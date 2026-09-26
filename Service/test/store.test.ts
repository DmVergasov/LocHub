import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyCell, isOutdated, type Unit } from '../src/contract.js';
import { canonicalJson, unitIdOf } from '../src/ids.js';
import { pluralCategories } from '../src/precheck.js';
import { LocHubStore, StoreChangedOnDiskError } from '../src/store.js';

// Wraps the real renameSync/readdirSync so a single test can make one call fail or return a fake listing
// (simulating a crash mid-rename, or a directory listing a case-insensitive filesystem could never actually
// produce) while every other fs call behaves normally.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), readdirSync: vi.fn(actual.readdirSync) };
});

const tempDir = () => mkdtempSync(join(tmpdir(), 'lochub-store-'));

function unit(namespace: string, key: string, source: string): Unit {
  return {
    id: unitIdOf(namespace, key),
    namespace,
    key,
    source,
    sourceRev: 1,
    state: 'active',
    origin: '/Game/Jobs/DA_Baler.DA_Baler:Title',
    devNotes: '',
    metadata: {},
    groupKey: '/Game/Jobs/DA_Baler',
  };
}

describe('ids', () => {
  it('keeps ids distinct for keys with separators, quotes, unicode and newlines', () => {
    const pairs: [string, string][] = [
      ['HW,Jobs', 'Title'],
      ['HW', 'Jobs,Title'],
      ['HW', 'Title "quoted"'],
      ['HW', 'Заголовок'],
      ['HW', 'Line\nBreak'],
      ['HW\u0000', 'X'],
      ['HW', '\u0000X'],
    ];
    const ids = pairs.map(([n, k]) => unitIdOf(n, k));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });

  it('serializes with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('isOutdated', () => {
  it('is true only for a non-empty cell based on an older source revision', () => {
    const u = { ...unit('HW', 'A', 'Load'), sourceRev: 2 };
    expect(isOutdated(u, emptyCell(u.id, 'ru'))).toBe(false);
    expect(isOutdated(u, { ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'approved', basedOnSourceRev: 1 })).toBe(true);
    expect(isOutdated(u, { ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'approved', basedOnSourceRev: 2 })).toBe(false);
  });
});

describe('LocHubStore', () => {
  it('round-trips units and cells through sorted canonical JSONL', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const tricky = [unit('HW', 'Line\nBreak', 'A'), unit('HW,Jobs', 'Title "q"', 'B'), unit('HW', 'Заголовок', 'C')];
    for (const u of tricky) store.units.set(u.id, u);
    store.putCell({ ...emptyCell(tricky[0]!.id, 'ru'), text: 'А', status: 'ai_draft', basedOnSourceRev: 1 });
    store.inbox.set('q1', {
      id: 'q1', unitId: tricky[0]!.id, culture: 'ru', question: 'Verb or noun?', askedBy: 'ai',
      status: 'open', answer: '', created: 't', answered: '',
    });
    store.save();

    const lines = readFileSync(join(dir, 'units.jsonl'), 'utf8').trimEnd().split('\n');
    const ids = lines.map((l) => (JSON.parse(l) as Unit).id);
    expect(ids).toEqual([...ids].sort());
    expect(lines[0]).toBe(canonicalJson(JSON.parse(lines[0]!)));

    const reloaded = LocHubStore.load(dir);
    expect([...reloaded.units.values()].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [...tricky].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(reloaded.getCell('ru', tricky[0]!.id).text).toBe('А');
    expect(reloaded.inbox.get('q1')?.question).toBe('Verb or noun?');
  });

  it('does not write empty cells', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell(emptyCell(u.id, 'ru'));
    store.save();
    expect(readFileSync(join(dir, 'cells.ru.jsonl'), 'utf8')).toBe('');
  });

  it('loads glossary and style guide', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'glossary.ru.jsonl'), '{"dnt":false,"note":"","term":"Baler","translation":"Тюковальщик"}\n');
    writeFileSync(join(dir, 'style.ru.md'), 'Use informal "ты".');
    const store = LocHubStore.load(dir);
    expect(store.glossary.get('ru')?.[0]?.translation).toBe('Тюковальщик');
    expect(store.style.get('ru')).toBe('Use informal "ты".');
  });

  // The brief is service config now (cli.ts's --brief-file), not store data: the store must not even notice a
  // brief.md file sitting in its data dir, let alone treat it as a conflicting external edit.
  it('a brief.md appearing in the data dir does not make the store stale', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    expect(store.changedOnDisk()).toBe(false);
    writeFileSync(join(dir, 'brief.md'), 'Open-world job simulator.');
    expect(store.changedOnDisk()).toBe(false);
  });

  // Push reads this once per culture per Push instead of calling readEvents per archive entry.
  it('groups every after text by unit id, and returns an empty map for a culture with no events', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    expect(store.afterTextsByUnit('ru')).toEqual(new Map());
    store.appendEvent({ ts: 't1', unitId: 'u', culture: 'ru', action: 'ai_draft', actor: 'ai', before: '', after: 'Привет' });
    store.appendEvent({ ts: 't2', unitId: 'u', culture: 'ru', action: 'ai_draft', actor: 'ai', before: 'Привет', after: 'Здравствуйте' });
    store.appendEvent({ ts: 't3', unitId: 'v', culture: 'ru', action: 'edit', actor: 'me', before: '', after: 'НАЗАД' });
    const afters = store.afterTextsByUnit('ru');
    expect(afters.get('u')).toEqual(new Set(['Привет', 'Здравствуйте']));
    expect(afters.get('v')).toEqual(new Set(['НАЗАД']));
  });

  it('appends events and reports bad JSONL with file and line', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    store.appendEvent({ ts: 't', unitId: 'u', culture: 'ru', action: 'edit', actor: 'me', before: 'a', after: 'b' });
    store.appendEvent({ ts: 't', unitId: 'v', culture: 'ru', action: 'edit', actor: 'me', before: 'c', after: 'd' });
    expect(readFileSync(join(dir, 'events.ru.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(store.readEvents('ru', 'u').map((e) => e.after)).toEqual(['b']);

    writeFileSync(join(dir, 'units.jsonl'), '{"id":"x"}\nnot json\n');
    expect(() => LocHubStore.load(dir)).toThrow(/units\.jsonl:2/);
  });

  // A pure read must never create a culture map — on NTFS "ru" and "RU" are the same file, and an
  // empty map for "RU" would truncate cells.ru.jsonl on the next save().
  it('getCell on an unknown culture returns an empty cell without inserting a map', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    expect(store.getCell('ru', u.id)).toEqual(emptyCell(u.id, 'ru'));
    expect(store.cells.has('ru')).toBe(false);
  });

  // A read with a differently-cased culture must not survive to wipe the real culture's file.
  it('does not let a differently-cased read truncate an existing culture file on save', () => {
    const dir = tempDir();
    let store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    const before = readFileSync(join(dir, 'cells.ru.jsonl'), 'utf8');
    expect(before.length).toBeGreaterThan(0);

    store = LocHubStore.load(dir);
    store.getCell('RU', u.id); // a bare read of the differently-cased culture
    store.save();
    expect(readFileSync(join(dir, 'cells.ru.jsonl'), 'utf8')).toBe(before);
  });

  // Writes go to <file>.tmp then rename over the target; a leftover .tmp from an interrupted write
  // must not be picked up as real data or otherwise break a later load.
  it('ignores a leftover .tmp file from an interrupted write', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'units.jsonl.tmp'), 'not valid json\n');
    writeFileSync(join(dir, 'cells.ru.jsonl.tmp'), 'garbage');
    writeFileSync(join(dir, 'style.ru.md.tmp'), 'garbage');
    const store = LocHubStore.load(dir);
    expect(store.units.size).toBe(0);
    expect(store.cells.has('ru')).toBe(false);
    expect(store.style.has('ru')).toBe(false);
  });

  // The case guard must see collisions across cells/glossary/style together, not just within one map
  // (a job started as "pt-br" leaving a cells map, then a style PUT for "pt-BR" landing in a different map).
  it('rejects a save when cultures collide across cells, glossary and style, not just within one map', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.style.set('RU', 'Use formal.');
    expect(() => store.save()).toThrow(/differ only in case/);
  });

  // save() itself must not leave a .tmp file behind on the happy path.
  it('does not leave a .tmp file behind after a normal save', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.style.set('ru', 'Use informal "ты".');
    store.save();
    expect(existsSync(join(dir, 'units.jsonl.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'cells.ru.jsonl.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'style.ru.md.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'units.jsonl'))).toBe(true);
  });

  // A JSONL write goes through <file>.tmp + renameSync, not a direct writeFileSync(target) — so a
  // crash during the rename must leave the previously saved file untouched (never truncated), with the new
  // content sitting in the .tmp file instead. writeFileSync(target) directly would already have clobbered
  // the old file before this failure point, so this genuinely distinguishes atomic from non-atomic writes.
  it('leaves the previous units.jsonl untouched if renameSync fails mid-write', () => {
    const dir = tempDir();
    let store = LocHubStore.load(dir);
    const a = unit('HW', 'A', 'Load');
    store.units.set(a.id, a);
    store.save();
    const before = readFileSync(join(dir, 'units.jsonl'), 'utf8');

    store = LocHubStore.load(dir);
    store.units.set(a.id, a);
    store.units.set(unit('HW', 'B', 'Unload').id, unit('HW', 'B', 'Unload'));
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated crash during rename');
    });
    expect(() => store.save()).toThrow('simulated crash during rename');

    expect(readFileSync(join(dir, 'units.jsonl'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'units.jsonl.tmp'))).toBe(true);
  });

  // Same mechanism for the style guide write, a separate call site from the JSONL helper. units.jsonl
  // is always written first (even empty), so its renameSync call is let through before the style one fails.
  it('leaves the previous style file untouched if renameSync fails mid-write', async () => {
    const dir = tempDir();
    let store = LocHubStore.load(dir);
    store.style.set('ru', 'Old style.');
    store.save();
    const before = readFileSync(join(dir, 'style.ru.md'), 'utf8');

    store = LocHubStore.load(dir);
    store.style.set('ru', 'New style.');
    const { renameSync: actualRenameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSync)
      .mockImplementationOnce((...args: Parameters<typeof renameSync>) => actualRenameSync(...args)) // units.jsonl
      .mockImplementationOnce(() => {
        throw new Error('simulated crash during rename'); // style.ru.md
      });
    expect(() => store.save()).toThrow('simulated crash during rename');

    expect(readFileSync(join(dir, 'style.ru.md'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, 'style.ru.md.tmp'))).toBe(true);
  });
});

// A `git pull` that updates Localization/LocHub/* files while the service holds
// them in memory must not be silently reverted by the next save().
describe('LocHubStore.changedOnDisk / save guard', () => {
  it('is false right after load, true after an external edit to a culture file, and false again after a fresh load', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    expect(store.changedOnDisk()).toBe(false);

    const path = join(dir, 'cells.ru.jsonl');
    const external = readFileSync(path, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(path, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped); // does not depend on clock resolution

    expect(store.changedOnDisk()).toBe(true);

    const reloaded = LocHubStore.load(dir);
    expect(reloaded.changedOnDisk()).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(external);
  });

  it('refuses to save and writes nothing when a data file changed on disk since load', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();

    const path = join(dir, 'cells.ru.jsonl');
    const external = readFileSync(path, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(path, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);

    store.putCell({ ...store.getCell('ru', u.id), text: 'ЗАГРУЗИТЬ' });
    expect(() => store.save()).toThrow(StoreChangedOnDiskError);
    expect(readFileSync(path, 'utf8')).toBe(external);
  });

  // assertFresh() is the same check save() uses, exposed so a caller can run it
  // before staging any putCell/appendEvent, not only inside save().
  it('assertFresh(): no-op when nothing changed, throws StoreChangedOnDiskError when a data file changed on disk', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    expect(() => store.assertFresh()).not.toThrow();

    const path = join(dir, 'cells.ru.jsonl');
    const external = readFileSync(path, 'utf8') + JSON.stringify({ unitId: 'external' }) + '\n';
    writeFileSync(path, external);
    const bumped = new Date(Date.now() + 5000);
    utimesSync(path, bumped, bumped);

    expect(() => store.assertFresh()).toThrow(StoreChangedOnDiskError);
  });

  it('does not trip the guard across two normal writes in a row (own writes refresh the fingerprint)', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    const u = unit('HW', 'A', 'Load');
    store.units.set(u.id, u);
    store.putCell({ ...emptyCell(u.id, 'ru'), text: 'Грузить', status: 'ai_draft', basedOnSourceRev: 1 });
    store.save();
    store.putCell({ ...store.getCell('ru', u.id), text: 'ЗАГРУЗИТЬ' });
    expect(() => store.save()).not.toThrow();
  });

  it('counts a newly added data file as a change even though nothing tracked was modified', () => {
    const dir = tempDir();
    const store = LocHubStore.load(dir);
    expect(store.changedOnDisk()).toBe(false);
    writeFileSync(join(dir, 'glossary.ru.jsonl'), '');
    expect(store.changedOnDisk()).toBe(true);
  });
});

// The case-collision guard save() already runs before writing must also run at the end of load(), so
// a Linux checkout that already holds both spellings on disk fails fast at startup with the same clear
// message, instead of loading silently and only failing on the first save().
describe('LocHubStore.load — case collisions at startup', () => {
  it('throws the case-collision message when the data dir already holds a culture and a differently-cased twin', () => {
    const dir = tempDir();
    // A case-insensitive filesystem (this test machine's NTFS included) cannot actually hold both
    // "cells.ru.jsonl" and "cells.RU.jsonl" as distinct directory entries, so the duplicate listing a Linux
    // checkout could produce is faked here for load()'s own readdirSync call instead of written to disk;
    // readJsonl tolerates the faked paths not existing (existsSync is false, so each reads back as empty).
    vi.mocked(readdirSync).mockReturnValueOnce(['cells.ru.jsonl', 'cells.RU.jsonl'] as unknown as string[]);
    expect(() => LocHubStore.load(dir)).toThrow(/differ only in case/);
  });
});

// A file written by a Windows editor can start with a UTF-8 BOM (U+FEFF); every reader load() uses
// must tolerate and strip it.
describe('LocHubStore.load — BOM tolerance', () => {
  it('loads a units.jsonl whose first line starts with a UTF-8 BOM', () => {
    const dir = tempDir();
    const u = unit('HW', 'A', 'Load');
    writeFileSync(join(dir, 'units.jsonl'), '﻿' + canonicalJson(u) + '\n');
    const store = LocHubStore.load(dir);
    expect(store.units.get(u.id)).toEqual(u);
  });

  it('loads a style guide whose file starts with a UTF-8 BOM, with the BOM stripped from the text', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'style.ru.md'), '﻿Use informal "ты".');
    const store = LocHubStore.load(dir);
    expect(store.style.get('ru')).toBe('Use informal "ты".');
  });
});

// The engine's plural forms from the last Push (plural-engine brief) are kept in memory, but the editor
// restarts the service on every AI/brief setting change, so they must also survive a restart until the next
// Push. Persisted to a second file, separate from dataDir (Localization/LocHub, source-controlled), because
// these forms describe the running engine, not project data (see cli.ts: Saved/LocHub/plural_forms.json).
describe('LocHubStore.load — persisted engine plural forms', () => {
  const formsPath = (dir: string) => join(dir, 'plural_forms.json');
  const FR = { cardinal: ['one', 'other'], ordinal: ['one', 'other'] };

  it('loads a valid persisted file at start and prefers it over Node\'s own rules', () => {
    const dir = tempDir();
    const path = formsPath(dir);
    writeFileSync(path, canonicalJson({ fr: FR }));
    const store = LocHubStore.load(dir, path);
    expect(store.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
    expect(store.pluralCategoriesFor('fr', 'ordinal')).toEqual(['one', 'other']);
  });

  it('falls back to Node\'s rules when no path is given, and when the file does not exist, with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = tempDir();
    expect(LocHubStore.load(dir).pluralCategoriesFor('fr', 'cardinal')).toEqual(pluralCategories('fr', 'cardinal'));
    expect(LocHubStore.load(dir, formsPath(dir)).pluralCategoriesFor('fr', 'cardinal')).toEqual(pluralCategories('fr', 'cardinal'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to Node\'s rules on a corrupt file, without throwing, and logs one warning line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = tempDir();
    const path = formsPath(dir);
    writeFileSync(path, '{ not valid json');
    let store: LocHubStore | undefined;
    expect(() => (store = LocHubStore.load(dir, path))).not.toThrow();
    expect(store!.pluralCategoriesFor('fr', 'cardinal')).toEqual(pluralCategories('fr', 'cardinal'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(path);
    warn.mockRestore();
  });

  it('persists updatePluralForms() atomically, with no leftover .tmp file', () => {
    const dir = tempDir();
    const path = formsPath(dir);
    const store = LocHubStore.load(dir, path);
    store.updatePluralForms({ fr: FR });
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ fr: FR });
  });

  it('a fresh store built on the same path sees forms written by an earlier one (restart)', () => {
    const dir = tempDir();
    const path = formsPath(dir);
    LocHubStore.load(dir, path).updatePluralForms({ fr: FR });
    const restarted = LocHubStore.load(dir, path);
    expect(restarted.pluralCategoriesFor('fr', 'cardinal')).toEqual(['one', 'other']);
  });
});
