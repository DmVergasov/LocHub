import { keepAudit, type Cell, type CellEvent, type PushReport, type Snapshot, type Unit } from './contract.js';
import { textHash, unitIdOf } from './ids.js';
import type { LocHubStore } from './store.js';
import { isCosmeticChange } from './ueText.js';

export interface PushOptions {
  // Count what would change without touching the store (--dry-run).
  dryRun?: boolean;
}

// Shared by Push's own archive loop and POST /api/reconcile: a translation in the archive that is
// neither our text nor a text we exported before was edited outside LocHub. `units` is the view of units to
// check `archived.source` against — Push's freshly staged map (so a same-Push source edit is seen), or the
// store's current units for a bare reconcile (no unit diff). Pure: stages writes/events without touching the
// store, so both dryRun and a shared-logic caller (reconcile) can decide separately whether to commit them.
function reconcileArchiveEntries(
  store: LocHubStore,
  units: ReadonlyMap<string, Unit>,
  archives: Snapshot['archives'],
  actor: string,
): { cellWrites: Cell[]; events: CellEvent[]; humanEdits: number } {
  const cellWrites: Cell[] = [];
  const events: CellEvent[] = [];
  let humanEdits = 0;
  const now = new Date().toISOString();
  for (const [culture, entries] of Object.entries(archives)) {
    // Read once per culture per call, not once per archive entry.
    const pastAfters = store.afterTextsByUnit(culture);
    for (const archived of entries) {
      const id = unitIdOf(archived.namespace, archived.key);
      const unit = units.get(id);
      if (!unit || archived.translation.length === 0) continue;
      // The archive entry was made for an older source: UE keeps stale foreign archive entries on purpose,
      // so this is not a decision about the unit's current text.
      if (archived.source !== unit.source) continue;
      const cell = store.getCell(culture, id);
      const hash = textHash(archived.translation);
      if (archived.translation === cell.text || hash === cell.archiveHash) continue;
      // A text LocHub itself produced for this cell before (an export whose ack was lost, or an archive
      // entry reverted by a source control sync, e.g. git pull) is a stale export, not a human edit.
      if (pastAfters.get(id)?.has(archived.translation)) continue;
      cellWrites.push({
        ...cell,
        text: archived.translation,
        status: 'human_edit',
        provenance: 'human:archive',
        basedOnSourceRev: unit.sourceRev,
        basedOnSource: unit.source,
        archiveHash: hash,
        band: '',
        judgeIssues: [],
        qaFlags: keepAudit(cell),
        suggestion: '',
        revision: cell.revision + 1,
      });
      events.push({ ts: now, unitId: id, culture, action: 'human_edit', actor, before: cell.text, after: archived.translation });
      humanEdits++;
    }
  }
  return { cellWrites, events, humanEdits };
}

// POST /api/reconcile: Pull calls this before its first export, so a translation edited in the archive
// outside LocHub since the last Push becomes human_edit instead of being silently overwritten by the export
// that follows. Runs exactly Push's archive check against the store's current units — no unit diff, no
// tombstones, does not touch lastPush — and commits immediately (there is no dry-run mode for it).
export function reconcileArchives(store: LocHubStore, archives: Snapshot['archives'], actor = 'pull'): number {
  const { cellWrites, events, humanEdits } = reconcileArchiveEntries(store, store.units, archives, actor);
  for (const cell of cellWrites) store.putCell(cell);
  for (const event of events) store.appendEvent(event);
  return humanEdits;
}

export function applySnapshot(store: LocHubStore, snapshot: Snapshot, actor = 'push', opts: PushOptions = {}): PushReport {
  const report: PushReport = { added: 0, changed: 0, cosmetic: 0, tombstoned: 0, revived: 0, humanEdits: 0 };
  const present = new Set<string>();
  // All changes are staged first and committed at the end, so a dry run shares the exact same logic.
  const units = new Map(store.units);

  for (const entry of snapshot.entries) {
    const id = unitIdOf(entry.namespace, entry.key);
    present.add(id);
    const old = units.get(id);
    if (!old) {
      units.set(id, {
        id,
        namespace: entry.namespace,
        key: entry.key,
        source: entry.source,
        sourceRev: 1,
        state: 'active',
        origin: entry.origin,
        devNotes: entry.devNotes,
        metadata: { ...entry.metadata },
        groupKey: entry.groupKey,
      });
      report.added++;
      continue;
    }
    // A new Unit object is built even for a unit whose fields did not change, rather than mutating `old`
    // in place. A job running concurrently holds the WorkItem.unit it started with; overwriting `old`'s
    // fields here would rewrite the source text out from under it mid-job.
    const next: Unit = { ...old, origin: entry.origin, devNotes: entry.devNotes, metadata: { ...entry.metadata }, groupKey: entry.groupKey };
    if (old.state === 'tombstone') {
      next.state = 'active';
      report.revived++;
    }
    if (old.source !== entry.source) {
      if (isCosmeticChange(old.source, entry.source)) {
        report.cosmetic++;
      } else {
        next.sourceRev = old.sourceRev + 1;
        report.changed++;
      }
      next.source = entry.source;
    }
    units.set(id, next);
  }

  // Retiring is reversible (a unit that comes back is revived with its cells, above), and the editor asks before it
  // retires anything: missing strings are retired on every real Push.
  for (const unit of units.values()) {
    if (unit.state === 'active' && !present.has(unit.id)) {
      units.set(unit.id, { ...unit, state: 'tombstone' });
      report.tombstoned++;
    }
  }

  // A translation in the archive that is neither our text nor the text we last exported was edited outside LocHub.
  const { cellWrites, events, humanEdits } = reconcileArchiveEntries(store, units, snapshot.archives, actor);
  report.humanEdits = humanEdits;

  if (!opts.dryRun) {
    store.units.clear();
    for (const [id, unit] of units) store.units.set(id, unit);
    for (const cell of cellWrites) store.putCell(cell);
    for (const event of events) store.appendEvent(event);
    // Latest value per culture: a culture this Push leaves out (the engine could not resolve it) keeps its
    // forms. store.updatePluralForms also persists them, so they survive the service restart the editor runs
    // on every AI/brief setting change (checks-fix1-brief).
    store.updatePluralForms(snapshot.pluralForms ?? {});
  }
  return report;
}
