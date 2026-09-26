import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyExportAck, approveCell, CellActionError, checkCell, editCell, exportForPull, rejectCell, StaleCellError } from '../src/cells.js';
import type { SnapshotEntry } from '../src/contract.js';
import { textHash, unitIdOf } from '../src/ids.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';

const entry = (key: string, source: string): SnapshotEntry => ({
  namespace: 'HW', key, source, origin: 'o', devNotes: '', metadata: {}, groupKey: 'g',
});

let store: LocHubStore;
const idA = unitIdOf('HW', 'A');
const idB = unitIdOf('HW', 'B');

beforeEach(() => {
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-cells-')));
  applySnapshot(store, {
    target: 'Game', nativeCulture: 'en', cultures: ['ru'],
    entries: [entry('A', '{Count} bales left'), entry('B', 'BACK')], archives: {},
  });
  store.putCell({ ...store.getCell('ru', idA), text: 'Осталось {Count} тюков', status: 'ai_draft', basedOnSourceRev: 1, band: 'Y', qaFlags: ['audit'] });
});

describe('cell actions', () => {
  it('approves a valid draft and bumps the revision', () => {
    const cell = approveCell(store, 'ru', idA, 'me');
    expect(cell).toMatchObject({ status: 'approved', revision: 1 });
  });

  it('refuses to approve text that fails the precheck', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'Осталось тюков' });
    expect(() => approveCell(store, 'ru', idA, 'me')).toThrow(CellActionError);
  });

  // Check tiers: a needs_fix cell is re-checked instead of refused outright (the glossary may have changed since).
  it('approves a needs_fix cell whose text now passes the check', () => {
    store.putCell({ ...store.getCell('ru', idA), status: 'needs_fix' });
    expect(approveCell(store, 'ru', idA, 'me')).toMatchObject({ status: 'approved' });
  });

  it('accepts a valid edit and clears AI metadata', () => {
    const cell = editCell(store, 'ru', idA, 'Ещё {Count} тюков', 'me');
    expect(cell).toMatchObject({ status: 'edited', provenance: 'human:me', band: 'Y', judgeIssues: [], alts: [], qaFlags: ['audit'] });
  });

  it('rejects an edit that breaks arguments with the issues attached', () => {
    let caught: CellActionError | undefined;
    try {
      editCell(store, 'ru', idA, 'Ещё тюков', 'me');
    } catch (error) {
      caught = error as CellActionError;
    }
    expect(caught?.issues.map((i) => i.code)).toContain('args_missing');
    expect(caught?.statusCode).toBe(422);
    expect(store.getCell('ru', idA).text).toBe('Осталось {Count} тюков');
  });

  it('stores the reviewer note on reject', () => {
    expect(rejectCell(store, 'ru', idA, 'use "тюк"', 'me')).toMatchObject({ status: 'rejected', note: 'use "тюк"' });
  });

  it('returns 404 for an unknown unit', () => {
    let status = 0;
    try {
      approveCell(store, 'ru', 'ffffffffffffffff', 'me');
    } catch (error) {
      status = (error as CellActionError).statusCode;
    }
    expect(status).toBe(404);
  });
});

// The read-only check route's function: approveCell/editCell must refuse exactly the texts it flags as hard,
// since checkOrThrow calls the same checkTranslation this goes through.
describe('checkCell', () => {
  it('returns [] for good text', () => {
    expect(checkCell(store, 'ru', idA, 'Осталось {Count} тюков')).toEqual([]);
  });

  it('returns the issue for a dropped placeholder (confirm tier), without throwing or writing', () => {
    const before = store.getCell('ru', idA);
    const issues = checkCell(store, 'ru', idA, 'Осталось тюков');
    expect(issues).toEqual([expect.objectContaining({ code: 'args_missing', severity: 'confirm' })]);
    expect(store.getCell('ru', idA)).toEqual(before);
  });

  it('returns a hard issue for an argument the source does not have', () => {
    expect(checkCell(store, 'ru', idA, 'Осталось {Count} тюков {Extra}')).toEqual([expect.objectContaining({ code: 'args_extra', severity: 'hard' })]);
  });

  it('returns a soft untranslated issue for text equal to the source', () => {
    const issues = checkCell(store, 'ru', idA, '{Count} bales left');
    expect(issues).toEqual([expect.objectContaining({ code: 'untranslated', severity: 'soft' })]);
  });

  it('throws a 404 CellActionError for an unknown unit', () => {
    let status = 0;
    try {
      checkCell(store, 'ru', 'ffffffffffffffff', 'x');
    } catch (error) {
      status = (error as CellActionError).statusCode;
    }
    expect(status).toBe(404);
  });

  it('approveCell and editCell still refuse the same broken text checkCell flags as hard', () => {
    expect(checkCell(store, 'ru', idA, 'Осталось тюков').length).toBeGreaterThan(0);
    store.putCell({ ...store.getCell('ru', idA), text: 'Осталось тюков' });
    expect(() => approveCell(store, 'ru', idA, 'me')).toThrow(CellActionError);
    expect(() => editCell(store, 'ru', idA, 'Осталось тюков', 'me')).toThrow(CellActionError);
  });
});

// Check tiers: a 'confirm' issue (valid for Unreal, probably a mistake) needs the human to name it in `accept`;
// a 'hard' one is refused whatever `accept` says.
describe('approve anyway', () => {
  const dropped = 'Осталось тюков'; // args_missing (confirm)
  const lastEvent = () => store.readEvents('ru', idA).at(-1);
  const refusal = (action: () => unknown): CellActionError | undefined => {
    try {
      action();
    } catch (error) {
      return error as CellActionError;
    }
    return undefined;
  };

  beforeEach(() => {
    store.putCell({ ...store.getCell('ru', idA), text: dropped });
  });

  it('refuses a confirm issue without accept, with the issues attached', () => {
    const error = refusal(() => approveCell(store, 'ru', idA, 'me'));
    expect(error).toBeInstanceOf(CellActionError);
    expect(error?.statusCode).toBe(422);
    expect(error?.issues).toEqual([expect.objectContaining({ code: 'args_missing', severity: 'confirm' })]);
    expect(store.getCell('ru', idA).status).toBe('ai_draft');
  });

  it('approves when accept names every confirm code, and records them on the event', () => {
    expect(approveCell(store, 'ru', idA, 'me', undefined, ['args_missing'])).toMatchObject({ status: 'approved' });
    expect(lastEvent()).toMatchObject({ action: 'approve', accepted: ['args_missing'] });
  });

  it('refuses when accept misses one of the confirm codes', () => {
    store.glossary.set('ru', [{ term: 'bales', translation: '', dnt: true, note: '' }]);
    const error = refusal(() => approveCell(store, 'ru', idA, 'me', undefined, ['args_missing']));
    expect(error?.statusCode).toBe(422);
    expect(error?.issues.map((i) => i.code).sort()).toEqual(['args_missing', 'dnt']);
  });

  it('refuses a hard issue even when accept names it', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'Осталось {Count} тюков {Extra}' });
    const error = refusal(() => approveCell(store, 'ru', idA, 'me', undefined, ['args_extra']));
    expect(error?.statusCode).toBe(422);
    expect(store.getCell('ru', idA).status).toBe('ai_draft');
  });

  it('saves an edit with a confirm issue only with accept, and records it', () => {
    expect(refusal(() => editCell(store, 'ru', idA, 'Тюков нет', 'me'))?.statusCode).toBe(422);
    expect(editCell(store, 'ru', idA, 'Тюков нет', 'me', undefined, ['args_missing'])).toMatchObject({ status: 'edited', text: 'Тюков нет' });
    expect(lastEvent()).toMatchObject({ action: 'edit', accepted: ['args_missing'] });
  });

  it('writes no accepted field for a clean action', () => {
    editCell(store, 'ru', idA, 'Осталось {Count} тюков', 'me', undefined, ['args_missing']);
    expect(lastEvent()).not.toHaveProperty('accepted');
  });

  it('approves a needs_fix cell whose text has only confirm issues once accept names them', () => {
    store.putCell({ ...store.getCell('ru', idA), status: 'needs_fix' });
    expect(refusal(() => approveCell(store, 'ru', idA, 'me'))?.statusCode).toBe(422);
    expect(approveCell(store, 'ru', idA, 'me', undefined, ['args_missing'])).toMatchObject({ status: 'approved' });
  });

  it('still refuses a needs_fix cell whose text has a hard issue', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'Осталось {Count тюков', status: 'needs_fix' });
    expect(refusal(() => approveCell(store, 'ru', idA, 'me', undefined, ['args_missing', 'syntax']))?.statusCode).toBe(422);
  });
});

// Optimistic concurrency on approve/edit/reject. idA starts at cell.revision 0 and unit.sourceRev 1
// (the fixture's single Push).
describe('optimistic concurrency', () => {
  it('approves when both expected numbers match the current state', () => {
    const cell = approveCell(store, 'ru', idA, 'me', { revision: 0, sourceRev: 1 });
    expect(cell).toMatchObject({ status: 'approved', revision: 1 });
  });

  it('refuses an approve whose expected sourceRev is behind a Push that changed the source, and writes nothing', () => {
    applySnapshot(store, {
      target: 'Game', nativeCulture: 'en', cultures: ['ru'],
      entries: [entry('A', '{Count} bales remain'), entry('B', 'BACK')], archives: {},
    });
    const beforeCell = store.getCell('ru', idA);
    let caught: StaleCellError | undefined;
    try {
      approveCell(store, 'ru', idA, 'me', { sourceRev: 1 });
    } catch (error) {
      caught = error as StaleCellError;
    }
    expect(caught).toBeInstanceOf(StaleCellError);
    expect(caught?.cell).toEqual(beforeCell);
    expect(caught?.unit.sourceRev).toBe(2);
    // Nothing was written: the cell is unchanged and still at its pre-attempt revision.
    expect(store.getCell('ru', idA)).toEqual(beforeCell);
  });

  it('refuses an edit whose expected revision is behind an edit that already landed', () => {
    editCell(store, 'ru', idA, 'Ещё {Count} тюков', 'someone-else');
    let caught: StaleCellError | undefined;
    try {
      editCell(store, 'ru', idA, 'Совсем другое', 'me', { revision: 0 });
    } catch (error) {
      caught = error as StaleCellError;
    }
    expect(caught).toBeInstanceOf(StaleCellError);
    expect(caught?.cell.revision).toBe(1);
    expect(store.getCell('ru', idA).text).toBe('Ещё {Count} тюков');
  });

  it('rejects without the expected fields, unaffected by a stale revision (compat)', () => {
    editCell(store, 'ru', idA, 'Ещё {Count} тюков', 'someone-else');
    const cell = rejectCell(store, 'ru', idA, '', 'me');
    expect(cell).toMatchObject({ status: 'rejected', revision: 2 });
  });
});

describe('export for Pull', () => {
  it('exports validated drafts but not needs_fix, rejected, outdated or tombstoned units', () => {
    store.putCell({ ...store.getCell('ru', idB), text: 'НАЗАД', status: 'needs_fix', basedOnSourceRev: 1 });
    expect(exportForPull(store, 'ru', 'validated').map((e) => e.unitId)).toEqual([idA]);

    store.units.set(idA, { ...store.units.get(idA)!, sourceRev: 2 });
    expect(exportForPull(store, 'ru', 'validated')).toEqual([]);
  });

  it('exports only human-approved text under approved_only', () => {
    expect(exportForPull(store, 'ru', 'approved_only')).toEqual([]);
    approveCell(store, 'ru', idA, 'me');
    expect(exportForPull(store, 'ru', 'approved_only')).toHaveLength(1);
  });

  it('records written hashes and turns engine rejections into needs_fix', () => {
    applyExportAck(store, {
      culture: 'ru',
      written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }],
      rejected: [{ unitId: idB, translation: '', errors: ['bad'] }],
    });
    expect(store.getCell('ru', idA).archiveHash).toBe(textHash('Осталось {Count} тюков'));
    store.putCell({ ...store.getCell('ru', idB), text: 'НАЗАД', status: 'ai_draft', basedOnSourceRev: 1 });
    applyExportAck(store, { culture: 'ru', written: [], rejected: [{ unitId: idB, translation: 'НАЗАД', errors: ['Unknown argument'] }] });
    expect(store.getCell('ru', idB)).toMatchObject({ status: 'needs_fix', band: 'R', question: 'Unknown argument' });
  });

  // The engine's rejection names the text it actually rejected; a human edit made after Pull must not be
  // withheld by a rejection that describes the old, already-superseded text.
  it('ignores an ack rejection whose translation is not the cell\'s current text', () => {
    applyExportAck(store, { culture: 'ru', written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }], rejected: [] });
    const edited = editCell(store, 'ru', idA, 'Ещё {Count} тюков', 'me');
    applyExportAck(store, {
      culture: 'ru',
      written: [],
      rejected: [{ unitId: idA, translation: 'Осталось {Count} тюков', errors: ['bad'] }],
    });
    expect(store.getCell('ru', idA)).toMatchObject({ text: 'Ещё {Count} тюков', status: edited.status });
  });

  // The event log must show why a cell turned R (engine_rejected) and that a row was exported.
  it('logs an engine event for a written row and for a rejected row', () => {
    store.putCell(store.getCell('ru', idB)); // an empty cell, so applyExportAck's rejected[].translation ('') matches it
    applyExportAck(store, {
      culture: 'ru',
      written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }],
      rejected: [{ unitId: idB, translation: '', errors: ['bad'] }],
    });
    expect(store.readEvents('ru', idA)).toEqual([expect.objectContaining({ action: 'exported', actor: 'engine' })]);
    expect(store.readEvents('ru', idB)).toEqual([expect.objectContaining({ action: 'engine_rejected', actor: 'engine' })]);
  });

  // The plugin acks every valid entry on every Pull, changed or not. Appending 'exported' unconditionally
  // would write one event per unit per Pull forever; it must fire only when the archive actually changes.
  it('appends exported only when the acked text changes the archive hash, not on every identical ack', () => {
    applyExportAck(store, { culture: 'ru', written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }], rejected: [] });
    applyExportAck(store, { culture: 'ru', written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }], rejected: [] });
    applyExportAck(store, { culture: 'ru', written: [{ unitId: idA, translation: 'Осталось {Count} тюков' }], rejected: [] });
    const exported = store.readEvents('ru', idA).filter((e) => e.action === 'exported');
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ after: 'Осталось {Count} тюков' });
  });

  // The event must record the text the engine actually wrote, not the cell's current text (which may
  // already have moved on by the time the ack arrives).
  it('records the exported event\'s after as the acked translation, not the cell\'s current text', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'Здравствуй' });
    applyExportAck(store, { culture: 'ru', written: [{ unitId: idA, translation: 'Привет' }], rejected: [] });
    const exported = store.readEvents('ru', idA).filter((e) => e.action === 'exported');
    expect(exported).toEqual([expect.objectContaining({ before: 'Здравствуй', after: 'Привет' })]);
  });
});
