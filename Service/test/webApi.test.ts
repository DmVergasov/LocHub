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
    expect(meta.nativeCulture).toBe('en');
    expect(meta.cultures).toContain('fr');
  });

  describe('native culture', () => {
    function reloadable() {
      const root = mkdtempSync(join(tmpdir(), 'lochub-webapi-native-'));
      const args = [join(root, 'Localization', 'LocHub'), join(root, 'Saved', 'LocHub', 'plural_forms.json'), join(root, 'Saved', 'LocHub', 'native_culture.json')] as const;
      return () => LocHubStore.load(...args);
    }
    const zh = { ...snapshot, nativeCulture: 'zh-Hans', cultures: ['zh-Hans', 'en', 'ja'] };

    it('is reported after the service restarts from disk, and is not a translation culture', async () => {
      const load = reloadable();
      store = load();
      await makeServer().inject({ method: 'POST', url: '/api/push', payload: zh });
      // Cells left over for both the native culture (from before it became native) and a real target culture.
      store.putCell({ ...emptyCell(idA, 'zh-Hans'), text: '暂停', status: 'edited' });
      store.putCell({ ...emptyCell(idA, 'en'), text: 'PAUSED', status: 'edited' });
      store.save();
      store = load();
      expect((await makeServer().inject({ method: 'GET', url: '/api/meta' })).json()).toEqual({ nativeCulture: 'zh-Hans', cultures: ['en'] });
    });

    it('follows a change of the native culture in a later Push', async () => {
      const load = reloadable();
      store = load();
      const app = makeServer();
      await app.inject({ method: 'POST', url: '/api/push', payload: zh });
      await app.inject({ method: 'POST', url: '/api/push', payload: { ...zh, nativeCulture: 'en', cultures: ['en', 'zh-Hans'] } });
      store = load();
      expect((await makeServer().inject({ method: 'GET', url: '/api/meta' })).json().nativeCulture).toBe('en');
    });

    it('is not changed by a dry-run Push', async () => {
      const load = reloadable();
      store = load();
      const app = makeServer();
      await app.inject({ method: 'POST', url: '/api/push', payload: zh });
      await app.inject({ method: 'POST', url: '/api/push?dryRun=1', payload: { ...zh, nativeCulture: 'ja' } });
      expect((await app.inject({ method: 'GET', url: '/api/meta' })).json().nativeCulture).toBe('zh-Hans');
      store = load();
      expect(store.nativeCulture).toBe('zh-Hans');
    });

    it('is en when a Push does not say (an older plugin)', async () => {
      const app = makeServer();
      const { nativeCulture: _omitted, ...withoutNative } = snapshot;
      await app.inject({ method: 'POST', url: '/api/push', payload: withoutNative });
      expect((await app.inject({ method: 'GET', url: '/api/meta' })).json().nativeCulture).toBe('en');
    });
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
