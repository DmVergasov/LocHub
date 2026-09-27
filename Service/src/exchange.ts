// Translation exchange: the work of human translators (a CSV or XLIFF file the web app parsed) applied through the
// same check Save runs. See CONTRACT.md, "Translation exchange (POST /api/import)". Rules per entry, in order:
// unknown, stale, empty, nothing to do (unchanged), conflict, hard/confirm, then the outcome. A dry run only reports.
import { createHash } from 'node:crypto';
import { approvedCell, editedCell } from './cells.js';
import {
  EXPORTED_AT_PATTERN,
  IMPORT_OUTCOMES,
  isOutdated,
  type Cell,
  type CellEvent,
  type CellEventAction,
  type ImportEntry,
  type ImportOutcome,
  type ImportRequest,
  type ImportResult,
  type ImportRow,
  type Unit,
} from './contract.js';
import { confirmCodes, hasHardIssues, type PrecheckIssue } from './precheck.js';
import type { LocHubStore } from './store.js';

// 400: a malformed body, or a file that names one string twice. Thrown before anything is written.
export class ImportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRequestError';
  }
}

// The apply refuses to write anything other than what its preview showed (the store changed in between since the
// dry run). `result` is the fresh dry-run result, for the caller to show as the new preview.
export class ImportPreviewStaleError extends Error {
  constructor(readonly result: ImportResult) {
    super('LocHub changed since the preview. Check the new preview and import again.');
    this.name = 'ImportPreviewStaleError';
  }
}

// The reviewer name recorded as the actor of every imported string (provenance and history).
export const MAX_ACTOR_LENGTH = 64;

// XLIFF 1.2 dates are ISO 8601 UTC: a date without an offset is read as UTC, never as this machine's local time.
// Date.parse alone accepts far looser strings ('9999', 'March 7') and would silently switch the date rule off.
const ISO_DATE_TIME = EXPORTED_AT_PATTERN;

// The check Save runs, bound to the request's culture: server.ts passes the /check route's own call.
export type TranslationCheck = (unit: Unit, text: string) => PrecheckIssue[];

// Events that leave a cell's text and status alone (they do not bump its revision): a Pull writing the archive, a
// job's suggestion next to a human's text. A translator's file cannot conflict with them.
const UNCHANGING_ACTIONS: ReadonlySet<CellEventAction> = new Set<CellEventAction>(['exported', 'ai_suggestion']);

type AppliedOutcome = 'changed' | 'changed_approved' | 'approved';

interface Applied {
  unit: Unit;
  cell: Cell;
  entry: ImportEntry;
  outcome: AppliedOutcome;
  accepted: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(entry: Record<string, unknown>, field: string, index: number): string | undefined {
  const value = entry[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ImportRequestError(`entries[${index}].${field} must be a string`);
  return value;
}

function parseEntry(raw: unknown, index: number): ImportEntry {
  if (!isRecord(raw)) throw new ImportRequestError(`entries[${index}] must be an object`);
  if (typeof raw.text !== 'string') throw new ImportRequestError(`entries[${index}].text must be a string`);
  if (typeof raw.approved !== 'boolean') throw new ImportRequestError(`entries[${index}].approved must be true or false`);
  const entry: ImportEntry = { text: raw.text, approved: raw.approved };
  for (const field of ['unitId', 'namespace', 'key', 'source'] as const) {
    const value = optionalString(raw, field, index);
    if (value !== undefined) entry[field] = value;
  }
  if (raw.exportedRevision !== undefined) {
    const revision = raw.exportedRevision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)
      throw new ImportRequestError(`entries[${index}].exportedRevision must be a whole number`);
    entry.exportedRevision = revision;
  }
  const exportedAt = optionalString(raw, 'exportedAt', index);
  if (exportedAt !== undefined) {
    const match = ISO_DATE_TIME.exec(exportedAt);
    const time = match ? Date.parse(match[1] ? exportedAt : `${exportedAt}Z`) : Number.NaN;
    if (Number.isNaN(time)) throw new ImportRequestError(`entries[${index}].exportedAt must be a date (ISO 8601)`);
    entry.exportedAt = new Date(time).toISOString();
  }
  return entry;
}

// The whole body is validated before any unit is resolved or anything written.
export function parseImportRequest(body: unknown): ImportRequest {
  if (!isRecord(body)) throw new ImportRequestError('Body must be a JSON object');
  if (typeof body.culture !== 'string') throw new ImportRequestError('culture is required');
  if (typeof body.actor !== 'string') throw new ImportRequestError('actor must be a string');
  const { dryRun, overwriteConflicts, acceptConfirm } = body;
  if (typeof dryRun !== 'boolean') throw new ImportRequestError('dryRun must be true or false');
  if (typeof overwriteConflicts !== 'boolean') throw new ImportRequestError('overwriteConflicts must be true or false');
  if (typeof acceptConfirm !== 'boolean') throw new ImportRequestError('acceptConfirm must be true or false');
  // Cut by code point, so a name is never cut inside a surrogate pair.
  const actor = Array.from(body.actor.trim()).slice(0, MAX_ACTOR_LENGTH).join('');
  // A dry run writes nothing, so the preview may run before the reviewer has typed a name.
  if (!dryRun && actor.length === 0) throw new ImportRequestError('actor is required: the reviewer name recorded on every imported string');
  if (body.previewDigest !== undefined && typeof body.previewDigest !== 'string') throw new ImportRequestError('previewDigest must be a string');
  if (!Array.isArray(body.entries)) throw new ImportRequestError('entries must be an array');
  const entries = body.entries.map((raw, index) => parseEntry(raw, index));
  return { culture: body.culture, actor, dryRun, overwriteConflicts, acceptConfirm, previewDigest: body.previewDigest, entries };
}

// By id when the entry has one and it resolves to an active unit; else (or as a fallback) by namespace + key. One
// string named twice would let the later row overwrite the earlier one unseen, so the request is refused instead.
function resolveUnits(store: LocHubStore, entries: readonly ImportEntry[]): (Unit | undefined)[] {
  const byName = new Map<string, Unit>();
  for (const unit of store.units.values()) if (unit.state === 'active') byName.set(JSON.stringify([unit.namespace, unit.key]), unit);
  const seen = new Set<string>();
  return entries.map((entry) => {
    let unit: Unit | undefined;
    if (entry.unitId !== undefined) {
      const found = store.units.get(entry.unitId);
      unit = found?.state === 'active' ? found : undefined;
    }
    // A spreadsheet can turn an all-digit id into a number (1.23457E+15, about 1 in 1,800 ids): the row's name
    // still finds the string. An explicit unitId that resolves to a unit already wins above, unchanged.
    if (!unit && entry.key !== undefined) unit = byName.get(JSON.stringify([entry.namespace ?? '', entry.key]));
    if (unit) {
      if (seen.has(unit.id)) throw new ImportRequestError(`The file has the same string twice (${unit.namespace}/${unit.key}); keep one and import again.`);
      seen.add(unit.id);
    }
    return unit;
  });
}

export function runImport(store: LocHubStore, request: ImportRequest, check: TranslationCheck): ImportResult {
  const units = resolveUnits(store, request.entries);
  // Read once, and only when an entry without a revision needs the date rule.
  let lastChange: Map<string, number> | undefined;
  const changedAfter = (unitId: string, exportedAt: string): boolean => {
    lastChange ??= store.latestEventTimes(request.culture, UNCHANGING_ACTIONS);
    return (lastChange.get(unitId) ?? Number.NEGATIVE_INFINITY) > Date.parse(exportedAt);
  };

  const rows: ImportRow[] = [];
  const applied: Applied[] = [];
  request.entries.forEach((entry, index) => {
    const unit = units[index];
    if (!unit) {
      rows.push({ index, outcome: 'unknown' });
      return;
    }
    if (entry.source !== undefined && entry.source !== unit.source) {
      rows.push({ index, unitId: unit.id, outcome: 'stale' });
      return;
    }
    if (entry.text.trim().length === 0) {
      rows.push({ index, unitId: unit.id, outcome: 'empty' });
      return;
    }
    const cell = store.getCell(request.culture, unit.id);
    // An approval writes when the cell is not approved yet, or is approved for an older source and this file shows the
    // current one (the stale rule above proved entry.source is the unit's source); without a source nothing proves the
    // translator saw the new text.
    const approves = entry.approved && (cell.status !== 'approved' || (entry.source !== undefined && isOutdated(unit, cell)));
    // Nothing to write: not a conflict and nothing to check, whatever changed in LocHub since the export.
    if (entry.text === cell.text && !approves) {
      rows.push({ index, unitId: unit.id, outcome: 'unchanged' });
      return;
    }
    const conflict =
      entry.exportedRevision !== undefined
        ? entry.exportedRevision !== cell.revision
        : entry.exportedAt !== undefined && changedAfter(unit.id, entry.exportedAt);
    const issues = check(unit, entry.text);
    const accepted = confirmCodes(issues);
    let outcome: ImportOutcome;
    if (conflict && !request.overwriteConflicts) outcome = 'conflict';
    else if (hasHardIssues(issues)) outcome = 'hard';
    else if (accepted.length > 0 && !request.acceptConfirm) outcome = 'confirm';
    else {
      // An approval never survives a conflict, whatever the text: it refers to a state of the string LocHub has
      // since changed, so an overwritten conflict always lands as changed (edited), as the reviewer's own work.
      // Without a conflict: the same text needs no change beyond approving it (`approved`); a new text becomes
      // `changed_approved` only when the cell's own status was not already `approved` at export — the export's
      // status column, left untouched, never certifies NEW text either.
      const carriedOverApproval = cell.status === 'approved';
      const kind: AppliedOutcome = conflict
        ? 'changed'
        : entry.text === cell.text
          ? 'approved'
          : entry.approved && !carriedOverApproval
            ? 'changed_approved'
            : 'changed';
      applied.push({ unit, cell, entry, outcome: kind, accepted });
      outcome = kind;
    }
    rows.push({ index, unitId: unit.id, outcome, ...(conflict ? { conflict: true as const } : {}), issues, before: cell.text, after: entry.text });
  });

  const counts = Object.fromEntries(IMPORT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<ImportOutcome, number>;
  for (const row of rows) counts[row.outcome]++;
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  const result: ImportResult = { rows, counts, digest };
  // The apply is tied to the preview the caller saw: a store change in between (a job, another tab, a Push, a
  // glossary edit, or a reload after files_changed_on_disk) changes what these rows would be, so it is refused
  // instead of silently applying a different set of rows than the one shown. Absent previewDigest, apply as before.
  if (!request.dryRun && request.previewDigest !== undefined && request.previewDigest !== digest) throw new ImportPreviewStaleError(result);
  if (!request.dryRun && applied.length > 0) apply(store, request, applied);
  return result;
}

// Every applied cell is staged, then saved once. save() refuses with 409 files_changed_on_disk when the data files
// moved under the service, and the route checks assertFresh() before this call too when the request is not a dry
// run, so that common case never stages anything. A save that throws before writing this culture's cells.*.jsonl
// (the freshness/case-collision checks, or units.jsonl) still leaves nothing written: the catch below puts every
// staged cell back. A save that throws *after* this culture's file (another culture's cells, glossary, style,
// inbox.jsonl) — or an appendEvents failure once save() has already succeeded — instead leaves the import on disk
// while the caller sees a 500 and memory is rolled back; the store's multi-file save is not atomic across that
// wider set. Either way, events follow a successful save, in one append: a refused save never leaves an event whose
// text the store does not hold, which a later Push would take for LocHub's own text (LocHubStore.afterTextsByUnit).
function apply(store: LocHubStore, request: ImportRequest, applied: readonly Applied[]): void {
  const ts = new Date().toISOString();
  const events: CellEvent[] = [];
  for (const { unit, cell, entry, outcome, accepted } of applied) {
    // Approving the text as it stands is an Approve (the text keeps its provenance); a new text is the reviewer's Edit.
    const next: Cell =
      outcome === 'approved'
        ? approvedCell(unit, cell)
        : { ...editedCell(unit, cell, entry.text, request.actor), ...(outcome === 'changed_approved' ? { status: 'approved' as const } : {}) };
    store.putCell(next);
    events.push({
      ts,
      unitId: unit.id,
      culture: request.culture,
      action: 'import',
      actor: request.actor,
      before: cell.text,
      after: next.text,
      ...(accepted.length > 0 ? { accepted: [...accepted] } : {}),
    });
  }
  try {
    store.save();
  } catch (error) {
    for (const { cell } of applied) store.putCell(cell);
    throw error;
  }
  store.appendEvents(events);
}
