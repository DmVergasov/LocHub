import { describe, expect, it } from 'vitest';
import type { PluralForms } from '../src/contract.js';
import { blocksAutoAccept, hasHardIssues, pluralCategories, precheck, type PluralType, type PrecheckIssue } from '../src/precheck.js';

const codes = (src: string, tr: string, dnt: string[] = []) =>
  precheck(src, tr, 'ru', { dntTerms: dnt }).map((i) => i.code);

const codesIn = (culture: string, src: string, tr: string) => precheck(src, tr, culture, { dntTerms: [] }).map((i) => i.code);

describe('pluralCategories', () => {
  it('returns the CLDR cardinal categories for Russian', () => {
    expect(pluralCategories('ru', 'cardinal').sort()).toEqual(['few', 'many', 'one', 'other']);
  });
});

describe('precheck', () => {
  it('accepts a complete Russian plural', () => {
    expect(
      codes('{Count}|plural(one=bale,other=bales) left', '{Count}|plural(one=тюк,few=тюка,many=тюков,other=тюка) осталось'),
    ).toEqual([]);
  });

  it('rejects a Russian plural without the few form', () => {
    expect(codes('{Count}|plural(one=bale,other=bales)', '{Count}|plural(one=тюк,many=тюков,other=тюка)')).toContain(
      'plural_forms_missing',
    );
  });

  it('allows adding a plural modifier the source did not have', () => {
    expect(codes('{Count} bales left', 'Осталось {Count}|plural(one=тюк,few=тюка,many=тюков,other=тюка)')).toEqual([]);
  });

  it('rejects dropping a plural modifier the source had', () => {
    expect(codes('{Count}|plural(one=bale,other=bales)', '{Count} тюков')).toContain('plural_dropped');
  });

  it('reports missing and unknown arguments', () => {
    const c = codes('Deliver {Count} bales to {Place}', 'Доставьте {Amount} тюков');
    expect(c).toContain('args_missing');
    expect(c).toContain('args_extra');
  });

  it('does not see escaped braces as arguments', () => {
    expect(codes('Use `{ and `} here', 'Используйте `{ и `} здесь')).toEqual([]);
  });

  it('reports changed rich text tags', () => {
    expect(codes('<Bold>Warning</>: {Text}', 'Внимание: {Text}')).toContain('rich_tags');
  });

  it('keeps do-not-translate terms verbatim', () => {
    expect(codes('Welcome to MyGame', 'Добро пожаловать в Трудягу', ['MyGame'])).toContain('dnt');
  });

  it('flags an untranslated string as soft', () => {
    const issues = precheck('Settings', 'Settings', 'ru', { dntTerms: [] });
    expect(issues.map((i) => i.code)).toEqual(['untranslated']);
    expect(hasHardIssues(issues)).toBe(false);
  });

  // A Chinese, Japanese or Korean word is often one or two characters: a short CJK source copied verbatim into an
  // English translation is untranslated, even though it is shorter than the three letters a Latin word needs.
  it('flags a short CJK source copied verbatim', () => {
    expect(codesIn('en', '设置', '设置')).toEqual(['untranslated']);
    expect(codesIn('en', '開始', '開始')).toEqual(['untranslated']);
    expect(codesIn('en', 'はい', 'はい')).toEqual(['untranslated']);
    expect(codesIn('en', '확인', '확인')).toEqual(['untranslated']);
  });

  it('does not flag a CJK do-not-translate term kept verbatim, or CJK punctuation alone', () => {
    expect(codes('原神', '原神', ['原神'])).toEqual([]);
    expect(codes('OK。', 'OK。')).toEqual([]);
  });

  it('rejects an empty translation', () => {
    expect(codes('Load', '   ')).toEqual(['empty']);
  });
});

// Check tiers (owner-approved): 'hard' = Unreal rejects the text or prints it broken, so it can never be approved;
// 'confirm' = valid for Unreal but probably a mistake, so a human may approve it anyway; 'soft' = a hint.
describe('precheck: severity tiers', () => {
  const severityOf = (issues: readonly PrecheckIssue[], code: string) => issues.find((i) => i.code === code)?.severity;
  const inRu = (src: string, tr: string, dnt: string[] = []) => precheck(src, tr, 'ru', { dntTerms: dnt });
  const RU_PLURAL = '{Count}|plural(one=тюк,few=тюка,many=тюков,other=тюка)';

  it.each([
    ['empty', 'Load', '   '],
    ['syntax', '{Count} bales left', 'Осталось {Count тюков'],
    ['args_extra', '{Count} bales left', 'Осталось {Count} тюков {Extra}'],
    ['plural_forms_missing', '{Count}|plural(one=bale,other=bales)', '{Count}|plural(one=тюк,other=тюков)'],
    ['plural_form_unused', '{Count}|plural(one=bale,other=bales)', '{Count}|plural(zero=нет,one=тюк,few=тюка,many=тюков,other=тюка)'],
    ['rich_tags_unbalanced', '<Bold>Hi</>', '<Bold>Привет'],
    // m-1: confirmed against engine source (see ueText.test.ts) -- each of these is printed as raw text in-game.
    ['syntax', '{Count}|plural(one=bale,other=bales)', '{Count}|Plural(one=тюк,few=тюка,many=тюков,other=тюка)'],
    ['syntax', '{Count}|plural(one=bale,other=bales)', '{Count}|plurl(one=тюк,few=тюка,many=тюков,other=тюка)'],
    ['syntax', '{Count}|plural(one=bale,other=bales)', '{Count}|plural(one=,few=тюка,many=тюков,other=тюка)'],
    // A stray unquoted ')' inside a form truncates the modifier the same way the engine's own parser does
    // (readModifier no longer tracks paren depth), so only 'one' survives and the rest is missing.
    ['plural_forms_missing', '{Count}|plural(one=bale,other=bales)', '{Count}|plural(one=(тюк),other=тюка)'],
  ])('%s is hard', (code, src, tr) => {
    expect(severityOf(inRu(src, tr), code)).toBe('hard');
  });

  it('plural_redundant is hard', () => {
    expect(severityOf(precheck('{Count}|plural(one=a,other=b)', '{Count}|plural(other=個)', 'ja', { dntTerms: [] }), 'plural_redundant')).toBe('hard');
  });

  it.each([
    ['args_missing', '{Count} bales left', 'Тюков осталось', []],
    ['plural_dropped', '{Count}|plural(one=bale,other=bales)', 'Тюков: {Count}', []],
    ['rich_tags', '<Bold>Warning</>: {Text}', 'Внимание: {Text}', []],
    ['dnt', 'Welcome to MyGame', 'Добро пожаловать в Трудягу', ['MyGame']],
    ['plural_unknown_form', '{Count}|plural(one=bale,other=bales)', `${RU_PLURAL.slice(0, -1)},several=тюков)`, []],
  ])('%s is confirm', (code, src, tr, dnt) => {
    const issues = inRu(src, tr, dnt);
    expect(severityOf(issues, code)).toBe('confirm');
    expect(hasHardIssues(issues)).toBe(false);
    expect(blocksAutoAccept(issues)).toBe(true);
  });

  it('untranslated stays soft and blocks nothing', () => {
    const issues = inRu('Settings', 'Settings');
    expect(severityOf(issues, 'untranslated')).toBe('soft');
    expect(blocksAutoAccept(issues)).toBe(false);
  });

  // A form name the engine's parser cannot read makes the whole modifier fail to compile, so it prints as raw text.
  it('a plural form name Unreal cannot parse is a hard syntax issue, not an unknown form', () => {
    const issues = inRu('{Count}|plural(one=bale,other=bales)', `${RU_PLURAL.slice(0, -1)},one more=тюков)`);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['syntax', 'hard']]);
  });

  // Same rule as the engine's own loc compile check (TextLocalizationResourceGenerator.cpp ValidateRichTextTags).
  it('follows the engine rich-text rule: <br> is self-closing and an imbalance the source has too is kept', () => {
    expect(inRu('Line<br>Next', 'Строка<br>Далее')).toEqual([]);
    expect(inRu('<Bold>Hi', '<Bold>Привет')).toEqual([]);
    expect(severityOf(inRu('<Bold>Hi</> there', '<Bold>Привет там'), 'rich_tags_unbalanced')).toBe('hard');
  });
});

// ja has a single cardinal plural form ('other'): the engine rejects a |plural modifier there
// (FTextFormatArgumentModifier_PluralForm::Validate, TextFormatArgumentModifier.cpp), so the
// translation must drop it instead of being asked to keep it.
describe('precheck: single-plural-form cultures', () => {
  it('accepts a ja translation that drops the plural modifier the source had', () => {
    expect(
      codesIn('ja', '{Count}|plural(one=You have {Count} item,other=You have {Count} items)', '{Count}個のアイテムがあります'),
    ).toEqual([]);
  });

  it('rejects a ja translation that keeps the plural modifier', () => {
    expect(
      codesIn('ja', '{Count}|plural(one=You have {Count} item,other=You have {Count} items)', '{Count}|plural(other={Count}個)'),
    ).toContain('plural_redundant');
  });

  it('does not also raise plural_dropped for a single-form culture', () => {
    expect(
      codesIn('ja', '{Count}|plural(one=You have {Count} item,other=You have {Count} items)', '{Count}個のアイテムがあります'),
    ).not.toContain('plural_dropped');
  });

  it('a multi-form culture still requires the modifier to stay (de cardinal: one, other)', () => {
    expect(codesIn('de', '{Count}|plural(one=bale,other=bales)', '{Count} Ballen')).toContain('plural_dropped');
  });

  it('rejects an ordinal modifier kept for a culture whose ordinal has a single category (de: other)', () => {
    expect(
      codesIn('de', '{Place}|ordinal(one=1st,two=2nd,few=3rd,other=nth)', '{Place}|ordinal(other=.)'),
    ).toContain('plural_redundant');
  });
});

// The engine validates with its own ICU (UE 5.8: ICU 64), whose CLDR can differ from Node's: Node 22 answers
// fr cardinal = one, many, other, while the engine only knows one, other and rejects a 'many' form as unused
// (FTextFormatArgumentModifier_PluralForm::Validate). The plugin sends the engine's forms with every Push; they win.
describe('precheck: plural categories from the engine', () => {
  const FR_ENGINE: PluralForms = { cardinal: ['one', 'other'], ordinal: ['one', 'other'] };
  const engine = (forms: PluralForms) => (type: PluralType) => forms[type];
  const src = '{Count}|plural(one=bale,other=bales) left';
  const inFr = (tr: string, plurals = engine(FR_ENGINE)) => precheck(src, tr, 'fr', { dntTerms: [], plurals });

  it('passes a translation that carries exactly the engine forms', () => {
    expect(inFr('{Count}|plural(one=botte,other=bottes) restante(s)')).toEqual([]);
  });

  it('flags a form the engine does not use for the culture as a hard plural_form_unused', () => {
    const issues = inFr('{Count}|plural(one=botte,many=bottes,other=bottes) restante(s)');
    expect(issues).toEqual([expect.objectContaining({ code: 'plural_form_unused', severity: 'hard' })]);
    expect(issues[0]!.message).toContain('many');
  });

  it('still requires every engine form', () => {
    expect(inFr('{Count}|plural(other=bottes) restantes').map((i) => i.code)).toEqual(['plural_forms_missing']);
  });

  it('applies the single-form rule to the engine forms', () => {
    const single = engine({ cardinal: ['other'], ordinal: ['other'] });
    expect(inFr('{Count}|plural(other=bottes) restantes', single).map((i) => i.code)).toEqual(['plural_redundant']);
    expect(inFr('{Count} bottes restantes', single)).toEqual([]);
  });

  it('falls back to Node when the engine sent no forms for the culture', () => {
    const tr = '{Count}|plural(one=botte,other=bottes) restante(s)';
    const node = (type: PluralType) => pluralCategories('fr', type);
    expect(precheck(src, tr, 'fr', { dntTerms: [] })).toEqual(inFr(tr, node));
  });

  it('flags an unused form under the Node fallback too (de cardinal: one, other)', () => {
    expect(codesIn('de', src, '{Count}|plural(one=Ballen,few=Ballen,other=Ballen) übrig')).toEqual(['plural_form_unused']);
  });
});

describe('precheck: too_long (Length Check)', () => {
  const MESSAGE_21_OF_10 = 'Too long for the UI: 21/10 characters (Length Check in Project Settings)';

  it('flags a translation over the limit with the configured severity', () => {
    expect(precheck('Save', 'Speichern jetzt bitte', 'de', { dntTerms: [], length: { limit: 10, severity: 'soft' } })).toEqual([
      { code: 'too_long', severity: 'soft', message: MESSAGE_21_OF_10 },
    ]);
    const confirm = precheck('Save', 'Speichern jetzt bitte', 'de', { dntTerms: [], length: { limit: 10, severity: 'confirm' } });
    expect(confirm).toEqual([{ code: 'too_long', severity: 'confirm', message: MESSAGE_21_OF_10 }]);
    expect(blocksAutoAccept(confirm)).toBe(true);
  });

  it('passes a translation exactly at the limit and flags one character more', () => {
    const at = (translation: string) => precheck('Save', translation, 'de', { dntTerms: [], length: { limit: 10, severity: 'soft' } });
    expect(at('Speichern!')).toEqual([]);
    expect(at('Speichern!!').map((i) => i.code)).toEqual(['too_long']);
  });

  it('measures visible characters: arguments and tags count 0', () => {
    const issues = precheck('<Bold>{Count}</> left', '<Bold>{Count}</> übrig', 'de', { dntTerms: [], length: { limit: 6, severity: 'soft' } });
    expect(issues).toEqual([]);
  });

  it('never flags length without a limit', () => {
    expect(precheck('Save', 'Speichern jetzt bitte', 'de', { dntTerms: [] })).toEqual([]);
  });
});
