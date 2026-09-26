import type { GlossaryTerm } from '../api/types';
import type { GridRow } from '../grid/model';

const normalize = (text: string) => text.trim().toLowerCase();

export function changedTerms(before: readonly GlossaryTerm[], after: readonly GlossaryTerm[]): GlossaryTerm[] {
  const previous = new Map(before.map((term) => [normalize(term.term), term] as const));
  return after.filter((term) => {
    const old = previous.get(normalize(term.term));
    return !old || old.translation !== term.translation || old.dnt !== term.dnt;
  });
}

// AI drafts whose source uses the term but whose text lacks the glossary form. Approved and edited texts are human
// decisions and are never touched: a human edit always wins.
export function rowsUsingTerm(rows: readonly GridRow[], culture: string, term: GlossaryTerm): GridRow[] {
  const needle = normalize(term.term);
  const expected = normalize(term.dnt ? term.term : term.translation);
  if (!needle || !expected) return [];
  return rows.filter((row) => {
    const cell = row.cells[culture]?.cell;
    return cell?.status === 'ai_draft' && row.unit.source.toLowerCase().includes(needle) && !cell.text.toLowerCase().includes(expected);
  });
}

// The rejection note travels to the model with the retranslation: a rule, not a string replacement (Russian cases).
export function termFixNote(term: GlossaryTerm): string {
  return term.dnt ? `Glossary: keep "${term.term}" untranslated.` : `Glossary: translate "${term.term}" as "${term.translation}".`;
}

// Import must run only against a glossary state the service has actually seen: unlike changedTerms, this also
// catches note-only edits, added/removed rows and reordering, so it is the right check for "did the on-screen
// list drift from the last saved/loaded one", not for "what should be re-queued".
export function glossaryUnsaved(current: readonly GlossaryTerm[], saved: readonly GlossaryTerm[]): boolean {
  if (current.length !== saved.length) return true;
  return current.some((term, index) => {
    const other = saved[index]!;
    return term.term !== other.term || term.translation !== other.translation || term.dnt !== other.dnt || term.note !== other.note;
  });
}
