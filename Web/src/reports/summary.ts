import type { CultureSummary } from '../api/types';

// The share of blind-audit greens a human corrected is the rate at which triage misses problems.
export function missRate(summary: CultureSummary): number | undefined {
  return summary.audit.sampled > 0 ? summary.audit.corrected / summary.audit.sampled : undefined;
}

export function percent(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '0%';
}
