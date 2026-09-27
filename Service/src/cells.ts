import { isOutdated, keepAudit, type Cell, type CellEventAction, type Culture, type ExportAck, type ExportEntry, type ReleasePolicy, type Unit } from './contract.js';
import { compareCodeUnits, textHash } from './ids.js';
import { LENGTH_CHECK_OFF, lengthLimitFor, type LengthCheckConfig } from './lengthCheck.js';
import { confirmCodes, hasHardIssues, precheck, type PrecheckIssue, type PrecheckOptions } from './precheck.js';
import type { LocHubStore } from './store.js';
import { bandFor } from './triage.js';

export class CellActionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 422,
    readonly issues: PrecheckIssue[] = [],
  ) {
    super(message);
    this.name = 'CellActionError';
  }
}

// What the reviewer saw before acting — the cell's `revision` and the unit's `sourceRev`. Either field
// may be absent (older clients and the plugin never send them, and the check that field is skipped).
export interface ExpectedRevision {
  revision?: number;
  sourceRev?: number;
}

// 409: the store moved under the reviewer between them opening the cell and acting on it (a Push changed the
// source, or another edit/approve/reject landed first). Carries the current state so the caller can show it
// without a second round trip.
export class StaleCellError extends Error {
  constructor(
    readonly cell: Cell,
    readonly unit: Unit,
  ) {
    super('This string changed since you opened it (new source text or a newer translation). Review it again.');
    this.name = 'StaleCellError';
  }
}

function checkFresh(unit: Unit, cell: Cell, expected: ExpectedRevision | undefined): void {
  if (!expected) return;
  if (expected.revision !== undefined && expected.revision !== cell.revision) throw new StaleCellError(cell, unit);
  if (expected.sourceRev !== undefined && expected.sourceRev !== unit.sourceRev) throw new StaleCellError(cell, unit);
}

export function dntTermsOf(store: LocHubStore, culture: Culture): string[] {
  return (store.glossary.get(culture) ?? []).filter((t) => t.dnt).map((t) => t.term);
}

function requireUnit(store: LocHubStore, unitId: string): Unit {
  const unit = store.units.get(unitId);
  if (!unit || unit.state !== 'active') throw new CellActionError(`Unknown unit ${unitId}`, 404);
  return unit;
}

// The precheck inputs for one unit: the culture's DNT glossary terms and the plural categories the engine reported on
// the last Push (Node's own answer until one did), both from the store, and the unit's Length Check limit from the
// service config. Every precheck caller goes through this, so the cell panel, Save/Approve and AI drafts agree.
export function precheckOptionsFor(store: LocHubStore, culture: Culture, unit: Unit, lengthCheck: LengthCheckConfig): PrecheckOptions {
  const options: PrecheckOptions = { dntTerms: dntTermsOf(store, culture), plurals: (type) => store.pluralCategoriesFor(culture, type) };
  const limit = lengthLimitFor(unit, culture, lengthCheck);
  if (limit !== null) options.length = { limit, severity: lengthCheck.mode === 'confirm' ? 'confirm' : 'soft' };
  return options;
}

// The one precheck call approveCell/editCell and the read-only check route all run, so the three can never drift.
export function checkTranslation(store: LocHubStore, culture: Culture, unit: Unit, text: string, lengthCheck: LengthCheckConfig): PrecheckIssue[] {
  return precheck(unit.source, text, culture, precheckOptionsFor(store, culture, unit, lengthCheck));
}

// POST /api/cells/:culture/:unitId/check: same 404 as approve/edit/reject, no store write. The Length Check defaults to
// off here and in approveCell/editCell only for callers with no service config (tests, the offline demo); every
// server route passes the configured one.
export function checkCell(store: LocHubStore, culture: Culture, unitId: string, text: string, lengthCheck: LengthCheckConfig = LENGTH_CHECK_OFF): PrecheckIssue[] {
  return checkTranslation(store, culture, requireUnit(store, unitId), text, lengthCheck);
}

// The human gate. A hard issue (Unreal rejects the text or prints it broken) is refused whatever `accept` says. A
// confirm issue (valid for Unreal, probably a mistake) passes only when `accept` names every confirm code of this
// very text, so a card that checked an older draft cannot approve issues it never showed. Returns the confirm codes
// the human accepted (for the event) together with the full issue list (editCell uses it to re-band the cell).
function checkOrThrow(
  store: LocHubStore, culture: Culture, unit: Unit, text: string, accept: readonly string[], lengthCheck: LengthCheckConfig,
): { issues: PrecheckIssue[]; accepted: string[] } {
  const issues = checkTranslation(store, culture, unit, text, lengthCheck);
  if (hasHardIssues(issues)) throw new CellActionError('Translation fails the format check', 422, issues);
  const accepted = confirmCodes(issues);
  const unconfirmed = accepted.filter((code) => !accept.includes(code));
  if (unconfirmed.length > 0) throw new CellActionError(`Confirm these warnings to go ahead anyway: ${unconfirmed.join(', ')}`, 422, issues);
  return { issues, accepted };
}

function commit(store: LocHubStore, before: Cell, after: Cell, action: CellEventAction, actor: string, accepted: readonly string[] = []): Cell {
  store.putCell(after);
  store.appendEvent({
    ts: new Date().toISOString(),
    unitId: after.unitId,
    culture: after.culture,
    action,
    actor,
    before: before.text,
    after: after.text,
    ...(accepted.length > 0 ? { accepted: [...accepted] } : {}),
  });
  return after;
}

// The cell an Approve leaves: same text and provenance, re-based on the current source. Shared with
// POST /api/import (exchange.ts), whose 'approved' outcome is exactly this action.
export function approvedCell(unit: Unit, cell: Cell): Cell {
  return { ...cell, status: 'approved', basedOnSourceRev: unit.sourceRev, basedOnSource: unit.source, qaFlags: keepAudit(cell), revision: cell.revision + 1 };
}

// The cell a human Edit leaves: the reviewer's text, the AI's leftovers cleared. Shared with POST /api/import
// (exchange.ts), whose 'changed' and 'changed_approved' outcomes build on this before optionally re-marking it approved.
export function editedCell(unit: Unit, cell: Cell, text: string, actor: string): Cell {
  return {
    ...cell,
    text,
    status: 'edited',
    basedOnSourceRev: unit.sourceRev,
    basedOnSource: unit.source,
    provenance: `human:${actor}`,
    ambiguity: 'none',
    alts: [],
    question: '',
    note: '',
    suggestion: '',
    judgeIssues: [],
    qaFlags: keepAudit(cell),
    revision: cell.revision + 1,
  };
}

// A needs_fix cell is re-checked like any other: its text may pass now (the glossary changed since), or carry only
// confirm issues a human may accept.
export function approveCell(
  store: LocHubStore,
  culture: Culture,
  unitId: string,
  actor: string,
  expected?: ExpectedRevision,
  accept: readonly string[] = [],
  lengthCheck: LengthCheckConfig = LENGTH_CHECK_OFF,
): Cell {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  if (cell.text.length === 0) throw new CellActionError('Nothing to approve');
  const { accepted } = checkOrThrow(store, culture, unit, cell.text, accept, lengthCheck);
  return commit(store, cell, approvedCell(unit, cell), 'approve', actor, accepted);
}

export function editCell(
  store: LocHubStore,
  culture: Culture,
  unitId: string,
  text: string,
  actor: string,
  expected?: ExpectedRevision,
  accept: readonly string[] = [],
  lengthCheck: LengthCheckConfig = LENGTH_CHECK_OFF,
): Cell {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  const { issues, accepted } = checkOrThrow(store, culture, unit, text, accept, lengthCheck);
  // "Existing data" (length-check design): the next job or edit re-bands the cell — a human edit is freshly
  // checked, so its review priority reflects what the check finds now (e.g. a soft too_long lands it in Y),
  // not whatever band the cell carried before the edit.
  const band = bandFor({ unit, ambiguity: 'none', precheck: issues, judge: [], refused: false });
  return commit(store, cell, { ...editedCell(unit, cell, text, actor), band }, 'edit', actor, accepted);
}

export function rejectCell(store: LocHubStore, culture: Culture, unitId: string, note: string, actor: string, expected?: ExpectedRevision): Cell {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  return commit(store, cell, { ...cell, status: 'rejected', note, revision: cell.revision + 1 }, 'reject', actor);
}

const EXPORTABLE: Record<ReleasePolicy, ReadonlySet<string>> = {
  validated: new Set(['ai_draft', 'approved', 'edited', 'human_edit']),
  approved_only: new Set(['approved', 'edited', 'human_edit']),
};

// What Pull may write into the archive. Outdated text is withheld: the player sees English until it is redone.
export function exportForPull(store: LocHubStore, culture: Culture, policy: ReleasePolicy): ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const unit of store.units.values()) {
    if (unit.state !== 'active') continue;
    const cell = store.getCell(culture, unit.id);
    if (!EXPORTABLE[policy].has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    out.push({ unitId: unit.id, namespace: unit.namespace, key: unit.key, source: unit.source, translation: cell.text });
  }
  return out.sort((a, b) => compareCodeUnits(a.unitId, b.unitId));
}

export function applyExportAck(store: LocHubStore, ack: ExportAck): void {
  const cells = store.cellsFor(ack.culture);
  const now = new Date().toISOString();
  for (const written of ack.written) {
    const cell = cells.get(written.unitId);
    if (!cell) continue;
    const hash = textHash(written.translation);
    // The plugin acks every valid entry on every Pull, changed or not — logging an 'exported' event
    // unconditionally would write one row per unit per Pull forever. Only the text the engine actually wrote
    // is recorded (`after`), and only when it moves the archive hash.
    if (cell.archiveHash !== hash) {
      store.appendEvent({ ts: now, unitId: written.unitId, culture: ack.culture, action: 'exported', actor: 'engine', before: cell.text, after: written.translation });
    }
    store.putCell({ ...cell, archiveHash: hash });
  }
  for (const rejected of ack.rejected) {
    const cell = cells.get(rejected.unitId);
    // The engine was validating a text a human (or a later job) has since replaced; that rejection no
    // longer describes the cell's current text and must not withhold it.
    if (!cell || rejected.translation !== cell.text) continue;
    store.putCell({
      ...cell,
      status: 'needs_fix',
      band: 'R',
      qaFlags: [...new Set([...cell.qaFlags, 'engine_rejected'])],
      question: rejected.errors.join('; '),
      revision: cell.revision + 1,
    });
    store.appendEvent({ ts: now, unitId: rejected.unitId, culture: ack.culture, action: 'engine_rejected', actor: 'engine', before: cell.text, after: cell.text });
  }
}
