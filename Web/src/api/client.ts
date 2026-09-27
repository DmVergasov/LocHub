import type {
  BridgeCommandName,
  Cell,
  CellEvent,
  CellRow,
  CellsPage,
  CoverageReport,
  CultureSummary,
  GlossaryTerm,
  Health,
  InboxItem,
  InboxRow,
  ImportRequest,
  ImportResult,
  JobEstimate,
  JobRecord,
  JobScope,
  Meta,
  PrecheckIssue,
  Unit,
} from './types';

export interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: PrecheckIssue[];
  // 409 stale_cell: the cell/unit as the service currently holds them, so the caller can re-render with them.
  cell?: Cell;
  unit?: Unit;
  // 409 job_running (job resume): the running job's id, once its record exists (absent while still `starting`).
  jobId?: string;
  // 409 preview_stale (import apply): the fresh preview of the same file, to show in place of the stale one.
  result?: ImportResult;
}

// The cell revision and unit sourceRev the reviewer's card was showing when they acted, so the service can detect
// a stale view and answer 409 stale_cell instead of overwriting text the reviewer never saw.
export interface ExpectedCellState {
  revision: number;
  sourceRev: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CellQuery {
  band?: string;
  status?: string;
  flag?: string;
  groupKey?: string;
  outdated?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

// GET /api/cells returns at most this many rows per page.
export const PAGE_LIMIT = 1000;

// LocHubApi.allCells: how many pages beyond the first may be in flight at once.
const ALL_CELLS_CONCURRENCY = 4;

// Runs `fn` over `items` with at most `limit` calls in flight at once, returning results in the same order as
// `items` regardless of resolution order. A rejection from any call rejects the whole call (Promise.all semantics
// on the underlying per-item promises, surfaced through the worker loop below).
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type QueryValue = string | number | boolean | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

const segment = encodeURIComponent;

function expectedBody(expected: ExpectedCellState | undefined): { expectedRevision?: number; expectedSourceRev?: number } {
  return expected ? { expectedRevision: expected.revision, expectedSourceRev: expected.sourceRev } : {};
}

// The 'confirm' issue codes the reviewer approves anyway (CONTRACT.md, check tiers); left out when there are none.
function acceptBody(accept: readonly string[] | undefined): { accept?: string[] } {
  return accept && accept.length > 0 ? { accept: [...accept] } : {};
}

export class LocHubApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl = '', fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    // The service answers 415 to a POST/PUT/DELETE that is not JSON, and Fastify answers 400 to a JSON content type
    // with an empty body (CONTRACT.md, "Request hygiene"): every mutation carries a JSON body, "{}" when it has no fields.
    if (method !== 'GET') {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body ?? {});
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const errorBody: ApiErrorBody = parsed !== null && typeof parsed === 'object' ? (parsed as ApiErrorBody) : {};
      throw new ApiError(response.status, errorBody, errorBody.message ?? errorBody.error ?? `${method} ${path} failed: ${response.status}`);
    }
    return parsed as T;
  }

  health(): Promise<Health> {
    return this.request('GET', '/api/health');
  }

  meta(): Promise<Meta> {
    return this.request('GET', '/api/meta');
  }

  cells(culture: string, query: CellQuery = {}): Promise<CellsPage> {
    return this.request('GET', `/api/cells${queryString({ culture, ...query })}`);
  }

  // Fetches the first page alone to learn `total`, then the remaining pages with up to 4 requests in flight at
  // once, concatenated back into offset order regardless of which one resolves first. `total` can itself grow
  // between rounds (a unit was added to the culture while this was still paging); each round re-reads the
  // latest known total and fetches whatever offsets it now covers that were not fetched yet, looping until a
  // round reports no further growth. Offsets only ever increase across rounds, so appending each round's pages
  // after the previous one keeps the result in offset order throughout.
  async allCells(culture: string): Promise<CellRow[]> {
    const first = await this.cells(culture, { limit: PAGE_LIMIT, offset: 0 });
    const rows = first.rows.slice();
    let total = first.total;
    let nextOffset = PAGE_LIMIT;
    while (nextOffset < total) {
      const offsets: number[] = [];
      for (; nextOffset < total; nextOffset += PAGE_LIMIT) offsets.push(nextOffset);
      const pages = await mapWithConcurrency(offsets, ALL_CELLS_CONCURRENCY, (offset) => this.cells(culture, { limit: PAGE_LIMIT, offset }));
      for (const page of pages) {
        rows.push(...page.rows);
        if (page.total > total) total = page.total;
      }
    }
    return rows;
  }

  approve(culture: string, unitId: string, expected?: ExpectedCellState, accept?: readonly string[]): Promise<{ cell: Cell }> {
    return this.request('POST', `/api/cells/${segment(culture)}/${segment(unitId)}/approve`, { ...expectedBody(expected), ...acceptBody(accept) });
  }

  edit(culture: string, unitId: string, text: string, expected?: ExpectedCellState, accept?: readonly string[]): Promise<{ cell: Cell }> {
    return this.request('POST', `/api/cells/${segment(culture)}/${segment(unitId)}/edit`, { text, ...expectedBody(expected), ...acceptBody(accept) });
  }

  reject(culture: string, unitId: string, note: string, expected?: ExpectedCellState): Promise<{ cell: Cell }> {
    return this.request('POST', `/api/cells/${segment(culture)}/${segment(unitId)}/reject`, { note, ...expectedBody(expected) });
  }

  // Read-only live format check, run against the draft as the reviewer types it: same precheck approve/edit
  // run, so the card can show why a draft would be refused before the click.
  check(culture: string, unitId: string, text: string): Promise<{ issues: PrecheckIssue[] }> {
    return this.request('POST', `/api/cells/${segment(culture)}/${segment(unitId)}/check`, { text });
  }

  // Translation exchange (CONTRACT.md, POST /api/import): a dry run for the preview, then the same request with
  // dryRun false to apply it.
  importTranslations(request: ImportRequest): Promise<ImportResult> {
    return this.request('POST', '/api/import', request);
  }

  retranslate(culture: string, unitId: string, note: string, asRule: boolean): Promise<{ cell: Cell; issues: PrecheckIssue[] }> {
    return this.request('POST', `/api/cells/${segment(culture)}/${segment(unitId)}/retranslate`, { note, asRule });
  }

  history(culture: string, unitId: string): Promise<CellEvent[]> {
    return this.request('GET', `/api/cells/${segment(culture)}/${segment(unitId)}/history`);
  }

  estimate(scope: JobScope): Promise<{ estimate: JobEstimate }> {
    return this.request('POST', '/api/jobs/estimate', scope);
  }

  // maxUsd is undefined under the subscription backend (CONTRACT.md: ignored, not required) and skipEstimate is
  // undefined for a normal Run (JobsView's Run button, after Estimate) -- JSON.stringify drops an
  // undefined-valued key, so the body simply omits whichever of the two does not apply.
  startJob(scope: JobScope, maxUsd: number | undefined, skipEstimate?: boolean): Promise<{ jobId: string; estimate: JobEstimate }> {
    return this.request('POST', '/api/jobs', { ...scope, maxUsd, skipEstimate });
  }

  job(id: string): Promise<JobRecord> {
    return this.request('GET', `/api/jobs/${segment(id)}`);
  }

  // Job resume: the newest job record of the culture (running, else the most recently started finished/failed
  // one), so a view that lost its job id (e.g. remounted after a tab switch) can find it again. A 404 (the
  // culture has no job) resolves to undefined rather than throwing, since that is the normal, expected case.
  async currentJob(culture: string): Promise<JobRecord | undefined> {
    try {
      return await this.request<JobRecord>('GET', `/api/jobs${queryString({ culture })}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  glossary(culture: string): Promise<GlossaryTerm[]> {
    return this.request('GET', `/api/glossary/${segment(culture)}`);
  }

  saveGlossary(culture: string, terms: GlossaryTerm[]): Promise<{ ok: true }> {
    return this.request('PUT', `/api/glossary/${segment(culture)}`, terms);
  }

  style(culture: string): Promise<{ text: string }> {
    return this.request('GET', `/api/style/${segment(culture)}`);
  }

  saveStyle(culture: string, text: string): Promise<{ ok: true }> {
    return this.request('PUT', `/api/style/${segment(culture)}`, { text });
  }

  inbox(filter: { status?: string; culture?: string } = {}): Promise<{ rows: InboxRow[] }> {
    return this.request('GET', `/api/inbox${queryString(filter)}`);
  }

  askContext(culture: string, unitId: string, question: string): Promise<{ item: InboxItem }> {
    return this.request('POST', '/api/inbox', { culture, unitId, question });
  }

  answer(id: string, answer: string): Promise<{ item: InboxItem }> {
    return this.request('POST', `/api/inbox/${segment(id)}/answer`, { answer });
  }

  dismiss(id: string): Promise<{ item: InboxItem }> {
    return this.request('POST', `/api/inbox/${segment(id)}/dismiss`, {});
  }

  summary(culture: string): Promise<CultureSummary> {
    return this.request('GET', `/api/summary${queryString({ culture })}`);
  }

  coverage(): Promise<CoverageReport> {
    return this.request('GET', '/api/coverage');
  }

  bridgeCommand(name: BridgeCommandName, args: Record<string, unknown>): Promise<{ delivered: number }> {
    return this.request('POST', '/api/bridge/command', { name, args });
  }
}
