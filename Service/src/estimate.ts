import type Anthropic from '@anthropic-ai/sdk';
import type { ResponseCache } from './cache.js';
import type { WorkGroup } from './grouping.js';
import { bypassesCache, planWork, translateParamsFor, type JobOptions } from './job.js';
import { requestId, type LlmClient, type LlmOutcome, type LlmRequest } from './llm.js';
import { approxInputTokens, runPool } from './llmShared.js';
import type { LocHubStore } from './store.js';

// First-party API list prices in USD per million tokens, verified against each provider's own models/pricing
// pages on 2026-09-26: developers.openai.com/api/docs/{models,pricing}; docs.x.ai/developers/models;
// api-docs.deepseek.com/quick_start/pricing; ai.google.dev/gemini-api/docs/{models,pricing};
// platform.claude.com/docs/en/about-claude/models/overview. Batch mode halves every token (Anthropic only).
export const PRICES_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'grok-4.7': { input: 2, output: 6 },
  'deepseek-v4-pro': { input: 1.32, output: 3.96 },
  'deepseek-flash': { input: 0.3, output: 1.2 },
  // deepseek-v4-flash is a retired model id the API still accepts, routed to deepseek-flash server-side (design
  // doc §2); priced the same so a paid run on that id keeps its budget check instead of silently pricing free.
  'deepseek-v4-flash': { input: 0.3, output: 1.2 },
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  // Google announced a price rise for this model to 1.50 / 7.50 USD per million tokens effective 2027-01-01;
  // update this entry then, or a job on the default Gemini translate model can cost up to twice this estimate.
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
};

// Conservative per-string output guesses (translation JSON with alternatives); the job report logs real usage.
export const OUTPUT_TOKENS_PER_ITEM = 150;
export const JUDGE_OUTPUT_TOKENS_PER_ITEM = 40;

export interface JobEstimate {
  requests: number;
  items: number;
  // Every string in scope the job would actually write: `items` (model-planned) plus TM reuse and cached
  // answers. TM reuse never calls the model; a cached translate answer skips only the translate call — the job
  // can still send it to the judge, so `strings` above `items` is not a full guarantee of "no model call" (see
  // CONTRACT.md's Jobs section). Always >= items; a scope where this is 0 truly has nothing to do, unlike
  // `items` alone, which used to read 0 for a scope that was really free TM/cached work.
  strings: number;
  inputTokens: number;
  outputTokens: number;
  // null when the translate or judge model has no known price (an unlisted or custom model id): the web then
  // shows the estimate without a dollar figure instead of a guess, and the maxUsd requirement is skipped.
  usd: number | null;
  // So the web can hide USD for a backend that is not billed per token (the subscription).
  billing: 'api' | 'subscription';
  // True when at least one group's inputTokens came from approxInputTokens (llmShared.ts) instead of a real
  // count: skipEstimate (no provider calls at all), a rate-limit/overloaded countInputTokens error that
  // survived the SDK's own retries, or a client whose countInputTokens is never a real provider call in the
  // first place (LlmClient.countsAreApproximate, llm.ts — OpenAI-compatible, Gemini, Claude Code/subscription).
  // Absent (never `false`) only when every group's count was a real, successful Anthropic countTokens call.
  approximate?: boolean;
  // Custom endpoints only: true when both Project Settings prices are 0, so usd is 0 and Max USD cannot limit
  // spending (the web says so). Absent (never `false`) otherwise.
  pricesUnset?: boolean;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// A Custom endpoint's own prices apply to whatever model id it serves; built-in providers use the table.
function priceOf(model: string, customPrice: JobOptions['customPrice']): { input: number; output: number } | null {
  return customPrice ?? PRICES_PER_MTOK[model] ?? null;
}

// estimateJob counts a French job of 715 strings with 162 sequential countInputTokens calls in 38.6s
// (estimate-speed-brief.md); this many in flight at once cuts that to roughly requests / 8 round-trips instead
// of one at a time, matching the concurrency job.ts already runs translate/judge requests at
// (DEFAULT_JOB_OPTIONS.concurrency).
const ESTIMATE_CONCURRENCY = 8;

// Bounded so a long-lived service process (CONTRACT.md: the service is a single, long-running process) cannot
// grow this map forever. A full clear instead of an LRU: the cost of a miss is only one more countInputTokens
// call, so "clear it all at 50k entries" trades a rare, cheap re-count for not having to maintain recency
// order — a process that has ever counted 50k distinct groups is already an unusual case, and whatever half an
// LRU would have kept is mostly re-populated within the next few jobs anyway.
const MAX_COUNT_CACHE_ENTRIES = 50_000;

// Process-lifetime memo of requestId(params) -> real input token count (estimate-speed-brief.md §2), meant to be
// shared by /api/jobs/estimate and POST /api/jobs so Run-after-Estimate and a repeated Estimate make no provider
// calls for a group already counted. requestId already hashes the whole request — model, prompt version,
// glossary, context, brief, source (llm.ts) — so a changed brief/glossary/model/source is simply a different
// key and gets counted again on its own; nothing here needs to know what changed.
export class TokenCountCache {
  private readonly counts = new Map<string, number>();

  get(id: string): number | undefined {
    return this.counts.get(id);
  }

  // Only a real count is ever remembered here — estimateJob never calls this for an approxInputTokens fallback.
  remember(id: string, tokens: number): void {
    if (!this.counts.has(id) && this.counts.size >= MAX_COUNT_CACHE_ENTRIES) this.counts.clear();
    this.counts.set(id, tokens);
  }
}

// The Anthropic SDK's ErrorType includes 'rate_limit_error' (status 429) and 'overloaded_error' (Anthropic's
// 529 "the model is overloaded", which the SDK maps to InternalServerError since it only branches on
// status >= 500 for a 5xx it does not special-case — node_modules/@anthropic-ai/sdk/core/error.js:39-70,
// resources/shared.d.ts:19,34). Both are already retried by the SDK itself with backoff before this ever sees
// the error: node_modules/@anthropic-ai/sdk/client.js's shouldRetry (:730-741, retrying 408/409/429/>=500) and
// its maxRetries default of 2 (:65 doc comment, :112 `this.maxRetries = ... ?? 2`) — three attempts total, the
// same envelope llmShared.ts's fetchWithRetry doc comment cites for the two fetch-based providers.
//
// The thrown error's `.status` is the HTTP status (429, 529, …). `.type` is the response body's *inner*
// `error.type`: `APIError.generate` reads it as `error?.['error']?.['type']` (core/error.js:44) and the
// constructor stores it as `this.type = type ?? null` (core/error.js:18-19). `.error` is the *whole*
// `ErrorResponse` body — `{ type: 'error', error: { type, message }, request_id }`
// (resources/shared.d.ts:14-18) — whose own `.type` is always the literal `'error'`, never the real error
// kind, so `.error.type` must never be checked here; that was R2-I1 (a real 529 has `err.error.type ===
// 'error'`, which matched neither branch, so the overloaded fallback never fired). Duck-typed on
// `.status`/`.type` (not `instanceof Anthropic.APIError`) so a test's fake error need not construct a real
// SDK error class, though the tests below build real ones anyway (`APIError.generate`) to prove the shape.
function isRateLimitOrOverloaded(error: unknown): boolean {
  const err = error as { status?: unknown; type?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const type = typeof err?.type === 'string' ? err.type : undefined;
  return status === 429 || status === 529 || type === 'rate_limit_error' || type === 'overloaded_error';
}

export interface EstimateExtras {
  // Shared across calls (server.ts holds one instance per running service) so a second estimate of the same
  // scope, or Run after Estimate, makes no provider calls for a group already counted (part 2 above). A fresh
  // instance is used when omitted, which is the same as "no memo" — every existing caller/test keeps working.
  countCache?: TokenCountCache;
  // POST /api/jobs's skipEstimate (estimate-speed-brief.md §3): every group's tokens come from
  // approxInputTokens with no provider call at all, and the result is always marked `approximate: true`.
  skipNetwork?: boolean;
}

// Upper-bound estimate of a translate job. TM reuse and groups with a usable cached answer are free and skipped;
// repairs are not predicted (the job report shows the real usage). Token counting for the remaining groups runs
// with bounded concurrency (ESTIMATE_CONCURRENCY) instead of one request at a time.
export async function estimateJob(
  store: LocHubStore,
  llm: LlmClient,
  cache: ResponseCache,
  opts: JobOptions,
  billing: 'api' | 'subscription' = 'api',
  extra: EstimateExtras = {},
): Promise<JobEstimate> {
  const translatePrice = priceOf(opts.translateModel, opts.customPrice);
  const judgePrice = priceOf(opts.judgeModel, opts.customPrice);
  const pricesUnset = opts.customPrice !== undefined && opts.customPrice.input === 0 && opts.customPrice.output === 0;
  const plan = planWork(store, opts);
  // TM reuse never reaches plan.groups at all; a cached group is counted below, as it is found.
  let strings = plan.tmHits.length;

  const toCount: { customId: string; group: WorkGroup; params: Anthropic.MessageCreateParamsNonStreaming }[] = [];
  for (const group of plan.groups) {
    const params = translateParamsFor(store, plan.ctx, group, opts);
    if (!bypassesCache(group) && cache.get(requestId(params))) {
      strings += group.items.length;
      continue;
    }
    toCount.push({ customId: requestId(params), group, params });
  }

  let requests = 0;
  let items = 0;
  let inputTokens = 0;
  let approximate = false;

  if (extra.skipNetwork) {
    for (const { group, params } of toCount) {
      requests++;
      items += group.items.length;
      inputTokens += approxInputTokens(params);
    }
    approximate = toCount.length > 0;
  } else {
    const countCache = extra.countCache ?? new TokenCountCache();
    // Populated only for a hard (non-rate-limit) countInputTokens failure, so it can be rethrown as-is after
    // the pool settles — runOne itself never throws (runPool's contract), it reports the failure as an
    // LlmOutcome and this map carries the original error alongside it.
    const rawErrors = new Map<string, unknown>();
    const approxIds = new Set<string>();
    // R2-I2: once a rate-limit/overloaded error has exhausted the SDK's own retries, every group not yet
    // started must be approximated instead of making its own doomed provider call; once a hard error has
    // happened, every group not yet started must be skipped instead of paying for a call whose outcome is
    // thrown away anyway (the whole estimate fails). Checked at the very start of each pool task, before
    // countInputTokens, so it stops tasks not yet dispatched — the tasks already in flight alongside the one
    // that failed (at most ESTIMATE_CONCURRENCY - 1 of them) still complete on their own. A plain `let` here
    // would let TypeScript narrow `stop` from one pool task's own early-return guards and (wrongly, since
    // concurrent tasks mutate it too) carry that narrowing across the `await` inside another task or past the
    // whole `runPool` call below; a one-field object sidesteps that — `state.stop` only ever moves forward
    // (none -> approximate/fail), never back, and 'fail' always wins over 'approximate' once set.
    const state: { stop: 'none' | 'approximate' | 'fail' } = { stop: 'none' };
    // A plain `state.stop !== 'fail'` read below would still get narrowed by TypeScript's control-flow
    // analysis to the literal 'none' left over from the early-return guards above (real for a single
    // invocation in isolation, but not once a concurrent pool task's own catch block can set it to 'fail' in
    // between) -- routing the read through a function call is what actually defeats that narrowing.
    const currentStop = (): typeof state.stop => state.stop;
    let firstHardError: unknown;
    const counted = await runPool(
      toCount.map((t): LlmRequest => ({ customId: t.customId, params: t.params })),
      ESTIMATE_CONCURRENCY,
      async (request): Promise<LlmOutcome> => {
        const remembered = countCache.get(request.customId);
        if (remembered !== undefined) return { customId: request.customId, kind: 'ok', text: '', inputTokens: remembered, outputTokens: 0 };
        if (state.stop === 'fail') return { customId: request.customId, kind: 'error', message: 'count_skipped', retryable: false };
        if (state.stop === 'approximate') {
          approxIds.add(request.customId);
          return { customId: request.customId, kind: 'ok', text: '', inputTokens: approxInputTokens(request.params), outputTokens: 0 };
        }
        try {
          const tokens = await llm.countInputTokens(request.params);
          countCache.remember(request.customId, tokens);
          // R2-M1/Minor: a client whose countInputTokens is never a real provider call (OpenAI-compatible,
          // Gemini, the Claude Code/subscription adapter) marks its own groups approximate too, even though
          // this call itself did not throw — "approximate" means the number is a local guess, not that a
          // provider call failed.
          if (llm.countsAreApproximate) approxIds.add(request.customId);
          return { customId: request.customId, kind: 'ok', text: '', inputTokens: tokens, outputTokens: 0 };
        } catch (error) {
          if (isRateLimitOrOverloaded(error)) {
            if (state.stop === 'none') state.stop = 'approximate';
            approxIds.add(request.customId);
            return { customId: request.customId, kind: 'ok', text: '', inputTokens: approxInputTokens(request.params), outputTokens: 0 };
          }
          if (currentStop() !== 'fail') { state.stop = 'fail'; firstHardError = error; }
          rawErrors.set(request.customId, error);
          return { customId: request.customId, kind: 'error', message: 'count_failed', retryable: false };
        }
      },
    );
    // Every hard error observed anywhere during the pool's run leaves `state.stop === 'fail'` by the time
    // runPool's own Promise.all has settled, regardless of which task's catch block set it first — so this
    // single check after the pool covers every hard-error outcome; the loop below never sees one.
    if (state.stop === 'fail') throw firstHardError;
    for (let i = 0; i < toCount.length; i++) {
      const outcome = counted[i]!;
      // Any other error still fails the request, exactly as the old sequential loop's unhandled throw did.
      // runOne above only ever returns 'ok' or 'error' (never 'refusal'), but the check is on `!== 'ok'`
      // rather than `=== 'error'` so the compiler can narrow `outcome.inputTokens` below.
      if (outcome.kind !== 'ok') throw rawErrors.get(outcome.customId);
      requests++;
      items += toCount[i]!.group.items.length;
      inputTokens += outcome.inputTokens;
    }
    approximate = approxIds.size > 0;
  }

  strings += items;
  const translateOut = items * OUTPUT_TOKENS_PER_ITEM;
  const judgeIn = inputTokens + translateOut;
  const judgeOut = items * JUDGE_OUTPUT_TOKENS_PER_ITEM;
  const discount = opts.mode === 'batch' ? 0.5 : 1;
  const usd =
    translatePrice && judgePrice
      ? ((inputTokens * translatePrice.input + translateOut * translatePrice.output + judgeIn * judgePrice.input + judgeOut * judgePrice.output) /
          1_000_000) *
        discount
      : null;
  return {
    requests,
    items,
    strings,
    inputTokens,
    outputTokens: translateOut + judgeOut,
    usd,
    billing,
    ...(approximate ? { approximate: true as const } : {}),
    ...(pricesUnset ? { pricesUnset: true as const } : {}),
  };
}

// A no-op when usd is null (unpriced model): the caller only reaches here when billing = 'api' and usd is
// known, but this stays safe on its own regardless.
export function assertWithinBudget(estimate: JobEstimate, maxUsd: number): void {
  if (estimate.usd !== null && estimate.usd > maxUsd)
    throw new BudgetExceededError(`Estimated $${estimate.usd.toFixed(2)} exceeds the limit of $${maxUsd.toFixed(2)}`);
}
