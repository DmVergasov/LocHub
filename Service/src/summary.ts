import { isOutdated, type Culture } from './contract.js';
import type { LocHubStore } from './store.js';

export interface CultureSummary {
  culture: Culture;
  total: number;
  byStatus: Record<string, number>;
  byBand: { R: number; Y: number; G: number };
  outdated: number;
  openQuestions: number;
  // Blind audit: the share of sampled green cells a human corrected is the triage miss rate.
  audit: { sampled: number; corrected: number };
}

const CORRECTED: ReadonlySet<string> = new Set(['edited', 'rejected', 'human_edit']);

export function summarize(store: LocHubStore, culture: Culture): CultureSummary {
  const summary: CultureSummary = {
    culture,
    total: 0,
    byStatus: {},
    byBand: { R: 0, Y: 0, G: 0 },
    outdated: 0,
    openQuestions: 0,
    audit: { sampled: 0, corrected: 0 },
  };
  for (const unit of store.units.values()) {
    if (unit.state !== 'active') continue;
    const cell = store.getCell(culture, unit.id);
    summary.total++;
    summary.byStatus[cell.status] = (summary.byStatus[cell.status] ?? 0) + 1;
    if (cell.band === 'R' || cell.band === 'Y' || cell.band === 'G') summary.byBand[cell.band]++;
    if (isOutdated(unit, cell)) summary.outdated++;
    if (cell.qaFlags.includes('audit')) {
      summary.audit.sampled++;
      if (CORRECTED.has(cell.status)) summary.audit.corrected++;
    }
  }
  for (const item of store.inbox.values()) if (item.culture === culture && item.status === 'open') summary.openQuestions++;
  return summary;
}
