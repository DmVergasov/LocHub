import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CellStatus } from '../api/types';
import type { EditorBridge } from '../bridge';
import { PathFilter } from '../common/PathFilter';
import { assetPathEntries, facets, filterRows, statusChip, type BandFilter, type GridFilters, type GridRow } from './model';
import { KeyDetails } from './KeyDetails';

// The query that drives filtering follows `value` after `delayMs` of no further change; the initial value is
// adopted immediately (no delay on first render), so a caller that renders with a `q` already set (e.g. a test)
// sees filtered results right away. Keeps the search box itself instant while the debounced value it returns —
// and, through it, filterRows below — only updates 150 ms after the user stops typing.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const SEARCH_DEBOUNCE_MS = 150;

export const GRID_ROW_HEIGHT = 36;

// The sticky header now lives inside the same scroller as the virtualized body (see styles.css), so its flow
// height is reserved from the virtualizer via `scrollMargin`, keeping item positions aligned to .grid-scroll's
// own coordinate space. jsdom has no real layout, so this is a fixed approximation, not a live measurement.
// Kept equal to .grid-header's CSS `height` in styles.css: change one, change the other.
const GRID_HEADER_HEIGHT = 36;

const STATUSES: CellStatus[] = ['empty', 'ai_draft', 'needs_fix', 'approved', 'edited', 'human_edit', 'rejected'];
// Same wording as statusChip() (src/grid/model.ts) so a cell's status reads the same in the badge and in this
// filter; the option `value` stays the raw CellStatus so filtering (and existing tests) are unaffected.
const STATUS_LABEL: Record<CellStatus, string> = {
  empty: 'Untranslated',
  ai_draft: 'Draft',
  needs_fix: 'Needs fix',
  approved: 'Approved',
  edited: 'Edited',
  human_edit: 'Human',
  rejected: 'Rejected',
};
const BANDS: { value: BandFilter; label: string }[] = [
  { value: '', label: 'Any band' },
  { value: 'R', label: 'Red' },
  { value: 'Y', label: 'Yellow' },
  { value: 'G', label: 'Green' },
  { value: 'none', label: 'No band' },
];

// Toolbar pill wrapper for a Status/Band/Namespace/Asset select: adds an accent-soft "active" look and a small ×
// button when the filter holds a non-default value. `label` names the filter for the button's aria-label and for
// nothing else, so it can differ from the wrapped control's own aria-label only in wording, never in meaning.
function FilterPill({ label, active, onClear, children }: { label: string; active: boolean; onClear: () => void; children: ReactNode }) {
  return (
    <span className={`filter-pill${active ? ' active' : ''}`}>
      {children}
      {active && (
        <button type="button" className="filter-clear" aria-label={`Clear ${label}`} onClick={onClear}>
          ×
        </button>
      )}
    </span>
  );
}

export interface GridViewProps {
  rows: readonly GridRow[];
  // Every culture the project is set up for (Columns picker offers one checkbox per entry here).
  cultures: readonly string[];
  // The subset of `cultures` whose column actually renders; see grid/columns.ts.
  visible: readonly string[];
  onVisible: (list: string[]) => void;
  culture: string;
  nativeCulture: string;
  filters: GridFilters;
  onFilters: (filters: GridFilters) => void;
  onOpenCell: (culture: string, unitId: string) => void;
  onApplyLive: () => void;
  canApplyLive: boolean;
  bridge: EditorBridge;
  editorConnected: boolean;
  // Owned by App and NOT React state, so writing it on every scroll event never re-renders the app; it survives
  // a GridView remount (card view, other tabs) and is restored on the next mount.
  scrollMemory: { top: number; left: number };
  // Which of `visible` have actually finished loading (useGridData's own field); a column not yet in this list
  // shows a loading state instead of blank cells. Required so every caller states its intent explicitly — an
  // omitted value used to default to "every visible column already loaded", which silently hid a caller that
  // forgot to wire it up.
  loadedCultures: readonly string[];
  // Whether a fetch for one of `loadedCultures`' missing entries is still in flight (useGridData's own field): a
  // column absent from `loadedCultures` only shows "Loading…" while this is true. Once it settles false, a still
  // absent column's fetch failed rather than being slow, and showing "Loading…" forever would hide that — it
  // falls back to the same blank/empty rendering as a loaded column with no cell for that culture, next to
  // whatever error banner the caller shows for `error`. Required for the same reason as `loadedCultures` above: an
  // omitted value used to default to true (assume still in flight, never "failed"), which brought back
  // "Loading…" forever for any caller that forgot to pass it.
  loading: boolean;
}

interface OpenKeyDetails {
  unitId: string;
  anchor: DOMRect;
}

// Key stays a fixed pixel width: the sticky Key/Source columns need a fixed `left` to stick at, and only Key has
// to be fixed for Source's `left: KEY_COL_WIDTH` to be right. Source and each visible culture are `minmax(...)`
// tracks that grow with the window (styles.css gives header/body/rows `width: 100%`); the horizontal scroller
// only kicks in once every track has hit its floor.
const KEY_COL_WIDTH = 200;
const SOURCE_MIN = 280;
const CULTURE_MIN = 260;
const GRID_GAP = 4; // matches `.grid-header, .grid-row { gap: 4px; }` in styles.css

function ColumnsPicker({
  cultures,
  visible,
  active,
  onVisible,
}: {
  cultures: readonly string[];
  visible: readonly string[];
  active: string;
  onVisible: (list: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Same pattern as KeyDetails.tsx: Escape and an outside pointerdown close the popover, but a pointerdown on the
  // toggle button itself is left to that button's own onClick, so open/close does not race itself.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.columns-toggle')) return;
      close(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  const toggle = (code: string, checked: boolean) => {
    if (code === active) return; // the active culture's checkbox is disabled; guard in case it still fires
    const next = new Set(visible);
    if (checked) next.add(code);
    else next.delete(code);
    next.add(active);
    onVisible(cultures.filter((c) => next.has(c)));
  };

  return (
    <div className="columns-picker">
      <button
        type="button"
        className="columns-toggle"
        ref={buttonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Columns{visible.length > 1 ? ` (${visible.length})` : ''}
      </button>
      {open && (
        <div ref={popoverRef} className="columns-popover" role="dialog" aria-label="Columns">
          {cultures.map((code) => {
            const isActive = code === active;
            const checked = isActive || visible.includes(code);
            return (
              <label key={code}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isActive}
                  title={isActive ? 'The active culture is always shown' : undefined}
                  onChange={(e) => toggle(code, e.target.checked)}
                />
                {code}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GridView({
  rows,
  cultures,
  visible,
  onVisible,
  culture,
  nativeCulture,
  filters,
  onFilters,
  onOpenCell,
  onApplyLive,
  canApplyLive,
  bridge,
  editorConnected,
  scrollMemory,
  loadedCultures,
  loading,
}: GridViewProps) {
  const isLoaded = (c: string) => loadedCultures.includes(c);
  // A culture absent from `loadedCultures` while a fetch is still in flight is loading; once that fetch settles
  // and the culture is still absent, its fetch failed rather than being slow.
  const isFailed = (c: string) => !isLoaded(c) && !loading;
  const cultureLoaded = isLoaded(culture);
  const debouncedQuery = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  // Memoized on the individual filter fields (plus the debounced query), not on `filters` itself: `filters` is a
  // new object from the parent on every keystroke (App's setFilters), including keystrokes in the search box
  // that the debounce is supposed to absorb — memoizing on that object identity would recompute filterRows on
  // every one of those keystrokes anyway, defeating the debounce entirely. Built field by field, not by spreading
  // `filters`, so a new `GridFilters` field is a compile error here (missing from the object literal) until it is
  // also added to the deps list above.
  const filtered = useMemo(
    () =>
      filterRows(rows, culture, {
        q: debouncedQuery,
        status: filters.status,
        band: filters.band,
        outdated: filters.outdated,
        namespace: filters.namespace,
        asset: filters.asset,
      }),
    [rows, culture, filters.status, filters.band, filters.outdated, filters.namespace, filters.asset, debouncedQuery],
  );
  const { namespaces } = useMemo(() => facets(rows), [rows]);
  const assetEntries = useMemo(() => assetPathEntries(rows), [rows]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keyButtons = useRef(new Map<string, HTMLButtonElement>());
  const [openKey, setOpenKey] = useState<OpenKeyDetails | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 20,
    scrollMargin: GRID_HEADER_HEIGHT,
    initialOffset: () => scrollMemory.top,
  });

  // Restore the remembered offset on mount (a fresh GridView after a card visit or another tab): the body's
  // height already comes from getTotalSize() on the first render, so the offset is reachable immediately.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = scrollMemory.top;
    el.scrollLeft = scrollMemory.left;
    // Mount-only intentionally: scrollMemory is a stable object owned by App, so this never needs to re-run.
  }, []);

  // Record the live offset on every scroll so it survives this GridView unmounting (card view, another tab).
  // A plain mutation, not React state: recording scroll position must not cause a re-render on every scroll event.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollMemory.top = el.scrollTop;
      scrollMemory.left = el.scrollLeft;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollMemory]);

  const columns = `${KEY_COL_WIDTH}px minmax(${SOURCE_MIN}px, 2fr) ${visible.map(() => `minmax(${CULTURE_MIN}px, 2fr)`).join(' ')}`;
  // The floor below which the horizontal scrollbar must appear: Key + Source's minimum + each visible culture's
  // minimum, plus the same gaps the `gap: 4px` CSS rule renders between every pair of columns.
  const gapCount = visible.length + 1; // Key|Source, Source|first culture, and one between each pair of cultures
  const minWidth = KEY_COL_WIDTH + SOURCE_MIN + visible.length * CULTURE_MIN + gapCount * GRID_GAP;
  const sourceLeft = KEY_COL_WIDTH;
  const set = (patch: Partial<GridFilters>) => onFilters({ ...filters, ...patch });

  const toggleKeyDetails = (unitId: string, button: HTMLButtonElement) => {
    setOpenKey((current) => (current?.unitId === unitId ? null : { unitId, anchor: button.getBoundingClientRect() }));
  };

  const closeKeyDetails = useCallback((returnFocus: boolean) => {
    setOpenKey((current) => {
      if (returnFocus && current) keyButtons.current.get(current.unitId)?.focus();
      return null;
    });
  }, []);

  const handleCloseKeyDetails = useCallback((reason: 'escape' | 'outside') => closeKeyDetails(reason === 'escape'), [closeKeyDetails]);

  // The virtualized rows are absolutely positioned and recycled on scroll, so the popover's anchor rect goes stale
  // the moment the grid scrolls; close it rather than let it float over the wrong row.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !openKey) return;
    const onScroll = () => closeKeyDetails(false);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [openKey, closeKeyDetails]);

  const openUnit = openKey ? rows.find((row) => row.unit.id === openKey.unitId)?.unit : undefined;

  return (
    <div className="grid-view">
      <div className="toolbar">
        <span className="search-wrap">
          <input
            type="search"
            aria-label="Search"
            placeholder="Search key, source or shown translations"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </span>
        <FilterPill label="Status" active={filters.status !== ''} onClear={() => set({ status: '' })}>
          <select aria-label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value as CellStatus | '' })}>
            <option value="">Any status</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </FilterPill>
        <FilterPill label="Band" active={filters.band !== ''} onClear={() => set({ band: '' })}>
          <select aria-label="Band" value={filters.band} onChange={(e) => set({ band: e.target.value as BandFilter })}>
            {BANDS.map((band) => (
              <option key={band.value} value={band.value}>
                {band.label}
              </option>
            ))}
          </select>
        </FilterPill>
        <span className={`filter-pill toggle-chip${filters.outdated ? ' active' : ''}`}>
          <label>
            <input type="checkbox" className="visually-hidden" checked={filters.outdated} onChange={(e) => set({ outdated: e.target.checked })} /> Outdated
          </label>
          {filters.outdated && (
            <button type="button" className="filter-clear" aria-label="Clear Outdated" onClick={() => set({ outdated: false })}>
              ×
            </button>
          )}
        </span>
        <FilterPill label="Namespace" active={filters.namespace !== ''} onClear={() => set({ namespace: '' })}>
          <select aria-label="Namespace" value={filters.namespace} onChange={(e) => set({ namespace: e.target.value })}>
            <option value="">Any namespace</option>
            {namespaces.map((namespace) => (
              <option key={namespace} value={namespace}>
                {namespace || '(empty)'}
              </option>
            ))}
          </select>
        </FilterPill>
        <PathFilter value={filters.asset} onChange={(value) => set({ asset: value })} entries={assetEntries} ariaLabel="Asset" placeholder="Any asset or file" />
        <span className="count">
          {cultureLoaded ? `${filtered.length} of ${rows.length} strings` : isFailed(culture) ? '' : 'Loading…'}
        </span>
        <button type="button" onClick={onApplyLive} disabled={!canApplyLive} title="Show every translation of this culture in the editor without a Pull">
          Apply {culture} live
        </button>
        <ColumnsPicker cultures={cultures} visible={visible} active={culture} onVisible={onVisible} />
      </div>
      <div ref={scrollRef} className="grid-scroll">
        <div className="grid-header" style={{ gridTemplateColumns: columns, minWidth }}>
          <span className="sticky-col" style={{ left: 0 }}>
            Key
          </span>
          <span className="sticky-col" style={{ left: sourceLeft }}>
            Source ({nativeCulture || 'native'})
          </span>
          {visible.map((c) => (
            <span key={c} className={c === culture ? 'focus' : undefined}>
              {c}
            </span>
          ))}
        </div>
        <div className="grid-body" style={{ height: virtualizer.getTotalSize(), minWidth }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = filtered[item.index];
            if (!row) return null;
            // The virtualizer's scrollMargin (the sticky header's reserved flow height) is baked into item.start
            // so ranges line up with the shared scroller's coordinate space; subtract it back out here since
            // .grid-body itself already sits below the header in normal flow (tanstack/react-virtual docs).
            const top = item.start - virtualizer.options.scrollMargin;
            return (
              <div
                key={row.unit.id}
                className="grid-row"
                style={{ height: item.size, transform: `translateY(${top}px)`, gridTemplateColumns: columns }}
              >
                <button
                  type="button"
                  className="key ellipsis sticky-col"
                  style={{ left: 0 }}
                  ref={(el) => {
                    if (el) keyButtons.current.set(row.unit.id, el);
                    else keyButtons.current.delete(row.unit.id);
                  }}
                  title={`${row.unit.namespace} / ${row.unit.key}`}
                  aria-haspopup="dialog"
                  aria-expanded={openKey?.unitId === row.unit.id}
                  onClick={(e) => toggleKeyDetails(row.unit.id, e.currentTarget)}
                >
                  {row.unit.key}
                </button>
                <span className="source sticky-col" style={{ left: sourceLeft }} title={row.unit.source}>
                  {row.unit.source}
                </span>
                {visible.map((c) => {
                  const loaded = isLoaded(c);
                  // A still-failed (settled, never loaded) column renders the same blank cell as a loaded column
                  // with nothing in it, next to whatever error banner the caller shows — only an in-flight fetch
                  // shows "Loading…", so a failed one does not show that forever.
                  const failed = !loaded && isFailed(c);
                  const gridCell = loaded ? row.cells[c] : undefined;
                  const chip = statusChip(gridCell);
                  return (
                    <button key={c} type="button" className="cell" title={loaded || failed ? (gridCell?.cell.status ?? 'empty') : 'Loading…'} onClick={() => onOpenCell(c, row.unit.id)}>
                      {!loaded && !failed ? (
                        <span className="cell-text muted">Loading…</span>
                      ) : chip ? (
                        <>
                          <span className="cell-text">{gridCell?.cell.text ?? ''}</span>
                          <span className={`status-chip ${chip.tone}`}>{chip.label}</span>
                        </>
                      ) : (
                        <span className="cell-text muted">{gridCell?.cell.text || '—'}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {openKey && openUnit && (
        <KeyDetails
          key={openKey.unitId}
          unit={openUnit}
          bridge={bridge}
          editorConnected={editorConnected}
          anchor={openKey.anchor}
          onClose={handleCloseKeyDetails}
        />
      )}
    </div>
  );
}
