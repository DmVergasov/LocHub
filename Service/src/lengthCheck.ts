// Length Check (Project Settings > Plugins > LocHub > Length Check): how long a translation may get before it is
// likely to overflow the UI, measured in what the player sees. The web app imports visibleLength for the cell
// panel's counter (Web/src/review/CellPanel.tsx), so this module must stay free of Node-only imports.
import { KIND_METADATA_KEY, type Unit } from './contract.js';
import { parseModifier, readModifier } from './ueText.js';

export type LengthCheckMode = 'off' | 'warning' | 'confirm';

export interface LengthCheckConfig {
  // off: no limit anywhere. warning: an over-limit translation is a soft precheck issue (band Y). confirm: a confirm
  // issue (a human approves it anyway; an AI draft is written needs_fix).
  mode: LengthCheckMode;
  // ui: only units whose LocHub.Kind metadata is 'ui' (Project Settings' Ui Source Patterns); all: every unit.
  scope: 'ui' | 'all';
  ratio: number;
  extra: number;
  // Culture or language code -> ratio, in the order --length-ratios listed them; looked up case-insensitively.
  ratios: Record<string, number>;
  // Tell the Translator: each translate item carries its limit as maxLength.
  hint: boolean;
}

// What `serve` runs with when it gets no --length-* flags (an older plugin build, tests): off. The other fields are
// the Project Settings defaults, so `--length-check warning` alone behaves like a fresh project.
export const LENGTH_CHECK_OFF: LengthCheckConfig = { mode: 'off', scope: 'ui', ratio: 1.3, extra: 4, ratios: {}, hint: true };

// Text Format escapes (Engine/Source/Runtime/Core/Public/Internationalization/TextFormatter.h IsValidEscapeChar): the
// backtick is not printed, the escaped character is. A backtick before any other character is printed as is
// (TextFormatter.cpp ParseEscapedChar adds no token for it).
const ESCAPABLE = new Set(['`', '{', '}', '|']);

// Rich-text markup the player never sees: <Name attr="...">, the closer </>, a self-closing <Name .../>, <br>.
const TAG = /<(?:\/|[\w.-]+(?:\s+[\w.-]+="[^"]*")*\s*\/?)>/y;

// Marks that draw no glyph of their own: non-spacing (an accent drawn over the base character, e.g. the accent
// in é) and enclosing (a circle or box drawn around it). A spacing combining mark (`\p{Mc}`, e.g. the Devanagari
// vowel sign ि U+093F, or a Bengali/Tamil vowel sign) draws its own glyph next to the base character and must
// count like ordinary text, so it is deliberately not in this set.
const NONSPACING_MARK = /^[\p{Mn}\p{Me}]$/u;

// Invisible on screen: the zero-width space, the zero-width non-joiner and joiner, and the byte order mark used
// as a zero-width no-break space. Written with \u escapes, not the literal characters, so this source file
// itself carries no invisible bytes.
const ZERO_WIDTH = /^[\u200B\u200C\u200D\uFEFF]$/;

// East Asian Wide and Fullwidth blocks (Unicode UAX #11) a player sees at double width, plus the emoji blocks
// most likely in game text: Unicode renders every emoji at double width regardless of its own UAX #11 category.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK and Kangxi radicals, ideographic description, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, Kanbun, CJK strokes, enclosed CJK
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: misc symbols and pictographs, emoticons
  [0x1f900, 0x1f9ff], // Emoji: supplemental symbols and pictographs
  [0x20000, 0x3fffd], // CJK unified ideographs extension B and later
];

function codePointWidth(codePoint: number): number {
  const char = String.fromCodePoint(codePoint);
  if (NONSPACING_MARK.test(char) || ZERO_WIDTH.test(char)) return 0;
  return WIDE.some(([first, last]) => codePoint >= first && codePoint <= last) ? 2 : 1;
}

// UE rich-text markup escapes a literal '<', '>', '&' or '"' this way (prompt.ts tells the model to keep them);
// the player sees the single character each entity stands for, so each one counts 1, not its written length.
const ENTITIES: readonly string[] = ['&amp;', '&lt;', '&gt;', '&quot;'];

// The weighted length of what the player sees: arguments and tags count 0, a plural/ordinal/gender/hpp argument its
// longest form (measured the same way), CJK characters 2, marks and zero-width characters 0, anything else 1 per
// code point. A modifier Unreal does not evaluate (unknown, or the wrong case) prints as text and counts as text.
export function visibleLength(text: string): number {
  let length = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '`' && i + 1 < text.length && ESCAPABLE.has(text[i + 1]!)) {
      length += 1;
      i += 2;
      continue;
    }
    if (c === '&') {
      const entity = ENTITIES.find((e) => text.startsWith(e, i));
      if (entity) {
        length += 1;
        i += entity.length;
        continue;
      }
    }
    if (c === '<') {
      TAG.lastIndex = i;
      const tag = TAG.exec(text);
      if (tag) {
        i += tag[0].length;
        continue;
      }
    }
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      if (end >= 0) {
        const modifier = text[end + 1] === '|' ? readModifier(text, end + 2) : undefined;
        const parsed = modifier ? parseModifier(text.slice(i + 1, end).trim(), modifier.name, modifier.body) : undefined;
        if (modifier && parsed && parsed.kind !== 'other' && parsed.name === parsed.kind) {
          const branches = [...Object.values(parsed.forms), ...parsed.positional];
          length += Math.max(0, ...branches.map((branch) => visibleLength(branch)));
          i = modifier.end;
        } else {
          i = end + 1;
        }
        continue;
      }
    }
    const codePoint = text.codePointAt(i)!;
    length += codePointWidth(codePoint);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return length;
}

// Exact culture first, then its language (the part before the first '-'), then the default ratio; case-insensitive.
function ratioFor(culture: string, config: LengthCheckConfig): number {
  const entries = Object.entries(config.ratios);
  const find = (code: string) => entries.find(([key]) => key.toLowerCase() === code.toLowerCase())?.[1];
  return find(culture) ?? find(culture.split('-')[0]!) ?? config.ratio;
}

// The most visible characters a translation of `unit` into `culture` may have, or null when the check is off, the
// unit is out of scope, or its source has nothing visible.
export function lengthLimitFor(unit: Pick<Unit, 'source' | 'metadata'>, culture: string, config: LengthCheckConfig): number | null {
  if (config.mode === 'off') return null;
  if (config.scope === 'ui' && unit.metadata[KIND_METADATA_KEY] !== 'ui') return null;
  const length = visibleLength(unit.source);
  if (length === 0) return null;
  // Integer hundredths (a ratio carries two decimals): 50 x 1.1 must be 55, not the 55.00000000000001 floating point
  // makes of it.
  return Math.ceil((length * Math.round(ratioFor(culture, config) * 100)) / 100) + config.extra;
}

// The --length-* flags for `config`, in the one form both sides write them: the editor passes exactly this string
// (FLocHubServiceProcess::BuildLengthArguments) and /api/health reports it back as ai.lengthArgs, so the editor can tell
// whether the running service applies its Project Settings.
export function lengthArgsOf(config: LengthCheckConfig): string {
  if (config.mode === 'off') return '--length-check off';
  const ratios = Object.entries(config.ratios).map(([culture, ratio]) => `${culture}=${ratio.toFixed(2)}`);
  return [
    `--length-check ${config.mode}`,
    `--length-scope ${config.scope}`,
    `--length-ratio ${config.ratio.toFixed(2)}`,
    `--length-extra ${config.extra}`,
    ...(ratios.length > 0 ? [`--length-ratios ${ratios.join(',')}`] : []),
    `--length-hint ${config.hint ? 'on' : 'off'}`,
  ].join(' ');
}
