import { useEffect, useState } from 'react';
import type { LocHubApi } from '../api/client';
import type { CoverageReport } from '../api/types';
import { errorText } from '../errors';

export function CoverageView({ api }: { api: LocHubApi }) {
  const [report, setReport] = useState<CoverageReport>();
  const [error, setError] = useState('');

  useEffect(() => {
    api.coverage().then(setReport, (e: unknown) => setError(errorText(e)));
  }, [api]);

  return (
    <div className="coverage">
      <h2>Coverage</h2>
      <p className="muted">
        Player-visible strings that bypass localization, as reported by the last Push
        {report?.pushedAt ? ` (${report.pushedAt})` : ''}.
      </p>
      {report && report.findings.length === 0 && <p>No findings.</p>}
      {report && report.findings.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Location</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {report.findings.map((finding, index) => (
              <tr key={index}>
                <td>{finding.kind}</td>
                <td>
                  <code>
                    {finding.file}:{finding.line}
                  </code>
                </td>
                <td>{finding.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Visual pass</h3>
      <p>
        Run the game with <code>-LEETIFYUnlocalized</code>: every text without a translation is drawn in leetspeak, so hard-coded strings stand out on
        screen.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
