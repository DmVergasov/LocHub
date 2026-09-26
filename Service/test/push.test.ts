import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot, SnapshotEntry } from '../src/contract.js';
import { textHash, unitIdOf } from '../src/ids.js';
import { pluralCategories } from '../src/precheck.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';

const store = () => LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-push-')));

// A dataDir plus a plural_forms.json path alongside it, so a second LocHubStore.load() on the same two
// paths can simulate a service restart.
const storeWithPersist = () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'lochub-push-persist-'));
  const pluralFormsPath = join(dataDir, '..', 'plural_forms.json');
  return { dataDir, pluralFormsPath, store: LocHubStore.load(dataDir, pluralFormsPath) };
};

const entry = (key: string, source: string): SnapshotEntry => ({
  namespace: 'HW',
  key,
  source,
  origin: '/Game/UI/WBP_Pause',
  devNotes: '',
  metadata: {},
  groupKey: '/Game/UI/WBP_Pause',
});

const snapshot = (entries: SnapshotEntry[], archives: Snapshot['archives'] = {}): Snapshot => ({
  target: 'Game',
  nativeCulture: 'en',
  cultures: ['ru'],
  entries,
  archives,
});

describe('applySnapshot', () => {
  it('adds new units at revision 1', () => {
    const s = store();
    expect(applySnapshot(s, snapshot([entry('A', 'PAUSED'), entry('B', 'BACK')])).added).toBe(2);
    expect(s.units.get(unitIdOf('HW', 'A'))?.sourceRev).toBe(1);
  });

  it('bumps the revision on a real change and keeps it on a cosmetic one', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'Load the truck'), entry('B', 'Press E.')]));
    const r = applySnapshot(s, snapshot([entry('A', 'Unload the truck'), entry('B', 'press e')]));
    expect(r).toMatchObject({ changed: 1, cosmetic: 1 });
    expect(s.units.get(unitIdOf('HW', 'A'))?.sourceRev).toBe(2);
    expect(s.units.get(unitIdOf('HW', 'B'))?.sourceRev).toBe(1);
    expect(s.units.get(unitIdOf('HW', 'B'))?.source).toBe('press e');
  });

  it('tombstones missing units and revives them with their translations', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED'), entry('B', 'BACK')], { ru: [{ namespace: 'HW', key: 'B', translation: 'НАЗАД', source: 'BACK' }] }));
    expect(applySnapshot(s, snapshot([entry('A', 'PAUSED')])).tombstoned).toBe(1);
    expect(s.units.get(unitIdOf('HW', 'B'))?.state).toBe('tombstone');
    expect(applySnapshot(s, snapshot([entry('A', 'PAUSED'), entry('B', 'BACK')])).revived).toBe(1);
    expect(s.units.get(unitIdOf('HW', 'B'))?.state).toBe('active');
    expect(s.getCell('ru', unitIdOf('HW', 'B')).text).toBe('НАЗАД');
  });

  it('is idempotent for an identical snapshot', () => {
    const s = store();
    const snap = snapshot([entry('A', 'PAUSED')]);
    applySnapshot(s, snap);
    expect(applySnapshot(s, snap)).toEqual({ added: 0, changed: 0, cosmetic: 0, tombstoned: 0, revived: 0, humanEdits: 0 });
    expect(s.units.get(unitIdOf('HW', 'A'))?.sourceRev).toBe(1);
  });

  it('records a pre-existing archive translation as a human edit once', () => {
    const s = store();
    const snap = snapshot([entry('A', 'PAUSED')], { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] });
    expect(applySnapshot(s, snap).humanEdits).toBe(1);
    const cell = s.getCell('ru', unitIdOf('HW', 'A'));
    expect(cell).toMatchObject({ text: 'ПАУЗА', status: 'human_edit', archiveHash: textHash('ПАУЗА'), basedOnSourceRev: 1 });
    expect(applySnapshot(s, snap).humanEdits).toBe(0);
  });

  it('ignores an archive that still holds the last exported text while the service has a newer draft', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED')]));
    const id = unitIdOf('HW', 'A');
    s.putCell({ ...s.getCell('ru', id), text: 'ПАУЗА!', status: 'ai_draft', basedOnSourceRev: 1, archiveHash: textHash('ПАУЗА') });
    const r = applySnapshot(s, snapshot([entry('A', 'PAUSED')], { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] }));
    expect(r.humanEdits).toBe(0);
    expect(s.getCell('ru', id).text).toBe('ПАУЗА!');
  });

  it('reports a dry run without touching units, cells or the event log', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED'), entry('B', 'BACK')]));
    const before = JSON.stringify([...s.units.values()]);
    const dry = snapshot([entry('A', 'PAUSE MENU'), entry('C', 'NEW')], { ru: [{ namespace: 'HW', key: 'C', translation: 'НОВОЕ', source: 'NEW' }] });
    expect(applySnapshot(s, dry, 'push', { dryRun: true })).toEqual({ added: 1, changed: 1, cosmetic: 0, tombstoned: 1, revived: 0, humanEdits: 1 });
    expect(JSON.stringify([...s.units.values()])).toBe(before);
    expect(s.getCell('ru', unitIdOf('HW', 'C')).status).toBe('empty');
    expect(existsSync(join(s.dataDir, 'events.ru.jsonl'))).toBe(false);
  });

  // job -> 'Привет'; Pull exports it but the ack is lost; the reviewer rejects; job -> 'Здравствуйте'.
  // The next Push still carries the archive's stale 'Привет' (UE preserves it, or the plugin's ack retry never
  // landed) — it must not resurrect the rejected text, because it is a text LocHub itself produced, not a human edit.
  it('ignores an archive entry that repeats a text LocHub already produced for this cell, even after a rejected rework', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED')]));
    const id = unitIdOf('HW', 'A');
    const t = '2026-01-01T00:00:00Z';
    // job -> 'Привет'
    s.putCell({ ...s.getCell('ru', id), text: 'Привет', status: 'ai_draft', basedOnSourceRev: 1, revision: 1 });
    s.appendEvent({ ts: t, unitId: id, culture: 'ru', action: 'ai_draft', actor: 'ai', before: '', after: 'Привет' });
    // Pull exports it; the ack never arrives, so archiveHash is never recorded.
    // the reviewer rejects it
    s.putCell({ ...s.getCell('ru', id), status: 'rejected', revision: 2 });
    s.appendEvent({ ts: t, unitId: id, culture: 'ru', action: 'reject', actor: 'reviewer', before: 'Привет', after: 'Привет' });
    // job -> 'Здравствуйте'
    s.putCell({ ...s.getCell('ru', id), text: 'Здравствуйте', status: 'ai_draft', revision: 3 });
    s.appendEvent({ ts: t, unitId: id, culture: 'ru', action: 'ai_draft', actor: 'ai', before: 'Привет', after: 'Здравствуйте' });

    const r = applySnapshot(s, snapshot([entry('A', 'PAUSED')], { ru: [{ namespace: 'HW', key: 'A', translation: 'Привет', source: 'PAUSED' }] }));
    expect(r.humanEdits).toBe(0);
    expect(s.getCell('ru', id).text).toBe('Здравствуйте');
    expect(s.readEvents('ru', id).filter((e) => e.action === 'human_edit')).toHaveLength(0);
  });

  // An archive entry made for an older source is a stale foreign entry the engine kept on purpose, not a
  // decision about the unit's current text.
  it('ignores an archive entry whose source is older than the unit\'s current source', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'Load the truck')]));
    const r = applySnapshot(
      s,
      snapshot([entry('A', 'Unload the truck')], { ru: [{ namespace: 'HW', key: 'A', translation: 'Загрузить машину', source: 'Load the truck' }] }),
    );
    expect(r.humanEdits).toBe(0);
    expect(s.getCell('ru', unitIdOf('HW', 'A')).text).toBe('');
  });

  // A genuinely new archive text made for the unit's current source is still adopted.
  it('adopts a new archive text made for the current source as a human edit', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED')]));
    const r = applySnapshot(s, snapshot([entry('A', 'PAUSED')], { ru: [{ namespace: 'HW', key: 'A', translation: 'ПАУЗА', source: 'PAUSED' }] }));
    expect(r.humanEdits).toBe(1);
    expect(s.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ text: 'ПАУЗА', status: 'human_edit' });
  });
});

// The engine's plural forms travel in the Push body (plural-engine brief): the latest value per culture is
// kept in memory, and every precheck/prompt lookup prefers it over Node's own ICU answer.
describe('applySnapshot: engine plural forms', () => {
  const FR = { cardinal: ['one', 'other'], ordinal: ['one', 'other'] };

  it('stores the forms per culture, and a later Push that leaves a culture out keeps its forms', () => {
    const s = store();
    applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { fr: FR, ru: { cardinal: ['one', 'few', 'many', 'other'], ordinal: ['other'] } } });
    expect(s.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
    expect(s.pluralCategoriesFor('ru', 'ordinal')).toEqual(['other']);

    applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { ru: { cardinal: ['one', 'other'], ordinal: ['other'] } } });
    expect(s.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
    expect(s.pluralCategoriesFor('ru', 'cardinal')).toEqual(['one', 'other']);
  });

  it('falls back to Node for a culture the engine sent nothing for (an older plugin sends no pluralForms)', () => {
    const s = store();
    applySnapshot(s, snapshot([entry('A', 'PAUSED')]));
    expect(s.pluralCategoriesFor('fr', 'cardinal')).toEqual(pluralCategories('fr', 'cardinal'));
  });

  it('stores nothing on a dry run', () => {
    const s = store();
    applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { fr: FR } }, 'push', { dryRun: true });
    expect(s.pluralCategoriesFor('fr', 'cardinal')).toEqual(pluralCategories('fr', 'cardinal'));
  });

  // The editor restarts the service on every AI/brief setting change (bs-fix1-brief), so the forms a Push
  // brought must survive that restart until the next Push, not just live in this process's memory.
  it('persists pushed forms, and a fresh service built on the same state dir has them (restart)', () => {
    const { dataDir, pluralFormsPath, store: s } = storeWithPersist();
    applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { fr: FR, ru: { cardinal: ['one', 'few', 'many', 'other'], ordinal: ['other'] } } });

    const restarted = LocHubStore.load(dataDir, pluralFormsPath);
    expect(restarted.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
    expect(restarted.pluralCategoriesFor('ru', 'ordinal')).toEqual(['other']);
  });

  it('does not erase the persisted file when a later Push omits pluralForms', () => {
    const { dataDir, pluralFormsPath, store: s } = storeWithPersist();
    applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { fr: FR } });
    applySnapshot(s, snapshot([entry('A', 'PAUSED MENU')])); // no pluralForms field at all

    const restarted = LocHubStore.load(dataDir, pluralFormsPath);
    expect(restarted.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
  });

  // m-2: a plural_forms.json write failure (a read-only Saved/, an AV lock on the .tmp file) must not turn an
  // otherwise-applied Push into a 500. `pluralFormsPath`'s directory is a plain file here, not a folder --
  // mkdirSync(dirname(...), {recursive:true}) then always throws EEXIST, on any platform, without needing
  // filesystem permissions -- a portable stand-in for the real-world unwritable-directory case.
  it('keeps the Push applied and the forms in memory when plural_forms.json cannot be written', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lochub-push-unwritable-'));
    const blockingFile = join(dataDir, 'blocked');
    writeFileSync(blockingFile, '');
    const pluralFormsPath = join(blockingFile, 'plural_forms.json');
    const s = LocHubStore.load(dataDir, pluralFormsPath);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = applySnapshot(s, { ...snapshot([entry('A', 'PAUSED')]), pluralForms: { fr: FR } });
      expect(report.added).toBe(1);
      expect(s.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(pluralFormsPath);
    } finally {
      warn.mockRestore();
    }
  });
});
