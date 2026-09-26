import { describe, expect, it } from 'vitest';
import {
  assetPathEntries,
  cellTone,
  dropCultures,
  facets,
  filterRows,
  liveEntries,
  mergeCulture,
  NO_FILTERS,
  sortRows,
  statusChip,
  withCell,
  type GridRow,
} from '../src/grid/model';
import { makeCell, makeUnit, rowsFromState } from './fakeApi';

const pause = makeUnit('Pause', 'PAUSED', { namespace: 'Menu', origin: '/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Title.Text' });
const bales = makeUnit('Bales', '{Count} bales left', { sourceRev: 2 });
const speed = makeUnit('Speed', 'SPEED');

function build(): GridRow[] {
  let data = mergeCulture(new Map(), 'ru', [
    { unit: pause, cell: makeCell(pause.id, 'ru', { text: 'ПАУЗА', status: 'approved' }), outdated: false },
    { unit: bales, cell: makeCell(bales.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y' }), outdated: true },
    { unit: speed, cell: makeCell(speed.id, 'ru', { status: 'empty' }), outdated: false },
  ]);
  data = mergeCulture(data, 'de', [{ unit: pause, cell: makeCell(pause.id, 'de', { text: 'PAUSE', status: 'ai_draft', band: 'R' }), outdated: false }]);
  return sortRows(data);
}

describe('grid model', () => {
  it('joins cultures per unit and sorts by namespace and key', () => {
    const rows = build();
    expect(rows.map((row) => row.unit.key)).toEqual(['Bales', 'Speed', 'Pause']);
    expect(Object.keys(rows[2]!.cells).sort()).toEqual(['de', 'ru']);
  });

  it('filters by status, band, outdated, namespace, asset and search', () => {
    const rows = build();
    const keys = (filters: Partial<typeof NO_FILTERS>, culture = 'ru') => filterRows(rows, culture, { ...NO_FILTERS, ...filters }).map((row) => row.unit.key);
    expect(keys({ status: 'approved' })).toEqual(['Pause']);
    expect(keys({ status: 'empty' })).toEqual(['Speed']);
    expect(keys({ band: 'Y' })).toEqual(['Bales']);
    expect(keys({ band: 'none' })).toEqual(['Speed', 'Pause']);
    expect(keys({ band: 'R' }, 'de')).toEqual(['Pause']);
    expect(keys({ outdated: true })).toEqual(['Bales']);
    expect(keys({ namespace: 'Menu' })).toEqual(['Pause']);
    expect(keys({ asset: '/Game/UI/WBP_Pause' })).toEqual(['Pause']);
    expect(keys({ q: 'тюков' })).toEqual(['Bales']);
    expect(keys({ q: 'spee' })).toEqual(['Speed']);
  });

  it('lists facets for the filter menus', () => {
    expect(facets(build())).toEqual({ namespaces: ['HW', 'Menu'] });
  });

  it('counts rows per asset path for the Asset PathFilter', () => {
    const entries = assetPathEntries(build());
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: '/Game/UI/WBP_Pause', count: 1 },
        { path: 'Source/MyGame/Private/Bales.cpp', count: 1 },
        { path: 'Source/MyGame/Private/Speed.cpp', count: 1 },
      ]),
    );
    expect(entries).toHaveLength(3);
  });

  it('matches the Asset filter exactly, or by folder prefix when the value ends with "/"', () => {
    const rows = build();
    expect(filterRows(rows, 'ru', { ...NO_FILTERS, asset: '/Game/UI/WBP_Pause' }).map((r) => r.unit.key)).toEqual(['Pause']);
    expect(filterRows(rows, 'ru', { ...NO_FILTERS, asset: '/Game/UI/' }).map((r) => r.unit.key)).toEqual(['Pause']);
    expect(filterRows(rows, 'ru', { ...NO_FILTERS, asset: '/Game/' }).map((r) => r.unit.key)).toEqual(['Pause']);
    expect(filterRows(rows, 'ru', { ...NO_FILTERS, asset: 'Source/MyGame/Private/' }).map((r) => r.unit.key).sort()).toEqual(['Bales', 'Speed']);
  });

  it('colours cells by status, band and staleness', () => {
    const rows = build();
    expect(cellTone(rows[0]!.cells.ru)).toBe('tone-outdated');
    expect(cellTone(rows[1]!.cells.ru)).toBe('tone-empty');
    expect(cellTone(rows[2]!.cells.ru)).toBe('tone-done');
    expect(cellTone(rows[2]!.cells.de)).toBe('tone-band-R');
    expect(cellTone(undefined)).toBe('tone-empty');
    expect(cellTone({ cell: makeCell('x', 'ru', { text: 't', status: 'needs_fix' }), outdated: false })).toBe('tone-bad');
  });

  it('maps cell state to a status chip label and tone, or to no chip when empty', () => {
    const rows = build();
    expect(statusChip(rows[0]!.cells.ru)).toEqual({ label: 'Outdated', tone: 'tone-outdated' }); // Bales/ru: outdated
    expect(statusChip(rows[1]!.cells.ru)).toBeUndefined(); // Speed/ru: empty
    expect(statusChip(rows[2]!.cells.ru)).toEqual({ label: 'Approved', tone: 'tone-done' }); // Pause/ru: approved
    expect(statusChip(rows[2]!.cells.de)).toEqual({ label: 'Draft', tone: 'tone-band-R' }); // Pause/de: ai_draft, band R
    expect(statusChip(undefined)).toBeUndefined();
    expect(statusChip({ cell: makeCell('x', 'ru', { text: 't', status: 'needs_fix' }), outdated: false })).toEqual({ label: 'Needs fix', tone: 'tone-bad' });
    expect(statusChip({ cell: makeCell('x', 'ru', { text: 't', status: 'rejected' }), outdated: false })).toEqual({ label: 'Rejected', tone: 'tone-bad' });
    expect(statusChip({ cell: makeCell('x', 'ru', { text: 't', status: 'edited' }), outdated: false })).toEqual({ label: 'Edited', tone: 'tone-done' });
    expect(statusChip({ cell: makeCell('x', 'ru', { text: 't', status: 'human_edit' }), outdated: false })).toEqual({ label: 'Human', tone: 'tone-done' });
    expect(statusChip({ cell: makeCell('x', 'ru', { text: 't', status: 'ai_draft', band: '' }), outdated: false })).toEqual({ label: 'Draft', tone: 'tone-band-none' });
  });

  it('recomputes staleness when a cell changes', () => {
    const data = mergeCulture(new Map(), 'ru', [{ unit: bales, cell: makeCell(bales.id, 'ru', { text: 'old', status: 'ai_draft', basedOnSourceRev: 1 }), outdated: true }]);
    const next = withCell(data, makeCell(bales.id, 'ru', { text: 'new', status: 'edited', basedOnSourceRev: 2 }));
    expect(next.get(bales.id)!.cells.ru).toEqual({ cell: expect.objectContaining({ text: 'new' }), outdated: false });
    expect(data.get(bales.id)!.cells.ru!.cell.text).toBe('old');
  });

  it('collects shippable texts for live preview', () => {
    expect(liveEntries(build(), 'ru')).toEqual([
      { namespace: 'HW', key: 'Bales', source: '{Count} bales left', translation: 'Осталось {Count} тюков' },
      { namespace: 'Menu', key: 'Pause', source: 'PAUSED', translation: 'ПАУЗА' },
    ]);
  });

  it('precomputes a lower-cased search string per row on merge, and recomputes it when a cell changes', () => {
    const rows = build();
    const balesRow = rows.find((r) => r.unit.key === 'Bales')!;
    expect(balesRow.search).toBe(balesRow.search?.toLowerCase());
    expect(balesRow.search).toContain('bales'); // from the key
    expect(balesRow.search).toContain('тюков'); // from the ru cell text

    const next = withCell(mergeCulture(new Map(), 'ru', [{ unit: bales, cell: makeCell(bales.id, 'ru', { text: 'old' }), outdated: false }]), makeCell(bales.id, 'ru', { text: 'new text' }));
    expect(next.get(bales.id)!.search).toContain('new text');
    expect(next.get(bales.id)!.search).not.toContain('old');
  });

  it('recomputes the full search, not just an incremental append, when the incoming unit itself changed', () => {
    const unitV1 = makeUnit('Doc', 'Old source text', { sourceRev: 1 });
    let data = mergeCulture(new Map(), 'ru', [{ unit: unitV1, cell: makeCell(unitV1.id, 'ru', { text: 'старый' }), outdated: false }]);
    data = mergeCulture(data, 'de', [{ unit: unitV1, cell: makeCell(unitV1.id, 'de', { text: 'alt' }), outdated: false }]);
    const before = data.get(unitV1.id)!;
    expect(before.search).toContain('old source text');
    expect(before.search).toContain('alt');

    // A Pull moved this unit's source text and sourceRev; re-merging "ru" with the new unit must drop the stale
    // "old source text" rather than append onto it, while still keeping the already-loaded "de" cell's text.
    const unitV2 = { ...unitV1, source: 'New source text', sourceRev: 2 };
    data = mergeCulture(data, 'ru', [{ unit: unitV2, cell: makeCell(unitV2.id, 'ru', { text: 'новый' }), outdated: false }]);
    const after = data.get(unitV2.id)!;
    expect(after.search).toContain('new source text');
    expect(after.search).not.toContain('old source text');
    expect(after.search).toContain('новый');
    expect(after.search).toContain('alt');
  });

  it("recomputes every other loaded culture's outdated flag too, not just search, when the incoming unit changed", () => {
    const unitV1 = makeUnit('Doc2', 'Old source text', { sourceRev: 1 });
    let data = mergeCulture(new Map(), 'ru', [{ unit: unitV1, cell: makeCell(unitV1.id, 'ru', { text: 'старый' }), outdated: false }]);
    data = mergeCulture(data, 'de', [{ unit: unitV1, cell: makeCell(unitV1.id, 'de', { text: 'alt', status: 'ai_draft' }), outdated: false }]);

    // A Pull moved this unit's sourceRev; re-merging "ru" with the new unit must recompute "de"'s own outdated
    // flag against the new unit too, the same way withUnit does, not just leave it as whatever it was merged in.
    const unitV2 = { ...unitV1, source: 'New source text', sourceRev: 2 };
    data = mergeCulture(data, 'ru', [{ unit: unitV2, cell: makeCell(unitV2.id, 'ru', { text: 'новый' }), outdated: false }]);

    const row = data.get(unitV1.id)!;
    expect(row.cells.de!.outdated).toBe(true); // basedOnSourceRev 1 < the unit's new sourceRev 2
    expect(row.cells.de!.cell.text).toBe('alt'); // the cell itself is untouched, only its outdated flag moved
  });

  it('drops a culture from every row, recomputing search, and leaves rows with none of that culture untouched', () => {
    let data = mergeCulture(new Map(), 'ru', [{ unit: pause, cell: makeCell(pause.id, 'ru', { text: 'ПАУЗА' }), outdated: false }]);
    data = mergeCulture(data, 'de', [{ unit: pause, cell: makeCell(pause.id, 'de', { text: 'ANDERSTEXT' }), outdated: false }]);
    const before = data.get(pause.id)!;
    expect(before.search).toContain('anderstext');

    const next = dropCultures(data, ['de']);
    const row = next.get(pause.id)!;
    expect(Object.keys(row.cells)).toEqual(['ru']);
    expect(row.search).not.toContain('anderstext'); // 'de' cell text is gone
    expect(row.search).toContain('пауза'); // 'ru' cell text stays

    // A row that never had the dropped culture keeps its exact object identity.
    let onlyRu = mergeCulture(new Map(), 'ru', [{ unit: speed, cell: makeCell(speed.id, 'ru', { text: 'x' }), outdated: false }]);
    const speedRow = onlyRu.get(speed.id)!;
    onlyRu = dropCultures(onlyRu, ['de']);
    expect(onlyRu.get(speed.id)).toBe(speedRow);

    // Dropping nothing returns the same Map reference (no-op).
    expect(dropCultures(data, [])).toBe(data);
  });

  it('filters out tombstoned (non-active) units in rowsFromState', () => {
    const activeUnit = makeUnit('Active', 'active source', { state: 'active' });
    const tombstonedUnit = makeUnit('Tombstoned', 'tombstoned source', { state: 'tombstone' });
    const state = {
      units: [activeUnit, tombstonedUnit],
      cells: {
        ru: {
          [activeUnit.id]: makeCell(activeUnit.id, 'ru', { text: 'активный', status: 'approved' }),
          [tombstonedUnit.id]: makeCell(tombstonedUnit.id, 'ru', { text: 'захоронено', status: 'approved' }),
        },
      },
      glossary: {},
      style: {},
      inbox: [],
      coverage: { pushedAt: '', findings: [] },
      editorConnected: false,
      estimateUsd: 0.5,
      jobPolls: 1,
      commands: [],
      stale: false,
      jobRunning: false,
    };

    const rows = rowsFromState(state, ['ru']);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unit.key).toBe('Active');
    // Verify tombstoned unit is not in the output
    expect(rows.some((row) => row.unit.key === 'Tombstoned')).toBe(false);
  });
});
