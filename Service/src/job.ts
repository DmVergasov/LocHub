import type Anthropic from '@anthropic-ai/sdk';
import { resolveWithCache, type ResponseCache } from './cache.js';
import { precheckOptionsFor } from './cells.js';
import { keepAudit, type Ambiguity, type Band, type Culture, type JudgeIssue } from './contract.js';
import { buildGroups, neighborsOf, selectWork, type WorkGroup, type WorkItem } from './grouping.js';
import { requestId, type LlmClient, type LlmOutcome, type LlmRequest } from './llm.js';
import { LENGTH_CHECK_OFF, lengthLimitFor, type LengthCheckConfig } from './lengthCheck.js';
// isTimeoutMessage: every adapter that reports a timed-out request builds its message with llmShared.ts's
// timeoutMessage, so a slow group is split like a max_tokens truncation instead of being retried whole for the
// job's full retry budget -- recognized here without importing any provider's adapter (NB-4).
import { isTimeoutMessage, redactSecrets } from './llmShared.js';
import { answersByUnit, buildTmIndex, recordQuestion, type TmMatch } from './memory.js';
import { blocksAutoAccept, precheck, TOO_LONG_CODE, type PrecheckIssue } from './precheck.js';
import { buildJudgeParams, buildTranslateParams, PROMPT_VERSION, type CultureContext, type RepairInfo } from './prompt.js';
import type { LocHubStore } from './store.js';
import { bandFor, isAuditSample } from './triage.js';

// Reported while a job runs. Units are strings, not requests/groups. See job.ts's
// runTranslateJob for the exact meaning of done/total in each phase, and CONTRACT.md's Jobs section.
export interface JobProgress {
  phase: 'translate' | 'repair' | 'judge' | 'write';
  done: number;
  total: number;
}

export interface JobOptions {
  culture: Culture;
  mode: 'sync' | 'batch';
  translateModel: string;
  judgeModel: string;
  // Project-wide brief (Project Settings > Plugins > LocHub > AI > Project Brief, cli.ts's --brief-file):
  // service config, not store data. cultureContext reads it from here, not from the store.
  brief: string;
  groupSize: number;
  concurrency: number;
  pollMs: number;
  maxRepairRounds: number;
  auditPercent: number;
  actor: string;
  // Length Check (Project Settings > Plugins > LocHub > Length Check, cli.ts's --length-* flags): service config, like
  // `brief`. Off unless the editor passed the flags.
  lengthCheck: LengthCheckConfig;
  // Custom endpoints only (providers.ts jobDefaultsFor): the Project Settings prices in USD per 1M tokens, used for
  // both the translate and the judge model instead of PRICES_PER_MTOK (estimate.ts).
  customPrice?: { input: number; output: number };
  filter?: { groupKey?: string; groupPrefix?: string; unitIds?: string[] };
  onProgress?: (progress: JobProgress) => void;
}

export type JobDefaults = Omit<JobOptions, 'culture' | 'filter'>;

export const DEFAULT_JOB_OPTIONS: JobDefaults = {
  mode: 'sync',
  translateModel: 'claude-opus-5-5',
  judgeModel: 'claude-sonnet-5',
  brief: '',
  groupSize: 40,
  concurrency: 8,
  pollMs: 60_000,
  maxRepairRounds: 2,
  auditPercent: 4,
  actor: 'ai',
  lengthCheck: LENGTH_CHECK_OFF,
};

export interface JobReport {
  culture: Culture;
  requested: number;
  tm: number;
  written: number;
  suggestions: number;
  needsFix: number;
  refused: number;
  errors: number;
  questions: number;
  bands: { R: number; Y: number; G: number };
  // Tokens of every answer used by the job, cached answers included.
  inputTokens: number;
  outputTokens: number;
  // Up to 3 distinct error messages, the last one seen for each string counted in `errors`, first seen first,
  // truncated to 300 characters and passed through redactSecrets: a misconfigured provider must surface a
  // reason a reviewer can act on, not just an inflated Review count. Also carries a judge failure's reason,
  // prefixed "Judge: " — that string is not itself counted in `errors`.
  errorSamples: string[];
}

interface TranslatedItem {
  translation: string;
  ambiguity: Ambiguity;
  alts: string[];
  question: string;
}

export interface PlannedWork {
  ctx: CultureContext;
  // `issues` is the donor text's precheck against this unit: never blocking (planWork already excludes a
  // blocking donor), but a soft too_long must still reach the written cell (see runTranslateJob step 0).
  tmHits: { item: WorkItem; match: TmMatch; issues: PrecheckIssue[] }[];
  groups: WorkGroup[];
}

const MAX_NEIGHBORS = 20;

const AMBIGUITIES: readonly Ambiguity[] = ['none', 'context', 'guessed'];
const SEVERITIES: readonly JudgeIssue['severity'][] = ['minor', 'major', 'critical'];
const MAX_TRANSLATE_ATTEMPTS = 4;
const MAX_ERROR_SAMPLES = 3;
const MAX_ERROR_SAMPLE_LENGTH = 300;
// Appended to a too_long issue's message in a repair request.
const SHORTEN_INSTRUCTION = 'Shorten it while keeping the meaning, every placeholder and every tag.';

export function cultureContext(store: LocHubStore, culture: Culture, brief: string): CultureContext {
  return {
    culture,
    sourceCulture: store.nativeCulture,
    brief,
    style: store.style.get(culture) ?? '',
    glossary: store.glossary.get(culture) ?? [],
    plurals: { cardinal: store.pluralCategoriesFor(culture, 'cardinal'), ordinal: store.pluralCategoriesFor(culture, 'ordinal') },
  };
}

// Splits the work into exact TM reuse and model groups. Rejected and needs_fix cells always go to the model:
// the reviewer or the engine has already refused a translation for them. A TM donor still has to pass the
// same precheck the model path runs: a donor imported from the archive, or a DNT term added to the
// glossary after the donor was translated, can carry a hard or confirm issue that must not be copied silently.
export function planWork(store: LocHubStore, opts: JobOptions): PlannedWork {
  const tm = buildTmIndex(store, opts.culture);
  const tmHits: PlannedWork['tmHits'] = [];
  const rest: WorkItem[] = [];
  for (const item of selectWork(store, opts.culture, opts.filter)) {
    const eligible = item.cell.status !== 'rejected' && item.cell.status !== 'needs_fix';
    const match = eligible ? tm.get(item.unit.source) : undefined;
    const issues = match ? precheck(item.unit.source, match.text, opts.culture, precheckOptionsFor(store, opts.culture, item.unit, opts.lengthCheck)) : undefined;
    const reusable = match !== undefined && match.donorId !== item.unit.id && !blocksAutoAccept(issues!);
    if (reusable) tmHits.push({ item, match: match!, issues: issues! });
    else rest.push(item);
  }
  return { ctx: cultureContext(store, opts.culture, opts.brief), tmHits, groups: buildGroups(rest, opts.groupSize) };
}

// A group with a needs_fix or rejected cell must reach the model: its cached answer is the one that failed
// or was turned down.
export function bypassesCache(group: WorkGroup): boolean {
  return group.items.some((w) => w.cell.status === 'needs_fix' || w.cell.status === 'rejected');
}

// The single place a translate request is built, shared with the estimate so both compute the same cache key.
export function translateParamsFor(
  store: LocHubStore,
  ctx: CultureContext,
  group: WorkGroup,
  opts: JobOptions,
  repair?: ReadonlyMap<string, RepairInfo>,
): Anthropic.MessageCreateParamsNonStreaming {
  const exclude = new Set(group.items.map((w) => w.unit.id));
  return buildTranslateParams(ctx, group, opts.translateModel, {
    repair,
    neighbors: neighborsOf(store, opts.culture, group.groupKey, exclude, MAX_NEIGHBORS),
    answers: answersByUnit(store),
    maxLength: promptLimits(group, opts),
  });
}

// Tell the Translator (Length Check): each item's limit goes into the request, so the model aims for it up front.
function promptLimits(group: WorkGroup, opts: JobOptions): Map<string, number> {
  const limits = new Map<string, number>();
  if (!opts.lengthCheck.hint) return limits;
  for (const { unit } of group.items) {
    const limit = lengthLimitFor(unit, opts.culture, opts.lengthCheck);
    if (limit !== null) limits.set(unit.id, limit);
  }
  return limits;
}

// A repair request's error line: the precheck message verbatim, plus how to fix an over-limit text.
function repairMessage(issue: PrecheckIssue): string {
  return issue.code === TOO_LONG_CODE ? `${issue.message}. ${SHORTEN_INSTRUCTION}` : issue.message;
}

// Accepts only ids that were asked for, first occurrence wins; anything unparseable counts as missing.
export function parseTranslatedItems(text: string, group: WorkGroup): { items: Map<string, TranslatedItem>; missing: WorkItem[] } {
  const wanted = new Set(group.items.map((w) => w.unit.id));
  const items = new Map<string, TranslatedItem>();
  for (const entry of listField(text, 'items')) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!wanted.has(id) || items.has(id) || typeof entry.translation !== 'string') continue;
    items.set(id, {
      translation: entry.translation,
      ambiguity: AMBIGUITIES.includes(entry.ambiguity as Ambiguity) ? (entry.ambiguity as Ambiguity) : 'guessed',
      alts: Array.isArray(entry.alts) ? entry.alts.filter((a): a is string => typeof a === 'string').slice(0, 3) : [],
      question: typeof entry.question === 'string' ? entry.question : '',
    });
  }
  return { items, missing: group.items.filter((w) => !items.has(w.unit.id)) };
}

export function parseJudgeIssues(text: string, ids: ReadonlySet<string>): Map<string, JudgeIssue[]> | undefined {
  if (!isObjectWithArray(text, 'issues')) return undefined;
  const out = new Map<string, JudgeIssue[]>();
  for (const entry of listField(text, 'issues')) {
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ids.has(id) || !SEVERITIES.includes(entry.severity as JudgeIssue['severity'])) continue;
    const list = out.get(id) ?? [];
    list.push({
      severity: entry.severity as JudgeIssue['severity'],
      category: String(entry.category ?? ''),
      why: String(entry.why ?? ''),
      fix: String(entry.fix ?? ''),
    });
    out.set(id, list);
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObjectWithArray(text: string, field: string): boolean {
  const value = parseJson(text);
  return value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[field]);
}

function listField(text: string, field: string): Record<string, unknown>[] {
  if (!isObjectWithArray(text, field)) return [];
  const list = (parseJson(text) as Record<string, unknown[]>)[field]!;
  return list.filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object');
}

function splitGroup(group: WorkGroup): WorkGroup[] {
  const middle = Math.ceil(group.items.length / 2);
  return [
    { groupKey: group.groupKey, items: group.items.slice(0, middle) },
    { groupKey: group.groupKey, items: group.items.slice(middle) },
  ];
}

// Probe mode (amendment 9): cuts a group into the fewest near-equal pieces of at most `max` strings each.
function capGroup(group: WorkGroup, max: number): WorkGroup[] {
  const count = group.items.length;
  if (count <= max) return [group];
  const pieces = Math.ceil(count / max);
  return Array.from({ length: pieces }, (_, i) => ({
    groupKey: group.groupKey,
    items: group.items.slice(Math.floor((i * count) / pieces), Math.floor(((i + 1) * count) / pieces)),
  }));
}

function isTimeoutOutcome(outcome: LlmOutcome): outcome is Extract<LlmOutcome, { kind: 'error' }> {
  return outcome.kind === 'error' && isTimeoutMessage(outcome.message);
}

function toRequest(params: Anthropic.MessageCreateParamsNonStreaming): LlmRequest {
  return { customId: requestId(params), params };
}

// Which of a translate group's strings this particular outcome settles, mirroring the classification the
// round-processing loop below applies to the same outcome. A group that gets split or retried settles none of
// its strings yet — they are only counted once a later, final outcome covers them. `parsed`, when given, is the
// already-computed parseTranslatedItems result for an 'ok' outcome (the round loop parses the same outcome
// again to build `results`; passing it in avoids parsing outcome.text twice).
function translateSettledIds(outcome: LlmOutcome, group: WorkGroup, parsed?: ReturnType<typeof parseTranslatedItems>): string[] {
  // Never sent: its group waits for a later round.
  if (outcome.kind === 'skipped') return [];
  if (outcome.kind === 'ok') return [...(parsed ?? parseTranslatedItems(outcome.text, group)).items.keys()];
  // I-1: a timed-out request gets the same split-not-retry-whole treatment as a max_tokens truncation.
  if (outcome.kind === 'refusal' || (outcome.kind === 'error' && (outcome.message === 'max_tokens' || isTimeoutMessage(outcome.message))))
    return group.items.length > 1 ? [] : [group.items[0]!.unit.id];
  if (outcome.kind === 'error' && outcome.retryable) return [];
  return group.items.map((w) => w.unit.id);
}

export async function runTranslateJob(store: LocHubStore, llm: LlmClient, cache: ResponseCache, opts: JobOptions): Promise<JobReport> {
  const culture = opts.culture;
  const plan = planWork(store, opts);
  const ctx = plan.ctx;
  const work = plan.groups.flatMap((g) => g.items);
  const report: JobReport = {
    culture, requested: work.length + plan.tmHits.length, tm: 0, written: 0, suggestions: 0, needsFix: 0, refused: 0,
    errors: 0, questions: 0, bands: { R: 0, Y: 0, G: 0 }, inputTokens: 0, outputTokens: 0, errorSamples: [],
  };
  if (report.requested === 0) return report;
  const now = new Date().toISOString();

  // 0. Exact TM reuse: the same source text already has a human-confirmed translation; no model call.
  // Check freshness before this batch's first putCell/appendEvent, not only in the store.save()
  // below — appendEvent is a plain append that a later 409 could not undo.
  store.assertFresh();
  for (const { item, match, issues } of plan.tmHits) {
    const cell = store.getCell(culture, item.unit.id);
    // A soft too_long (Warning) donor was still reusable (planWork only excludes a blocking one), but it must
    // surface the same as a fresh draft would: band Y with the issue's code in qaFlags, not a silent band G.
    const tooLong = issues.some((i) => i.code === TOO_LONG_CODE);
    store.putCell({
      ...cell,
      text: match.text,
      status: 'ai_draft',
      basedOnSourceRev: item.unit.sourceRev,
      basedOnSource: item.unit.source,
      provenance: `tm:${match.donorId}`,
      ambiguity: 'none',
      alts: [],
      question: '',
      note: '',
      suggestion: '',
      judgeIssues: [],
      qaFlags: [...keepAudit(cell), 'tm', ...(tooLong ? [TOO_LONG_CODE] : [])],
      band: tooLong ? 'Y' : 'G',
      revision: cell.revision + 1,
    });
    store.appendEvent({ ts: now, unitId: item.unit.id, culture, action: 'tm', actor: opts.actor, before: cell.text, after: match.text });
    report.tm++;
    report.bands[tooLong ? 'Y' : 'G']++;
  }
  // A crash during a long batch must not leave tm events on disk without the cells they describe.
  if (plan.tmHits.length > 0) store.save();
  if (work.length === 0) {
    store.save();
    return report;
  }

  const byId = new Map(work.map((w) => [w.unit.id, w]));
  const startRevision = new Map(work.map((w) => [w.unit.id, w.cell.revision]));
  const results = new Map<string, TranslatedItem>();
  const failed = new Map<string, 'refused' | 'error'>();
  // The last error-outcome message seen for a unit id: populated whenever a group's outcome is a non-'ok',
  // non-refusal error, whether or not it ends up retried again; whatever is set here survives into
  // `report.errorSamples` for every id that finally lands in `failed` with reason 'error'.
  const errorMessages = new Map<string, string>();
  // Request ids that must reach the model: already answered in this job, or known to have produced a failure.
  const seen = new Set<string>();

  const resolve = async (
    requests: LlmRequest[],
    onOutcome?: (outcome: LlmOutcome) => void,
    onBatchProgress?: (finishedRequests: number, totalRequests: number) => void,
    shouldContinue?: () => boolean,
  ): Promise<Map<string, LlmOutcome>> => {
    const outcomes = await resolveWithCache(llm, cache, requests, {
      mode: opts.mode, concurrency: opts.concurrency, pollMs: opts.pollMs, fresh: seen, onOutcome, onBatchProgress, shouldContinue,
    });
    // A skipped request was never sent: neither answered nor a known failure, so it does not join `seen`.
    for (const r of requests) if (outcomes.get(r.customId)?.kind !== 'skipped') seen.add(r.customId);
    for (const o of outcomes.values()) {
      if (o.kind !== 'ok') continue;
      report.inputTokens += o.inputTokens;
      report.outputTokens += o.outputTokens;
    }
    return outcomes;
  };

  // Job progress. translateDone only ever grows (a Set survives across retry/split rounds, so a string
  // is not counted twice and a still-pending one is not counted at all); onProgress itself is clamped to a
  // high-water mark so a coarse batch-mode estimate (below) can never make done step backwards once the
  // round's real outcomes replace it.
  const onProgress = opts.onProgress;
  const translateTotal = work.length;
  const translateSettled = new Set<string>();
  let translateHighWater = 0;
  const reportTranslate = (done: number) => {
    translateHighWater = Math.max(translateHighWater, Math.min(done, translateTotal));
    onProgress?.({ phase: 'translate', done: translateHighWater, total: translateTotal });
  };
  const markTranslateSettled = (ids: readonly string[]) => {
    let changed = false;
    for (const id of ids) if (!translateSettled.has(id)) { translateSettled.add(id); changed = true; }
    if (changed) reportTranslate(translateSettled.size);
  };
  // An initial 0 event lets a client show the phase and its total before the first answer arrives.
  reportTranslate(0);

  // 1. Translate. Refused, truncated or timed-out groups are split; missing ids and transient errors are retried.
  // Splitting must not eat the retry budget: bound the loop to the fixed retry budget plus enough rounds to
  // halve the default group size down to a single string.
  const maxTranslateRounds = MAX_TRANSLATE_ATTEMPTS + Math.ceil(Math.log2(Math.max(2, opts.groupSize)));
  // Per unit id, why its group was last sent back: used to classify a leftover if the loop still runs out.
  const lastReason = new Map<string, 'refused' | 'error'>();
  // Probe mode (amendment 9): an endpoint that has answered nothing in this job and then times out is probed, not
  // flooded. `answered` turns true with the first 'ok' outcome (a cache hit included); `probing` with the first
  // timeout that lands before it, and back to false in the round that brings that first answer. While a round
  // has seen such a timeout, its requests that have not started yet are not sent (runSync's shouldContinue
  // declines them: 'skipped'); after the round, the next one sends only the two halves of the largest group that
  // timed out, and every other group -- skipped, timed out or otherwise sent back -- waits in `held`, unchanged.
  // The first answer releases everything that waited, cut into pieces no larger than the largest group that was
  // answered, and the job goes on under the normal rules. A single string that times out before any answer stops
  // the job. So a hung endpoint costs about (1 + split depth) timeouts per parallel slot, not 2N-1 per group.
  let answered = false;
  let probing = false;
  let largestAnswered = 0;
  let held: WorkGroup[] = [];
  let pending = plan.groups;
  // A probe round halves one group, so probe rounds are bounded by the split depth and use none of this budget.
  let budgetUsed = 0;
  for (let round = 0; pending.length > 0 && budgetUsed < maxTranslateRounds; round++) {
    const requests = pending.map((group) => ({ group, request: toRequest(translateParamsFor(store, ctx, group, opts)) }));
    for (const { group, request } of requests) if (bypassesCache(group)) seen.add(request.customId);
    const groupByCustomId = new Map(requests.map((r) => [r.request.customId, r.group]));
    // 'ok' outcomes parsed once in onOutcome below and reused here by the round loop instead of re-parsing.
    const parsedByCustomId = new Map<string, ReturnType<typeof parseTranslatedItems>>();
    // Batch mode only: a coarse, proportional estimate of this round's progress while its one poll is still
    // running — how many of the round's strings the succeeded-request fraction implies, added on top of
    // whatever this round already settled from the cache before the batch even started polling. Capped below
    // the round's own remaining count: a refused/errored request can reach a terminal state (finished = total)
    // without settling anything, so the estimate alone must never claim the round complete — only the round's
    // real outcomes, processed below once the batch is fully collected, can do that.
    const roundItemsTotal = pending.reduce((sum, g) => sum + g.items.length, 0);
    const settledBeforeRound = translateSettled.size;
    let roundRemaining: number | undefined;
    // Set by a timeout that lands before any answer: this round's requests that have not started yet are held.
    let roundStalled = false;
    const outcomes = await resolve(
      requests.map((r) => r.request),
      (outcome) => {
        const group = groupByCustomId.get(outcome.customId)!;
        if (outcome.kind === 'ok') {
          answered = true;
          largestAnswered = Math.max(largestAnswered, group.items.length);
        } else if (!answered && isTimeoutOutcome(outcome)) {
          roundStalled = true;
          probing = true;
          // Not final either way: the group is probed, held or stops the job (below), so it settles nothing yet.
          return;
        }
        const parsed = outcome.kind === 'ok' ? parseTranslatedItems(outcome.text, group) : undefined;
        if (parsed) parsedByCustomId.set(outcome.customId, parsed);
        markTranslateSettled(translateSettledIds(outcome, group, parsed));
      },
      (succeeded, total) => {
        if (roundRemaining === undefined) roundRemaining = roundItemsTotal - (translateSettled.size - settledBeforeRound);
        const cap = Math.max(0, roundRemaining - 1);
        const estimate = Math.min(cap, Math.floor((roundRemaining * succeeded) / Math.max(1, total)));
        reportTranslate(translateSettled.size + estimate);
      },
      () => !roundStalled,
    );
    // A misconfigured provider (bad model id, invalid key, no credit) makes every request of a round fail the
    // same way. When that happens on the very first round — before any cell has been touched — the job aborts
    // outright instead of writing a grid of unexplained `needs_fix`/`llm_error` cells: TM reuse above already
    // saved, so that part of the job's work is not lost.
    if (round === 0 && requests.length > 0) {
      const roundOutcomes = requests.map((r) => outcomes.get(r.request.customId)!);
      const firstHardError = roundOutcomes.find((o): o is Extract<LlmOutcome, { kind: 'error' }> => o.kind === 'error' && !o.retryable);
      if (firstHardError && roundOutcomes.every((o) => o.kind === 'error' && !o.retryable)) {
        throw new Error(redactSecrets(firstHardError.message));
      }
    }
    const retry: WorkGroup[] = [];
    // Probe mode: groups this round never sent, and groups that timed out before any answer in the job.
    const skipped: WorkGroup[] = [];
    const timedOut: { group: WorkGroup; message: string }[] = [];
    for (const { group, request } of requests) {
      const outcome = outcomes.get(request.customId)!;
      if (outcome.kind === 'skipped') {
        skipped.push(group);
      } else if (!answered && isTimeoutOutcome(outcome)) {
        for (const w of group.items) { lastReason.set(w.unit.id, 'error'); errorMessages.set(w.unit.id, outcome.message); }
        timedOut.push({ group, message: outcome.message });
      } else if (outcome.kind === 'ok') {
        const parsed = parsedByCustomId.get(request.customId)!;
        for (const [id, item] of parsed.items) results.set(id, item);
        if (parsed.missing.length > 0) {
          // Overwrites whatever an earlier, non-final round left in errorMessages for these ids: an answer that
          // comes back but still leaves an id out is itself the id's latest reason, however that id's group
          // failed before.
          for (const w of parsed.missing) errorMessages.set(w.unit.id, 'The model returned no translation for this string.');
          retry.push({ groupKey: group.groupKey, items: parsed.missing });
        }
      } else if (outcome.kind === 'refusal' || (outcome.kind === 'error' && (outcome.message === 'max_tokens' || isTimeoutMessage(outcome.message)))) {
        // I-1: a timed-out group is split exactly like a max_tokens truncation instead of being requeued whole --
        // a whole-group retry would simply time out again, and job.ts's own round budget would otherwise let a
        // slow Custom endpoint retry the same group for ~30 fetch attempts (fetchWithRetry's own 3, times up to
        // 10 translate rounds) before the job ever gives up on it.
        const reason = outcome.kind === 'refusal' ? 'refused' : 'error';
        for (const w of group.items) lastReason.set(w.unit.id, reason);
        if (outcome.kind === 'error') for (const w of group.items) errorMessages.set(w.unit.id, outcome.message);
        if (group.items.length > 1) retry.push(...splitGroup(group));
        else {
          failed.set(group.items[0]!.unit.id, reason);
          // Already settled by onOutcome, except a timeout that landed before this round's first answer.
          markTranslateSettled([group.items[0]!.unit.id]);
        }
      } else if (outcome.kind === 'error' && outcome.retryable) {
        for (const w of group.items) { lastReason.set(w.unit.id, 'error'); errorMessages.set(w.unit.id, outcome.message); }
        retry.push(group);
      } else {
        for (const w of group.items) { failed.set(w.unit.id, 'error'); errorMessages.set(w.unit.id, outcome.message); }
      }
    }
    if (timedOut.length > 0) {
      // Probe step (only reached with no answer in the job yet): halve the largest group that timed out, hold the
      // rest. Its message is also the latest reason of every held string that was never sent.
      const probe = timedOut.reduce((largest, t) => (t.group.items.length > largest.group.items.length ? t : largest));
      // Even one string cannot finish in time and nothing has answered: stop, like the first-round abort above.
      if (probe.group.items.length === 1) throw new Error(redactSecrets(probe.message));
      for (const group of skipped) for (const w of group.items) { lastReason.set(w.unit.id, 'error'); errorMessages.set(w.unit.id, probe.message); }
      held.push(...skipped, ...retry, ...timedOut.filter((t) => t !== probe).map((t) => t.group));
      pending = splitGroup(probe.group);
      continue;
    }
    // Skipped groups here mean an answer landed after the round stalled: they go back like any other retry.
    retry.push(...skipped);
    if (probing && answered) {
      // The first answer after a stall: release everything that waited, cut down to the size that just worked.
      pending = [...retry, ...held].flatMap((group) => capGroup(group, largestAnswered));
      held = [];
      probing = false;
    } else if (retry.length === 0 && held.length > 0) {
      // Every probed string ended for good without an answer (a hard error, a refusal): nothing is left to
      // probe, so the held groups go out as they are; a timeout among them re-enters the probe step.
      pending = held;
      held = [];
    } else {
      pending = retry;
    }
    budgetUsed++;
  }
  for (const group of [...pending, ...held])
    for (const w of group.items) if (!results.has(w.unit.id) && !failed.has(w.unit.id)) failed.set(w.unit.id, lastReason.get(w.unit.id) ?? 'error');
  // Every string in `work` is now in `results` or `failed` (the loop above forces the retry budget's own
  // leftovers into `failed`) — settle whatever a group's own outcome had not already, so translate always ends
  // at done === total even when the retry budget ran out.
  markTranslateSettled(work.map((w) => w.unit.id));

  // 2. Deterministic precheck with repair passes; errors go back to the model verbatim. The AI gate is
  // blocksAutoAccept, not hasHardIssues: a 'confirm' issue a human may approve anyway still sends an AI draft to
  // repair and, if it survives, to needs_fix (nothing suspicious ships on its own).
  const checks = new Map<string, PrecheckIssue[]>();
  // `ids`, when given, rechecks only those ids (used after a repair round restores a handful of pre-repair
  // texts) instead of re-running precheck over every string in the job.
  const recheck = (ids?: Iterable<string>) => {
    for (const id of ids ?? results.keys()) {
      const item = results.get(id);
      if (!item) continue;
      const { unit } = byId.get(id)!;
      checks.set(id, precheck(unit.source, item.translation, culture, precheckOptionsFor(store, culture, unit, opts.lengthCheck)));
    }
  };
  recheck();
  // A soft too_long (Length Check: Warning) never blocks a draft, but is worth one repair attempt per job: the model is
  // asked for a shorter wording. Other soft issues are never repaired.
  const lengthRepaired = new Set<string>();
  const tooLong = (id: string) => checks.get(id)!.some((i) => i.code === TOO_LONG_CODE);
  for (let round = 0; round < opts.maxRepairRounds; round++) {
    const broken = [...results.keys()].filter((id) => blocksAutoAccept(checks.get(id)!) || (tooLong(id) && !lengthRepaired.has(id)));
    if (broken.length === 0) break;
    // A repair must never turn a good draft worse: for every id that did not block auto-accept before this
    // round (a soft-only too_long sent for an optional shortening), keep its pre-repair translation so it can
    // be restored if the round's answer makes it worse (drops a placeholder, a DNT term, a plural form...).
    const safeBefore = broken.filter((id) => !blocksAutoAccept(checks.get(id)!));
    const previousItems = new Map(safeBefore.map((id) => [id, results.get(id)!]));
    for (const id of broken) if (tooLong(id)) lengthRepaired.add(id);
    // Total is scoped to this round, not accumulated across rounds — a string still broken after this
    // round reappears in the next round's (smaller, or equal) total rather than carrying its count forward.
    const repairTotal = broken.length;
    let repairDone = 0;
    const repair = new Map<string, RepairInfo>(
      broken.map((id) => [
        id,
        { previous: results.get(id)!.translation, errors: checks.get(id)!.filter((i) => i.severity !== 'soft' || i.code === TOO_LONG_CODE).map(repairMessage) },
      ]),
    );
    const groups = buildGroups(broken.map((id) => byId.get(id)!), opts.groupSize);
    const requests = groups.map((group) => ({ group, request: toRequest(translateParamsFor(store, ctx, group, opts, repair)) }));
    const repairGroupByCustomId = new Map(requests.map((r) => [r.request.customId, r.group]));
    // Repairs always reach the model: an identical repair cached by an earlier job produced this very failure.
    for (const { request } of requests) seen.add(request.customId);
    onProgress?.({ phase: 'repair', done: 0, total: repairTotal });
    const outcomes = await resolve(requests.map((r) => r.request), (outcome) => {
      repairDone += repairGroupByCustomId.get(outcome.customId)!.items.length;
      onProgress?.({ phase: 'repair', done: repairDone, total: repairTotal });
    });
    for (const { group, request } of requests) {
      const outcome = outcomes.get(request.customId)!;
      if (outcome.kind !== 'ok') continue;
      for (const [id, item] of parseTranslatedItems(outcome.text, group).items) results.set(id, item);
    }
    recheck();
    // Restore whichever previously-good id now blocks: its pre-repair text and soft issues (band Y) survive
    // instead of the repair's worse answer landing in band R.
    for (const [id, previous] of previousItems) if (blocksAutoAccept(checks.get(id)!)) results.set(id, previous);
    if (previousItems.size > 0) recheck(previousItems.keys());
  }

  // Distinct final (redacted, truncated) messages already sampled, so a repeated error does not crowd out a
  // different one, and de-duplication sees the same text a reviewer would.
  const sampledErrorMessages = new Set<string>();
  const addErrorSample = (message: string): void => {
    const s = redactSecrets(message).slice(0, MAX_ERROR_SAMPLE_LENGTH);
    if (sampledErrorMessages.has(s)) return;
    sampledErrorMessages.add(s);
    if (report.errorSamples.length < MAX_ERROR_SAMPLES) report.errorSamples.push(s);
  };

  // 3. Judge everything that passed the precheck.
  const judged = new Map<string, JudgeIssue[]>();
  const judgeFailed = new Set<string>();
  const judgeable = [...results.keys()].filter((id) => !blocksAutoAccept(checks.get(id)!));
  const translations = new Map([...results].map(([id, item]) => [id, item.translation]));
  const judgeGroups = buildGroups(judgeable.map((id) => byId.get(id)!), opts.groupSize);
  const judgeRequests = judgeGroups.map((group) => ({
    group,
    request: toRequest(buildJudgeParams(ctx, group, translations, opts.judgeModel)),
  }));
  const judgeGroupByCustomId = new Map(judgeRequests.map((r) => [r.request.customId, r.group]));
  const judgeTotal = judgeable.length;
  let judgeDone = 0;
  if (judgeRequests.length > 0) onProgress?.({ phase: 'judge', done: 0, total: judgeTotal });
  const judgeOutcomes =
    judgeRequests.length > 0
      ? await resolve(judgeRequests.map((r) => r.request), (outcome) => {
          judgeDone += judgeGroupByCustomId.get(outcome.customId)!.items.length;
          onProgress?.({ phase: 'judge', done: judgeDone, total: judgeTotal });
        })
      : new Map<string, LlmOutcome>();
  for (const { group, request } of judgeRequests) {
    const ids = new Set(group.items.map((w) => w.unit.id));
    const outcome = judgeOutcomes.get(request.customId);
    const parsed = outcome?.kind === 'ok' ? parseJudgeIssues(outcome.text, ids) : undefined;
    if (!parsed) {
      for (const id of ids) judgeFailed.add(id);
      // A judge failure never counts in `errors` (the translation itself may be fine) but must still surface a
      // reason: without this, a mistyped judge model ends the job "done" with every string `judge_failed` and
      // nothing a reviewer can act on.
      addErrorSample(`Judge: ${outcome?.kind === 'error' ? outcome.message : 'The judge returned malformed output.'}`);
      continue;
    }
    for (const [id, issues] of parsed) judged.set(id, issues);
  }

  // 4. Write cells. A cell a human touched during the job keeps its text; the AI result becomes a suggestion.
  // Check freshness before this batch's first putCell/appendEvent (the long model/judge calls above
  // are exactly the window a `git pull` could land in between the two commit batches).
  store.assertFresh();
  onProgress?.({ phase: 'write', done: 0, total: work.length });
  for (const w of work) {
    const id = w.unit.id;
    const cell = store.getCell(culture, id);
    const item = results.get(id);
    if (!item) {
      const refused = failed.get(id) === 'refused';
      if (refused) report.refused++;
      else {
        report.errors++;
        const message = errorMessages.get(id);
        if (message !== undefined) addErrorSample(message);
      }
      // A human touched this cell while the job ran: leave it untouched, the refusal/error still counted above.
      if (cell.revision !== startRevision.get(id)) continue;
      store.putCell({
        ...cell,
        status: cell.text ? cell.status : 'needs_fix',
        band: 'R',
        qaFlags: [...keepAudit(cell), refused ? 'refused' : 'llm_error'],
        revision: cell.revision + 1,
      });
      store.appendEvent({ ts: now, unitId: id, culture, action: refused ? 'ai_refused' : 'ai_error', actor: opts.actor, before: cell.text, after: cell.text });
      report.bands.R++;
      continue;
    }
    if (cell.revision !== startRevision.get(id)) {
      store.putCell({ ...cell, suggestion: item.translation });
      store.appendEvent({ ts: now, unitId: id, culture, action: 'ai_suggestion', actor: opts.actor, before: cell.text, after: item.translation });
      report.suggestions++;
      continue;
    }
    const issues = checks.get(id) ?? [];
    const judgeIssues = judged.get(id) ?? [];
    const blocked = blocksAutoAccept(issues);
    let band: Band = bandFor({ unit: w.unit, ambiguity: item.ambiguity, precheck: issues, judge: judgeIssues, refused: false });
    if (judgeFailed.has(id) && band === 'G') band = 'Y';
    // Keep the blind-audit flag through the rewrite, like every other writer (keepAudit(cell)) — a band
    // drop must not make an audited cell disappear from the sample.
    const qaFlags = [...new Set([...keepAudit(cell), ...issues.map((i) => i.code)])];
    if (judgeFailed.has(id) && !blocked) qaFlags.push('judge_failed');
    if (band === 'G' && isAuditSample(id, culture, opts.auditPercent) && !qaFlags.includes('audit')) qaFlags.push('audit');
    store.putCell({
      ...cell,
      text: item.translation,
      status: blocked ? 'needs_fix' : 'ai_draft',
      basedOnSourceRev: w.unit.sourceRev,
      basedOnSource: w.unit.source,
      provenance: `ai:${opts.translateModel}+${PROMPT_VERSION}`,
      ambiguity: item.ambiguity,
      alts: item.alts,
      question: item.question,
      note: '',
      // A suggestion set while the job ran (e.g. a retranslate that did not bump the revision) survives
      // the job's own write; the reviewer accepts or discards it through the edit action.
      suggestion: cell.suggestion,
      judgeIssues,
      qaFlags,
      band,
      revision: cell.revision + 1,
    });
    store.appendEvent({ ts: now, unitId: id, culture, action: blocked ? 'ai_needs_fix' : 'ai_draft', actor: opts.actor, before: cell.text, after: item.translation });
    // The model's question goes to the inbox; the answer later reaches the engine as DevNotes.
    const before = store.inbox.size;
    if (item.ambiguity !== 'none') recordQuestion(store, culture, id, item.question, opts.actor, now);
    report.questions += store.inbox.size - before;
    if (blocked) report.needsFix++;
    else report.written++;
    if (band === 'R' || band === 'Y' || band === 'G') report.bands[band]++;
  }
  // Minor: this final write event fires before store.save() below, so a client can see done === total for a
  // moment before the write it describes has actually landed on disk.
  onProgress?.({ phase: 'write', done: work.length, total: work.length });
  store.save();
  return report;
}
