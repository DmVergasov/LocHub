// Types shared by the service, the UE plugin (plan 2) and the web app (plan 3). See CONTRACT.md.

export type Culture = string;

// Metadata key the UE plugin sets on units shown in UI widgets ('ui') versus other text ('text').
export const KIND_METADATA_KEY = 'LocHub.Kind';

export interface SnapshotEntry {
  namespace: string;
  key: string;
  source: string;
  origin: string;
  devNotes: string;
  metadata: Record<string, string>;
  groupKey: string;
}

export interface ArchiveEntry {
  namespace: string;
  key: string;
  translation: string;
  // The English text this translation was made for: Push ignores an entry whose source differs from
  // the unit's current source, or that repeats a text LocHub itself produced earlier for this cell.
  source: string;
}

// A player-visible string that bypasses localization, reported by the plugin on every Push.
export interface CoverageFinding {
  kind: string;
  file: string;
  line: number;
  text: string;
}

// The CLDR plural categories the engine's own ICU data gives one culture (FCulture::GetValidPluralForms). The
// engine validates plural modifiers against these on Pull, and its CLDR can differ from Node's.
export interface PluralForms {
  cardinal: string[];
  ordinal: string[];
}

export interface Snapshot {
  target: string;
  nativeCulture: Culture;
  cultures: Culture[];
  entries: SnapshotEntry[];
  archives: Record<Culture, ArchiveEntry[]>;
  coverage?: CoverageFinding[];
  // Absent from an older plugin, and a culture the engine cannot resolve is left out: Node's ICU answers then.
  pluralForms?: Record<Culture, PluralForms>;
}

export type UnitState = 'active' | 'tombstone';

export interface Unit {
  id: string;
  namespace: string;
  key: string;
  source: string;
  sourceRev: number;
  state: UnitState;
  origin: string;
  devNotes: string;
  metadata: Record<string, string>;
  groupKey: string;
}

export type CellStatus = 'empty' | 'ai_draft' | 'needs_fix' | 'approved' | 'edited' | 'human_edit' | 'rejected';
export type Band = 'R' | 'Y' | 'G' | '';
export type Ambiguity = 'none' | 'context' | 'guessed';

export interface JudgeIssue {
  severity: 'minor' | 'major' | 'critical';
  category: string;
  why: string;
  fix: string;
}

export interface Cell {
  unitId: string;
  culture: Culture;
  text: string;
  status: CellStatus;
  basedOnSourceRev: number;
  basedOnSource: string;
  provenance: string;
  ambiguity: Ambiguity;
  alts: string[];
  question: string;
  note: string;
  suggestion: string;
  judgeIssues: JudgeIssue[];
  qaFlags: string[];
  band: Band;
  archiveHash: string;
  revision: number;
}

export interface GlossaryTerm {
  term: string;
  translation: string;
  dnt: boolean;
  note: string;
}

export type CellEventAction =
  | 'approve'
  | 'edit'
  | 'reject'
  | 'human_edit'
  | 'tm'
  | 'ai_draft'
  | 'ai_needs_fix'
  | 'ai_suggestion'
  | 'ai_refused'
  | 'ai_error'
  // Engine decisions recorded by applyExportAck: why a cell was written, or turned R by the engine.
  | 'engine_rejected'
  | 'exported';

export interface CellEvent {
  ts: string;
  unitId: string;
  culture: Culture;
  action: CellEventAction;
  actor: string;
  before: string;
  after: string;
  // An approve or edit a human confirmed despite these 'confirm' precheck codes; present only when non-empty.
  accepted?: string[];
}

export type InboxStatus = 'open' | 'answered' | 'applied' | 'dismissed';

// A question from the model (or a reviewer's request for context) about one unit.
export interface InboxItem {
  id: string;
  unitId: string;
  culture: Culture;
  question: string;
  askedBy: string;
  status: InboxStatus;
  answer: string;
  created: string;
  answered: string;
}

export interface PushReport {
  added: number;
  changed: number;
  cosmetic: number;
  tombstoned: number;
  revived: number;
  humanEdits: number;
}

export interface ExportEntry {
  unitId: string;
  namespace: string;
  key: string;
  source: string;
  translation: string;
}

export interface ExportAck {
  culture: Culture;
  written: { unitId: string; translation: string }[];
  // translation: the text the engine actually rejected. applyExportAck ignores a rejection whose
  // translation is not the cell's current text — the engine was validating a text a human has since replaced.
  rejected: { unitId: string; translation: string; errors: string[] }[];
}

export type ReleasePolicy = 'validated' | 'approved_only';

export const BRIDGE_COMMANDS = ['OpenOrigin', 'SetPreviewCulture', 'ApplyLive'] as const;
export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number];

export interface BridgeCommand {
  name: BridgeCommandName;
  args: Record<string, unknown>;
}

export function emptyCell(unitId: string, culture: Culture): Cell {
  return {
    unitId,
    culture,
    text: '',
    status: 'empty',
    basedOnSourceRev: 0,
    basedOnSource: '',
    provenance: '',
    ambiguity: 'none',
    alts: [],
    question: '',
    note: '',
    suggestion: '',
    judgeIssues: [],
    qaFlags: [],
    band: '',
    archiveHash: '',
    revision: 0,
  };
}

// "Outdated" is computed, never stored: the cell was produced for an older source revision.
export function isOutdated(unit: Unit, cell: Cell): boolean {
  return cell.status !== 'empty' && cell.text.length > 0 && cell.basedOnSourceRev < unit.sourceRev;
}

// The blind-audit mark survives human actions: it is how the summary measures what triage missed.
export function keepAudit(cell: Cell): string[] {
  return cell.qaFlags.filter((flag) => flag === 'audit');
}
