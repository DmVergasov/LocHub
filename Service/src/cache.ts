import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmClient, LlmOutcome, LlmRequest } from './llm.js';

function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// Answers keyed by requestId; re-running a job or resuming after a crash costs nothing for cached groups.
export class ResponseCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  get(customId: string): LlmOutcome | undefined {
    const path = join(this.dir, `${customId}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as LlmOutcome;
    } catch {
      // A crash mid-write or on-disk corruption: treat it as a miss rather than failing every job
      // that touches this group, and clear it so the next successful put replaces it.
      try {
        unlinkSync(path);
      } catch {
        // Already gone; nothing to clean up.
      }
      return undefined;
    }
  }

  put(outcome: LlmOutcome): void {
    if (outcome.kind !== 'ok') return;
    writeFileAtomic(join(this.dir, `${outcome.customId}.json`), JSON.stringify(outcome));
  }
}

export interface ResolveOptions {
  mode: 'sync' | 'batch';
  concurrency: number;
  pollMs: number;
  // Request ids already answered in this job: an identical retry must reach the model again.
  fresh?: ReadonlySet<string>;
  // Fires for every outcome as soon as it is known — a cache hit immediately, a live answer as it arrives
  // (sync mode) or once the whole round is collected (batch mode). Lets the caller track job progress
  // without waiting for the whole round to finish.
  onOutcome?: (outcome: LlmOutcome) => void;
  // Batch mode only: forwarded to LlmClient.runBatch's own polling-based progress.
  onBatchProgress?: (finishedRequests: number, totalRequests: number) => void;
  // Sync mode only: forwarded to LlmClient.runSync (a declined request comes back 'skipped' and is never cached).
  // A batch is submitted whole, so there is no request left to decline once it is running.
  shouldContinue?: () => boolean;
}

export async function resolveWithCache(
  llm: LlmClient,
  cache: ResponseCache,
  requests: readonly LlmRequest[],
  opts: ResolveOptions,
): Promise<Map<string, LlmOutcome>> {
  const out = new Map<string, LlmOutcome>();
  const queued = new Set<string>();
  const toSend: LlmRequest[] = [];
  for (const request of requests) {
    if (out.has(request.customId) || queued.has(request.customId)) continue;
    const cached = opts.fresh?.has(request.customId) ? undefined : cache.get(request.customId);
    if (cached) {
      out.set(request.customId, cached);
      // A cache hit needs no round to finish: the caller's progress tracking sees it right away.
      opts.onOutcome?.(cached);
    } else {
      queued.add(request.customId);
      toSend.push(request);
    }
  }
  if (toSend.length === 0) return out;
  const cacheIfWorthKeeping = (outcome: LlmOutcome): void => {
    if (outcome.kind === 'ok' && isJsonObject(outcome.text)) cache.put(outcome);
  };
  if (opts.mode === 'batch') {
    // Batch results only arrive as a whole round, so caching (and onOutcome) happens after collection, as
    // before; onBatchProgress gives the caller an earlier, coarser signal while the round is still polling.
    const results = await llm.runBatch(toSend, opts.pollMs, opts.onBatchProgress);
    for (const outcome of results) {
      out.set(outcome.customId, outcome);
      cacheIfWorthKeeping(outcome);
      opts.onOutcome?.(outcome);
    }
  } else {
    // Sync mode: cache each answer as it arrives instead of waiting for the whole round, so a crash
    // mid-round does not lose answers that already came back; onOutcome rides along the same callback.
    const results = await llm.runSync(
      toSend,
      opts.concurrency,
      (outcome) => {
        cacheIfWorthKeeping(outcome);
        opts.onOutcome?.(outcome);
      },
      opts.shouldContinue,
    );
    for (const outcome of results) out.set(outcome.customId, outcome);
  }
  return out;
}

function isJsonObject(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}
