import { useCallback, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type Ref } from 'react';
import { emptyCell } from '../../../Service/src/contract';
import { visibleLength } from '../../../Service/src/lengthCheck';
import { ApiError, type LocHubApi } from '../api/client';
import type { Cell, CellEvent, PrecheckIssue, Unit } from '../api/types';
import type { EditorBridge } from '../bridge';
import { errorText } from '../errors';
import type { GridRow } from '../grid/model';
import { parseOrigin } from '../origin';
import { formatArgs } from '../text';
import { OriginActions } from './OriginActions';

export interface CellPanelHandle {
  approve(): void;
  pickAlternative(index: number): void;
  focusEdit(): void;
  focusReject(): void;
  focusContext(): void;
}

// The draft used for the live format check below follows `value` after `delayMs` of no further change; the
// initial value is adopted immediately (no delay on first render), so the check fires right away when the card
// opens and only 300 ms after the reviewer stops typing after that — same shape as GridView's search debounce.
function useDebouncedDraft(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const CHECK_DEBOUNCE_MS = 300;

// Disabled buttons carry this exact title, and the queue's A hotkey (which bypasses the button's own disabled
// attribute — it calls the imperative handle directly) shows the same text as a notice instead of silently
// swallowing the key press.
const FIX_PROBLEMS_TITLE = 'Fix the problems above first';

// Check tiers: a 'confirm' issue is valid for Unreal but looks wrong. The buttons stay enabled as "Approve anyway" /
// "Save anyway", the A hotkey never overrides it, and the click names the codes it shows in `accept`.
const CONFIRM_LINE = 'Unreal accepts this text, but it looks wrong. Approve anyway if it is intended.';
const CHECK_WARNINGS_NOTICE = 'Check the warnings, then click Approve anyway.';

const LENGTH_COUNTER_TITLE = 'Visible characters / Length Check limit';

// One history line; an approve or edit a human confirmed despite warnings names them, e.g.
// "approved anyway (args_missing)".
function historyVerb(event: CellEvent): string {
  if (!event.accepted || event.accepted.length === 0) return event.action;
  return `${event.action === 'approve' ? 'approved' : 'saved'} anyway (${event.accepted.join(', ')})`;
}

export interface CellPanelProps {
  api: LocHubApi;
  bridge: EditorBridge;
  row: GridRow;
  culture: string;
  editorConnected: boolean;
  neighbors: readonly GridRow[];
  // Queue mode: hide the triage band so blind-audit greens look like any other item.
  blind?: boolean;
  onCell: (cell: Cell) => void;
  // A 409 stale_cell answer also carries the unit as the service currently holds it (e.g. a moved sourceRev).
  onUnit?: (unit: Unit) => void;
  handleRef?: Ref<CellPanelHandle>;
}

// Parents key this component by unit and culture, so its draft state starts fresh for every cell.
export function CellPanel({ api, bridge, row, culture, editorConnected, neighbors, blind = false, onCell, onUnit, handleRef }: CellPanelProps) {
  const { unit } = row;
  const gridCell = row.cells[culture];
  const cell = gridCell?.cell ?? emptyCell(unit.id, culture);
  const [draft, setDraft] = useState(cell.text);
  const [issues, setIssues] = useState<PrecheckIssue[]>([]);
  // The suggestion's own issues, from the retranslate response: shown next to "Suggestion:", never used to gate
  // Approve/Save edit — those are gated by `issues`, which describes the draft, not the suggestion (I-1).
  const [suggestionIssues, setSuggestionIssues] = useState<PrecheckIssue[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [rejectNote, setRejectNote] = useState('');
  const [retranslateNote, setRetranslateNote] = useState('');
  const [asRule, setAsRule] = useState(false);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<CellEvent[]>([]);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const rejectRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLInputElement>(null);
  const route = bridge.route(editorConnected);
  const origin = parseOrigin(unit.origin);
  const args = formatArgs(unit.source);
  // Length Check counter: the draft's visible characters against the limit GET /api/cells sent for this string (null or
  // absent: no limit, no counter), counted exactly like the service's too_long check.
  const lengthLimit = gridCell?.lengthLimit ?? null;
  const draftLength = visibleLength(draft);

  const loadHistory = useCallback(() => {
    api.history(culture, unit.id).then(setHistory, (e: unknown) => setError(errorText(e)));
  }, [api, culture, unit.id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Live format check: mirrors the server's own precheck (Service/src/cells.ts checkCell/checkTranslation) so
  // the reviewer sees why a draft would be refused before they click. Fires once when the card opens and again
  // after CHECK_DEBOUNCE_MS of no further typing (useDebouncedDraft). A failed check (network/500) must not
  // block the buttons or show an error banner — the server still has the final word on approve/edit; only a
  // *later* successful check may overwrite what is shown, so a stale response chasing an older draft can never
  // win the race (checkSeqRef bumps on every request actually sent, and a response is applied only if it is
  // still the latest one sent when it resolves).
  const debouncedDraft = useDebouncedDraft(draft, CHECK_DEBOUNCE_MS);
  const checkSeqRef = useRef(0);
  // Bumped to force a fresh live check of the *current* draft even when debouncedDraft itself did not change
  // (retranslate() below does this): a retranslate's suggestion never gates the draft, and the draft's own
  // issues must come from an actual check of the draft, not from whatever this effect last happened to store.
  const [recheckSeq, setRecheckSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    const seq = ++checkSeqRef.current;
    api.check(culture, unit.id, debouncedDraft).then(
      (result) => {
        if (alive && checkSeqRef.current === seq) setIssues(result.issues);
      },
      () => {
        // Ignored: leave `issues` (and the buttons it gates) exactly as they were.
      },
    );
    return () => {
      alive = false;
    };
  }, [api, culture, unit.id, debouncedDraft, recheckSeq]);

  // The service re-checks a needs_fix cell like any other (cells.ts approveCell), so the issues alone decide.
  const hasHardIssue = issues.some((issue) => issue.severity === 'hard');
  const confirmIssues = hasHardIssue ? [] : issues.filter((issue) => issue.severity === 'confirm');
  const listedIssues = hasHardIssue ? issues : issues.filter((issue) => issue.severity !== 'confirm');
  const accept = [...new Set(confirmIssues.map((issue) => issue.code))];
  const needsConfirm = accept.length > 0;
  const approveDisabled = hasHardIssue;
  const saveDisabled = draft === cell.text || hasHardIssue;

  // Does not touch `issues`: the draft's text is not changing here, so its last known (or in-flight) live-check
  // result is still the right thing to gate on — clearing it to [] would make a hard-issue draft look clean
  // for as long as no re-check happens to fire (I-1).
  const clearMessages = () => {
    setError('');
    setNotice('');
  };

  // Resolves true when the action succeeded, so callers can keep the user's input after a failure.
  const run = async (action: () => Promise<{ cell: Cell }>, done: string): Promise<boolean> => {
    clearMessages();
    try {
      const { cell: next } = await action();
      onCell(next);
      setDraft(next.text);
      setNotice(done);
      loadHistory();
      return true;
    } catch (e) {
      // The reviewer's view was stale (source or translation moved since this card loaded); show the
      // service's message and refresh the card with the current cell/unit instead of the queue advancing.
      if (e instanceof ApiError && e.body.error === 'stale_cell') {
        if (e.body.cell) {
          onCell(e.body.cell);
          setDraft(e.body.cell.text);
        }
        if (e.body.unit) onUnit?.(e.body.unit);
        setError(errorText(e));
        return false;
      }
      if (e instanceof ApiError && e.body.issues) setIssues(e.body.issues);
      setError(errorText(e));
      return false;
    }
  };

  const expected = { revision: cell.revision, sourceRev: unit.sourceRev };
  const save = () => run(() => api.edit(culture, unit.id, draft, expected, accept), 'Saved.');
  // Accepting a changed draft is a human edit; accepting the text as shown is an approval.
  const approve = () => (draft !== cell.text ? save() : run(() => api.approve(culture, unit.id, expected, accept), 'Approved.'));

  const reject = (event: FormEvent) => {
    event.preventDefault();
    void run(() => api.reject(culture, unit.id, rejectNote, expected), 'Rejected: the string goes back to translation.').then((ok) => {
      if (ok) setRejectNote('');
    });
  };

  const retranslate = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    try {
      const result = await api.retranslate(culture, unit.id, retranslateNote, asRule);
      onCell(result.cell);
      // The new suggestion's issues describe the suggestion, not the unchanged draft (I-1): keep them separate
      // and force a fresh check of the draft instead of trusting whatever `issues` held before this call.
      setSuggestionIssues(result.issues);
      setRecheckSeq((n) => n + 1);
      setNotice(asRule ? 'New suggestion below; the note was added to the style guide.' : 'New suggestion below.');
      loadHistory();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    clearMessages();
    try {
      await api.askContext(culture, unit.id, question);
      setQuestion('');
      setNotice('Question sent to the Inbox.');
    } catch (e) {
      setError(errorText(e));
    }
  };

  const applyLive = async () => {
    clearMessages();
    try {
      const applied = await bridge.applyLive(culture, [{ namespace: unit.namespace, key: unit.key, source: unit.source, translation: draft }], editorConnected);
      if (applied) setNotice(`Applied live in the editor (${culture} preview).`);
      else setError('The editor did not apply the text.');
    } catch (e) {
      setError(errorText(e));
    }
  };

  useImperativeHandle(handleRef, () => ({
    // The queue's A hotkey calls this directly, bypassing the Approve button's own `disabled` attribute — so
    // the key press must not be silently ignored while blocked, it must surface the same message a click would.
    approve: () => {
      if (approveDisabled) {
        setNotice(FIX_PROBLEMS_TITLE);
        return;
      }
      if (needsConfirm) {
        setNotice(CHECK_WARNINGS_NOTICE);
        return;
      }
      void approve();
    },
    pickAlternative: (index: number) => {
      const alternative = cell.alts[index];
      if (alternative !== undefined) setDraft(alternative);
    },
    focusEdit: () => editRef.current?.focus(),
    focusReject: () => rejectRef.current?.focus(),
    focusContext: () => contextRef.current?.focus(),
  }));

  return (
    <article className="cell-panel" aria-label={`${unit.namespace} ${unit.key}`}>
      <header className="cell-head">
        <code>{unit.namespace || '(no namespace)'}</code> / <code>{unit.key}</code>
        {!blind && cell.band && <span className={`chip band-${cell.band}`}>{cell.band}</span>}
        <span className="chip">{cell.status}</span>
        {gridCell?.outdated && <span className="chip outdated">outdated</span>}
      </header>

      <section>
        <h3>Source</h3>
        <p className="source-text">{unit.source}</p>
        {gridCell?.outdated && cell.basedOnSource && <p className="muted">Translated from: {cell.basedOnSource}</p>}
      </section>

      <section>
        <h3>Translation ({culture})</h3>
        <textarea ref={editRef} aria-label="Translation" rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
        {lengthLimit !== null && (
          <p className={draftLength > lengthLimit ? 'length-counter over' : 'length-counter'} title={LENGTH_COUNTER_TITLE}>
            {`${draftLength}/${lengthLimit}`}
          </p>
        )}
        {listedIssues.length > 0 && (
          <ul className="issues">
            {listedIssues.map((issue, index) => (
              // A soft issue (e.g. a Warning-level too_long, or "Translation is identical to the source") is a
              // hint that blocks nothing; only a hard issue is the blocking-error red the list defaults to (M-2).
              <li key={index} className={issue.severity === 'soft' ? 'soft' : undefined}>
                {issue.message}
              </li>
            ))}
          </ul>
        )}
        {needsConfirm && (
          <div className="confirm-issues">
            <p>{CONFIRM_LINE}</p>
            <ul className="issues confirm">
              {confirmIssues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="actions">
          <button type="button" onClick={() => void approve()} disabled={approveDisabled} title={approveDisabled ? FIX_PROBLEMS_TITLE : undefined}>
            {needsConfirm ? 'Approve anyway' : 'Approve (A)'}
          </button>
          <button type="button" onClick={() => void save()} disabled={saveDisabled} title={hasHardIssue ? FIX_PROBLEMS_TITLE : undefined}>
            {needsConfirm ? 'Save anyway' : 'Save edit'}
          </button>
          <button
            type="button"
            onClick={() => void applyLive()}
            disabled={route === 'none' || draft.length === 0}
            title={route === 'none' ? 'The editor is not connected' : 'Show this text in the editor without a Pull'}
          >
            Apply live
          </button>
        </div>
        {cell.suggestion && (
          <div className="suggestion">
            <p>
              Suggestion: {cell.suggestion}{' '}
              <button type="button" onClick={() => setDraft(cell.suggestion)}>
                Use suggestion
              </button>
            </p>
            {suggestionIssues.length > 0 && (
              <ul className="issues suggestion-issues">
                {suggestionIssues.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {cell.alts.length > 0 && (
          <ol className="alts">
            {cell.alts.slice(0, 3).map((alternative, index) => (
              <li key={index}>
                <button type="button" onClick={() => setDraft(alternative)}>
                  Use {index + 1}
                </button>{' '}
                {alternative}
              </li>
            ))}
          </ol>
        )}
      </section>

      {cell.judgeIssues.length > 0 && (
        <section>
          <h3>Judge</h3>
          <ul className="judge">
            {cell.judgeIssues.map((issue, index) => (
              <li key={index}>
                <strong>{issue.severity}</strong> {issue.category}: {issue.why}
                {issue.fix && <> (fix: {issue.fix})</>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {cell.question && (
        <section>
          <h3>Model question</h3>
          <p>{cell.question}</p>
        </section>
      )}

      <section>
        <h3>Context</h3>
        <dl className="context">
          <dt>Origin</dt>
          <dd>
            {origin.kind === 'unknown' && <span className="muted">{unit.origin || 'unknown'}</span>}
            <OriginActions unit={unit} bridge={bridge} editorConnected={editorConnected} onBeforeAction={clearMessages} onError={setError} />
          </dd>
          <dt>Dev notes</dt>
          <dd>{unit.devNotes || 'none'}</dd>
          <dt>Arguments</dt>
          <dd>{args.length > 0 ? args.map((name) => `{${name}}`).join(' ') : 'none'}</dd>
          <dt>Group</dt>
          <dd>{unit.groupKey || 'none'}</dd>
          <dt>Provenance</dt>
          <dd>{cell.provenance || 'none'}</dd>
        </dl>
        {neighbors.length > 0 && (
          <table className="neighbors">
            <caption>Other strings in this group</caption>
            <tbody>
              {neighbors.map((neighbor) => (
                <tr key={neighbor.unit.id}>
                  <td>{neighbor.unit.source}</td>
                  <td>{neighbor.cells[culture]?.cell.text ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="forms">
        <form onSubmit={reject}>
          <input ref={rejectRef} aria-label="Reject reason" placeholder="What is wrong? (R)" value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
          <button type="submit">Reject</button>
        </form>
        <form onSubmit={(e) => void retranslate(e)}>
          <input aria-label="Retranslate note" placeholder="Explain, then translate again" value={retranslateNote} onChange={(e) => setRetranslateNote(e.target.value)} />
          <label>
            <input type="checkbox" checked={asRule} onChange={(e) => setAsRule(e.target.checked)} /> as a style rule
          </label>
          <button type="submit" disabled={retranslateNote.trim().length === 0}>
            Translate again
          </button>
        </form>
        <form onSubmit={(e) => void ask(e)}>
          <input ref={contextRef} aria-label="Context question" placeholder="What context is missing? (N)" value={question} onChange={(e) => setQuestion(e.target.value)} />
          <button type="submit" disabled={question.trim().length === 0}>
            Ask for context
          </button>
        </form>
      </section>

      <section>
        <h3>History</h3>
        {history.length === 0 ? (
          <p className="muted">No changes yet.</p>
        ) : (
          <ul className="history">
            {history.map((event, index) => (
              <li key={index}>
                <time>{event.ts}</time> {event.actor} {historyVerb(event)}: {event.before || '(empty)'} to {event.after || '(empty)'}
              </li>
            ))}
          </ul>
        )}
      </section>

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
    </article>
  );
}
