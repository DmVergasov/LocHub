import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type LocHubApi } from '../api/client';
import type { JobEstimate, JobProgress, JobRecord, JobReport, JobScope } from '../api/types';
import { PathFilter } from '../common/PathFilter';
import { errorText } from '../errors';
import type { GridRow } from '../grid/model';
import { canRun, formatUsd, groupPathEntries, suggestMaxUsd } from './jobs';

const PHASE_LABELS: Record<JobProgress['phase'], string> = {
  translate: 'Translating',
  repair: 'Fixing',
  judge: 'Checking',
  write: 'Writing',
};

// Why an estimate without a dollar amount has none: the subscription bills nothing per token, a Custom endpoint's
// prices are 0 in Project Settings, or the model has no entry in the service's price table.
function noDollarsNote(billing: 'api' | 'subscription', estimate: JobEstimate): string {
  if (billing === 'subscription') return 'uses your Claude subscription limits';
  return estimate.pricesUnset ? 'no price set' : 'price unknown for this model';
}

function JobProgressBar({ progress: { phase, done, total } }: { progress: JobProgress }) {
  const label = total === 0 ? `${PHASE_LABELS[phase]}…` : `${PHASE_LABELS[phase]} · ${done} / ${total} strings`;
  return (
    <div className="job-progress">
      <div
        className="job-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Job progress"
      >
        <div className="job-progress-fill" style={{ width: total > 0 ? `${(done / total) * 100}%` : '0%' }} />
      </div>
      <p className="job-progress-label muted">{label}</p>
    </div>
  );
}

export interface JobsViewProps {
  api: LocHubApi;
  culture: string;
  // The loaded grid rows (path/folder filter): drives the Group PathFilter's suggestions and counts.
  // Defaults to [] so a caller that predates this prop (e.g. a test rendering JobsView on its own) keeps
  // working, just without suggestions.
  rows?: readonly GridRow[];
  // How the service bills translate jobs; defaults to 'api' so a caller that predates this prop keeps today's
  // behavior.
  billing?: 'api' | 'subscription';
  // Whether the active AI provider is actually usable right now (health.ai.ready); defaults to true. While false,
  // Estimate and Run are disabled (the service would answer 400 ai_not_ready anyway) and aiDetail explains why.
  aiReady?: boolean;
  aiDetail?: string;
  preset?: JobScope;
  onJobDone: () => void;
  pollMs?: number;
}

function JobReportLine({ report }: { report: JobReport }) {
  return (
    <>
      <p>
        Written {report.written} · suggestions {report.suggestions} · needs fix {report.needsFix} · refused {report.refused} · errors {report.errors} · questions{' '}
        {report.questions} · R {report.bands.R} / Y {report.bands.Y} / G {report.bands.G} · {report.inputTokens.toLocaleString('en-US')} input /{' '}
        {report.outputTokens.toLocaleString('en-US')} output tokens
      </p>
      {report.errorSamples && report.errorSamples.length > 0 && (
        <div className="job-errors">
          <h4>Error reasons</h4>
          <ul>
            {report.errorSamples.map((sample, index) => (
              <li key={index}>{sample}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function JobsView({ api, culture, rows = [], billing = 'api', aiReady = true, aiDetail = '', preset, onJobDone, pollMs = 1000 }: JobsViewProps) {
  const [group, setGroup] = useState('');
  const [unitIds, setUnitIds] = useState<string[]>(preset?.unitIds ?? []);
  const groupEntries = useMemo(() => groupPathEntries(rows, culture), [rows, culture]);
  const [estimate, setEstimate] = useState<JobEstimate>();
  const [maxUsd, setMaxUsd] = useState('');
  const [job, setJob] = useState<JobRecord>();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [jobStatusUnknown, setJobStatusUnknown] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const startCountRef = useRef(0);
  // Bumped by resetEstimate on every scope change (culture, group, selection, preset): runEstimate captures the
  // current value before its request and only applies the response if it is still current, so an estimate (or
  // the pending "Estimating…" state) for an old scope can never be shown once the scope has moved on.
  const estimateGenRef = useRef(0);

  const resetEstimate = () => {
    estimateGenRef.current++;
    setEstimate(undefined);
    setMaxUsd('');
    setEstimating(false);
  };

  useEffect(() => {
    setUnitIds(preset?.unitIds ?? []);
    resetEstimate();
  }, [preset]);

  useEffect(() => {
    resetEstimate();
  }, [culture]);

  // Job resume: a view that lost its job (unmounted on a tab switch, or a fresh mount after a culture
  // change) asks the service for the newest job of this culture and resumes it as if it had started it itself —
  // the polling effect below then takes over for a running one, and a finished one just shows its report line.
  useEffect(() => {
    let cancelled = false;
    setJob(undefined);
    setJobStatusUnknown(false);
    api
      .currentJob(culture)
      .then((current) => {
        if (!cancelled && current) setJob(current);
      })
      .catch(() => {
        // Best-effort resume: a failed lookup just means the view starts without a job, same as before this fix.
      });
    return () => {
      cancelled = true;
    };
  }, [api, culture]);

  useEffect(() => {
    if (!job || job.status !== 'running' || jobStatusUnknown) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api.job(job.id);
        if (!cancelled) {
          setJob(next);
          if (next.status !== 'running') onJobDone();
          setJobStatusUnknown(false);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(errorText(e));
          setJobStatusUnknown(true);
        }
      }
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, job, onJobDone, pollMs, jobStatusUnknown]);

  // A value ending in "/" is a folder prefix (path/folder filter): sent as groupPrefix, matching every
  // group key under that folder; anything else is an exact groupKey.
  const groupScope = group === '' ? {} : group.endsWith('/') ? { groupPrefix: group } : { groupKey: group };
  const scope: JobScope = { culture, mode: 'sync', ...groupScope, ...(unitIds.length > 0 ? { unitIds } : {}) };
  const running = job?.status === 'running';
  // No dollar amount to show or budget: the subscription bills nothing per request, a model with no entry in the
  // price table gives a null estimate.usd, and a $0 estimate (every string reuses translation memory or a cached
  // answer, no model call) has nothing to enter a Max USD against either. Either way there is no Max USD field
  // and no budget check on Run.
  const noDollars = billing === 'subscription' || estimate?.usd === null || estimate?.usd === 0;
  // strings mirrors the service's JobEstimate.strings (every string in scope the job would write: model-planned
  // items plus TM reuse and cached answers); an older service that predates the field sends only items, which is
  // then the right number to show (nothing extra was reused for free).
  const strings = estimate ? (estimate.strings ?? estimate.items) : 0;

  const runEstimate = async () => {
    // Return early if already estimating; the estimate can take tens of seconds
    // when the provider counts tokens, so we prevent double-clicks and show a pending state.
    if (estimating) return;
    const gen = ++estimateGenRef.current;
    setEstimating(true);
    setError('');
    try {
      const { estimate: next } = await api.estimate(scope);
      // A resetEstimate (culture/group/selection/preset changed) since this request was sent bumps the
      // generation: the scope this response answers for is no longer the one on screen, so it is dropped.
      if (gen !== estimateGenRef.current) return;
      setEstimate(next);
      setMaxUsd(typeof next.usd === 'number' ? suggestMaxUsd(next.usd) : '');
    } catch (e) {
      if (gen !== estimateGenRef.current) return;
      setError(errorText(e));
    } finally {
      if (gen === estimateGenRef.current) setEstimating(false);
    }
  };

  // skipEstimate (Run without estimate): starts the job immediately for the current scope, with no maxUsd —
  // the service ignores it entirely (CONTRACT.md) — and no cost estimate to gate on, so noDollars/maxUsd never
  // enter into this call.
  const start = async (options: { skipEstimate?: boolean } = {}) => {
    const startId = ++startCountRef.current;
    if (startId !== 1) {
      startCountRef.current--;
      return;
    }
    setStarting(true);
    setError('');
    try {
      const { jobId, estimate: accepted } = await api.startJob(
        scope,
        options.skipEstimate || noDollars ? undefined : Number(maxUsd),
        options.skipEstimate,
      );
      setJob({ id: jobId, culture, status: 'running', estimate: accepted });
      setJobStatusUnknown(false);
    } catch (e) {
      // job_running: another job for this culture is already running (started elsewhere, or by this view
      // before an intervening resume). Show that job instead of just the message, so the user sees it running.
      const runningJobId = e instanceof ApiError && e.body.error === 'job_running' ? e.body.jobId : undefined;
      if (runningJobId) {
        try {
          setJob(await api.job(runningJobId));
          setJobStatusUnknown(false);
        } catch {
          setError(errorText(e));
        }
      } else {
        setError(errorText(e));
      }
    } finally {
      startCountRef.current--;
      setStarting(false);
    }
  };

  return (
    <div className="jobs">
      <h2>Translate {culture}</h2>
      <div className="form-row">
        <label>
          Group{' '}
          <PathFilter
            value={group}
            onChange={(next) => {
              setGroup(next);
              resetEstimate();
            }}
            entries={groupEntries}
            ariaLabel="Group"
            placeholder="all groups"
          />
        </label>
        {unitIds.length > 0 && (
          <span>
            {unitIds.length} selected {unitIds.length === 1 ? 'string' : 'strings'}{' '}
            <button
              type="button"
              onClick={() => {
                setUnitIds([]);
                resetEstimate();
              }}
            >
              Clear selection
            </button>
          </span>
        )}
        <button type="button" onClick={() => void runEstimate()} disabled={running || !aiReady || estimating} aria-busy={estimating} title={aiReady ? undefined : aiDetail}>
          {estimating ? 'Estimating…' : 'Estimate'}
        </button>
        <button
          type="button"
          onClick={() => void start({ skipEstimate: true })}
          disabled={running || !aiReady || estimating || starting}
          title="Starts right away: no cost estimate and no Max USD limit. The job report shows the real cost."
        >
          Run without estimate
        </button>
      </div>
      {estimating && <p className="muted" role="status">Estimating the cost…</p>}
      {estimate && strings === 0 && <p className="muted">{group !== '' ? 'No strings match this group.' : 'Nothing to translate.'}</p>}
      {estimate && strings > 0 && estimate.items === 0 && (
        <div className="estimate">
          <p>{strings} strings reuse translation memory or cached answers — no translate cost is estimated; judging may still run.</p>
          {/* No model call happens in this branch regardless of usd (0 or unpriced-model null alike), so there is
              nothing for a Max USD budget to gate: canRun (which requires a numeric usd) does not apply here. */}
          <button type="button" onClick={() => void start()} disabled={running || starting || !aiReady} title={aiReady ? undefined : aiDetail}>
            Run
          </button>
        </div>
      )}
      {estimate && estimate.items > 0 && noDollars && (
        <div className="estimate">
          <p>
            ≈ {estimate.items} strings in {estimate.requests} requests · ≈ {estimate.inputTokens.toLocaleString('en-US')} input /{' '}
            {estimate.outputTokens.toLocaleString('en-US')} output tokens ·{' '}
            {noDollarsNote(billing, estimate)}
          </p>
          {estimate.pricesUnset && <p className="muted">Custom endpoint prices are 0 in Project Settings; Max USD cannot limit spending.</p>}
          {estimate.approximate && <p className="muted">≈ Approximate: token counts are estimated from text length; the job report shows the real usage.</p>}
          <button type="button" onClick={() => void start()} disabled={running || starting || !aiReady} title={aiReady ? undefined : aiDetail}>
            Run
          </button>
        </div>
      )}
      {estimate && estimate.items > 0 && !noDollars && typeof estimate.usd === 'number' && (
        <div className="estimate">
          <p>
            {estimate.approximate ? '≈ ' : ''}
            {estimate.items} strings in {estimate.requests} requests · {estimate.inputTokens.toLocaleString('en-US')} input /{' '}
            {estimate.outputTokens.toLocaleString('en-US')} output tokens · estimated {formatUsd(estimate.usd)}
          </p>
          {estimate.approximate && <p className="muted">≈ Approximate: token counts are estimated from text length; the job report shows the real usage.</p>}
          <label>
            Max USD <input inputMode="decimal" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} />
          </label>{' '}
          <button type="button" onClick={() => void start()} disabled={!canRun(estimate, maxUsd) || running || starting || !aiReady} title={aiReady ? undefined : aiDetail}>
            Run
          </button>
          {!canRun(estimate, maxUsd) && <p className="muted">Max USD must cover the estimate.</p>}
        </div>
      )}
      {job && (
        <div className="job">
          {jobStatusUnknown ? (
            <p>Job status unknown — the service may have restarted.</p>
          ) : job.status === 'running' && job.progress ? (
            <JobProgressBar progress={job.progress} />
          ) : (
            <p>{`Job ${job.status}`}</p>
          )}
          {!jobStatusUnknown && job.report && <JobReportLine report={job.report} />}
          {!jobStatusUnknown && job.error && <p className="error">{job.error}</p>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
