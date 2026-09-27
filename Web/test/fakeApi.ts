import { BRIDGE_COMMANDS, emptyCell, IMPORT_OUTCOMES, isOutdated as contractOutdated, type ImportEntry, type ImportRow } from '../../Service/src/contract';
import { visibleLength } from '../../Service/src/lengthCheck';
import type { GridCell, GridRow } from '../src/grid/model';
import type { FetchLike } from '../src/api/client';
import type { AiStatus, Cell, CellEvent, CoverageReport, GlossaryTerm, InboxItem, JobEstimate, JobProgress, PrecheckIssue, Unit } from '../src/api/types';

export interface FakeState {
  units: Unit[];
  cells: Record<string, Record<string, Cell>>;
  glossary: Record<string, GlossaryTerm[]>;
  style: Record<string, string>;
  inbox: InboxItem[];
  coverage: CoverageReport;
  editorConnected: boolean;
  // null mimics a model with no entry in the price table (JobEstimate.usd: number | null).
  estimateUsd: number | null;
  // Overrides JobEstimate.strings in the fake's estimate replies: a number sets it explicitly (test the
  // "items === 0 but strings > 0", TM/cache reuse, and "strings === 0", nothing to translate, branches
  // independently of the real candidate count); undefined defaults to the same value as items (nothing extra
  // reused); null omits the `strings` field from the reply entirely, mimicking a service that predates it.
  estimateStrings?: number | null;
  // JobEstimate.approximate in the fake's estimate/job replies: mimics a rate-limit/overloaded fallback (or
  // skipEstimate) having made part of the estimate a local guess instead of a real token count.
  estimateApproximate?: boolean;
  // JobEstimate.pricesUnset in the fake's estimate/job replies: mimics a Custom endpoint whose Project Settings
  // prices are both 0 (usd 0, Max USD cannot limit spending).
  estimatePricesUnset?: boolean;
  // GET /api/jobs/:id answers "running" this many times before "done".
  jobPolls: number;
  // JobRecord.progress: set on the fake before a job starts to have GET /api/jobs/:id and ?culture= carry
  // it, mirroring the real service leaving it at its last value once the job ends.
  jobProgress?: JobProgress;
  // JobReport.errorSamples for the report a finished job answers with; undefined omits the field (an older
  // service, or a job with no errors to sample).
  jobErrorSamples?: string[];
  commands: { name: string; args: Record<string, unknown> }[];
  // /api/health.stale: true after Localization/LocHub changed on disk.
  stale: boolean;
  // /api/health.jobRunning: true while any translation job has status 'running'. A test
  // flips it directly (real jobs run through /api/jobs, which this fake does not simulate progress for).
  jobRunning: boolean;
  // /api/health.jobsFinished: undefined omits the field entirely, mimicking a service that
  // predates it; a test sets a number and bumps it directly to simulate a job leaving 'running'.
  jobsFinished?: number;
  // /api/health.ai; undefined mimics an older service that predates the field (no ai key in the reply at all).
  ai?: AiStatus;
  // Set to mimic the service's 400 ai_not_ready (missing provider API key env var): POST /api/jobs/estimate and
  // POST /api/jobs answer 400 with this as the message before doing any work.
  aiNotReady?: string;
  // Glossary CSV import partial-failure test: cultures listed here answer 500 to PUT /api/glossary/:culture
  // instead of saving, so a multi-culture import can be made to fail partway through.
  failGlossaryPutCultures?: string[];
  // POST /api/cells/:culture/:unitId/check answers 500 instead of computing issues (simulates a network/service
  // failure of the live format check — the card must fall back to today's behaviour, not block on it).
  checkFails?: boolean;
  // When true, POST .../check does not resolve on its own; the call is instead queued onto `pendingChecks`
  // (below) for the test to release in whatever order it wants, so a response can be made to arrive "late" for
  // an out-of-order-network test.
  holdChecks?: boolean;
  // POST .../retranslate answers with these issues for the new suggestion (a real service would compute them
  // from the suggestion text); undefined mimics the common case of a suggestion with nothing wrong with it.
  retranslateIssues?: PrecheckIssue[];
  // GET /api/cells row's lengthLimit (Service/src/lengthCheck.ts lengthLimitFor), keyed by unit id: an absent
  // entry (or the whole field left undefined) sends null, "no limit", same as the real service. Culture is not
  // modeled here — a test fake, not the real per-culture computation. checkIssuesFor also reads this (with
  // lengthCheckSeverity below) to add a 'too_long' issue, mirroring Service/src/precheck.ts so the live check,
  // the approve/edit gate and the card counter all agree in tests too (M-3).
  lengthLimits?: Record<string, number | null>;
  // Severity checkIssuesFor's too_long issue uses when a lengthLimits entry is exceeded. Mirrors
  // Service/src/lengthCheck.ts LengthCheckMode ('warning' -> 'soft', the default; 'confirm' -> 'confirm').
  lengthCheckSeverity?: 'soft' | 'confirm';
}

export function makeUnit(key: string, source: string, extra: Partial<Unit> = {}): Unit {
  return {
    id: `id-${key}`,
    namespace: 'HW',
    key,
    source,
    sourceRev: 1,
    state: 'active',
    origin: `Source/MyGame/Private/${key}.cpp(10)`,
    devNotes: '',
    metadata: {},
    groupKey: 'Hud',
    ...extra,
  };
}

export function makeCell(unitId: string, culture: string, extra: Partial<Cell> = {}): Cell {
  return { ...emptyCell(unitId, culture), basedOnSourceRev: 1, ...extra };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function reply(status: number, body: unknown): Response {
  const response: FakeResponse = { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  return response as unknown as Response;
}

const CELL_ROUTE = /^\/api\/cells\/([^/]+)\/([^/]+)\/(approve|edit|reject|retranslate|history|check)$/;

// A cheap, deterministic stand-in for the real service's sha256 digest (Service/src/exchange.ts): distinguishes
// "these are the same preview rows" from "something changed" well enough for a test fake. Never compared against a
// real service's digest, and not meant to be collision-resistant.
function fakeDigest(rows: readonly ImportRow[]): string {
  const text = JSON.stringify(rows);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// The fake's stand-in for the real precheck (Service/src/precheck.ts), one example per tier: "{Broken}" stands
// for an argument the source does not have (hard: Unreal prints it raw), a source argument the text leaves out
// is a confirm issue (valid for Unreal, probably a mistake), and text identical to the source is soft. A
// too_long issue (also soft or confirm, per lengthCheckSeverity) is added on top when the text is over the
// unit's lengthLimits entry, the same way precheck.ts adds it alongside whatever else it found.
function checkIssuesFor(unit: Unit, text: string, state: Pick<FakeState, 'lengthLimits' | 'lengthCheckSeverity'>): PrecheckIssue[] {
  if (text.includes('{Broken}')) return [{ code: 'args_extra', severity: 'hard', message: 'Unknown arguments: Broken' }];
  const missing = [...unit.source.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((arg) => !text.includes(`{${arg}}`));
  if (missing.length > 0) return [{ code: 'args_missing', severity: 'confirm', message: `Missing arguments: ${missing.join(', ')}` }];
  const issues: PrecheckIssue[] = [];
  if (text.trim().length > 0 && text.trim() === unit.source.trim())
    issues.push({ code: 'untranslated', severity: 'soft', message: 'Translation is identical to the source' });
  const limit = state.lengthLimits?.[unit.id];
  if (typeof limit === 'number') {
    const length = visibleLength(text);
    if (length > limit)
      issues.push({
        code: 'too_long',
        severity: state.lengthCheckSeverity ?? 'soft',
        message: `Too long for the UI: ${length}/${limit} characters (Length Check in Project Settings)`,
      });
  }
  return issues;
}

// Same gate as Service/src/cells.ts checkOrThrow: a hard issue is refused, a confirm issue only passes when
// `accept` names every confirm code. Returns the 422 body, or the accepted codes for the event.
function gate(
  unit: Unit,
  text: string,
  accept: unknown,
  state: Pick<FakeState, 'lengthLimits' | 'lengthCheckSeverity'>,
): { refusal: { error: string; issues: PrecheckIssue[] } } | { accepted: string[] } {
  const issues = checkIssuesFor(unit, text, state);
  if (issues.some((i) => i.severity === 'hard')) return { refusal: { error: 'Precheck failed', issues } };
  const accepted = [...new Set(issues.filter((i) => i.severity === 'confirm').map((i) => i.code))];
  const named = Array.isArray(accept) ? accept : [];
  const unconfirmed = accepted.filter((code) => !named.includes(code));
  if (unconfirmed.length > 0) return { refusal: { error: `Confirm these warnings to go ahead anyway: ${unconfirmed.join(', ')}`, issues } };
  return { accepted };
}
const INBOX_ROUTE = /^\/api\/inbox\/([^/]+)\/(answer|dismiss)$/;
const JOB_ROUTE = /^\/api\/jobs\/([^/]+)$/;
const CULTURE_ROUTE = /^\/api\/(glossary|style)\/([^/]+)$/;

export function createFakeApi(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    units: [],
    cells: {},
    glossary: {},
    style: {},
    inbox: [],
    coverage: { pushedAt: '', findings: [] },
    editorConnected: false,
    estimateUsd: 0.5,
    jobPolls: 1,
    commands: [],
    stale: false,
    jobRunning: false,
    ...initial,
  };
  const calls: string[] = [];
  // The JSON body of every request, in call order, for tests that assert what a click actually sent.
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const events: CellEvent[] = [];
  // POST .../check calls queued here while state.holdChecks is true, oldest first; a test resolves them in
  // whatever order it wants to simulate an out-of-order network response.
  const pendingChecks: { text: string; resolve: () => void }[] = [];
  const jobs = new Map<string, number>();
  // The most recently started job id per culture, so GET /api/jobs?culture= and the 409 job_running jobId can
  // find it, same as the real service's JobRecord map.
  const jobCultures = new Map<string, string>();
  const jobStatus = (id: string) => {
    const polls = jobs.get(id) ?? 0;
    const running = polls < state.jobPolls;
    return {
      id,
      culture: 'ru',
      status: running ? 'running' : ('done' as const),
      estimate: estimateFor({}),
      ...(state.jobProgress ? { progress: state.jobProgress } : {}),
      report: running
        ? undefined
        : {
            culture: 'ru',
            requested: 2,
            tm: 0,
            written: 2,
            suggestions: 0,
            needsFix: 0,
            refused: 0,
            errors: 0,
            questions: 0,
            bands: { R: 0, Y: 1, G: 1 },
            inputTokens: 1000,
            outputTokens: 200,
            ...(state.jobErrorSamples ? { errorSamples: state.jobErrorSamples } : {}),
          },
    };
  };

  const cellOf = (culture: string, unitId: string): Cell => state.cells[culture]?.[unitId] ?? makeCell(unitId, culture);
  const putCell = (cell: Cell) => {
    state.cells[cell.culture] = { ...(state.cells[cell.culture] ?? {}), [cell.unitId]: cell };
  };
  const isOutdated = (unit: Unit, cell: Cell) => cell.status !== 'empty' && cell.text.length > 0 && cell.basedOnSourceRev < unit.sourceRev;
  // Mirrors the real service's scope narrowing (Service/src/grouping.ts selectWork) closely enough for tests:
  // unitIds is an exact set, groupKey is an exact match, groupPrefix is a startsWith match on unit.groupKey.
  const estimateFor = (body: { unitIds?: string[]; groupKey?: string; groupPrefix?: string }): JobEstimate => {
    let candidates = state.units;
    if (body.unitIds) {
      const ids = new Set(body.unitIds);
      candidates = candidates.filter((u) => ids.has(u.id));
    }
    if (typeof body.groupKey === 'string') candidates = candidates.filter((u) => u.groupKey === body.groupKey);
    if (typeof body.groupPrefix === 'string') candidates = candidates.filter((u) => u.groupKey.startsWith(body.groupPrefix!));
    const strings = state.estimateStrings === undefined ? candidates.length : state.estimateStrings;
    return {
      requests: 1,
      items: candidates.length,
      inputTokens: 1000,
      outputTokens: 200,
      usd: state.estimateUsd,
      ...(strings === null ? {} : { strings }),
      ...(state.estimateApproximate ? { approximate: true } : {}),
      ...(state.estimatePricesUnset ? { pricesUnset: true } : {}),
    };
  };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, 'http://lochub.test');
    const method = init?.method ?? 'GET';
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const path = url.pathname;
    const query = url.searchParams;
    calls.push(`${method} ${path}${url.search}`);
    requests.push({ method, path, body });

    // The service's request hygiene (CONTRACT.md): a mutation without a JSON content type gets 415, and Fastify
    // answers 400 to a JSON content type with an empty body.
    if (method !== 'GET') {
      const contentType = (init?.headers as Record<string, string> | undefined)?.['content-type'] ?? '';
      if (!contentType.startsWith('application/json')) return reply(415, { error: 'Content-Type must be application/json' });
      if (typeof init?.body !== 'string' || init.body.length === 0)
        return reply(400, { error: "Body cannot be empty when content-type is set to 'application/json'" });
    }

    if (method === 'GET' && path === '/api/health')
      return reply(200, {
        ok: true,
        units: state.units.length,
        editorConnected: state.editorConnected,
        stale: state.stale,
        jobRunning: state.jobRunning,
        ...(state.jobsFinished !== undefined ? { jobsFinished: state.jobsFinished } : {}),
        ...(state.ai ? { ai: state.ai } : {}),
      });
    if (method === 'GET' && path === '/api/meta') return reply(200, { nativeCulture: 'en', cultures: Object.keys(state.cells).sort() });

    if (method === 'GET' && path === '/api/cells') {
      const culture = query.get('culture');
      if (!culture) return reply(400, { error: 'culture is required' });
      const needle = query.get('q')?.toLowerCase();
      const rows = state.units
        .filter((unit) => unit.state === 'active')
        .map((unit) => {
          const cell = cellOf(culture, unit.id);
          // The real service always sends lengthLimit (server.ts, lengthLimitFor); null means "no limit" (M-3).
          return { unit, cell, outdated: isOutdated(unit, cell), lengthLimit: state.lengthLimits?.[unit.id] ?? null };
        })
        .filter((row) => !query.get('band') || row.cell.band === query.get('band'))
        .filter((row) => !query.get('status') || row.cell.status === query.get('status'))
        .filter((row) => !needle || row.unit.source.toLowerCase().includes(needle) || row.cell.text.toLowerCase().includes(needle));
      const limit = Math.min(1000, Number(query.get('limit') ?? 200));
      const offset = Number(query.get('offset') ?? 0);
      return reply(200, { total: rows.length, rows: rows.slice(offset, offset + limit) });
    }

    const cellRoute = CELL_ROUTE.exec(path);
    if (cellRoute) {
      const culture = decodeURIComponent(cellRoute[1] ?? '');
      const unitId = decodeURIComponent(cellRoute[2] ?? '');
      const action = cellRoute[3] ?? '';
      const unit = state.units.find((u) => u.id === unitId);
      if (!unit) return reply(404, { error: `Unknown unit ${unitId}` });
      const cell = cellOf(culture, unitId);
      if (action === 'history') return reply(200, events.filter((e) => e.culture === culture && e.unitId === unitId));
      if (action === 'retranslate') {
        const next: Cell = { ...cell, suggestion: `${unit.source} (again)` };
        putCell(next);
        return reply(200, { cell: next, issues: state.retranslateIssues ?? [] });
      }
      if (action === 'check') {
        if (state.checkFails) return reply(500, { error: 'boom' });
        const issues = checkIssuesFor(unit, String(body.text ?? ''), state);
        if (state.holdChecks) {
          await new Promise<void>((resolve) => pendingChecks.push({ text: String(body.text ?? ''), resolve }));
        }
        return reply(200, { issues });
      }
      // Fix S contract: approve/edit/reject accept optional expectedRevision/expectedSourceRev; a mismatch answers
      // 409 stale_cell with the current cell and unit, and nothing is written.
      if (action === 'approve' || action === 'edit' || action === 'reject') {
        const expectedRevision = body.expectedRevision;
        const expectedSourceRev = body.expectedSourceRev;
        const revisionStale = typeof expectedRevision === 'number' && expectedRevision !== cell.revision;
        const sourceRevStale = typeof expectedSourceRev === 'number' && expectedSourceRev !== unit.sourceRev;
        if (revisionStale || sourceRevStale) {
          return reply(409, {
            error: 'stale_cell',
            message: 'This string changed since you opened it (new source text or a newer translation). Review it again.',
            cell,
            unit,
          });
        }
      }
      let next: Cell;
      let accepted: string[] = [];
      if (action === 'approve' || action === 'edit') {
        const text = action === 'edit' ? String(body.text ?? '') : cell.text;
        const verdict = gate(unit, text, body.accept, state);
        if ('refusal' in verdict) return reply(422, verdict.refusal);
        accepted = verdict.accepted;
        next = action === 'approve' ? { ...cell, status: 'approved', revision: cell.revision + 1 } : { ...cell, text, status: 'edited', suggestion: '', revision: cell.revision + 1 };
      } else next = { ...cell, status: 'rejected', note: String(body.note ?? ''), revision: cell.revision + 1 };
      putCell(next);
      events.push({
        ts: '2026-09-25T12:00:00Z',
        unitId,
        culture,
        action: action as CellEvent['action'],
        actor: 'reviewer',
        before: cell.text,
        after: next.text,
        ...(accepted.length > 0 ? { accepted } : {}),
      });
      return reply(200, { cell: next });
    }

    if (method === 'POST' && path === '/api/jobs/estimate') {
      if (typeof body.culture !== 'string') return reply(400, { error: 'culture is required' });
      if (state.aiNotReady) return reply(400, { error: 'ai_not_ready', message: state.aiNotReady });
      return reply(200, { estimate: estimateFor(body as { unitIds?: string[]; groupKey?: string; groupPrefix?: string }) });
    }
    if (method === 'POST' && path === '/api/jobs') {
      if (typeof body.culture !== 'string') return reply(400, { error: 'culture and maxUsd are required' });
      if (state.aiNotReady) return reply(400, { error: 'ai_not_ready', message: state.aiNotReady });
      const culture = body.culture;
      // Same shape as the real service (server.ts): 409 job_running carries the running job's id.
      const existingId = jobCultures.get(culture);
      if (existingId !== undefined && jobStatus(existingId).status === 'running') return reply(409, { error: 'job_running', jobId: existingId });
      const estimate = estimateFor(body as { unitIds?: string[]; groupKey?: string; groupPrefix?: string });
      // maxUsd is not sent when there is no dollar amount to check against (subscription billing, or a model with
      // no price); only check the budget when the caller did send a number and the estimate has one too.
      if (typeof body.maxUsd === 'number' && typeof estimate.usd === 'number' && body.maxUsd < estimate.usd)
        return reply(422, { error: 'budget', message: `Estimate $${estimate.usd} is above MaxUSD $${body.maxUsd}`, estimate });
      const id = `job-${jobs.size + 1}`;
      jobs.set(id, 0);
      jobCultures.set(culture, id);
      return reply(202, { jobId: id, estimate });
    }
    if (method === 'GET' && path === '/api/jobs') {
      const culture = query.get('culture');
      if (!culture) return reply(400, { error: 'culture is required' });
      const id = jobCultures.get(culture);
      if (id === undefined) return reply(404, { error: 'Unknown job' });
      return reply(200, jobStatus(id));
    }
    const jobRoute = JOB_ROUTE.exec(path);
    if (method === 'GET' && jobRoute) {
      const id = jobRoute[1] ?? '';
      const polls = jobs.get(id);
      if (polls === undefined) return reply(404, { error: 'Unknown job' });
      const result = jobStatus(id);
      jobs.set(id, polls + 1);
      return reply(200, result);
    }

    const cultureRoute = CULTURE_ROUTE.exec(path);
    if (cultureRoute) {
      const kind = cultureRoute[1];
      const culture = decodeURIComponent(cultureRoute[2] ?? '');
      if (kind === 'glossary' && method === 'GET') return reply(200, state.glossary[culture] ?? []);
      if (kind === 'glossary' && method === 'PUT') {
        if (state.failGlossaryPutCultures?.includes(culture)) return reply(500, { error: `boom saving ${culture}` });
        const terms: unknown = JSON.parse(String(init?.body));
        // Same rule as PUT /api/glossary/:culture in Service/src/server.ts: nothing is saved unless every term is complete.
        const complete = (candidate: unknown): candidate is GlossaryTerm => {
          const t = candidate as Partial<GlossaryTerm> | null;
          return t !== null && typeof t === 'object' && typeof t.term === 'string' && t.term !== '' &&
            typeof t.translation === 'string' && typeof t.dnt === 'boolean' && typeof t.note === 'string';
        };
        if (!Array.isArray(terms) || !terms.every(complete)) return reply(400, { error: 'Each term needs term, translation, dnt and note' });
        state.glossary[culture] = terms;
        return reply(200, { ok: true });
      }
      if (kind === 'style' && method === 'GET') return reply(200, { text: state.style[culture] ?? '' });
      state.style[culture] = String(body.text ?? '');
      return reply(200, { ok: true });
    }

    if (method === 'GET' && path === '/api/inbox') {
      const status = query.get('status');
      const culture = query.get('culture');
      const rows = state.inbox
        .filter((item) => (!status || item.status === status) && (!culture || item.culture === culture))
        .map((item) => {
          const unit = state.units.find((u) => u.id === item.unitId);
          return { item, unit: unit ? { namespace: unit.namespace, key: unit.key, source: unit.source, origin: unit.origin, devNotes: unit.devNotes } : null };
        });
      return reply(200, { rows });
    }
    if (method === 'POST' && path === '/api/inbox') {
      const question = String(body.question ?? '').trim();
      if (!state.units.some((u) => u.id === body.unitId)) return reply(404, { error: 'Unknown unit' });
      if (!question) return reply(422, { error: 'Question is empty' });
      const item: InboxItem = {
        id: `q-${state.inbox.length + 1}`,
        unitId: String(body.unitId),
        culture: String(body.culture),
        question,
        askedBy: 'reviewer',
        status: 'open',
        answer: '',
        created: '2026-09-25T12:00:00Z',
        answered: '',
      };
      state.inbox.push(item);
      return reply(201, { item });
    }
    const inboxRoute = INBOX_ROUTE.exec(path);
    if (method === 'POST' && inboxRoute) {
      const index = state.inbox.findIndex((item) => item.id === inboxRoute[1]);
      const current = state.inbox[index];
      if (!current) return reply(404, { error: 'Unknown inbox item' });
      const answer = String(body.answer ?? '').trim();
      if (inboxRoute[2] === 'answer' && !answer) return reply(422, { error: 'Answer is empty' });
      const next: InboxItem = inboxRoute[2] === 'answer' ? { ...current, status: 'answered', answer, answered: '2026-09-25T12:00:00Z' } : { ...current, status: 'dismissed' };
      state.inbox[index] = next;
      return reply(200, { item: next });
    }

    if (method === 'GET' && path === '/api/summary') {
      const culture = query.get('culture');
      if (!culture) return reply(400, { error: 'culture is required' });
      const cells = state.units.map((unit) => cellOf(culture, unit.id));
      const byStatus: Record<string, number> = {};
      const byBand = { R: 0, Y: 0, G: 0 };
      for (const cell of cells) {
        byStatus[cell.status] = (byStatus[cell.status] ?? 0) + 1;
        if (cell.band === 'R' || cell.band === 'Y' || cell.band === 'G') byBand[cell.band] += 1;
      }
      const sampled = cells.filter((cell) => cell.qaFlags.includes('audit'));
      return reply(200, {
        culture,
        total: cells.length,
        byStatus,
        byBand,
        outdated: state.units.filter((unit) => isOutdated(unit, cellOf(culture, unit.id))).length,
        openQuestions: state.inbox.filter((item) => item.culture === culture && item.status === 'open').length,
        audit: { sampled: sampled.length, corrected: sampled.filter((cell) => ['edited', 'rejected', 'human_edit'].includes(cell.status)).length },
      });
    }
    if (method === 'GET' && path === '/api/coverage') return reply(200, state.coverage);

    if (method === 'POST' && path === '/api/bridge/command') {
      if (!(BRIDGE_COMMANDS as readonly string[]).includes(String(body.name))) return reply(400, { error: 'Unknown command' });
      if (!state.editorConnected) return reply(409, { error: 'editor_not_connected' });
      state.commands.push({ name: String(body.name), args: (body.args ?? {}) as Record<string, unknown> });
      return reply(202, { delivered: 1 });
    }

    // A small stand-in for Service/src/exchange.ts: the same outcome names and rule order, checkIssuesFor as the
    // check, applied row by row (the real route is all or nothing). digest identifies one exact preview: an apply
    // whose previewDigest no longer matches (the store changed since the dry run) is refused with 409 preview_stale
    // and writes nothing, mirroring the real service's previewDigest/digest pair.
    if (method === 'POST' && path === '/api/import') {
      const culture = String(body.culture ?? '');
      const dryRun = body.dryRun !== false;
      if (!dryRun && String(body.actor ?? '').trim() === '') return reply(400, { error: 'actor is required' });
      const entries = (Array.isArray(body.entries) ? body.entries : []) as ImportEntry[];
      const writes: { unitId: string; cell: Cell; entry: ImportEntry; outcome: ImportRow['outcome'] }[] = [];
      const rows: ImportRow[] = entries.map((entry, index) => {
        const unit = state.units.find((u) =>
          entry.unitId !== undefined ? u.id === entry.unitId : u.namespace === (entry.namespace ?? '') && u.key === entry.key,
        );
        if (!unit || unit.state !== 'active') return { index, outcome: 'unknown' };
        if (entry.source !== undefined && entry.source !== unit.source) return { index, unitId: unit.id, outcome: 'stale' };
        if (entry.text.trim() === '') return { index, unitId: unit.id, outcome: 'empty' };
        const cell = cellOf(culture, unit.id);
        // An approval writes when the cell is not approved yet, or is approved for an older source and this file
        // shows the current one (mirrors Service/src/exchange.ts's `approves`: a re-approval of an outdated string).
        const approves = entry.approved && (cell.status !== 'approved' || (entry.source !== undefined && contractOutdated(unit, cell)));
        if (entry.text === cell.text && !approves) return { index, unitId: unit.id, outcome: 'unchanged' };
        const conflict = entry.exportedRevision !== undefined && entry.exportedRevision !== cell.revision;
        const issues = checkIssuesFor(unit, entry.text, state);
        const row: ImportRow = { index, unitId: unit.id, outcome: 'unchanged', ...(conflict ? { conflict: true as const } : {}), issues, before: cell.text, after: entry.text };
        if (conflict && body.overwriteConflicts !== true) row.outcome = 'conflict';
        else if (issues.some((issue) => issue.severity === 'hard')) row.outcome = 'hard';
        else if (issues.some((issue) => issue.severity === 'confirm') && body.acceptConfirm !== true) row.outcome = 'confirm';
        else {
          // An overwritten conflict never approves, whatever the text: it refers to a state of the string LocHub
          // has since changed, so it always lands as changed (the reviewer's own edit). A carried-over approval
          // (the cell was already approved at export) never approves new text either.
          row.outcome = conflict ? 'changed' : entry.text === cell.text ? 'approved' : entry.approved && cell.status !== 'approved' ? 'changed_approved' : 'changed';
          writes.push({ unitId: unit.id, cell, entry, outcome: row.outcome });
        }
        return row;
      });
      const counts = Object.fromEntries(IMPORT_OUTCOMES.map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]));
      const digest = fakeDigest(rows);
      // The apply refuses to write anything other than what its own preview showed. Absent previewDigest, apply as
      // before (backward compatible).
      if (!dryRun && typeof body.previewDigest === 'string' && body.previewDigest !== digest) {
        return reply(409, { error: 'preview_stale', message: 'LocHub changed since the preview. Check the new preview and import again.', result: { rows, counts, digest } });
      }
      if (!dryRun) {
        for (const { cell, entry, outcome } of writes) putCell({ ...cell, text: entry.text, status: outcome === 'changed' ? 'edited' : 'approved', revision: cell.revision + 1 });
      }
      return reply(200, { rows, counts, digest });
    }

    return reply(404, { error: `Fake has no route ${method} ${path}` });
  };

  return { fetch, state, calls, requests, pendingChecks };
}

// Grid rows as the web app builds them from GET /api/cells, straight from the fake's state.
export function rowsFromState(state: FakeState, cultures: readonly string[]): GridRow[] {
  return state.units
    .filter((unit) => unit.state === 'active')
    .map((unit) => {
      const cells: Record<string, GridCell> = {};
      for (const culture of cultures) {
        const cell = state.cells[culture]?.[unit.id] ?? makeCell(unit.id, culture);
        cells[culture] = { cell, outdated: contractOutdated(unit, cell) };
      }
      return { unit, cells };
    });
}
