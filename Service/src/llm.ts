import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Anthropic } from './deps.js';
import { canonicalJson } from './ids.js';
import { MISSING_KEY_MESSAGE } from './llmShared.js';

export interface LlmRequest {
  customId: string;
  params: Anthropic.MessageCreateParamsNonStreaming;
}

export type LlmOutcome =
  | { customId: string; kind: 'ok'; text: string; inputTokens: number; outputTokens: number }
  | { customId: string; kind: 'refusal' }
  | { customId: string; kind: 'error'; message: string; retryable: boolean };

export interface LlmClient {
  // onOutcome, when given, fires as soon as each request's outcome is known — lets the caller cache
  // an answer immediately instead of waiting for the whole round to finish.
  runSync(requests: LlmRequest[], concurrency: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]>;
  // onProgress, when given, fires while polling with the number of requests that have succeeded so far out of
  // the total submitted (job progress). Only a succeeded request can settle strings; a refused, errored,
  // canceled or expired one reaches a terminal state without settling anything, so it is not counted here —
  // the caller finds out what it actually settled from the outcomes themselves, once the round is collected.
  runBatch(requests: LlmRequest[], pollMs: number, onProgress?: (succeededRequests: number, totalRequests: number) => void): Promise<LlmOutcome[]>;
  countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number>;
  // True when this client's countInputTokens is always a local character-count guess (approxInputTokens,
  // llmShared.ts) and never a real provider call: the OpenAI-compatible and Gemini adapters (no free
  // token-count endpoint) and the Claude Code/subscription adapter (no countTokens equivalent for a CLI
  // session) all set this. AnthropicLlmClient does not: its countInputTokens is a real countTokens call
  // whenever it succeeds — a rate-limit/overloaded failure is handled per-call in estimate.ts, not here.
  // Absent (never explicit `false`) means "exact when it succeeds", so estimate.ts's `approximate` flag
  // (JobEstimate) can tell a wholly real Anthropic count from a provider whose counts are never real.
  readonly countsAreApproximate?: boolean;
}

// The whole request (model, prompt version, glossary, context, source) determines the answer, so it is the cache key.
// 64 hex characters fit the Batches custom_id limit.
export function requestId(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return createHash('sha256').update(canonicalJson(params), 'utf8').digest('hex');
}

export function outcomeFromMessage(customId: string, message: Anthropic.Message): LlmOutcome {
  if (message.stop_reason === 'refusal') return { customId, kind: 'refusal' };
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    // Both indicate the response was cut off; job splits groups on 'max_tokens' message.
    return { customId, kind: 'error', message: 'max_tokens', retryable: true };
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return { customId, kind: 'ok', text, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

// Shared by errorOutcome (sync mode) and runBatch's retrieve/results handling: no status, 408, 409, 429
// and >= 500 are transient (network blip, rate limit, momentary overload); everything else is final.
function isRetryableError(error: unknown): boolean {
  const raw = (error as { status?: unknown } | null)?.status;
  const status = typeof raw === 'number' ? raw : undefined;
  return status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
}

function errorOutcome(customId: string, error: unknown): LlmOutcome {
  return { customId, kind: 'error', message: error instanceof Error ? error.message : String(error), retryable: isRetryableError(error) };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Batch API error types that never succeed on retry: same as HTTP 4xx non-5xx errors in sync mode.
const FINAL_BATCH_ERRORS: ReadonlySet<string> = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'billing_error']);

// A thrown batches.retrieve during polling (network blip, 5xx, 429) does not fail the call: keep
// polling with backoff, only give up once the batch has been unreachable for this many attempts in a row.
const MAX_RETRIEVE_FAILURES = 10;
const MAX_BACKOFF_MS = 60_000;

interface BatchDescriptor {
  batchId: string;
  customIds: string[];
  createdAt: string;
}

// The set of custom ids fully determines a batch's content, so it is the resume key: two runs that submit
// the same requests hash to the same file and reuse the same batch instead of paying twice.
export function batchKey(customIds: readonly string[]): string {
  return createHash('sha256').update([...customIds].sort().join('\n'), 'utf8').digest('hex');
}

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// The stock Anthropic client still authenticates from its own environment and disk even when an explicit
// `apiKey` is given (key-contract.md §2: LOCHUB_API_KEY is the only source of a provider key, everything
// else must be neutral). Four separate fallbacks in node_modules/@anthropic-ai/sdk/client.js need closing:
// - ANTHROPIC_API_KEY (:77): only read when the ctor's own `apiKey` is `undefined`; passing `null` (never
//   omitted -- see AnthropicLlmClientOptions.apiKey below) skips that branch.
// - ANTHROPIC_AUTH_TOKEN (:80) and the double X-Api-Key + `Authorization: Bearer` send when both an apiKey
//   and an authToken are set (:363, apiKeyAuth/bearerAuth at :369/:375): closed by passing `authToken: null`
//   explicitly, the same "never omit it" reasoning as apiKey.
// - The default credential chain (config file / profile / OIDC federation, resolved by
//   `_resolveDefaultCredentials()` at :163 whenever `apiKey == null && authToken == null` and
//   `_shouldResolveDefaultCredentials()` returns true): the SDK's own doc comment on that hook
//   (client.d.ts:213-219) says "Subclasses that bring their own auth scheme return false so unrelated local
//   credentials are never resolved or allowed to supply a base URL" -- exactly LocHub's case, so
//   LocHubAnthropic below does that.
// - ANTHROPIC_BASE_URL (:70): read unconditionally as the ctor's `baseURL` default. Pinned to the public API
//   host explicitly (owner's ruling: no proxy support, env is not a configuration path for LocHub).
// ANTHROPIC_CUSTOM_HEADERS (:116-125) is a fifth: parsed unconditionally in the constructor and merged into
// `options.defaultHeaders`, which becomes `this._options.defaultHeaders` -- read fresh on every request by
// `buildHeaders` (:838). There is no constructor option to suppress that parse, so LocHubAnthropic instead
// overwrites `this._options.defaultHeaders` right after `super()` runs, discarding whatever the environment
// injected (whatever header names it used) while keeping any `defaultHeaders` LocHub itself passed in (none,
// today).
class LocHubAnthropic extends Anthropic {
  constructor(options?: ConstructorParameters<typeof Anthropic>[0]) {
    super(options);
    this._options.defaultHeaders = options?.defaultHeaders;
  }

  protected override _shouldResolveDefaultCredentials(): boolean {
    return false;
  }
}

export interface AnthropicLlmClientOptions {
  // The injectable Anthropic client, for tests. Also counts as "has a key" (see hasKey below): a test's fake
  // SDK stands in for a real, working client regardless of what apiKey it was built with.
  client?: Anthropic;
  // The resolved LOCHUB_API_KEY value, passed down explicitly by createLlmClient (providers.ts). Passed as
  // `null` (not omitted) when absent: see the fallback rundown above.
  apiKey?: string;
  // Where in-flight batches are persisted. Without it, runBatch behaves as before: no resume, no
  // survives-a-restart guarantee.
  batchDir?: string;
}

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly batchDir: string | undefined;
  // False only when there is truly no key to authenticate with: every call is refused locally, without
  // ever reaching the SDK/network (I-1 -- an ungated caller, not just an ungated route, must never make a
  // billed or credentialed call on LocHub's behalf with no key configured).
  private readonly hasKey: boolean;

  constructor(options: AnthropicLlmClientOptions = {}) {
    this.client =
      options.client ??
      new LocHubAnthropic({ apiKey: options.apiKey || null, authToken: null, baseURL: 'https://api.anthropic.com' });
    this.hasKey = options.client !== undefined || !!options.apiKey;
    this.batchDir = options.batchDir;
  }

  async runSync(requests: LlmRequest[], concurrency: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]> {
    if (!this.hasKey) {
      const out = requests.map((r): LlmOutcome => ({ customId: r.customId, kind: 'error', message: `Anthropic: ${MISSING_KEY_MESSAGE}`, retryable: false }));
      out.forEach((outcome) => onOutcome?.(outcome));
      return out;
    }
    const out = new Array<LlmOutcome>(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const index = next++;
        const request = requests[index]!;
        let outcome: LlmOutcome;
        try {
          outcome = outcomeFromMessage(request.customId, await this.client.messages.create(request.params));
        } catch (error) {
          outcome = errorOutcome(request.customId, error);
        }
        out[index] = outcome;
        onOutcome?.(outcome);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
    return out;
  }

  async runBatch(
    requests: LlmRequest[],
    pollMs: number,
    onProgress?: (succeededRequests: number, totalRequests: number) => void,
  ): Promise<LlmOutcome[]> {
    if (requests.length === 0) return [];
    if (!this.hasKey) throw new Error(MISSING_KEY_MESSAGE);
    const file = this.batchDir ? join(this.batchDir, `${batchKey(requests.map((r) => r.customId))}.json`) : undefined;

    // Resume: an earlier run already paid for this batch and may have crashed before collecting it.
    let resumed = file !== undefined && existsSync(file);
    let batchId: string;
    let status: string;
    if (resumed) {
      batchId = (JSON.parse(readFileSync(file!, 'utf8')) as BatchDescriptor).batchId;
      status = 'in_progress';
    } else {
      ({ batchId, status } = await this.createBatch(requests, file));
    }

    let waitMs = pollMs;
    let failures = 0;
    const byId = new Map<string, LlmOutcome>();

    for (;;) {
      try {
        while (status !== 'ended') {
          await sleep(waitMs);
          const retrieved = await this.client.messages.batches.retrieve(batchId);
          status = retrieved.processing_status;
          const counts = retrieved.request_counts;
          // Only succeeded requests can have settled strings: errored/canceled/expired requests are
          // retried or split by the caller and settle nothing, so they must not inflate this estimate.
          onProgress?.(counts.succeeded, requests.length);
          failures = 0;
          waitMs = pollMs;
        }
        for await (const entry of await this.client.messages.batches.results(batchId)) {
          const result = entry.result;
          if (result.type === 'succeeded') {
            byId.set(entry.custom_id, outcomeFromMessage(entry.custom_id, result.message));
          } else if (result.type === 'errored') {
            // result.error is the API error envelope: { type: 'error', error: { type: 'invalid_request_error', message } }.
            // Every variant of the SDK's ErrorObject carries a message alongside its type; keep both instead of
            // dropping the one part a reviewer could actually act on.
            const apiError = result.error.error;
            byId.set(entry.custom_id, {
              customId: entry.custom_id,
              kind: 'error',
              message: `${apiError.type}: ${apiError.message}`,
              retryable: !FINAL_BATCH_ERRORS.has(apiError.type),
            });
          } else {
            // expired or canceled: resubmitted on the next attempt, finished groups come from the cache.
            byId.set(entry.custom_id, { customId: entry.custom_id, kind: 'error', message: result.type, retryable: true });
          }
        }
        break;
      } catch (error) {
        // A non-retryable retrieve/results error means this batch id is no longer good for us — a
        // crash left a descriptor pointing at a batch from another workspace/org credential, past its
        // retention window, or since deleted. A resumed descriptor is dropped in favor of a fresh batch
        // instead of wedging the job forever; a batch we created ourselves in this call has nothing to
        // fall back to and the error is final.
        if (!isRetryableError(error)) {
          if (file && existsSync(file)) unlinkSync(file);
          if (!resumed) throw error;
          resumed = false;
          byId.clear();
          ({ batchId, status } = await this.createBatch(requests, file));
          failures = 0;
          waitMs = pollMs;
          continue;
        }
        failures++;
        if (failures >= MAX_RETRIEVE_FAILURES) throw error;
        waitMs = Math.min(Math.max(MAX_BACKOFF_MS, pollMs), waitMs * 2);
        // The retrieve loop above sleeps before its own next attempt; a results() failure lands here with
        // status already 'ended', which would skip that loop entirely, so back off explicitly instead.
        if (status === 'ended') await sleep(waitMs);
      }
    }

    // Only now, with every result collected, is the batch truly finished: safe to stop resuming it.
    if (file && existsSync(file)) unlinkSync(file);
    return requests.map((r) => byId.get(r.customId) ?? { customId: r.customId, kind: 'error', message: 'missing_result', retryable: true });
  }

  private async createBatch(requests: LlmRequest[], file: string | undefined): Promise<{ batchId: string; status: string }> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({ custom_id: r.customId, params: r.params })),
    });
    if (file) {
      mkdirSync(this.batchDir!, { recursive: true });
      const descriptor: BatchDescriptor = { batchId: batch.id, customIds: requests.map((r) => r.customId), createdAt: new Date().toISOString() };
      writeFileAtomic(file, JSON.stringify(descriptor));
    }
    return { batchId: batch.id, status: batch.processing_status };
  }

  async countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number> {
    if (!this.hasKey) throw new Error(MISSING_KEY_MESSAGE);
    const counted = await this.client.messages.countTokens({ model: params.model, system: params.system, messages: params.messages });
    return counted.input_tokens;
  }
}
