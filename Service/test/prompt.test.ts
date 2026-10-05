import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotEntry } from '../src/contract.js';
import { buildGroups, neighborsOf, selectWork } from '../src/grouping.js';
import { unitIdOf } from '../src/ids.js';
import { cultureContext } from '../src/job.js';
import { buildCultureBlock, buildJudgeParams, buildTranslateParams, describeCulture, JUDGE_RULES, TRANSLATE_RULES, type CultureContext } from '../src/prompt.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';

const entry = (key: string, source: string, groupKey: string): SnapshotEntry => ({
  namespace: 'HW', key, source, origin: `/Game/${groupKey}`, devNotes: 'HUD button', metadata: { 'LocHub.Kind': 'ui' }, groupKey,
});

function seeded(): LocHubStore {
  const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-prompt-')));
  applySnapshot(store, {
    target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
    entries: [entry('A', 'PAUSED', 'Pause'), entry('B', 'BACK', 'Pause'), entry('C', '{Count} bales left', 'Hud'), entry('D', 'APPLY', 'Pause')],
  });
  return store;
}

const ctx: CultureContext = {
  culture: 'ru',
  brief: 'Job simulator.',
  style: 'Use "ты".',
  glossary: [{ term: 'MyGame', translation: '', dnt: true, note: '' }, { term: 'Baler', translation: 'Тюковальщик', dnt: false, note: '' }],
};

const userJson = (params: { messages: { content: unknown }[] }) => JSON.parse(params.messages[0]!.content as string) as {
  group: string;
  items: Record<string, unknown>[];
};

describe('selectWork and buildGroups', () => {
  it('selects empty, rejected, needs_fix and outdated cells, skipping approved up-to-date ones', () => {
    const store = seeded();
    store.putCell({ ...store.getCell('ru', unitIdOf('HW', 'A')), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1 });
    store.putCell({ ...store.getCell('ru', unitIdOf('HW', 'B')), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 0 });
    const ids = selectWork(store, 'ru').map((w) => w.unit.key).sort();
    expect(ids).toEqual(['B', 'C', 'D']);
  });

  it('groups by owner and chunks each group', () => {
    const groups = buildGroups(selectWork(seeded(), 'ru'), 2);
    expect(groups.map((g) => [g.groupKey, g.items.length])).toEqual([['Hud', 1], ['Pause', 2], ['Pause', 1]]);
  });

  it('honours unit and group filters', () => {
    const store = seeded();
    expect(selectWork(store, 'ru', { groupKey: 'Hud' }).map((w) => w.unit.key)).toEqual(['C']);
    expect(selectWork(store, 'ru', { unitIds: [unitIdOf('HW', 'D')] }).map((w) => w.unit.key)).toEqual(['D']);
  });

  it('honours a groupPrefix filter (path/folder filter), matching every group key that starts with it', () => {
    const store = seeded();
    // seeded() groups: A/B/D -> 'Pause', C -> 'Hud'. A prefix of 'Pa' matches only 'Pause'.
    expect(selectWork(store, 'ru', { groupPrefix: 'Pa' }).map((w) => w.unit.key).sort()).toEqual(['A', 'B', 'D']);
    expect(selectWork(store, 'ru', { groupPrefix: 'Hu' }).map((w) => w.unit.key)).toEqual(['C']);
    expect(selectWork(store, 'ru', { groupPrefix: 'Nope' })).toEqual([]);
  });

  it('collects translated neighbours of the same owner, excluding the work items', () => {
    const store = seeded();
    store.putCell({ ...store.getCell('ru', unitIdOf('HW', 'A')), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1 });
    store.putCell({ ...store.getCell('ru', unitIdOf('HW', 'D')), text: 'ПРИМЕН', status: 'needs_fix', basedOnSourceRev: 1 });
    expect(neighborsOf(store, 'ru', 'Pause', new Set([unitIdOf('HW', 'B')]), 20)).toEqual([{ source: 'PAUSED', translation: 'ПАУЗА' }]);
  });
});

describe('buildTranslateParams', () => {
  it('caches the culture block for an hour and sends every item once', () => {
    const [group] = buildGroups(selectWork(seeded(), 'ru'), 40).filter((g) => g.groupKey === 'Pause');
    const params = buildTranslateParams(ctx, group!, 'claude-opus-5');
    expect(params.model).toBe('claude-opus-5');
    const system = params.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(2);
    expect(system[0]!.cache_control).toBeUndefined();
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1]!.text).toContain('MyGame => DNT');
    expect(system[1]!.text).toMatch(/Plural categories \(cardinal\): .*few/);
    const body = userJson(params);
    expect(body.group).toBe('Pause');
    expect(body.items.map((i) => i.id).sort()).toEqual(group!.items.map((w) => w.unit.id).sort());
    expect(params.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
  });

  it('adds prev for outdated cells, the reviewer note for rejected ones and errors for repairs', () => {
    const store = seeded();
    const idA = unitIdOf('HW', 'A');
    const idB = unitIdOf('HW', 'B');
    store.putCell({ ...store.getCell('ru', idA), text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 0, basedOnSource: 'PAUSE' });
    store.putCell({ ...store.getCell('ru', idB), text: 'ОБРАТНО', status: 'rejected', note: 'button: go back', basedOnSourceRev: 1 });
    const [group] = buildGroups(selectWork(store, 'ru'), 40).filter((g) => g.groupKey === 'Pause');
    const repair = new Map([[idA, { previous: 'ПАУЗ', errors: ['Missing arguments: X'] }]]);
    const items = userJson(buildTranslateParams(ctx, group!, 'claude-opus-5', { repair })).items;
    const a = items.find((i) => i.id === idA)!;
    const b = items.find((i) => i.id === idB)!;
    expect(a).toMatchObject({ prev_source: 'PAUSE', prev: 'ПАУЗА', previous_attempt: 'ПАУЗ', errors: ['Missing arguments: X'] });
    expect(b).toMatchObject({ reviewer_note: 'button: go back', rejected_translation: 'ОБРАТНО' });
  });

  it('adds neighbours and answered questions as context', () => {
    const [group] = buildGroups(selectWork(seeded(), 'ru'), 40).filter((g) => g.groupKey === 'Hud');
    const id = unitIdOf('HW', 'C');
    const params = buildTranslateParams(ctx, group!, 'claude-opus-5', {
      neighbors: [{ source: 'Bales', translation: 'Тюки' }],
      answers: new Map([[id, ['It is a counter on the HUD']]]),
    });
    const body = JSON.parse(params.messages[0]!.content as string) as { neighbors: unknown; items: Record<string, unknown>[] };
    expect(body.neighbors).toEqual([{ source: 'Bales', translation: 'Тюки' }]);
    expect(body.items[0]).toMatchObject({ answers: ['It is a counter on the HUD'] });
  });

  it('is deterministic for identical input', () => {
    const groups = buildGroups(selectWork(seeded(), 'ru'), 40);
    const a = JSON.stringify(buildTranslateParams(ctx, groups[0]!, 'claude-opus-5'));
    const b = JSON.stringify(buildTranslateParams(ctx, groups[0]!, 'claude-opus-5'));
    expect(a).toBe(b);
  });

  it('produces identical params regardless of metadata key order', () => {
    // Create two stores with the same entry but metadata in different key orders
    const store1 = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-prompt-order1-')));
    const store2 = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-prompt-order2-')));

    // Entry with keys in order: 'LocHub.Kind', 'b'
    const entry1: SnapshotEntry = {
      namespace: 'HW',
      key: 'A',
      source: 'TEST',
      origin: '/Game/Test',
      devNotes: 'note',
      metadata: { 'LocHub.Kind': 'ui', b: '1' },
      groupKey: 'Test',
    };

    // Entry with keys in order: 'b', 'LocHub.Kind'
    const entry2: SnapshotEntry = {
      namespace: 'HW',
      key: 'A',
      source: 'TEST',
      origin: '/Game/Test',
      devNotes: 'note',
      metadata: { b: '1', 'LocHub.Kind': 'ui' },
      groupKey: 'Test',
    };

    applySnapshot(store1, {
      target: 'Game',
      nativeCulture: 'en',
      cultures: ['ru'],
      archives: {},
      entries: [entry1],
    });

    applySnapshot(store2, {
      target: 'Game',
      nativeCulture: 'en',
      cultures: ['ru'],
      archives: {},
      entries: [entry2],
    });

    const groups1 = buildGroups(selectWork(store1, 'ru'), 40);
    const groups2 = buildGroups(selectWork(store2, 'ru'), 40);

    const paramsA = buildTranslateParams(ctx, groups1[0]!, 'claude-opus-5');
    const paramsB = buildTranslateParams(ctx, groups2[0]!, 'claude-opus-5');

    expect(JSON.stringify(paramsA)).toBe(JSON.stringify(paramsB));
  });
});

// ja has a single cardinal AND ordinal plural form: keeping |plural(...)/|ordinal(...) there is rejected
// by the engine (FTextFormatArgumentModifier_PluralForm::Validate). The prompt must tell the model so,
// and give it the ordinal categories it needs to decide (cardinal categories alone do not cover |ordinal).
describe('buildCultureBlock: single-plural-form cultures', () => {
  it('lists the ordinal categories alongside the cardinal ones', () => {
    const block = buildCultureBlock(ctx);
    expect(block).toMatch(/Plural categories \(cardinal\): .*few/);
    expect(block).toMatch(/Plural categories \(ordinal\): /);
  });

  it('the ordinal line reflects a single-form culture', () => {
    const jaCtx: CultureContext = { ...ctx, culture: 'ja' };
    expect(buildCultureBlock(jaCtx)).toMatch(/Plural categories \(ordinal\): other$/m);
  });
});

// The engine's forms (sent with every Push) are the ones the engine validates against on Pull, so the model must
// be told those, not Node's own ICU answer, whenever the plugin sent them.
describe('buildCultureBlock: engine plural forms', () => {
  it('lists the engine forms when the context carries them', () => {
    const block = buildCultureBlock({ ...ctx, culture: 'fr', plurals: { cardinal: ['one', 'other'], ordinal: ['one', 'other'] } });
    expect(block).toMatch(/^Plural categories \(cardinal\): one, other$/m);
    expect(block).toMatch(/^Plural categories \(ordinal\): one, other$/m);
  });

  it('cultureContext takes the forms the store holds from the last Push', () => {
    const store = seeded();
    applySnapshot(store, {
      target: 'Game', nativeCulture: 'en', cultures: ['fr'], archives: {}, entries: [entry('A', 'PAUSED', 'Pause')],
      pluralForms: { fr: { cardinal: ['one', 'other'], ordinal: ['one', 'other'] } },
    });
    expect(buildCultureBlock(cultureContext(store, 'fr', ''))).toMatch(/^Plural categories \(cardinal\): one, other$/m);
  });
});

describe('TRANSLATE_RULES: single-plural-form cultures', () => {
  it('tells the model to drop the modifier when the target culture has a single category', () => {
    expect(TRANSLATE_RULES).toMatch(/single.*(plural|category|form)/i);
  });
});

describe('buildJudgeParams', () => {
  it('sends source and translation per item to the judge model', () => {
    const [group] = buildGroups(selectWork(seeded(), 'ru'), 40).filter((g) => g.groupKey === 'Hud');
    const id = unitIdOf('HW', 'C');
    const params = buildJudgeParams(ctx, group!, new Map([[id, 'Осталось {Count} тюков']]), 'claude-sonnet-5');
    expect(params.model).toBe('claude-sonnet-5');
    expect(userJson(params).items).toEqual([
      expect.objectContaining({ id, source: '{Count} bales left', translation: 'Осталось {Count} тюков' }),
    ]);
    expect(params.output_config).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
  });
});

describe('TRANSLATE_RULES: Length Check', () => {
  it('explains maxLength the way the precheck counts it', () => {
    expect(TRANSLATE_RULES).toContain(
      '- If an item has maxLength, keep the translation within maxLength visible characters: placeholders and tags count 0, CJK characters count 2. Prefer a natural shorter wording over abbreviations.',
    );
  });
});

describe('source culture', () => {
  it('describes a culture by its English name and its code', () => {
    expect(describeCulture('zh-Hans')).toBe('Simplified Chinese (zh-Hans)');
    expect(describeCulture('en')).toBe('English (en)');
  });

  it('falls back to "the source language" for an unknown, invalid or empty code, without throwing', () => {
    expect(describeCulture('xx-Fake')).toBe('the source language (xx-Fake)');
    expect(describeCulture('%%')).toBe('the source language (%%)');
    expect(describeCulture('')).toBe('the source language');
  });

  it('starts the culture block with the source culture', () => {
    expect(buildCultureBlock({ ...ctx, culture: 'en', sourceCulture: 'zh-Hans' }).split('\n').slice(0, 2)).toEqual([
      'Source culture: Simplified Chinese (zh-Hans)',
      'Target culture: en',
    ]);
    expect(buildCultureBlock(ctx).split('\n')[0]).toBe('Source culture: the source language');
  });

  it('names the source culture in translate and judge requests, and the fixed rules no longer say English', () => {
    const [group] = buildGroups(selectWork(seeded(), 'ru'), 40).filter((g) => g.groupKey === 'Hud');
    const zh = { ...ctx, sourceCulture: 'zh-Hans' };
    expect(JSON.stringify(buildTranslateParams(zh, group!, 'claude-opus-5'))).toContain('Source culture: Simplified Chinese (zh-Hans)');
    expect(JSON.stringify(buildJudgeParams(zh, group!, new Map(), 'claude-sonnet-5'))).toContain('Source culture: Simplified Chinese (zh-Hans)');
    expect(TRANSLATE_RULES).not.toMatch(/English/);
    expect(JUDGE_RULES).not.toMatch(/English/);
  });

  it('cultureContext takes the source culture from the store', () => {
    const store = seeded();
    store.setNativeCulture('zh-Hans');
    expect(cultureContext(store, 'en', '').sourceCulture).toBe('zh-Hans');
  });
});
