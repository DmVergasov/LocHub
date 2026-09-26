import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHub } from '../src/bridge.js';
import { ResponseCache } from '../src/cache.js';
import type { Snapshot } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { recordQuestion } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient, ok, requestItems } from './fakeLlm.js';

const snapshot: Snapshot = {
  target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
  entries: [
    { namespace: 'HW', key: 'A', source: 'PAUSED', origin: '/Game/UI/WBP_Pause', devNotes: '', metadata: {}, groupKey: 'Pause' },
    { namespace: 'HW', key: 'B', source: 'BACK', origin: '/Game/UI/WBP_Pause', devNotes: '', metadata: {}, groupKey: 'Pause' },
  ],
  coverage: [{ kind: 'FromString', file: 'Source/MyGame/Hud/MyHud.cpp', line: 42, text: 'SPEED' }],
};

const llm = new FakeLlmClient((r) =>
  ok(r.customId, { items: requestItems(r).map((i) => ({ id: i.id, translation: 'ВЕРНУТЬСЯ', ambiguity: 'none', alts: [], question: '', terms_used: [] })) }),
);

let store: LocHubStore;
let app: ReturnType<typeof buildServer>;
const idA = unitIdOf('HW', 'A');
const idB = unitIdOf('HW', 'B');

beforeEach(async () => {
  // POST /api/jobs/estimate 400s ai_not_ready without a key; real process.env has no test keys.
  vi.stubEnv('LOCHUB_API_KEY', 'test-key-not-real');
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-api-')));
  app = buildServer({
    store,
    llm,
    cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-apic-'))),
    jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
    bridge: new BridgeHub(),
    policy: 'validated',
    port: 80,
  });
  await app.inject({ method: 'POST', url: '/api/push', payload: snapshot });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('web and plugin API', () => {
  it('reports a dry-run push without applying it, and keeps the coverage of the last real push', async () => {
    const dry = await app.inject({
      method: 'POST', url: '/api/push?dryRun=1',
      payload: { ...snapshot, entries: [...snapshot.entries, { ...snapshot.entries[0]!, key: 'C', source: 'NEW' }], coverage: [] },
    });
    expect(dry.json()).toMatchObject({ added: 1 });
    expect(store.units.size).toBe(2);
    const coverage = (await app.inject({ method: 'GET', url: '/api/coverage' })).json();
    expect(coverage).toMatchObject({ findings: [{ kind: 'FromString', line: 42 }] });
    expect(coverage).not.toHaveProperty('headSha');
  });

  it('estimates a job without starting it', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: { culture: 'ru' } });
    expect(res.json().estimate).toMatchObject({ requests: 1, items: 2 });
    expect((await app.inject({ method: 'POST', url: '/api/jobs/estimate', payload: {} })).statusCode).toBe(400);
  });

  it('retranslates with a note into a suggestion and can add the note to the style guide', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/cells/ru/${idB}/retranslate`, payload: { note: 'Menu button', asRule: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().cell).toMatchObject({ suggestion: 'ВЕРНУТЬСЯ', text: '' });
    expect((await app.inject({ method: 'GET', url: '/api/style/ru' })).json().text).toContain('- Menu button');

    expect((await app.inject({ method: 'PUT', url: '/api/style/ru', payload: { text: 'Use "ты".' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/style/ru' })).json()).toEqual({ text: 'Use "ты".' });
  });

  it('returns the history of a cell', async () => {
    await app.inject({ method: 'POST', url: `/api/cells/ru/${idA}/edit`, payload: { text: 'ПАУЗА', actor: 'me' } });
    const history = (await app.inject({ method: 'GET', url: `/api/cells/ru/${idA}/history` })).json();
    expect(history).toEqual([expect.objectContaining({ action: 'edit', actor: 'me', after: 'ПАУЗА' })]);
  });

  it('lists, answers and applies inbox questions for the plugin', async () => {
    const q = recordQuestion(store, 'ru', idB, 'Button or direction?', 'ai', '2026-09-25T10:00:00Z')!;
    const open = (await app.inject({ method: 'GET', url: '/api/inbox?status=open' })).json();
    expect(open.rows).toEqual([expect.objectContaining({ item: expect.objectContaining({ id: q.id }), unit: expect.objectContaining({ namespace: 'HW', key: 'B', origin: '/Game/UI/WBP_Pause' }) })]);

    expect((await app.inject({ method: 'POST', url: `/api/inbox/${q.id}/answer`, payload: { answer: 'A button' } })).json().item.status).toBe('answered');
    expect((await app.inject({ method: 'GET', url: '/api/inbox?status=answered' })).json().rows).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/inbox/applied', payload: { ids: [q.id] } })).json()).toEqual({ applied: 1 });
    expect((await app.inject({ method: 'POST', url: '/api/inbox/nope/dismiss', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/inbox/${q.id}/answer`, payload: { answer: ' ' } })).statusCode).toBe(422);
  });

  it('summarizes a culture', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/summary?culture=ru' });
    expect(res.json()).toMatchObject({ culture: 'ru', total: 2, byStatus: { empty: 2 } });
    expect((await app.inject({ method: 'GET', url: '/api/summary' })).statusCode).toBe(400);
  });
});
