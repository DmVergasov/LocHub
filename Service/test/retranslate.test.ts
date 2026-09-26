import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SnapshotEntry } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { applySnapshot } from '../src/push.js';
import { retranslateWithNote } from '../src/retranslate.js';
import { LocHubStore } from '../src/store.js';
import { FakeLlmClient, ok, requestItems } from './fakeLlm.js';

const entry = (key: string, source: string): SnapshotEntry => ({
  namespace: 'HW', key, source, origin: 'o', devNotes: '', metadata: {}, groupKey: 'Pause',
});

function setup() {
  const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-retr-')));
  applySnapshot(store, { target: 'Game', nativeCulture: 'en', cultures: ['ru'], archives: {}, entries: [entry('A', 'BACK')] });
  const id = unitIdOf('HW', 'A');
  store.putCell({ ...store.getCell('ru', id), text: 'НАЗАД', status: 'ai_draft', basedOnSourceRev: 1, basedOnSource: 'BACK', band: 'Y' });
  return { store, id };
}

const opts = { ...DEFAULT_JOB_OPTIONS, culture: 'ru', mode: 'sync' as const };

describe('retranslateWithNote', () => {
  it('sends the note and stores the answer as a suggestion without touching the text', async () => {
    const { store, id } = setup();
    const llm = new FakeLlmClient((r) =>
      ok(r.customId, { items: requestItems(r).map((i) => ({ id: i.id, translation: 'ВЕРНУТЬСЯ', ambiguity: 'none', alts: [], question: '', terms_used: [] })) }),
    );
    const result = await retranslateWithNote(store, llm, opts, id, 'It is a menu button', true);
    expect(requestItems(llm.calls[0]!)[0]).toMatchObject({ reviewer_note: 'It is a menu button' });
    expect(result.issues).toEqual([]);
    expect(result.cell).toMatchObject({ text: 'НАЗАД', status: 'ai_draft', suggestion: 'ВЕРНУТЬСЯ' });
    expect(store.getCell('ru', id).suggestion).toBe('ВЕРНУТЬСЯ');
    expect(store.style.get('ru')).toContain('- It is a menu button');
  });

  it('reports unknown units, empty notes and refusals with HTTP codes', async () => {
    const { store, id } = setup();
    const refusing = new FakeLlmClient((r) => ({ customId: r.customId, kind: 'refusal' }));
    const statusOf = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 0;
      } catch (error) {
        return (error as { statusCode: number }).statusCode;
      }
    };
    expect(await statusOf(() => retranslateWithNote(store, refusing, opts, 'ffffffffffffffff', 'x', false))).toBe(404);
    expect(await statusOf(() => retranslateWithNote(store, refusing, opts, id, '  ', false))).toBe(422);
    expect(await statusOf(() => retranslateWithNote(store, refusing, opts, id, 'x', false))).toBe(502);
    expect(store.getCell('ru', id).suggestion).toBe('');
  });

  // The 502 must carry the reason so a reviewer can tell a typo'd model id from a billing problem, redacted.
  it('carries the redacted model-call error reason in the 502 message', async () => {
    const { store, id } = setup();
    const erroring = new FakeLlmClient((r) => ({ customId: r.customId, kind: 'error', message: 'OpenAI: 401 Incorrect API key provided: sk-abcdef123456', retryable: false }));
    await expect(retranslateWithNote(store, erroring, opts, id, 'x', false)).rejects.toMatchObject({
      statusCode: 502,
      message: 'The model call failed: OpenAI: 401 Incorrect API key provided: [redacted]',
    });
  });

  it('keeps a human edit made while the model was answering', async () => {
    const { store, id } = setup();
    const llm = new FakeLlmClient((r) => {
      // The reviewer edits the cell in the web app while the request is in flight.
      const cell = store.getCell('ru', id);
      store.putCell({ ...cell, text: 'К МЕНЮ', status: 'approved', revision: cell.revision + 1 });
      return ok(r.customId, { items: requestItems(r).map((i) => ({ id: i.id, translation: 'ВЕРНУТЬСЯ', ambiguity: 'none', alts: [], question: '', terms_used: [] })) });
    });
    const result = await retranslateWithNote(store, llm, opts, id, 'It is a menu button', false);
    expect(store.getCell('ru', id)).toMatchObject({ text: 'К МЕНЮ', status: 'approved', suggestion: 'ВЕРНУТЬСЯ' });
    expect(result.cell).toMatchObject({ text: 'К МЕНЮ', suggestion: 'ВЕРНУТЬСЯ' });
  });

  it('does not append duplicate style rules', async () => {
    const { store, id } = setup();
    const llm = new FakeLlmClient((r) =>
      ok(r.customId, { items: requestItems(r).map((i) => ({ id: i.id, translation: 'ВЕРНУТЬСЯ', ambiguity: 'none', alts: [], question: '', terms_used: [] })) }),
    );
    await retranslateWithNote(store, llm, opts, id, 'It is a menu button', true);
    await retranslateWithNote(store, llm, opts, id, 'It is a menu button', true);
    const lines = store.style.get('ru')!.split('\n').filter((l) => l === '- It is a menu button');
    expect(lines).toHaveLength(1);
  });
});
