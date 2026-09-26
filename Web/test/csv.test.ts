import { describe, expect, it } from 'vitest';
import { decodeUtf8, glossaryToCsv, mergeGlossary, parseCsv, readGlossaryCsv } from '../src/glossary/csv';
import type { GlossaryTerm } from '../src/api/types';

const term = (t: string, translation: string, dnt = false, note = ''): GlossaryTerm => ({ term: t, translation, dnt, note });

describe('parseCsv', () => {
  it('parses quoted fields, "" escapes and a newline inside quotes', () => {
    const text = 'term,note\r\n"bale","says ""hi""\nover two lines"\r\n';
    expect(parseCsv(text)).toEqual([
      ['term', 'note'],
      ['bale', 'says "hi"\nover two lines'],
    ]);
  });

  it('auto-detects a semicolon delimiter from the header line', () => {
    const text = 'term;translation\nbale;тюк\n';
    expect(parseCsv(text)).toEqual([
      ['term', 'translation'],
      ['bale', 'тюк'],
    ]);
  });

  it('auto-detects a tab delimiter from the header line', () => {
    const text = 'term\ttranslation\nbale\tтюк\n';
    expect(parseCsv(text)).toEqual([
      ['term', 'translation'],
      ['bale', 'тюк'],
    ]);
  });

  it('ties default to comma', () => {
    // header has one comma and one semicolon outside quotes -> tie -> comma wins
    const text = 'a,b;c\n1,2,3\n';
    expect(parseCsv(text)[0]).toEqual(['a', 'b;c']);
  });

  it('handles CRLF, LF and CR newlines the same way', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ignores a trailing empty line', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('pads rows shorter than the header with empty strings', () => {
    expect(parseCsv('term,translation,note\nbale,тюк\n')).toEqual([
      ['term', 'translation', 'note'],
      ['bale', 'тюк', ''],
    ]);
  });

  it('treats a lone CR (no LF) as a newline', () => {
    expect(parseCsv('a,b\r1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('treats a quote that is not at a field boundary as a literal character', () => {
    const text = 'term,note\r\nbale,5" hose\r\nmower,plain\r\n';
    expect(parseCsv(text)).toEqual([
      ['term', 'note'],
      ['bale', '5" hose'],
      ['mower', 'plain'],
    ]);
  });

  it('treats two stray quotes in one field as literal characters', () => {
    const text = 'term,note\r\nx,say "hi" now\r\n';
    expect(parseCsv(text)).toEqual([
      ['term', 'note'],
      ['x', 'say "hi" now'],
    ]);
  });

  it('a stray quote in the header line does not change delimiter detection', () => {
    // Without the field-boundary fix, the stray quote after "ter" would enter quoted mode and swallow the
    // semicolon, leaving the header looking delimiter-less (falls back to comma, splitting nothing).
    const text = 'ter"m;note\r\nbale;plain\r\n';
    expect(parseCsv(text)).toEqual([
      ['ter"m', 'note'],
      ['bale', 'plain'],
    ]);
  });
});

describe('decodeUtf8', () => {
  it('strips a leading BOM', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('term,translation')]);
    expect(decodeUtf8(bytes)).toBe('term,translation');
  });

  it('decodes plain UTF-8 (including non-Latin text) unchanged', () => {
    const bytes = new TextEncoder().encode('bale,тюк');
    expect(decodeUtf8(bytes)).toBe('bale,тюк');
  });

  it('throws a clear error on invalid UTF-8', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x00]);
    expect(() => decodeUtf8(bytes)).toThrow('The file is not UTF-8. Save it as "CSV UTF-8" and import again.');
  });
});

describe('readGlossaryCsv', () => {
  const opts = { cultures: ['ru', 'de'], nativeCulture: 'en', activeCulture: 'ru' };

  it('accepts term/source/source term aliases', () => {
    for (const alias of ['term', 'source', 'source term', 'Term', 'SOURCE TERM']) {
      const rows = [[alias, 'translation'], ['bale', 'тюк']];
      const result = readGlossaryCsv(rows, opts);
      expect(result.byCulture.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: undefined, note: undefined }]);
    }
  });

  it('falls back to a column named after nativeCulture when no term alias exists', () => {
    const rows = [['en', 'translation'], ['bale', 'тюк']];
    const result = readGlossaryCsv(rows, opts);
    expect(result.byCulture.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: undefined, note: undefined }]);
  });

  it('throws when no term column can be found', () => {
    const rows = [['foo', 'translation'], ['bale', 'тюк']];
    expect(() => readGlossaryCsv(rows, opts)).toThrow('No "term" column. The first row must name the columns, e.g. term,translation,dnt,note.');
  });

  it('maps translation/target to the active culture', () => {
    expect(readGlossaryCsv([['term', 'translation'], ['bale', 'тюк']], opts).byCulture.ru).toEqual([
      { term: 'bale', translation: 'тюк', dnt: undefined, note: undefined },
    ]);
    expect(readGlossaryCsv([['term', 'target'], ['bale', 'тюк']], opts).byCulture.ru).toEqual([
      { term: 'bale', translation: 'тюк', dnt: undefined, note: undefined },
    ]);
  });

  it('maps a column named after a project culture, matching case and _/- interchangeably', () => {
    const rows = [['term', 'RU', 'de_DE'], ['bale', 'тюк', 'Ballen']];
    const opts2 = { cultures: ['ru', 'de-DE'], nativeCulture: 'en', activeCulture: 'ru' };
    const result = readGlossaryCsv(rows, opts2);
    expect(result.byCulture.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: undefined, note: undefined }]);
    expect(result.byCulture['de-DE']).toEqual([{ term: 'bale', translation: 'Ballen', dnt: undefined, note: undefined }]);
  });

  it('throws when both "translation" and the active culture column are present', () => {
    const rows = [['term', 'translation', 'ru'], ['bale', 'тюк', 'тюк']];
    expect(() => readGlossaryCsv(rows, opts)).toThrow('Both "translation" and "ru" columns fill ru; keep one.');
  });

  it('accepts dnt aliases and rejects an unrecognized value', () => {
    const rows = [
      ['term', 'translation', 'dnt'],
      ['MyGame', '', 'yes'],
      ['bale', 'тюк', 'no'],
      ['mower', 'косилка', 'maybe'],
    ];
    const result = readGlossaryCsv(rows, opts);
    expect(result.byCulture.ru).toEqual([
      { term: 'MyGame', translation: undefined, dnt: true, note: undefined },
      { term: 'bale', translation: 'тюк', dnt: false, note: undefined },
    ]);
    expect(result.skipped).toEqual([{ line: 4, reason: 'dnt value "maybe" is not yes/no' }]);
  });

  it('recognizes do not translate / keep aliases and the full yes/no value sets', () => {
    const rows = [
      ['term', 'translation', 'Do Not Translate'],
      ['a', '', 'y'],
      ['b', '', 'true'],
      ['c', '', '1'],
      ['d', '', 'x'],
      ['e', '', '+'],
      ['f', 'x', 'n'],
      ['g', 'x', 'false'],
      ['h', 'x', '0'],
      ['i', 'x', '-'],
      ['j', 'x', ''],
    ];
    const result = readGlossaryCsv(rows, opts);
    expect(result.byCulture.ru?.map((t) => [t.term, t.dnt])).toEqual([
      ['a', true],
      ['b', true],
      ['c', true],
      ['d', true],
      ['e', true],
      ['f', false],
      ['g', false],
      ['h', false],
      ['i', false],
      ['j', false],
    ]);
  });

  it('reports note and comment aliases', () => {
    expect(readGlossaryCsv([['term', 'translation', 'note'], ['bale', 'тюк', 'seen in HUD']], opts).byCulture.ru).toEqual([
      { term: 'bale', translation: 'тюк', dnt: undefined, note: 'seen in HUD' },
    ]);
    expect(readGlossaryCsv([['term', 'translation', 'comment'], ['bale', 'тюк', 'seen in HUD']], opts).byCulture.ru).toEqual([
      { term: 'bale', translation: 'тюк', dnt: undefined, note: 'seen in HUD' },
    ]);
  });

  it('collects unrecognized columns into ignoredColumns', () => {
    const result = readGlossaryCsv([['term', 'translation', 'Category'], ['bale', 'тюк', 'vehicles']], opts);
    expect(result.ignoredColumns).toEqual(['Category']);
  });

  it('skips a row with an empty term', () => {
    const rows = [['term', 'translation'], ['', 'тюк'], ['  ', 'x'], ['bale', 'тюк']];
    const result = readGlossaryCsv(rows, opts);
    expect(result.skipped).toEqual([
      { line: 2, reason: 'empty term' },
      { line: 3, reason: 'empty term' },
    ]);
    expect(result.byCulture.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: undefined, note: undefined }]);
  });

  it('skips a row that fills no culture', () => {
    const rows = [['term', 'translation'], ['bale', ''], ['mower', 'косилка']];
    const result = readGlossaryCsv(rows, opts);
    expect(result.skipped).toEqual([{ line: 2, reason: 'no translation' }]);
    expect(result.byCulture.ru).toEqual([{ term: 'mower', translation: 'косилка', dnt: undefined, note: undefined }]);
  });

  it('keeps the last occurrence of a duplicate term and skips the earlier line', () => {
    const rows = [
      ['term', 'translation'],
      ['bale', 'тюк'],
      ['mower', 'косилка'],
      ['Bale', 'кипа'],
    ];
    const result = readGlossaryCsv(rows, opts);
    expect(result.skipped).toEqual([{ line: 2, reason: 'duplicate of line 4' }]);
    expect(result.byCulture.ru).toEqual([
      { term: 'mower', translation: 'косилка', dnt: undefined, note: undefined },
      { term: 'Bale', translation: 'кипа', dnt: undefined, note: undefined },
    ]);
  });

  it('throws when there is no translation column and no dnt column', () => {
    const rows = [['term', 'note'], ['bale', 'x']];
    expect(() => readGlossaryCsv(rows, opts)).toThrow('No translation column: add "translation" or one column per culture (ru, de).');
  });

  it('accepts a dnt-only file: terms go to the active culture', () => {
    const rows = [
      ['term', 'dnt'],
      ['MyGame', 'yes'],
      ['bale', 'no'],
    ];
    const result = readGlossaryCsv(rows, opts);
    expect(result.byCulture.ru).toEqual([{ term: 'MyGame', translation: undefined, dnt: true, note: undefined }]);
    expect(result.skipped).toEqual([{ line: 3, reason: 'no translation' }]);
  });
});

describe('mergeGlossary', () => {
  it('updates an existing term, keeping its spelling and position, only for defined non-empty fields', () => {
    const existing = [term('Bale', 'кипа', false, 'old note'), term('Mower', 'косилка')];
    const incoming = [
      { term: 'bale', translation: 'тюк', dnt: undefined, note: undefined },
      { term: 'mower', translation: undefined, dnt: true, note: 'engine part' },
    ];
    const result = mergeGlossary(existing, incoming);
    expect(result.terms).toEqual([term('Bale', 'тюк', false, 'old note'), term('Mower', 'косилка', true, 'engine part')]);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(2);
    expect(result.unchanged).toBe(0);
  });

  it('keeps the existing translation and note when the incoming term leaves them undefined (empty cells keep values)', () => {
    const existing = [term('mower', 'косилка', false, 'engine part')];
    const result = mergeGlossary(existing, [{ term: 'mower', translation: undefined, dnt: true, note: undefined }]);
    expect(result.terms).toEqual([term('mower', 'косилка', true, 'engine part')]);
    expect(result.updated).toBe(1);
  });

  it('leaves a term unchanged when the incoming values are identical', () => {
    const existing = [term('bale', 'тюк')];
    const result = mergeGlossary(existing, [{ term: 'bale', translation: 'тюк', dnt: false, note: undefined }]);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(1);
  });

  it('appends new terms in file order with defaults', () => {
    const result = mergeGlossary([term('bale', 'тюк')], [
      { term: 'mower', translation: undefined, dnt: undefined, note: undefined },
      { term: 'trailer', translation: 'прицеп', dnt: undefined, note: undefined },
    ]);
    expect(result.terms).toEqual([term('bale', 'тюк'), term('mower', '', false, ''), term('trailer', 'прицеп', false, '')]);
    expect(result.added).toBe(2);
  });
});

describe('glossaryToCsv', () => {
  it('writes a header and one row per term, quoting where needed', () => {
    const csv = glossaryToCsv([term('bale', 'says "hi"'), term('mower', 'a, b', true, 'note, with comma')]);
    expect(csv).toBe('term,translation,dnt,note\r\nbale,"says ""hi""",no,\r\nmower,"a, b",yes,"note, with comma"\r\n');
  });

  it('round-trips through parseCsv + readGlossaryCsv', () => {
    const terms = [term('bale', 'says "hi", ok'), term('mower', 'косилка', true, 'a note')];
    const csv = glossaryToCsv(terms);
    const rows = parseCsv(csv);
    const result = readGlossaryCsv(rows, { cultures: ['ru'], nativeCulture: 'en', activeCulture: 'ru' });
    expect(result.byCulture.ru).toEqual([
      { term: 'bale', translation: 'says "hi", ok', dnt: false, note: '' },
      { term: 'mower', translation: 'косилка', dnt: true, note: 'a note' },
    ]);
  });

  it('guards a formula-injection prefix (=, +, -, @) with a leading tab', () => {
    const csv = glossaryToCsv([term('bale', '=SUM(A1)'), term('mower', '+1'), term('x', '-1'), term('y', '@cmd')]);
    expect(csv).toBe('term,translation,dnt,note\r\nbale,\t=SUM(A1),no,\r\nmower,\t+1,no,\r\nx,\t-1,no,\r\ny,\t@cmd,no,\r\n');
  });

  it('export -> import round trip keeps a formula-like value intact (the importer trims the guard tab)', () => {
    const csv = glossaryToCsv([term('bale', '=SUM(A1)')]);
    const rows = parseCsv(csv);
    const result = readGlossaryCsv(rows, { cultures: ['ru'], nativeCulture: 'en', activeCulture: 'ru' });
    expect(result.byCulture.ru).toEqual([{ term: 'bale', translation: '=SUM(A1)', dnt: false, note: '' }]);
  });
});
