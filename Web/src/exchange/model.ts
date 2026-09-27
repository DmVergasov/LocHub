// Pieces the translation exchange formats share (CSV and XLIFF 1.2): the status an exported row reads as, and what a
// parsed file hands the import preview.
import type { CellRow, ImportEntry } from '../api/types';

export type ExchangeFormat = 'csv' | 'xliff';

export interface ParsedImport {
  format: ExchangeFormat;
  entries: ImportEntry[];
  // One per entry, same order, for the preview: "Row 5: UI/MainMenu.NewGame" (CSV) or the XLIFF resname.
  labels: string[];
  // CSV header names LocHub does not read, listed in the preview; always empty for XLIFF.
  ignoredColumns: string[];
  // One per entry, same order: true when readXliff emptied a CAT tool's "copy source to target" pre-fill (an XLIFF
  // target left in state new/needs-translation with the source's own text) rather than a genuinely blank
  // translation. The preview needs this to give the two cases different reasons; always false for CSV.
  copyOfSource: boolean[];
}

// "outdated" wins over the cell's own status; a string with no translation yet reads "empty".
export function exportStatus(row: CellRow): string {
  return row.outdated ? 'outdated' : row.cell.status;
}

// Culture codes as CAT tools write them: case and "_" versus "-" do not matter ("de_DE" is "de-de").
export function sameCulture(a: string, b: string): boolean {
  const normalize = (code: string) => code.trim().toLowerCase().replace(/_/g, '-');
  return normalize(a) === normalize(b);
}
