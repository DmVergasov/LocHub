// Helpers for Unreal Engine FText format patterns and rich text markup.
// Pattern syntax: Engine/Source/Runtime/Core/Public/Internationalization/TextFormatter.h:50-63
// ('{' '}' argument braces, '|' modifier char, backtick escape) and
// Engine/Source/Runtime/Core/Private/Internationalization/TextFormatArgumentModifier.h:16-75.
// Rich text: Engine/Source/Runtime/Slate/Private/Framework/Text/RichTextMarkupProcessing.cpp:15-18,63-64.

export type ModifierKind = 'plural' | 'ordinal' | 'gender' | 'hpp' | 'other';

export interface ArgModifier {
  arg: string;
  kind: ModifierKind;
  name: string;
  forms: Record<string, string>;
  positional: string[];
}

export interface ParsedPattern {
  args: string[];
  modifiers: ArgModifier[];
  errors: string[];
}

export interface RichTagSummary {
  names: string[];
  closers: number;
  selfClosing: number;
}

const ESCAPE = '`';

export function parsePattern(text: string): ParsedPattern {
  const result: ParsedPattern = { args: [], modifiers: [], errors: [] };
  scanPattern(text, result, new Set<string>());
  return result;
}

function scanPattern(s: string, out: ParsedPattern, seen: Set<string>): void {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ESCAPE && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === '}') {
      out.errors.push(`Unmatched '}' at ${i}`);
      i++;
      continue;
    }
    if (c !== '{') {
      i++;
      continue;
    }
    const end = s.indexOf('}', i + 1);
    if (end < 0) {
      out.errors.push(`Unclosed '{' at ${i}`);
      return;
    }
    const name = s.slice(i + 1, end).trim();
    if (name.length === 0) {
      out.errors.push(`Empty argument at ${i}`);
    } else if (!seen.has(name)) {
      seen.add(name);
      out.args.push(name);
    }
    i = end + 1;
    if (s[i] !== '|') continue;
    const mod = readModifier(s, i + 1);
    if (!mod) {
      out.errors.push(`Malformed modifier after {${name}}`);
      return;
    }
    const parsed = parseModifier(name, mod.name, mod.body);
    out.modifiers.push(parsed);
    // The engine looks up the modifier keyword case-sensitively (FCString::Strncmp via FTextFormatString's
    // operator==, ITextFormatArgumentModifier.h:135-158) against the lowercase names it registers
    // (TextFormatter.cpp:995-998: "plural", "ordinal", "gender", "hpp"). A different case, or a name it does
    // not register at all (kind 'other'), never resolves to a compile function; ParseArgumentModifier then
    // backs out with no token (TextFormatter.cpp:205-208), so the whole "|name(...)" is printed as literal text.
    if (parsed.kind === 'other') {
      out.errors.push(`Unreal does not recognize the modifier "|${parsed.name}(" on {${name}}; it will print as literal text, not be evaluated`);
    } else if (parsed.name !== parsed.kind) {
      out.errors.push(`Modifier names are case-sensitive in Unreal: "|${parsed.name}(" on {${name}} must be "|${parsed.kind}(", or it will print as literal text`);
    } else if (parsed.kind === 'plural' || parsed.kind === 'ordinal') {
      // ITextFormatArgumentModifier::ParseKeyValueArgs returns false as soon as a value is zero-length
      // (TextFormatArgumentModifier.cpp:89-93), for "one=" and for "one=\"\"" alike (an empty quoted string is
      // still zero-length once FParse::QuotedString unquotes it) -- Create() then returns nullptr for the
      // *whole* modifier, so it too is printed as literal text rather than compiled with the other forms.
      const empty = Object.entries(parsed.forms).filter(([, v]) => v === '').map(([k]) => k);
      if (empty.length > 0)
        out.errors.push(
          `|${parsed.kind} on {${name}} has an empty value for ${empty.map((k) => `"${k}"`).join(', ')}; Unreal fails to compile the whole modifier and prints it as literal text`,
        );
    }
    // Plural and gender values are patterns themselves and may reference arguments.
    for (const value of [...Object.values(parsed.forms), ...parsed.positional]) scanPattern(value, out, seen);
    i = mod.end;
  }
}

// Also used by lengthCheck.ts visibleLength, which walks the same argument/modifier structure.
export function readModifier(s: string, start: number): { name: string; body: string; end: number } | undefined {
  const match = /^[A-Za-z]+/.exec(s.slice(start));
  if (!match) return undefined;
  let i = start + match[0].length;
  if (s[i] !== '(') return undefined;
  const bodyStart = i + 1;
  let inQuotes = false;
  // The engine's own parameter-list scan (TextFormatter.cpp:215-246, ParseArgumentModifier) tracks no
  // nesting depth: it ends the modifier at the first unquoted ')', full stop. A stray, unquoted ')' inside a
  // form value therefore truncates the modifier there too (whatever follows becomes ordinary pattern text) --
  // matched here rather than depth-counted, so a plural with too few forms after truncation surfaces through
  // the existing plural_forms_missing/plural_form_unused checks instead of parsing as if it were well-formed.
  for (i = bodyStart; i < s.length; i++) {
    const c = s[i];
    if (c === ESCAPE) {
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (c === ')') return { name: match[0], body: s.slice(bodyStart, i), end: i + 1 };
  }
  return undefined;
}

export function parseModifier(arg: string, name: string, body: string): ArgModifier {
  const lower = name.toLowerCase();
  const kind: ModifierKind =
    lower === 'plural' || lower === 'ordinal' || lower === 'gender' || lower === 'hpp' ? lower : 'other';
  const forms: Record<string, string> = {};
  const positional: string[] = [];
  for (const part of splitTopLevel(body)) {
    const eq = kind === 'plural' || kind === 'ordinal' ? part.indexOf('=') : -1;
    if (eq > 0) forms[part.slice(0, eq).trim()] = unquote(part.slice(eq + 1).trim());
    else positional.push(unquote(part.trim()));
  }
  return { arg, kind, name, forms, positional };
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let braces = 0;
  let parens = 0;
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === ESCAPE && i + 1 < body.length) {
      current += c + body[i + 1];
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === ',' && braces === 0 && parens === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += c;
  }
  if (current.trim().length > 0 || parts.length > 0) parts.push(current);
  return parts;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

const OPEN_TAG = /<([\w.-]+)((?:\s+[\w.-]+="[^"]*")*)\s*(\/?)>/g;

export function summarizeRichTags(text: string): RichTagSummary {
  const names: string[] = [];
  let selfClosing = 0;
  for (const m of text.matchAll(OPEN_TAG)) {
    names.push(m[1]!);
    if (m[3] === '/') selfClosing++;
  }
  const closers = text.split('</>').length - 1;
  return { names: names.sort(), closers, selfClosing };
}

// Port of CountRichTextTags (Engine/Source/Developer/Localization/Private/TextLocalizationResourceGenerator.cpp:22-66,
// UE 5.8): any "<...>" counts as an opening tag except a self-closing "<.../>" and the historic "<br>", and only
// "</>" closes. JavaScript strings index UTF-16 code units, exactly like the engine's TCHAR on Windows.
export function countRichTextTags(text: string): { opening: number; closing: number } {
  let opening = 0;
  let closing = 0;
  let tagOpen = false;
  let tagLength = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<') {
      tagOpen = true;
      tagLength = 0;
    } else if (tagOpen) {
      if (c === '>') {
        if (text[i - 1] === '/') {
          if (tagLength === 1) closing++;
        } else if (!(tagLength === 2 && text[i - 2] === 'b' && text[i - 1] === 'r')) {
          opening++;
        }
        tagOpen = false;
      }
      tagLength++;
    }
  }
  return { opening, closing };
}

// Port of ValidateRichTextTags (same file, :67-91): balanced, or unbalanced in exactly the way the source is
// (a deliberate imbalance, e.g. for concatenation). The loc compile warns about anything else.
export function richTextTagsBalanced(source: string, translation: string): boolean {
  const tr = countRichTextTags(translation);
  if (tr.opening === tr.closing) return true;
  const src = countRichTextTags(source);
  return src.opening === tr.opening && src.closing === tr.closing;
}

export function normalizeForCosmetic(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?…:;,]+$/u, '').trim();
}

// A cosmetic change keeps approvals: case, whitespace or trailing punctuation only, same arguments and tags.
export function isCosmeticChange(before: string, after: string): boolean {
  if (before === after) return false;
  if (normalizeForCosmetic(before) !== normalizeForCosmetic(after)) return false;
  if (parsePattern(before).args.join('\u0000') !== parsePattern(after).args.join('\u0000')) return false;
  return summarizeRichTags(before).names.join('|') === summarizeRichTags(after).names.join('|');
}
