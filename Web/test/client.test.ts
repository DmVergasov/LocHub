import { describe, expect, it } from 'vitest';
import { ApiError, LocHubApi, type FetchLike } from '../src/api/client';
import { errorText } from '../src/errors';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

describe('LocHubApi', () => {
  it('builds encoded query strings, drops empty filters and sends every mutation as JSON', async () => {
    const fake = createFakeApi({ units: [makeUnit('A', 'PAUSED')] });
    const api = new LocHubApi('', fake.fetch);
    await api.cells('ru', { band: 'R', q: 'a b', outdated: true, status: '' });
    await api.edit('pt-BR', 'id-A', 'x');
    // approve has no fields: it still goes out as JSON "{}", or the service would answer 415/400.
    await api.approve('pt-BR', 'id-A');
    expect(fake.calls).toEqual([
      'GET /api/cells?culture=ru&band=R&q=a+b&outdated=1',
      'POST /api/cells/pt-BR/id-A/edit',
      'POST /api/cells/pt-BR/id-A/approve',
    ]);
    // The fake enforces the service's rule, so a client that dropped the JSON body would fail every view test.
    expect((await fake.fetch('/api/cells/ru/id-A/approve', { method: 'POST' })).status).toBe(415);
  });

  it('pages through every row of a culture', async () => {
    const units = Array.from({ length: 2500 }, (_, i) => makeUnit(`K${i}`, `Source ${i}`));
    const fake = createFakeApi({ units });
    const rows = await new LocHubApi('', fake.fetch).allCells('ru');
    expect(rows).toHaveLength(2500);
    expect(fake.calls).toEqual([
      'GET /api/cells?culture=ru&limit=1000&offset=0',
      'GET /api/cells?culture=ru&limit=1000&offset=1000',
      'GET /api/cells?culture=ru&limit=1000&offset=2000',
    ]);
  });

  describe('allCells: concurrency and ordering', () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const rowPage = (offset: number, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const unit = makeUnit(`K${offset + i}`, `Source ${offset + i}`);
        return { unit, cell: makeCell(unit.id, 'ru'), outdated: false };
      });

    // Total 6000 -> first page (offset 0) alone, then 5 remaining pages (1000..5000): with a concurrency cap of
    // 4, the 5th (offset 5000) must not be requested until one of the first 4 remaining pages resolves.
    function deferredFetch(total: number) {
      let inFlight = 0;
      let maxInFlight = 0;
      const pending = new Map<number, (rows: unknown) => void>();
      const requested: number[] = [];
      const fetchImpl: FetchLike = (input: string) => {
        const url = new URL(input, 'http://lochub.test');
        const offset = Number(url.searchParams.get('offset'));
        requested.push(offset);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          pending.set(offset, (rows: unknown) => {
            inFlight--;
            resolve({ ok: true, status: 200, text: async () => JSON.stringify({ total, rows }) } as unknown as Response);
          });
        });
      };
      return { fetchImpl, pending, requested, maxInFlight: () => maxInFlight };
    }

    it('never has more than 4 remaining pages in flight, and preserves offset order under out-of-order completion', async () => {
      const total = 6000;
      const { fetchImpl, pending, requested, maxInFlight } = deferredFetch(total);
      const api = new LocHubApi('', fetchImpl);
      const promise = api.allCells('ru');

      await flush();
      expect(requested).toEqual([0]);
      pending.get(0)!(rowPage(0, 1000));

      await flush();
      // The 4-wide concurrency cap: offsets 1000..4000 are issued, 5000 is withheld.
      expect(requested).toEqual([0, 1000, 2000, 3000, 4000]);
      expect(maxInFlight()).toBeLessThanOrEqual(4);

      // Resolve out of order; each resolution frees a worker to pull the next offset (5000).
      pending.get(3000)!(rowPage(3000, 1000));
      await flush();
      expect(requested).toEqual([0, 1000, 2000, 3000, 4000, 5000]);

      pending.get(5000)!(rowPage(5000, 1000));
      pending.get(1000)!(rowPage(1000, 1000));
      pending.get(4000)!(rowPage(4000, 1000));
      pending.get(2000)!(rowPage(2000, 1000));

      const rows = await promise;
      expect(rows).toHaveLength(6000);
      expect(rows.map((r) => r.unit.key)).toEqual(Array.from({ length: 6000 }, (_, i) => `K${i}`));
      expect(maxInFlight()).toBeLessThanOrEqual(4);
    });

    // A `total` that grows between pages (a unit was added to the culture while allCells was still paging)
    // used to be silently ignored — the offsets to fetch were computed once, from the first page's total. Now
    // it must keep fetching the newly-appeared offsets, in the same ≤4-in-flight batches, until a round reports
    // no further growth.
    it('fetches newly-appeared pages when total grows mid-fetch', async () => {
      let total = 2500;
      const fetchImpl: FetchLike = async (input: string) => {
        const url = new URL(input, 'http://lochub.test');
        const offset = Number(url.searchParams.get('offset'));
        // Discovered while paging the first round (offsets 1000, 2000): the culture grew to 3500 mid-fetch.
        if (offset === 2000) total = 3500;
        const count = Math.max(0, Math.min(1000, total - offset));
        return { ok: true, status: 200, text: async () => JSON.stringify({ total, rows: rowPage(offset, count) }) } as unknown as Response;
      };
      const api = new LocHubApi('', fetchImpl);
      const rows = await api.allCells('ru');
      expect(rows).toHaveLength(3500);
      expect(rows.map((r) => r.unit.key)).toEqual(Array.from({ length: 3500 }, (_, i) => `K${i}`));
    });

    it('rejects the whole call when one page fails', async () => {
      const total = 3000;
      const fetchImpl: FetchLike = async (input: string) => {
        const url = new URL(input, 'http://lochub.test');
        const offset = Number(url.searchParams.get('offset'));
        if (offset === 2000) return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'boom' }) } as unknown as Response;
        return { ok: true, status: 200, text: async () => JSON.stringify({ total, rows: rowPage(offset, 1000) }) } as unknown as Response;
      };
      const api = new LocHubApi('', fetchImpl);
      await expect(api.allCells('ru')).rejects.toThrow();
    });
  });

  it('turns error answers into ApiError with the precheck issues', async () => {
    const fake = createFakeApi({ units: [makeUnit('A', '{Count} bales')], cells: { ru: { 'id-A': makeCell('id-A', 'ru', { text: 'x' }) } } });
    const api = new LocHubApi('', fake.fetch);
    const error = await api.edit('ru', 'id-A', 'Осталось {Broken}').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).body.issues?.[0]?.code).toBe('args_extra');
    expect(errorText(error)).toBe('Precheck failed');
  });

  // Check tiers: approve/edit carry the confirm codes the reviewer approves anyway, and nothing when there are none.
  it('sends accept with approve and edit only when there is something to accept', async () => {
    const fake = createFakeApi({ units: [makeUnit('A', '{Count} bales')], cells: { ru: { 'id-A': makeCell('id-A', 'ru', { text: 'тюки' }) } } });
    const api = new LocHubApi('', fake.fetch);
    await api.approve('ru', 'id-A', undefined, ['args_missing']);
    await api.edit('ru', 'id-A', 'ещё тюки', undefined, ['args_missing']);
    await api.edit('ru', 'id-A', 'ещё {Count} тюков', undefined, []);
    expect(fake.requests.map((r) => r.body)).toEqual([{ accept: ['args_missing'] }, { text: 'ещё тюки', accept: ['args_missing'] }, { text: 'ещё {Count} тюков' }]);
  });

  it('survives a non-JSON error body', async () => {
    const api = new LocHubApi('', async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>' }) as unknown as Response);
    const error = await api.health().catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(502);
    expect(errorText(error)).toBe('GET /api/health failed: 502');
  });

  it('startJob sends no maxUsd key when maxUsd is undefined (subscription backend)', async () => {
    let sentBody = '';
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '');
      return { ok: true, status: 202, text: async () => JSON.stringify({ jobId: 'job-1', estimate: { requests: 1, items: 1, inputTokens: 1, outputTokens: 1, usd: 0 } }) } as unknown as Response;
    };
    const api = new LocHubApi('', fetchImpl);
    await api.startJob({ culture: 'ru' }, undefined);
    expect(Object.keys(JSON.parse(sentBody))).not.toContain('maxUsd');
  });
});
