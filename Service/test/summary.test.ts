import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotEntry } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { recordQuestion } from '../src/memory.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';
import { summarize } from '../src/summary.js';

const entry = (key: string): SnapshotEntry => ({ namespace: 'HW', key, source: key, origin: 'o', devNotes: '', metadata: {}, groupKey: 'g' });

describe('summarize', () => {
  it('counts statuses, bands, outdated cells, open questions and the blind-audit metric', () => {
    const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-sum-')));
    const snap = { target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {} };
    applySnapshot(store, { ...snap, entries: ['A', 'B', 'C', 'D', 'E'].map(entry) });
    applySnapshot(store, { ...snap, entries: ['A', 'B', 'C', 'D'].map(entry) });
    const put = (key: string, patch: object) => store.putCell({ ...store.getCell('ru', unitIdOf('HW', key)), text: key, basedOnSourceRev: 1, ...patch });
    put('A', { status: 'ai_draft', band: 'G', qaFlags: ['audit'] });
    put('B', { status: 'edited', band: 'G', qaFlags: ['audit'] });
    put('C', { status: 'approved', band: 'Y', basedOnSourceRev: 0 });
    recordQuestion(store, 'ru', unitIdOf('HW', 'A'), 'Which screen?', 'ai', 't');

    expect(summarize(store, 'ru')).toEqual({
      culture: 'ru',
      total: 4,
      byStatus: { ai_draft: 1, edited: 1, approved: 1, empty: 1 },
      byBand: { R: 0, Y: 1, G: 2 },
      outdated: 1,
      openQuestions: 1,
      audit: { sampled: 2, corrected: 1 },
    });
  });
});
