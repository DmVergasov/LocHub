import type Anthropic from '@anthropic-ai/sdk';
import { isOutdated, type Culture, type GlossaryTerm, type PluralForms } from './contract.js';
import { canonicalJson } from './ids.js';
import type { Neighbor, WorkGroup } from './grouping.js';
import { pluralCategories } from './precheck.js';
import { parsePattern } from './ueText.js';

export interface CultureContext {
  culture: Culture;
  // The localization target's native culture: the language of every source text (job.ts cultureContext fills it from
  // the store's last Push); absent or '' when no Push has reported it.
  sourceCulture?: Culture;
  brief: string;
  style: string;
  glossary: GlossaryTerm[];
  // The categories the engine validates against (job.ts cultureContext fills them from the last Push);
  // absent means Node's own ICU answer for `culture`.
  plurals?: PluralForms;
}

export interface RepairInfo {
  previous: string;
  errors: string[];
}

export interface TranslateExtras {
  repair?: ReadonlyMap<string, RepairInfo>;
  neighbors?: readonly Neighbor[];
  // Answered inbox questions per unit id, until the next Push brings them back as DevNotes.
  answers?: ReadonlyMap<string, readonly string[]>;
  // Length Check limit per unit id (Tell the Translator): the item carries it as maxLength.
  maxLength?: ReadonlyMap<string, number>;
}

// v2: items may carry maxLength (Length Check). v3: the source culture is named in the culture block instead of the
// rules assuming English. Bumped so a draft's provenance tells which rules produced it.
export const PROMPT_VERSION = 'translate-v3';

const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

// "Simplified Chinese (zh-Hans)" for a culture ICU knows; "the source language (<code>)" for one it does not, or
// for a malformed code (Intl.DisplayNames throws on those), and "the source language" when there is no code at all.
export function describeCulture(code: string): string {
  if (code === '') return 'the source language';
  let name: string | undefined;
  try {
    name = LANGUAGE_NAMES.of(code);
  } catch {
    name = undefined;
  }
  return name ? `${name} (${code})` : `the source language (${code})`;
}

export const TRANSLATE_RULES = [
  'You translate video game strings from the source culture into the target culture for an Unreal Engine 5 game.',
  'Hard rules:',
  '- Keep every {Argument} exactly as written: same names, same case. Never translate argument names.',
  '- Keep format modifiers {Arg}|plural(...), {Arg}|ordinal(...), {Arg}|gender(...), {Arg}|hpp(...).',
  '  Inside plural and ordinal use the CLDR categories of the target culture and write every required category.',
  '  When the target culture has a single plural (or ordinal) category, the engine rejects the modifier: write the',
  '  argument plainly, with no |plural(...) or |ordinal(...), even when the source has one.',
  '  You may add |plural(...) to an existing numeric argument when the target culture needs more than one category.',
  '- The backtick is an escape character: `{ `} `| and `` must stay exactly as written.',
  '- Keep rich text tags exactly: <Style>text</> and self-closing <img id="..."/>; keep the entities &quot; &lt; &gt; &amp;.',
  '- Keep leading and trailing spaces and line breaks. Keep ALL CAPS when the source is ALL CAPS.',
  '- Glossary terms marked DNT stay verbatim; other glossary terms use the given translation, inflected as grammar requires.',
  '- The strings of one request belong together (same asset, screen or quest): keep terminology and tone consistent.',
  'Per item:',
  '- ambiguity = none when the meaning is clear, context when the given context decided between readings, guessed when you had to guess.',
  '- When ambiguity is guessed, put up to 3 alternative translations into alts and a short question for the developer into question.',
  '- Otherwise alts is an empty array and question is an empty string.',
  '- terms_used lists the glossary terms you applied.',
  '- If an item has prev_source and prev (an earlier source and its translation), make the minimal edit of prev that matches the new source.',
  '- If an item has reviewer_note or answers, follow them: they come from the developers.',
  '- If an item has rejected_translation, a reviewer rejected that text: return a different translation.',
  '- neighbors are already translated strings of the same screen or asset: stay consistent with them.',
  '- If an item has previous_attempt and errors, return a corrected translation that fixes every listed error.',
  '- If an item has maxLength, keep the translation within maxLength visible characters: placeholders and tags count 0, CJK characters count 2. Prefer a natural shorter wording over abbreviations.',
  'Return exactly one result per input id.',
].join('\n');

export const JUDGE_RULES = [
  'You review translations of video game strings from the source culture into the target culture.',
  'Report only real problems: wrong meaning, wrong or inconsistent terminology against the glossary,',
  'ungrammatical or unnatural target text, wrong tone or register against the style guide, broken locale conventions.',
  'severity: critical = misleads the player or is offensive; major = wrong meaning or clearly wrong grammar;',
  'minor = wording a native speaker would improve.',
  'Do not report placeholders, format modifiers or markup: code checks them.',
  'For each issue give the full corrected translation in fix. Return an empty issues array when everything is fine.',
].join('\n');

export const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          translation: { type: 'string' },
          ambiguity: { type: 'string', enum: ['none', 'context', 'guessed'] },
          alts: { type: 'array', items: { type: 'string' } },
          question: { type: 'string' },
          terms_used: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'translation', 'ambiguity', 'alts', 'question', 'terms_used'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['minor', 'major', 'critical'] },
          category: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['id', 'severity', 'category', 'why', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['issues'],
  additionalProperties: false,
} as const;

export function buildCultureBlock(ctx: CultureContext): string {
  const glossary =
    ctx.glossary.length === 0
      ? '(empty)'
      : ctx.glossary
          .map((t) => (t.dnt ? `- ${t.term} => DNT (keep verbatim)` : `- ${t.term} => ${t.translation}${t.note ? ` (${t.note})` : ''}`))
          .join('\n');
  return [
    `Source culture: ${describeCulture(ctx.sourceCulture ?? '')}`,
    `Target culture: ${ctx.culture}`,
    `Plural categories (cardinal): ${(ctx.plurals?.cardinal ?? pluralCategories(ctx.culture, 'cardinal')).join(', ')}`,
    `Plural categories (ordinal): ${(ctx.plurals?.ordinal ?? pluralCategories(ctx.culture, 'ordinal')).join(', ')}`,
    '',
    'Project brief:',
    ctx.brief || '(none)',
    '',
    'Style guide:',
    ctx.style || '(none)',
    '',
    'Glossary:',
    glossary,
  ].join('\n');
}

function systemBlocks(rules: string, ctx: CultureContext): Anthropic.TextBlockParam[] {
  // The culture block changes only with the glossary or style guide; cache it for an hour (batches outlive 5 minutes).
  return [
    { type: 'text', text: rules },
    { type: 'text', text: buildCultureBlock(ctx), cache_control: { type: 'ephemeral', ttl: '1h' } },
  ];
}

export function buildTranslateParams(
  ctx: CultureContext,
  group: WorkGroup,
  model: string,
  extras: TranslateExtras = {},
): Anthropic.MessageCreateParamsNonStreaming {
  const { repair, neighbors = [], answers, maxLength } = extras;
  const items = group.items.map(({ unit, cell }) => {
    const item: Record<string, unknown> = {
      id: unit.id,
      source: unit.source,
      origin: unit.origin,
      dev_notes: unit.devNotes,
      args: parsePattern(unit.source).args,
    };
    if (Object.keys(unit.metadata).length > 0) item.metadata = unit.metadata;
    if (isOutdated(unit, cell)) {
      item.prev_source = cell.basedOnSource;
      item.prev = cell.text;
    }
    if (cell.status === 'rejected' && cell.note) item.reviewer_note = cell.note;
    if (cell.status === 'needs_fix' && cell.question) item.reviewer_note = cell.question;
    if (cell.status === 'rejected' && cell.text) item.rejected_translation = cell.text;
    const unitAnswers = answers?.get(unit.id);
    if (unitAnswers && unitAnswers.length > 0) item.answers = unitAnswers;
    const fix = repair?.get(unit.id);
    if (fix) {
      item.previous_attempt = fix.previous;
      item.errors = fix.errors;
    }
    const limit = maxLength?.get(unit.id);
    if (limit !== undefined) item.maxLength = limit;
    return item;
  });
  const body: Record<string, unknown> = { group: group.groupKey };
  if (neighbors.length > 0) body.neighbors = neighbors;
  body.items = items;
  return {
    model,
    max_tokens: 16000,
    system: systemBlocks(TRANSLATE_RULES, ctx),
    messages: [{ role: 'user', content: canonicalJson(body) }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
  };
}

export function buildJudgeParams(
  ctx: CultureContext,
  group: WorkGroup,
  translations: ReadonlyMap<string, string>,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const items = group.items
    .filter(({ unit }) => translations.has(unit.id))
    .map(({ unit }) => ({ id: unit.id, source: unit.source, translation: translations.get(unit.id)!, dev_notes: unit.devNotes, origin: unit.origin }));
  return {
    model,
    max_tokens: 16000,
    system: systemBlocks(JUDGE_RULES, ctx),
    messages: [{ role: 'user', content: canonicalJson({ group: group.groupKey, items }) }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
  };
}
