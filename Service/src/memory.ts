import { CellActionError } from './cells.js';
import { isOutdated, type Culture, type InboxItem } from './contract.js';
import { compareCodeUnits, textHash } from './ids.js';
import type { LocHubStore } from './store.js';

export interface TmMatch {
  text: string;
  donorId: string;
}

const TM_STATUSES: ReadonlySet<string> = new Set(['approved', 'edited', 'human_edit']);

// Exact translation memory: the same English text already has a human-confirmed translation.
// The first donor by unit id wins, so the result does not depend on load order.
export function buildTmIndex(store: LocHubStore, culture: Culture): Map<string, TmMatch> {
  const index = new Map<string, TmMatch>();
  const units = [...store.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const unit of units) {
    if (unit.state !== 'active' || index.has(unit.source)) continue;
    const cell = store.getCell(culture, unit.id);
    if (!TM_STATUSES.has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    index.set(unit.source, { text: cell.text, donorId: unit.id });
  }
  return index;
}

// The id is derived from the question, so re-running a job does not duplicate open questions.
export function recordQuestion(
  store: LocHubStore,
  culture: Culture,
  unitId: string,
  question: string,
  askedBy: string,
  now: string,
): InboxItem | undefined {
  const text = question.trim();
  if (text.length === 0) return undefined;
  const id = textHash(`${unitId}|${culture}|${text}`);
  const existing = store.inbox.get(id);
  if (existing) return existing;
  const item: InboxItem = { id, unitId, culture, question: text, askedBy, status: 'open', answer: '', created: now, answered: '' };
  store.inbox.set(id, item);
  return item;
}

function requireItem(store: LocHubStore, id: string): InboxItem {
  const item = store.inbox.get(id);
  if (!item) throw new CellActionError(`Unknown inbox item ${id}`, 404);
  return item;
}

export function answerQuestion(store: LocHubStore, id: string, answer: string, now: string): InboxItem {
  const item = requireItem(store, id);
  const text = answer.trim();
  if (text.length === 0) throw new CellActionError('Answer is empty');
  const next: InboxItem = { ...item, status: 'answered', answer: text, answered: now };
  store.inbox.set(id, next);
  return next;
}

export function dismissQuestion(store: LocHubStore, id: string): InboxItem {
  const next: InboxItem = { ...requireItem(store, id), status: 'dismissed' };
  store.inbox.set(id, next);
  return next;
}

// Called after the plugin wrote the answers into DevNotes; from then on the context arrives with Push.
export function markApplied(store: LocHubStore, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    const item = store.inbox.get(id);
    if (!item || item.status !== 'answered') continue;
    store.inbox.set(id, { ...item, status: 'applied' });
    count++;
  }
  return count;
}

// The plugin writes 'Q: <question> A: <answer>' into DevNotes with both parts single-lined
// (CR/LF -> space) and trimmed, and checks presence with a case-sensitive Contains of that whole line.
// Building the exact same line here — and using it in both reachedDevNotes and answersByUnit — keeps the two
// from drifting apart: a short answer like "Yes" must not count as delivered merely because it appears
// somewhere else in DevNotes.
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ').trim();
}

function answerLine(item: Pick<InboxItem, 'question' | 'answer'>): string {
  return `Q: ${singleLine(item.question)} A: ${singleLine(item.answer)}`;
}

// An item marked 'applied' still belongs in the prompt until its answer actually reaches the unit's
// DevNotes. The plugin marks an answered item 'applied' as soon as it writes the asset (before Push), but
// DevNotes only reach unit.devNotes on the next gather + Push — a rework in that window must still see it.
//
// Matched whole-line, not by substring — a substring Contains would find "Q: X A: Verb" inside
// "Q: X A: Verbs" and wrongly mark the shorter answer delivered. The plugin applies the same
// whole-line comparison on its own side.
function reachedDevNotes(store: LocHubStore, item: InboxItem): boolean {
  const devNotes = store.units.get(item.unitId)?.devNotes ?? '';
  const line = answerLine(item);
  return devNotes.split(/\r\n|\r|\n/).some((l) => l.trim() === line);
}

// Meaning does not depend on the target culture: an answer given for one culture helps every culture.
export function answersByUnit(store: LocHubStore): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const items = [...store.inbox.values()]
    .filter((i) => i.status === 'answered' || (i.status === 'applied' && !reachedDevNotes(store, i)))
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const item of items) {
    const list = out.get(item.unitId) ?? [];
    list.push(answerLine(item));
    out.set(item.unitId, list);
  }
  return out;
}
