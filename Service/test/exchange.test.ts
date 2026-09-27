import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeHub } from '../src/bridge.js';
import { ResponseCache } from '../src/cache.js';
import { emptyCell, KIND_METADATA_KEY, type Cell, type CellEvent, type ImportEntry, type Snapshot } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { LENGTH_CHECK_OFF } from '../src/lengthCheck.js';
import { buildServer } from '../src/server.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient } from './fakeLlm.js';

// C is tagged as UI text so a Length Check scoped to UI (plan 2) gives it a limit.
const SOURCES: Record<string, string> = {
  A: 'PAUSED',
  B: '{Count} bales left',
  C: 'Continue',
  D: 'Quit',
  E: 'New Game',
  F: 'Settings',
  G: 'Credits',
  H: 'Health',
  I: 'Stamina',
  J: '{Count} coins',
};
const snapshot: Snapshot = {
  target: 'Game',
  nativeCulture: 'en',
  cultures: ['ru'],
  archives: {},
  entries: Object.entries(SOURCES).map(([key, source]) => ({
    namespace: 'HW',
    key,
    source,
    origin: 'o',
    devNotes: '',
    metadata: key === 'C' ? { [KIND_METADATA_KEY]: 'ui' } : {},
    groupKey: 'Hud',
  })),
};
const id = (key: string) => unitIdOf('HW', key);

let store: LocHubStore;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-imp-')));
  app = buildServer({
    store,
    llm: new FakeLlmClient(() => {
      throw new Error('an import never calls a model');
    }),
    cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-impc-'))),
    jobDefaults: { ...DEFAULT_JOB_OPTIONS, mode: 'sync', pollMs: 1 },
    bridge: new BridgeHub(),
    policy: 'validated',
    port: 80,
  });
  expect((await app.inject({ method: 'POST', url: '/api/push', payload: snapshot })).statusCode).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A cell as a job or a reviewer left it, saved like a real write.
function seed(key: string, patch: Partial<Cell>): void {
  const unit = store.units.get(id(key))!;
  store.putCell({ ...emptyCell(unit.id, 'ru'), basedOnSourceRev: unit.sourceRev, basedOnSource: unit.source, ...patch });
  store.save();
}

function body(entries: ImportEntry[], patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { culture: 'ru', actor: 'Alex', dryRun: true, overwriteConflicts: false, acceptConfirm: false, entries, ...patch };
}

const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/import', payload: payload as object });

function events(): CellEvent[] {
  const path = join(store.dataDir, 'events.ru.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CellEvent);
}

function makeStale(): void {
  const path = join(store.dataDir, 'cells.ru.jsonl');
  writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n');
  const bumped = new Date(Date.now() + 5000);
  utimesSync(path, bumped, bumped);
}

describe('POST /api/import — outcomes', () => {
  it('resolves by unitId, else by namespace + key; anything else is unknown', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const res = await post(
      body([
        { unitId: id('A'), text: 'ПАУЗА!', approved: false },
        { namespace: 'HW', key: 'C', text: 'Продолжить', approved: false },
        { unitId: 'nope', text: 'x', approved: false },
        { namespace: 'HW', key: 'Missing', text: 'x', approved: false },
        { text: 'x', approved: false },
      ]),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((row: { unitId?: string; outcome: string }) => [row.unitId, row.outcome])).toEqual([
      [id('A'), 'changed'],
      [id('C'), 'changed'],
      [undefined, 'unknown'],
      [undefined, 'unknown'],
      [undefined, 'unknown'],
    ]);
  });

  it('resolves by unitId even when namespace and key name another string', async () => {
    const row = (await post(body([{ unitId: id('A'), namespace: 'HW', key: 'C', text: 'Пауза', approved: false }]))).json().rows[0];
    expect(row).toMatchObject({ unitId: id('A'), outcome: 'changed' });
  });

  it('falls back to namespace + key when unitId does not resolve (a spreadsheet mangled it into a number)', async () => {
    const row = (await post(body([{ unitId: '1.23457E+15', namespace: 'HW', key: 'A', text: 'Пауза', approved: false }]))).json().rows[0];
    expect(row).toMatchObject({ unitId: id('A'), outcome: 'changed' });
  });

  it('treats a string no longer in the project (tombstoned) as unknown', async () => {
    await app.inject({ method: 'POST', url: '/api/push', payload: { ...snapshot, entries: snapshot.entries.filter((e) => e.key !== 'C') } });
    const res = await post(body([{ unitId: id('C'), text: 'Продолжить', approved: false }]));
    expect(res.json().rows[0].outcome).toBe('unknown');
  });

  it('skips an entry whose source changed since the export (stale); no source means no stale check', async () => {
    const res = await post(
      body([
        { unitId: id('A'), source: 'PAUSED (old)', text: 'ПАУЗА', approved: false },
        { unitId: id('C'), source: 'Continue', text: 'Продолжить', approved: false },
        { unitId: id('D'), text: 'Выход', approved: false },
      ]),
    );
    expect(res.json().rows.map((row: { outcome: string }) => row.outcome)).toEqual(['stale', 'changed', 'changed']);
  });

  it('never clears a translation: an empty or blank text is skipped', async () => {
    seed('A', { text: 'ПАУЗА', status: 'approved', revision: 1 });
    const res = await post(body([{ unitId: id('A'), text: '', approved: false }]));
    expect(res.json().rows[0].outcome).toBe('empty');
    const blank = await post(body([{ unitId: id('A'), text: '  \t ', approved: true }]));
    expect(blank.json().rows[0].outcome).toBe('empty');
  });

  it('reports an entry that would change nothing as unchanged, even when the cell changed since the export', async () => {
    seed('A', { text: 'ПАУЗА', status: 'edited', revision: 5 });
    seed('B', { text: 'Осталось {Count} тюков', status: 'approved', revision: 2 });
    const res = await post(
      body([
        { unitId: id('A'), text: 'ПАУЗА', approved: false, exportedRevision: 1 },
        { unitId: id('B'), text: 'Осталось {Count} тюков', approved: true, exportedRevision: 1 },
      ]),
    );
    const rows = res.json().rows;
    expect(rows.map((row: { outcome: string }) => row.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(rows[0].issues).toBeUndefined();
    expect(rows[0].conflict).toBeUndefined();
  });

  it('flags a conflict by revision and lets it through only with overwriteConflicts', async () => {
    seed('A', { text: 'ПАУЗА', status: 'edited', revision: 3 });
    const entries = [{ unitId: id('A'), text: 'ПАУЗА!', approved: false, exportedRevision: 2 }];
    expect((await post(body(entries))).json().rows[0]).toEqual({
      index: 0,
      unitId: id('A'),
      outcome: 'conflict',
      conflict: true,
      issues: [],
      before: 'ПАУЗА',
      after: 'ПАУЗА!',
    });
    expect((await post(body(entries, { overwriteConflicts: true }))).json().rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
    const current = (await post(body([{ ...entries[0]!, exportedRevision: 3 }]))).json().rows[0];
    expect(current.outcome).toBe('changed');
    expect(current.conflict).toBeUndefined();
  });

  it('without a revision, flags a conflict by date: a cell event after the export date, not exported/ai_suggestion', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const ev = (ts: string, action: CellEvent['action']): CellEvent => ({ ts, unitId: id('A'), culture: 'ru', action, actor: 'job', before: '', after: 'ПАУЗА' });
    store.appendEvent(ev('2026-09-27T10:00:00.000Z', 'ai_draft'));
    store.appendEvent(ev('2026-09-27T12:00:00.000Z', 'exported'));
    store.appendEvent(ev('2026-09-27T12:30:00.000Z', 'ai_suggestion'));
    const entry = (exportedAt: string) => ({ unitId: id('A'), text: 'ПАУЗА!', approved: false, exportedAt });

    expect((await post(body([entry('2026-09-27T11:00:00.000Z')]))).json().rows[0].outcome).toBe('changed');
    expect((await post(body([entry('2026-09-27T09:00:00.000Z')]))).json().rows[0].outcome).toBe('conflict');
    // A revision, when present, decides alone.
    expect((await post(body([{ ...entry('2026-09-27T09:00:00.000Z'), exportedRevision: 1 }]))).json().rows[0].outcome).toBe('changed');
    // No revision and no date: no conflict detection.
    expect((await post(body([{ unitId: id('A'), text: 'ПАУЗА!', approved: false }]))).json().rows[0].outcome).toBe('changed');
  });

  it('does not flag a conflict when the last change lands exactly at exportedAt (the boundary is not a conflict)', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const ts = '2026-09-27T12:00:00.000Z';
    store.appendEvent({ ts, unitId: id('A'), culture: 'ru', action: 'ai_draft', actor: 'job', before: '', after: 'ПАУЗА' });
    const res = await post(body([{ unitId: id('A'), text: 'ПАУЗА!', approved: false, exportedAt: ts }]));
    expect(res.json().rows[0].outcome).toBe('changed');
    expect(res.json().rows[0].conflict).toBeUndefined();
  });

  it('re-approves a string approved for an older source when the file approves it against the current one', async () => {
    seed('A', { text: 'ПАУЗА', status: 'approved', revision: 1 });
    const moved = { ...snapshot, entries: snapshot.entries.map((e) => (e.key === 'A' ? { ...e, source: 'GAME PAUSED' } : e)) };
    expect((await app.inject({ method: 'POST', url: '/api/push', payload: moved })).statusCode).toBe(200);
    const approve = { unitId: id('A'), source: 'GAME PAUSED', text: 'ПАУЗА', approved: true, exportedRevision: 1 };
    expect((await post(body([approve]))).json().rows[0].outcome).toBe('approved');
    // No source in the file: nothing shows the translator saw the new one.
    expect((await post(body([{ unitId: id('A'), text: 'ПАУЗА', approved: true, exportedRevision: 1 }]))).json().rows[0].outcome).toBe('unchanged');
    await post(body([approve], { dryRun: false }));
    expect(store.getCell('ru', id('A'))).toMatchObject({ status: 'approved', basedOnSource: 'GAME PAUSED', revision: 2 });
  });

  it('never lets a carried-over approved status approve new text: same export state, different text is changed', async () => {
    seed('A', { text: 'ПАУЗА', status: 'approved', revision: 1 });
    const res = await post(body([{ unitId: id('A'), text: 'Пауза!', approved: true, exportedRevision: 1 }]));
    expect(res.json().rows[0].outcome).toBe('changed');
  });

  it('still gives changed_approved for new text the file approves when the cell was not approved at export', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const res = await post(body([{ unitId: id('A'), text: 'Пауза!', approved: true, exportedRevision: 1 }]));
    expect(res.json().rows[0].outcome).toBe('changed_approved');
  });

  it('an overwritten conflict never approves, even over a cell that was approved before the conflict', async () => {
    seed('A', { text: 'ПАУЗА', status: 'approved', revision: 2 });
    const entries = [{ unitId: id('A'), text: 'Пауза!', approved: true, exportedRevision: 1 }];
    // The dry-run preview reports the same outcome as the real apply below.
    const preview = await post(body(entries, { overwriteConflicts: true }));
    expect(preview.json().rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
    const res = await post(body(entries, { overwriteConflicts: true, dryRun: false }));
    expect(res.json().rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
    expect(store.getCell('ru', id('A'))).toMatchObject({ text: 'Пауза!', status: 'edited' });
    expect(events().map((e) => [e.unitId, e.action])).toEqual([[id('A'), 'import']]);
  });

  it('an overwritten conflict never approves either, on a cell that was not approved before the conflict', async () => {
    seed('A', { text: 'ПАУЗА', status: 'edited', revision: 2 });
    const entries = [{ unitId: id('A'), text: 'Пауза!', approved: true, exportedRevision: 1 }];
    const res = await post(body(entries, { overwriteConflicts: true }));
    expect(res.json().rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
  });

  it('an overwritten conflict never approves the same text either (rejected in LocHub after the export)', async () => {
    seed('A', { text: 'ПАУЗА', status: 'rejected', revision: 2 });
    const entries = [{ unitId: id('A'), text: 'ПАУЗА', approved: true, exportedRevision: 1 }];
    expect((await post(body(entries))).json().rows[0]).toMatchObject({ outcome: 'conflict', conflict: true });
    const res = await post(body(entries, { overwriteConflicts: true, dryRun: false }));
    expect(res.json().rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
    expect(store.getCell('ru', id('A'))).toMatchObject({ text: 'ПАУЗА', status: 'edited', provenance: 'human:Alex' });
  });

  it('never applies a text with a hard issue, whatever the flags say', async () => {
    seed('B', { text: 'Осталось {Count} тюков', status: 'ai_draft', revision: 1 });
    const entries = [{ unitId: id('B'), text: 'Осталось {Cnt} тюков', approved: true }];
    for (const flags of [{}, { acceptConfirm: true, overwriteConflicts: true }]) {
      const row = (await post(body(entries, flags))).json().rows[0];
      expect(row.outcome).toBe('hard');
      expect(row.issues.map((issue: { code: string }) => issue.code)).toContain('args_extra');
    }
    const applied = await post(body(entries, { dryRun: false, acceptConfirm: true, overwriteConflicts: true }));
    expect(applied.json().rows[0].outcome).toBe('hard');
    expect(store.getCell('ru', id('B')).text).toBe('Осталось {Count} тюков');
    expect(events()).toEqual([]);
  });

  it('applies a text with only warnings just with acceptConfirm, and records the accepted codes', async () => {
    seed('B', { text: 'Осталось {Count} тюков', status: 'ai_draft', revision: 1 });
    const entries = [{ unitId: id('B'), text: 'Осталось мало тюков', approved: false }];
    expect((await post(body(entries))).json().rows[0].outcome).toBe('confirm');
    expect((await post(body(entries, { dryRun: false }))).json().rows[0].outcome).toBe('confirm');
    expect(store.getCell('ru', id('B')).text).toBe('Осталось {Count} тюков');

    const res = await post(body(entries, { dryRun: false, acceptConfirm: true }));
    expect(res.json().rows[0].outcome).toBe('changed');
    expect(store.getCell('ru', id('B'))).toMatchObject({ text: 'Осталось мало тюков', status: 'edited' });
    expect(events()).toMatchObject([{ action: 'import', actor: 'Alex', accepted: ['args_missing'] }]);
  });

  it('reports exactly the issues the /check route (Save) reports for the same text', async () => {
    await app.inject({ method: 'PUT', url: '/api/glossary/ru', payload: [{ term: 'PAUSED', translation: '', dnt: true, note: '' }] });
    const cases: [string, string][] = [
      [id('A'), 'ПАУЗА'],
      [id('B'), 'Осталось {Cnt} тюков'],
      [id('C'), 'Continue!'],
    ];
    for (const [unitId, text] of cases) {
      const check = await app.inject({ method: 'POST', url: `/api/cells/ru/${unitId}/check`, payload: { text } });
      const row = (await post(body([{ unitId, text, approved: false }]))).json().rows[0];
      expect(row.issues).toEqual(check.json().issues);
    }
    const dnt = (await post(body([{ unitId: id('A'), text: 'ПАУЗА', approved: false }]))).json().rows[0];
    expect(dnt.issues.map((issue: { code: string }) => issue.code)).toEqual(['dnt']);
  });

  it('counts every outcome', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    seed('B', { text: 'Осталось {Count} тюков', status: 'ai_draft', revision: 1 });
    seed('C', { text: 'Продолжить', status: 'ai_draft', revision: 1 });
    seed('D', { text: 'Выход', status: 'edited', revision: 1 });
    seed('G', { text: 'Титры', status: 'edited', revision: 4 });
    const res = await post(
      body([
        { unitId: id('A'), text: 'ПАУЗА!', approved: false },
        { unitId: id('B'), text: 'Осталось {Count} тюков', approved: true },
        { unitId: id('C'), text: 'Далее', approved: true },
        { unitId: id('D'), text: 'Выход', approved: false },
        { unitId: id('E'), source: 'New game', text: 'Новая игра', approved: false },
        { unitId: 'missing', text: 'x', approved: false },
        { unitId: id('F'), text: ' ', approved: false },
        { unitId: id('G'), text: 'Авторы', approved: false, exportedRevision: 3 },
        { unitId: id('H'), text: 'Здоровье {Value}', approved: false },
        { unitId: id('J'), text: 'Монеты', approved: false },
      ]),
    );
    expect(res.json().rows.map((row: { outcome: string }) => row.outcome)).toEqual([
      'changed',
      'approved',
      'changed_approved',
      'unchanged',
      'stale',
      'unknown',
      'empty',
      'conflict',
      'hard',
      'confirm',
    ]);
    expect(res.json().counts).toEqual({
      changed: 1,
      approved: 1,
      changed_approved: 1,
      unchanged: 1,
      stale: 1,
      unknown: 1,
      empty: 1,
      conflict: 1,
      hard: 1,
      confirm: 1,
    });
  });

  it('reports a re-imported, untouched export as unchanged throughout', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 2 });
    seed('B', { text: 'Осталось {Count} тюков', status: 'approved', revision: 3 });
    const entries = ['A', 'B'].map((key) => {
      const cell = store.getCell('ru', id(key));
      return { unitId: id(key), source: SOURCES[key]!, text: cell.text, approved: cell.status === 'approved', exportedRevision: cell.revision };
    });
    expect((await post(body(entries))).json().counts.unchanged).toBe(2);
  });

  it('applies the Length Check Save applies (plan 2)', async () => {
    // lengthApp: built like plan 2's server test with Length Check at Must Confirm (same buildServer deps),
    // over the same store this describe's beforeEach already pushed the snapshot into.
    const lengthApp = buildServer({
      store,
      llm: new FakeLlmClient(() => {
        throw new Error('an import never calls a model');
      }),
      cache: new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-impl-'))),
      jobDefaults: {
        ...DEFAULT_JOB_OPTIONS,
        mode: 'sync',
        pollMs: 1,
        lengthCheck: { ...LENGTH_CHECK_OFF, mode: 'confirm', scope: 'all' },
      },
      bridge: new BridgeHub(),
      policy: 'validated',
      port: 80,
    });
    // A fresh buildServer() starts with no lastPush of its own (that state is per app instance, not per store), and
    // /api/import now refuses a culture translationCultures() does not list; give lengthApp the same Push app got.
    expect((await lengthApp.inject({ method: 'POST', url: '/api/push', payload: snapshot })).statusCode).toBe(200);
    const text = 'Продолжить '.repeat(8).trim();
    const check = await lengthApp.inject({ method: 'POST', url: `/api/cells/ru/${id('C')}/check`, payload: { text } });
    const row = (await lengthApp.inject({ method: 'POST', url: '/api/import', payload: body([{ unitId: id('C'), text, approved: false }]) })).json().rows[0];
    expect(row.outcome).toBe('confirm');
    expect(row.issues.map((issue: { code: string }) => issue.code)).toContain('too_long');
    expect(row.issues).toEqual(check.json().issues);
  });
});

describe('POST /api/import — applying', () => {
  it('writes statuses, provenance and the current source; one save and one event per applied row', async () => {
    seed('A', {
      text: 'ПАУЗА',
      status: 'ai_draft',
      revision: 1,
      basedOnSourceRev: 0,
      basedOnSource: 'OLD',
      provenance: 'ai:model+v1',
      suggestion: 'Пауза?',
      note: 'n',
      qaFlags: ['audit', 'untranslated'],
    });
    seed('B', { text: 'Осталось {Count} тюков', status: 'ai_draft', revision: 2, provenance: 'ai:model+v1' });
    seed('C', { text: 'Продолжить', status: 'needs_fix', revision: 1 });
    const save = vi.spyOn(store, 'save');
    const append = vi.spyOn(store, 'appendEvents');

    const res = await post(
      body(
        [
          { unitId: id('A'), text: 'Пауза', approved: false },
          { unitId: id('B'), text: 'Осталось {Count} тюков', approved: true },
          { unitId: id('C'), text: 'Далее', approved: true },
          { unitId: id('D'), text: '', approved: false },
        ],
        { dryRun: false, actor: '  Alex  ' },
      ),
    );

    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(store.getCell('ru', id('A'))).toMatchObject({
      text: 'Пауза',
      status: 'edited',
      provenance: 'human:Alex',
      basedOnSourceRev: 1,
      basedOnSource: 'PAUSED',
      suggestion: '',
      note: '',
      qaFlags: ['audit'],
      revision: 2,
    });
    expect(store.getCell('ru', id('B'))).toMatchObject({ text: 'Осталось {Count} тюков', status: 'approved', provenance: 'ai:model+v1', revision: 3 });
    expect(store.getCell('ru', id('C'))).toMatchObject({ text: 'Далее', status: 'approved', provenance: 'human:Alex', revision: 2 });
    expect(events().map((e) => [e.unitId, e.action, e.actor, e.before, e.after])).toEqual([
      [id('A'), 'import', 'Alex', 'ПАУЗА', 'Пауза'],
      [id('B'), 'import', 'Alex', 'Осталось {Count} тюков', 'Осталось {Count} тюков'],
      [id('C'), 'import', 'Alex', 'Продолжить', 'Далее'],
    ]);
    expect(LocHubStore.load(store.dataDir).getCell('ru', id('A')).text).toBe('Пауза');
  });

  it('cuts the reviewer name to 64 characters', async () => {
    await post(body([{ unitId: id('A'), text: 'Пауза', approved: false }], { dryRun: false, actor: 'x'.repeat(80) }));
    expect(events()[0]!.actor).toBe('x'.repeat(64));
    expect(store.getCell('ru', id('A')).provenance).toBe(`human:${'x'.repeat(64)}`);
  });

  it('applies the rows that pass and leaves every refused row untouched, with no event for it', async () => {
    seed('A', { text: 'ПАУЗА', status: 'edited', revision: 3 });
    seed('B', { text: 'Осталось {Count} тюков', status: 'ai_draft', revision: 1 });
    seed('C', { text: 'Продолжить', status: 'ai_draft', revision: 1 });
    const res = await post(
      body(
        [
          { unitId: id('A'), text: 'Пауза', approved: false, exportedRevision: 2 },
          { unitId: id('B'), text: 'Осталось {Cnt} тюков', approved: false },
          { unitId: id('J'), text: 'Монеты', approved: false },
          { unitId: id('C'), text: 'Далее', approved: false },
        ],
        { dryRun: false },
      ),
    );
    expect(res.json().rows.map((row: { outcome: string }) => row.outcome)).toEqual(['conflict', 'hard', 'confirm', 'changed']);
    expect(store.getCell('ru', id('A')).text).toBe('ПАУЗА');
    expect(store.getCell('ru', id('B')).text).toBe('Осталось {Count} тюков');
    expect(store.getCell('ru', id('J')).text).toBe('');
    expect(events().map((e) => [e.unitId, e.action])).toEqual([[id('C'), 'import']]);
  });

  it('writes nothing on a dry run', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const cellsFile = join(store.dataDir, 'cells.ru.jsonl');
    const before = readFileSync(cellsFile, 'utf8');
    const save = vi.spyOn(store, 'save');
    const res = await post(body([{ unitId: id('A'), text: 'Пауза', approved: true }]));
    expect(res.json().rows[0].outcome).toBe('changed_approved');
    expect(save).not.toHaveBeenCalled();
    expect(readFileSync(cellsFile, 'utf8')).toBe(before);
    expect(store.getCell('ru', id('A')).text).toBe('ПАУЗА');
    expect(events()).toEqual([]);
  });

  it('refuses to write over data files changed on disk (409) and writes nothing; a dry run still answers', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    makeStale();
    const entries = [{ unitId: id('A'), text: 'Пауза', approved: false }];
    expect((await post(body(entries))).statusCode).toBe(200);
    const res = await post(body(entries, { dryRun: false }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'files_changed_on_disk' });
    expect(store.getCell('ru', id('A')).text).toBe('ПАУЗА');
    expect(events()).toEqual([]);
  });

  it('refuses (409) a non-dry-run request even when it would apply nothing, once the store went stale on disk; a dry run still answers 200', async () => {
    seed('A', { text: 'ПАУЗА', status: 'approved', revision: 1 });
    makeStale();
    // Same text, not asking for approval: this entry resolves to `unchanged`, so the pre-fix code (which only
    // checked freshness once something was actually applied) would have let this one through as 200.
    const entries = [{ unitId: id('A'), text: 'ПАУЗА', approved: false }];
    const dry = await post(body(entries));
    expect(dry.statusCode).toBe(200);
    expect(dry.json().rows[0].outcome).toBe('unchanged');
    const res = await post(body(entries, { dryRun: false }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'files_changed_on_disk' });
  });

  it('puts every cell back and writes no event when the save fails', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    seed('C', { text: 'Продолжить', status: 'ai_draft', revision: 1 });
    vi.spyOn(store, 'save').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const res = await post(
      body(
        [
          { unitId: id('A'), text: 'Пауза', approved: false },
          { unitId: id('C'), text: 'Далее', approved: false },
        ],
        { dryRun: false },
      ),
    );
    expect(res.statusCode).toBe(500);
    expect(store.getCell('ru', id('A')).text).toBe('ПАУЗА');
    expect(store.getCell('ru', id('C')).text).toBe('Продолжить');
    expect(events()).toEqual([]);
  });
});

describe('POST /api/import — preview digest', () => {
  it('refuses a stale preview (409 preview_stale), writing nothing, once the store changed since it', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const entries = [{ unitId: id('A'), text: 'Пауза', approved: false, exportedRevision: 1 }];
    const preview = await post(body(entries));
    expect(preview.json().rows[0].outcome).toBe('changed');
    const staleDigest = preview.json().digest;
    // Something else writes the cell between the preview and the apply: another tab, a job, a Push.
    seed('A', { text: 'Другое', status: 'edited', revision: 2 });
    const res = await post(body(entries, { dryRun: false, previewDigest: staleDigest }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'preview_stale' });
    expect(res.json().result.rows[0].outcome).toBe('conflict');
    expect(store.getCell('ru', id('A')).text).toBe('Другое');
    expect(events()).toEqual([]);
  });

  it('applies as before when the request carries no previewDigest (backward compatible)', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const res = await post(body([{ unitId: id('A'), text: 'Пауза', approved: false }], { dryRun: false }));
    expect(res.statusCode).toBe(200);
    expect(store.getCell('ru', id('A')).text).toBe('Пауза');
  });

  it('applies when previewDigest matches the freshly recomputed digest', async () => {
    seed('A', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 });
    const entries = [{ unitId: id('A'), text: 'Пауза', approved: false }];
    const preview = await post(body(entries));
    const res = await post(body(entries, { dryRun: false, previewDigest: preview.json().digest }));
    expect(res.statusCode).toBe(200);
    expect(store.getCell('ru', id('A')).text).toBe('Пауза');
    expect(events().map((e) => e.unitId)).toEqual([id('A')]);
  });
});

describe('POST /api/import — request validation', () => {
  const valid = () => body([{ unitId: id('A'), text: 'x', approved: false }]);
  const entryWith = (patch: Record<string, unknown>) => ({ ...valid(), entries: [{ unitId: id('A'), text: 'x', approved: false, ...patch }] });

  it.each([
    ['a non-object body', [], 'Body must be a JSON object'],
    ['no culture', { ...valid(), culture: undefined }, 'culture is required'],
    ['a non-string actor', { ...valid(), actor: 5 }, 'actor must be a string'],
    ['dryRun not a boolean', { ...valid(), dryRun: 'yes' }, 'dryRun must be true or false'],
    ['overwriteConflicts missing', { ...valid(), overwriteConflicts: undefined }, 'overwriteConflicts must be true or false'],
    ['acceptConfirm not a boolean', { ...valid(), acceptConfirm: 1 }, 'acceptConfirm must be true or false'],
    ['previewDigest not a string', { ...valid(), previewDigest: 5 }, 'previewDigest must be a string'],
    ['an empty actor on apply', { ...valid(), actor: '   ', dryRun: false }, 'actor is required: the reviewer name recorded on every imported string'],
    ['entries not an array', { ...valid(), entries: {} }, 'entries must be an array'],
    ['an entry that is not an object', { ...valid(), entries: ['x'] }, 'entries[0] must be an object'],
    ['text not a string', { ...valid(), entries: [{ unitId: id('A'), approved: false }] }, 'entries[0].text must be a string'],
    ['approved not a boolean', { ...valid(), entries: [{ unitId: id('A'), text: 'x' }] }, 'entries[0].approved must be true or false'],
    ['unitId not a string', entryWith({ unitId: 7 }), 'entries[0].unitId must be a string'],
    ['a negative revision', entryWith({ exportedRevision: -1 }), 'entries[0].exportedRevision must be a whole number'],
    ['a fractional revision', entryWith({ exportedRevision: 1.5 }), 'entries[0].exportedRevision must be a whole number'],
    ['an unparsable date', entryWith({ exportedAt: 'yesterday' }), 'entries[0].exportedAt must be a date (ISO 8601)'],
    // Date.parse alone accepts this ('9999' -> 9999-01-01Z) and would silently switch the date conflict rule off.
    ['a date Date.parse accepts but is not ISO 8601', entryWith({ exportedAt: '9999' }), 'entries[0].exportedAt must be a date (ISO 8601)'],
  ])('answers 400 for %s', async (_name, payload, error) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
  });

  it('refuses a file that names one string twice, writing nothing', async () => {
    const res = await post(
      body(
        [
          { unitId: id('A'), text: 'Пауза', approved: false },
          { namespace: 'HW', key: 'A', text: 'ПАУЗА', approved: false },
        ],
        { dryRun: false },
      ),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'The file has the same string twice (HW/A); keep one and import again.' });
    expect(store.getCell('ru', id('A')).text).toBe('');
    expect(events()).toEqual([]);
  });

  it('accepts an empty actor on a dry run, answers 400 for a bad culture and 415 for a non-JSON body', async () => {
    expect((await post(body([{ unitId: id('A'), text: 'x', approved: false }], { actor: '' }))).statusCode).toBe(200);
    expect((await post(body([], { culture: '../x' }))).statusCode).toBe(400);
    const plain = await app.inject({ method: 'POST', url: '/api/import', payload: 'x', headers: { 'content-type': 'text/plain' } });
    expect(plain.statusCode).toBe(415);
  });

  it('refuses a culture that is not a translation culture of the project: the native culture, or one nothing lists', async () => {
    const native = await post(body([{ unitId: id('A'), text: 'x', approved: false }], { culture: 'en' }));
    expect(native.statusCode).toBe(400);
    expect(native.json()).toEqual({ error: 'en is not a translation culture of this project' });
    const unlisted = await post(body([{ unitId: id('A'), text: 'x', approved: false }], { culture: 'de' }));
    expect(unlisted.statusCode).toBe(400);
    expect(unlisted.json()).toEqual({ error: 'de is not a translation culture of this project' });
  });
});
