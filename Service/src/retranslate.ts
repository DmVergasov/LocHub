import { CellActionError, checkTranslation } from './cells.js';
import type { Cell } from './contract.js';
import { cultureContext, parseTranslatedItems, translateParamsFor, type JobOptions } from './job.js';
import { requestId, type LlmClient } from './llm.js';
import { redactSecrets } from './llmShared.js';
import type { PrecheckIssue } from './precheck.js';
import type { LocHubStore } from './store.js';

export interface RetranslateResult {
  cell: Cell;
  issues: PrecheckIssue[];
}

// "Retranslate with a note": one synchronous request that bypasses the cache. The answer becomes a
// suggestion the reviewer compares with the current text and accepts through the edit action.
export async function retranslateWithNote(
  store: LocHubStore,
  llm: LlmClient,
  opts: JobOptions,
  unitId: string,
  note: string,
  asRule: boolean,
): Promise<RetranslateResult> {
  const culture = opts.culture;
  const unit = store.units.get(unitId);
  if (!unit || unit.state !== 'active') throw new CellActionError(`Unknown unit ${unitId}`, 404);
  const text = note.trim();
  if (text.length === 0) throw new CellActionError('Note is empty');

  const current = store.getCell(culture, unitId);
  // The note travels as reviewer_note, the same channel a rejection uses.
  const group = { groupKey: unit.groupKey, items: [{ unit, cell: { ...current, status: 'rejected' as const, note: text } }] };
  const params = translateParamsFor(store, cultureContext(store, culture, opts.brief), group, opts);
  const [outcome] = await llm.runSync([{ customId: requestId(params), params }], 1);
  // No shouldContinue is passed, so a 'skipped' outcome cannot happen here; it would read as a failed call.
  if (!outcome || outcome.kind !== 'ok') {
    // The reason reaches the reviewer instead of a bare "the model call failed", so a typo'd model id is
    // distinguishable from a billing problem; redacted, since it can echo a masked key fragment (a 401 text).
    const message =
      outcome?.kind === 'refusal' ? 'The model refused this string' : outcome?.kind === 'error' ? `The model call failed: ${redactSecrets(outcome.message)}` : 'The model call failed';
    throw new CellActionError(message, 502);
  }
  const item = parseTranslatedItems(outcome.text, group).items.get(unitId);
  if (!item) throw new CellActionError('The model returned no translation for this string', 502);

  const issues = checkTranslation(store, culture, unit, item.translation, opts.lengthCheck);
  // Re-read after the model call: a human edit or a job may have written this cell meanwhile, and only the
  // suggestion belongs to this request.
  // The model call can take seconds; re-check before staging the event so a 409 leaves no phantom `after`.
  store.assertFresh();
  const latest = store.getCell(culture, unitId);
  const cell: Cell = { ...latest, suggestion: item.translation };
  store.putCell(cell);
  store.appendEvent({ ts: new Date().toISOString(), unitId, culture, action: 'ai_suggestion', actor: 'reviewer', before: latest.text, after: item.translation });
  // "Use as a rule": the note joins the culture's style guide, so every later request carries it.
  if (asRule) {
    const style = (store.style.get(culture) ?? '').trimEnd();
    const rule = `- ${text}`;
    if (!style.split('\n').includes(rule)) store.style.set(culture, `${style}${style ? '\n' : ''}${rule}\n`);
  }
  store.save();
  return { cell, issues };
}
