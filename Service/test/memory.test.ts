import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SnapshotEntry } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { answerQuestion, answersByUnit, buildTmIndex, dismissQuestion, markApplied, recordQuestion } from '../src/memory.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';

const entry = (key: string, source: string): SnapshotEntry => ({
  namespace: 'HW', key, source, origin: 'o', devNotes: '', metadata: {}, groupKey: 'g',
});

let store: LocHubStore;
const idA = unitIdOf('HW', 'A');
const idB = unitIdOf('HW', 'B');
const idC = unitIdOf('HW', 'C');

beforeEach(() => {
  store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-mem-')));
  applySnapshot(store, {
    target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {},
    entries: [entry('A', 'BACK'), entry('B', 'BACK'), entry('C', 'APPLY')],
  });
});

describe('buildTmIndex', () => {
  it('indexes human-confirmed, up-to-date translations by source text', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 1 });
    store.putCell({ ...store.getCell('ru', idC), text: 'ПРИМЕНИТЬ', status: 'ai_draft', basedOnSourceRev: 1 });
    const index = buildTmIndex(store, 'ru');
    expect(index.get('BACK')).toEqual({ text: 'НАЗАД', donorId: idA });
    expect(index.has('APPLY')).toBe(false);
  });

  it('skips outdated donors', () => {
    store.putCell({ ...store.getCell('ru', idA), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 0 });
    expect(buildTmIndex(store, 'ru').size).toBe(0);
  });
});

describe('inbox', () => {
  it('records a question once and ignores blank ones', () => {
    const first = recordQuestion(store, 'ru', idA, 'Is BACK a button? ', 'ai', 't1');
    const again = recordQuestion(store, 'ru', idA, 'Is BACK a button?', 'ai', 't2');
    expect(again?.id).toBe(first?.id);
    expect(store.inbox.size).toBe(1);
    expect(recordQuestion(store, 'ru', idA, '   ', 'ai', 't3')).toBeUndefined();
  });

  it('answers, dismisses and marks items applied', () => {
    const q = recordQuestion(store, 'ru', idA, 'Is BACK a button?', 'ai', 't1')!;
    const other = recordQuestion(store, 'ru', idB, 'Which screen?', 'ai', 't1')!;
    expect(answerQuestion(store, q.id, 'Yes, the pause menu button', 't2')).toMatchObject({ status: 'answered', answered: 't2' });
    expect(dismissQuestion(store, other.id).status).toBe('dismissed');
    expect(answersByUnit(store).get(idA)).toEqual(['Q: Is BACK a button? A: Yes, the pause menu button']);
    expect(answersByUnit(store).has(idB)).toBe(false);
    expect(markApplied(store, [q.id, 'unknown'])).toBe(1);
    // An applied item stays in the prompt until its answer reaches DevNotes, not from the moment it's applied.
    expect(answersByUnit(store).get(idA)).toEqual(['Q: Is BACK a button? A: Yes, the pause menu button']);
    // DevNotes must hold the exact 'Q: <question> A: <answer>' line the plugin writes, not merely the
    // answer text somewhere in the notes. Matching is whole-line, so the recorded line sits on its
    // own line here — other text on a different line must not stop it from being found.
    store.units.set(idA, { ...store.units.get(idA)!, devNotes: 'From plugin:\nQ: Is BACK a button? A: Yes, the pause menu button' });
    expect(answersByUnit(store).size).toBe(0);
  });

  // A short answer ('Yes') must not count as delivered just because it appears elsewhere in
  // DevNotes; only the exact single-lined, trimmed 'Q: <question> A: <answer>' line counts.
  it('keeps an applied item in the prompt when only its answer text, not the recorded line, appears in DevNotes', () => {
    const q = recordQuestion(store, 'ru', idA, 'Is BACK a button?', 'ai', 't1')!;
    answerQuestion(store, q.id, 'Yes', 't2');
    markApplied(store, [q.id]);
    store.units.set(idA, { ...store.units.get(idA)!, devNotes: 'Translator note: Yes, that reads fine to me.' });
    expect(answersByUnit(store).get(idA)).toEqual(['Q: Is BACK a button? A: Yes']);
    // Whole-line match — the recorded line on its own line is found even with other text present.
    store.units.set(idA, { ...store.units.get(idA)!, devNotes: 'From plugin:\nQ: Is BACK a button? A: Yes' });
    expect(answersByUnit(store).has(idA)).toBe(false);
  });

  // "Q: X A: Verb" must not be considered reached merely because it is a substring of
  // "Q: X A: Verbs" in DevNotes — only a whole matching line counts.
  it('does not treat a shorter answer line as reached when only a longer line containing it as a substring is present', () => {
    const q = recordQuestion(store, 'ru', idA, 'X', 'ai', 't1')!;
    answerQuestion(store, q.id, 'Verb', 't2');
    markApplied(store, [q.id]);
    store.units.set(idA, { ...store.units.get(idA)!, devNotes: 'Q: X A: Verbs' });
    expect(answersByUnit(store).get(idA)).toEqual(['Q: X A: Verb']);
    store.units.set(idA, { ...store.units.get(idA)!, devNotes: 'Q: X A: Verb' });
    expect(answersByUnit(store).has(idA)).toBe(false);
  });

  it('rejects an empty answer and an unknown id', () => {
    const q = recordQuestion(store, 'ru', idA, 'Is BACK a button?', 'ai', 't1')!;
    const statusOf = (fn: () => unknown) => {
      try {
        fn();
        return 0;
      } catch (error) {
        return (error as { statusCode: number }).statusCode;
      }
    };
    expect(statusOf(() => answerQuestion(store, q.id, '  ', 't2'))).toBe(422);
    expect(statusOf(() => answerQuestion(store, 'nope', 'x', 't2'))).toBe(404);
  });
});
