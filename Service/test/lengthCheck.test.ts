import { describe, expect, it } from 'vitest';
import { LENGTH_CHECK_OFF, lengthArgsOf, lengthLimitFor, visibleLength, type LengthCheckConfig } from '../src/lengthCheck.js';

describe('visibleLength', () => {
  it.each([
    ['empty', '', 0],
    ['plain text', 'Save & Quit', 11],
    ['named argument', 'Hello, {Name}!', 8],
    ['positional arguments', '{0} of {1}', 4],
    ['plural: its longest form', '{Count}|plural(one=bale,other=bales) left', 10],
    ['plural with quoted forms holding tags and arguments', '{Count}|plural(one="<Bold>{Count}</> bale",other="<Bold>{Count}</> bales") left', 11],
    ['gender: its longest form', '{Gender}|gender(Er,Sie,Es) kam an', 10],
    ['ordinal: its longest form', '{Place}|ordinal(one=st,two=nd,few=rd,other=th) place', 8],
    ['escaped braces', '`{Name`}', 6],
    ['escaped pipe', 'A `| B', 5],
    ['escaped backtick', '``', 1],
    ['a backtick before anything else is printed', '`x', 2],
    ['rich-text tags, closer and self-closing', '<Bold>Warning</>: low <img id="heart"/>', 13],
    ['a lone less-than sign is text', '2 < 3', 5],
    ['CJK ideographs count 2', '設定', 4],
    ['katakana with the prolonged sound mark', 'ニューゲーム', 12],
    ['CJK brackets and hiragana', '「はい」', 8],
    ['fullwidth Latin', 'ＡＢ', 4],
    ['halfwidth katakana counts 1', 'ｱｲ', 2],
    ['Hangul', '설정', 4],
    ['combining mark counts 0', 'é', 1],
    ['zero-width space', 'a​b', 2],
    ['zero-width joiner', 'a‍b', 2],
    ['byte order mark', '﻿OK', 2],
    ['emoji is one code point, not two UTF-16 units, and counts wide', '😀', 2],
    ['text and emoji', 'OK 👍', 5],
    ['emoji from the supplemental symbols and pictographs block counts wide', '🤖', 2],
    ['Devanagari vowel sign is a spacing mark and counts like ordinary text', 'हि', 2],
    ['each UE rich-text entity counts 1', '&amp;&lt;&gt;&quot;', 4],
    ['unclosed brace is text', 'a { b', 5],
    ['unmatched closing brace is text', 'a } b', 5],
    ['an unknown modifier prints as text', '{X}|shout(a)', 9],
    ['a wrong-case modifier prints as text', '{N}|Plural(one=a,other=b)', 22],
  ])('%s', (_name, text, expected) => {
    expect(visibleLength(text)).toBe(expected);
  });
});

describe('lengthLimitFor', () => {
  const ON: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'warning' };
  const ui = { source: 'Save & Quit', metadata: { 'LocHub.Kind': 'ui' } };
  const text = { source: 'Save & Quit', metadata: { 'LocHub.Kind': 'text' } };
  const unmarked = { source: 'Save & Quit', metadata: {} };

  it('is null while the check is off', () => {
    expect(lengthLimitFor(ui, 'de', LENGTH_CHECK_OFF)).toBeNull();
  });

  it('is ceil(visible length x ratio) + extra for a UI string under the UI scope', () => {
    // 11 x 1.3 = 14.3 -> 15, + 4
    expect(lengthLimitFor(ui, 'de', ON)).toBe(19);
  });

  it('skips non-UI strings and strings without a kind under the UI scope, and measures them under All strings', () => {
    expect(lengthLimitFor(text, 'de', ON)).toBeNull();
    expect(lengthLimitFor(unmarked, 'de', ON)).toBeNull();
    expect(lengthLimitFor(text, 'de', { ...ON, scope: 'all' })).toBe(19);
  });

  it('uses the exact culture override, case-insensitively', () => {
    expect(lengthLimitFor(ui, 'PT-br', { ...ON, ratios: { 'pt-BR': 2 } })).toBe(26);
  });

  it('falls back to the language part, and the exact culture wins over its language', () => {
    const config = { ...ON, ratios: { de: 1.5, 'de-AT': 2 } };
    expect(lengthLimitFor(ui, 'de-AT', config)).toBe(26);
    // 11 x 1.5 = 16.5 -> 17, + 4
    expect(lengthLimitFor(ui, 'de-CH', config)).toBe(21);
    expect(lengthLimitFor(ui, 'fr', config)).toBe(19);
  });

  it('gives no limit to a source with nothing visible', () => {
    expect(lengthLimitFor({ source: '{Name}', metadata: { 'LocHub.Kind': 'ui' } }, 'de', ON)).toBeNull();
  });

  it('rounds up exactly, without floating point drift', () => {
    const exact = { ...ON, scope: 'all' as const, extra: 0 };
    // 50 x 1.1 is 55; plain floating point makes 55.00000000000001 of it and would round up to 56.
    expect(lengthLimitFor({ source: 'x'.repeat(50), metadata: {} }, 'de', { ...exact, ratio: 1.1 })).toBe(55);
    // 7 x 1.15 = 8.05 -> 9
    expect(lengthLimitFor({ source: 'x'.repeat(7), metadata: {} }, 'de', { ...exact, ratio: 1.15 })).toBe(9);
    expect(lengthLimitFor({ source: 'x'.repeat(10), metadata: {} }, 'de', { ...exact, ratio: 1 })).toBe(10);
  });
});

describe('lengthArgsOf', () => {
  it('writes only the off switch while the check is off', () => {
    expect(lengthArgsOf(LENGTH_CHECK_OFF)).toBe('--length-check off');
  });

  // The same literals as LocHubLengthCheckTests.cpp (LocHub.LengthCheck.Arguments): the editor builds these strings.
  it('writes every flag with two-decimal ratios, overrides in their given order, the way the editor builds them', () => {
    expect(lengthArgsOf({ ...LENGTH_CHECK_OFF, mode: 'warning' })).toBe(
      '--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4 --length-hint on',
    );
    expect(lengthArgsOf({ mode: 'confirm', scope: 'all', ratio: 1, extra: 100, ratios: { de: 1.5, ja: 5, 'pt-BR': 1.2 }, hint: false })).toBe(
      '--length-check confirm --length-scope all --length-ratio 1.00 --length-extra 100 --length-ratios de=1.50,ja=5.00,pt-BR=1.20 --length-hint off',
    );
  });
});
