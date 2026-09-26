import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BridgeHub } from '../src/bridge.js';
import { ResponseCache } from '../src/cache.js';
import { emptyCell, type Snapshot } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { buildServer } from '../src/server.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient, ok } from './fakeLlm.js';

const snapshot: Snapshot = {
  target: 'Game', nativeCulture: 'en', cultures: ['ru', 'de'], archives: {},
  entries: [{ namespace: 'HW', key: 'A', source: 'PAUSED', origin: 'Source/MyGame/A.cpp(3)', devNotes: '', metadata: {}, groupKey: 'Pause' }],
};

const llm = new FakeLlmClient((r) => ok(r.customId, { items: [] }));
const idA = unitIdOf('HW', 'A');
let store: LocHubStore;

// app.inject sends "Host: localhost:80" when the request names none; the Host allowlist compares it with this port.
const PORT = 80;

function makeServer() {
  return buildServer({
    store,
    llm,
    cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-webapic-'))),
    jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
    bridge: new BridgeHub(),
    policy: 'validated',
    port: PORT,
  });
}

beforeEach(() => {
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-webapi-')));
});

describe('web-only API', () => {
  it('lists the target cultures of the last push without the native one, spelled as the store spells them', async () => {
    const app = makeServer();
    await app.inject({ method: 'POST', url: '/api/push', payload: snapshot });
    expect((await app.inject({ method: 'GET', url: '/api/meta' })).json()).toEqual({ nativeCulture: 'en', cultures: ['de', 'ru'] });

    // "FR" differs only in case from the stored "fr": every culture route would answer 400, so meta leaves it out.
    store.putCell({ ...emptyCell(idA, 'fr'), text: 'PAUSE', status: 'edited' });
    await app.inject({ method: 'POST', url: '/api/push', payload: { ...snapshot, cultures: ['ru', 'de', 'FR'] } });
    expect((await app.inject({ method: 'GET', url: '/api/meta' })).json().cultures).toEqual(['de', 'fr', 'ru']);
  });

  it('keeps cultures that have cells after a service restart', async () => {
    await makeServer().inject({ method: 'POST', url: '/api/push', payload: snapshot });
    store.putCell({ ...emptyCell(idA, 'fr'), text: 'PAUSE', status: 'edited' });
    const meta = (await makeServer().inject({ method: 'GET', url: '/api/meta' })).json();
    expect(meta.nativeCulture).toBe('');
    expect(meta.cultures).toContain('fr');
  });

  it('records a reviewer question in the inbox', async () => {
    const app = makeServer();
    await app.inject({ method: 'POST', url: '/api/push', payload: snapshot });
    const created = await app.inject({ method: 'POST', url: '/api/inbox', payload: { culture: 'ru', unitId: idA, question: 'Is this a verb?' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().item).toMatchObject({ unitId: idA, culture: 'ru', askedBy: 'reviewer', status: 'open', question: 'Is this a verb?' });
    expect((await app.inject({ method: 'GET', url: '/api/inbox?status=open' })).json().rows).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: '/api/inbox', payload: { culture: 'ru', unitId: 'ffffffffffffffff', question: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/inbox', payload: { culture: 'ru', unitId: idA, question: '   ' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: '/api/inbox', payload: { culture: 'ru' } })).statusCode).toBe(400);
    // The culture guard of every other culture route applies here too.
    const traversal = await app.inject({ method: 'POST', url: '/api/inbox', payload: { culture: '../ru', unitId: idA, question: 'x' } });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error).toBe('Invalid culture');
  });
});
