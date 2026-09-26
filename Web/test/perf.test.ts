import { describe, expect, it } from 'vitest';
import { buildFolderTotals, pathSuggestions } from '../src/common/PathFilter';
import { assetPathEntries, filterRows, mergeCulture, NO_FILTERS, sortRows, type GridData, type GridRow } from '../src/grid/model';
import { makeCell, makeUnit } from './fakeApi';

// Performance guard: 50,000 rows x 10 loaded cultures, realistic text lengths (key 32 hex, source ~60 chars,
// translations ~70 chars), built through the same row-building code the app uses (mergeCulture + sortRows).
const ROW_COUNT = 50_000;
const CULTURES = Array.from({ length: 10 }, (_, i) => `c${i}`);
const BUILD_BUDGET_MS = 1500;
// The guard catches order-of-magnitude regressions (lower-casing every culture per keystroke measured ~10x slower),
// not machine load: at 16 ms the median failed intermittently while a translation job shared the CPU. With the
// 150 ms search debounce, 50 ms still keeps typing responsive.
const FILTER_BUDGET_MS = 50;

function hex(n: number, len: number): string {
  return n.toString(16).padStart(len, '0');
}

// A fixed-length filler so every row's text has a realistic, consistent size regardless of the index it embeds.
function padded(prefix: string, len: number): string {
  return prefix.length >= len ? prefix.slice(0, len) : prefix + '.'.repeat(len - prefix.length);
}

function syntheticUnits(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeUnit(hex(i, 32), padded(`Source text for string number ${i} shown in a UI panel`, 60), {
      groupKey: `/Game/MyGame/Content/Path${i % 500}/Group${i % 200}`,
      origin: `/Game/MyGame/Content/Path${i % 500}/Asset_${i}.Asset_${i}:Text`,
    }),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Shared timing harness for every guard below: warms the JIT up with a few untimed calls (so the first, slowest
// call of a run never lands in a sample), then takes the median of many timed calls so a single slow tick (a GC
// pause, a sibling process briefly stealing the CPU) cannot flip a guard on a loaded machine. `onSample`, when
// given, runs after each timed call (outside the timed window) to assert the call actually did its job every time,
// not only once.
const WARMUP_RUNS = 3;
const SAMPLE_RUNS = 15;
// A call that itself takes about a second (building every row of every culture) needs far fewer runs: fifteen of
// them would stretch this file to a quarter of a minute, and the 2x hard limit already absorbs a noisy sample.
const SLOW_CALL_RUNS = { warmup: 1, samples: 3 };

function timedMedian<T>(fn: () => T, onSample?: (result: T) => void, runs = { warmup: WARMUP_RUNS, samples: SAMPLE_RUNS }): number {
  for (let i = 0; i < runs.warmup; i++) fn();
  const timings: number[] = [];
  for (let i = 0; i < runs.samples; i++) {
    const start = performance.now();
    const result = fn();
    timings.push(performance.now() - start);
    onSample?.(result);
  }
  return median(timings);
}

// A guard only hard-fails past HARD_FAIL_MULTIPLIER x its budget — the real limit its test title states — and
// logs a NOTE once it is past the budget itself but still under that hard limit. A loaded machine (another build,
// another test file's GC) pushes the median up without the algorithm itself regressing; the hard limit exists to
// catch an actual order-of-magnitude regression, not to make the suite flaky under load.
const HARD_FAIL_MULTIPLIER = 2;

function assertBudget(actualMs: number, budgetMs: number, label: string): void {
  const hardLimitMs = budgetMs * HARD_FAIL_MULTIPLIER;
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}: ${actualMs.toFixed(2)} ms`);
  if (actualMs > budgetMs) {
    // eslint-disable-next-line no-console
    console.log(`[perf] NOTE: ${label} is ${actualMs.toFixed(2)} ms, above its ${budgetMs} ms budget but within the ${hardLimitMs} ms hard limit`);
  }
  expect(actualMs).toBeLessThanOrEqual(hardLimitMs);
}

describe('perf: row building and filterRows at scale', () => {
  it(
    `builds ${ROW_COUNT} rows x ${CULTURES.length} cultures within ${BUILD_BUDGET_MS * HARD_FAIL_MULTIPLIER}ms (budget ${BUILD_BUDGET_MS}ms), and filters them with a median under ${FILTER_BUDGET_MS * HARD_FAIL_MULTIPLIER}ms (budget ${FILTER_BUDGET_MS}ms)`,
    () => {
      const units = syntheticUnits(ROW_COUNT);

      let gridRows: readonly GridRow[] = [];
      const buildMs = timedMedian(
        () => {
          let data: GridData = new Map();
          for (const culture of CULTURES) {
            const rows = units.map((unit) => ({
              unit,
              cell: makeCell(unit.id, culture, { text: padded(`Translated string ${unit.key} into ${culture} with realistic length`, 70), status: 'ai_draft' as const }),
              outdated: false,
            }));
            data = mergeCulture(data, culture, rows);
          }
          gridRows = sortRows(data);
          return gridRows;
        },
        (rows) => expect(rows).toHaveLength(ROW_COUNT),
        SLOW_CALL_RUNS,
      );
      assertBudget(buildMs, BUILD_BUDGET_MS, `build ${ROW_COUNT} rows x ${CULTURES.length} cultures`);

      const needle = 'e42'; // a 3-letter needle that hits a realistic subset via the synthetic text/paths above
      const filterMs = timedMedian(
        () => filterRows(gridRows, CULTURES[0]!, { ...NO_FILTERS, q: needle }),
        (result) => expect(result.length).toBeGreaterThan(0), // sanity: the needle actually matches something real
      );
      assertBudget(filterMs, FILTER_BUDGET_MS, `filterRows median (needle="${needle}")`);
    },
    30_000,
  );
});

// PathFilter suggestion perf guard: a folder suggestion's count used to be an `entries.filter(...).reduce(...)`
// scan per matching folder, which is O(folders × entries) — measured at ~2.2s over the same 50k-row shape below.
const PATH_SUGGESTIONS_BUDGET_MS = 50;
// buildFolderTotals itself is a per-data-load cost (built once per `entries`, cached across keystrokes by
// PathFilter's own lazy cache), not a per-keystroke one, but it must still have its own budget: a build with no
// budget at all would silently regress right alongside the per-keystroke cost this file guards.
const FOLDER_TOTALS_BUILD_BUDGET_MS = 100;

describe('perf: PathFilter suggestions at scale', () => {
  it(
    `builds folder totals within ${FOLDER_TOTALS_BUILD_BUDGET_MS * HARD_FAIL_MULTIPLIER}ms (budget ${FOLDER_TOTALS_BUILD_BUDGET_MS}ms) and suggests over ${ROW_COUNT} asset paths with a median under ${PATH_SUGGESTIONS_BUDGET_MS * HARD_FAIL_MULTIPLIER}ms (budget ${PATH_SUGGESTIONS_BUDGET_MS}ms)`,
    () => {
      const units = syntheticUnits(ROW_COUNT);
      const rows = units.map((unit) => ({
        unit,
        cell: makeCell(unit.id, 'ru', { text: padded(`Translated string ${unit.key}`, 70), status: 'ai_draft' as const }),
        outdated: false,
      }));
      const data = mergeCulture(new Map(), 'ru', rows);
      const gridRows = sortRows(data);
      const entries = assetPathEntries(gridRows);
      expect(entries.length).toBeGreaterThan(0);

      // Only the per-keystroke pathSuggestions call below is timed against PATH_SUGGESTIONS_BUDGET_MS; the
      // one-time totals-map build gets its own separate budget instead.
      let folderTotals = new Map<string, number>();
      const totalsBuildMs = timedMedian(() => {
        folderTotals = buildFolderTotals(entries);
        return folderTotals;
      });
      assertBudget(totalsBuildMs, FOLDER_TOTALS_BUILD_BUDGET_MS, `buildFolderTotals over ${entries.length} entries`);

      const needle = 'a';
      const suggestionsMs = timedMedian(
        () => pathSuggestions(entries, needle, folderTotals),
        (result) => expect(result.length).toBeGreaterThan(0),
      );
      assertBudget(suggestionsMs, PATH_SUGGESTIONS_BUDGET_MS, `pathSuggestions over ${entries.length} asset paths (needle="${needle}")`);
    },
    30_000,
  );
});
