import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHub } from '../src/bridge.js';
import { ResponseCache } from '../src/cache.js';
import { emptyCell, type Snapshot } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';
import { pluralCategories } from '../src/precheck.js';
import { jobDefaultsFor, NO_KEY_NEEDED_DETAIL, type AiConfig } from '../src/providers.js';
import { applySnapshot } from '../src/push.js';
import { buildServer } from '../src/server.js';
import { LENGTH_CHECK_OFF, type LengthCheckConfig } from '../src/lengthCheck.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient, isJudgeRequest, ok, requestItems } from './fakeLlm.js';

const snapshot: Snapshot = {
  target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
  entries: [
    { namespace: 'HW', key: 'A', source: 'PAUSED', origin: 'o', devNotes: '', metadata: {}, groupKey: 'Pause' },
    { namespace: 'HW', key: 'B', source: '{Count} bales left', origin: 'o', devNotes: '', metadata: {}, groupKey: 'Hud' },
  ],
};

// What buildServer's own default (no deps.briefSha1) reports: the hash of an empty brief, exactly what an old
// build's absent --brief-file would have hashed to under the new cli.ts.
const EMPTY_BRIEF_SHA1 = createHash('sha1').update('').digest('hex');

const RU: Record<string, string> = { PAUSED: 'ПАУЗА', '{Count} bales left': 'Осталось {Count} тюков' };
const respond = (r: any) =>
  isJudgeRequest(r)
    ? ok(r.customId, { issues: [] })
    : ok(r.customId, { items: requestItems(r).map((i: any) => ({ id: i.id, translation: RU[i.source as string], ambiguity: 'none', alts: [], question: '', terms_used: [] })) });
const llm = new FakeLlmClient(respond);

// Holds countInputTokens until released, so a second request can arrive while the first is still estimating.
class GatedLlm extends FakeLlmClient {
  entered!: () => void;
  readonly enteredOnce = new Promise<void>((resolve) => (this.entered = resolve));
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));

  async countInputTokens(params: Parameters<FakeLlmClient['countInputTokens']>[0]): Promise<number> {
    this.entered();
    await this.gate;
    return super.countInputTokens(params);
  }
}

// Holds runSync until released: unlike GatedLlm (gated before the job record exists), this lets the job record
// get created and reach status 'running' first, so a test can observe it that way (GET /api/jobs?culture=, the
// job_running 409's jobId) before the job finishes.
class GatedRunLlm extends FakeLlmClient {
  entered!: () => void;
  readonly enteredOnce = new Promise<void>((resolve) => (this.entered = resolve));
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));

  async runSync(
    requests: Parameters<FakeLlmClient['runSync']>[0],
    concurrency?: Parameters<FakeLlmClient['runSync']>[1],
    onOutcome?: Parameters<FakeLlmClient['runSync']>[2],
  ): ReturnType<FakeLlmClient['runSync']> {
    this.entered();
    await this.gate;
    return super.runSync(requests, concurrency, onOutcome);
  }
}

let bridge: BridgeHub;
let app: ReturnType<typeof buildServer>;
let store: LocHubStore;
const idA = unitIdOf('HW', 'A');

// app.inject defaults the Host header to 'localhost:80' when the request gives none, so every test server in
// this file binds the same port and only tests of the Host allowlist itself need to override the header.
const PORT = 80;

// POST /api/jobs and /api/jobs/estimate 400 ai_not_ready before any LLM call when auth is 'api' and
// LOCHUB_API_KEY is unset (key-contract.md §2: the service reads only this one variable, whatever provider is
// configured). Real process.env has no test keys, so every server built below needs an injected env with a
// placeholder key to keep exercising its job/estimate behaviour.
const API_KEY_ENV = { LOCHUB_API_KEY: 'test-key-not-real' };

// key-contract.md §3: first 12 lowercase hex characters of SHA-1 over the key's UTF-8 bytes -- what
// API_KEY_ENV.LOCHUB_API_KEY hashes to, so a health assertion can check ai.keyId without hardcoding the hash.
const API_KEY_ID = createHash('sha1').update(API_KEY_ENV.LOCHUB_API_KEY).digest('hex').slice(0, 12);

beforeEach(async () => {
  // Real process.env has no test keys, so every server built below with the default ai (Anthropic,
  // api) reads ai_not_ready unless a key is present. vi.stubEnv (not deps.env — the health "not ready" test
  // further below overrides this per-test with its own vi.stubEnv, which only works against process.env) keeps
  // the shared `app`'s jobs/estimate behaviour exercised, the same placeholder already used elsewhere in this file.
  vi.stubEnv('LOCHUB_API_KEY', API_KEY_ENV.LOCHUB_API_KEY);
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
  bridge = new BridgeHub();
  app = buildServer({
    store,
    llm,
    cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
    jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
    bridge,
    policy: 'validated',
    port: PORT,
  });
  await app.inject({ method: 'POST', url: '/api/push', payload: snapshot });
});

async function waitForJob(jobId: string, target: ReturnType<typeof buildServer> = app) {
  for (let i = 0; i < 100; i++) {
    const res = await target.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    if (res.json().status !== 'running') return res.json();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

describe('server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports health, with Anthropic ready when LOCHUB_API_KEY is set, plus its keyId', async () => {
    vi.stubEnv('LOCHUB_API_KEY', API_KEY_ENV.LOCHUB_API_KEY);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      ok: true, units: 2, editorConnected: false, pid: process.pid, projectDir: '', stale: false, jobRunning: false, jobsFinished: 0,
      ai: {
        provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5',
        // M-4: the detail text for a present key never names the internal variable.
        batch: true, ready: true, detail: 'API key is set', briefSha1: EMPTY_BRIEF_SHA1, keyId: API_KEY_ID,
        lengthArgs: '--length-check off',
      },
    });
  });

  it('reports ai.briefSha1 from deps.briefSha1 when the caller (cli.ts) supplies one', async () => {
    vi.stubEnv('LOCHUB_API_KEY', API_KEY_ENV.LOCHUB_API_KEY);
    const briefSha1 = createHash('sha1').update('This is a farming sim.').digest('hex');
    const briefedApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      briefSha1,
    });
    expect((await briefedApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ai: { briefSha1 } });
  });

  // key-contract.md §2: the service reads only LOCHUB_API_KEY, whatever provider is configured -- every
  // provider-specific variable (including Anthropic's own ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) is ignored,
  // and the missing-key message is the fixed contract text (§4), not a variable name.
  it('reports Anthropic as not ready and with keyId "" when LOCHUB_API_KEY is unset, even with every provider variable set', async () => {
    vi.stubEnv('LOCHUB_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-be-ignored');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'should-be-ignored');
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      ai: { batch: true, ready: false, detail: MISSING_KEY_MESSAGE, keyId: '' },
    });
  });

  it('reports OpenAI as not ready and without Batch when LOCHUB_API_KEY is unset, even with OPENAI_API_KEY set', async () => {
    vi.stubEnv('LOCHUB_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-be-ignored');
    // No explicit jobDefaults here (the original fixture mixed ai = gpt-6-sol with jobDefaults =
    // claude-opus-5-5/claude-sonnet-5) — buildServer must derive it from `ai` via jobDefaultsFor so health and
    // jobs cannot disagree about which models are in use.
    const openAiApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
    });
    expect((await openAiApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      ai: { provider: 'openai', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna', batch: false, ready: false, detail: MISSING_KEY_MESSAGE, keyId: '' },
    });
  });

  // With no explicit jobDefaults, buildServer must derive translate/judge models (and mode) from `ai`
  // via jobDefaultsFor — proven here by comparing against a deliberately mismatched fixture (ai = openai,
  // jobDefaults left at the Anthropic defaults), which used to be silently accepted.
  it('derives jobDefaults from ai when none is given explicitly, so health and jobs cannot disagree', async () => {
    const ai: AiConfig = { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' };
    const derivedApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      ai,
      env: API_KEY_ENV,
    });
    const mismatchedApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 }, // deliberately still claude-opus-5-5 / claude-sonnet-5
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      ai,
      env: API_KEY_ENV,
    });
    const derivedEstimate = (await derivedApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } })).json().estimate;
    const mismatchedEstimate = (await mismatchedApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } })).json().estimate;
    // Different translate/judge models price differently (gpt-6-sol/gpt-6-luna vs claude-opus-5-5/claude-sonnet-5):
    // the derived app must actually use ai's models, not silently fall back to the Anthropic defaults.
    expect(derivedEstimate.usd).not.toBe(mismatchedEstimate.usd);
  });

  // pid identifies an owned/orphaned process, projectDir tells apart a
  // service belonging to another project, stale surfaces store.changedOnDisk().
  it('reports health with pid, the given projectDir, and stale: false on a fresh store', async () => {
    vi.stubEnv('LOCHUB_API_KEY', API_KEY_ENV.LOCHUB_API_KEY);
    const freshStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
    const freshApp = buildServer({
      store: freshStore,
      llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      projectDir: 'D:/Projects/MyGame',
    });
    expect((await freshApp.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      ok: true, units: 0, editorConnected: false, pid: process.pid, projectDir: 'D:/Projects/MyGame', stale: false, jobRunning: false, jobsFinished: 0,
      ai: {
        provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5',
        batch: true, ready: true, detail: 'API key is set', briefSha1: EMPTY_BRIEF_SHA1, keyId: API_KEY_ID,
        lengthArgs: '--length-check off',
      },
    });
  });

  it('reports the subscription backend health from the injected auth probe', async () => {
    const subApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      ai: { provider: 'anthropic', auth: 'subscription', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
      authProbe: async () => ({ ready: true, detail: 'Signed in to Claude Code' }),
    });
    expect((await subApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      ai: { provider: 'anthropic', auth: 'subscription', batch: false, ready: true, detail: 'Signed in to Claude Code' },
    });
  });

  it('reports the subscription backend as not ready when the auth probe says so', async () => {
    const subApp = buildServer({
      store, llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      ai: { provider: 'anthropic', auth: 'subscription', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
      authProbe: async () => ({ ready: false, detail: 'Claude Code is not signed in: run "claude" once and sign in.' }),
    });
    expect((await subApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      ai: { batch: false, ready: false, detail: 'Claude Code is not signed in: run "claude" once and sign in.' },
    });
  });

  it('rejects a snapshot without entries', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/push', payload: { target: 'Game' } })).statusCode).toBe(400);
  });

  it('runs a job within budget, lists cells, exports and acknowledges', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    expect(started.statusCode).toBe(202);
    const job = await waitForJob(started.json().jobId);
    expect(job).toMatchObject({ status: 'done', report: { written: 2 } });

    const cells = (await app.inject({ method: 'GET', url: '/api/cells?culture=ru&band=G' })).json();
    expect(cells.total).toBe(2);

    const exported = (await app.inject({ method: 'GET', url: '/api/export?culture=ru' })).json();
    expect(exported.entries.map((e: { translation: string }) => e.translation).sort()).toEqual(['Осталось {Count} тюков', 'ПАУЗА']);

    const ack = await app.inject({
      method: 'POST', url: '/api/export/ack',
      payload: { culture: 'ru', written: [{ unitId: idA, translation: 'ПАУЗА' }], rejected: [] },
    });
    expect(ack.statusCode).toBe(200);
  });

  // Path/folder filter. snapshot's units are A (groupKey 'Pause') and B (groupKey 'Hud').
  it('accepts groupPrefix on POST /api/jobs/estimate and matches only group keys with that prefix', async () => {
    const all = await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    const scoped = await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', groupPrefix: 'Pa' } });
    expect(all.json().estimate.items).toBe(2); // A (Pause) + B (Hud)
    expect(scoped.json().estimate.items).toBe(1); // only A (Pause)
  });

  it('runs a job scoped by groupPrefix, translating only the matching group', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5, groupPrefix: 'Pa' } });
    expect(started.statusCode).toBe(202);
    const job = await waitForJob(started.json().jobId);
    expect(job).toMatchObject({ status: 'done', report: { written: 1 } });
  });

  it('rejects an empty or too-long groupPrefix with 400 invalid_scope, before any token counting', async () => {
    const tracked = new FakeLlmClient(respond);
    const trackedApp = buildServer({
      store, llm: tracked,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    const empty = await trackedApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', groupPrefix: '' } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe('invalid_scope');
    const tooLong = await trackedApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', groupPrefix: 'x'.repeat(513) } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe('invalid_scope');
    expect(tracked.countInputTokensCalls).toBe(0);
  });

  it('rejects groupPrefix combined with groupKey (mutually exclusive) with 400 invalid_scope on both routes', async () => {
    const est = await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', groupKey: 'Pause', groupPrefix: 'Pa' } });
    expect(est.statusCode).toBe(400);
    expect(est.json().error).toBe('invalid_scope');
    const job = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5, groupKey: 'Pause', groupPrefix: 'Pa' } });
    expect(job.statusCode).toBe(400);
    expect(job.json().error).toBe('invalid_scope');
  });

  it('refuses a job above the budget', async () => {
    // maxUsd: 0 is no longer a valid budget (it is rejected up front as invalid_maxUsd, see below), so this uses
    // a tiny-but-valid, price-independent budget: any priced estimate is > 0, so Number.MIN_VALUE always exceeds
    // it without depending on the current price table (a fixed maxUsd like 0.01 breaks if the default model
    // gets cheaper).
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: Number.MIN_VALUE } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('budget');
  });

  // A maxUsd that is present but not a finite positive number must 400 before any token counting.
  it('rejects a present maxUsd that is not a finite positive number, with 400 before any token counting', async () => {
    const badValues: unknown[] = [0, -1, -0.01, 'not-a-number', null, false, {}];
    for (const maxUsd of badValues) {
      const tracked = new FakeLlmClient(respond);
      const trackedApp = buildServer({
        store, llm: tracked,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        env: API_KEY_ENV,
      });
      const res = await trackedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_maxUsd');
      expect(tracked.countInputTokensCalls).toBe(0);
    }
  });

  it('accepts a present, finite, positive maxUsd (compat: absent maxUsd is a separate case, tested elsewhere)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    expect(res.statusCode).toBe(202);
  });

  // A scope that is free (TM reuse only, no model call) must not need a maxUsd — `items` used to read 0 for
  // exactly this scope and hide Run in the web; `strings` (estimate.ts) now tells them apart.
  it('accepts POST /api/jobs without maxUsd for a free (TM-only) scope, and writes the TM text', async () => {
    const tmStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-tm-')));
    applySnapshot(tmStore, {
      target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
      entries: [
        { namespace: 'HW', key: 'Donor', source: 'PAUSED', origin: 'o', devNotes: '', metadata: {}, groupKey: 'Pause' },
        { namespace: 'HW', key: 'Recipient', source: 'PAUSED', origin: 'o', devNotes: '', metadata: {}, groupKey: 'TmOnly' },
      ],
    });
    const donorId = unitIdOf('HW', 'Donor');
    tmStore.putCell({ ...tmStore.getCell('ru', donorId), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'PAUSED' });
    const tmApp = buildServer({
      store: tmStore, llm: new FakeLlmClient(respond),
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(), policy: 'validated', port: PORT, env: API_KEY_ENV,
    });
    const est = await tmApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', groupKey: 'TmOnly' } });
    expect(est.json().estimate).toMatchObject({ items: 0, strings: 1, usd: 0 });

    const started = await tmApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', groupKey: 'TmOnly' } });
    expect(started.statusCode).toBe(202);
    const job = await waitForJob(started.json().jobId, tmApp);
    expect(job).toMatchObject({ status: 'done', report: { tm: 1, written: 0 } });
    const recipientId = unitIdOf('HW', 'Recipient');
    expect(tmStore.getCell('ru', recipientId)).toMatchObject({ text: 'ПАУЗА', status: 'ai_draft' });
  });

  // estimate-speed-brief.md §2: the count cache is one instance per running server, shared by both routes.
  it('shares counted groups between /api/jobs/estimate and POST /api/jobs (Run after Estimate makes no further countInputTokens calls)', async () => {
    const tracked = new FakeLlmClient(respond);
    const trackedApp = buildServer({
      store, llm: tracked,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    const est = await trackedApp.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(est.statusCode).toBe(200);
    const callsAfterEstimate = tracked.countInputTokensCalls;
    expect(callsAfterEstimate).toBeGreaterThan(0);
    const started = await trackedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    expect(started.statusCode).toBe(202);
    expect(tracked.countInputTokensCalls).toBe(callsAfterEstimate);
    await waitForJob(started.json().jobId, trackedApp);
  });

  // estimate-speed-brief.md §3: POST /api/jobs's skipEstimate.
  describe('POST /api/jobs skipEstimate', () => {
    it('starts the job with zero countInputTokens calls and an approximate local estimate, without maxUsd', async () => {
      const tracked = new FakeLlmClient(respond);
      const trackedApp = buildServer({
        store, llm: tracked,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        env: API_KEY_ENV,
      });
      const res = await trackedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true } });
      expect(res.statusCode).toBe(202);
      expect(res.json().estimate).toMatchObject({ approximate: true });
      expect(tracked.countInputTokensCalls).toBe(0);
      const job = await waitForJob(res.json().jobId, trackedApp);
      expect(job).toMatchObject({ status: 'done' });
    });

    // maxUsd, if sent, is ignored outright with skipEstimate: true -- not required, not validated (an invalid
    // one does not 400 either), not enforced against a budget.
    it('ignores an invalid maxUsd sent alongside skipEstimate: true (no 400 invalid_maxUsd)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true, maxUsd: -1 } });
      expect(res.statusCode).toBe(202);
    });

    it('never requires maxUsd with skipEstimate: true on a priced model (no "culture and maxUsd are required")', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true } });
      expect(res.statusCode).toBe(202);
    });

    it('still enforces ai_not_ready with skipEstimate: true, and never calls the LLM', async () => {
      const tracked = new FakeLlmClient(respond);
      const trackedApp = buildServer({
        store, llm: tracked,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        env: {},
      });
      const res = await trackedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ai_not_ready', message: MISSING_KEY_MESSAGE });
      expect(tracked.countInputTokensCalls).toBe(0);
      expect(tracked.calls.length).toBe(0);
    });

    it('still enforces job_running with skipEstimate: true', async () => {
      const gated = new GatedRunLlm(respond);
      const gatedApp = buildServer({
        store, llm: gated,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        env: API_KEY_ENV,
      });
      const first = await gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true } });
      expect(first.statusCode).toBe(202);
      await gated.enteredOnce;
      const second = await gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true } });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe('job_running');
      gated.release();
      await waitForJob(first.json().jobId, gatedApp);
    });

    it('still enforces scope validation (invalid_scope) with skipEstimate: true', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true, groupKey: 'Pause', groupPrefix: 'Pa' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_scope');
    });

    it('still enforces batch_unavailable with skipEstimate: true', async () => {
      const openAiApp = buildServer({
        store, llm,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        env: API_KEY_ENV,
      });
      const res = await openAiApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', skipEstimate: true, mode: 'batch' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'batch_unavailable', message: 'Batch mode is only available for Anthropic with an API key.' });
    });
  });

  it('answers 404 for GET /api/jobs?culture= when the culture has no job', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs?culture=ru' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Unknown job' });
  });

  it('returns the most recently started job when none is running, and the newest via GET /api/jobs?culture=', async () => {
    const firstStart = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    const firstJob = await waitForJob(firstStart.json().jobId);
    expect(firstJob.status).toBe('done');
    const secondStart = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    const secondJob = await waitForJob(secondStart.json().jobId);
    expect(secondJob.status).toBe('done');

    const res = await app.inject({ method: 'GET', url: '/api/jobs?culture=ru' });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(secondJob.id);
  });

  it('returns the running job for a culture via GET /api/jobs?culture=, and a second POST 409s with its jobId', async () => {
    const gated = new GatedRunLlm(respond);
    const jobStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
    const gatedApp = buildServer({
      store: jobStore,
      llm: gated,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    await gatedApp.inject({ method: 'POST', url: '/api/push', payload: snapshot });

    const started = gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    await gated.enteredOnce;

    const running = await gatedApp.inject({ method: 'GET', url: '/api/jobs?culture=ru' });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({ culture: 'ru', status: 'running' });

    const second = await gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'job_running', jobId: running.json().id });

    gated.release();
    const startedRes = await started;
    expect(startedRes.statusCode).toBe(202);
    expect(startedRes.json().jobId).toBe(running.json().id);
  });

  // GET /api/jobs/:id surfaces the job's own progress while it runs; /api/health.jobRunning
  // is true for the same window and goes back to false once the job (and thus the gate) is done.
  it('reports progress with phase translate and health.jobRunning while a job is gated mid-run, false once it completes', async () => {
    const gated = new GatedRunLlm(respond);
    const jobStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
    const gatedApp = buildServer({
      store: jobStore,
      llm: gated,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    await gatedApp.inject({ method: 'POST', url: '/api/push', payload: snapshot });

    expect((await gatedApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ jobRunning: false });

    const started = gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    await gated.enteredOnce;

    expect((await gatedApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ jobRunning: true });
    const runningJob = (await gatedApp.inject({ method: 'GET', url: '/api/jobs?culture=ru' })).json();
    expect(runningJob).toMatchObject({ culture: 'ru', status: 'running', progress: { phase: 'translate' } });
    expect(runningJob.progress.done).toBeLessThanOrEqual(runningJob.progress.total);

    gated.release();
    const startedRes = await started;
    let finished = (await gatedApp.inject({ method: 'GET', url: `/api/jobs/${startedRes.json().jobId}` })).json();
    for (let i = 0; i < 100 && finished.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      finished = (await gatedApp.inject({ method: 'GET', url: `/api/jobs/${startedRes.json().jobId}` })).json();
    }
    expect(finished.status).toBe('done');
    expect((await gatedApp.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ jobRunning: false, jobsFinished: 1 });
  });

  // health.jobRunning true->false is invisible to a client whose poll interval is longer than
  // the job (never observes `true`). jobsFinished is a monotonic counter incremented once per job leaving
  // `running`, so a client can notice by remembering the last value and comparing. Never decreases across
  // several jobs, done or failed alike.
  it('increments health.jobsFinished once per job that leaves running, and never decreases', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/health' })).json().jobsFinished as number;
    const started = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    expect(started.statusCode).toBe(202);
    await waitForJob(started.json().jobId);
    const after = (await app.inject({ method: 'GET', url: '/api/health' })).json().jobsFinished as number;
    expect(after).toBe(before + 1);
  });

  it('carries billing: api in the estimate, so the web can hide USD for the other backend', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(res.json().estimate).toMatchObject({ billing: 'api' });
  });

  it('requires culture and maxUsd for an Anthropic API-key job (usd is known)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'culture and maxUsd are required' });
  });

  describe('subscription AI backend', () => {
    function subscriptionApp() {
      return buildServer({
        store, llm,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'anthropic', auth: 'subscription', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
        authProbe: async () => ({ ready: true, detail: 'Signed in to Claude Code' }),
      });
    }

    it('rejects mode: batch on /api/jobs', async () => {
      const res = await subscriptionApp().inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', mode: 'batch' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'batch_unavailable', message: 'Batch mode is only available for Anthropic with an API key.' });
    });

    it('rejects mode: batch on /api/jobs/estimate', async () => {
      const res = await subscriptionApp().inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', mode: 'batch' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'batch_unavailable', message: 'Batch mode is only available for Anthropic with an API key.' });
    });

    it('accepts a job without maxUsd and skips the budget check', async () => {
      const res = await subscriptionApp().inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
      expect(res.statusCode).toBe(202);
      expect(res.json().estimate).toMatchObject({ billing: 'subscription' });
    });

    it('carries billing: subscription in the estimate', async () => {
      const res = await subscriptionApp().inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
      expect(res.json().estimate).toMatchObject({ billing: 'subscription' });
    });
  });

  describe('OpenAI (API only, no Batch)', () => {
    function openAiApp() {
      return buildServer({
        store, llm,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        env: API_KEY_ENV,
      });
    }

    it('rejects mode: batch on /api/jobs', async () => {
      const res = await openAiApp().inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', mode: 'batch', maxUsd: 5 } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'batch_unavailable', message: 'Batch mode is only available for Anthropic with an API key.' });
    });

    it('rejects mode: batch on /api/jobs/estimate', async () => {
      const res = await openAiApp().inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru', mode: 'batch' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'batch_unavailable', message: 'Batch mode is only available for Anthropic with an API key.' });
    });

    it('accepts a job without maxUsd when the model has no known price, and estimate.usd is null', async () => {
      const unpricedApp = buildServer({
        store, llm,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, translateModel: 'gpt-custom', judgeModel: 'gpt-custom' },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-custom', judgeModel: 'gpt-custom' },
        env: API_KEY_ENV,
      });
      const res = await unpricedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
      expect(res.statusCode).toBe(202);
      expect(res.json().estimate.usd).toBeNull();
    });

    it('still requires maxUsd when the model has a known price', async () => {
      const res = await openAiApp().inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'culture and maxUsd are required' });
    });
  });

  // A missing API key must fail the request (400 ai_not_ready), not the job (which used to answer 202
  // and end 'done' with N errors and no reason, because countInputTokens is a local approximation for every
  // non-Anthropic provider and never touches the network).
  describe('ai_not_ready (missing API key fails the request, not the job)', () => {
    function openAiAppWithEnv(env: NodeJS.ProcessEnv, llmClient: FakeLlmClient) {
      return buildServer({
        store, llm: llmClient,
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
        env,
      });
    }

    it('answers 400 ai_not_ready on POST /api/jobs when LOCHUB_API_KEY is unset, with the contract message, and never calls the LLM', async () => {
      const tracked = new FakeLlmClient(respond);
      const res = await openAiAppWithEnv({}, tracked).inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ai_not_ready', message: MISSING_KEY_MESSAGE });
      expect(tracked.countInputTokensCalls).toBe(0);
      expect(tracked.calls.length).toBe(0);
    });

    it('answers 400 ai_not_ready on POST /api/jobs/estimate when LOCHUB_API_KEY is unset, with the contract message, and never calls the LLM', async () => {
      const tracked = new FakeLlmClient(respond);
      const res = await openAiAppWithEnv({}, tracked).inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ai_not_ready', message: MISSING_KEY_MESSAGE });
      expect(tracked.countInputTokensCalls).toBe(0);
      expect(tracked.calls.length).toBe(0);
    });

    // key-contract.md §2: OPENAI_API_KEY (the provider's own variable) must not satisfy the gate -- only
    // LOCHUB_API_KEY does, whatever provider is configured.
    it('stays ai_not_ready when OPENAI_API_KEY is set but LOCHUB_API_KEY is not', async () => {
      const tracked = new FakeLlmClient(respond);
      const res = await openAiAppWithEnv({ OPENAI_API_KEY: 'sk-should-be-ignored' }, tracked).inject({
        method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ai_not_ready', message: MISSING_KEY_MESSAGE });
      expect(tracked.calls.length).toBe(0);
    });

    // Asserts the exact success code, not merely "not 400": that also passes on 500, 409 or 422.
    it('starts the job once LOCHUB_API_KEY is set', async () => {
      const res = await openAiAppWithEnv(API_KEY_ENV, new FakeLlmClient(respond)).inject({
        method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 },
      });
      expect(res.statusCode).toBe(202);
    });

    // Asserts the exact success code, not merely "not 400": that also passes on 500, 409 or 422.
    it('estimates once LOCHUB_API_KEY is set', async () => {
      const res = await openAiAppWithEnv(API_KEY_ENV, new FakeLlmClient(respond)).inject({
        method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' },
      });
      expect(res.statusCode).toBe(200);
    });

    // I-1: retranslate reaches the same Anthropic/adapter call as jobs/estimate and must be gated the same
    // way -- it was not, so a missing key used to reach retranslateWithNote's model call directly.
    it('answers 400 ai_not_ready on POST /api/cells/:culture/:unitId/retranslate when LOCHUB_API_KEY is unset, with the contract message, and never calls the LLM', async () => {
      const tracked = new FakeLlmClient(respond);
      const res = await openAiAppWithEnv({}, tracked).inject({
        method: 'POST', url: `/api/cells/ru/${idA}/retranslate`, payload: { note: 'It is a menu button' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'ai_not_ready', message: MISSING_KEY_MESSAGE });
      expect(tracked.calls.length).toBe(0);
    });

    // Subscription keeps its current path: no ai_not_ready gate, whatever the environment.
    it('leaves the subscription path unaffected (no ai_not_ready gate)', async () => {
      const subApp = buildServer({
        store, llm: new FakeLlmClient(respond),
        cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
        jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
        bridge: new BridgeHub(),
        policy: 'validated',
        port: PORT,
        ai: { provider: 'anthropic', auth: 'subscription', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
        authProbe: async () => ({ ready: true, detail: 'Signed in to Claude Code' }),
        env: {},
      });
      const res = await subApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
      expect(res.statusCode).toBe(202);
    });
  });

  it('maps cell action errors to HTTP codes', async () => {
    const bad = await app.inject({ method: 'POST', url: `/api/cells/ru/${unitIdOf('HW', 'B')}/edit`, payload: { text: 'Осталось тюков' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues[0].code).toBe('args_missing');
    const missing = await app.inject({ method: 'POST', url: '/api/cells/ru/ffffffffffffffff/approve', payload: {} });
    expect(missing.statusCode).toBe(404);
    const good = await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: 'ПАУЗА' } });
    expect(good.json().cell.status).toBe('edited');
  });

  it('round-trips the glossary', async () => {
    const terms = [{ term: 'MyGame', translation: '', dnt: true, note: '' }];
    expect((await app.inject({ method: 'PUT', url: '/api/glossary/ru', payload: terms })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/glossary/ru' })).json()).toEqual(terms);
  });

  it('relays whitelisted commands only to a connected editor', async () => {
    const payload = { name: 'SetPreviewCulture', args: { culture: 'ru' } };
    expect((await app.inject({ method: 'POST', url: '/api/bridge/command', payload })).statusCode).toBe(409);

    const chunks: string[] = [];
    const remove = bridge.add((c) => chunks.push(c));
    expect((await app.inject({ method: 'POST', url: '/api/bridge/command', payload })).statusCode).toBe(202);
    expect(chunks[0]).toBe(`event: command\ndata: ${JSON.stringify(payload)}\n\n`);
    remove();

    expect((await app.inject({ method: 'POST', url: '/api/bridge/command', payload: { name: 'DeleteEverything', args: {} } })).statusCode).toBe(400);
  });

  it('refuses a second job for a culture while the first is still estimating', async () => {
    const gated = new GatedLlm(respond);
    const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
    const gatedApp = buildServer({
      store,
      llm: gated,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    await gatedApp.inject({ method: 'POST', url: '/api/push', payload: snapshot });

    const first = gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    await gated.enteredOnce;
    const second = gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: 5 } });
    const secondRes = await Promise.race([second, new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 200))]);
    gated.release();
    const firstRes = await first;
    expect(firstRes.statusCode).toBe(202);
    expect(secondRes === 'blocked' ? (await second).statusCode : secondRes.statusCode).toBe(409);
  });

  it('rejects malformed glossary terms', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/glossary/ru', payload: [{ term: 'Baler' }] });
    expect(bad.statusCode).toBe(400);
    const get = await app.inject({ method: 'GET', url: '/api/glossary/ru' });
    expect(get.json()).toEqual([]);
  });
});

// Reconcile checks the archive for a human edit before Pull's first export,
// using exactly Push's archive loop, without touching units or lastPush.
describe('POST /api/reconcile', () => {
  it('turns a new archive text (current source) into a human edit, and the next export carries it (a)', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1 });
    store.save();
    await app.inject({ method: 'GET', url: '/api/export?culture=ru' });
    await app.inject({
      method: 'POST', url: '/api/export/ack',
      payload: { culture: 'ru', written: [{ unitId: idA, translation: 'ПАУЗА' }], rejected: [] },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/reconcile',
      payload: { archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА (правка)', source: 'PAUSED' }] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ humanEdits: 1 });
    expect(store.getCell('ru', idA)).toMatchObject({ text: 'ПАУЗА (правка)', status: 'human_edit' });

    const exported = (await app.inject({ method: 'GET', url: '/api/export?culture=ru' })).json();
    expect(exported.entries.find((e: { unitId: string; translation: string }) => e.unitId === idA)?.translation).toBe('ПАУЗА (правка)');
  });

  // (b): an archive text equal to an earlier export of the cell (not the current one) is a stale export, not
  // a human edit — mirrors push.test.ts's rejected-rework test, exercised through /api/reconcile.
  it('ignores an archive text that matches an earlier export of the cell, not the current one (b)', async () => {
    const t = '2026-01-01T00:00:00Z';
    store.putCell({ ...store.getCell('ru', idA), text: 'Привет', status: 'ai_draft', basedOnSourceRev: 1, revision: 1 });
    store.appendEvent({ ts: t, unitId: idA, culture: 'ru', action: 'ai_draft', actor: 'ai', before: '', after: 'Привет' });
    store.putCell({ ...store.getCell('ru', idA), text: 'Здравствуйте', status: 'ai_draft', revision: 2 });
    store.appendEvent({ ts: t, unitId: idA, culture: 'ru', action: 'ai_draft', actor: 'ai', before: 'Привет', after: 'Здравствуйте' });

    const res = await app.inject({
      method: 'POST', url: '/api/reconcile',
      payload: { archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'Привет', source: 'PAUSED' }] } },
    });
    expect(res.json()).toEqual({ humanEdits: 0 });
    expect(store.getCell('ru', idA).text).toBe('Здравствуйте');
  });

  it('leaves unit count and objects unchanged while still recording the human edit (c)', async () => {
    const before = [...store.units.values()];
    const res = await app.inject({
      method: 'POST', url: '/api/reconcile',
      payload: { archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] } },
    });
    // The route did real work (not a vacuous no-op): a genuinely new archive text is still adopted...
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ humanEdits: 1 });
    expect(store.getCell('ru', idA)).toMatchObject({ text: 'ПАУЗА', status: 'human_edit' });
    // ...yet units themselves (count and objects) are untouched by it.
    expect([...store.units.values()]).toEqual(before);
    expect(store.units.size).toBe(before.length);
  });

  it('rejects a malformed body with 400 and touches nothing (d)', async () => {
    const beforeCell = store.getCell('ru', idA);
    const res = await app.inject({ method: 'POST', url: '/api/reconcile', payload: { archives: { ru: [{ namespace: 'HW' }] } } });
    expect(res.statusCode).toBe(400);
    expect(store.getCell('ru', idA)).toEqual(beforeCell);
  });

  it('rejects a bad culture in archives before touching the store', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/reconcile',
      payload: { archives: { 'x/../../PWNED': [] } },
    });
    expect(res.statusCode).toBe(400);
  });
});

// A save() refused because the store's data files changed on disk (a source control sync, e.g. `git pull`,
// while the service ran) surfaces as 409 on any write route, and /api/health reports it as stale.
describe('409 files_changed_on_disk', () => {
  it('maps a refused save to 409 on a write route, keeps the external content, and health reports stale', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();

    const path = join(store.dataDir, 'cells.ru.jsonl');
    const external = readFileSync(path, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(path, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);

    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ stale: true });

    const res = await app.inject({ method: 'PUT', url: '/api/style/ru', payload: { text: 'Use "ты".' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'files_changed_on_disk',
      message: 'Localization/LocHub changed on disk since the service loaded it (a source control sync?). Restart the LocHub service.',
    });
    expect(readFileSync(path, 'utf8')).toBe(external);
  });

  // The freshness check must run before reconcileArchives stages a
  // putCell/appendEvent, not only inside the store.save() that follows — otherwise the event is already on
  // disk when save() throws, a phantom `after` that a later reconcile mistakes for LocHub's own text.
  it('refuses a reconcile that would record a human edit when cells changed on disk, and leaves no phantom event', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1 });
    store.save();
    await app.inject({ method: 'GET', url: '/api/export?culture=ru' });
    await app.inject({
      method: 'POST', url: '/api/export/ack',
      payload: { culture: 'ru', written: [{ unitId: idA, translation: 'ПАУЗА' }], rejected: [] },
    });

    const cellsPath = join(store.dataDir, 'cells.ru.jsonl');
    const eventsPath = join(store.dataDir, 'events.ru.jsonl');
    const beforeEvents = readFileSync(eventsPath, 'utf8');

    const external = readFileSync(cellsPath, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(cellsPath, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(cellsPath, bumped, bumped);

    const res = await app.inject({
      method: 'POST', url: '/api/reconcile',
      payload: { archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА (правка)', source: 'PAUSED' }] } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'files_changed_on_disk' });
    expect(readFileSync(eventsPath, 'utf8')).toBe(beforeEvents);
    expect(readFileSync(cellsPath, 'utf8')).toBe(external);
  });

  // Same defect, through a cell action route instead of reconcile.
  it('refuses a cell action when cells changed on disk, and leaves no phantom event', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();

    const cellsPath = join(store.dataDir, 'cells.ru.jsonl');
    const eventsPath = join(store.dataDir, 'events.ru.jsonl');
    const beforeEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null;

    const external = readFileSync(cellsPath, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(cellsPath, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(cellsPath, bumped, bumped);

    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/approve`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'files_changed_on_disk' });
    expect(existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null).toBe(beforeEvents);
    expect(readFileSync(cellsPath, 'utf8')).toBe(external);
  });
});

// Culture guard, payload validation, Host allowlist and JSON-only
// mutations.
describe('request hygiene', () => {
  it('rejects a differently-cased culture and keeps a later save from touching the real culture file', async () => {
    store.putCell({ ...emptyCell(idA, 'ru'), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const before = readFileSync(join(store.dataDir, 'cells.ru.jsonl'), 'utf8');
    expect(before.length).toBeGreaterThan(0);

    expect((await app.inject({ method: 'GET', url: '/api/summary?culture=RU' })).statusCode).toBe(400);

    // A later, unrelated save must not have been corrupted by the rejected read.
    expect((await app.inject({ method: 'PUT', url: '/api/style/ru', payload: { text: 'Use "ты".' } })).statusCode).toBe(200);
    expect(readFileSync(join(store.dataDir, 'cells.ru.jsonl'), 'utf8')).toBe(before);
  });

  it('rejects a path-traversing culture on PUT /api/style and writes no file', async () => {
    const before = readdirSync(store.dataDir);
    const res = await app.inject({ method: 'PUT', url: '/api/style/x%2F..%2F..%2F..%2FPWNED', payload: { text: 'attacker text' } });
    expect(res.statusCode).toBe(400);
    expect(readdirSync(store.dataDir)).toEqual(before);
    expect(existsSync(join(store.dataDir, '..', 'PWNED.md'))).toBe(false);
  });

  it('rejects a path-traversing culture on GET /api/cells', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cells?culture=x%2F..%2FTRUNC' });
    expect(res.statusCode).toBe(400);
  });

  it('validates a push body before touching the store', async () => {
    const { source: _source, ...withoutSource } = snapshot.entries[0]!;
    const bad = { ...snapshot, entries: [withoutSource] };
    expect((await app.inject({ method: 'POST', url: '/api/push', payload: bad })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/push', payload: snapshot })).statusCode).toBe(200);
  });

  it('validates an export/ack body and leaves the store unchanged', async () => {
    const before = store.getCell('ru', idA);
    const res = await app.inject({
      method: 'POST', url: '/api/export/ack',
      payload: { culture: 'ru', written: [{ unitId: idA }], rejected: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(store.getCell('ru', idA)).toEqual(before);
  });

  it('rejects a foreign Host on a GET', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:80' } });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a Host header that only differs in case', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: `LOCALHOST:${PORT}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-JSON mutation and leaves the cell unchanged', async () => {
    store.putCell({ ...emptyCell(idA, 'ru'), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const before = store.getCell('ru', idA);
    const res = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/reject`,
      headers: { 'content-type': 'text/plain' }, payload: 'note=bad',
    });
    expect(res.statusCode).toBe(415);
    expect(store.getCell('ru', idA)).toEqual(before);
  });

  it('rejects a POST without a content-type', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/estimate' });
    expect(res.statusCode).toBe(415);
  });

  // A culture with no cells/glossary/style yet (a job just started for it) must still block a
  // differently-cased spelling landing in a different map, before either file exists on disk.
  it('rejects a style PUT that collides in case with a job starting for that culture', async () => {
    const gated = new GatedLlm(respond);
    const jobStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-srv-')));
    const gatedApp = buildServer({
      store: jobStore,
      llm: gated,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      env: API_KEY_ENV,
    });
    await gatedApp.inject({ method: 'POST', url: '/api/push', payload: snapshot });

    const job = gatedApp.inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'pt-br', maxUsd: 5 } });
    await gated.enteredOnce;
    const style = await gatedApp.inject({ method: 'PUT', url: '/api/style/pt-BR', payload: { text: 'x' } });
    expect(style.statusCode).toBe(400);
    gated.release();
    expect((await job).statusCode).toBe(202);
  });

  // appendEvent is not atomic against a crash mid-write, so the events log can end in a torn last line.
  // Push must not fail wholesale over one bad line in the per-culture 'after' map it reads for archives.
  it('tolerates a torn last line in the events log when Push reads it for archives', async () => {
    const path = join(store.dataDir, 'events.ru.jsonl');
    const goodLine = JSON.stringify({ ts: 't', unitId: idA, culture: 'ru', action: 'exported', actor: 'engine', before: '', after: 'ПАУЗА' });
    writeFileSync(path, `${goodLine}\n{"ts":"t","unitId":`);
    const res = await app.inject({
      method: 'POST', url: '/api/push',
      payload: { ...snapshot, archives: { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] } },
    });
    expect(res.statusCode).toBe(200);
  });

  // Framing headers on every response, cross-site browser requests refused (the Sec-Fetch-Site check).
  it('carries the framing headers on the SPA root and on an API route', async () => {
    const rootRes = await app.inject({ method: 'GET', url: '/' });
    const apiRes = await app.inject({ method: 'GET', url: '/api/health' });
    for (const res of [rootRes, apiRes]) {
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    }
  });

  it('refuses a cross-site GET on the bridge stream and a cross-site POST, but accepts same-origin', async () => {
    const stream = await app.inject({ method: 'GET', url: '/api/bridge/stream', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(stream.statusCode).toBe(403);
    expect(stream.json()).toEqual({ error: 'cross_site' });

    const post = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/reject`,
      headers: { 'sec-fetch-site': 'cross-site' }, payload: {},
    });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toEqual({ error: 'cross_site' });

    const sameOrigin = await app.inject({ method: 'GET', url: '/api/health', headers: { 'sec-fetch-site': 'same-origin' } });
    expect(sameOrigin.statusCode).toBe(200);
  });

  // Type validation for the optimistic-concurrency fields on the cell action route.
  it('rejects a non-number expectedRevision or expectedSourceRev with 400', async () => {
    const badRevision = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/approve`, payload: { expectedRevision: '0' },
    });
    expect(badRevision.statusCode).toBe(400);

    const badSourceRev = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/approve`, payload: { expectedSourceRev: '1' },
    });
    expect(badSourceRev.statusCode).toBe(400);
  });
});

// Optimistic concurrency on the cell action route (approve/edit/reject). idA is 'PAUSED', pushed once,
// so unit.sourceRev is 1; its cell starts at revision 0.
describe('optimistic concurrency', () => {
  it('approves when the expected numbers match, and bumps the revision', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const res = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/approve`,
      payload: { expectedRevision: 0, expectedSourceRev: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cell).toMatchObject({ status: 'approved', revision: 1 });
  });

  it('answers 409 stale_cell when a Push changed the source, with the current cell and unit, and writes no event', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const eventsPath = join(store.dataDir, 'events.ru.jsonl');
    const beforeEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null;

    await app.inject({
      method: 'POST', url: '/api/push',
      payload: { ...snapshot, entries: [{ ...snapshot.entries[0]!, source: 'PAUSED (new)' }, snapshot.entries[1]!] },
    });

    const res = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/approve`,
      payload: { expectedSourceRev: 1 },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe('stale_cell');
    expect(typeof body.message).toBe('string');
    expect(body.cell).toMatchObject({ unitId: idA, culture: 'ru', text: 'ПАУЗА', revision: 0 });
    expect(body.unit).toMatchObject({ id: idA, source: 'PAUSED (new)', sourceRev: 2 });
    expect(existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null).toBe(beforeEvents);
  });

  it('answers 409 stale_cell on an edit whose expected revision is behind an edit that already landed', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const first = await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: 'ПАУЗА (правка)', actor: 'someone-else' } });
    expect(first.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST', url: `/api/cells/ru/${idA}/edit`,
      payload: { text: 'ещё правка', expectedRevision: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'stale_cell', cell: { revision: 1, text: 'ПАУЗА (правка)' } });
    expect(store.getCell('ru', idA).text).toBe('ПАУЗА (правка)');
  });

  it('rejects without the expected fields, unaffected by a stale revision (compat)', async () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: 'ПАУЗА (правка)', actor: 'someone-else' } });

    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/reject`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().cell).toMatchObject({ status: 'rejected', revision: 2 });
  });
});

// Live format check for the review card (UX approve brief, item 1): read-only, runs exactly the precheck
// approve/edit run (cells.ts checkCell), so the card can show why a draft would be refused before the click.
describe('POST /api/cells/:culture/:unitId/check', () => {
  const idB = unitIdOf('HW', 'B'); // source '{Count} bales left' — has a format argument to break

  it('returns the issue for a dropped placeholder (confirm tier), and writes no store row or event', async () => {
    const eventsPath = join(store.dataDir, 'events.ru.jsonl');
    const beforeEvents = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null;
    const beforeCell = store.getCell('ru', idB);

    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: 'Осталось тюков' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([expect.objectContaining({ code: 'args_missing', severity: 'confirm' })]);
    expect(store.getCell('ru', idB)).toEqual(beforeCell);
    expect(existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null).toBe(beforeEvents);
  });

  it('reports the hard tier for an argument the source does not have', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: 'Осталось {Count} {Extra}' } });
    expect(res.json().issues).toEqual([expect.objectContaining({ code: 'args_extra', severity: 'hard' })]);
  });

  it('returns a soft untranslated issue for text equal to the source', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: '{Count} bales left' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([expect.objectContaining({ code: 'untranslated', severity: 'soft' })]);
  });

  it('returns [] for good text', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: 'Осталось {Count} тюков' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ issues: [] });
  });

  it('404s for an unknown unit', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cells/ru/ffffffffffffffff/check', payload: { text: 'x' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s a body without a string text field', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('edit still refuses the same broken text the check route flags as hard, because they share checkTranslation', async () => {
    const checked = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: 'Осталось тюков' } });
    expect(checked.json().issues.length).toBeGreaterThan(0);
    const edited = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/edit`, payload: { text: 'Осталось тюков' } });
    expect(edited.statusCode).toBe(422);
  });
});

// Check tiers on the action route: `accept` must name every confirm code of the text; a hard issue is refused
// whatever it says; the event records what was accepted.
describe('POST /api/cells/:culture/:unitId/approve|edit with accept', () => {
  const idB = unitIdOf('HW', 'B'); // source '{Count} bales left'
  const act = (action: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/${action}`, payload });

  it('422s a confirm issue without accept and approves it with accept, recording it', async () => {
    const refused = await act('edit', { text: 'Тюков нет' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().issues).toEqual([expect.objectContaining({ code: 'args_missing', severity: 'confirm' })]);

    const saved = await act('edit', { text: 'Тюков нет', accept: ['args_missing'] });
    expect(saved.statusCode).toBe(200);
    const approved = await act('approve', { accept: ['args_missing'] });
    expect(approved.json().cell.status).toBe('approved');

    const history = (await app.inject({ method: 'GET', url: `/api/cells/ru/${idB}/history` })).json();
    expect(history.map((e: { action: string; accepted?: string[] }) => [e.action, e.accepted])).toEqual([
      ['edit', ['args_missing']],
      ['approve', ['args_missing']],
    ]);
  });

  it('422s a hard issue even with accept', async () => {
    const res = await act('edit', { text: 'Осталось {Count} {Extra}', accept: ['args_extra'] });
    expect(res.statusCode).toBe(422);
  });

  it('400s an accept that is not an array of strings', async () => {
    expect((await act('approve', { accept: 'args_missing' })).statusCode).toBe(400);
    expect((await act('edit', { text: 'Тюков нет', accept: [1] })).statusCode).toBe(400);
  });
});

// The engine's plural forms ride in the Push body (plural-engine brief) and every later check uses them.
describe('POST /api/push pluralForms', () => {
  const idB = unitIdOf('HW', 'B'); // source '{Count} bales left'
  // Deliberately not what Node answers for ru (one, few, many, other): proves the check reads the pushed forms.
  const RU_ENGINE = { cardinal: ['one', 'other'], ordinal: ['other'] };
  const twoForms = 'Осталось {Count}|plural(one=тюк,other=тюков)';

  it('makes the check route use the pushed forms', async () => {
    const before = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: twoForms } });
    expect(before.json().issues.map((i: { code: string }) => i.code)).toEqual(['plural_forms_missing']);

    const pushed = await app.inject({ method: 'POST', url: '/api/push', payload: { ...snapshot, pluralForms: { ru: RU_ENGINE } } });
    expect(pushed.statusCode).toBe(200);
    const after = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: twoForms } });
    expect(after.json()).toEqual({ issues: [] });
  });

  it('400s a malformed pluralForms and stores nothing from it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/push', payload: { ...snapshot, pluralForms: { ru: { cardinal: 'one' } } } });
    expect(res.statusCode).toBe(400);
    expect(store.pluralCategoriesFor('ru', 'cardinal')).toEqual(pluralCategories('ru', 'cardinal'));
  });

  // The editor restarts the service on every AI/brief setting change, so the pushed forms must survive a
  // restart until the next Push, not just live in this process's memory (checks-fix1-brief).
  it('answers the check route with the pushed forms after a fresh service on the same state dir (restart)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lochub-srv-persist-'));
    const pluralFormsPath = join(dataDir, '..', 'plural_forms.json');
    const store1 = LocHubStore.load(dataDir, pluralFormsPath);
    const app1 = buildServer({
      store: store1, llm, cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 }, bridge: new BridgeHub(), policy: 'validated', port: PORT,
    });
    await app1.inject({ method: 'POST', url: '/api/push', payload: { ...snapshot, pluralForms: { ru: RU_ENGINE } } });

    // Simulate a restart: a fresh store loaded from the same two paths, and a fresh server built on it.
    const store2 = LocHubStore.load(dataDir, pluralFormsPath);
    const app2 = buildServer({
      store: store2, llm, cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 }, bridge: new BridgeHub(), policy: 'validated', port: PORT,
    });
    const res = await app2.inject({ method: 'POST', url: `/api/cells/ru/${idB}/check`, payload: { text: twoForms } });
    expect(res.json()).toEqual({ issues: [] });
  });
});

// Parked from the Task 4 review: only registerWebApp was tested directly, so swapped webRoot/webDepsRoot
// arguments at the buildServer call (server.ts, "if (deps.webRoot) registerWebApp(...)") would go unnoticed.
describe('buildServer web app wiring', () => {
  it('serves the web dir at / and the deps dir file at /lochub_web_deps.js', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'lochub-srv-web-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="root">web-root-marker</div>');
    const webDepsRoot = mkdtempSync(join(tmpdir(), 'lochub-srv-webdeps-'));
    writeFileSync(join(webDepsRoot, 'lochub_web_deps.js'), 'export const vendor = "deps-root-marker";');
    // The same name in both folders: the web dir must win. Without this, a swapped webRoot/webDepsRoot at the
    // buildServer call would still pass — each lookup misses its first folder and falls back to the other one.
    writeFileSync(join(webRoot, 'shared.txt'), 'web-copy');
    writeFileSync(join(webDepsRoot, 'shared.txt'), 'deps-copy');

    const webApp = buildServer({
      store,
      llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-web-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: PORT,
      webRoot,
      webDepsRoot,
    });

    const index = await webApp.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('web-root-marker');

    const deps = await webApp.inject({ method: 'GET', url: '/lochub_web_deps.js' });
    expect(deps.statusCode).toBe(200);
    expect(deps.body).toContain('deps-root-marker');

    const shared = await webApp.inject({ method: 'GET', url: '/shared.txt' });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toBe('web-copy');
  });
});

// Custom (OpenAI-compatible) endpoint. The base URL carries a path and a token in its query: neither may ever
// reach /api/health. Every server built here injects endpointFetch, so the startup probe never reaches the network.
const CUSTOM_AI: AiConfig = {
  provider: 'custom',
  auth: 'api',
  translateModel: 'qwen3:8b',
  judgeModel: 'qwen3:8b',
  custom: {
    baseUrl: 'http://127.0.0.1:11434/v1?token=secret-token',
    keyHeader: 'bearer',
    structuredOutput: 'json_schema',
    priceIn: 0,
    priceOut: 0,
    maxParallel: 2,
    requestTimeoutSeconds: 600,
    settingsId: 'test-settings-id',
  },
};

function modelsReply(ids: string[]): Response {
  return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function customApp(env: NodeJS.ProcessEnv, endpointFetch: typeof fetch, ai: AiConfig = CUSTOM_AI, llmClient: FakeLlmClient = new FakeLlmClient(respond)) {
  return buildServer({
    store,
    llm: llmClient,
    cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvc-'))),
    jobDefaults: { ...jobDefaultsFor(ai), pollMs: 1 },
    bridge: new BridgeHub(),
    policy: 'validated',
    port: PORT,
    ai,
    env,
    endpointFetch,
  });
}

describe('Custom endpoint health and key gates', () => {
  const okFetch = (async () => modelsReply(['qwen3:8b'])) as typeof fetch;

  it('reports the endpoint host, settings id and probe status, never the endpoint settings or the full base URL', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    const endpointFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      await gate;
      return modelsReply(['qwen3:8b']);
    }) as typeof fetch;
    const server = customApp({}, endpointFetch);

    const first = await server.inject({ method: 'GET', url: '/api/health' });
    expect(first.json().ai).toEqual({
      provider: 'custom',
      auth: 'api',
      translateModel: 'qwen3:8b',
      judgeModel: 'qwen3:8b',
      batch: false,
      briefSha1: EMPTY_BRIEF_SHA1,
      keyId: '',
      lengthArgs: '--length-check off',
      ready: true,
      detail: NO_KEY_NEEDED_DETAIL,
      customSettingsId: 'test-settings-id',
      endpoint: { url: 'http://127.0.0.1:11434', status: 'checking' },
    });

    release();
    await vi.waitFor(async () => {
      const health = await server.inject({ method: 'GET', url: '/api/health' });
      expect(health.json().ai.endpoint).toEqual({ url: 'http://127.0.0.1:11434', status: 'ok' });
    });
    expect(seen).toEqual(['http://127.0.0.1:11434/v1/models?token=secret-token']);
    const raw = (await server.inject({ method: 'GET', url: '/api/health' })).body;
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('/v1');
  });

  it('never probes anything for a built-in provider', async () => {
    let probes = 0;
    const counting = (async () => {
      probes++;
      return modelsReply([]);
    }) as typeof fetch;
    const openAi: AiConfig = { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' };
    const health = await customApp(API_KEY_ENV, counting, openAi).inject({ method: 'GET', url: '/api/health' });
    expect(health.json().ai).not.toHaveProperty('endpoint');
    expect(health.json().ai).not.toHaveProperty('customSettingsId');
    expect(probes).toBe(0);
  });

  it('runs estimate, jobs and retranslate without a key (no ai_not_ready for a custom endpoint)', async () => {
    const estimate = await customApp({}, okFetch).inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(estimate.statusCode).toBe(200);
    const job = await customApp({}, okFetch).inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
    expect(job.statusCode).toBe(202);
    const tracked = new FakeLlmClient(respond);
    const retranslate = await customApp({}, okFetch, CUSTOM_AI, tracked).inject({
      method: 'POST',
      url: `/api/cells/ru/${idA}/retranslate`,
      payload: { note: 'It is a menu button' },
    });
    expect(retranslate.json().error).not.toBe('ai_not_ready');
    expect(tracked.calls.length).toBeGreaterThan(0);
  });
});

describe('Custom endpoint prices and Max USD', () => {
  const okFetch = (async () => modelsReply(['qwen3:8b'])) as typeof fetch;
  const priced: AiConfig = { ...CUSTOM_AI, custom: { ...CUSTOM_AI.custom!, priceIn: 1, priceOut: 2 } };

  it('estimates usd 0 with pricesUnset and starts a job without maxUsd when both prices are 0', async () => {
    const estimate = await customApp(API_KEY_ENV, okFetch).inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json().estimate).toMatchObject({ usd: 0, pricesUnset: true });
    const job = await customApp(API_KEY_ENV, okFetch).inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
    expect(job.statusCode).toBe(202);
  });

  it('requires and enforces maxUsd exactly like a built-in provider once a price is set', async () => {
    const estimate = await customApp(API_KEY_ENV, okFetch, priced).inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(estimate.json().estimate.usd).toBeGreaterThan(0);
    expect(estimate.json().estimate).not.toHaveProperty('pricesUnset');
    const missing = await customApp(API_KEY_ENV, okFetch, priced).inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru' } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'culture and maxUsd are required' });
    const over = await customApp(API_KEY_ENV, okFetch, priced).inject({ method: 'POST', url: '/api/jobs', payload: { culture: 'ru', maxUsd: Number.MIN_VALUE } });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('budget');
  });
});

describe('Length Check: cell routes', () => {
  // The shared snapshot's units carry no LocHub.Kind, so this service measures All strings. PAUSED has 6 visible
  // characters: ceil(6 x 1.3) + 4 = 12.
  const CONFIRM_ALL: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'confirm', scope: 'all' };
  const TOO_LONG = 'ПРИОСТАНОВЛЕНО НАДОЛГО'; // 22 visible characters
  const ISSUE = { code: 'too_long', severity: 'confirm', message: 'Too long for the UI: 22/12 characters (Length Check in Project Settings)' };
  const lengthApp = () =>
    buildServer({
      store,
      llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvlen-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, lengthCheck: CONFIRM_ALL },
      bridge,
      policy: 'validated',
      port: PORT,
    });

  it('the check route reports too_long with the configured severity; a service with the check off reports nothing', async () => {
    const res = await lengthApp().inject({ method: 'POST', url: `/api/cells/ru/${idA}/check`, payload: { text: TOO_LONG } });
    expect(res.json().issues).toEqual([ISSUE]);
    const plain = await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/check`, payload: { text: TOO_LONG } });
    expect(plain.json().issues).toEqual([]);
  });

  it('edit and approve refuse an over-limit text until the reviewer accepts too_long', async () => {
    const server = lengthApp();
    const refused = await server.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: TOO_LONG } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: 'Confirm these warnings to go ahead anyway: too_long', issues: [ISSUE] });
    const saved = await server.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: TOO_LONG, accept: ['too_long'] } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().cell).toMatchObject({ text: TOO_LONG, status: 'edited' });
    expect((await server.inject({ method: 'POST', url: `/api/cells/ru/${idA}/approve`, payload: {} })).statusCode).toBe(422);
    const approved = await server.inject({ method: 'POST', url: `/api/cells/ru/${idA}/approve`, payload: { accept: ['too_long'] } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().cell.status).toBe('approved');
  });
});

describe('Length Check: wire', () => {
  // The shared snapshot's units carry no LocHub.Kind, so this service measures All strings. PAUSED (6 visible) gets
  // ceil(6 x 1.3) + 4 = 12; '{Count} bales left' (11 visible) gets ceil(11 x 1.3) + 4 = 19.
  const WARNING_ALL: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'warning', scope: 'all' };
  const wireApp = (lengthCheck: LengthCheckConfig) =>
    buildServer({
      store,
      llm,
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-srvwire-'))),
      jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1, lengthCheck },
      bridge,
      policy: 'validated',
      port: PORT,
    });

  it('GET /api/cells gives every row its lengthLimit, and null while the check is off', async () => {
    const rows = (await wireApp(WARNING_ALL).inject({ method: 'GET', url: '/api/cells?culture=ru' })).json().rows as { unit: { key: string }; lengthLimit: number | null }[];
    expect(Object.fromEntries(rows.map((r) => [r.unit.key, r.lengthLimit]))).toEqual({ A: 12, B: 19 });
    const offRows = (await app.inject({ method: 'GET', url: '/api/cells?culture=ru' })).json().rows as { lengthLimit: number | null }[];
    expect(offRows.map((r) => r.lengthLimit)).toEqual([null, null]);
  });

  it('reports the Length Check flags it runs with as ai.lengthArgs', async () => {
    const health = (await wireApp({ ...WARNING_ALL, ratios: { de: 1.5 } }).inject({ method: 'GET', url: '/api/health' })).json();
    expect(health.ai.lengthArgs).toBe('--length-check warning --length-scope all --length-ratio 1.30 --length-extra 4 --length-ratios de=1.50 --length-hint on');
  });
});
