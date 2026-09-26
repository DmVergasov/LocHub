// Wire types. Everything the service keeps in its contract module is imported from there, so the web app and the
// service cannot drift; shapes that live next to Node-only service code are mirrored below.
import type { Cell, CoverageFinding, InboxItem, Unit } from '../../../Service/src/contract';

export type {
  Band,
  BridgeCommandName,
  Cell,
  CellEvent,
  CellStatus,
  CoverageFinding,
  GlossaryTerm,
  InboxItem,
  InboxStatus,
  JudgeIssue,
  Unit,
} from '../../../Service/src/contract';

export interface CellRow {
  unit: Unit;
  cell: Cell;
  outdated: boolean;
}

export interface CellsPage {
  total: number;
  rows: CellRow[];
}

// Mirror of PrecheckIssue in Service/src/precheck.ts. hard: Unreal rejects the text, nobody can approve it;
// confirm: valid for Unreal but probably a mistake, approvable with `accept`; soft: a hint.
export interface PrecheckIssue {
  code: string;
  severity: 'hard' | 'confirm' | 'soft';
  message: string;
}

// Mirror of JobEstimate in Service/src/estimate.ts. billing is missing only from a stored estimate an older
// service wrote before the field existed; a live response always sends it. usd is null when the model's price
// is unknown (a new provider's model not yet in the price table). strings is every string in scope the job would
// actually write (items, model-planned, plus TM reuse and cached answers); absent from an older service that
// predates the field, in which case it means the same as items (no free reuse to report separately).
export interface JobEstimate {
  requests: number;
  items: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  billing?: 'api' | 'subscription';
  strings?: number;
  // True when at least one group's inputTokens is a local character-count guess (approxInputTokens) instead of
  // a real count: either Run without estimate (skipEstimate, JobsView.tsx) or a rate-limit/overloaded error the
  // service's own retries could not clear. Absent (never `false`) for a wholly real estimate. Absent from an
  // older service that predates the field, in which case it means the same as `false`.
  approximate?: boolean;
}

// Mirror of JobReport in Service/src/job.ts. errorSamples is up to 3 redacted messages explaining what went
// wrong for the job's `errors` count; absent from an older service that predates the field, or when there is
// nothing to show.
export interface JobReport {
  culture: string;
  requested: number;
  tm: number;
  written: number;
  suggestions: number;
  needsFix: number;
  refused: number;
  errors: number;
  questions: number;
  bands: { R: number; Y: number; G: number };
  inputTokens: number;
  outputTokens: number;
  errorSamples?: string[];
}

export type JobStatus = 'running' | 'done' | 'failed';

// Mirror of JobProgress in Service/src/job.ts. Units are strings, not requests/groups; see CONTRACT.md's Jobs
// section for the exact meaning of done/total in each phase.
export interface JobProgress {
  phase: 'translate' | 'repair' | 'judge' | 'write';
  done: number;
  total: number;
}

export interface JobRecord {
  id: string;
  culture: string;
  status: JobStatus;
  estimate: JobEstimate;
  report?: JobReport;
  error?: string;
  // Absent until the job's first progress event lands (older service, or the first poll); left at its last
  // value once the job ends.
  progress?: JobProgress;
}

export type JobMode = 'sync' | 'batch';

export interface JobScope {
  culture: string;
  mode?: JobMode;
  groupKey?: string;
  // A folder prefix (path/folder filter): matches every group key starting with it. Mutually exclusive
  // with groupKey; the service answers 400 invalid_scope if both are sent.
  groupPrefix?: string;
  unitIds?: string[];
}

// Mirror of CultureSummary in Service/src/summary.ts.
export interface CultureSummary {
  culture: string;
  total: number;
  byStatus: Record<string, number>;
  byBand: { R: number; Y: number; G: number };
  outdated: number;
  openQuestions: number;
  audit: { sampled: number; corrected: number };
}

export interface CoverageReport {
  pushedAt: string;
  findings: CoverageFinding[];
}

export interface InboxUnit {
  namespace: string;
  key: string;
  source: string;
  origin: string;
  devNotes: string;
}

export interface InboxRow {
  item: InboxItem;
  unit: InboxUnit | null;
}

export type AiProvider = 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'gemini';

// Mirror of the health block server.ts builds from the active AI provider config: which provider and models
// translate jobs run on, whether Batch mode is available for it, and whether it is actually usable right now
// (provider API key set / Claude subscription signed in).
export interface AiStatus {
  provider: AiProvider;
  auth: 'api' | 'subscription';
  translateModel: string;
  judgeModel: string;
  batch: boolean;
  ready: boolean;
  detail: string;
}

export interface Health {
  ok: boolean;
  units: number;
  editorConnected: boolean;
  // True after Localization/LocHub changed on disk since the service loaded it (CONTRACT.md, "Writes and 409 files_changed_on_disk").
  stale: boolean;
  // True while any translation job has status 'running'. Absent from an older service that predates the field;
  // App treats that the same as false (no job to notice finishing).
  jobRunning?: boolean;
  // Monotonic counter, incremented once for every job that leaves 'running': unlike jobRunning, this also
  // catches a job that starts and ends between two health polls. Absent from an older service that predates the
  // field; App treats that the same as "no reload" (see App.tsx).
  jobsFinished?: number;
  // Absent from an older service that predates the ai block; treat as Anthropic, API key, no Batch info, ready.
  ai?: AiStatus;
}

export interface Meta {
  nativeCulture: string;
  cultures: string[];
}

// ApplyLive entry (CONTRACT.md, "Bridge commands"): source is the current English text of the unit.
export interface LiveEntry {
  namespace: string;
  key: string;
  source: string;
  translation: string;
}
