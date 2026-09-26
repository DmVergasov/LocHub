import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmOutcome, LlmRequest } from './llm.js';
import {
  approxInputTokens,
  BATCH_UNAVAILABLE_MESSAGE,
  effortOf,
  fetchWithRetry,
  MISSING_KEY_MESSAGE,
  REQUEST_TIMEOUT_MS,
  runPool,
  schemaOf,
  systemTextOf,
  userTextOf,
} from './llmShared.js';

export type OpenAiCompatibleProvider = 'openai' | 'xai' | 'deepseek';

export interface OpenAiCompatibleProfile {
  label: string;
  baseUrl: string;
  // DeepSeek documents only json_object; the schema then goes into the system prompt.
  schemaMode: 'json_schema' | 'json_object';
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  sendsEffort: boolean;
  // xAI reports reasoning tokens outside completion_tokens; OpenAI and DeepSeek count them inside.
  reasoningAddsToOutput: boolean;
}

// Sources (2026-09-26): developers.openai.com structured-outputs/reasoning; docs.x.ai structured-outputs/reasoning;
// api-docs.deepseek.com json_mode/thinking_mode.
export const OPENAI_COMPATIBLE_PROFILES: Readonly<Record<OpenAiCompatibleProvider, OpenAiCompatibleProfile>> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', schemaMode: 'json_schema', maxTokensField: 'max_completion_tokens', sendsEffort: true, reasoningAddsToOutput: false },
  xai: { label: 'xAI', baseUrl: 'https://api.x.ai/v1', schemaMode: 'json_schema', maxTokensField: 'max_completion_tokens', sendsEffort: true, reasoningAddsToOutput: true },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', schemaMode: 'json_object', maxTokensField: 'max_tokens', sendsEffort: false, reasoningAddsToOutput: false },
};

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
    responseFormat = { type: 'json_object' };
  }
  const body: Record<string, unknown> = {
    model: params.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userTextOf(params) },
    ],
    response_format: responseFormat,
    [profile.maxTokensField]: params.max_tokens,
  };
  const effort = effortOf(params);
  if (profile.sendsEffort && effort) body.reasoning_effort = effort;
  return body;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string; code?: string | null; type?: string };
}

function isRetryableStatus(status: number, code: string | undefined): boolean {
  if (code && FINAL_ERROR_CODES.has(code)) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function outcomeFromChatResponse(customId: string, profile: OpenAiCompatibleProfile, status: number, json: ChatResponse): LlmOutcome {
  if (status !== 200) {
    const message = json.error?.message ?? 'request failed';
    const code = json.error?.code ?? undefined;
    return { customId, kind: 'error', message: `${profile.label}: ${status} ${message}`.slice(0, 300), retryable: isRetryableStatus(status, code) };
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) return { customId, kind: 'refusal' };
  // job.ts splits a group on exactly this message (same as outcomeFromMessage in llm.ts).
  if (choice?.finish_reason === 'length') return { customId, kind: 'error', message: 'max_tokens', retryable: true };
  // An empty or non-JSON answer is 'ok' with that text, exactly like outcomeFromMessage (llm.ts): the job's own
  // missing-id retry (parseTranslatedItems finds every id missing) handles it, not a final error — a sporadic
  // empty DeepSeek json_object reply must not permanently fail the whole group.
  const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const usage = json.usage ?? {};
  const reasoning = profile.reasoningAddsToOutput ? (usage.completion_tokens_details?.reasoning_tokens ?? 0) : 0;
  return { customId, kind: 'ok', text, inputTokens: usage.prompt_tokens ?? 0, outputTokens: (usage.completion_tokens ?? 0) + reasoning };
}

export interface OpenAiCompatibleLlmClientOptions {
  provider: OpenAiCompatibleProvider;
  // Injectable so tests never reach the network.
  fetchImpl?: typeof fetch;
  // The resolved LOCHUB_API_KEY value, passed down explicitly by createLlmClient (providers.ts); this
  // adapter never reads process.env itself. Empty or absent means no key (key-contract.md §1/§2).
  apiKey?: string;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  // No free token-count endpoint (llmShared.ts's approxInputTokens doc comment); every count is a guess.
  readonly countsAreApproximate = true;
  private readonly profile: OpenAiCompatibleProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;

  constructor(options: OpenAiCompatibleLlmClientOptions) {
    this.profile = OPENAI_COMPATIBLE_PROFILES[options.provider];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }

  async runSync(requests: LlmRequest[], concurrency: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]> {
    return runPool(requests, concurrency, (request) => this.runOne(request), onOutcome);
  }

  async runBatch(_requests: LlmRequest[], _pollMs: number): Promise<LlmOutcome[]> {
    throw new Error(BATCH_UNAVAILABLE_MESSAGE);
  }

  async countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number> {
    return approxInputTokens(params);
  }

  private async runOne(request: LlmRequest): Promise<LlmOutcome> {
    const { profile } = this;
    if (!this.apiKey) return { customId: request.customId, kind: 'error', message: `${profile.label}: ${MISSING_KEY_MESSAGE}`, retryable: false };
    const result = await fetchWithRetry(
      `${profile.baseUrl}/chat/completions`,
      () => ({
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildChatBody(profile, request.params)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      {
        fetchImpl: this.fetchImpl,
        // FINAL_ERROR_CODES rides a 429 (an exhausted balance) but never succeeds on retry.
        isFinal: (status, body) => status === 429 && FINAL_ERROR_CODES.has((body as ChatResponse).error?.code ?? ''),
      },
    );
    if ('networkError' in result) {
      const { networkError } = result;
      const timedOut = networkError instanceof Error && (networkError.name === 'TimeoutError' || networkError.name === 'AbortError');
      const message = timedOut ? 'the request timed out after 10 minutes' : networkError instanceof Error ? networkError.message : String(networkError);
      return { customId: request.customId, kind: 'error', message: `${profile.label}: ${message}`, retryable: true };
    }
    return outcomeFromChatResponse(request.customId, profile, result.status, result.json as ChatResponse);
  }
}
