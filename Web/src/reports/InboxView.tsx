import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { InboxRow, InboxStatus } from '../api/types';
import { errorText } from '../errors';

const STATUSES: InboxStatus[] = ['open', 'answered', 'applied', 'dismissed'];

// Answers are culture-independent context: the plugin writes them into DevNotes on the next Pull (plan 1, deviation 5).
// The list itself shows the questions asked for the selected culture only, like every other culture-scoped view.
export function InboxView({ api, culture }: { api: LocHubApi; culture: string }) {
  const [status, setStatus] = useState<InboxStatus>('open');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  // A status switch (or Answer/Dismiss) can fire a second load before the first settles; a late answer must
  // never overwrite what a more recent request already showed (same request-id guard as useGridData).
  const load = useCallback(() => {
    const id = ++requestRef.current;
    api.inbox({ status, culture }).then(
      (result) => {
        if (id === requestRef.current) setRows(result.rows);
      },
      (e: unknown) => {
        if (id === requestRef.current) setError(errorText(e));
      },
    );
  }, [api, status, culture]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="inbox">
      <h2>Inbox</h2>
      <div className="tabs">
        {STATUSES.map((candidate) => (
          <button key={candidate} type="button" aria-pressed={candidate === status} onClick={() => setStatus(candidate)}>
            {candidate}
          </button>
        ))}
      </div>
      {rows.length === 0 && <p className="muted">No {status} questions.</p>}
      <ul className="inbox-list">
        {rows.map(({ item, unit }) => (
          <li key={item.id}>
            <p className="question">{item.question}</p>
            <p className="muted">
              {item.askedBy} · {item.culture} · {unit ? `${unit.namespace} / ${unit.key}: ${unit.source}` : 'unit no longer exists'}
            </p>
            {unit?.devNotes && <p className="muted">Dev notes: {unit.devNotes}</p>}
            {item.status === 'open' && (
              <div className="answer">
                <textarea
                  aria-label={`Answer to ${item.id}`}
                  rows={2}
                  value={answers[item.id] ?? ''}
                  onChange={(e) => setAnswers((all) => ({ ...all, [item.id]: e.target.value }))}
                />
                <button type="button" onClick={() => void act(() => api.answer(item.id, answers[item.id] ?? ''))}>
                  Answer
                </button>
                <button type="button" onClick={() => void act(() => api.dismiss(item.id))}>
                  Dismiss
                </button>
              </div>
            )}
            {item.status === 'answered' && <p>Answer: {item.answer} (written into DevNotes on the next Pull)</p>}
            {item.status === 'applied' && <p>Answer: {item.answer}</p>}
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
