import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { attachEditorStream, type BridgeHub } from './bridge.js';
import type { ResponseCache } from './cache.js';
import { checkClaudeAuthStatus, type ClaudeAuthStatus } from './claudeCode.js';
import { applyExportAck, approveCell, CellActionError, checkCell, editCell, exportForPull, rejectCell, StaleCellError } from './cells.js';
import {
  BRIDGE_COMMANDS,
  isOutdated,
  type BridgeCommandName,
  type Cell,
  type CoverageFinding,
  type EndpointHealth,
  type ExportAck,
  type GlossaryTerm,
  type InboxItem,
  type ReleasePolicy,
  type Snapshot,
} from './contract.js';
import { probeEndpoint, reduceBaseUrl } from './customEndpoint.js';
import { Fastify } from './deps.js';
import { assertWithinBudget, BudgetExceededError, estimateJob, TokenCountCache, type JobEstimate } from './estimate.js';
import { ImportPreviewStaleError, ImportRequestError, parseImportRequest, runImport, type TranslationCheck } from './exchange.js';
import { compareCodeUnits } from './ids.js';
import { runTranslateJob, type JobDefaults, type JobOptions, type JobProgress, type JobReport } from './job.js';
import { lengthArgsOf, lengthLimitFor } from './lengthCheck.js';
import type { LlmClient } from './llm.js';
import { BATCH_UNAVAILABLE_MESSAGE } from './llmShared.js';
import { answerQuestion, dismissQuestion, markApplied, recordQuestion } from './memory.js';
import { apiKeyHealth, billingOf, DEFAULT_AI_CONFIG, jobDefaultsFor, keyIdOf, supportsBatch, type AiConfig, type AiHealth } from './providers.js';
import { applySnapshot, reconcileArchives } from './push.js';
import { retranslateWithNote } from './retranslate.js';
import { StoreChangedOnDiskError, type LocHubStore } from './store.js';
import { summarize } from './summary.js';
import { registerWebApp } from './web.js';
import { checkCulture, validateAccept, validateAck, validateExpected, validateJobScope, validateReconcileBody, validateSnapshot } from './validate.js';

export interface ServerDeps {
  store: LocHubStore;
  llm: LlmClient;
  cache: ResponseCache;
  // Defaults to jobDefaultsFor(ai) when omitted, so a caller that only sets `ai` cannot end up with
  // jobs running under different translate/judge models than /api/health reports. Pass this explicitly only to
  // override a field jobDefaultsFor would not set on its own (for example a shorter pollMs in tests).
  jobDefaults?: JobDefaults;
  bridge: BridgeHub;
  policy: ReleasePolicy;
  // The port the server is bound to; the Host allowlist is checked against it.
  port: number;
  // Resources/LocHubWeb; when set, the service also serves the web app at its root (behind the same Host allowlist).
  webRoot?: string;
  // Source/ThirdParty/LocHubWebDeps: files the web root does not have (the vendor chunk) are served from here.
  webDepsRoot?: string;
  // The absolute project directory the service was started with: /api/health reports it so the plugin
  // can refuse a service that turns out to belong to another project on the same port. Absent in tests.
  projectDir?: string;
  // Provider, auth mode and models translate jobs run on; defaults to DEFAULT_AI_CONFIG (Anthropic, API key).
  // Drives /api/health's ai block and gates batch mode + the maxUsd requirement to Anthropic with an API key.
  ai?: AiConfig;
  // Only consulted when ai.auth is 'subscription'. Injectable so tests never spawn a real `claude`;
  // defaults to the real checkClaudeAuthStatus. Run once at startup and cached: the subscription's sign-in
  // state does not change over the life of the process.
  authProbe?: () => Promise<ClaudeAuthStatus>;
  // Injectable so tests never depend on the real process environment for API-key readiness (gates
  // POST /api/jobs and /api/jobs/estimate with 400 ai_not_ready) or for /api/health's ai.ready/detail/keyId.
  // Only LOCHUB_API_KEY is consulted (key-contract.md §2) -- the same variable the editor set for this
  // process at spawn, whatever provider is configured.
  env?: NodeJS.ProcessEnv;
  // Lowercase hex SHA-1 the editor's Project Brief is expected to hash to (cli.ts's --brief-file); reported at
  // ai.briefSha1 in /api/health. Defaults to the SHA-1 of an empty brief when omitted (tests only; cli.ts always
  // computes it, even for an absent or empty brief file).
  briefSha1?: string;
  // Custom endpoints only: the fetch the startup GET {base}/models probe uses. Injectable so tests never reach the
  // network; defaults to the global fetch.
  endpointFetch?: typeof fetch;
}

interface JobRecord {
  id: string;
  culture: string;
  status: 'running' | 'done' | 'failed';
  estimate: JobEstimate;
  report?: JobReport;
  error?: string;
  // When the job was created (job resume). Picks the "newest" record for a culture in GET /api/jobs?culture=.
  startedAt: string;
  // Updated from the job's own onProgress while it runs; left at its last value once the job ends (done or
  // failed), so a client that polled it mid-run keeps seeing where it got to.
  progress?: JobProgress;
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isNaN(parsed) ? fallback : Math.min(max, Math.max(min, parsed));
}

interface JobRequestBody {
  culture?: unknown;
  mode?: unknown;
  maxUsd?: unknown;
  groupKey?: unknown;
  groupPrefix?: unknown;
  unitIds?: unknown;
  // POST /api/jobs only (estimate-speed-brief.md §3): starts the job with no provider calls before it — no
  // countInputTokens, no maxUsd requirement, no budget check. See the route below and CONTRACT.md.
  skipEstimate?: unknown;
}

function jobOptionsFrom(body: JobRequestBody, defaults: JobDefaults): JobOptions | undefined {
  if (typeof body.culture !== 'string' || body.culture.length === 0) return undefined;
  return {
    ...defaults,
    culture: body.culture,
    mode: body.mode === 'sync' || body.mode === 'batch' ? body.mode : defaults.mode,
    filter: {
      groupKey: typeof body.groupKey === 'string' ? body.groupKey : undefined,
      groupPrefix: typeof body.groupPrefix === 'string' ? body.groupPrefix : undefined,
      unitIds: Array.isArray(body.unitIds) ? body.unitIds.filter((u): u is string => typeof u === 'string') : undefined,
    },
  };
}

function sendCellError(reply: FastifyReply, error: unknown) {
  if (error instanceof StaleCellError) return reply.code(409).send({ error: 'stale_cell', message: error.message, cell: error.cell, unit: error.unit });
  if (error instanceof CellActionError) return reply.code(error.statusCode).send({ error: error.message, issues: error.issues });
  throw error;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });

  // Store §3: a save() refused because the data files changed on disk (a source control sync, e.g. git pull,
  // p4 sync, while the service ran) surfaces as this on every write route, whichever one triggered it.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StoreChangedOnDiskError) return reply.code(409).send({ error: 'files_changed_on_disk', message: error.message });
    reply.send(error);
  });

  const jobs = new Map<string, JobRecord>();
  // Cultures whose job is being estimated; closes the gap between the running-job check and the job record.
  const starting = new Set<string>();
  // Monotonic counter, incremented once for every job record that leaves 'running' (done or failed) — see
  // /api/health's jobsFinished: a client polling health can notice a job that started and
  // ended between two polls (too short for jobRunning to ever have been observed true) by comparing against
  // the last value it saw, which jobRunning alone cannot do.
  let jobsFinished = 0;
  const { store } = deps;
  // Process-lifetime (for the life of this server instance) memo of counted groups, shared by POST /api/jobs
  // and POST /api/jobs/estimate (estimate-speed-brief.md §2): Run after Estimate, and a repeated Estimate,
  // make no provider calls for a group already counted.
  const estimateCountCache = new TokenCountCache();

  const ai: AiConfig = deps.ai ?? DEFAULT_AI_CONFIG;
  const env: NodeJS.ProcessEnv = deps.env ?? process.env;
  // One source of truth for the models jobs run on — derived from `ai` unless a caller overrides it
  // explicitly, so /api/health and the job routes cannot disagree about which translate/judge models are live.
  const jobDefaults: JobDefaults = deps.jobDefaults ?? jobDefaultsFor(ai);
  // Computed once, at server startup: a real `serve --brief-file` invocation (see cli.ts's USAGE) always sets
  // this (even for an absent or empty brief file); tests that omit it get the same value an empty brief would
  // hash to.
  const briefSha1: string = deps.briefSha1 ?? createHash('sha1').update('').digest('hex');

  // Run once, at server startup, and cached here: the subscription's sign-in state does not change over the
  // life of the process, and re-spawning `claude auth status` on every /api/health poll would be wasteful.
  const subscriptionHealthPromise: Promise<{ ready: boolean; detail: string }> | undefined =
    ai.auth === 'subscription' ? (deps.authProbe ?? (() => checkClaudeAuthStatus()))() : undefined;

  // Custom endpoints only: one GET {base}/models at startup, in the background -- readiness never waits for it,
  // and /api/health reports 'checking' until it answers.
  let endpointHealth: EndpointHealth | undefined = ai.custom ? { url: reduceBaseUrl(ai.custom.baseUrl), status: 'checking' } : undefined;
  if (ai.custom) {
    void probeEndpoint(ai.custom, [ai.translateModel, ai.judgeModel], env.LOCHUB_API_KEY, deps.endpointFetch).then((probed) => {
      endpointHealth = probed;
    });
  }

  // Every route that takes a culture funnels through this before it touches the store. Sends 400 and returns
  // false on failure so the caller can `if (!cultureGuard(...)) return;`. Also consults the cultures
  // of jobs that are starting or running: a job started as "pt-br" has no cells/glossary/style file
  // yet, so it must still block a differently-cased "pt-BR" landing anywhere else while it is in flight.
  function cultureGuard(culture: unknown, reply: FastifyReply): culture is string {
    const inFlight = [...starting, ...[...jobs.values()].filter((j) => j.status === 'running').map((j) => j.culture)];
    const error = checkCulture(store, culture, inFlight);
    if (error) reply.code(400).send({ error });
    return error === null;
  }

  // Loopback bind does not stop a browser from sending same-origin-looking requests (DNS rebinding), so
  // every request must present the Host it was actually served on, and every mutation must be real JSON (a
  // cross-site form POST cannot set an arbitrary content-type).
  app.addHook('onRequest', async (request, reply) => {
    // The port is all digits, so lowercasing only the header (not the templates) is enough to accept any casing.
    const host = (request.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${deps.port}` && host !== `localhost:${deps.port}`) return reply.code(403).send({ error: 'Forbidden host' });
    // A browser sets this header on a request a foreign page makes (fetch/XHR/EventSource across
    // origins), including a no-cors GET kept open on /api/bridge/stream to probe editorConnected. The
    // plugin's HTTP client and curl never send it, and same-origin/same-site/absent all pass through.
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'cross_site' });
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.startsWith('application/json')) return reply.code(415).send({ error: 'Content-Type must be application/json' });
    }
  });

  // Minor: every response refuses to be framed, so a foreign page embedding this origin cannot clickjack
  // Approve / Estimate+Run / Apply-to-N.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    return payload;
  });

  // Coverage is derived from code on every Push; it lives in memory only.
  let coverage: { pushedAt: string; findings: CoverageFinding[] } = { pushedAt: '', findings: [] };

  // Target cultures of the last real Push; like coverage, it lives in memory only.
  let lastPush: { nativeCulture: string; cultures: string[] } = { nativeCulture: '', cultures: [] };

  // Cultures of the last Push plus every culture that already has cells, minus the native (source) culture: the
  // same set /api/meta lists (so the Grid can only ever open one of these), shared here so /api/import refuses
  // anything else too.
  function translationCultures(): Set<string> {
    const cultures = new Set<string>(lastPush.cultures);
    for (const [culture, cells] of store.cells) if (cells.size > 0) cultures.add(culture);
    cultures.delete(lastPush.nativeCulture);
    return cultures;
  }

  app.get('/api/health', async () => {
    // The Custom endpoint settings stay out of the reply: the base URL may carry a path or a query with a token.
    const { custom, ...aiPublic } = ai;
    const aiHealth: AiHealth = {
      ...aiPublic,
      batch: supportsBatch(ai),
      briefSha1,
      keyId: keyIdOf(env.LOCHUB_API_KEY),
      lengthArgs: lengthArgsOf(jobDefaults.lengthCheck),
      ...(custom ? { customSettingsId: custom.settingsId } : {}),
      ...(endpointHealth ? { endpoint: endpointHealth } : {}),
      ...(subscriptionHealthPromise ? await subscriptionHealthPromise : apiKeyHealth(env, ai.provider)),
    };
    return {
      ok: true,
      units: store.units.size,
      editorConnected: deps.bridge.connected > 0,
      pid: process.pid,
      projectDir: deps.projectDir ?? '',
      stale: store.changedOnDisk(),
      // The editor plugin reads this to avoid restarting the service under a running job when the AI settings
      // change. Not `starting` (being estimated, no record yet) — only a real job record.
      jobRunning: [...jobs.values()].some((j) => j.status === 'running'),
      jobsFinished,
      ai: aiHealth,
    };
  });

  // Pull calls this before its first export for every culture, so a translation edited in the archive
  // outside LocHub since the last Push becomes human_edit instead of being overwritten by the export that
  // follows. No unit diff, no tombstones, does not touch lastPush (/api/meta).
  app.post('/api/reconcile', async (request, reply) => {
    // Check freshness before reconcileArchives stages any putCell/appendEvent, not only in the
    // store.save() below — appendEvent is a plain append, so a later 409 would still leave a phantom event.
    store.assertFresh();
    const validationError = validateReconcileBody(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    const { archives } = request.body as { archives: Snapshot['archives'] };
    for (const culture of Object.keys(archives)) {
      if (!cultureGuard(culture, reply)) return;
    }
    const humanEdits = reconcileArchives(store, archives, 'pull');
    store.save();
    return { humanEdits };
  });

  app.post('/api/push', async (request, reply) => {
    // A dry run never stages a write (applySnapshot only touches the store when !dryRun), so it is
    // exempt; a real push must be checked before applySnapshot stages anything.
    const dryRun = (request.query as Record<string, string | undefined>).dryRun === '1';
    if (!dryRun) store.assertFresh();
    const validationError = validateSnapshot(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    const snapshot = request.body as Partial<Snapshot>;
    const full = { archives: {}, cultures: [], nativeCulture: 'en', target: '', ...snapshot } as Snapshot;
    for (const culture of [...Object.keys(full.archives), ...Object.keys(full.pluralForms ?? {})]) {
      if (!cultureGuard(culture, reply)) return;
    }
    const report = applySnapshot(store, full, 'push', { dryRun });
    if (dryRun) return report;
    if (Array.isArray(full.coverage)) coverage = { pushedAt: new Date().toISOString(), findings: full.coverage };
    lastPush = {
      nativeCulture: typeof full.nativeCulture === 'string' ? full.nativeCulture : '',
      cultures: Array.isArray(full.cultures) ? full.cultures.filter((c): c is string => typeof c === 'string') : [],
    };
    store.save();
    return report;
  });

  app.get('/api/cells', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const culture = q.culture;
    if (!cultureGuard(culture, reply)) return;
    const needle = q.q?.toLowerCase();
    const rows = [...store.units.values()]
      .filter((unit) => unit.state === 'active')
      .sort((a, b) => compareCodeUnits(a.id, b.id))
      .map((unit) => {
        const cell = store.getCell(culture, unit.id);
        return { unit, cell, outdated: isOutdated(unit, cell) };
      })
      .filter(
        (row) =>
          (!q.band || row.cell.band === q.band) &&
          (!q.status || row.cell.status === q.status) &&
          (!q.flag || row.cell.qaFlags.includes(q.flag)) &&
          (!q.groupKey || row.unit.groupKey === q.groupKey) &&
          (q.outdated !== '1' || row.outdated) &&
          (!needle || row.unit.source.toLowerCase().includes(needle) || row.cell.text.toLowerCase().includes(needle)),
      );
    const limit = intParam(q.limit, 200, 1, 1000);
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    // Only for the page returned: every page request would otherwise measure every unit of the project again.
    const page = rows.slice(offset, offset + limit).map((row) => ({ ...row, lengthLimit: lengthLimitFor(row.unit, culture, jobDefaults.lengthCheck) }));
    return { total: rows.length, rows: page };
  });

  app.post('/api/cells/:culture/:unitId/:action', async (request, reply) => {
    // approve/edit/reject stage a putCell/appendEvent via cells.ts's commit() before store.save().
    store.assertFresh();
    const { culture, unitId, action } = request.params as { culture: string; unitId: string; action: string };
    if (!cultureGuard(culture, reply)) return;
    const body = (request.body ?? {}) as { text?: unknown; note?: unknown; actor?: unknown; expectedRevision?: unknown; expectedSourceRev?: unknown; accept?: unknown };
    // Optimistic concurrency. Both fields are optional; present-but-wrong-type is a 400, and the check
    // itself (a mismatch -> 409 stale_cell) runs inside approve/edit/rejectCell, after assertFresh() above
    // and before any of them stage a write.
    const expectedError = validateExpected(body) ?? validateAccept(body);
    if (expectedError) return reply.code(400).send({ error: expectedError });
    // The confirm issue codes the reviewer approves anyway (check tiers); approve/edit refuse a confirm issue it misses.
    const accept = (body.accept as string[] | undefined) ?? [];
    const expected =
      body.expectedRevision !== undefined || body.expectedSourceRev !== undefined
        ? { revision: body.expectedRevision as number | undefined, sourceRev: body.expectedSourceRev as number | undefined }
        : undefined;
    const actor = typeof body.actor === 'string' ? body.actor : 'reviewer';
    try {
      let cell: Cell;
      if (action === 'approve') cell = approveCell(store, culture, unitId, actor, expected, accept, jobDefaults.lengthCheck);
      else if (action === 'edit') {
        if (typeof body.text !== 'string') return reply.code(400).send({ error: 'text is required' });
        cell = editCell(store, culture, unitId, body.text, actor, expected, accept, jobDefaults.lengthCheck);
      } else if (action === 'reject') cell = rejectCell(store, culture, unitId, typeof body.note === 'string' ? body.note : '', actor, expected);
      else return reply.code(404).send({ error: `Unknown action ${action}` });
      store.save();
      return { cell };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });

  app.get('/api/export', async (request, reply) => {
    const culture = (request.query as Record<string, string | undefined>).culture;
    if (!cultureGuard(culture, reply)) return;
    return { culture, policy: deps.policy, entries: exportForPull(store, culture, deps.policy) };
  });

  app.post('/api/export/ack', async (request, reply) => {
    // applyExportAck stages putCell/appendEvent before store.save().
    store.assertFresh();
    if (!cultureGuard((request.body as { culture?: unknown } | null)?.culture, reply)) return;
    const validationError = validateAck(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    applyExportAck(store, request.body as ExportAck);
    store.save();
    return { ok: true };
  });

  app.post('/api/jobs', async (request, reply) => {
    const body = (request.body ?? {}) as JobRequestBody;
    const opts = jobOptionsFrom(body, jobDefaults);
    if (!opts) return reply.code(400).send({ error: 'culture is required' });
    const scopeError = validateJobScope(body);
    if (scopeError) return reply.code(400).send({ error: scopeError });
    if (opts.mode === 'batch' && !supportsBatch(ai)) return reply.code(400).send({ error: 'batch_unavailable', message: BATCH_UNAVAILABLE_MESSAGE });
    // A missing API key must fail the request, not the job — before any LLM call. Estimating below
    // calls the model to count tokens only for Anthropic with an API key; every other provider estimates
    // locally (approxInputTokens), which is exactly why a missing key used to fail the job silently instead of
    // this request. Subscription keeps its current path.
    if (ai.auth === 'api') {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: 'ai_not_ready', message: health.detail });
    }
    // skipEstimate (estimate-speed-brief.md §3): the job starts with no provider calls at all, so maxUsd is
    // ignored entirely — not required, not validated, not enforced (CONTRACT.md documents this). Every other
    // gate below (culture, job_running, scope, batch, ai_not_ready above) still applies.
    const skipEstimate = body.skipEstimate === true;
    // Reject a present-but-invalid maxUsd before any token counting, distinct from the "absent" case
    // handled below (culture and maxUsd are required), which only applies once billing/usd are known.
    if (!skipEstimate && body.maxUsd !== undefined && !(typeof body.maxUsd === 'number' && Number.isFinite(body.maxUsd) && body.maxUsd > 0)) {
      return reply.code(400).send({ error: 'invalid_maxUsd', message: 'maxUsd must be a finite positive number' });
    }
    if (!cultureGuard(opts.culture, reply)) return;
    const culture = opts.culture;
    // The 409 carries the running job's id so the web can show that job instead of only the message (job
    // resume) — except while it is still `starting`, where no record exists yet to point to.
    if (starting.has(culture)) return reply.code(409).send({ error: 'job_running' });
    const runningJob = [...jobs.values()].find((j) => j.culture === culture && j.status === 'running');
    if (runningJob) return reply.code(409).send({ error: 'job_running', jobId: runningJob.id });
    starting.add(culture);
    try {
      const estimate = await estimateJob(
        store,
        deps.llm,
        deps.cache,
        opts,
        billingOf(ai),
        skipEstimate ? { skipNetwork: true } : { countCache: estimateCountCache },
      );
      // The subscription is not billed per token, an unpriced model has no usd figure to check against, and a
      // scope priced at exactly $0 (TM reuse and cached answers only; no translate cost is estimated, judging may
      // still run) has nothing a budget could refuse: all three carry no maxUsd requirement and skip the budget
      // check below. skipEstimate skips it too — its estimate is only a local approxInputTokens guess, never a
      // real count to hold a budget against.
      if (!skipEstimate && billingOf(ai) === 'api' && estimate.usd !== null && estimate.usd !== 0) {
        if (typeof body.maxUsd !== 'number') return reply.code(400).send({ error: 'culture and maxUsd are required' });
        try {
          assertWithinBudget(estimate, body.maxUsd);
        } catch (error) {
          if (error instanceof BudgetExceededError) return reply.code(422).send({ error: 'budget', message: error.message, estimate });
          throw error;
        }
      }
      const record: JobRecord = { id: randomUUID(), culture, status: 'running', estimate, startedAt: new Date().toISOString() };
      jobs.set(record.id, record);
      // The job's own onProgress just updates this record; GET /api/jobs/:id and ?culture= read it back.
      opts.onProgress = (progress) => {
        record.progress = progress;
      };
      runTranslateJob(store, deps.llm, deps.cache, opts)
        .then((report) => {
          record.status = 'done';
          record.report = report;
          jobsFinished++;
        })
        .catch((error: unknown) => {
          record.status = 'failed';
          record.error = error instanceof Error ? error.message : String(error);
          jobsFinished++;
        });
      return reply.code(202).send({ jobId: record.id, estimate });
    } finally {
      starting.delete(culture);
    }
  });

  // Job resume. The newest job record of the culture — running first, else the most recently started
  // finished/failed one — so a view that lost its job id (e.g. remounted after a tab switch) can find it again.
  app.get('/api/jobs', async (request, reply) => {
    const culture = (request.query as Record<string, string | undefined>).culture;
    if (!cultureGuard(culture, reply)) return;
    const records = [...jobs.values()].filter((j) => j.culture === culture);
    const running = records.find((j) => j.status === 'running');
    const newest = running ?? records.reduce<JobRecord | undefined>((best, j) => (!best || j.startedAt >= best.startedAt ? j : best), undefined);
    return newest ?? reply.code(404).send({ error: 'Unknown job' });
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const record = jobs.get((request.params as { id: string }).id);
    return record ?? reply.code(404).send({ error: 'Unknown job' });
  });

  app.get('/api/glossary/:culture', async (request, reply) => {
    const { culture } = request.params as { culture: string };
    if (!cultureGuard(culture, reply)) return;
    return store.glossary.get(culture) ?? [];
  });

  app.put('/api/glossary/:culture', async (request, reply) => {
    // Stages store.glossary.set() before store.save().
    store.assertFresh();
    const { culture } = request.params as { culture: string };
    if (!cultureGuard(culture, reply)) return;
    const terms = request.body as GlossaryTerm[] | null;
    if (!Array.isArray(terms)) return reply.code(400).send({ error: 'Body must be an array of terms' });
    const valid = terms.every(
      (t) => t !== null && typeof t === 'object' && typeof t.term === 'string' && t.term !== '' &&
        typeof t.translation === 'string' && typeof t.dnt === 'boolean' && typeof t.note === 'string',
    );
    if (!valid) return reply.code(400).send({ error: 'Each term needs term, translation, dnt and note' });
    store.glossary.set(culture, terms);
    store.save();
    return { ok: true };
  });

  app.get('/api/bridge/stream', (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const detach = attachEditorStream(deps.bridge, (chunk) => reply.raw.write(chunk));
    // The response closes when the editor disconnects; the request's own 'close' only means it was fully read.
    // detach is idempotent (clearInterval and Set.delete), so an 'error' followed by 'close' is harmless.
    reply.raw.on('close', detach);
    reply.raw.on('error', detach);
  });

  app.post('/api/bridge/command', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; args?: unknown };
    if (typeof body.name !== 'string' || !(BRIDGE_COMMANDS as readonly string[]).includes(body.name))
      return reply.code(400).send({ error: 'Unknown command' });
    const args = body.args !== null && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    const delivered = deps.bridge.send({ name: body.name as BridgeCommandName, args });
    if (delivered === 0) return reply.code(409).send({ error: 'editor_not_connected' });
    return reply.code(202).send({ delivered });
  });

  app.get('/api/coverage', async () => coverage);

  app.post('/api/jobs/estimate', async (request, reply) => {
    const body = (request.body ?? {}) as JobRequestBody;
    const opts = jobOptionsFrom(body, jobDefaults);
    if (!opts) return reply.code(400).send({ error: 'culture is required' });
    const scopeError = validateJobScope(body);
    if (scopeError) return reply.code(400).send({ error: scopeError });
    if (opts.mode === 'batch' && !supportsBatch(ai)) return reply.code(400).send({ error: 'batch_unavailable', message: BATCH_UNAVAILABLE_MESSAGE });
    // Same ai_not_ready gate as POST /api/jobs. Estimating calls the model to count tokens only for
    // Anthropic with an API key; every other provider estimates locally, but a bad key must still fail this
    // request rather than let the job start.
    if (ai.auth === 'api') {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: 'ai_not_ready', message: health.detail });
    }
    if (!cultureGuard(opts.culture, reply)) return;
    return { estimate: await estimateJob(store, deps.llm, deps.cache, opts, billingOf(ai), { countCache: estimateCountCache }) };
  });

  // Static segments win over parameters in Fastify routing, so this does not reach the generic :action route.
  app.post('/api/cells/:culture/:unitId/retranslate', async (request, reply) => {
    const { culture, unitId } = request.params as { culture: string; unitId: string };
    if (!cultureGuard(culture, reply)) return;
    // Same ai_not_ready gate as POST /api/jobs and /api/jobs/estimate (I-1): a missing key must fail this
    // request, not reach retranslateWithNote's model call with none.
    if (ai.auth === 'api') {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: 'ai_not_ready', message: health.detail });
    }
    const body = (request.body ?? {}) as { note?: unknown; asRule?: unknown };
    if (typeof body.note !== 'string') return reply.code(400).send({ error: 'note is required' });
    try {
      // Before the paid model call: a stale store would refuse the write afterwards anyway.
      store.assertFresh();
      return await retranslateWithNote(store, deps.llm, { ...jobDefaults, culture }, unitId, body.note, body.asRule === true);
    } catch (error) {
      return sendCellError(reply, error);
    }
  });

  app.get('/api/cells/:culture/:unitId/history', async (request, reply) => {
    const { culture, unitId } = request.params as { culture: string; unitId: string };
    if (!cultureGuard(culture, reply)) return;
    return store.readEvents(culture, unitId);
  });

  // Live format check for the review card: read-only, runs exactly the precheck approve/edit run (checkCell),
  // so the reviewer sees why a draft would be refused before they click. No store write, no event, no
  // freshness requirement.
  app.post('/api/cells/:culture/:unitId/check', async (request, reply) => {
    const { culture, unitId } = request.params as { culture: string; unitId: string };
    if (!cultureGuard(culture, reply)) return;
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') return reply.code(400).send({ error: 'text is required' });
    try {
      return { issues: checkCell(store, culture, unitId, body.text, jobDefaults.lengthCheck) };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });

  // Translation exchange (CONTRACT.md): a translator's CSV/XLIFF strings, parsed by the web app. A dry run only
  // reports; an apply writes every applied row in one save (runImport).
  app.post('/api/import', async (request, reply) => {
    try {
      const body = parseImportRequest(request.body);
      if (!cultureGuard(body.culture, reply)) return;
      if (!translationCultures().has(body.culture)) return reply.code(400).send({ error: `${body.culture} is not a translation culture of this project` });
      // A dry run never stages a write (runImport only touches the store when !dryRun), so it is exempt, like Push's
      // own dry run; a real import must be checked before runImport stages anything (server.ts's edit/approve/reconcile
      // routes check the same way before their own writes).
      if (!body.dryRun) store.assertFresh();
      // Exactly the call the /check route makes, so an import can never pass a text Save would refuse.
      const check: TranslationCheck = (unit, text) => checkCell(store, body.culture, unit.id, text, jobDefaults.lengthCheck);
      return runImport(store, body, check);
    } catch (error) {
      if (error instanceof ImportRequestError) return reply.code(400).send({ error: error.message });
      if (error instanceof ImportPreviewStaleError) return reply.code(409).send({ error: 'preview_stale', message: error.message, result: error.result });
      throw error;
    }
  });

  app.get('/api/style/:culture', async (request, reply) => {
    const { culture } = request.params as { culture: string };
    if (!cultureGuard(culture, reply)) return;
    return { text: store.style.get(culture) ?? '' };
  });

  app.put('/api/style/:culture', async (request, reply) => {
    // Stages store.style.set() before store.save().
    store.assertFresh();
    const { culture } = request.params as { culture: string };
    if (!cultureGuard(culture, reply)) return;
    const body = (request.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string') return reply.code(400).send({ error: 'text is required' });
    store.style.set(culture, body.text);
    store.save();
    return { ok: true };
  });

  // The plugin reads answered items on Pull, writes them into DevNotes and reports them back as applied.
  app.get('/api/inbox', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q.culture !== undefined && !cultureGuard(q.culture, reply)) return;
    const rows = [...store.inbox.values()]
      .filter((item) => (!q.status || item.status === q.status) && (!q.culture || item.culture === q.culture))
      .sort((a, b) => compareCodeUnits(a.created, b.created) || compareCodeUnits(a.id, b.id))
      .map((item) => {
        const unit = store.units.get(item.unitId);
        return {
          item,
          unit: unit ? { namespace: unit.namespace, key: unit.key, source: unit.source, origin: unit.origin, devNotes: unit.devNotes } : null,
        };
      });
    return { rows };
  });

  app.post('/api/inbox/applied', async (request, reply) => {
    // markApplied stages inbox item writes before store.save().
    store.assertFresh();
    const body = (request.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids)) return reply.code(400).send({ error: 'ids[] is required' });
    const applied = markApplied(store, body.ids.filter((id): id is string => typeof id === 'string'));
    store.save();
    return { applied };
  });

  app.post('/api/inbox/:id/:action', async (request, reply) => {
    // answerQuestion/dismissQuestion stage inbox item writes before store.save().
    store.assertFresh();
    const { id, action } = request.params as { id: string; action: string };
    const body = (request.body ?? {}) as { answer?: unknown };
    try {
      let item: InboxItem;
      if (action === 'answer') item = answerQuestion(store, id, typeof body.answer === 'string' ? body.answer : '', new Date().toISOString());
      else if (action === 'dismiss') item = dismissQuestion(store, id);
      else return reply.code(404).send({ error: `Unknown action ${action}` });
      store.save();
      return { item };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });

  app.get('/api/summary', async (request, reply) => {
    const culture = (request.query as Record<string, string | undefined>).culture;
    if (!cultureGuard(culture, reply)) return;
    return summarize(store, culture);
  });

  // Cultures of the last Push plus every culture that already has cells, so the list survives a service restart.
  // Only spellings the culture guard accepts are listed: the web app loads every listed culture, and one 400 (a pushed
  // "FR" next to a stored "fr", or a malformed code) would fail the whole grid.
  app.get('/api/meta', async () => {
    const usable = [...translationCultures()].filter((culture) => checkCulture(store, culture) === null);
    return { nativeCulture: lastPush.nativeCulture, cultures: usable.sort(compareCodeUnits) };
  });

  // A reviewer's "needs context" (queue key N) lands in the inbox next to the model's own questions.
  app.post('/api/inbox', async (request, reply) => {
    // recordQuestion stages an inbox item write before store.save().
    store.assertFresh();
    const body = (request.body ?? {}) as { culture?: unknown; unitId?: unknown; question?: unknown };
    if (!cultureGuard(body.culture, reply)) return;
    if (typeof body.unitId !== 'string' || typeof body.question !== 'string')
      return reply.code(400).send({ error: 'unitId and question are required' });
    if (!store.units.has(body.unitId)) return reply.code(404).send({ error: `Unknown unit ${body.unitId}` });
    const item = recordQuestion(store, body.culture, body.unitId, body.question, 'reviewer', new Date().toISOString());
    if (!item) return reply.code(422).send({ error: 'Question is empty' });
    store.save();
    return reply.code(201).send({ item });
  });

  if (deps.webRoot) registerWebApp(app, deps.webRoot, deps.webDepsRoot);

  return app;
}
