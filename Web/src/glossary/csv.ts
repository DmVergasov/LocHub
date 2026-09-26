// Pure CSV support for glossary Import/Export. No DOM access here: file picking and saving live in ../files.
import type { GlossaryTerm } from '../api/types';

const BOM = 0xfeff;

// The editor writes CSV as UTF-8 with a BOM; a plain UTF-8 file has none. `fatal: true` turns a mis-saved
// (non-UTF-8) file into a clear error instead of silently mangling every non-ASCII character.
export function decodeUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The file is not UTF-8. Save it as "CSV UTF-8" and import again.');
  }
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}

const DELIMITER_CANDIDATES = [',', ';', '\t'] as const;

// The header line, i.e. up to the first newline that is not inside a quoted field. Delimiter detection only
// looks at this line, matching a spreadsheet app's own "detect from the first row" behavior.
//
// A quote only opens a quoted field when it is the first character of that field (RFC 4180 / Excel); a quote
// found mid-field is a literal character. `atFieldStart` tracks the field boundary without needing to know the
// delimiter yet (headerLine runs before the delimiter is detected).
function headerLine(text: string): string {
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (inQuotes) {
        inQuotes = false;
      } else if (atFieldStart) {
        inQuotes = true;
      }
      atFieldStart = false;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) return text.slice(0, i);
    if (!inQuotes) atFieldStart = ch === ',' || ch === ';' || ch === '\t';
  }
  return text;
}

// Most frequent of , ; \t outside quotes on the header line; a tie (including no delimiter at all) keeps comma,
// since DELIMITER_CANDIDATES is checked in that order and a later candidate only wins by a strictly higher count.
// Same field-boundary rule as headerLine: a quote only opens quoted mode at the start of a field.
function detectDelimiter(text: string): string {
  const line = headerLine(text);
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (inQuotes) {
        inQuotes = false;
      } else if (atFieldStart) {
        inQuotes = true;
      }
      atFieldStart = false;
      continue;
    }
    if (!inQuotes && ch in counts) {
      counts[ch] = (counts[ch] ?? 0) + 1;
      atFieldStart = true;
      continue;
    }
    if (!inQuotes) atFieldStart = false;
  }
  let best: string = ',';
  let bestCount = counts[',']!;
  for (const candidate of DELIMITER_CANDIDATES) {
    if (counts[candidate]! > bestCount) {
      best = candidate;
      bestCount = counts[candidate]!;
    }
  }
  return best;
}

// RFC 4180: quoted fields, "" escapes a literal quote, and CR/LF/CRLF are all newlines, including inside a
// quoted field where they are kept as literal text rather than ending the row.
export function parseCsv(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A quote only opens a quoted field when it is the first character of that field; a quote appearing
      // after other content (the field buffer is non-empty) is a literal character, per RFC 4180 / Excel.
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) endRow();

  // A file ending in a blank line produces one phantom [''] row at the very end; drop it (but only at the end —
  // a blank line in the middle of the file is left alone).
  while (rows.length > 0) {
    const last = rows[rows.length - 1]!;
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  const headerLength = rows[0]?.length ?? 0;
  for (let r = 1; r < rows.length; r += 1) {
    const current = rows[r]!;
    while (current.length < headerLength) current.push('');
  }
  return rows;
}

export interface IncomingTerm {
  term: string;
  translation?: string;
  dnt?: boolean;
  note?: string;
}

export interface ReadGlossaryCsvOptions {
  cultures: readonly string[];
  nativeCulture: string;
  activeCulture: string;
}

export interface SkippedRow {
  line: number;
  reason: string;
}

export interface ReadGlossaryCsvResult {
  byCulture: Record<string, IncomingTerm[]>;
  skipped: SkippedRow[];
  ignoredColumns: string[];
}

const TERM_ALIASES = new Set(['term', 'source', 'source term']);
const TRANSLATION_ALIASES = new Set(['translation', 'target']);
const DNT_ALIASES = new Set(['dnt', 'do not translate', 'keep']);
const NOTE_ALIASES = new Set(['note', 'comment']);
const DNT_TRUE = new Set(['yes', 'y', 'true', '1', 'x', '+']);
const DNT_FALSE = new Set(['no', 'n', 'false', '0', '-', '']);

const normalizeCultureKey = (value: string): string => value.trim().toLowerCase().replace(/_/g, '-');

function parseDnt(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (DNT_TRUE.has(value)) return true;
  if (DNT_FALSE.has(value)) return false;
  return undefined;
}

interface ResolvedColumns {
  termIndex: number;
  cultureIndexes: Map<string, number>;
  dntIndex?: number;
  noteIndex?: number;
  ignoredColumns: string[];
}

function resolveColumns(header: readonly string[], cultures: readonly string[], nativeCulture: string, activeCulture: string): ResolvedColumns {
  const trimmed = header.map((cell) => cell.trim());
  const lower = trimmed.map((cell) => cell.toLowerCase());
  const used = new Set<number>();

  let termIndex = lower.findIndex((cell) => TERM_ALIASES.has(cell));
  if (termIndex === -1 && nativeCulture) {
    const nativeKey = normalizeCultureKey(nativeCulture);
    termIndex = trimmed.findIndex((cell) => normalizeCultureKey(cell) === nativeKey);
  }
  if (termIndex === -1) throw new Error('No "term" column. The first row must name the columns, e.g. term,translation,dnt,note.');
  used.add(termIndex);

  const cultureIndexes = new Map<string, number>();

  let translationIndex = -1;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (TRANSLATION_ALIASES.has(lower[i]!)) {
      translationIndex = i;
      break;
    }
  }
  if (translationIndex !== -1) {
    cultureIndexes.set(activeCulture, translationIndex);
    used.add(translationIndex);
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    if (used.has(i)) continue;
    const key = normalizeCultureKey(trimmed[i]!);
    const match = cultures.find((culture) => normalizeCultureKey(culture) === key);
    if (!match) continue;
    if (match === activeCulture && translationIndex !== -1) {
      throw new Error(`Both "translation" and "${activeCulture}" columns fill ${activeCulture}; keep one.`);
    }
    if (!cultureIndexes.has(match)) {
      cultureIndexes.set(match, i);
      used.add(i);
    }
  }

  let dntIndex: number | undefined;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (DNT_ALIASES.has(lower[i]!)) {
      dntIndex = i;
      used.add(i);
      break;
    }
  }

  let noteIndex: number | undefined;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (NOTE_ALIASES.has(lower[i]!)) {
      noteIndex = i;
      used.add(i);
      break;
    }
  }

  if (cultureIndexes.size === 0 && dntIndex === undefined) {
    throw new Error(`No translation column: add "translation" or one column per culture (${cultures.join(', ')}).`);
  }

  const ignoredColumns: string[] = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (!used.has(i)) ignoredColumns.push(trimmed[i]!);
  }

  return { termIndex, cultureIndexes, dntIndex, noteIndex, ignoredColumns };
}

interface TermEntry {
  term: string;
  line: number;
  dnt?: boolean;
  note?: string;
  perCulture: Map<string, string | undefined>;
}

export function readGlossaryCsv(rows: readonly string[][], options: ReadGlossaryCsvOptions): ReadGlossaryCsvResult {
  const { cultures, nativeCulture, activeCulture } = options;
  const header = rows[0];
  if (!header) throw new Error('No "term" column. The first row must name the columns, e.g. term,translation,dnt,note.');
  const columns = resolveColumns(header, cultures, nativeCulture, activeCulture);
  // Allowed only alongside a dnt column (resolveColumns already enforced that): every dnt term goes to the
  // active culture since the file names no culture column at all.
  const dntOnlyCulture = columns.cultureIndexes.size === 0 ? activeCulture : undefined;

  const skipped: SkippedRow[] = [];
  const byKey = new Map<string, TermEntry>();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rowIndex + 1; // header is line 1
    const row = rows[rowIndex]!;
    const term = (row[columns.termIndex] ?? '').trim();
    if (term === '') {
      skipped.push({ line, reason: 'empty term' });
      continue;
    }

    let dnt: boolean | undefined;
    if (columns.dntIndex !== undefined) {
      const raw = row[columns.dntIndex] ?? '';
      const parsed = parseDnt(raw);
      if (parsed === undefined) {
        skipped.push({ line, reason: `dnt value "${raw.trim()}" is not yes/no` });
        continue;
      }
      dnt = parsed;
    }

    const note = columns.noteIndex !== undefined ? (row[columns.noteIndex] ?? '').trim() : undefined;

    const perCulture = new Map<string, string | undefined>();
    if (dntOnlyCulture !== undefined) {
      if (dnt === true) perCulture.set(dntOnlyCulture, undefined);
    } else {
      for (const [culture, index] of columns.cultureIndexes) {
        const raw = (row[index] ?? '').trim();
        if (raw.length > 0) perCulture.set(culture, raw);
        else if (dnt === true) perCulture.set(culture, undefined);
      }
    }

    if (perCulture.size === 0) {
      skipped.push({ line, reason: 'no translation' });
      continue;
    }

    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      skipped.push({ line: existing.line, reason: `duplicate of line ${line}` });
      // Last one wins outright (not merged): drop and re-insert so this entry lands at its own (later) file
      // position instead of the earlier, now-discarded occurrence's position.
      byKey.delete(key);
    }
    byKey.set(key, { term, line, dnt, note, perCulture });
  }

  const byCulture: Record<string, IncomingTerm[]> = {};
  for (const entry of byKey.values()) {
    for (const [culture, translation] of entry.perCulture) {
      (byCulture[culture] ??= []).push({ term: entry.term, translation, dnt: entry.dnt, note: entry.note });
    }
  }

  skipped.sort((a, b) => a.line - b.line);
  return { byCulture, skipped, ignoredColumns: columns.ignoredColumns };
}

export interface MergeResult {
  terms: GlossaryTerm[];
  added: number;
  updated: number;
  unchanged: number;
}

// Match by trimmed lower-case term; the existing spelling and order are always kept. Only fields the incoming
// term actually sets are applied, and translation/note additionally need to be non-empty (an empty cell means
// "no value here", not "clear this field") — dnt has no such rule since false is a real, meaningful value.
export function mergeGlossary(existing: readonly GlossaryTerm[], incoming: readonly IncomingTerm[]): MergeResult {
  const key = (value: string) => value.trim().toLowerCase();
  const terms = existing.map((term) => ({ ...term }));
  const indexByKey = new Map(terms.map((term, index) => [key(term.term), index] as const));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const incomingTerm of incoming) {
    const existingIndex = indexByKey.get(key(incomingTerm.term));
    if (existingIndex === undefined) {
      terms.push({
        term: incomingTerm.term,
        translation: incomingTerm.translation ?? '',
        dnt: incomingTerm.dnt ?? false,
        note: incomingTerm.note ?? '',
      });
      indexByKey.set(key(incomingTerm.term), terms.length - 1);
      added += 1;
      continue;
    }

    const current = terms[existingIndex]!;
    const next = { ...current };
    let changed = false;
    if (incomingTerm.translation !== undefined && incomingTerm.translation !== '') {
      if (next.translation !== incomingTerm.translation) changed = true;
      next.translation = incomingTerm.translation;
    }
    if (incomingTerm.dnt !== undefined) {
      if (next.dnt !== incomingTerm.dnt) changed = true;
      next.dnt = incomingTerm.dnt;
    }
    if (incomingTerm.note !== undefined && incomingTerm.note !== '') {
      if (next.note !== incomingTerm.note) changed = true;
      next.note = incomingTerm.note;
    }
    terms[existingIndex] = next;
    if (changed) updated += 1;
    else unchanged += 1;
  }

  return { terms, added, updated, unchanged };
}

function needsQuoting(value: string): boolean {
  return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r');
}

// A cell starting with =, +, - or @ can be read as a formula by Excel/Sheets (formula injection); a leading tab
// defuses it without changing the value visually. The importer trims every cell before use (readGlossaryCsv), so
// the export -> import round trip strips the guard tab back off and the value comes back unchanged.
const FORMULA_INJECTION_PREFIXES = new Set(['=', '+', '-', '@']);

function csvField(value: string): string {
  const guarded = FORMULA_INJECTION_PREFIXES.has(value[0] ?? '') ? `\t${value}` : value;
  return needsQuoting(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function glossaryToCsv(terms: readonly GlossaryTerm[]): string {
  const lines = ['term,translation,dnt,note'];
  for (const term of terms) {
    lines.push([csvField(term.term), csvField(term.translation), term.dnt ? 'yes' : 'no', csvField(term.note)].join(','));
  }
  return lines.map((line) => `${line}\r\n`).join('');
}
