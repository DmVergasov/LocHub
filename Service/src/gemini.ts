import type Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmOutcome, LlmRequest } from './llm.js';
import {
  approxInputTokens,
  BATCH_UNAVAILABLE_MESSAGE,
  fetchWithRetry,
  isFetchTimeout,
  MISSING_KEY_MESSAGE,
  REQUEST_TIMEOUT_MS,
  runPool,
  schemaOf,
  systemTextOf,
  timedOutAfterMs,
  timeoutMessage,
  userTextOf,
} from './llmShared.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const REFUSAL_REASONS: ReadonlySet<string> = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

export function buildGenerateBody(params: Anthropic.MessageCreateParamsNonStreaming): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: systemTextOf(params) }] },
    contents: [{ role: 'user', parts: [{ text: userTextOf(params) }] }],
    // responseJsonSchema takes full JSON Schema; responseSchema is an OpenAPI subset that may not accept
    // additionalProperties (confirmed only by the first live call).
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schemaOf(params), maxOutputTokens: params.max_tokens },
  };
}

export function outcomeFromGenerateResponse(customId: string, status: number, json: GeminiResponse): LlmOutcome {
  if (status !== 200) {
    const retryable = status === 408 || status === 429 || status >= 500;
    return { customId, kind: 'error', message: `Gemini: ${status} ${json.error?.message ?? 'request failed'}`.slice(0, 300), retryable };
  }
  if (json.promptFeedback?.blockReason) return { customId, kind: 'refusal' };
  const candidate = json.candidates?.[0];
  if (candidate?.finishReason && REFUSAL_REASONS.has(candidate.finishReason)) return { customId, kind: 'refusal' };
  // job.ts splits a group on exactly this message (same as outcomeFromMessage in llm.ts).
  if (candidate?.finishReason === 'MAX_TOKENS') return { customId, kind: 'error', message: 'max_tokens', retryable: true };
  // An empty or non-JSON answer is 'ok' with that text, exactly like outcomeFromMessage (llm.ts): the job's own
  // missing-id retry (parseTranslatedItems finds every id missing) handles it, not a final error.
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  const usage = json.usageMetadata ?? {};
  // Thinking tokens are billed as output (ai.google.dev pricing: "output price includes thinking tokens").
  return { customId, kind: 'ok', text, inputTokens: usage.promptTokenCount ?? 0, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) };
}

export interface GeminiLlmClientOptions {
  fetchImpl?: typeof fetch;
  // The resolved LOCHUB_API_KEY value, passed down explicitly by createLlmClient (providers.ts); this
  // adapter never reads process.env itself. Empty or absent means no key (key-contract.md §1/§2).
  apiKey?: string;
}

export class GeminiLlmClient implements LlmClient {
  // No free token-count endpoint (llmShared.ts's approxInputTokens doc comment); every count is a guess.
  readonly countsAreApproximate = true;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | undefined;

  constructor(options: GeminiLlmClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
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
    if (!this.apiKey) return { customId: request.customId, kind: 'error', message: `Gemini: ${MISSING_KEY_MESSAGE}`, retryable: false };
    const result = await fetchWithRetry(
      `${BASE_URL}/${encodeURIComponent(request.params.model)}:generateContent`,
      () => ({
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey!, 'content-type': 'application/json' },
        body: JSON.stringify(buildGenerateBody(request.params)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
      { fetchImpl: this.fetchImpl },
    );
    if ('networkError' in result) {
      const { networkError } = result;
      // Node's own fetch timeout counts as a timeout too (amendment 8); job.ts splits the group on either.
      const timedOut = isFetchTimeout(networkError);
      const message = timedOut
        ? timeoutMessage(timedOutAfterMs(networkError, REQUEST_TIMEOUT_MS))
        : networkError instanceof Error
          ? networkError.message
          : String(networkError);
      return { customId: request.customId, kind: 'error', message: `Gemini: ${message}`, retryable: true };
    }
    return outcomeFromGenerateResponse(request.customId, result.status, result.json as GeminiResponse);
  }
}
