import type Anthropic from '@anthropic-ai/sdk';
import {
  authHeaders,
  endpointUrl,
  extractJsonObject,
  isRedirectError,
  networkErrorCode,
  reduceBaseUrl,
  REDIRECT_MESSAGE,
  scrubBaseUrlParts,
  scrubUrls,
  type CustomEndpointConfig,
  type CustomKeyHeader,
  type StructuredOutputMode,
} from './customEndpoint.js';
import type { LlmClient, LlmOutcome, LlmRequest } from './llm.js';
import {
  approxInputTokens,
  approxOutputTokens,
  BATCH_UNAVAILABLE_MESSAGE,
  effortOf,
  fetchWithRetry,
  isFetchTimeout,
  MISSING_KEY_MESSAGE,
  redactSecrets,
  REQUEST_TIMEOUT_MS,
  runPool,
  schemaOf,
  systemTextOf,
  timedOutAfterMs,
  timeoutMessage,
  userTextOf,
} from './llmShared.js';

export type OpenAiCompatibleProvider = 'openai' | 'xai' | 'deepseek';

export interface OpenAiCompatibleProfile {
  label: string;
  // Routes are appended to its path, before any query string (customEndpoint.ts endpointUrl).
  baseUrl: string;
  // DeepSeek documents only json_object; the schema then goes into the system prompt. prompt_only (Custom
  // endpoints) sends no response_format at all and also puts the schema into the system prompt.
  schemaMode: StructuredOutputMode;
  // null (Custom endpoints only, amendment 3): no output-token cap is sent at all -- the server's own default
  // applies (vLLM: the remaining context; Ollama/llama.cpp/LM Studio: unlimited). A finish_reason: 'length' still
  // splits the group, the same as a real cap being hit.
  maxTokensField: 'max_completion_tokens' | 'max_tokens' | null;
  sendsEffort: boolean;
  // xAI reports reasoning tokens outside completion_tokens; OpenAI and DeepSeek count them inside.
  reasoningAddsToOutput: boolean;
  keyHeader: CustomKeyHeader;
  // False only for a Custom endpoint: a local server needs no key, so a missing key sends no auth header instead
  // of failing the request.
  keyRequired: boolean;
  requestTimeoutMs: number;
  // Custom endpoints only: take the first balanced JSON object out of a fenced or prose-wrapped answer.
  tolerantJson: boolean;
  // False only for a Custom endpoint (amendment 2): a request that times out is not retried at the fetch level --
  // job.ts splits the group instead of resending the same slow request whole. Built-in providers keep the
  // existing envelope (their timeout is the fixed, generous REQUEST_TIMEOUT_MS, not a user-configurable value).
  retryTimeouts: boolean;
}

// Sources (2026-09-26): developers.openai.com structured-outputs/reasoning; docs.x.ai structured-outputs/reasoning;
// api-docs.deepseek.com json_mode/thinking_mode.
export const OPENAI_COMPATIBLE_PROFILES: Readonly<Record<OpenAiCompatibleProvider, OpenAiCompatibleProfile>> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    schemaMode: 'json_schema',
    maxTokensField: 'max_completion_tokens',
    sendsEffort: true,
    reasoningAddsToOutput: false,
    keyHeader: 'bearer',
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true,
  },
  xai: {
    label: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    schemaMode: 'json_schema',
    maxTokensField: 'max_completion_tokens',
    sendsEffort: true,
    reasoningAddsToOutput: true,
    keyHeader: 'bearer',
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true,
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    schemaMode: 'json_object',
    maxTokensField: 'max_tokens',
    sendsEffort: false,
    reasoningAddsToOutput: false,
    keyHeader: 'bearer',
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true,
  },
};

// A Custom endpoint's profile comes from its Project Settings (cli.ts), not the table above: no output-token cap
// and no reasoning_effort, which every OpenAI-compatible server accepts (amendment 3); a timed-out request is not
// retried at the fetch level (amendment 2, I-1) -- job.ts splits the group instead.
export function customProfileOf(custom: CustomEndpointConfig): OpenAiCompatibleProfile {
  return {
    label: 'Custom',
    baseUrl: custom.baseUrl,
    schemaMode: custom.structuredOutput,
    maxTokensField: null,
    sendsEffort: false,
    reasoningAddsToOutput: false,
    keyHeader: custom.keyHeader,
    keyRequired: false,
    requestTimeoutMs: custom.requestTimeoutSeconds * 1000,
    tolerantJson: true,
    retryTimeouts: false,
  };
}

const SCHEMA_NAME = 'lochub_response';
const JSON_OBJECT_INSTRUCTION = 'Answer with one JSON object that matches this JSON Schema:';
// A 429 is usually a rate limit, but these codes mean the account is out of money and a retry cannot help.
const FINAL_ERROR_CODES: ReadonlySet<string> = new Set(['credit_balance_exhausted', 'insufficient_quota']);

export function buildChatBody(profile: OpenAiCompatibleProfile, params: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
  const schema = schemaOf(params);
  let system = systemTextOf(params);
  let responseFormat: unknown;
  if (profile.schemaMode === 'json_schema') {
    responseFormat = { type: 'json_schema', json_schema: { name: SCHEMA_NAME, schema, strict: true } };
  } else {
    system = `${system}\n\n${JSON_OBJECT_INSTRUCTION}\n${JSON.stringify(schema)}`;
    if (profile.schemaMode === 'json_object') responseFormat = { type: 'json_object' };
  }
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userTextOf(params) },
    ],
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    // I-2: a Custom endpoint's profile.maxTokensField is null -- neither field is sent, and the server's own
    // default applies instead of a fixed 16000 that an ordinary-context vLLM/TGI deployment would refuse outright.
    ...(profile.maxTokensField === null ? {} : { [profile.maxTokensField]: params.max_tokens }),
  };
  const effort = effortOf(params);
  if (profile.sendsEffort && effort) body.reasoning_effort = effort;
  return body;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string; code?: string | null; type?: string } | string;
  message?: string;
  detail?: string;
}

function isRetryableStatus(status: number, code: string | undefined): boolean {
  if (code && FINAL_ERROR_CODES.has(code)) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

// M-1: not every OpenAI-compatible server answers the OpenAI error shape ({error:{message}}). Tried in order --
// error.message (OpenAI, vLLM), a string error (TGI), a top-level message (older vLLM), detail (FastAPI wrappers,
// often the whole body already read as JSON) -- then the raw body text, then a fixed fallback. `rawText` is the
// exact body fetchWithRetry read, so this never needs a second read of an already-consumed response.
function reasonFromErrorBody(json: ChatResponse, rawText: string): string {
  const error = json.error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof error === 'string' && error !== '') return error;
  if (typeof json.message === 'string' && json.message !== '') return json.message;
  if (typeof json.detail === 'string' && json.detail !== '') return json.detail;
  const trimmed = rawText.trim();
  return trimmed !== '' ? trimmed : 'request failed';
}

// The expected top-level key of the JSON object the model was asked for (TRANSLATE_SCHEMA: 'items', JUDGE_SCHEMA:
// 'issues') -- read from the request's own schema, so extractJsonObject never has to hardcode either name.
function expectedKeyOf(params: Anthropic.MessageCreateParamsNonStreaming): string | undefined {
  const required = (schemaOf(params) as { required?: unknown }).required;
  const first = Array.isArray(required) ? required[0] : undefined;
  return typeof first === 'string' ? first : undefined;
}

// M-9/amendment 7: every place an error message may carry the configured Base URL or the key runs both scrubs;
// `scrubUrls` catches a full URL (any scheme/host), `scrubBaseUrlParts` additionally catches this endpoint's own
// path/query echoed bare (no scheme) -- a case scrubUrls cannot recognize on its own.
function scrubEndpointMessage(text: string, baseUrl: string): string {
  return scrubBaseUrlParts(scrubUrls(text), baseUrl);
}

export function outcomeFromChatResponse(
  customId: string,
  profile: OpenAiCompatibleProfile,
  params: Anthropic.MessageCreateParamsNonStreaming,
  status: number,
  json: ChatResponse,
  rawText: string,
): LlmOutcome {
  if (status !== 200) {
    const code = (json.error && typeof json.error === 'object' ? json.error.code : undefined) ?? undefined;
    const reason = scrubEndpointMessage(reasonFromErrorBody(json, rawText), profile.baseUrl);
    const message = redactSecrets(`${profile.label}: ${status} ${reason}`).slice(0, 200);
    return { customId, kind: 'error', message, retryable: isRetryableStatus(status, code) };
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) return { customId, kind: 'refusal' };
  // job.ts splits a group on exactly this message (same as outcomeFromMessage in llm.ts).
  if (choice?.finish_reason === 'length') return { customId, kind: 'error', message: 'max_tokens', retryable: true };
  // An empty or non-JSON answer is 'ok' with that text, exactly like outcomeFromMessage (llm.ts): the job's own
  // missing-id retry (parseTranslatedItems finds every id missing) handles it, not a final error — a sporadic
  // empty DeepSeek json_object reply must not permanently fail the whole group.
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const text = profile.tolerantJson ? (extractJsonObject(content, expectedKeyOf(params)) ?? content) : content;
  const usage = json.usage;
  const reasoning = profile.reasoningAddsToOutput ? (usage?.completion_tokens_details?.reasoning_tokens ?? 0) : 0;
  // M-5: a proxy that omits usage (or just completion_tokens) falls back to the same character-count guess the
  // job report otherwise uses only when it never asked the model at all. NB-7: the guess covers the raw content, a
  // stripped <think> block included -- the model generated (and a priced endpoint bills) those tokens too.
  const inputTokens = usage?.prompt_tokens ?? approxInputTokens(params);
  const outputTokens = (usage?.completion_tokens ?? approxOutputTokens(content)) + reasoning;
  return { customId, kind: 'ok', text, inputTokens, outputTokens };
}

// M-3/amendment 4: an n-slot semaphore gating every request a Custom OpenAiCompatibleLlmClient instance makes,
// across every job running at once -- unlike a job's own `concurrency` (runPool), which only bounds that one
// job's workers. One instance lives for the life of the service (providers.ts createLlmClient, called once in
// cli.ts's main()), so this is the one place that can see every job's requests at once.
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(slots: number) {
    this.available = slots;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.available++;
  }
}

export type OpenAiCompatibleLlmClientOptions = {
  // Injectable so tests never reach the network.
  fetchImpl?: typeof fetch;
  // The resolved LOCHUB_API_KEY value, passed down explicitly by createLlmClient (providers.ts); this
  // adapter never reads process.env itself. Empty or absent means no key (key-contract.md §1/§2).
  apiKey?: string;
} & ({ provider: OpenAiCompatibleProvider } | { provider: 'custom'; custom: CustomEndpointConfig });

export class OpenAiCompatibleLlmClient implements LlmClient {
  // No free token-count endpoint (llmShared.ts's approxInputTokens doc comment); every count is a guess.
  readonly countsAreApproximate = true;
  private readonly profile: OpenAiCompatibleProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;
  // Custom endpoints only (M-3): caps this instance's total in-flight requests at Max Parallel Requests, across
  // every job. Built-in providers have no such cap -- a job's own `concurrency` is enough for them.
  private readonly semaphore: Semaphore | undefined;

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    this.profile = options.provider === 'custom' ? customProfileOf(options.custom) : OPENAI_COMPATIBLE_PROFILES[options.provider];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
    this.semaphore = options.provider === 'custom' ? new Semaphore(options.custom.maxParallel) : undefined;
  }

  async runSync(
    requests: LlmRequest[],
    concurrency: number,
    onOutcome?: (outcome: LlmOutcome) => void,
    shouldContinue?: () => boolean,
  ): Promise<LlmOutcome[]> {
    return runPool(requests, concurrency, (request) => this.runOne(request), onOutcome, shouldContinue);
  }

  async runBatch(_requests: LlmRequest[], _pollMs: number): Promise<LlmOutcome[]> {
    throw new Error(BATCH_UNAVAILABLE_MESSAGE);
  }

  async countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number> {
    return approxInputTokens(params);
  }

  private async runOne(request: LlmRequest): Promise<LlmOutcome> {
    const { profile } = this;
    if (profile.keyRequired && !this.apiKey) return { customId: request.customId, kind: 'error', message: `${profile.label}: ${MISSING_KEY_MESSAGE}`, retryable: false };
    await this.semaphore?.acquire();
    try {
      const result = await fetchWithRetry(
        endpointUrl(profile.baseUrl, '/chat/completions'),
        () => ({
          method: 'POST',
          headers: { ...authHeaders(profile.keyHeader, this.apiKey), 'content-type': 'application/json' },
          body: JSON.stringify(buildChatBody(profile, request.params)),
          // M-10/amendment 5: a cross-origin redirect would forward every header but Authorization (api-key
          // included), so a redirect is refused outright instead of followed.
          redirect: 'error',
          signal: AbortSignal.timeout(profile.requestTimeoutMs),
        }),
        {
          fetchImpl: this.fetchImpl,
          // FINAL_ERROR_CODES rides a 429 (an exhausted balance) but never succeeds on retry.
          isFinal: (status, body) => {
            const error = (body as ChatResponse).error;
            const code = error && typeof error === 'object' ? (error.code ?? '') : '';
            return status === 429 && FINAL_ERROR_CODES.has(code);
          },
          retryTimeouts: profile.retryTimeouts,
          // NB-6: the server answers the same redirect every time, so a refused one is final at the fetch level too.
          isFinalNetworkError: isRedirectError,
        },
      );
      if ('networkError' in result) {
        const { networkError } = result;
        // Amendment 8: Node's own fetch timeout (UND_ERR_HEADERS_TIMEOUT/UND_ERR_BODY_TIMEOUT) is a timeout exactly
        // like AbortSignal.timeout firing -- the job splits on it -- and the message names the limit that fired.
        const timedOut = isFetchTimeout(networkError);
        const redirected = !timedOut && isRedirectError(networkError);
        // LocHub's own timeout and redirect sentences carry no server text, so they skip the scrub: a Base URL query
        // value that happens to be one of their words must not break job.ts's isTimeoutMessage.
        const message = timedOut
          ? timeoutMessage(timedOutAfterMs(networkError, profile.requestTimeoutMs))
          : redirected
            ? REDIRECT_MESSAGE
            // M-2: name the same network-failure cause the probe already does, instead of a bare "fetch failed".
            : scrubEndpointMessage(`cannot reach ${reduceBaseUrl(profile.baseUrl)} (${networkErrorCode(networkError)})`, profile.baseUrl);
        return {
          customId: request.customId,
          kind: 'error',
          message: `${profile.label}: ${message}`,
          retryable: !redirected,
        };
      }
      return outcomeFromChatResponse(request.customId, profile, request.params, result.status, result.json as ChatResponse, result.text);
    } finally {
      this.semaphore?.release();
    }
  }
}
