// Fast deterministic checks used for the repair loop and the human gate. The engine re-validates on Pull and has the
// final word (FTextFormat::ValidatePattern, Engine/Source/Runtime/Core/Public/Internationalization/Text.h:386).
import { visibleLength } from './lengthCheck.js';
import { countRichTextTags, parsePattern, richTextTagsBalanced, summarizeRichTags } from './ueText.js';

// hard: Unreal rejects the text or prints it broken (ValidatePattern fails, a placeholder or modifier shows as raw
//       text, the loc compile flags the rich-text tags); nobody can approve it.
// confirm: valid for Unreal but probably a mistake; a human may approve it anyway (cells.ts `accept`), an AI draft
//       with one is never written as a plain draft.
// soft: a hint only.
export type IssueSeverity = 'hard' | 'confirm' | 'soft';

export interface PrecheckIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

export type PluralType = 'cardinal' | 'ordinal';

// The plural categories a culture uses for one plural type.
export type PluralLookup = (type: PluralType) => readonly string[];

export interface PrecheckOptions {
  dntTerms: string[];
  // The engine's categories when the plugin sent them (LocHubStore.pluralCategoriesFor); absent means Node's.
  plurals?: PluralLookup;
  // The Length Check limit of this unit in this culture (cells.ts precheckOptionsFor, lengthCheck.ts lengthLimitFor)
  // and the severity an over-limit translation gets: soft (Warning) or confirm (Must Confirm). Absent: no limit.
  length?: { limit: number; severity: 'soft' | 'confirm' };
}

// The Length Check issue; job.ts repairs it even when it is soft.
export const TOO_LONG_CODE = 'too_long';

export const PLURAL_CATEGORIES: ReadonlySet<string> = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

// A plural form name the engine's key parser reads (FTextFormatArgumentModifier::ParseKeyValueArgs takes identifier
// characters only). Any other name makes the whole modifier fail to compile, so the game prints it as raw text.
// ASCII only on purpose: whether the engine's FChar::IsIdentifier accepts a non-ASCII letter depends on the C runtime.
const PLURAL_FORM_NAME = /^[A-Za-z0-9_]+$/;

// Node's own ICU answer: only the fallback for a culture the engine has not reported its forms for, since the
// two ICU versions disagree (Node 22's CLDR has fr/es/it/pt cardinal 'many', UE 5.8's ICU 64 does not).
export function pluralCategories(culture: string, type: PluralType): string[] {
  return [...new Intl.PluralRules(culture, { type }).resolvedOptions().pluralCategories] as string[];
}

// The human gate: a hard issue can never be approved or saved, not even with `accept`.
export function hasHardIssues(issues: readonly PrecheckIssue[]): boolean {
  return issues.some((i) => i.severity === 'hard');
}

// The AI gate: an AI draft with a hard or a confirm issue is written needs_fix, never as a plain draft.
export function blocksAutoAccept(issues: readonly PrecheckIssue[]): boolean {
  return issues.some((i) => i.severity !== 'soft');
}

// The distinct confirm codes a human must name in `accept` to approve or save the text anyway.
export function confirmCodes(issues: readonly PrecheckIssue[]): string[] {
  return [...new Set(issues.filter((i) => i.severity === 'confirm').map((i) => i.code))];
}

export function precheck(source: string, translation: string, culture: string, opts: PrecheckOptions): PrecheckIssue[] {
  if (translation.trim().length === 0) return [{ code: 'empty', severity: 'hard', message: 'Translation is empty' }];

  const issues: PrecheckIssue[] = [];
  const src = parsePattern(source);
  const tr = parsePattern(translation);
  // Unreal reads an unmatched brace or a malformed modifier as literal text: the player sees it raw.
  for (const error of tr.errors) issues.push({ code: 'syntax', severity: 'hard', message: error });

  // Unreal formats a pattern that leaves an argument out (a count the phrase does not need, a gender the language
  // does not have), but an argument the game never passes is printed as "{Name}".
  const missing = src.args.filter((a) => !tr.args.includes(a));
  const extra = tr.args.filter((a) => !src.args.includes(a));
  if (missing.length > 0)
    issues.push({ code: 'args_missing', severity: 'confirm', message: `Missing arguments: ${missing.join(', ')}` });
  if (extra.length > 0)
    issues.push({ code: 'args_extra', severity: 'hard', message: `Unknown arguments: ${extra.join(', ')}` });

  // A pluralized argument should stay pluralized in a culture with several plural forms (dropping it is valid for
  // Unreal, only suspicious); a culture with a single form (e.g. ja, zh-Hans, ko cardinal) makes the modifier
  // redundant and the engine rejects it outright (FTextFormatArgumentModifier_PluralForm::Validate,
  // TextFormatArgumentModifier.cpp), so there the translation must drop it instead.
  const categoriesOf = opts.plurals ?? ((type: PluralType) => pluralCategories(culture, type));
  for (const m of src.modifiers) {
    if (m.kind !== 'plural' && m.kind !== 'ordinal') continue;
    if (categoriesOf(m.kind === 'plural' ? 'cardinal' : 'ordinal').length === 1) continue;
    if (!tr.modifiers.some((t) => t.arg === m.arg && t.kind === m.kind))
      issues.push({ code: 'plural_dropped', severity: 'confirm', message: `{${m.arg}} lost its |${m.kind}(...) modifier` });
  }
  for (const m of tr.modifiers) {
    if (m.kind !== 'plural' && m.kind !== 'ordinal') continue;
    const have = Object.keys(m.forms);
    const unreadable = have.filter((k) => !PLURAL_FORM_NAME.test(k));
    if (unreadable.length > 0) {
      issues.push({
        code: 'syntax',
        severity: 'hard',
        message: `|${m.kind} on {${m.arg}} has form names Unreal cannot read: ${unreadable.map((k) => `"${k}"`).join(', ')}`,
      });
      continue;
    }
    const required = categoriesOf(m.kind === 'plural' ? 'cardinal' : 'ordinal');
    if (required.length === 1) {
      issues.push({
        code: 'plural_redundant',
        severity: 'hard',
        message: `{${m.arg}}|${m.kind} is not allowed in ${culture}: it has a single plural form — write the argument without the modifier`,
      });
      continue;
    }
    // The engine skips a form name outside the CLDR set (it compiles only zero..other) but rejects a CLDR form the
    // culture does not use ("has an unused plural form") as well as a missing one.
    const unknown = have.filter((k) => !PLURAL_CATEGORIES.has(k));
    const absent = required.filter((k) => !have.includes(k));
    const unused = have.filter((k) => PLURAL_CATEGORIES.has(k) && !required.includes(k));
    if (unknown.length > 0)
      issues.push({
        code: 'plural_unknown_form',
        severity: 'confirm',
        message: `|${m.kind} on {${m.arg}} has forms Unreal ignores: ${unknown.join(', ')}`,
      });
    if (absent.length > 0)
      issues.push({
        code: 'plural_forms_missing',
        severity: 'hard',
        message: `|${m.kind} on {${m.arg}} is missing forms required by ${culture}: ${absent.join(', ')}`,
      });
    if (unused.length > 0)
      issues.push({
        code: 'plural_form_unused',
        severity: 'hard',
        message: `|${m.kind} on {${m.arg}} has forms ${culture} does not use: ${unused.join(', ')} (it uses ${required.join(', ')})`,
      });
  }

  // The engine only cares that tags are balanced (TextLocalizationResourceGenerator.cpp ValidateRichTextTags); a
  // span split in two or merged is valid markup, only suspicious.
  const srcTags = summarizeRichTags(source);
  const trTags = summarizeRichTags(translation);
  if (srcTags.names.join('|') !== trTags.names.join('|') || srcTags.closers !== trTags.closers)
    issues.push({
      code: 'rich_tags',
      severity: 'confirm',
      message: `Rich text tags differ: source [${srcTags.names.join(', ')}], translation [${trTags.names.join(', ')}]`,
    });
  if (!richTextTagsBalanced(source, translation)) {
    const { opening, closing } = countRichTextTags(translation);
    issues.push({
      code: 'rich_tags_unbalanced',
      severity: 'hard',
      message: `Rich text tags are not balanced: ${opening} opening tag(s) but ${closing} closing '</>'`,
    });
  }

  // The project's own glossary rule, not Unreal's: a one-off exception is sometimes right.
  for (const term of opts.dntTerms) {
    if (source.includes(term) && !translation.includes(term))
      issues.push({ code: 'dnt', severity: 'confirm', message: `Do-not-translate term "${term}" must stay verbatim` });
  }

  // Three letters make a Latin-script word worth translating; one Chinese, Japanese or Korean character already does.
  const withoutDnt = opts.dntTerms.reduce((acc, t) => acc.split(t).join(''), source);
  if (translation.trim() === source.trim() && /\p{L}{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(withoutDnt))
    issues.push({ code: 'untranslated', severity: 'soft', message: 'Translation is identical to the source' });

  // Not Unreal's rule but the project's: text over the limit is likely to overflow its widget.
  if (opts.length) {
    const length = visibleLength(translation);
    if (length > opts.length.limit)
      issues.push({
        code: TOO_LONG_CODE,
        severity: opts.length.severity,
        message: `Too long for the UI: ${length}/${opts.length.limit} characters (Length Check in Project Settings)`,
      });
  }

  return issues;
}
