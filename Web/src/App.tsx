import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocHubApi } from './api/client';
import type { AiProvider, EndpointHealth, EndpointStatus, Health, JobScope, Meta } from './api/types';
import type { BridgeRoute, EditorBridge, SyncAction, SyncOutcome } from './bridge';
import { extraColumns, loadChosenColumns, saveChosenColumns, visibleCultures } from './grid/columns';
import { errorText } from './errors';
import { GlossaryView } from './glossary/GlossaryView';
import { ExchangeActions } from './exchange/ExchangeActions';
import { GridView } from './grid/GridView';
import { liveEntries, NO_FILTERS, type GridFilters, type GridRow } from './grid/model';
import { useGridData } from './grid/useGridData';
import { JobsView } from './jobs/JobsView';
import { CoverageView } from './reports/CoverageView';
import { InboxView } from './reports/InboxView';
import { SummaryView } from './reports/SummaryView';
import { CellPanel } from './review/CellPanel';
import { QueueView } from './review/QueueView';
import { buildQueue } from './review/queue';
import { useView, viewHref, type View } from './route';

const NAV: { view: View; label: string }[] = [
  { view: { name: 'grid' }, label: 'Grid' },
  { view: { name: 'queue' }, label: 'Review' },
  { view: { name: 'glossary' }, label: 'Glossary' },
  { view: { name: 'jobs' }, label: 'Jobs' },
  { view: { name: 'coverage' }, label: 'Coverage' },
  { view: { name: 'summary' }, label: 'Summary' },
  { view: { name: 'inbox' }, label: 'Inbox' },
];

export function editorStatus(health: Health | undefined, route: BridgeRoute): string {
  if (!health) return 'Service offline';
  if (route === 'direct') return 'Editor: this tab';
  if (route === 'relay') return 'Editor: connected';
  return 'Editor: offline';
}

const AI_PROVIDER_LABEL: Record<AiProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  custom: 'Custom',
};

// The Custom endpoint's startup probe (GET /api/health ai.endpoint.status), as the AI pill words it.
const ENDPOINT_STATUS_LABEL: Record<EndpointStatus, string> = {
  checking: 'checking endpoint…',
  ok: 'endpoint OK',
  model_missing: 'model missing',
  unreachable: 'unreachable',
  unknown: 'no model list',
};

// Only an unreachable endpoint is an error; a missing model, like a provider that is not ready, is a warning.
function aiBadgeTone(ready: boolean, endpoint: EndpointHealth | undefined): string {
  if (endpoint?.status === 'unreachable') return ' endpoint-error';
  if (!ready || endpoint?.status === 'model_missing') return ' warning';
  return '';
}

function AiBadge({ health }: { health: Health | undefined }) {
  if (!health) return null;
  const ai = health.ai;
  // Missing `ai` (an older service) means Anthropic, ready, no models to show and no warning (CONTRACT.md).
  if (!ai) return <span className="ai-status">AI: Anthropic</span>;
  // An even older service can still send the *previous* `ai` shape ({backend, ready, detail}, no `provider`); only
  // the current shape has a provider/models to show, so fall back to a plain Anthropic label but keep any
  // ready/detail warning that shape still carries.
  const isCurrentShape = typeof ai.provider === 'string' && ai.provider in AI_PROVIDER_LABEL;
  const endpoint = isCurrentShape ? ai.endpoint : undefined;
  // A Custom endpoint adds its host (the service never sends the path or query) and the probe status.
  const host = endpoint ? ` (${endpoint.url.replace(/^https?:\/\//, '')})` : '';
  const probe = endpoint ? ` · ${ENDPOINT_STATUS_LABEL[endpoint.status] ?? endpoint.status}` : '';
  const label = isCurrentShape
    ? `AI: ${AI_PROVIDER_LABEL[ai.provider]}${ai.auth === 'subscription' ? ' (subscription)' : ''}${host} · ${ai.translateModel} / ${ai.judgeModel}${probe}`
    : 'AI: Anthropic';
  const title = ai.ready ? (endpoint?.detail ?? '') : ai.detail;
  return (
    <span className={`ai-status${aiBadgeTone(ai.ready, endpoint)}`} title={title}>
      {label}
    </span>
  );
}

const THEME_KEY = 'lochub.theme';

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function readStoredTheme(): 'light' | 'dark' | undefined {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : undefined;
  } catch {
    return undefined; // storage may be unavailable (private mode, blocked cookies)
  }
}

// A small manual override on top of main.tsx's host/OS default (?host=editor -> dark, else the OS setting): once
// the user picks a theme here it is remembered per browser and wins over that default on the next load.
function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readStoredTheme() ?? currentTheme());
  const next = theme === 'dark' ? 'light' : 'dark';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Best-effort: the toggle still works for this page load even if it cannot be remembered.
    }
  };

  return (
    <button type="button" aria-label="Toggle theme" onClick={toggle}>
      {next === 'dark' ? 'Dark' : 'Light'}
    </button>
  );
}

function neighborsOf(rows: readonly GridRow[], row: GridRow): GridRow[] {
  return rows.filter((candidate) => candidate.unit.groupKey === row.unit.groupKey && candidate.unit.id !== row.unit.id).slice(0, 8);
}

const SYNC_LABEL: Record<SyncAction, string> = { push: 'Push', dryrun: 'Dry run', pull: 'Pull' };
const SYNC_BUSY_LABEL: Record<SyncAction, string> = { push: 'Pushing…', dryrun: 'Checking…', pull: 'Pulling…' };
const SYNC_TITLE: Record<SyncAction, string> = {
  push: 'Send the gathered strings to LocHub (a dry run and a confirmation come first)',
  dryrun: 'Show what a Push would add, change and retire',
  pull: 'Write released translations into the archives and compile .locres',
};
const SYNC_ACTIONS: SyncAction[] = ['push', 'dryrun', 'pull'];

function syncOutcomeClass(outcome: SyncOutcome): string {
  if (outcome.cancelled) return 'cancelled';
  return outcome.success ? 'ok' : 'failed';
}

function SyncResultPanel({ outcome, onDismiss }: { outcome: SyncOutcome; onDismiss: () => void }) {
  return (
    <div className={`sync-result ${syncOutcomeClass(outcome)}`} role="status">
      <span>{outcome.summary}</span>
      {outcome.details.length > 0 && (
        <details>
          <summary>Details</summary>
          <ul>
            {outcome.details.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      <button type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export interface AppProps {
  api: LocHubApi;
  bridge: EditorBridge;
  healthMs?: number;
}

export function App({ api, bridge, healthMs = 5000 }: AppProps) {
  const [view, navigate] = useView();
  const [meta, setMeta] = useState<Meta>({ nativeCulture: '', cultures: [] });
  const [chosenCulture, setChosenCulture] = useState('');
  const [chosenColumns, setChosenColumns] = useState<string[] | undefined>(() => loadChosenColumns());
  const [health, setHealth] = useState<Health>();
  const [filters, setFilters] = useState<GridFilters>(NO_FILTERS);
  const [jobPreset, setJobPreset] = useState<JobScope>();
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState<SyncAction | null>(null);
  const [syncResult, setSyncResult] = useState<SyncOutcome | null>(null);
  // The grid's scroll position lives here, outside GridView, so it survives GridView unmounting (the card view or
  // any other tab renders in its place). A ref, not state: recording it on every scroll must not re-render App.
  const gridScroll = useRef({ top: 0, left: 0 });

  // Only cultures the project is actually set up for (meta.cultures, filled from the last Push) are ever shown or
  // selectable: a culture the service does not know cannot be requested, so there is no "add culture" control.
  const cultures = useMemo(() => [...meta.cultures].sort(), [meta.cultures]);
  const culture = cultures.includes(chosenCulture) ? chosenCulture : (cultures[0] ?? '');
  const visible = useMemo(() => visibleCultures(cultures, chosenColumns, culture), [cultures, chosenColumns, culture]);
  // Only the visible cultures are loaded, not every project culture. `visible` always includes the active
  // culture (visibleCultures's own contract), so Queue/Glossary/card view/Apply live keep working.
  const grid = useGridData(api, visible);
  const reviewCount = useMemo(() => buildQueue(grid.rows, culture).length, [grid.rows, culture]);
  const editorConnected = health?.editorConnected ?? false;
  const route = bridge.route(editorConnected);
  const { reload } = grid;

  const onVisible = useCallback((list: string[]) => {
    const extras = extraColumns(list, culture, chosenColumns);
    setChosenColumns(extras);
    saveChosenColumns(extras);
  }, [culture, chosenColumns]);

  useEffect(() => {
    const poll = () => {
      api.health().then(setHealth, () => setHealth(undefined));
    };
    poll();
    const timer = window.setInterval(poll, healthMs);
    return () => window.clearInterval(timer);
  }, [api, healthMs]);

  // Notices a job finishing independently of which view is open. JobsView
  // only reloads the grid while it is mounted (the Jobs tab); switching to Grid mid-job means nobody calls
  // reload() when it ends. The original signal here was health.jobRunning going true then false, but a job
  // shorter than one health poll (healthMs) is never observed as a true->false transition — it can start and end
  // between two polls, or while the Jobs tab is unmounted, with jobRunning reading false at every single poll.
  // health.jobsFinished (a monotonic counter, incremented by the service once per job leaving 'running') fixes
  // that: App remembers the last value it saw and reloads whenever a later poll reports a larger one. The first
  // poll only records the value — there is nothing yet to compare it against — and an absent field (an older
  // service) never reloads. This can double up with onJobDone below when the Jobs tab is open and itself just
  // finished a job (both call reload() for the same job); that extra fetch is accepted, not worth suppressing.
  const lastJobsFinished = useRef<number | undefined>(undefined);

  const onJobDone = useCallback(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const seen = health?.jobsFinished;
    if (seen === undefined) return;
    if (lastJobsFinished.current !== undefined && seen > lastJobsFinished.current) {
      void reload();
    }
    lastJobsFinished.current = seen;
  }, [health?.jobsFinished, reload]);

  // Length Check settings change (I-1): a different lengthArgs string means the editor restarted the service with
  // new Length Check settings. That restart resets jobsFinished to 0, so the effect above never fires for it, and
  // nothing else reloads the grid on its own — the cell panel's counter (GridRow.lengthLimit, filled by the last
  // GET /api/cells) would otherwise keep the OLD limit even though the panel's own live check already runs
  // against the NEW settings. Same shape as the jobsFinished effect above: remember the first value seen, then
  // reload whenever a later poll reports a different one. An absent field (an older service) never reloads.
  const lastLengthArgs = useRef<string | undefined>(undefined);

  useEffect(() => {
    const seen = health?.ai?.lengthArgs;
    if (seen === undefined) return;
    if (lastLengthArgs.current !== undefined && seen !== lastLengthArgs.current) {
      void reload();
    }
    lastLengthArgs.current = seen;
  }, [health?.ai?.lengthArgs, reload]);

  const loadMeta = useCallback(() => {
    return api.meta().then(setMeta, (e: unknown) => setError(errorText(e)));
  }, [api]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  // Refresh also re-reads /api/meta, so a culture added by a later Push shows up without a page reload.
  const refresh = useCallback(() => {
    void reload();
    void loadMeta();
  }, [reload, loadMeta]);

  const runSync = async (action: SyncAction) => {
    setSyncing(action);
    try {
      const outcome = await bridge.sync(action);
      setSyncResult(outcome);
      // A Push can add a culture (its Gather Text step may have picked up new ones); a Pull writes new
      // translations into the archives. Either way the grid and meta.cultures may now be stale.
      if (outcome.success && (action === 'push' || action === 'pull')) refresh();
    } catch (e) {
      setSyncResult({ success: false, cancelled: false, summary: errorText(e), details: [] });
    } finally {
      setSyncing(null);
    }
  };

  const run = async (action: () => Promise<boolean>, failure: string) => {
    setError('');
    try {
      if (!(await action())) setError(failure);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const applyAllLive = () =>
    void run(() => bridge.applyLive(culture, liveEntries(grid.rows, culture), editorConnected), 'Nothing was applied: no translations, or the editor refused them.');
  const previewCulture = () => void run(() => bridge.setPreviewCulture(culture, editorConnected), 'The editor did not switch the preview culture.');

  let content: ReactNode;
  if (cultures.length === 0) {
    content = <p className="empty">No strings yet. If the project has no Game localization target, run Tools {'>'} LocHub {'>'} Set Up Localization Target in the editor. Then press Push to send your strings to LocHub.</p>;
  } else if (view.name === 'card') {
    const row = grid.rows.find((candidate) => candidate.unit.id === view.unitId);
    content = row ? (
      <div className="card-view">
        <a href={viewHref({ name: 'grid' })}>Back to the grid</a>
        <CellPanel
          key={`${row.unit.id}:${view.culture}`}
          api={api}
          bridge={bridge}
          row={row}
          culture={view.culture}
          editorConnected={editorConnected}
          neighbors={neighborsOf(grid.rows, row)}
          onCell={grid.updateCell}
          onUnit={grid.updateUnit}
        />
      </div>
    ) : (
      <p className="empty">{grid.loading ? 'Loading…' : 'This string is not in the grid.'}</p>
    );
  } else if (view.name === 'queue') {
    content = (
      <QueueView api={api} bridge={bridge} rows={grid.rows} culture={culture} editorConnected={editorConnected} onCell={grid.updateCell} onUnit={grid.updateUnit} />
    );
  } else if (view.name === 'glossary') {
    content = (
      <GlossaryView
        api={api}
        culture={culture}
        rows={grid.rows}
        onCell={grid.updateCell}
        onTermFix={(scope) => {
          setJobPreset(scope);
          navigate({ name: 'jobs' });
        }}
        bridge={bridge}
        cultures={cultures}
        nativeCulture={meta.nativeCulture}
      />
    );
  } else if (view.name === 'jobs') {
    content = (
      <JobsView
        api={api}
        culture={culture}
        rows={grid.rows}
        billing={health?.ai?.auth === 'subscription' ? 'subscription' : 'api'}
        aiReady={health?.ai?.ready ?? true}
        aiDetail={health?.ai?.detail ?? ''}
        preset={jobPreset}
        onJobDone={onJobDone}
      />
    );
  } else if (view.name === 'coverage') {
    content = <CoverageView api={api} />;
  } else if (view.name === 'summary') {
    content = <SummaryView api={api} culture={culture} />;
  } else if (view.name === 'inbox') {
    content = <InboxView api={api} culture={culture} />;
  } else {
    content = (
      <GridView
        rows={grid.rows}
        cultures={cultures}
        visible={visible}
        onVisible={onVisible}
        culture={culture}
        nativeCulture={meta.nativeCulture}
        filters={filters}
        onFilters={setFilters}
        onOpenCell={(cellCulture, unitId) => navigate({ name: 'card', culture: cellCulture, unitId })}
        onApplyLive={applyAllLive}
        canApplyLive={route !== 'none' && culture !== ''}
        bridge={bridge}
        editorConnected={editorConnected}
        scrollMemory={gridScroll.current}
        loadedCultures={grid.loadedCultures}
        loading={grid.loading}
        toolbarExtra={(filtered) => (
          // Keyed by culture: switching culture closes an open preview instead of importing into the new culture.
          <ExchangeActions
            key={culture}
            api={api}
            bridge={bridge}
            culture={culture}
            cultures={cultures}
            nativeCulture={meta.nativeCulture}
            filtered={filtered}
            totalCount={grid.rows.length}
            onImported={() => void reload()}
          />
        )}
      />
    );
  }

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <strong className="brand">
            <img className="brand-logo" src="./favicon.svg" alt="" width={20} height={20} />
            LocHub
          </strong>
          {meta.nativeCulture && (
            <span className="context-line muted">
              {meta.nativeCulture} → {cultures.length} {cultures.length === 1 ? 'culture' : 'cultures'}
            </span>
          )}
          <span className="spacer" />
          <select className="culture" aria-label="Culture" value={culture} onChange={(e) => setChosenCulture(e.target.value)}>
            {cultures.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
          <button type="button" onClick={previewCulture} disabled={route === 'none' || culture === ''}>
            Preview {culture || 'culture'} in editor
          </button>
          <span className={`editor-status route-${route}`}>{editorStatus(health, route)}</span>
          <AiBadge health={health} />
          {bridge.canSync() && (
            <div className="sync-actions">
              {SYNC_ACTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={action === 'push' ? 'primary' : undefined}
                  onClick={() => void runSync(action)}
                  disabled={syncing !== null}
                  title={SYNC_TITLE[action]}
                >
                  {syncing === action ? SYNC_BUSY_LABEL[action] : SYNC_LABEL[action]}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={refresh} disabled={grid.loading}>
            {grid.loading ? 'Loading…' : 'Refresh'}
          </button>
          <ThemeToggle />
        </div>
        <div className="top-row">
          <nav>
            {NAV.map((item) => (
              <a key={item.label} href={viewHref(item.view)} aria-current={item.view.name === view.name ? 'page' : undefined}>
                {item.view.name === 'queue' && reviewCount > 0 ? `${item.label} (${reviewCount})` : item.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      {health?.ai && !health.ai.ready && health.ai.detail && (
        <p className="notice warning" role="alert">
          {health.ai.detail}
        </p>
      )}
      {syncResult && <SyncResultPanel outcome={syncResult} onDismiss={() => setSyncResult(null)} />}
      {health?.stale && (
        <p className="banner stale" role="alert">
          {'Localization/LocHub changed on disk. Restart the LocHub service (Tools > LocHub > Restart Service), then Refresh.'}
        </p>
      )}
      {(error || grid.error) && (
        <p className="error" role="alert">
          {error || grid.error}
        </p>
      )}
      <main>{content}</main>
    </div>
  );
}
