import { describe, expect, it } from 'vitest';
import { splitInlineCodes } from '../src/exchange/inline';

// Codes in brackets, plain text as is.
const parts = (text: string) => splitInlineCodes(text).map((part) => (part.code ? `[${part.text}]` : part.text));

describe('splitInlineCodes', () => {
  it('marks arguments without a modifier and rich-text tags as codes', () => {
    expect(parts('Press {Key} to interact.')).toEqual(['Press ', '[{Key}]', ' to interact.']);
    expect(parts('{0} of {1}')).toEqual(['[{0}]', ' of ', '[{1}]']);
    expect(parts('<Bold>Warning</>: {Name}')).toEqual(['[<Bold>]', 'Warning', '[</>]', ': ', '[{Name}]']);
    expect(parts('<img id="coin" size="2"/> x{Amount}')).toEqual(['[<img id="coin" size="2"/>]', ' x', '[{Amount}]']);
  });

  it('keeps an argument with a plural, ordinal or gender modifier as plain text, branches included', () => {
    expect(parts('You have {Count}|plural(one={Count} bale,other={Count} bales) left')).toEqual([
      'You have {Count}|plural(one={Count} bale,other={Count} bales) left',
    ]);
    expect(parts('{Place}|ordinal(one=st,two=nd,few=rd,other=th) of {Total}')).toEqual(['{Place}|ordinal(one=st,two=nd,few=rd,other=th) of ', '[{Total}]']);
    expect(parts('{Gender}|gender(He,She) waves')).toEqual(['{Gender}|gender(He,She) waves']);
    expect(parts('{N}|plural(one="a)b",other=c) {X}')).toEqual(['{N}|plural(one="a)b",other=c) ', '[{X}]']);
    expect(parts('{N}|plural(one=a')).toEqual(['{N}|plural(one=a']);
    // Backtick inside modifier escapes any next char (matches Service/src/ueText.ts), so a`" closes modifier properly
    expect(parts('{N}|plural(one=a`"b,other=c) {X}')).toEqual(['{N}|plural(one=a`"b,other=c) ', '[{X}]']);
  });

  it('leaves escaped braces and tags, stray brackets and unclosed arguments as text', () => {
    expect(parts('Use `{braces`} and `<tags>')).toEqual(['Use `{braces`} and `', '[<tags>]']);
    expect(parts('a < b > c')).toEqual(['a < b > c']);
    expect(parts('{Name}|x and {Open')).toEqual(['[{Name}]', '|x and {Open']);
    expect(parts('')).toEqual([]);
  });

  it('proves a backtick before < does not escape the tag (negative control)', () => {
    // A backtick escapes only: backtick, {, }, |. Before <, it stays literal.
    expect(parts('`<tag>')).toEqual(['`', '[<tag>]']);
  });
});
