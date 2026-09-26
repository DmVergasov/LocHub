import { useEffect, useRef, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { CultureSummary } from '../api/types';
import { errorText } from '../errors';
import { missRate, percent } from './summary';

export function SummaryView({ api, culture }: { api: LocHubApi; culture: string }) {
  const [summary, setSummary] = useState<CultureSummary>();
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  // Ignore a summary that resolves after a later culture switch already requested a different one.
  useEffect(() => {
    const id = ++requestRef.current;
    api.summary(culture).then(
      (result) => {
        if (id === requestRef.current) setSummary(result);
      },
      (e: unknown) => {
        if (id === requestRef.current) setError(errorText(e));
      },
    );
  }, [api, culture]);

  if (!summary) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading…</p>;
  const triaged = summary.byBand.R + summary.byBand.Y + summary.byBand.G;
  const miss = missRate(summary);
  return (
    <div className="summary">
      <h2>Summary ({culture})</h2>
      <p>
        {summary.total} strings · {summary.outdated} outdated · {summary.openQuestions} open questions
      </p>
      <div className="bands">
        {(['R', 'Y', 'G'] as const).map((band) => (
          <div key={band} className={`band-bar band-${band}`} style={{ flexGrow: Math.max(summary.byBand[band], 0.001) }}>
            {band} {summary.byBand[band]} ({percent(summary.byBand[band], triaged)})
          </div>
        ))}
      </div>
      <table>
        <tbody>
          {Object.entries(summary.byStatus).map(([status, count]) => (
            <tr key={status}>
              <td>{status}</td>
              <td>{count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        {miss === undefined
          ? 'Blind audit: no sampled green strings reviewed yet.'
          : `Blind audit: ${summary.audit.corrected} of ${summary.audit.sampled} sampled green strings were corrected, triage miss rate ${percent(summary.audit.corrected, summary.audit.sampled)}.`}
      </p>
    </div>
  );
}
