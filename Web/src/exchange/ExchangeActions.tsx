// Grid toolbar: Export… writes a culture as CSV (spreadsheets) or XLIFF 1.2 (CAT tools) for human translators;
// Import… reads their file back, previews it with a dry run of POST /api/import, and applies the very same request
// once a reviewer name is entered. See Docs/07_Grid_and_Review.md, "Export and import (CSV, XLIFF)".
import { useState } from 'react';
import { ApiError, type LocHubApi } from '../api/client';
import type { ImportOutcome, ImportRequest, ImportResult, ImportRow } from '../api/types';
import type { EditorBridge } from '../bridge';
import { errorText } from '../errors';
import { pickTextFile, saveTextFile } from '../files';
import { compareText, type GridRow } from '../grid/model';
import { exchangeToCsv } from './csv';
import type { ExchangeFormat, ParsedImport } from './model';
import { parseTranslationFile, TRANSLATION_FILE_ACCEPT } from './read';
import { exchangeToXliff } from './xliff';

const REVIEWER_KEY = 'lochub.reviewerName';
// Longer groups are cut here in the preview; the counts stay exact.
const LIST_LIMIT = 200;

// Windows common-dialog filter syntax (ULocHubBrowserBridge::PickTextFile/SaveTextFile).
const TRANSLATION_FILE_TYPES = 'Translation files (*.csv;*.xlf;*.xliff;*.xml)|*.csv;*.xlf;*.xliff;*.xml|All files (*.*)|*.*';
const SAVE_AS: Record<ExchangeFormat, { extension: string; fileTypes: string; mime: string }> = {
  csv: { extension: 'csv', fileTypes: 'CSV files (*.csv)|*.csv|All files (*.*)|*.*', mime: 'text/csv;charset=utf-8' },
  xliff: { extension: 'xlf', fileTypes: 'XLIFF files (*.xlf)|*.xlf|All files (*.*)|*.*', mime: 'application/xliff+xml;charset=utf-8' },
};

const SKIPPED: ReadonlySet<ImportOutcome> = new Set<ImportOutcome>(['stale', 'unknown', 'empty', 'hard']);
const SKIP_REASON: Partial<Record<ImportOutcome, string>> = {
  stale: 'the source text changed since the export',
  unknown: 'no such string in this project',
};
// A blank translation cell, plain and simple: an import never clears a translation.
const EMPTY_REASON = 'no translation in the file (an import never clears one)';
// A CAT tool's "copy source to target" pre-fill (readXliff resolves it to an empty entry.text before this ever
// reaches the service): a different message from a genuinely blank cell, since it is not the translator saying
// "nothing yet" — the tool said it for them.
const COPY_OF_SOURCE_REASON = 'copy of the source (not translated)';

function messages(row: ImportRow, severities: readonly string[]): string {
  return (row.issues ?? [])
    .filter((issue) => severities.includes(issue.severity))
    .map((issue) => issue.message)
    .join('; ');
}

// A row the "Import anyway" checkbox decides: it has warnings, no problem Unreal would reject, and is not held back
// for another reason (skipped, or a conflict not overwritten).
function isWarningRow(row: ImportRow): boolean {
  return messages(row, ['confirm']) !== '' && messages(row, ['hard']) === '' && !['unknown', 'stale', 'empty', 'conflict'].includes(row.outcome);
}

function describeRow(row: ImportRow, label: string, copyOfSource: boolean): string {
  if (row.outcome === 'hard') return `${label}: format problem: ${messages(row, ['hard'])}`;
  if (row.outcome === 'empty') return `${label}: ${copyOfSource ? COPY_OF_SOURCE_REASON : EMPTY_REASON}`;
  const reason = SKIP_REASON[row.outcome];
  if (reason) return `${label}: ${reason}`;
  if (row.outcome === 'unchanged') return label;
  if (row.outcome === 'confirm') return `${label}: ${messages(row, ['confirm'])}`;
  const change = row.outcome === 'approved' ? `approve "${row.after ?? ''}"` : `"${row.before || '(empty)'}" → "${row.after ?? ''}"`;
  const approvedToo = row.outcome === 'changed_approved' ? ' (approved)' : '';
  const notes = messages(row, ['confirm', 'soft']);
  return `${label}: ${change}${approvedToo}${notes ? ` — ${notes}` : ''}`;
}

function groupsOf(result: ImportResult): { title: string; rows: ImportRow[] }[] {
  const pick = (test: (row: ImportRow) => boolean) => result.rows.filter(test);
  return [
    { title: 'Changed', rows: pick((row) => row.outcome === 'changed' || row.outcome === 'changed_approved') },
    { title: 'Approved', rows: pick((row) => row.outcome === 'approved') },
    { title: 'Unchanged', rows: pick((row) => row.outcome === 'unchanged') },
    { title: 'Skipped', rows: pick((row) => SKIPPED.has(row.outcome)) },
    { title: 'Conflicts', rows: pick((row) => row.outcome === 'conflict') },
    { title: 'Needs confirmation', rows: pick((row) => row.outcome === 'confirm') },
  ];
}

interface Preview {
  fileName: string;
  parsed: ParsedImport;
  result: ImportResult;
  overwriteConflicts: boolean;
  acceptConfirm: boolean;
}

export interface ExchangeActionsProps {
  api: LocHubApi;
  bridge: EditorBridge;
  // The Grid's active culture: the culture an import writes into, and the export's default.
  culture: string;
  cultures: readonly string[];
  // XLIFF source-language; 'en' when the service does not know it yet (no Push since it started).
  nativeCulture: string;
  // The rows the Grid shows right now: "Strings matching the current filters".
  filtered: readonly GridRow[];
  // Every string in the Grid: "All strings".
  totalCount: number;
  // Called once an import applied, so the Grid reloads.
  onImported: () => void;
  // The XLIFF export date; injectable for tests.
  now?: () => Date;
}

export function ExchangeActions({ api, bridge, culture, cultures, nativeCulture, filtered, totalCount, onImported, now = () => new Date() }: ExchangeActionsProps) {
  const [panel, setPanel] = useState<'none' | 'export' | 'import'>('none');
  const [exportCulture, setExportCulture] = useState(culture);
  const [format, setFormat] = useState<ExchangeFormat>('csv');
  const [scope, setScope] = useState<'filtered' | 'all'>('filtered');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewer, setReviewer] = useState(loadReviewer);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const request = (target: Pick<Preview, 'parsed' | 'overwriteConflicts' | 'acceptConfirm'>, dryRun: boolean): ImportRequest => ({
    culture,
    actor: reviewer.trim(),
    dryRun,
    overwriteConflicts: target.overwriteConflicts,
    acceptConfirm: target.acceptConfirm,
    entries: target.parsed.entries,
  });

  const close = () => {
    setPanel('none');
    setPreview(null);
    setError('');
  };

  const openExport = () => {
    setPanel('export');
    setPreview(null);
    setExportCulture(culture);
    setError('');
    setNotice('');
  };

  const runExport = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Captured before the (possibly multi-page) fetch below, so the date rule sees any edit that lands while the
      // export is in flight: ts < exportedAt would otherwise fail to hold for such an edit.
      const exportedAt = now().toISOString();
      const ids = new Set(filtered.map((row) => row.unit.id));
      const all = await api.allCells(exportCulture);
      const rows = (scope === 'all' ? all : all.filter((row) => ids.has(row.unit.id)))
        .slice()
        .sort((a, b) => compareText(a.unit.namespace, b.unit.namespace) || compareText(a.unit.key, b.unit.key));
      if (rows.length === 0) {
        setError('Nothing to export: no strings match.');
        return;
      }
      const text = format === 'csv' ? exchangeToCsv(rows) : exchangeToXliff(rows, { culture: exportCulture, sourceCulture: nativeCulture || 'en', date: exportedAt });
      const target = SAVE_AS[format];
      const name = `lochub-${exportCulture}.${target.extension}`;
      const saved = await saveTextFile(bridge, name, text, target.fileTypes, 'Export translations', target.mime);
      if (!saved) return; // cancelled: the panel stays open
      setNotice(saved.path ? `Saved to ${saved.path}` : `Downloaded ${name}`);
      setPanel('none');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setPanel('none');
    setPreview(null);
    try {
      const picked = await pickTextFile(bridge, 'Import translations', TRANSLATION_FILE_ACCEPT, TRANSLATION_FILE_TYPES);
      if (!picked) return; // cancelled
      const parsed = parseTranslationFile(picked.name, picked.bytes, culture);
      if (parsed.entries.length === 0) {
        setError(`${picked.name} has no strings to import.`);
        return;
      }
      const draft = { parsed, overwriteConflicts: false, acceptConfirm: false };
      const result = await api.importTranslations(request(draft, true));
      setPreview({ fileName: picked.name, result, ...draft });
      setPanel('import');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // A checkbox changes the request, so the preview is run again: it always shows what Import will do.
  const rerun = async (patch: Partial<Pick<Preview, 'overwriteConflicts' | 'acceptConfirm'>>) => {
    if (!preview || busy) return;
    const next = { ...preview, ...patch };
    setBusy(true);
    setError('');
    try {
      const result = await api.importTranslations(request(next, true));
      setPreview({ ...next, result });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const applyImport = async () => {
    if (!preview || busy || reviewer.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      const result = await api.importTranslations({ ...request(preview, false), previewDigest: preview.result.digest });
      saveReviewer(reviewer.trim());
      const applied = result.counts.changed + result.counts.changed_approved + result.counts.approved;
      setNotice(`Imported ${applied} ${applied === 1 ? 'string' : 'strings'} into ${culture}.`);
      setPreview(null);
      setPanel('none');
      onImported();
    } catch (e) {
      // The store changed since the preview (a job, another tab, a Push, a glossary edit, or a retry after
      // files_changed_on_disk): the service refused to write anything and sent the fresh preview back instead.
      // Show it in place of the stale one and ask the reviewer to check it, rather than retrying blind.
      const staleResult = e instanceof ApiError && e.body.error === 'preview_stale' ? e.body.result : undefined;
      if (staleResult) {
        setPreview({ ...preview, result: staleResult });
        setError('Strings changed in LocHub since this preview. Check it again, then Import.');
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (row: ImportRow) => preview?.parsed.labels[row.index] ?? `String ${row.index + 1}`;
  const conflictCount = preview ? preview.result.rows.filter((row) => row.conflict).length : 0;
  const warningCount = preview ? preview.result.rows.filter(isWarningRow).length : 0;
  const applicable = preview ? preview.result.counts.changed + preview.result.counts.changed_approved + preview.result.counts.approved : 0;

  return (
    <>
      <button type="button" onClick={openExport} disabled={busy}>
        Export…
      </button>
      <button type="button" onClick={() => void startImport()} disabled={busy}>
        Import…
      </button>
      {notice && (
        <span className="notice" role="status">
          {notice}
        </span>
      )}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      {panel === 'export' && (
        <div className="import-preview exchange-panel" role="dialog" aria-label="Export translations">
          <h3>Export translations</h3>
          <label>
            Culture{' '}
            <select aria-label="Export culture" value={exportCulture} onChange={(e) => setExportCulture(e.target.value)}>
              {cultures.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
          <label>
            Format{' '}
            <select aria-label="Export format" value={format} onChange={(e) => setFormat(e.target.value as ExchangeFormat)}>
              <option value="csv">CSV (spreadsheets)</option>
              <option value="xliff">XLIFF 1.2 (CAT tools)</option>
            </select>
          </label>
          <label>
            Strings{' '}
            <select aria-label="Export scope" value={scope} onChange={(e) => setScope(e.target.value as 'filtered' | 'all')}>
              <option value="filtered">{`Strings matching the current filters (${filtered.length})`}</option>
              <option value="all">{`All strings (${totalCount})`}</option>
            </select>
          </label>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void runExport()} disabled={busy}>
              Export
            </button>
            <button type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {panel === 'import' && preview && (
        <div className="import-preview exchange-panel" role="dialog" aria-label="Import translations">
          <h3>{`Import into ${culture}`}</h3>
          <p className="muted">
            {`${preview.fileName}: ${preview.parsed.entries.length} ${preview.parsed.entries.length === 1 ? 'string' : 'strings'} (${preview.parsed.format === 'csv' ? 'CSV' : 'XLIFF'})`}
          </p>
          {groupsOf(preview.result).map((group) => (
            <details key={group.title}>
              <summary>{`${group.title} (${group.rows.length})`}</summary>
              <ul>
                {group.rows.slice(0, LIST_LIMIT).map((row) => (
                  <li key={row.index}>{describeRow(row, labelOf(row), preview.parsed.copyOfSource[row.index] ?? false)}</li>
                ))}
                {group.rows.length > LIST_LIMIT && <li className="muted">{`…and ${group.rows.length - LIST_LIMIT} more`}</li>}
              </ul>
            </details>
          ))}
          {preview.parsed.ignoredColumns.length > 0 && <p className="muted">{`Ignored columns: ${preview.parsed.ignoredColumns.join(', ')}`}</p>}
          <label>
            Reviewer name{' '}
            <input aria-label="Reviewer name" value={reviewer} maxLength={64} onChange={(e) => setReviewer(e.target.value)} />
          </label>
          {conflictCount > 0 && (
            <label>
              <input type="checkbox" checked={preview.overwriteConflicts} disabled={busy} onChange={(e) => void rerun({ overwriteConflicts: e.target.checked })} />
              {` Overwrite conflicts (${conflictCount})`}
            </label>
          )}
          {warningCount > 0 && (
            <label>
              <input type="checkbox" checked={preview.acceptConfirm} disabled={busy} onChange={(e) => void rerun({ acceptConfirm: e.target.checked })} />
              {` Import anyway: ${warningCount} ${warningCount === 1 ? 'string' : 'strings'} with warnings`}
            </label>
          )}
          {reviewer.trim() === '' && <p className="muted">Enter your name: it is recorded as the reviewer of every imported string.</p>}
          <div className="actions">
            <button type="button" className="primary" onClick={() => void applyImport()} disabled={busy || reviewer.trim() === '' || applicable === 0}>
              Import
            </button>
            <button type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// The editor's embedded browser profile (or a private window) can refuse localStorage: the name is then asked for on
// every import instead of remembered.
function loadReviewer(): string {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveReviewer(name: string): void {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Not remembered; see loadReviewer.
  }
}
