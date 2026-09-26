import { useEffect, useRef, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { Cell, GlossaryTerm, JobScope } from '../api/types';
import type { EditorBridge } from '../bridge';
import { errorText } from '../errors';
import { pickTextFile, saveTextFile } from '../files';
import type { GridRow } from '../grid/model';
import { decodeUtf8, glossaryToCsv, mergeGlossary, parseCsv, readGlossaryCsv, type IncomingTerm } from './csv';
import { changedTerms, glossaryUnsaved, rowsUsingTerm, termFixNote } from './glossary';

export interface GlossaryViewProps {
  api: LocHubApi;
  culture: string;
  rows: readonly GridRow[];
  onCell: (cell: Cell) => void;
  onTermFix: (scope: JobScope) => void;
  bridge: EditorBridge;
  cultures: readonly string[];
  nativeCulture: string;
}

interface ImportPreviewCulture {
  culture: string;
  added: number;
  updated: number;
}

interface ImportPreview {
  byCulture: Record<string, IncomingTerm[]>;
  perCulture: ImportPreviewCulture[];
  skipped: { line: number; reason: string }[];
  ignoredColumns: string[];
}

interface TermFix {
  term: GlossaryTerm;
  culture: string;
  unitIds: string[];
}

const EMPTY_TERM: GlossaryTerm = { term: '', translation: '', dnt: false, note: '' };

export function GlossaryView({ api, culture, rows, onCell, onTermFix, bridge, cultures, nativeCulture }: GlossaryViewProps) {
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [saved, setSaved] = useState<GlossaryTerm[]>([]);
  const [style, setStyle] = useState('');
  const [fixes, setFixes] = useState<TermFix[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [pickingImport, setPickingImport] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The culture actually selected right now, read inside an async function's continuation to tell whether the
  // user switched culture while that call was in flight: `culture` itself is a stale closure by then.
  const cultureRef = useRef(culture);
  const previewDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cultureRef.current = culture;
  }, [culture]);

  // Moves focus onto the import preview dialog as soon as it opens, so a keyboard/screen-reader user lands on
  // it instead of it silently appearing over wherever focus already was in the table.
  useEffect(() => {
    if (preview) previewDialogRef.current?.focus();
  }, [preview]);

  useEffect(() => {
    let alive = true;
    // A pending "Apply to N strings" fix names units for the culture it was computed for; the view is not
    // keyed by culture, so leaving stale fixes here would apply them under whatever culture is now selected.
    setFixes([]);
    // The import preview and the "Importing…" flag belong to whichever culture was active when the file
    // was read; switching culture must close a still-open preview rather than let a later confirm run against
    // the newly selected culture's data.
    setPreview(null);
    setImporting(false);
    Promise.all([api.glossary(culture), api.style(culture)]).then(
      ([glossary, guide]) => {
        if (!alive) return;
        setTerms(glossary);
        setSaved(glossary);
        setStyle(guide.text);
      },
      (e: unknown) => {
        if (alive) setError(errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [api, culture]);

  const update = (index: number, patch: Partial<GlossaryTerm>) => setTerms((list) => list.map((term, i) => (i === index ? { ...term, ...patch } : term)));

  const saveGlossary = async () => {
    const savingCulture = culture;
    setError('');
    setNotice('');
    // PUT /api/glossary/:culture refuses the whole list when any term is empty (400, nothing saved): drop blank rows.
    const clean = terms.filter((term) => term.term.trim().length > 0);
    try {
      await api.saveGlossary(savingCulture, clean);
      // The culture switched while this PUT was in flight: that culture's own load effect already owns
      // terms/saved/fixes now, so writing this stale result over them would show the wrong culture as saved.
      if (cultureRef.current !== savingCulture) return;
      const next = changedTerms(saved, clean)
        .map((term) => ({ term, culture: savingCulture, unitIds: rowsUsingTerm(rows, savingCulture, term).map((row) => row.unit.id) }))
        .filter((fix) => fix.unitIds.length > 0);
      setFixes(next);
      setSaved(clean);
      setTerms(clean);
      setNotice('Glossary saved.');
    } catch (e) {
      if (cultureRef.current !== savingCulture) return;
      setError(errorText(e));
    }
  };

  // Rejected drafts are picked up by the next job, which reads the updated glossary ("Apply to N strings?").
  // Always the culture the fix was computed for, never the (possibly since-switched) culture prop.
  const applyFix = async (fix: TermFix) => {
    setError('');
    try {
      for (const unitId of fix.unitIds) onCell((await api.reject(fix.culture, unitId, termFixNote(fix.term))).cell);
      setFixes((list) => list.filter((candidate) => candidate !== fix));
      onTermFix({ culture: fix.culture, unitIds: fix.unitIds });
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Import merges against whatever the service currently holds and then overwrites terms/saved with the
  // result, so an unsaved on-screen edit would otherwise be silently discarded.
  const startImport = async () => {
    if (pickingImport) return; // ignore a second click while the file picker is already in flight
    setPickingImport(true);
    setError('');
    setNotice('');
    try {
      if (glossaryUnsaved(terms, saved)) {
        setError('Save your glossary changes before importing.');
        return;
      }
      const picked = await pickTextFile(bridge, 'Import glossary CSV', '.csv,text/csv');
      if (!picked) return; // cancelled
      const text = decodeUtf8(picked.bytes);
      const csvRows = parseCsv(text);
      const { byCulture, skipped, ignoredColumns } = readGlossaryCsv(csvRows, { cultures, nativeCulture, activeCulture: culture });
      const perCulture: ImportPreviewCulture[] = [];
      for (const [cultureCode, incoming] of Object.entries(byCulture)) {
        const existing = cultureCode === culture ? saved : await api.glossary(cultureCode);
        const merged = mergeGlossary(existing, incoming);
        perCulture.push({ culture: cultureCode, added: merged.added, updated: merged.updated });
      }
      setPreview({ byCulture, perCulture, skipped, ignoredColumns });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPickingImport(false);
    }
  };

  const cancelImport = () => setPreview(null);

  const confirmImport = async () => {
    if (!preview) return;
    // The table (Add/Remove, every field) stays live and editable here on purpose: re-checked at the moment of
    // confirming, not only when the preview was opened, since an edit made while the preview sat open would
    // otherwise be silently overwritten by the imported terms below.
    if (glossaryUnsaved(terms, saved)) {
      setError('Save your glossary changes before importing.');
      return;
    }
    const importingCulture = culture;
    setImporting(true);
    setError('');
    const savedCultures: string[] = [];
    let loopError: unknown;
    try {
      for (const [cultureCode, incoming] of Object.entries(preview.byCulture)) {
        try {
          // Re-GET and re-merge right before this culture's PUT: the server may have changed since the preview.
          const existing = await api.glossary(cultureCode);
          const merged = mergeGlossary(existing, incoming);
          await api.saveGlossary(cultureCode, merged.terms);
          savedCultures.push(cultureCode);
        } catch (e) {
          loopError = e;
          break; // stop on the first failure; savedCultures already lists which PUTs went through
        }
      }

      // The culture switched while these PUTs were running: that culture's own load effect already owns the
      // view now, so none of terms/saved/fixes/notice/error below may write over it — except when the newly
      // active culture is itself one this import just saved. That load effect may have read the glossary before
      // this import's own PUT for it landed, leaving a stale (pre-import) view that a later Save would overwrite
      // the import with; refresh just that one culture's terms to replace whatever it loaded.
      if (cultureRef.current !== importingCulture) {
        const switchedTo = cultureRef.current;
        if (savedCultures.includes(switchedTo)) {
          try {
            const refreshed = await api.glossary(switchedTo);
            if (cultureRef.current === switchedTo) {
              setSaved(refreshed);
              setTerms(refreshed);
            }
          } catch {
            // Best-effort: that culture's own load effect (or switching back to it later) will retry.
          }
        }
        return;
      }

      // Reload the active culture whenever its own PUT saved, even after a later culture's PUT failed: a
      // partial failure must not hide the terms that did make it to the server.
      if (savedCultures.includes(importingCulture)) {
        const before = saved;
        const refreshed = await api.glossary(importingCulture);
        if (cultureRef.current !== importingCulture) return;
        const nextFixes = changedTerms(before, refreshed)
          .map((term) => ({ term, culture: importingCulture, unitIds: rowsUsingTerm(rows, importingCulture, term).map((row) => row.unit.id) }))
          .filter((fix) => fix.unitIds.length > 0);
        setFixes(nextFixes);
        setSaved(refreshed);
        setTerms(refreshed);
      }

      if (loopError) {
        setError(`Import stopped: ${errorText(loopError)}. Saved: ${savedCultures.length > 0 ? savedCultures.join(', ') : 'no cultures'}.`);
      } else {
        const summary = preview.perCulture.map((p) => `${p.culture} ${p.added} new${p.updated > 0 ? `, ${p.updated} updated` : ''}`).join('; ');
        setNotice(`Imported: ${summary}.`);
      }
    } catch (e) {
      if (cultureRef.current === importingCulture) setError(errorText(e));
    } finally {
      setPreview(null);
      setImporting(false);
    }
  };

  const exportGlossary = async () => {
    if (exporting) return; // ignore a second click while the save dialog is already in flight
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const clean = terms.filter((term) => term.term.trim().length > 0);
      const csv = glossaryToCsv(clean);
      const name = `glossary-${culture}.csv`;
      const result = await saveTextFile(bridge, name, csv);
      if (!result) return; // cancelled
      setNotice(result.path ? `Saved to ${result.path}` : `Downloaded ${name}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };

  const saveStyle = async () => {
    setError('');
    setNotice('');
    try {
      await api.saveStyle(culture, style);
      setNotice('Style guide saved.');
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="glossary">
      <h2>Glossary ({culture})</h2>
      <table className="terms">
        <thead>
          <tr>
            <th>Term</th>
            <th>Translation</th>
            <th>Do not translate</th>
            <th>Note</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {terms.map((term, index) => (
            <tr key={index}>
              <td>
                <input aria-label={`Term ${index + 1}`} value={term.term} onChange={(e) => update(index, { term: e.target.value })} />
              </td>
              <td>
                <input aria-label={`Translation ${index + 1}`} value={term.translation} disabled={term.dnt} onChange={(e) => update(index, { translation: e.target.value })} />
              </td>
              <td>
                <input type="checkbox" aria-label={`Do not translate ${index + 1}`} checked={term.dnt} onChange={(e) => update(index, { dnt: e.target.checked })} />
              </td>
              <td>
                <input aria-label={`Note ${index + 1}`} value={term.note} onChange={(e) => update(index, { note: e.target.value })} />
              </td>
              <td>
                <button type="button" onClick={() => setTerms((list) => list.filter((_, i) => i !== index))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button type="button" onClick={() => setTerms((list) => [...list, { ...EMPTY_TERM }])}>
          Add term
        </button>
        <button type="button" onClick={() => void saveGlossary()}>
          Save glossary
        </button>
        <button type="button" onClick={() => void startImport()} disabled={pickingImport}>
          Import CSV…
        </button>
        <button type="button" onClick={() => void exportGlossary()} disabled={exporting}>
          Export CSV
        </button>
      </div>
      {preview && (
        <div className="import-preview" role="dialog" aria-label="Import glossary" ref={previewDialogRef} tabIndex={-1}>
          <h3>Import preview</h3>
          {preview.perCulture.length === 0 ? (
            <p>No terms to import.</p>
          ) : (
            <ul>
              {preview.perCulture.map((p) => (
                <li key={p.culture}>
                  {p.culture}: {p.added} new, {p.updated} updated
                </li>
              ))}
            </ul>
          )}
          {preview.skipped.length > 0 && (
            <div className="skipped">
              <h4>Skipped rows</h4>
              <ul>
                {preview.skipped.slice(0, 20).map((s) => (
                  <li key={s.line}>
                    Line {s.line}: {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.ignoredColumns.length > 0 && <p className="muted">Ignored columns: {preview.ignoredColumns.join(', ')}</p>}
          <div className="actions">
            <button type="button" onClick={() => void confirmImport()} disabled={importing || preview.perCulture.length === 0}>
              {importing ? 'Importing…' : 'Import'}
            </button>
            <button type="button" onClick={cancelImport} disabled={importing}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {fixes.map((fix) => (
        <p key={fix.term.term} className="term-fix">
          &quot;{fix.term.term}&quot; appears in {fix.unitIds.length} {fix.culture} AI {fix.unitIds.length === 1 ? 'draft' : 'drafts'} that do not follow it.{' '}
          <button type="button" onClick={() => void applyFix(fix)}>
            Apply to {fix.unitIds.length} {fix.unitIds.length === 1 ? 'string' : 'strings'}
          </button>
        </p>
      ))}
      <h2>Style guide ({culture})</h2>
      <textarea aria-label="Style guide" rows={10} value={style} onChange={(e) => setStyle(e.target.value)} />
      <div className="actions">
        <button type="button" onClick={() => void saveStyle()}>
          Save style guide
        </button>
      </div>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
