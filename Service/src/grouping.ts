import { isOutdated, type Cell, type Culture, type Unit } from './contract.js';
import { compareCodeUnits } from './ids.js';
import type { LocHubStore } from './store.js';

export interface WorkItem {
  unit: Unit;
  cell: Cell;
}

export interface WorkGroup {
  groupKey: string;
  items: WorkItem[];
}

export const UNGROUPED = '(ungrouped)';

export function needsWork(unit: Unit, cell: Cell): boolean {
  if (unit.state !== 'active') return false;
  if (cell.status === 'empty' || cell.status === 'rejected' || cell.status === 'needs_fix') return true;
  return isOutdated(unit, cell);
}

export function selectWork(
  store: LocHubStore,
  culture: Culture,
  filter?: { groupKey?: string; groupPrefix?: string; unitIds?: string[] },
): WorkItem[] {
  const ids = filter?.unitIds ? new Set(filter.unitIds) : undefined;
  const out: WorkItem[] = [];
  for (const unit of store.units.values()) {
    if (ids && !ids.has(unit.id)) continue;
    if (filter?.groupKey !== undefined && unit.groupKey !== filter.groupKey) continue;
    if (filter?.groupPrefix !== undefined && !unit.groupKey.startsWith(filter.groupPrefix)) continue;
    const cell = store.getCell(culture, unit.id);
    if (needsWork(unit, cell)) out.push({ unit, cell });
  }
  return out.sort((a, b) => compareCodeUnits(a.unit.id, b.unit.id));
}

export interface Neighbor {
  source: string;
  translation: string;
}

const NEIGHBOR_STATUSES: ReadonlySet<string> = new Set(['ai_draft', 'approved', 'edited', 'human_edit']);

// Already translated strings of the same owner: the model keeps wording consistent with them.
export function neighborsOf(store: LocHubStore, culture: Culture, groupKey: string, exclude: ReadonlySet<string>, max: number): Neighbor[] {
  const out: Neighbor[] = [];
  const units = [...store.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const unit of units) {
    if (out.length >= max) break;
    if (unit.state !== 'active' || unit.groupKey !== groupKey || exclude.has(unit.id)) continue;
    const cell = store.getCell(culture, unit.id);
    if (!NEIGHBOR_STATUSES.has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    out.push({ source: unit.source, translation: cell.text });
  }
  return out;
}

// Strings of one owner (asset, screen, quest, source file) travel together so terminology stays consistent.
export function buildGroups(items: readonly WorkItem[], maxSize: number): WorkGroup[] {
  const byKey = new Map<string, WorkItem[]>();
  for (const item of items) {
    const key = item.unit.groupKey || UNGROUPED;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  const groups: WorkGroup[] = [];
  for (const key of [...byKey.keys()].sort(compareCodeUnits)) {
    const list = byKey.get(key)!.sort((a, b) => compareCodeUnits(a.unit.id, b.unit.id));
    for (let i = 0; i < list.length; i += maxSize) groups.push({ groupKey: key, items: list.slice(i, i + maxSize) });
  }
  return groups;
}
