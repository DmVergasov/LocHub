import { describe, expect, it } from 'vitest';
import { countRichTextTags, isCosmeticChange, parsePattern, richTextTagsBalanced, summarizeRichTags } from '../src/ueText.js';

describe('parsePattern', () => {
  it('collects argument names in order of first appearance', () => {
    expect(parsePattern('Collect {Count} bales from {Place}, {Count} left').args).toEqual(['Count', 'Place']);
  });

  it('treats backtick-escaped braces as literals', () => {
    const p = parsePattern('Use `{braces`} and ``ticks');
    expect(p.args).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it('parses plural forms into a map', () => {
    const p = parsePattern('{Count}|plural(one=bale,other=bales)');
    expect(p.modifiers).toEqual([
      { arg: 'Count', kind: 'plural', name: 'plural', forms: { one: 'bale', other: 'bales' }, positional: [] },
    ]);
  });

  it('finds arguments nested inside plural forms without errors', () => {
    const p = parsePattern('{Count}|plural(one={Count} bale of {Kind},other={Count} bales of {Kind})');
    expect(p.args).toEqual(['Count', 'Kind']);
    expect(p.errors).toEqual([]);
  });

  it('keeps commas inside quoted plural values', () => {
    const p = parsePattern('{N}|plural(one="a, b",other=c)');
    expect(p.modifiers[0]?.forms).toEqual({ one: 'a, b', other: 'c' });
  });

  it('reads gender values positionally', () => {
    const p = parsePattern('{G}|gender(le,la)');
    expect(p.modifiers[0]?.kind).toBe('gender');
    expect(p.modifiers[0]?.positional).toEqual(['le', 'la']);
  });

  it('reports an unclosed brace', () => {
    expect(parsePattern('Collect {Count bales').errors.length).toBeGreaterThan(0);
  });

  it('reports a stray closing brace', () => {
    expect(parsePattern('Collect Count} bales').errors.length).toBeGreaterThan(0);
  });
});

// m-1: shapes the engine compiles differently from a naive read of the pattern, confirmed against
// TextFormatArgumentModifier.cpp and TextFormatter.cpp (UE 5.8 and 5.6 are byte-identical in the cited ranges).
describe('parsePattern: modifier shapes the engine prints as literal text', () => {
  it('flags a modifier keyword with the wrong case (engine keyword lookup is case-sensitive: ITextFormatArgumentModifier.h:135-158 Strncmp against the lowercase names TextFormatter.cpp:995-998 registers)', () => {
    const p = parsePattern('{Count}|Plural(one=bale,other=bales)');
    expect(p.errors).toEqual(['Modifier names are case-sensitive in Unreal: "|Plural(" on {Count} must be "|plural(", or it will print as literal text']);
  });

  it('flags an unregistered modifier name (TextFormatter.cpp:205-208: no compile function found -> no token added)', () => {
    const p = parsePattern('{Count}|plurl(one=bale,other=bales)');
    expect(p.errors).toEqual(['Unreal does not recognize the modifier "|plurl(" on {Count}; it will print as literal text, not be evaluated']);
  });

  it('flags an empty plural form value, unquoted or quoted (TextFormatArgumentModifier.cpp:89-93: ParseKeyValueArgs fails on a zero-length value, Create returns nullptr for the whole modifier)', () => {
    expect(parsePattern('{Count}|plural(one=,other=bales)').errors).toEqual([
      '|plural on {Count} has an empty value for "one"; Unreal fails to compile the whole modifier and prints it as literal text',
    ]);
    expect(parsePattern('{Count}|plural(one="",other=bales)').errors).toEqual([
      '|plural on {Count} has an empty value for "one"; Unreal fails to compile the whole modifier and prints it as literal text',
    ]);
  });

  it('does not flag a correctly-cased, fully-formed modifier', () => {
    expect(parsePattern('{Count}|plural(one=bale,other=bales)').errors).toEqual([]);
    expect(parsePattern('{G}|gender(le,la)').errors).toEqual([]);
  });

  it('truncates a plural modifier at the first unquoted ")", same as the engine\'s own parameter scan (TextFormatter.cpp:215-246, no nesting depth tracked)', () => {
    // The stray ')' after "(5" ends the modifier's argument list right there; "other=bales)" is left over as
    // ordinary pattern text (no braces in it, so it adds no further args or errors by itself).
    const p = parsePattern('{Count}|plural(one=(5),other=bales)');
    expect(p.modifiers).toEqual([{ arg: 'Count', kind: 'plural', name: 'plural', forms: { one: '(5' }, positional: [] }]);
  });
});

describe('summarizeRichTags', () => {
  it('counts paired and self-closing tags', () => {
    expect(summarizeRichTags('<Bold>Hi</> <img id="x"/>')).toEqual({
      names: ['Bold', 'img'],
      closers: 1,
      selfClosing: 1,
    });
  });

  it('ignores a lone less-than sign', () => {
    expect(summarizeRichTags('Speed < 50').names).toEqual([]);
  });
});

// Port of the engine's loc compile check (TextLocalizationResourceGenerator.cpp CountRichTextTags /
// ValidateRichTextTags, UE 5.8), the same rule LocHubValidator ports on the C++ side.
describe('richTextTagsBalanced', () => {
  it('counts <Tag> as opening and </> as closing, but not a self-closing tag or <br>', () => {
    expect(countRichTextTags('<Bold>Hi</> <img id="x"/> Line<br>Next')).toEqual({ opening: 1, closing: 1 });
  });

  it('accepts balanced tags and rejects an unclosed one', () => {
    expect(richTextTagsBalanced('<Bold>Hi</>', '<Bold>Привет</>')).toBe(true);
    expect(richTextTagsBalanced('<Bold>Hi</>', '<Bold>Привет')).toBe(false);
  });

  it('keeps an imbalance the source has too (deliberate, e.g. for concatenation)', () => {
    expect(richTextTagsBalanced('<Bold>Hi', '<Bold>Привет')).toBe(true);
    expect(richTextTagsBalanced('<Bold>Hi', '<Bold><Italic>Привет')).toBe(false);
  });
});

describe('isCosmeticChange', () => {
  it('ignores case, spacing and trailing punctuation', () => {
    expect(isCosmeticChange('Press E.', 'press  e')).toBe(true);
  });

  it('never treats a renamed argument as cosmetic', () => {
    expect(isCosmeticChange('{Count} left', '{count} left')).toBe(false);
  });

  it('is false for identical strings and for real rewrites', () => {
    expect(isCosmeticChange('Load', 'Load')).toBe(false);
    expect(isCosmeticChange('Load the truck', 'Unload the truck')).toBe(false);
  });

  // A Chinese, Japanese or Korean source ends sentences with fullwidth punctuation and may use the ideographic
  // space: editing only those must keep approvals, exactly as it does for ASCII punctuation in an English source.
  it('treats trailing fullwidth punctuation and the ideographic space as cosmetic', () => {
    expect(isCosmeticChange('返回主菜单。', '返回主菜单')).toBe(true);
    expect(isCosmeticChange('返回主菜单！', '返回主菜单？')).toBe(true);
    expect(isCosmeticChange('确定，', '确定')).toBe(true);
    expect(isCosmeticChange('新的　游戏', '新的 游戏')).toBe(true);
  });

  it('is false for a real rewrite of a Chinese source', () => {
    expect(isCosmeticChange('返回主菜单', '退出游戏')).toBe(false);
    expect(isCosmeticChange('返回主菜单。', '返回主菜单吗？')).toBe(false);
  });
});
