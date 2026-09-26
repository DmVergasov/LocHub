import type { PathEntry } from '../common/PathFilter';
import type { JobEstimate } from '../api/types';
import type { GridRow } from '../grid/model';

// Group keys of the loaded rows still needing translation for the given culture (path/folder filter):
// mirrors the service's own needsWork (Service/src/grouping.ts) using the row's already-computed GridCell.outdated
// instead of recomputing it, so the count the Group PathFilter shows matches what a job would actually translate
// — including a cell whose status looks done (approved/edited/human_edit) but is outdated because the source
// text moved, which needsWork still counts as work.
export function groupPathEntries(rows: readonly GridRow[], culture: string): PathEntry[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const groupKey = row.unit.groupKey;
    if (!groupKey) continue;
    const gridCell = row.cells[culture];
    const status = gridCell?.cell.status ?? 'empty';
    const needsWork = status === 'empty' || status === 'rejected' || status === 'needs_fix' || (gridCell?.outdated ?? false);
    if (!needsWork) continue;
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}

// The service refuses a job whose estimate is above MaxUSD (422 "budget"); the button mirrors that rule. A $0
// estimate (every string reuses translation memory or a cached answer, no model call) never needs a Max USD to
// run, whatever was typed into that field. Otherwise, called only for a numeric usd — a null usd (subscription,
// or an unpriced model) has no Max USD field to check.
export function canRun(estimate: JobEstimate | undefined, maxUsd: string): boolean {
  if (!estimate || typeof estimate.usd !== 'number') return false;
  if (estimate.usd === 0) return true;
  const limit = Number(maxUsd);
  return maxUsd.trim() !== '' && Number.isFinite(limit) && limit >= estimate.usd;
}

// 20% headroom over the estimate, rounded up to whole cents (the epsilon absorbs float noise such as 0.5 * 120).
export function suggestMaxUsd(usd: number): string {
  return (Math.ceil(usd * 120 - 1e-9) / 100).toFixed(2);
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
