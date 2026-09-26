import type Anthropic from '@anthropic-ai/sdk';
import type { LlmOutcome, LlmRequest } from './llm.js';

type Params = Anthropic.MessageCreateParamsNonStreaming;

// One HTTP call or CLI child may not hang a job forever.
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export const BATCH_UNAVAILABLE_MESSAGE = 'Batch mode is only available for Anthropic with an API key.';

// key-contract.md §4, verbatim: wherever the service or the web UI tells the user a key is missing. Error
// codes and JSON field names stay as they are; only this sentence is shared.
export const MISSING_KEY_MESSAGE = 'No API key: enter it in Project Settings > Plugins > LocHub > AI > API Key.';

// The internal request is Anthropic-shaped (prompt.ts); every other backend flattens it with these helpers.
export function systemTextOf(params: Params): string {
  const { system } = params;
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system
    .filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

export function userTextOf(params: Params): string {
  const first = params.messages[0];
  if (!first) return '';
  return typeof first.content === 'string' ? first.content : JSON.stringify(first.content);
}

export function schemaOf(params: Params): unknown {
  return params.output_config?.format?.schema ?? {};
}

export function effortOf(params: Params): string | undefined {
  const effort = params.output_config?.effort;
  return typeof effort === 'string' ? effort : undefined;
}

// No free token-count endpoint is used for these backends; about three characters per token is close enough
// for an estimate the job report later replaces with real usage.
export function approxInputTokens(params: Params): number {
  return Math.ceil((systemTextOf(params).length + userTextOf(params).length) / 3);
}

// The only environment variable the service reads a provider key from (key-contract.md §2). Kept as its own
// name here (not imported from providers.ts) so this stays a pure module with no import back into the
// adapters — redactSecrets is called from deep inside job reporting, far from where the key was resolved.
const KEY_ENV_VAR = 'LOCHUB_API_KEY';

// The negative lookbehind stops a plain word that merely contains "sk-" or "xai-" (`risk-assessment`) from being
// eaten as a key; the `*` in the tail character class matches a provider's own masked fragment (`sk-proj-****`).
const SECRET_SHAPED_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_*-]{6,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9_*-]{6,}/g,
  /AIza[0-9A-Za-z_-]{10,}/g,
  /Bearer\s+\S+/g,
];

// A provider error message can echo the key it just rejected (an invalid key, a masked fragment). Strips the
// exact value of every configured key env var that is set, then anything shaped like a key regardless of its
// source, so a message is safe to store in a job report or hand back over HTTP.
export function redactSecrets(text: string): string {
  let out = text;
  const value = process.env[KEY_ENV_VAR];
  if (value) out = out.split(value).join('[redacted]');
  for (const pattern of SECRET_SHAPED_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

// Fetch-level retry envelope: the Anthropic SDK already retries 408/409/429/5xx and a thrown network error
// twice, honoring retry-after/retry-after-ms (node_modules/@anthropic-ai/sdk/client.js). The two fetch-based
// adapters send exactly one request per round otherwise, so a short rate-limit window exhausts every one of the
// job's retry rounds in milliseconds. This mirrors that envelope for both.
const FETCH_RETRY_MAX_RETRIES = 2; // 3 attempts total.
const RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const BACKOFF_JITTER_RATIO = 0.25;
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 500 ms * 2^attempt, +/-25%, capped at 8 000 ms.
function jitteredBackoffMs(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  const jitter = base * BACKOFF_JITTER_RATIO;
  return Math.min(Math.max(base - jitter + Math.random() * (2 * jitter), 0), BACKOFF_CAP_MS);
}

// retry-after-ms (milliseconds) wins when present; otherwise retry-after (seconds, or an HTTP date). Both are
// capped at 60 s so a server asking for an hour does not stall the job that long.
function retryAfterMsFrom(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, RETRY_AFTER_CAP_MS);
  }
  const after = headers.get('retry-after');
  if (after === null) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(after);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
}

export type FetchRetryOutcome = { status: number; json: unknown } | { networkError: unknown };

export interface FetchRetryOptions {
  fetchImpl: typeof fetch;
  // The final status/json looks retryable (a 429) but the adapter's own error shape says it never succeeds on
  // retry (e.g. FINAL_ERROR_CODES riding a 429, an exhausted balance): this helper does not know any adapter's
  // error shape, so the adapter decides.
  isFinal?: (status: number, json: unknown) => boolean;
}

// Wraps one HTTP call with the retry envelope described above. `buildInit` is called again for every attempt so
// each one gets its own AbortSignal.timeout window instead of racing a stale one from an earlier attempt.
export async function fetchWithRetry(url: string, buildInit: () => RequestInit, opts: FetchRetryOptions): Promise<FetchRetryOutcome> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await opts.fetchImpl(url, buildInit());
    } catch (networkError) {
      if (attempt >= FETCH_RETRY_MAX_RETRIES) return { networkError };
      await sleep(jitteredBackoffMs(attempt));
      continue;
    }
    const json: unknown = await response.json().catch(() => ({}));
    const isFinal = opts.isFinal?.(response.status, json) ?? false;
    if (isFinal || !isTransientStatus(response.status) || attempt >= FETCH_RETRY_MAX_RETRIES) return { status: response.status, json };
    await sleep(retryAfterMsFrom(response.headers) ?? jitteredBackoffMs(attempt));
  }
}

// Same contract as AnthropicLlmClient.runSync: outcomes in request order, onOutcome as each one lands.
// runOne must not throw.
export async function runPool(
  requests: readonly LlmRequest[],
  concurrency: number,
  runOne: (request: LlmRequest) => Promise<LlmOutcome>,
  onOutcome?: (outcome: LlmOutcome) => void,
): Promise<LlmOutcome[]> {
  const out = new Array<LlmOutcome>(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next++;
      const outcome = await runOne(requests[index]!);
      out[index] = outcome;
      onOutcome?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
  return out;
}
