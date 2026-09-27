// CSV for the translation exchange (volunteers in Excel or Google Sheets). Pure: file picking and saving live in
// ../files.
import type { CellRow, ImportEntry } from '../api/types';
import { FORMULA_INJECTION_PREFIXES, parseCsv } from '../glossary/csv';
import { exportStatus, type ParsedImport } from './model';

export const EXCHANGE_CSV_COLUMNS = ['namespace', 'key', 'source', 'translation', 'status', 'context', 'notes', 'max_length', 'lochub_id', 'lochub_revision'] as const;

const REQUIRED_COLUMNS_MESSAGE =
  'The CSV needs a "translation" column and either "lochub_id" or both "namespace" and "key" (the header row LocHub exports).';

// The glossary's formula guard (a leading tab defuses a cell a spreadsheet would run as a formula), extended to a
// value that already starts with a tab, so the import can strip exactly one guard tab and nothing else.
const GUARDED_START: ReadonlySet<string> = new Set([...FORMULA_INJECTION_PREFIXES, '\t']);

function guard(value: string): string {
  return GUARDED_START.has(value[0] ?? '') ? `\t${value}` : value;
}

function unguard(value: string): string {
  return value[0] === '\t' && GUARDED_START.has(value[1] ?? '') ? value.slice(1) : value;
}

function field(value: string): string {
  const guarded = guard(value);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

// No BOM here: saveTextFile adds it (the editor's SaveTextFile and the browser download both write one).
export function exchangeToCsv(rows: readonly CellRow[]): string {
  const lines = [EXCHANGE_CSV_COLUMNS.join(',')];
  for (const row of rows) {
    const limit = row.lengthLimit ?? null;
    lines.push(
      [
        field(row.unit.namespace),
        field(row.unit.key),
        field(row.unit.source),
        field(row.cell.text),
        exportStatus(row),
        field(row.unit.origin),
        field(row.unit.devNotes),
        limit === null ? '' : String(limit),
        field(row.unit.id),
        // Always written, including 0 for a string that was empty at export: the import's conflict check (the
        // conflict rule) needs the revision to notice a LocHub write made after the export to a string that was
        // empty then.
        String(row.cell.revision),
      ].join(','),
    );
  }
  return lines.map((line) => `${line}\r\n`).join('');
}

// Header-driven: any column order, header names in any case; columns LocHub does not know are listed, not refused.
export function readExchangeCsv(text: string): ParsedImport {
  const rows = parseCsv(text);
  const headerRow = rows[0] ?? [];
  const header = headerRow.map((name) => name.trim().toLowerCase());
  const column = (name: string) => header.indexOf(name);
  const translation = column('translation');
  const id = column('lochub_id');
  const namespace = column('namespace');
  const key = column('key');
  if (translation < 0 || (id < 0 && (namespace < 0 || key < 0))) throw new Error(REQUIRED_COLUMNS_MESSAGE);
  const source = column('source');
  const status = column('status');
  const revision = column('lochub_revision');
  const known: ReadonlySet<string> = new Set(EXCHANGE_CSV_COLUMNS);
  const ignoredColumns = headerRow.filter((name, i) => name.trim() !== '' && !known.has(header[i]!)).map((name) => name.trim());

  const entries: ImportEntry[] = [];
  const labels: string[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.every((value) => value.trim() === '')) continue; // a blank spreadsheet row
    const value = (index: number) => (index < 0 ? undefined : unguard(cells[index] ?? ''));
    const entry: ImportEntry = { text: value(translation) ?? '', approved: (value(status) ?? '').trim().toLowerCase() === 'approved' };
    const unitId = value(id)?.trim();
    if (unitId) entry.unitId = unitId;
    if (namespace >= 0 && key >= 0) {
      entry.namespace = value(namespace) ?? '';
      entry.key = value(key) ?? '';
    }
    // Every string LocHub knows has a source text: an empty source cell is "not given", not "the source is now empty".
    const sourceText = value(source);
    if (sourceText) entry.source = sourceText;
    const exported = value(revision)?.trim() ?? '';
    if (/^\d+$/.test(exported)) entry.exportedRevision = Number(exported);
    entries.push(entry);
    // Spreadsheet row numbers: the header is row 1, and a multi-line cell is still one row.
    labels.push(entry.key !== undefined ? `Row ${r + 1}: ${entry.namespace}/${entry.key}` : `Row ${r + 1}`);
  }
  // CSV has no CAT-tool pre-fill concept: every empty row here is a genuinely blank translation.
  return { format: 'csv', entries, labels, ignoredColumns, copyOfSource: entries.map(() => false) };
}
