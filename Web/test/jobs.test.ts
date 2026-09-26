import { describe, expect, it } from 'vitest';
import type { GridRow } from '../src/grid/model';
import { canRun, formatUsd, groupPathEntries, suggestMaxUsd } from '../src/jobs/jobs';
import { makeCell, makeUnit } from './fakeApi';

const estimate = { requests: 1, items: 2, inputTokens: 1000, outputTokens: 200, usd: 0.5 };

describe('job budget helpers', () => {
  it('runs only when MaxUSD covers the estimate', () => {
    expect(canRun(estimate, '0.5')).toBe(true);
    expect(canRun(estimate, '0.49')).toBe(false);
    expect(canRun(estimate, '')).toBe(false);
    expect(canRun(estimate, 'abc')).toBe(false);
    expect(canRun(undefined, '10')).toBe(false);
  });

  it('a $0 estimate can always run, with or without a Max USD typed in', () => {
    const free = { ...estimate, usd: 0 };
    expect(canRun(free, '')).toBe(true);
    expect(canRun(free, 'abc')).toBe(true);
    expect(canRun(free, '0')).toBe(true);
  });

  it('suggests 20% headroom rounded up to cents', () => {
    expect(suggestMaxUsd(0.5)).toBe('0.60');
    expect(suggestMaxUsd(0.011)).toBe('0.02');
    expect(suggestMaxUsd(0)).toBe('0.00');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

function row(key: string, groupKey: string, status: GridRow['cells'][string]['cell']['status'], outdated = false): GridRow {
  const unit = makeUnit(key, `${key} source`, { groupKey });
  return { unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { status }), outdated } } };
}

describe('groupPathEntries (mirrors the service\'s needsWork)', () => {
  it('counts empty, rejected and needs_fix cells as work, and excludes a done cell that is not outdated', () => {
    const rows = [
      row('A', 'Pause', 'empty'),
      row('B', 'Pause', 'rejected'),
      row('C', 'Pause', 'needs_fix'),
      row('D', 'Pause', 'approved'), // done and current: excluded
    ];
    expect(groupPathEntries(rows, 'ru')).toEqual([{ path: 'Pause', count: 3 }]);
  });

  it('counts an outdated cell as work even when its status looks done', () => {
    const rows = [
      row('A', 'Pause', 'approved', true), // outdated: still counted, unlike the old done-status exclusion
      row('B', 'Pause', 'edited', false), // done and current: excluded
    ];
    expect(groupPathEntries(rows, 'ru')).toEqual([{ path: 'Pause', count: 1 }]);
  });

  it('does not count an ai_draft cell that is not outdated (nothing a job would rewrite)', () => {
    const rows = [row('A', 'Pause', 'ai_draft', false)];
    expect(groupPathEntries(rows, 'ru')).toEqual([]);
  });
});
