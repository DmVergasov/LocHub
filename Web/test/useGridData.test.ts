import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocHubApi, type FetchLike } from '../src/api/client';
import { useGridData } from '../src/grid/useGridData';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

describe('useGridData', () => {
  it('ignores stale responses when two reloads happen in flight', async () => {
    const unit1 = makeUnit('Key1', 'Source 1');
    const unit2 = makeUnit('Key2', 'Source 2');

    // Create two deferred responses so we can control resolution order
    let resolveFirst: (response: Response) => void = () => {};
    let resolveSecond: (response: Response) => void = () => {};

    const firstPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPromise = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });

    let callCount = 0;
    const delayedFetch: FetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        // First call: resolves later
        return firstPromise;
      } else {
        // Second call: resolves immediately
        return secondPromise;
      }
    };

    const api = new LocHubApi('', delayedFetch);
    const { result } = renderHook(() => useGridData(api, ['en']));

    // Initial render triggers first reload
    expect(result.current.loading).toBe(true);

    // Trigger second reload while first is still in flight
    void result.current.reload();

    // Now resolve the second call first (simulating faster response)
    resolveSecond({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ total: 1, rows: [{ unit: unit2, cell: makeCell(unit2.id, 'en'), outdated: false }] }),
    } as unknown as Response);

    await new Promise((resolve) => setTimeout(resolve, 5));

    // Now resolve the first call (slower response)
    resolveFirst({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ total: 1, rows: [{ unit: unit1, cell: makeCell(unit1.id, 'en'), outdated: false }] }),
    } as unknown as Response);

    // Wait for the state to settle
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // The final data should be from the second request (Key2), not the first (Key1)
    expect(result.current.rows.length).toBe(1);
    expect(result.current.rows[0]?.unit.key).toBe('Key2');
  });

  it('filters active units in rowsFromState', async () => {
    const fake = createFakeApi({
      units: [
        makeUnit('Active1', 'source1', { state: 'active' }),
        makeUnit('Tombstoned1', 'source2', { state: 'tombstone' }),
      ],
    });
    const api = new LocHubApi('', fake.fetch);
    const { result } = renderHook(() => useGridData(api, ['en']));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]?.unit.key).toBe('Active1');
  });

  describe('per-culture cache', () => {
    function seededApi() {
      const unit = makeUnit('K', 'Source');
      const fake = createFakeApi({
        units: [unit],
        cells: {
          ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'RU1' }) },
          de: { [unit.id]: makeCell(unit.id, 'de', { text: 'DE1' }) },
        },
      });
      return { unit, fake, api: new LocHubApi('', fake.fetch) };
    }

    it('loads only the given cultures on mount, not every project culture', async () => {
      const { unit, fake, api } = seededApi();
      const { result } = renderHook(() => useGridData(api, ['ru']));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(fake.calls.some((c) => c.includes('culture=ru'))).toBe(true);
      expect(fake.calls.some((c) => c.includes('culture=de'))).toBe(false);
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1');
      expect(result.current.rows[0]!.cells.de).toBeUndefined();
      void unit;
    });

    it('loadedCultures stays empty while the initial fetch is in flight, then reports the culture once it resolves', async () => {
      let resolveFetch: (r: Response) => void = () => {};
      const delayedFetch: FetchLike = () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
      const api = new LocHubApi('', delayedFetch);
      const { result } = renderHook(() => useGridData(api, ['ru']));

      expect(result.current.loading).toBe(true);
      expect(result.current.loadedCultures).toEqual([]);

      const unit = makeUnit('K', 'Source');
      resolveFetch({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ total: 1, rows: [{ unit, cell: makeCell(unit.id, 'ru', { text: 'RU1' }), outdated: false }] }),
      } as unknown as Response);

      await waitFor(() => expect(result.current.loadedCultures).toEqual(['ru']));
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1');
    });

    it('loadedCultures excludes a newly-added culture until its own fetch resolves, leaving the already-loaded one visible meanwhile', async () => {
      const { unit, fake, api } = seededApi();
      const { result, rerender } = renderHook(
        ({ api, cultures }: { api: LocHubApi; cultures: string[] }) => useGridData(api, cultures),
        { initialProps: { api, cultures: ['ru'] } },
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.loadedCultures).toEqual(['ru']);

      let resolveDe: (r: Response) => void = () => {};
      const deferredFetch: FetchLike = (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://lochub.test');
        if (url.searchParams.get('culture') === 'de') return new Promise<Response>((resolve) => (resolveDe = resolve));
        return fake.fetch(input, init);
      };
      const deferredApi = new LocHubApi('', deferredFetch);

      rerender({ api: deferredApi, cultures: ['ru', 'de'] });
      await waitFor(() => expect(result.current.loading).toBe(true));
      expect(result.current.loadedCultures).toEqual(['ru']); // 'de' requested but not answered yet
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1'); // the loaded column is unaffected meanwhile

      resolveDe({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ total: 1, rows: [{ unit, cell: makeCell(unit.id, 'de', { text: 'DE1' }), outdated: false }] }),
      } as unknown as Response);

      await waitFor(() => expect(result.current.loadedCultures.slice().sort()).toEqual(['de', 'ru']));
      expect(result.current.rows[0]!.cells.de?.cell.text).toBe('DE1');
    });

    it('adding a culture fetches only the new one, without refetching the already-loaded culture', async () => {
      const { fake, api } = seededApi();
      const { result, rerender } = renderHook(({ cultures }: { cultures: string[] }) => useGridData(api, cultures), {
        initialProps: { cultures: ['ru'] },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      const callsAfterFirstLoad = fake.calls.length;

      rerender({ cultures: ['ru', 'de'] });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const newCalls = fake.calls.slice(callsAfterFirstLoad);
      expect(newCalls.length).toBeGreaterThan(0);
      expect(newCalls.every((c) => c.includes('culture=de'))).toBe(true); // no fresh 'ru' request
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1');
      expect(result.current.rows[0]!.cells.de?.cell.text).toBe('DE1');
    });

    it('removing a culture drops its cells from the rows without any new fetch', async () => {
      const { fake, api } = seededApi();
      const { result, rerender } = renderHook(({ cultures }: { cultures: string[] }) => useGridData(api, cultures), {
        initialProps: { cultures: ['ru', 'de'] },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows[0]!.cells.de).toBeTruthy();
      const callsBeforeDrop = fake.calls.length;

      rerender({ cultures: ['ru'] });
      await waitFor(() => expect(result.current.rows[0]!.cells.de).toBeUndefined());
      expect(fake.calls.length).toBe(callsBeforeDrop); // pure removal: no network call
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1');
    });

    it('reload() refetches every currently loaded culture from scratch', async () => {
      const { unit, fake, api } = seededApi();
      const { result } = renderHook(() => useGridData(api, ['ru', 'de']));
      await waitFor(() => expect(result.current.loading).toBe(false));
      const cellCallsBefore = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;

      fake.state.cells.ru = { ...fake.state.cells.ru, [unit.id]: makeCell(unit.id, 'ru', { text: 'RU2' }) };
      await act(async () => {
        await result.current.reload();
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const cellCallsAfter = fake.calls.filter((c) => c.startsWith('GET /api/cells')).length;
      expect(cellCallsAfter).toBeGreaterThan(cellCallsBefore); // both cultures refetched
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU2');
      expect(result.current.rows[0]!.cells.de?.cell.text).toBe('DE1');
    });

    // reload() used to fetch its cultures one after another (`for (const culture of list) await
    // api.allCells(culture)`). Proven here by swapping in a fetch that never resolves until the test tells it
    // to: under the old sequential code, the second culture's request would never be issued while the first is
    // still pending, so `requested` would get stuck at length 1.
    it('reload() fetches all cultures in parallel, not one after another', async () => {
      const { fake, api } = seededApi();
      const { result, rerender } = renderHook(({ api }: { api: LocHubApi }) => useGridData(api, ['ru', 'de']), { initialProps: { api } });
      await waitFor(() => expect(result.current.loading).toBe(false));

      const requested: string[] = [];
      const resolvers = new Map<string, (r: Response) => void>();
      const deferredFetch: FetchLike = (input: string) => {
        const url = new URL(input, 'http://lochub.test');
        const culture = url.searchParams.get('culture')!;
        requested.push(culture);
        return new Promise<Response>((resolve) => resolvers.set(culture, resolve));
      };
      const deferredApi = new LocHubApi('', deferredFetch);
      rerender({ api: deferredApi });

      act(() => {
        void result.current.reload();
      });
      // Both cultures' requests must be in flight before either resolves, proving they were not awaited in turn.
      await waitFor(() => expect(requested).toHaveLength(2));
      expect(requested.sort()).toEqual(['de', 'ru']);

      resolvers.get('ru')!({ ok: true, status: 200, text: async () => JSON.stringify({ total: 0, rows: [] }) } as unknown as Response);
      resolvers.get('de')!({ ok: true, status: 200, text: async () => JSON.stringify({ total: 0, rows: [] }) } as unknown as Response);
      await waitFor(() => expect(result.current.loading).toBe(false));
    });
  });

  // reload() and the per-culture effect used to share requestRef with no coordination — a
  // culture-set change while reload() was still in flight invalidated the reload via requestRef, and the
  // effect's own incremental fetch (of only the newly-added culture) then merged onto the PRE-reload `data`
  // (the reload's own result was discarded as stale, so it never landed). The already-visible culture kept
  // showing stale text even though a fresh reload had been requested for it.
  describe('reload vs. culture-set change race', () => {
    it('a culture-set change while a reload is in flight ends in fresh data for every visible culture', async () => {
      const unit = makeUnit('K', 'Source');
      const fake = createFakeApi({
        units: [unit],
        cells: {
          ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'RU1' }) },
          de: { [unit.id]: makeCell(unit.id, 'de', { text: 'DE1' }) },
        },
      });
      const api = new LocHubApi('', fake.fetch);
      const { result, rerender } = renderHook(({ cultures }: { cultures: string[] }) => useGridData(api, cultures), {
        initialProps: { cultures: ['ru'] },
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU1');

      // The fake now answers 'ru' with new text, as if an edit landed while the in-flight reload below was
      // still fetching the OLD text.
      fake.state.cells.ru = { ...fake.state.cells.ru, [unit.id]: makeCell(unit.id, 'ru', { text: 'RU2' }) };

      let reloadPromise!: Promise<void>;
      act(() => {
        reloadPromise = result.current.reload();
      });
      // Add a column ('de') while that reload is still in flight.
      rerender({ cultures: ['ru', 'de'] });

      await act(async () => {
        await reloadPromise;
      });
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.rows[0]!.cells.ru?.cell.text).toBe('RU2'); // fresh text for the already-visible culture
      expect(result.current.rows[0]!.cells.de?.cell.text).toBe('DE1'); // and the newly-visible one
    });
  });
});
