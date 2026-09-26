import { APIError } from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../src/cache.js';
import type { SnapshotEntry } from '../src/contract.js';
import { assertWithinBudget, BudgetExceededError, estimateJob, TokenCountCache } from '../src/estimate.js';
import { GeminiLlmClient } from '../src/gemini.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS, planWork, translateParamsFor, type JobOptions } from '../src/job.js';
import { AnthropicLlmClient, requestId } from '../src/llm.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient, ok } from './fakeLlm.js';

const entry = (key: string, groupKey: string): SnapshotEntry => ({
  namespace: 'HW', key, source: key, origin: 'o', devNotes: '', metadata: {}, groupKey,
});

function setup() {
  const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-est-')));
  applySnapshot(store, { target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {}, entries: [entry('A', 'g1'), entry('B', 'g1'), entry('C', 'g2')] });
  return { store, cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-estc-'))) };
}

// N units sharing one groupKey; with groupSize: 1 (buildGroups splits a key's items into chunks of maxSize)
// this yields exactly N single-item groups, each with distinct source text "K<i>" — enough groups to prove
// bounded concurrency actually overlaps (> 1) while staying <= ESTIMATE_CONCURRENCY (8).
function manyGroupsSetup(n: number) {
  const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-est-many-')));
  const entries = Array.from({ length: n }, (_, i) => entry(`K${i}`, 'g'));
  applySnapshot(store, { target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {}, entries });
  return { store, cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-estc-many-'))) };
}

// Rate-limit / overloaded errors built the way the Anthropic SDK really builds them (R2-I1: a hand-shaped
// object that merely looked like one masked the bug -- err.error.type is always the literal 'error', never
// the real kind; the real kind is err.type, set by APIError.generate from the body's *inner* error.type).
// `APIError.generate` is what node_modules/@anthropic-ai/sdk/client.js calls after retries are exhausted, so
// this is the exact shape isRateLimitOrOverloaded (estimate.ts) has to classify.
function apiError(status: number, type: string): Error {
  const body = { type: 'error' as const, error: { type, message: type }, request_id: null };
  return APIError.generate(status, body, undefined, new Headers()) as unknown as Error;
}
function rateLimitError(): Error {
  return apiError(429, 'rate_limit_error');
}
function overloadedError(): Error {
  return apiError(529, 'overloaded_error');
}

const opts = (o: Partial<JobOptions> = {}): JobOptions => ({ ...DEFAULT_JOB_OPTIONS, culture: 'ru', ...o });
const llm = new FakeLlmClient((r) => ok(r.customId, {}));

describe('estimateJob', () => {
  it('counts one request per group and halves the price in batch mode', async () => {
    const { store, cache } = setup();
    const batch = await estimateJob(store, llm, cache, opts({ mode: 'batch' }));
    const sync = await estimateJob(store, llm, cache, opts({ mode: 'sync' }));
    expect(batch).toMatchObject({ requests: 2, items: 3, inputTokens: 2000 });
    expect(batch.usd).toBeCloseTo(sync.usd / 2, 10);
    expect(sync.usd).toBeGreaterThan(0);
  });

  it('skips cached groups unless they hold a needs_fix cell', async () => {
    const { store, cache } = setup();
    const o = opts();
    const plan = planWork(store, o);
    const first = plan.groups[0]!;
    cache.put(ok(requestId(translateParamsFor(store, plan.ctx, first, o)), { items: [] }));
    expect((await estimateJob(store, llm, cache, o)).requests).toBe(1);

    store.putCell({ ...store.getCell('ru', first.items[0]!.unit.id), text: 'x', status: 'needs_fix', basedOnSourceRev: 1 });
    expect((await estimateJob(store, llm, cache, o)).requests).toBe(2);
  });

  // `items` alone hid free work (TM reuse, cached answers) from the web's Run gate. `strings` counts every
  // string the job would actually write, model-planned or not.
  it('counts a fully cached scope in strings but not in items', async () => {
    const { store, cache } = setup();
    const o = opts();
    const plan = planWork(store, o);
    for (const group of plan.groups) {
      const items = group.items.map((w) => ({ id: w.unit.id, translation: `${w.unit.source} (ru)`, ambiguity: 'none', alts: [], question: '' }));
      cache.put(ok(requestId(translateParamsFor(store, plan.ctx, group, o)), { items }));
    }
    const estimate = await estimateJob(store, llm, cache, o);
    expect(estimate).toMatchObject({ requests: 0, items: 0, strings: 3 });
  });

  it('counts a TM-only scope in strings but not in items, with usd: 0', async () => {
    const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-est-tm-')));
    applySnapshot(store, {
      target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
      entries: [entry('Donor', 'g1'), { namespace: 'HW', key: 'Recipient', source: 'Donor', origin: 'o', devNotes: '', metadata: {}, groupKey: 'g1' }],
    });
    const donorId = unitIdOf('HW', 'Donor');
    store.putCell({ ...store.getCell('ru', donorId), text: 'Донор', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'Donor' });
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-estc-tm-')));
    const estimate = await estimateJob(store, llm, cache, opts());
    expect(estimate).toMatchObject({ requests: 0, items: 0, strings: 1, usd: 0 });
  });

  it('reports usd: null for an unknown model instead of guessing its price', async () => {
    const { store, cache } = setup();
    expect((await estimateJob(store, llm, cache, opts({ translateModel: 'claude-unknown' }))).usd).toBeNull();
  });

  // deepseek-v4-flash is a retired model id the API still accepts; it must keep pricing
  // (and therefore the budget check) instead of silently becoming unpriced, so it is priced the same as its
  // replacement, deepseek-flash.
  it('prices the retired deepseek-v4-flash id the same as deepseek-flash', async () => {
    const { store, cache } = setup();
    const current = await estimateJob(store, llm, cache, opts({ translateModel: 'deepseek-flash', judgeModel: 'deepseek-flash' }));
    const retiredAlias = await estimateJob(store, llm, cache, opts({ translateModel: 'deepseek-v4-flash', judgeModel: 'deepseek-v4-flash' }));
    expect(retiredAlias.usd).not.toBeNull();
    expect(retiredAlias.usd).toBe(current.usd);
  });
});

describe('assertWithinBudget', () => {
  it('throws above the limit', () => {
    const estimate = { requests: 1, items: 1, strings: 1, inputTokens: 1, outputTokens: 1, usd: 3, billing: 'api' as const };
    expect(() => assertWithinBudget(estimate, 2)).toThrow(BudgetExceededError);
    expect(() => assertWithinBudget(estimate, 5)).not.toThrow();
  });
});

// estimate-speed-brief.md §1: bounded-concurrency token counting.
describe('estimateJob concurrency', () => {
  it('counts groups with concurrency > 1 and <= 8, with the same per-group totals a sequential run would produce', async () => {
    const groupCount = 12;
    const { store, cache } = manyGroupsSetup(groupCount);
    // Each group's fake count is derived from its own source text ("K<i>" -> 1000 + i) instead of one constant,
    // so a bug that lost, duplicated or mis-attributed a group's count under concurrent execution would show up
    // as a wrong sum instead of being masked by every call returning the same number.
    const tracked = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      {
        countInputTokens: async (params) => {
          const content = typeof params.messages[0]?.content === 'string' ? (params.messages[0]!.content as string) : '';
          const match = content.match(/K(\d+)/);
          return 1000 + Number(match?.[1] ?? -1000);
        },
      },
    );
    const estimate = await estimateJob(store, tracked, cache, opts({ groupSize: 1 }));
    const expectedInputTokens = Array.from({ length: groupCount }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0);
    expect(estimate).toMatchObject({ requests: groupCount, items: groupCount, inputTokens: expectedInputTokens });
    expect(tracked.countInputTokensCalls).toBe(groupCount);
    expect(tracked.maxConcurrentCountInputTokens).toBeGreaterThan(1);
    expect(tracked.maxConcurrentCountInputTokens).toBeLessThanOrEqual(8);
    // R2-M1: nothing here failed and FakeLlmClient's counts are real ones (not countsAreApproximate), so a
    // regression that marked every estimate approximate would slip past every other assertion in this file.
    expect(estimate.approximate).toBeUndefined();
  });

  it('after a rate-limit/overloaded failure exhausts the SDK, no further group makes a real countInputTokens call', async () => {
    const groupCount = 40;
    const { store, cache } = manyGroupsSetup(groupCount);
    const rateLimited = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      {
        countInputTokens: async () => {
          throw rateLimitError();
        },
      },
    );
    const estimate = await estimateJob(store, rateLimited, cache, opts({ groupSize: 1 }));
    // Every group not yet dispatched when the first failure lands must be approximated locally instead of
    // making its own doomed call (R2-I2): only the tasks already in flight alongside the failing one -- at
    // most ESTIMATE_CONCURRENCY (8) of the 40 -- ever reach the fake provider at all.
    expect(rateLimited.countInputTokensCalls).toBeLessThanOrEqual(8);
    expect(rateLimited.countInputTokensCalls).toBeLessThan(groupCount);
    expect(estimate.approximate).toBe(true);
    expect(estimate).toMatchObject({ requests: groupCount, items: groupCount });
  });

  it('after a hard countInputTokens error, no further group makes a real call before the estimate fails', async () => {
    const groupCount = 40;
    const { store, cache } = manyGroupsSetup(groupCount);
    const hardFailure = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      {
        countInputTokens: async () => {
          throw apiError(401, 'authentication_error');
        },
      },
    );
    await expect(estimateJob(store, hardFailure, cache, opts({ groupSize: 1 }))).rejects.toThrow('authentication_error');
    // Same bound as the rate-limit case: only the tasks already in flight alongside the first hard failure
    // ever call the fake provider -- every group behind them is skipped, not paid for and discarded.
    expect(hardFailure.countInputTokensCalls).toBeLessThanOrEqual(8);
    expect(hardFailure.countInputTokensCalls).toBeLessThan(groupCount);
  });

  it.each([
    ['rate_limit_error (429)', rateLimitError],
    ['overloaded_error (Anthropic 529, mapped to InternalServerError by the SDK)', overloadedError],
  ])('falls back to approxInputTokens and marks the estimate approximate on %s after the SDK exhausts its own retries', async (_name, makeError) => {
    const { store, cache } = setup();
    const rateLimited = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      { countInputTokens: async () => { throw makeError(); } },
    );
    const estimate = await estimateJob(store, rateLimited, cache, opts());
    expect(estimate.approximate).toBe(true);
    // The scope's usual shape (setup(): g1 has A+B, g2 has C -- 2 groups, 3 items) still comes through the
    // fallback path: the request still fails to reach the model, but the estimate itself does not fail.
    expect(estimate).toMatchObject({ requests: 2, items: 3, strings: 3 });
    expect(estimate.inputTokens).toBeGreaterThan(0);
  });

  it('still fails the estimate for a countInputTokens error that is not rate-limit/overloaded', async () => {
    const { store, cache } = setup();
    const hardFailure = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      { countInputTokens: async () => { throw Object.assign(new Error('bad request'), { status: 400 }); } },
    );
    await expect(estimateJob(store, hardFailure, cache, opts())).rejects.toThrow('bad request');
  });

  // R2-I1: a real SDK 5xx that is neither status 529 nor a body type of 'overloaded_error' (an ordinary
  // 500 api_error, e.g. a transient outage the SDK's own retries did not recover from) must still fail the
  // estimate -- only 529/overloaded_error and 429/rate_limit_error take the approxInputTokens fallback.
  it('still fails the estimate for a real SDK 500 api_error (not 529/overloaded_error)', async () => {
    const { store, cache } = setup();
    const hardFailure = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      { countInputTokens: async () => { throw apiError(500, 'api_error'); } },
    );
    await expect(estimateJob(store, hardFailure, cache, opts())).rejects.toThrow('api_error');
  });
});

// estimate-speed-brief.md §2: process-lifetime memo of real counts, shared across calls via a TokenCountCache.
describe('estimateJob count cache (TokenCountCache)', () => {
  it('makes zero further countInputTokens calls for a repeated estimate of the same scope', async () => {
    const { store, cache } = setup();
    const tracked = new FakeLlmClient((r) => ok(r.customId, {}));
    const countCache = new TokenCountCache();
    const first = await estimateJob(store, tracked, cache, opts(), 'api', { countCache });
    expect(tracked.countInputTokensCalls).toBe(2); // g1 and g2, neither cached yet
    expect(first.approximate).toBeUndefined(); // R2-M1: every group here is a real count, never a fallback
    const callsAfterFirst = tracked.countInputTokensCalls;
    const second = await estimateJob(store, tracked, cache, opts(), 'api', { countCache });
    expect(tracked.countInputTokensCalls).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it('only remembers real counts: a scope that only ever hits the rate-limit fallback is recounted next time', async () => {
    const { store, cache } = setup();
    const rateLimited = new FakeLlmClient(
      (r) => ok(r.customId, {}),
      { countInputTokens: async () => { throw rateLimitError(); } },
    );
    const countCache = new TokenCountCache();
    await estimateJob(store, rateLimited, cache, opts(), 'api', { countCache });
    const callsAfterFirst = rateLimited.countInputTokensCalls;
    await estimateJob(store, rateLimited, cache, opts(), 'api', { countCache });
    // Both groups are attempted again -- an approximation is never remembered, so there is nothing to skip.
    expect(rateLimited.countInputTokensCalls).toBe(callsAfterFirst * 2);
  });

  it('recounts only the groups a changed translateModel affects (different requestId, same countCache)', async () => {
    const { store, cache } = setup();
    const tracked = new FakeLlmClient((r) => ok(r.customId, {}));
    const countCache = new TokenCountCache();
    const first = await estimateJob(store, tracked, cache, opts(), 'api', { countCache });
    expect(first.approximate).toBeUndefined(); // R2-M1: real counts throughout, never a fallback
    const callsAfterFirst = tracked.countInputTokensCalls;
    await estimateJob(store, tracked, cache, opts({ translateModel: 'claude-sonnet-5' }), 'api', { countCache });
    // Every group's requestId includes the model (llm.ts), so a changed translateModel is a full re-count here.
    expect(tracked.countInputTokensCalls).toBe(callsAfterFirst * 2);
  });
});

// R2-M1/Minor: `approximate` must reflect whether a group's tokens came from a real provider call, not just
// whether that call happened to throw. Anthropic's real countTokens is exact; the OpenAI-compatible, Gemini
// and Claude Code/subscription adapters have no free token-count endpoint and always return approxInputTokens
// (openaiCompatible.ts, gemini.ts, claudeCode.ts) even though countInputTokens never throws for them.
describe('estimateJob approximate flag reflects exact vs. always-local counting clients', () => {
  it('is absent for a fully real Anthropic count', async () => {
    const { store, cache } = setup();
    const fakeSdk = {
      messages: { countTokens: async () => ({ input_tokens: 42 }) },
    } as unknown as Anthropic;
    const anthropic = new AnthropicLlmClient({ client: fakeSdk });
    const estimate = await estimateJob(store, anthropic, cache, opts());
    expect(estimate.approximate).toBeUndefined();
    expect(estimate.inputTokens).toBe(84); // 42 per group, 2 groups (g1, g2)
  });

  it('is present for a provider whose counts are always a local guess', async () => {
    const { store, cache } = setup();
    // GeminiLlmClient.countInputTokens never touches the network -- it returns approxInputTokens directly
    // (gemini.ts) -- so no apiKey/fetch stubbing is needed to exercise the real adapter here.
    const gemini = new GeminiLlmClient();
    const estimate = await estimateJob(store, gemini, cache, opts());
    expect(estimate.approximate).toBe(true);
    expect(estimate.inputTokens).toBeGreaterThan(0);
  });
});

// estimate-speed-brief.md §3: POST /api/jobs's skipEstimate, at the estimateJob level (server.test.ts covers the route).
describe('estimateJob skipNetwork', () => {
  it('computes a fully local, approximate estimate with zero countInputTokens calls', async () => {
    const { store, cache } = setup();
    const tracked = new FakeLlmClient((r) => ok(r.customId, {}));
    const estimate = await estimateJob(store, tracked, cache, opts(), 'api', { skipNetwork: true });
    expect(tracked.countInputTokensCalls).toBe(0);
    expect(estimate.approximate).toBe(true);
    expect(estimate).toMatchObject({ requests: 2, items: 3, strings: 3 });
  });

  it('never marks approximate for a scope with nothing to count (TM/cache reuse only)', async () => {
    const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-est-tm-skip-')));
    applySnapshot(store, {
      target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
      entries: [entry('Donor', 'g1'), { namespace: 'HW', key: 'Recipient', source: 'Donor', origin: 'o', devNotes: '', metadata: {}, groupKey: 'g1' }],
    });
    const donorId = unitIdOf('HW', 'Donor');
    store.putCell({ ...store.getCell('ru', donorId), text: 'Донор', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'Donor' });
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-estc-tm-skip-')));
    const tracked = new FakeLlmClient((r) => ok(r.customId, {}));
    const estimate = await estimateJob(store, tracked, cache, opts(), 'api', { skipNetwork: true });
    expect(estimate).toMatchObject({ requests: 0, items: 0, strings: 1 });
    expect(estimate.approximate).toBeUndefined();
  });
});
