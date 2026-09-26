import { describe, expect, it } from 'vitest';
import { changedTerms, glossaryUnsaved, rowsUsingTerm, termFixNote } from '../src/glossary/glossary';
import type { GridRow } from '../src/grid/model';
import { makeCell, makeUnit } from './fakeApi';

const term = (value: string, translation: string, dnt = false) => ({ term: value, translation, dnt, note: '' });

function row(key: string, source: string, text: string, status: 'ai_draft' | 'approved'): GridRow {
  const unit = makeUnit(key, source);
  return { unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { text, status }), outdated: false } } };
}

describe('glossary helpers', () => {
  it('reports new and changed terms only', () => {
    const before = [term('bale', 'кипа'), term('mower', 'косилка')];
    const after = [term('Bale', 'тюк'), term('mower', 'косилка'), term('MyGame', '', true)];
    expect(changedTerms(before, after).map((t) => t.term)).toEqual(['Bale', 'MyGame']);
  });

  it('finds AI drafts that ignore a term and leaves human decisions alone', () => {
    const rows = [
      row('A', 'Bale loaded', 'Кипа загружена', 'ai_draft'),
      row('B', 'Bales left', 'Осталось тюков', 'ai_draft'),
      row('C', 'Bale count', 'Кипы', 'approved'),
      row('D', 'Mower', 'Косилка', 'ai_draft'),
    ];
    expect(rowsUsingTerm(rows, 'ru', term('bale', 'тюк')).map((r) => r.unit.key)).toEqual(['A']);
    expect(rowsUsingTerm(rows, 'ru', term('Mower', 'Mower', true)).map((r) => r.unit.key)).toEqual(['D']);
    expect(rowsUsingTerm(rows, 'ru', term('', 'тюк'))).toEqual([]);
  });

  it('writes the instruction the model gets with the rejection', () => {
    expect(termFixNote(term('bale', 'тюк'))).toBe('Glossary: translate "bale" as "тюк".');
    expect(termFixNote(term('MyGame', '', true))).toBe('Glossary: keep "MyGame" untranslated.');
  });

  it('detects unsaved on-screen edits against the last saved/loaded list', () => {
    const saved = [term('bale', 'тюк')];
    expect(glossaryUnsaved(saved, saved)).toBe(false);
    expect(glossaryUnsaved([...saved, term('mower', '')], saved)).toBe(true); // an added (even blank) row
    expect(glossaryUnsaved([{ ...saved[0]!, note: 'changed' }], saved)).toBe(true); // a field changedTerms ignores
    expect(glossaryUnsaved([], saved)).toBe(true); // a removed row
  });
});
