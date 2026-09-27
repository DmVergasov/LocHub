// Unreal inline codes inside a translatable string, for the XLIFF exchange. A format argument without a modifier
// ({Name}, {0}) and a rich-text tag (<Tag attr="v">, </>, <Tag/>) are codes a CAT tool must protect; an argument with
// a modifier ({Count}|plural(one=...,other=...)) stays text, since its branches need translating. A backtick escapes
// only these four characters: backtick, {, }, | — so an escaped brace or pipe is text, but a backtick before < is
// literal and the tag still codes.
export interface InlinePart {
  code: boolean;
  text: string;
}

const ESCAPE = '`';
const ESCAPED_CHARS = new Set(['`', '{', '}', '|']);
const TAG = /<[\w.-]+(?:\s+[\w.-]+="[^"]*")*\s*\/?>/y;
const MODIFIER_NAME = /[A-Za-z]+\(/y;

// Unreal ends a modifier at the first unquoted ')' (TextFormatter.cpp, ParseArgumentModifier). Inside the modifier
// body, a backtick escapes any next character (Service/src/ueText.ts readModifier line ~113). Returns the index after
// the closing ')', or -1 when the modifier never closes.
function modifierEnd(text: string, start: number): number {
  let inQuotes = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === ESCAPE && i + 1 < text.length) {
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ')') return i + 1;
  }
  return -1;
}

export function splitInlineCodes(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let plain = '';
  const code = (value: string) => {
    if (plain) parts.push({ code: false, text: plain });
    plain = '';
    parts.push({ code: true, text: value });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const nextChar = text[i + 1];
    if (c === ESCAPE && nextChar && ESCAPED_CHARS.has(nextChar)) {
      plain += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '{') {
      const close = text.indexOf('}', i + 1);
      if (close < 0) {
        plain += text.slice(i);
        break;
      }
      const after = close + 1;
      if (text[after] === '|') {
        MODIFIER_NAME.lastIndex = after + 1;
        if (MODIFIER_NAME.test(text)) {
          const end = modifierEnd(text, MODIFIER_NAME.lastIndex);
          const stop = end < 0 ? text.length : end;
          plain += text.slice(i, stop);
          i = stop;
          continue;
        }
      }
      code(text.slice(i, after));
      i = after;
      continue;
    }
    if (c === '<') {
      if (text.startsWith('</>', i)) {
        code('</>');
        i += 3;
        continue;
      }
      TAG.lastIndex = i;
      const tag = TAG.exec(text);
      if (tag) {
        code(tag[0]);
        i += tag[0].length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  if (plain) parts.push({ code: false, text: plain });
  return parts;
}
