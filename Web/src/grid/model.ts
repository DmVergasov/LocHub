import { isOutdated } from '../../../Service/src/contract';
import type { Cell, CellRow, CellStatus, LiveEntry, Unit } from '../api/types';
import type { PathEntry } from '../common/PathFilter';
import { parseOrigin } from '../origin';

export interface GridCell {
  cell: Cell;
  outdated: boolean;
}

export interface GridRow {
  unit: Unit;
  cells: Record<string, GridCell>;
  // Precomputed lower-cased "key + source + every loaded culture's text": mergeCulture/withCell/
  // withUnit/dropCultures set it whenever they build or touch a row, so filterRows never lower-cases per call.
  // Optional only so a row built outside those helpers (older code, test fixtures) still type-checks; filterRows
  // falls back to computing it on the fly for those.
  search?: string;
}

export type GridData = Map<string, GridRow>;

export type BandFilter = 'R' | 'Y' | 'G' | 'none' | '';

export interface GridFilters {
  q: string;
  status: CellStatus | '';
  band: BandFilter;
  outdated: boolean;
  namespace: string;
  asset: string;
}

export const NO_FILTERS: GridFilters = { q: '', status: '', band: '', outdated: false, namespace: '', asset: '' };

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// The search text a row's `search` field holds: key + source + every loaded culture's cell text, lower-cased and
// space-joined. Recomputes from scratch over every loaded culture — used by filterRows's own fallback (a row
// built without `search`), withCell, withUnit and dropCultures, none of which run in a per-culture, per-row hot
// loop. mergeCulture (below) is that hot loop (50k rows x 10 cultures) and appends incrementally instead, to
// stay O(rows x cultures) rather than O(rows x cultures^2).
function computeSearch(unit: Unit, cells: Record<string, GridCell>): string {
  return [unit.key, unit.source, ...Object.values(cells).map((c) => c.cell.text)].join(' ').toLowerCase();
}

export function mergeCulture(data: GridData, culture: string, rows: readonly CellRow[]): GridData {
  const next = new Map(data);
  for (const { unit, cell, outdated } of rows) {
    const existing = next.get(unit.id);
    const cells = { ...(existing?.cells ?? {}), [culture]: { cell, outdated } };
    // A Pull can move a unit's sourceRev or change its source text under an id already in `data`; the row's
    // existing `search` was computed from the OLD unit's key/source, so appending onto it would keep that stale
    // text forever, and every already-loaded culture's own `outdated` flag was computed against the OLD unit too.
    // Fall back to a full recompute of both (search touches every loaded culture, not just this one; outdated is
    // recomputed the same way withUnit does it) whenever the unit itself changed; the common case (an unchanged
    // unit, or a brand-new row) keeps the incremental search append and this cell's own outdated flag as given.
    if (existing !== undefined && (existing.unit.sourceRev !== unit.sourceRev || existing.unit.source !== unit.source)) {
      const refreshedCells: Record<string, GridCell> = {};
      for (const [c, gridCell] of Object.entries(cells)) refreshedCells[c] = { cell: gridCell.cell, outdated: isOutdated(unit, gridCell.cell) };
      next.set(unit.id, { unit, cells: refreshedCells, search: computeSearch(unit, refreshedCells) });
      continue;
    }
    const base = existing?.search ?? `${unit.key} ${unit.source}`.toLowerCase();
    next.set(unit.id, { unit, cells, search: `${base} ${cell.text.toLowerCase()}` });
  }
  return next;
}

// Drops one or more loaded cultures from every row (a culture removed from the visible column set). A row
// untouched by the drop (it never had any of `cultures` loaded) keeps its existing object identity.
export function dropCultures(data: GridData, cultures: readonly string[]): GridData {
  if (cultures.length === 0) return data;
  const next = new Map(data);
  for (const [id, row] of next) {
    if (!cultures.some((c) => c in row.cells)) continue;
    const cells = { ...row.cells };
    for (const c of cultures) delete cells[c];
    next.set(id, { ...row, cells, search: computeSearch(row.unit, cells) });
  }
  return next;
}

export function withCell(data: GridData, cell: Cell): GridData {
  const row = data.get(cell.unitId);
  if (!row) return data;
  const next = new Map(data);
  const cells = { ...row.cells, [cell.culture]: { cell, outdated: isOutdated(row.unit, cell) } };
  next.set(cell.unitId, { ...row, cells, search: computeSearch(row.unit, cells) });
  return next;
}

// A 409 stale_cell answer carries the unit as the service currently holds it (e.g. a moved sourceRev), so the
// row's outdated flag is recomputed per culture from the new unit.
export function withUnit(data: GridData, unit: Unit): GridData {
  const row = data.get(unit.id);
  if (!row) return data;
  const next = new Map(data);
  const cells: Record<string, GridCell> = {};
  for (const [culture, gridCell] of Object.entries(row.cells)) cells[culture] = { cell: gridCell.cell, outdated: isOutdated(unit, gridCell.cell) };
  next.set(unit.id, { unit, cells, search: computeSearch(unit, cells) });
  return next;
}

export function sortRows(data: GridData): GridRow[] {
  return [...data.values()].sort((a, b) => compareText(a.unit.namespace, b.unit.namespace) || compareText(a.unit.key, b.unit.key));
}

// Asset package or source file of a unit: what the "Asset" filter groups by.
export function assetOf(unit: Unit): string {
  const origin = parseOrigin(unit.origin);
  return origin.kind === 'unknown' ? '' : origin.path;
}

// An Asset filter value ending in "/" means "this folder and everything under it" (path filter); anything
// else is an exact match, same as Namespace.
function matchesPath(candidate: string, filter: string): boolean {
  return filter.endsWith('/') ? candidate.startsWith(filter) : candidate === filter;
}

// A plain loop with results.push, not rows.filter(callback): at 50k rows the generic callback dispatch of
// Array.prototype.filter is measurable next to the per-row work itself, and this is the hot path a keystroke
// re-runs on every render.
export function filterRows(rows: readonly GridRow[], culture: string, filters: GridFilters): GridRow[] {
  const needle = filters.q.trim().toLowerCase();
  const { status: statusFilter, band: bandFilter, outdated: outdatedFilter, namespace: namespaceFilter, asset: assetFilter } = filters;
  const results: GridRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const gridCell = row.cells[culture];
    if (statusFilter && (gridCell?.cell.status ?? 'empty') !== statusFilter) continue;
    const band = gridCell?.cell.band ?? '';
    if (bandFilter === 'none' && band !== '') continue;
    if (bandFilter !== '' && bandFilter !== 'none' && band !== bandFilter) continue;
    if (outdatedFilter && !gridCell?.outdated) continue;
    if (namespaceFilter && row.unit.namespace !== namespaceFilter) continue;
    if (assetFilter && !matchesPath(assetOf(row.unit), assetFilter)) continue;
    if (needle && !(row.search ?? computeSearch(row.unit, row.cells)).includes(needle)) continue;
    results.push(row);
  }
  return results;
}

export function facets(rows: readonly GridRow[]): { namespaces: string[] } {
  const namespaces = new Set<string>();
  for (const row of rows) namespaces.add(row.unit.namespace);
  return { namespaces: [...namespaces].sort(compareText) };
}

// Asset paths of every row with a string count each (path filter): what PathFilter's suggestion popover
// offers for the Grid toolbar's Asset filter. A unit with no parseable asset/file path (assetOf returns '') is
// excluded, same as facets() used to do for its old `assets` field.
export function assetPathEntries(rows: readonly GridRow[]): PathEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const asset = assetOf(row.unit);
    if (asset) counts.set(asset, (counts.get(asset) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}

export function cellTone(gridCell: GridCell | undefined): string {
  if (!gridCell || gridCell.cell.status === 'empty') return 'tone-empty';
  if (gridCell.outdated) return 'tone-outdated';
  switch (gridCell.cell.status) {
    case 'approved':
    case 'edited':
    case 'human_edit':
      return 'tone-done';
    case 'needs_fix':
    case 'rejected':
      return 'tone-bad';
    default:
      return `tone-band-${gridCell.cell.band || 'none'}`;
  }
}

export interface StatusChip {
  label: string;
  tone: string;
}

// The trailing status badge on a grid cell (styles.css .status-chip): label and tone (a cellTone() result, reused
// as the CSS class) for the cell's current state. undefined means no chip at all (tone-empty: the cell is blank).
export function statusChip(gridCell: GridCell | undefined): StatusChip | undefined {
  const tone = cellTone(gridCell);
  if (tone === 'tone-empty') return undefined;
  if (tone === 'tone-outdated') return { label: 'Outdated', tone };
  if (tone === 'tone-done') {
    const label = gridCell!.cell.status === 'approved' ? 'Approved' : gridCell!.cell.status === 'edited' ? 'Edited' : 'Human';
    return { label, tone };
  }
  if (tone === 'tone-bad') {
    const label = gridCell!.cell.status === 'needs_fix' ? 'Needs fix' : 'Rejected';
    return { label, tone };
  }
  return { label: 'Draft', tone }; // tone-band-R|Y|G|none
}

// What "Apply live" sends: every text that would ship under the default policy (everything valid).
export function liveEntries(rows: readonly GridRow[], culture: string): LiveEntry[] {
  return rows.flatMap((row) => {
    const cell = row.cells[culture]?.cell;
    if (!cell || cell.text.length === 0 || cell.status === 'rejected' || cell.status === 'needs_fix') return [];
    return [{ namespace: row.unit.namespace, key: row.unit.key, source: row.unit.source, translation: cell.text }];
  });
}
