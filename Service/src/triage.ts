import { KIND_METADATA_KEY, type Ambiguity, type Band, type JudgeIssue, type Unit } from './contract.js';
import { textHash } from './ids.js';
import { blocksAutoAccept, type PrecheckIssue } from './precheck.js';

export interface TriageInput {
  unit: Unit;
  ambiguity: Ambiguity;
  precheck: PrecheckIssue[];
  judge: JudgeIssue[];
  refused: boolean;
}

// Review priority only: the release policy ships every valid band.
export function bandFor(input: TriageInput): Band {
  if (input.refused || blocksAutoAccept(input.precheck) || input.judge.some((j) => j.severity !== 'minor')) return 'R';
  if (input.ambiguity === 'guessed') return input.unit.metadata[KIND_METADATA_KEY] === 'ui' ? 'R' : 'Y';
  if (input.ambiguity === 'context' || input.judge.length > 0 || input.precheck.length > 0) return 'Y';
  return 'G';
}

// Blind audit: a stable pseudo-random share of green cells goes to the queue to measure what triage misses.
export function isAuditSample(unitId: string, culture: string, percent: number): boolean {
  return parseInt(textHash(`${unitId}|${culture}|audit`).slice(0, 8), 16) % 100 < percent;
}
