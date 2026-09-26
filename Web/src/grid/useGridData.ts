import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { Cell, Unit } from '../api/types';
import { errorText } from '../errors';
import { dropCultures, mergeCulture, sortRows, withCell, withUnit, type GridData, type GridRow } from './model';

export interface GridDataState {
  rows: GridRow[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  updateCell: (cell: Cell) => void;
  updateUnit: (unit: Unit) => void;
  // Which of the requested `cultures` have actually finished their first fetch and are merged into `rows`; a
  // culture just added to `cultures` (a new column, or the active culture right after switching to it) is absent
  // here until its own fetch resolves, so a caller can show a loading state for it instead of an empty column.
  loadedCultures: readonly string[];
}

// Loads only the given (visible) cultures' cells into memory (pages of 1000, up to 4 in flight — see
// LocHubApi.allCells): filters and search then run on the client. A per-culture cache keeps already-loaded
// cultures in `data` when `cultures` changes — adding a column fetches only the new culture, removing one drops
// it — instead of refetching everything; `reload()` (Refresh, a job finishing) refetches every currently loaded
// culture from scratch.
export function useGridData(api: LocHubApi, cultures: readonly string[]): GridDataState {
  const [data, setData] = useState<GridData>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  // Cultures currently merged into `data`; reload() refetches exactly this set, and the effect below diffs
  // against it to fetch only newly-visible cultures and drop ones no longer visible. Mirrored into
  // `loadedCultures` state (below) wherever it changes, since the ref alone would not re-render a consumer.
  const loadedRef = useRef<string[]>([]);
  const [loadedCultures, setLoadedCultures] = useState<string[]>([]);
  const setLoaded = useCallback((next: string[]) => {
    loadedRef.current = next;
    setLoadedCultures(next);
  }, []);
  // True for the lifetime of a reload() call still in flight: tells the per-culture effect below that an
  // incremental add/remove is unsafe right now — see its own comment for why — and it must run a full reload
  // of the new set instead.
  const reloadingRef = useRef(false);
  const cultureKey = cultures.join('|');

  // The listed cultures are fetched in parallel (Promise.all), not one after another, then merged back in list
  // order so the result does not depend on which one resolves first.
  const reload = useCallback(async () => {
    const id = ++requestRef.current;
    const list = cultureKey ? cultureKey.split('|') : [];
    reloadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const results = await Promise.all(list.map(async (culture) => ({ culture, rows: await api.allCells(culture) })));
      if (id === requestRef.current) {
        let next: GridData = new Map();
        for (const { culture, rows } of results) next = mergeCulture(next, culture, rows);
        setData(next);
        setLoaded(list);
      }
    } catch (e) {
      if (id === requestRef.current) {
        setError(errorText(e));
      }
    } finally {
      // A mismatch here means a later reload() call (or the effect's fallback below) already took over
      // reloadingRef's ownership; only the request that is still current may clear it.
      if (id === requestRef.current) {
        setLoading(false);
        reloadingRef.current = false;
      }
    }
  }, [api, cultureKey]);

  // Per-culture cache: on mount (loadedRef starts empty, so every initial culture counts as "added") and
  // whenever the visible culture set changes, fetch only the cultures not already loaded and drop the ones no
  // longer visible, rather than refetching everything reload() would.
  useEffect(() => {
    const wanted = cultureKey ? cultureKey.split('|') : [];
    const wantedSet = new Set(wanted);
    const loaded = loadedRef.current;
    const added = wanted.filter((c) => !loaded.includes(c));
    const removed = loaded.filter((c) => !wantedSet.has(c));
    if (added.length === 0 && removed.length === 0) return undefined;

    // A reload() in flight already owns requestRef and will overwrite `data` wholesale once it
    // resolves. Doing an incremental add/remove here instead would either get discarded outright (this effect's
    // own id check below, once reload() itself finishes and bumps requestRef again) or — the actual bug — land
    // on the PRE-reload `data`: reload()'s result gets discarded as stale by the id bump this effect is about to
    // make, so it never applies, and the incremental fetch's `setData(previous => ...)` then merges the newly
    // added culture onto that stale `previous`, leaving every already-visible culture showing pre-reload text.
    // A full reload of the new set (cultureKey has already changed by the time this effect runs) is the simplest
    // rule that is correct either way.
    if (reloadingRef.current) {
      void reload();
      return undefined;
    }

    const id = ++requestRef.current;
    if (removed.length > 0) {
      setData((previous) => dropCultures(previous, removed));
      setLoaded(loadedRef.current.filter((c) => wantedSet.has(c)));
    }
    if (added.length === 0) return undefined;
    setLoading(true);
    setError('');
    let cancelled = false;
    Promise.all(added.map(async (culture) => ({ culture, rows: await api.allCells(culture) })))
      .then((results) => {
        if (cancelled || id !== requestRef.current) return;
        setData((previous) => {
          let next = previous;
          for (const { culture, rows } of results) next = mergeCulture(next, culture, rows);
          return next;
        });
        // Only now counts as loaded: a race with a later culture change that discarded this result (the id
        // check above) must not have this culture look already-loaded to that later diff.
        setLoaded([...loadedRef.current, ...added]);
      })
      .catch((e: unknown) => {
        if (!cancelled && id === requestRef.current) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled && id === requestRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `reload` is included for the reloadingRef branch above; its identity already changes exactly when
    // cultureKey does (reload's own deps are [api, cultureKey]), so this adds no extra runs of this effect.
  }, [api, cultureKey, reload]);

  useEffect(() => {
    return () => {
      ++requestRef.current; // Ignore results after unmount
    };
  }, []);

  const updateCell = useCallback((cell: Cell) => setData((previous) => withCell(previous, cell)), []);
  const updateUnit = useCallback((unit: Unit) => setData((previous) => withUnit(previous, unit)), []);
  const rows = useMemo(() => sortRows(data), [data]);
  return { rows, loading, error, reload, updateCell, updateUnit, loadedCultures };
}
