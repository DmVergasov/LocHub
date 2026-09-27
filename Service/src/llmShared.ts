import type Anthropic from '@anthropic-ai/sdk';
import type { LlmOutcome, LlmRequest } from './llm.js';

type Params = Anthropic.MessageCreateParamsNonStreaming;

// One HTTP call or CLI child may not hang a job forever. For a fetch-based adapter Node's own, shorter fetch limit
// (NODE_FETCH_TIMEOUT_MS, below) fires first; either one counts as a timeout.
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// Node's built-in fetch (undici) gives up on its own after 300 s without response headers
// (UND_ERR_HEADERS_TIMEOUT) or 300 s without a body chunk (UND_ERR_BODY_TIMEOUT) -- a non-streaming chat
// completion sends its headers only once the whole answer is generated, so this is the real ceiling of any
// fetch-based request, whatever AbortSignal.timeout says (amendment 8: Request Timeout is therefore 30-300 s).
export const NODE_FETCH_TIMEOUT_MS = 300_000;
const NODE_FETCH_TIMEOUT_CODES: ReadonlySet<string> = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function nodeFetchTimeoutCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof own === 'string' && NODE_FETCH_TIMEOUT_CODES.has(own)) return own;
  const cause = (error as { cause?: { code?: unknown } | null } | null | undefined)?.cause?.code;
  return typeof cause === 'string' && NODE_FETCH_TIMEOUT_CODES.has(cause) ? cause : undefined;
}

// True when a thrown fetch error is a timeout: LocHub's own AbortSignal.timeout (TimeoutError/AbortError), or
// Node's fetch giving up first (an UND_ERR_*_TIMEOUT code on the error or its cause). Both are treated alike.
export function isFetchTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  return nodeFetchTimeoutCode(error) !== undefined;
}

// How long a timed-out request actually ran: the configured limit, or Node's own fetch limit when that one fired.
export function timedOutAfterMs(error: unknown, configuredMs: number): number {
  return nodeFetchTimeoutCode(error) !== undefined ? Math.min(configuredMs, NODE_FETCH_TIMEOUT_MS) : configuredMs;
}

// "10 minutes" for a whole number of minutes, "90 seconds" otherwise.
export function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Every adapter that reports a timed-out request as such builds its message with timeoutMessage, and job.ts's
// translate loop matches it with isTimeoutMessage to split the group (like a 'max_tokens' truncation) and to
// probe an endpoint that has not answered yet -- this module, not an adapter, owns the marker so job.ts never
// has to import a provider's adapter to recognize one.
const TIMEOUT_MARK = 'the request timed out after';

export function timeoutMessage(ms: number): string {
  return `${TIMEOUT_MARK} ${describeDuration(ms)}`;
}

export function isTimeoutMessage(message: string): boolean {
  return message.includes(TIMEOUT_MARK);
}

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

// M-5: the same three-characters-per-token guess as approxInputTokens, for a proxy that omits `usage` (or omits
// completion_tokens) from an otherwise-200 chat response -- 0 in/0 out on a priced Custom endpoint would otherwise
// silently under-report cost.
export function approxOutputTokens(text: string): number {
  return Math.ceil(text.length / 3);
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

// `text` is the raw response body, read once; `json` is `JSON.parse(text)`, or `{}` when that fails (a non-JSON
// body -- an nginx error page, a bare string) so an existing caller reading only `.json` sees the same empty
// object as before. M-1: the adapter's own reason-extraction falls back to `text` when the body is not the JSON
// shape it expects.
export type FetchRetryOutcome = { status: number; text: string; json: unknown } | { networkError: unknown };

export interface FetchRetryOptions {
  fetchImpl: typeof fetch;
  // The final status/json looks retryable (a 429) but the adapter's own error shape says it never succeeds on
  // retry (e.g. FINAL_ERROR_CODES riding a 429, an exhausted balance): this helper does not know any adapter's
  // error shape, so the adapter decides.
  isFinal?: (status: number, json: unknown) => boolean;
  // I-1: when false, a request that times out (isFetchTimeout: AbortSignal.timeout firing, or Node's own fetch
  // UND_ERR_HEADERS_TIMEOUT/UND_ERR_BODY_TIMEOUT) is returned immediately instead of being retried at this level --
  // the caller (job.ts, for Custom) splits the group instead of resending the same slow request whole. Every other
  // network error keeps the normal envelope. Defaults to true (every existing caller's behavior).
  retryTimeouts?: boolean;
  // A thrown network error the adapter knows can never succeed on retry (a refused redirect: the server will
  // answer the same 3xx every time) is returned on the first attempt instead of going through the envelope.
  isFinalNetworkError?: (error: unknown) => boolean;
}

// Wraps one HTTP call with the retry envelope described above. `buildInit` is called again for every attempt so
// each one gets its own AbortSignal.timeout window instead of racing a stale one from an earlier attempt.
export async function fetchWithRetry(url: string, buildInit: () => RequestInit, opts: FetchRetryOptions): Promise<FetchRetryOutcome> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    let text: string;
    try {
      response = await opts.fetchImpl(url, buildInit());
      // A timeout can also fire while the body is still arriving (UND_ERR_BODY_TIMEOUT, or the AbortSignal): that is
      // the same timed-out request, not an empty answer. Any other failure to read the body still reads as ''.
      text = await response.text().catch((bodyError: unknown) => {
        if (isFetchTimeout(bodyError)) throw bodyError;
        return '';
      });
    } catch (networkError) {
      const timedOut = isFetchTimeout(networkError);
      const final = opts.isFinalNetworkError?.(networkError) ?? false;
      if (final || (timedOut && opts.retryTimeouts === false) || attempt >= FETCH_RETRY_MAX_RETRIES) return { networkError };
      await sleep(jitteredBackoffMs(attempt));
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    const isFinal = opts.isFinal?.(response.status, json) ?? false;
    if (isFinal || !isTransientStatus(response.status) || attempt >= FETCH_RETRY_MAX_RETRIES) return { status: response.status, text, json };
    await sleep(retryAfterMsFrom(response.headers) ?? jitteredBackoffMs(attempt));
  }
}

// Same contract as AnthropicLlmClient.runSync: outcomes in request order, onOutcome as each one lands.
// runOne must not throw. `shouldContinue` (LlmClient.runSync) is asked right before each request that has not
// started yet: a request it declines is never sent and resolves to a 'skipped' outcome, for which onOutcome does
// not fire (nothing came back from the provider). A request already in flight is never affected.
export async function runPool(
  requests: readonly LlmRequest[],
  concurrency: number,
  runOne: (request: LlmRequest) => Promise<LlmOutcome>,
  onOutcome?: (outcome: LlmOutcome) => void,
  shouldContinue?: () => boolean,
): Promise<LlmOutcome[]> {
  const out = new Array<LlmOutcome>(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next++;
      if (shouldContinue && !shouldContinue()) {
        out[index] = { customId: requests[index]!.customId, kind: 'skipped' };
        continue;
      }
      const outcome = await runOne(requests[index]!);
      out[index] = outcome;
      onOutcome?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
  return out;
}
