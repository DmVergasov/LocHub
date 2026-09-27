import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../src/cache.js';
import { editCell, rejectCell } from '../src/cells.js';
import type { SnapshotEntry } from '../src/contract.js';
import type { CustomEndpointConfig } from '../src/customEndpoint.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS, runTranslateJob, type JobOptions, type JobProgress } from '../src/job.js';
import { LENGTH_CHECK_OFF, type LengthCheckConfig } from '../src/lengthCheck.js';
import type { LlmOutcome, LlmRequest } from '../src/llm.js';
import { answerQuestion, recordQuestion } from '../src/memory.js';
import { OpenAiCompatibleLlmClient } from '../src/openaiCompatible.js';
import { applySnapshot } from '../src/push.js';
import { LocHubStore } from '../src/store.js';
import { isAuditSample } from '../src/triage.js';
import { FakeLlmClient, isJudgeRequest, ok, requestItems } from './fakeLlm.js';

const RU: Record<string, string> = { PAUSED: 'ПАУЗА', BACK: 'НАЗАД', '{Count} bales left': 'Осталось {Count} тюков' };

const entry = (key: string, source: string, kind = 'text'): SnapshotEntry => ({
  namespace: 'HW', key, source, origin: 'o', devNotes: '', metadata: { 'LocHub.Kind': kind }, groupKey: 'Pause',
});

function setup(entries = [entry('A', 'PAUSED'), entry('B', 'BACK'), entry('C', '{Count} bales left')]) {
  const store = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-job-')));
  applySnapshot(store, { target: 'Game', nativeCulture: 'en', cultures: ['ru'], entries, archives: {} });
  const cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-jobcache-')));
  return { store, cache };
}

const options = (overrides: Partial<JobOptions> = {}): JobOptions => ({ ...DEFAULT_JOB_OPTIONS, culture: 'ru', mode: 'sync', pollMs: 1, auditPercent: 0, ...overrides });

// Default behaviour: translate by dictionary, judge finds nothing.
function translateAll(request: LlmRequest, translate = (source: string) => RU[source] ?? source) {
  if (isJudgeRequest(request)) return ok(request.customId, { issues: [] });
  return ok(request.customId, {
    items: requestItems(request).map((i) => ({
      id: i.id, translation: translate(i.source as string), ambiguity: 'none', alts: [], question: '', terms_used: [],
    })),
  });
}

describe('runTranslateJob', () => {
  it('translates everything into green drafts and saves the store', async () => {
    const { store, cache } = setup();
    const report = await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options());
    expect(report).toMatchObject({ requested: 3, written: 3, needsFix: 0, bands: { R: 0, Y: 0, G: 3 } });
    const cell = LocHubStore.load(store.dataDir).getCell('ru', unitIdOf('HW', 'A'));
    expect(cell).toMatchObject({ text: 'ПАУЗА', status: 'ai_draft', band: 'G', provenance: 'ai:claude-opus-5-5+translate-v2', revision: 1 });
  });

  // The brief is service config (JobOptions.brief), not store data: cultureContext takes it from opts, not
  // store.brief (which no longer exists).
  it('carries the brief from JobOptions into the translate request system block', async () => {
    const { store, cache } = setup();
    const llm = new FakeLlmClient((r) => translateAll(r));
    await runTranslateJob(store, llm, cache, options({ brief: 'This is a farming sim.' }));
    const call = llm.calls.find((r) => !isJudgeRequest(r))!;
    const systemText = (call.params.system as { text: string }[]).map((b) => b.text).join('\n');
    expect(systemText).toContain('This is a farming sim.');
  });

  it('retries after malformed JSON and after missing ids without caching the broken answer', async () => {
    const { store, cache } = setup();
    let call = 0;
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      call++;
      if (call === 1) return ok(r.customId, 'not json at all');
      if (call === 2) {
        const [first] = requestItems(r);
        const item = (id: unknown, translation: string) => ({ id, translation, ambiguity: 'none', alts: [], question: '', terms_used: [] });
        return ok(r.customId, { items: [item(first!.id, RU[first!.source as string]!), item(first!.id, 'DUP'), item('unknown', 'x')] });
      }
      return translateAll(r);
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report.written).toBe(3);
    expect(store.getCell('ru', unitIdOf('HW', 'C')).text).toBe('Осталось {Count} тюков');
    for (const key of ['A', 'B', 'C']) expect(store.getCell('ru', unitIdOf('HW', key)).text).not.toBe('DUP');
  });

  // An empty answer (no JSON at all — what the OpenAI-compatible/Gemini adapters return for a blank
  // response) goes through the job's own missing-id retry exactly like a malformed one; it must not surface as
  // an error once a later attempt actually answers.
  it('retries an empty first answer and writes the second, valid one with errors: 0', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    let call = 0;
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      call++;
      return call === 1 ? ok(r.customId, '') : translateAll(r);
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report).toMatchObject({ written: 1, errors: 0 });
    expect(store.getCell('ru', unitIdOf('HW', 'A')).text).toBe('ПАУЗА');
  });

  it('asks the model again for a needs_fix cell instead of replaying the cached answer', async () => {
    const { store, cache } = setup([entry('C', '{Count} bales left')]);
    const broken = new FakeLlmClient((r) => translateAll(r, () => 'Осталось тюков'));
    await runTranslateJob(store, broken, cache, options({ maxRepairRounds: 0 }));
    expect(store.getCell('ru', unitIdOf('HW', 'C')).status).toBe('needs_fix');
    const report = await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options({ maxRepairRounds: 0 }));
    expect(report.written).toBe(1);
    expect(store.getCell('ru', unitIdOf('HW', 'C')).text).toBe('Осталось {Count} тюков');
  });

  it('reuses a confirmed translation of the identical source without calling the model', async () => {
    const { store, cache } = setup([entry('A', 'BACK'), entry('B', 'BACK')]);
    const idA = unitIdOf('HW', 'A');
    store.putCell({ ...store.getCell('ru', idA), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'BACK' });
    const llm = new FakeLlmClient((r) => translateAll(r));
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report).toMatchObject({ requested: 1, tm: 1, written: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(store.getCell('ru', unitIdOf('HW', 'B'))).toMatchObject({ text: 'НАЗАД', status: 'ai_draft', provenance: `tm:${idA}`, band: 'G', qaFlags: ['tm'] });
  });

  it('files model questions into the inbox and sends answered ones with the string', async () => {
    const { store, cache } = setup([entry('B', 'BACK')]);
    const idB = unitIdOf('HW', 'B');
    const asking = new FakeLlmClient((r) =>
      isJudgeRequest(r)
        ? ok(r.customId, { issues: [] })
        : ok(r.customId, { items: requestItems(r).map((i) => ({ id: i.id, translation: 'НАЗАД', ambiguity: 'guessed', alts: ['ВЕРНУТЬСЯ'], question: 'Button or direction?', terms_used: [] })) }),
    );
    expect((await runTranslateJob(store, asking, cache, options())).questions).toBe(1);
    const [question] = [...store.inbox.values()];
    expect(question).toMatchObject({ unitId: idB, culture: 'ru', question: 'Button or direction?', status: 'open', askedBy: 'ai' });

    answerQuestion(store, question!.id, 'A button in the pause menu', 't');
    const again = new FakeLlmClient((r) => translateAll(r));
    await runTranslateJob(store, again, cache, options({ filter: { unitIds: [idB] } }));
    expect(again.calls).toHaveLength(0);
    store.putCell({ ...store.getCell('ru', idB), status: 'rejected', note: 'too literal' });
    await runTranslateJob(store, again, cache, options());
    expect(requestItems(again.calls[0]!)[0]).toMatchObject({ answers: ['Q: Button or direction? A: A button in the pause menu'] });
    expect(recordQuestion(store, 'ru', idB, 'Button or direction?', 'ai', 't')?.status).toBe('answered');
  });

  it('repairs a broken placeholder and marks a still-broken one needs_fix in band R', async () => {
    const { store, cache } = setup([entry('C', '{Count} bales left')]);
    const seen: Record<string, unknown>[] = [];
    const fixing = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      const items = requestItems(r);
      seen.push(...items);
      const repaired = items[0]!.errors !== undefined;
      return translateAll(r, () => (repaired ? 'Осталось {Count} тюков' : 'Осталось тюков'));
    });
    expect((await runTranslateJob(store, fixing, cache, options())).written).toBe(1);
    expect(seen.some((i) => Array.isArray(i.errors) && String(i.errors).includes('Missing arguments: Count'))).toBe(true);

    const other = setup([entry('C', '{Count} bales left')]);
    const stubborn = new FakeLlmClient((r) => translateAll(r, () => 'Осталось тюков'));
    const report = await runTranslateJob(other.store, stubborn, other.cache, options());
    expect(report).toMatchObject({ needsFix: 1, bands: { R: 1 } });
    expect(other.store.getCell('ru', unitIdOf('HW', 'C'))).toMatchObject({ status: 'needs_fix', band: 'R' });
    expect(stubborn.calls.filter((c) => !isJudgeRequest(c))).toHaveLength(3);
  });

  // plural-engine brief: the job's precheck uses the engine's forms from the last Push, so a draft that matches
  // them is not sent to repair or written needs_fix for a form only Node's ICU asks for.
  it('checks drafts against the engine plural forms the last Push sent', async () => {
    const { store, cache } = setup([entry('C', '{Count} bales left')]);
    applySnapshot(store, {
      target: 'Game', nativeCulture: 'en', cultures: ['ru'], entries: [entry('C', '{Count} bales left')], archives: {},
      pluralForms: { ru: { cardinal: ['one', 'other'], ordinal: ['other'] } },
    });
    const llm = new FakeLlmClient((r) => translateAll(r, () => 'Осталось {Count}|plural(one=тюк,other=тюков)'));
    const report = await runTranslateJob(store, llm, cache, options({ maxRepairRounds: 0 }));
    expect(report).toMatchObject({ written: 1, needsFix: 0 });
    expect(store.getCell('ru', unitIdOf('HW', 'C')).status).toBe('ai_draft');
  });

  // Check tiers: 'confirm' issues let a human approve anyway, but an AI draft with one is never written as a
  // plain draft (nothing suspicious ships on its own): needs_fix, band R, same as a hard issue.
  it('writes needs_fix for a draft whose only issue is a confirm one', async () => {
    const { store, cache } = setup([entry('W', 'Welcome to MyGame')]);
    store.glossary.set('ru', [{ term: 'MyGame', translation: '', dnt: true, note: '' }]);
    const llm = new FakeLlmClient((r) => translateAll(r, () => 'Добро пожаловать в Трудягу'));
    const report = await runTranslateJob(store, llm, cache, options({ maxRepairRounds: 0 }));
    expect(report).toMatchObject({ written: 0, needsFix: 1, bands: { R: 1 } });
    expect(store.getCell('ru', unitIdOf('HW', 'W'))).toMatchObject({ status: 'needs_fix', band: 'R', qaFlags: ['dnt'] });
  });

  it('splits a refused group and marks a single refused string R', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED'), entry('B', 'BACK')]);
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      const items = requestItems(r);
      if (items.length > 1 || items[0]!.source === 'BACK') return { customId: r.customId, kind: 'refusal' };
      return translateAll(r);
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report).toMatchObject({ written: 1, refused: 1 });
    expect(store.getCell('ru', unitIdOf('HW', 'B'))).toMatchObject({ band: 'R', qaFlags: ['refused'], status: 'needs_fix' });
  });

  it('bands by judge severity and by guessed UI strings', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED'), entry('B', 'BACK', 'ui'), entry('C', '{Count} bales left')]);
    const idA = unitIdOf('HW', 'A');
    const idC = unitIdOf('HW', 'C');
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r))
        return ok(r.customId, {
          issues: [
            { id: idA, severity: 'major', category: 'accuracy', why: 'w', fix: 'f' },
            { id: idC, severity: 'minor', category: 'style', why: 'w', fix: 'f' },
          ],
        });
      return ok(r.customId, {
        items: requestItems(r).map((i) => ({ id: i.id, translation: RU[i.source as string], ambiguity: i.source === 'BACK' ? 'guessed' : 'none', alts: [], question: '', terms_used: [] })),
      });
    });
    await runTranslateJob(store, llm, cache, options());
    expect(store.getCell('ru', idA).band).toBe('R');
    expect(store.getCell('ru', unitIdOf('HW', 'B')).band).toBe('R');
    expect(store.getCell('ru', idC).band).toBe('Y');
  });

  // A suggestion set on a cell before the job runs (for example by retranslate, which does not bump the
  // revision) must not be wiped by the job's own successful write.
  it('keeps a suggestion set before the job runs', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    store.putCell({ ...store.getCell('ru', idA), suggestion: 'Existing suggestion' });
    const report = await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options());
    expect(report.written).toBe(1);
    expect(store.getCell('ru', idA)).toMatchObject({ text: 'ПАУЗА', suggestion: 'Existing suggestion' });
  });

  // The blind-audit flag must survive a rework even when the new band is not G, so the summary keeps
  // counting the cell in its sample.
  it('keeps the audit flag when a job rewrites an audited cell into a lower band', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options({ auditPercent: 100 }));
    expect(store.getCell('ru', idA)).toMatchObject({ band: 'G', qaFlags: ['audit'] });

    rejectCell(store, 'ru', idA, '', 'me');
    const majorIssue = new FakeLlmClient((r) =>
      isJudgeRequest(r)
        ? ok(r.customId, { issues: [{ id: idA, severity: 'major', category: 'accuracy', why: 'w', fix: 'f' }] })
        : translateAll(r),
    );
    // A fresh cache: the rework produces the identical translation, so the first job's cached judge answer
    // ({ issues: [] }) would otherwise mask the major issue this test needs — unrelated to the audit-flag check.
    const cache2 = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-jobcache-')));
    await runTranslateJob(store, majorIssue, cache2, options({ auditPercent: 0 }));
    const cell = store.getCell('ru', idA);
    expect(cell.band).toBe('R');
    expect(cell.qaFlags).toContain('audit');
  });

  // A TM donor that breaks a placeholder (for example imported from the archive) must not be copied; the
  // string goes to the model instead.
  it('does not reuse a TM donor that fails the precheck', async () => {
    const { store, cache } = setup([entry('A', '{Count} bales left'), entry('B', '{Count} bales left')]);
    const idA = unitIdOf('HW', 'A');
    const idB = unitIdOf('HW', 'B');
    store.putCell({ ...store.getCell('ru', idA), text: 'Осталось тюков', status: 'human_edit', basedOnSourceRev: 1, basedOnSource: '{Count} bales left' });
    const llm = new FakeLlmClient((r) => translateAll(r));
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report.tm).toBe(0);
    expect(llm.calls.filter((c) => !isJudgeRequest(c))).toHaveLength(1);
    expect(store.getCell('ru', idB).text).toBe('Осталось {Count} тюков');
  });

  it('keeps a human edit made during the job and stores the AI text as a suggestion', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    const llm = new FakeLlmClient((r) => {
      if (!isJudgeRequest(r) && store.getCell('ru', idA).status === 'empty') editCell(store, 'ru', idA, 'ПАУЗА (вручную)', 'me');
      return translateAll(r);
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report.suggestions).toBe(1);
    expect(store.getCell('ru', idA)).toMatchObject({ text: 'ПАУЗА (вручную)', status: 'edited', suggestion: 'ПАУЗА' });
  });

  it('flags audit samples among green strings deterministically', async () => {
    const { store, cache } = setup();
    await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options({ auditPercent: 100 }));
    expect(store.getCell('ru', unitIdOf('HW', 'A')).qaFlags).toContain('audit');
    expect(isAuditSample('u1', 'ru', 4)).toBe(isAuditSample('u1', 'ru', 4));
    expect(isAuditSample('u1', 'ru', 0)).toBe(false);
  });

  it('does nothing when there is no work', async () => {
    const { store, cache } = setup([]);
    const llm = new FakeLlmClient((r) => translateAll(r));
    expect((await runTranslateJob(store, llm, cache, options())).requested).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  // Splitting a refusing group must not eat the fixed retry budget; the culprit string is isolated and
  // marked refused, the 15 innocent strings sharing its group are written.
  it('isolates a single refusing string in a large default group instead of erroring the whole tail', async () => {
    const keys = Array.from({ length: 16 }, (_, i) => String.fromCharCode(65 + i));
    const culpritKey = 'H';
    const entries = keys.map((k) => entry(k, k === culpritKey ? 'CULPRIT' : `Source ${k}`));
    const { store, cache } = setup(entries);
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      const items = requestItems(r);
      if (items.some((i) => i.source === 'CULPRIT')) return { customId: r.customId, kind: 'refusal' };
      return ok(r.customId, {
        items: items.map((i) => ({ id: i.id, translation: `T:${i.source}`, ambiguity: 'none', alts: [], question: '', terms_used: [] })),
      });
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report.refused).toBe(1);
    expect(report.written).toBe(15);
    const culpritCell = store.getCell('ru', unitIdOf('HW', culpritKey));
    expect(culpritCell).toMatchObject({ status: 'needs_fix', band: 'R' });
    expect(culpritCell.qaFlags).toContain('refused');
  });

  // A rejected cell's request must carry rejected_translation so it never replays the rejected answer.
  it('sends a rejected cell back to the model instead of replaying its own rejected answer', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r, () => 'Вариант 1')), cache, options());
    expect(store.getCell('ru', idA).text).toBe('Вариант 1');
    rejectCell(store, 'ru', idA, '', 'me');
    const retry = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      return ok(r.customId, {
        items: requestItems(r).map((i) => ({
          id: i.id, translation: i.rejected_translation ? 'Вариант 2' : 'Вариант 1', ambiguity: 'none', alts: [], question: '', terms_used: [],
        })),
      });
    });
    await runTranslateJob(store, retry, cache, options());
    expect(retry.calls.filter((c) => !isJudgeRequest(c))).toHaveLength(1);
    expect(store.getCell('ru', idA).text).toBe('Вариант 2');
  });

  // A refusal of a cell that carries the audit flag must log ai_refused, bump revision, keep the audit flag.
  it('logs a refusal event and bumps revision for a cell that carries the audit flag', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options({ auditPercent: 100 }));
    const drafted = store.getCell('ru', idA);
    expect(drafted.qaFlags).toContain('audit');
    store.putCell({ ...drafted, status: 'needs_fix' });
    const refusing = new FakeLlmClient((r) => (isJudgeRequest(r) ? ok(r.customId, { issues: [] }) : { customId: r.customId, kind: 'refusal' }));
    await runTranslateJob(store, refusing, cache, options());
    const cell = store.getCell('ru', idA);
    expect(cell.qaFlags.slice().sort()).toEqual(['audit', 'refused']);
    expect(cell.band).toBe('R');
    expect(cell.revision).toBe(drafted.revision + 1);
    expect(store.readEvents('ru', idA).at(-1)).toMatchObject({ action: 'ai_refused', before: 'ПАУЗА', after: 'ПАУЗА' });
  });

  // A misconfigured provider (bad model id, bad key, no credit) must not silently become "done, N errors" with
  // the reason nowhere to be found. When every request of the first round is a hard, non-retryable error, the
  // whole job aborts before writing any cell.
  it('ends the job failed when every request of the first round is a non-retryable error, leaving cells untouched', async () => {
    const { store, cache } = setup();
    const llm = new FakeLlmClient((r) =>
      isJudgeRequest(r) ? ok(r.customId, { issues: [] }) : { customId: r.customId, kind: 'error', message: 'OpenAI: 404 The model `gpt-6-sool` does not exist', retryable: false },
    );
    await expect(runTranslateJob(store, llm, cache, options())).rejects.toThrow(/The model `gpt-6-sool` does not exist/);
    expect(store.getCell('ru', unitIdOf('HW', 'A')).status).toBe('empty');
  });

  // The first-round abort message must never carry a raw secret through to the job record / HTTP error.
  it('redacts a secret-shaped token in the first-round abort message', async () => {
    const { store, cache } = setup();
    const llm = new FakeLlmClient((r) =>
      isJudgeRequest(r) ? ok(r.customId, { issues: [] }) : { customId: r.customId, kind: 'error', message: 'OpenAI: 401 Incorrect API key provided: sk-abcdef123456', retryable: false },
    );
    let error: unknown;
    try {
      await runTranslateJob(store, llm, cache, options());
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('sk-abcdef123456');
  });

  // TM reuse is saved before the translate round even starts, so a first-round abort for the rest of
  // the scope must not undo it — the abort only guards against writing needs_fix/llm_error cells for work the
  // model never actually did.
  it('keeps a TM hit written even though the job then aborts on a first-round hard failure for the rest', async () => {
    const { store, cache } = setup([entry('A', 'BACK'), entry('B', 'BACK'), entry('C', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    const idB = unitIdOf('HW', 'B');
    store.putCell({ ...store.getCell('ru', idA), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'BACK' });
    const llm = new FakeLlmClient((r) =>
      isJudgeRequest(r) ? ok(r.customId, { issues: [] }) : { customId: r.customId, kind: 'error', message: 'OpenAI: 404 The model `gpt-6-sool` does not exist', retryable: false },
    );
    await expect(runTranslateJob(store, llm, cache, options())).rejects.toThrow(/does not exist/);
    expect(store.getCell('ru', idB)).toMatchObject({ text: 'НАЗАД', provenance: `tm:${idA}`, status: 'ai_draft' });
  });

  // A mix of a succeeding group and a hard-failing one must not abort the job — only a round where every
  // request fails aborts it. The failing group's message reaches JobReport.errorSamples, redacted.
  it('finishes done and records a redacted error sample when only some groups hit a final error', async () => {
    const entries = [
      { namespace: 'HW', key: 'A', source: 'PAUSED', origin: 'o', devNotes: '', metadata: {}, groupKey: 'G1' },
      { namespace: 'HW', key: 'B', source: 'BACK', origin: 'o', devNotes: '', metadata: {}, groupKey: 'G2' },
    ];
    const { store, cache } = setup(entries);
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      const items = requestItems(r);
      if (items[0]!.source === 'BACK') return { customId: r.customId, kind: 'error', message: 'OpenAI: 401 Incorrect API key provided: sk-abcdef123456', retryable: false };
      return translateAll(r);
    });
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report).toMatchObject({ written: 1, errors: 1 });
    expect(report.errorSamples).toEqual(['OpenAI: 401 Incorrect API key provided: [redacted]']);
    expect(store.getCell('ru', unitIdOf('HW', 'B'))).toMatchObject({ status: 'needs_fix', band: 'R', qaFlags: ['llm_error'] });
  });

  // A unit's stored error reason must track its own group's *latest* outcome: a retryable error from an early
  // round must not survive in errorSamples once a later round answers ok but still leaves that unit out.
  it('replaces a stale retryable-error reason with "no translation" once a later answer still leaves the string out', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED'), entry('B', 'BACK')]);
    const idB = unitIdOf('HW', 'B');
    let call = 0;
    const llm = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      call++;
      if (call === 1) return { customId: r.customId, kind: 'error', message: '503 Server is overloaded', retryable: true };
      // From the second attempt on, answer every id asked for except B — B is never in the returned items.
      const items = requestItems(r).filter((i) => i.id !== idB);
      return ok(r.customId, {
        items: items.map((i) => ({ id: i.id, translation: RU[i.source as string], ambiguity: 'none', alts: [], question: '', terms_used: [] })),
      });
    });
    const report = await runTranslateJob(store, llm, cache, options({ groupSize: 2 }));
    expect(report.errors).toBe(1);
    expect(report.errorSamples).toEqual(['The model returned no translation for this string.']);
    expect(store.getCell('ru', unitIdOf('HW', 'A')).text).toBe('ПАУЗА');
  });

  // A judge failure must not vanish silently: it must not inflate `errors` (the translation itself may be
  // fine), but it must still leave a reason a reviewer can act on.
  it('records a redacted judge failure reason in errorSamples, without counting it toward errors', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    const llm = new FakeLlmClient((r) =>
      isJudgeRequest(r)
        ? { customId: r.customId, kind: 'error', message: 'OpenAI: 404 The model `gpt-6-sool` does not exist', retryable: false }
        : translateAll(r),
    );
    const report = await runTranslateJob(store, llm, cache, options());
    expect(report).toMatchObject({ written: 1, errors: 0 });
    expect(report.errorSamples).toEqual(['Judge: OpenAI: 404 The model `gpt-6-sool` does not exist']);
    expect(store.getCell('ru', idA).qaFlags).toContain('judge_failed');
  });

  // A human edit racing a refusal must keep the human text untouched, with no event and no revision bump.
  it('keeps a human edit made during a job that ends in refusal', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    const refusing = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      if (store.getCell('ru', idA).status === 'empty') editCell(store, 'ru', idA, 'ПАУЗА (вручную)', 'me');
      return { customId: r.customId, kind: 'refusal' };
    });
    const report = await runTranslateJob(store, refusing, cache, options());
    expect(report.refused).toBe(1);
    const cell = store.getCell('ru', idA);
    // band 'G': editCell now re-bands from its own fresh check (M-7-web) instead of leaving the cell's
    // never-touched '' band in place.
    expect(cell).toMatchObject({ text: 'ПАУЗА (вручную)', status: 'edited', band: 'G', qaFlags: [], revision: 1 });
    expect(store.readEvents('ru', idA)).toHaveLength(1);
  });
});

// Job progress (JobProgress: phase, done, total — units are strings).
describe('runTranslateJob progress', () => {
  it(
    'reports translate progress rising within a round (concurrency 1), non-decreasing, ending at done === total; ' +
      'a refused/split group is not counted until it settles; phases appear in order (translate, judge, write)',
    async () => {
      const entries = [entry('A', 'PAUSED'), entry('B', 'BACK'), entry('C', 'UNIQUE_C'), entry('D', 'UNIQUE_D')];
      const { store, cache } = setup(entries);
      let cdAttempts = 0;
      const llm = new FakeLlmClient((r) => {
        if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
        const sources = requestItems(r).map((i) => i.source);
        // The [C, D] group refuses exactly once, forcing a split; C and D only settle once retried singly.
        if (sources.includes('UNIQUE_C') && sources.includes('UNIQUE_D') && cdAttempts++ === 0) {
          return { customId: r.customId, kind: 'refusal' };
        }
        return translateAll(r, (s) => (s === 'UNIQUE_C' ? 'C translated' : s === 'UNIQUE_D' ? 'D translated' : (RU[s] ?? s)));
      });
      const events: JobProgress[] = [];
      const report = await runTranslateJob(store, llm, cache, options({ groupSize: 2, concurrency: 1, onProgress: (p) => events.push({ ...p }) }));
      expect(report.written).toBe(4);

      const translateEvents = events.filter((e) => e.phase === 'translate');
      // Non-decreasing and within bounds throughout.
      for (let i = 1; i < translateEvents.length; i++) expect(translateEvents[i]!.done).toBeGreaterThanOrEqual(translateEvents[i - 1]!.done);
      for (const e of translateEvents) expect(e.done).toBeLessThanOrEqual(e.total);
      // Rises more than once inside the round: A/B settle (done=2) before the refused C/D pair is retried.
      expect(new Set(translateEvents.map((e) => e.done)).size).toBeGreaterThan(1);
      expect(translateEvents.some((e) => e.done === 2)).toBe(true);
      expect(translateEvents.at(-1)).toMatchObject({ done: 4, total: 4 });

      // Phases ran in the required relative order; repair did not run (nothing broken).
      const phases = events.map((e) => e.phase);
      expect(phases).not.toContain('repair');
      expect(phases.indexOf('translate')).toBeLessThan(phases.indexOf('judge'));
      expect(phases.indexOf('judge')).toBeLessThan(phases.indexOf('write'));

      const writeEvents = events.filter((e) => e.phase === 'write');
      expect(writeEvents[0]).toMatchObject({ done: 0, total: 4 });
      expect(writeEvents.at(-1)).toMatchObject({ done: 4, total: 4 });
    },
  );

  it('counts a cached translate answer immediately, without calling the model', async () => {
    const entries = [entry('A', 'PAUSED'), entry('B', 'BACK')];
    const { store: firstStore, cache } = setup(entries);
    await runTranslateJob(firstStore, new FakeLlmClient((r) => translateAll(r)), cache, options());

    // A second, independent store with the identical entries: the same requests hash to the same cache keys.
    const secondStore = LocHubStore.load(mkdtempSync(join(tmpdir(), 'lochub-job-')));
    applySnapshot(secondStore, { target: 'Game', nativeCulture: 'en', cultures: ['ru'], entries, archives: {} });
    const throwing = new FakeLlmClient(() => {
      throw new Error('must not call the model: every request should be a cache hit');
    });
    const events: JobProgress[] = [];
    const report = await runTranslateJob(secondStore, throwing, cache, options({ onProgress: (p) => events.push({ ...p }) }));
    expect(report.written).toBe(2);
    expect(throwing.calls).toHaveLength(0);
    expect(events.filter((e) => e.phase === 'translate').at(-1)).toMatchObject({ done: 2, total: 2 });
  });

  it('batch mode: a fake batch client reporting finished/total request counts drives translate progress', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED'), entry('B', 'BACK')]);
    class FakeBatchLlm extends FakeLlmClient {
      async runBatch(requests: LlmRequest[], _pollMs: number, onProgress?: (finished: number, total: number) => void): Promise<LlmOutcome[]> {
        onProgress?.(0, requests.length);
        onProgress?.(1, requests.length);
        onProgress?.(requests.length, requests.length);
        return this.runSync(requests, requests.length);
      }
    }
    const llm = new FakeBatchLlm((r) => translateAll(r));
    const events: JobProgress[] = [];
    const report = await runTranslateJob(store, llm, cache, options({ mode: 'batch', onProgress: (p) => events.push({ ...p }) }));
    expect(report.written).toBe(2);
    const translateEvents = events.filter((e) => e.phase === 'translate');
    expect(translateEvents.length).toBeGreaterThan(1);
    for (let i = 1; i < translateEvents.length; i++) expect(translateEvents[i]!.done).toBeGreaterThanOrEqual(translateEvents[i - 1]!.done);
    expect(translateEvents.at(-1)).toMatchObject({ done: 2, total: 2 });
  });

  it(
    'batch mode: a refused multi-item group settles nothing even though the batch reports every request ' +
      'finished, so translate.done stays below total until the retry round actually settles it',
    async () => {
      const entries = [entry('A', 'PAUSED'), entry('B', 'BACK'), entry('C', 'UNIQUE_C'), entry('D', 'UNIQUE_D')];
      const { store, cache } = setup(entries);
      let cdAttempts = 0;
      const respond = (r: LlmRequest): LlmOutcome => {
        if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
        const sources = requestItems(r).map((i) => i.source);
        // The [C, D] group refuses exactly once, forcing a split; C and D only settle once retried singly.
        if (sources.includes('UNIQUE_C') && sources.includes('UNIQUE_D') && cdAttempts++ === 0) {
          return { customId: r.customId, kind: 'refusal' };
        }
        return translateAll(r, (s) => (s === 'UNIQUE_C' ? 'C translated' : s === 'UNIQUE_D' ? 'D translated' : (RU[s] ?? s)));
      };
      class FakeBatchLlm extends FakeLlmClient {
        async runBatch(requests: LlmRequest[], _pollMs: number, onProgress?: (finished: number, total: number) => void): Promise<LlmOutcome[]> {
          // Mirrors the real Anthropic client's request_counts polling: every request in the round has
          // reached a terminal state (the refused group included) before its actual outcome is collected.
          onProgress?.(requests.length, requests.length);
          return this.runSync(requests, requests.length);
        }
      }
      const llm = new FakeBatchLlm(respond);
      const events: JobProgress[] = [];
      const report = await runTranslateJob(store, llm, cache, options({ mode: 'batch', groupSize: 2, onProgress: (p) => events.push({ ...p }) }));
      expect(report.written).toBe(4);

      const translateEvents = events.filter((e) => e.phase === 'translate');
      for (let i = 1; i < translateEvents.length; i++) expect(translateEvents[i]!.done).toBeGreaterThanOrEqual(translateEvents[i - 1]!.done);
      // The estimate alone (round 1's batch progress, before the refused CD group is actually processed and
      // split) must never claim the whole job done: only the very last event may reach the total.
      expect(translateEvents.slice(0, -1).every((e) => e.done < e.total)).toBe(true);
      expect(translateEvents.at(-1)).toMatchObject({ done: 4, total: 4 });
    },
  );

  it('repair progress: total is scoped to the round, done rises per repaired answer, ends at done === total', async () => {
    const { store, cache } = setup([entry('C', '{Count} bales left')]);
    const fixing = new FakeLlmClient((r) => {
      if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
      const repaired = requestItems(r)[0]!.errors !== undefined;
      return translateAll(r, () => (repaired ? 'Осталось {Count} тюков' : 'Осталось тюков'));
    });
    const events: JobProgress[] = [];
    const report = await runTranslateJob(store, fixing, cache, options({ onProgress: (p) => events.push({ ...p }) }));
    expect(report.written).toBe(1);
    const repairEvents = events.filter((e) => e.phase === 'repair');
    expect(repairEvents[0]).toMatchObject({ done: 0, total: 1 });
    expect(repairEvents.at(-1)).toMatchObject({ done: 1, total: 1 });
  });
});

describe('runTranslateJob: Length Check on translation-memory reuse', () => {
  // BACK has 4 visible characters: a 'ui' unit gets ceil(4 x 1.3) + 4 = 10; the donor text has 15.
  const LONG_DONOR = 'ВЕРНУТЬСЯ НАЗАД';

  function withLongDonor() {
    const { store, cache } = setup([entry('A', 'BACK', 'ui'), entry('B', 'BACK', 'ui')]);
    const idA = unitIdOf('HW', 'A');
    store.putCell({ ...store.getCell('ru', idA), text: LONG_DONOR, status: 'approved', basedOnSourceRev: 1, basedOnSource: 'BACK' });
    return { store, cache };
  }

  it('does not reuse a donor over the limit under Must Confirm: the string goes to the model', async () => {
    const { store, cache } = withLongDonor();
    const llm = new FakeLlmClient((r) => translateAll(r));
    const lengthCheck: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'confirm' };
    const report = await runTranslateJob(store, llm, cache, options({ lengthCheck }));
    expect(report.tm).toBe(0);
    expect(store.getCell('ru', unitIdOf('HW', 'B')).text).toBe('НАЗАД');
  });

  it('still reuses it under Warning (a hint never blocks reuse), landing in band Y with too_long in its flags', async () => {
    const { store, cache } = withLongDonor();
    const report = await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r)), cache, options({ lengthCheck: { ...LENGTH_CHECK_OFF, mode: 'warning' } }));
    expect(report).toMatchObject({ tm: 1, bands: { Y: 1, G: 0 } });
    expect(store.getCell('ru', unitIdOf('HW', 'B'))).toMatchObject({ text: LONG_DONOR, status: 'ai_draft', band: 'Y', qaFlags: ['tm', 'too_long'] });
  });
});

describe('runTranslateJob: Length Check repair and prompt', () => {
  // PAUSED has 6 visible characters: a 'ui' unit gets ceil(6 x 1.3) + 4 = 12.
  const TOO_LONG_RU = 'ПРИОСТАНОВЛЕНО НАДОЛГО'; // 22 visible characters
  const WARNING: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'warning' };
  const CONFIRM: LengthCheckConfig = { ...LENGTH_CHECK_OFF, mode: 'confirm' };
  const translateCalls = (llm: FakeLlmClient) => llm.calls.filter((c) => !isJudgeRequest(c));

  it('sends a soft too_long back for one repair and writes what stays too long as a Y draft', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED', 'ui')]);
    const llm = new FakeLlmClient((r) => translateAll(r, () => TOO_LONG_RU));
    const report = await runTranslateJob(store, llm, cache, options({ lengthCheck: WARNING }));
    expect(translateCalls(llm)).toHaveLength(2);
    expect(requestItems(translateCalls(llm)[1]!)[0]!.errors).toEqual([
      'Too long for the UI: 22/12 characters (Length Check in Project Settings). Shorten it while keeping the meaning, every placeholder and every tag.',
    ]);
    expect(report).toMatchObject({ written: 1, needsFix: 0, bands: { Y: 1 } });
    expect(store.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ status: 'ai_draft', band: 'Y', qaFlags: ['too_long'] });
  });

  // I-3 (amendment 2): a repair round must never turn a good draft into a worse one. Round 0's draft only has
  // the soft too_long issue (it kept {Count}); the one repair round this job gets drops {Count}, which is a
  // blocking (confirm) issue. With no round left to try again, the pre-repair text must survive with its band Y.
  it('restores the pre-repair text when the only repair round drops a placeholder', async () => {
    const { store, cache } = setup([entry('C', '{Count} bales left', 'ui')]);
    const TOO_LONG_WITH_COUNT = 'ОЧЕНЬ МНОГО ТЮКОВ СЕНА ОСТАЛОСЬ ВСЕГО {Count}';
    const MISSING_COUNT = 'Осталось тюков сена';
    const llm = new FakeLlmClient((r) => translateAll(r, () => (requestItems(r)[0]!.errors !== undefined ? MISSING_COUNT : TOO_LONG_WITH_COUNT)));
    const report = await runTranslateJob(store, llm, cache, options({ lengthCheck: WARNING, maxRepairRounds: 1 }));
    expect(translateCalls(llm)).toHaveLength(2);
    expect(report).toMatchObject({ written: 1, needsFix: 0, bands: { Y: 1 } });
    expect(store.getCell('ru', unitIdOf('HW', 'C'))).toMatchObject({ text: TOO_LONG_WITH_COUNT, status: 'ai_draft', band: 'Y', qaFlags: ['too_long'] });
  });

  it('writes the shorter wording the repair returns as a clean draft', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED', 'ui')]);
    const llm = new FakeLlmClient((r) => translateAll(r, () => (requestItems(r)[0]!.errors !== undefined ? 'ПАУЗА' : TOO_LONG_RU)));
    const report = await runTranslateJob(store, llm, cache, options({ lengthCheck: WARNING }));
    expect(report).toMatchObject({ written: 1, bands: { G: 1 } });
    expect(store.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ text: 'ПАУЗА', status: 'ai_draft', band: 'G', qaFlags: [] });
  });

  it('under Must Confirm repairs in every round and writes what stays too long needs_fix in band R', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED', 'ui')]);
    const llm = new FakeLlmClient((r) => translateAll(r, () => TOO_LONG_RU));
    const report = await runTranslateJob(store, llm, cache, options({ lengthCheck: CONFIRM }));
    expect(translateCalls(llm)).toHaveLength(3);
    expect(report).toMatchObject({ written: 0, needsFix: 1, bands: { R: 1 } });
    expect(store.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ status: 'needs_fix', band: 'R', qaFlags: ['too_long'] });
  });

  it('under Must Confirm the needs_fix string goes back to the model on the next job', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED', 'ui')]);
    await runTranslateJob(store, new FakeLlmClient((r) => translateAll(r, () => TOO_LONG_RU)), cache, options({ lengthCheck: CONFIRM }));
    expect(store.getCell('ru', unitIdOf('HW', 'A')).status).toBe('needs_fix');
    const next = new FakeLlmClient((r) => translateAll(r));
    const report = await runTranslateJob(store, next, cache, options({ lengthCheck: CONFIRM }));
    expect(translateCalls(next)).toHaveLength(1);
    expect(report.written).toBe(1);
    expect(store.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ text: 'ПАУЗА', status: 'ai_draft', band: 'G' });
  });

  it('leaves a non-UI string alone under the UI scope', async () => {
    const { store, cache } = setup([entry('A', 'PAUSED', 'text')]);
    const llm = new FakeLlmClient((r) => translateAll(r, () => TOO_LONG_RU));
    await runTranslateJob(store, llm, cache, options({ lengthCheck: WARNING }));
    expect(translateCalls(llm)).toHaveLength(1);
    expect(store.getCell('ru', unitIdOf('HW', 'A'))).toMatchObject({ status: 'ai_draft', band: 'G', qaFlags: [] });
  });

  it('sends maxLength for each item with a limit, only while Tell the Translator is on', async () => {
    const idA = unitIdOf('HW', 'A');
    const idB = unitIdOf('HW', 'B');
    const firstRequestLimits = async (lengthCheck: LengthCheckConfig) => {
      const { store, cache } = setup([entry('A', 'PAUSED', 'ui'), entry('B', 'BACK', 'text')]);
      const llm = new FakeLlmClient((r) => translateAll(r));
      await runTranslateJob(store, llm, cache, options({ lengthCheck }));
      return Object.fromEntries(requestItems(translateCalls(llm)[0]!).map((i) => [i.id as string, i.maxLength]));
    };
    expect(await firstRequestLimits(WARNING)).toEqual({ [idA]: 12, [idB]: undefined });
    expect(await firstRequestLimits({ ...WARNING, hint: false })).toEqual({ [idA]: undefined, [idB]: undefined });
    // An older plugin passes no --length-* flags: nothing changes in the request.
    expect(await firstRequestLimits(LENGTH_CHECK_OFF)).toEqual({ [idA]: undefined, [idB]: undefined });
  });
});

// I-1 + amendments 8/9: a request that times out is split like a max_tokens truncation, never resent whole, and an
// endpoint that has answered nothing in the job yet is probed -- the two halves of one timed-out group per round --
// instead of being flooded with every group of the job.
describe('runTranslateJob: timeouts and probe mode (I-1, amendment 9)', () => {
  const TIMEOUT_MESSAGE = 'Custom: the request timed out after 90 seconds';
  const timeout = (r: LlmRequest): LlmOutcome => ({ customId: r.customId, kind: 'error', message: TIMEOUT_MESSAGE, retryable: true });
  const lines = (count: number) => Array.from({ length: count }, (_, i) => entry(`K${i}`, `Line ${i}`));
  const toRu = (source: string) => source.replace('Line', 'Строка');
  // An endpoint that answers a group of up to `answersUpTo` strings and times out on anything larger.
  const bySize = (answersUpTo: number) => (r: LlmRequest): LlmOutcome =>
    isJudgeRequest(r) ? ok(r.customId, { issues: [] }) : requestItems(r).length <= answersUpTo ? translateAll(r, toRu) : timeout(r);
  const translateSizes = (llm: FakeLlmClient) => llm.calls.filter((c) => !isJudgeRequest(c)).map((c) => requestItems(c).length);

  it('stops an always-timing-out job after 1 + ceil(log2 groupSize) waves, never sending round 0\'s unstarted requests', async () => {
    const { store, cache } = setup(lines(120));
    const llm = new FakeLlmClient(bySize(0), { pool: true });
    await expect(runTranslateJob(store, llm, cache, options({ concurrency: 2 }))).rejects.toThrow(TIMEOUT_MESSAGE);
    // Three groups of 40 at concurrency 2: round 0 starts two; the first timeout (nothing answered yet) holds the
    // third, which is never sent. Then each wave sends only the two halves of the largest group that timed out:
    // 40 -> 20 -> 10 -> 5 -> 3 -> 2 -> 1, i.e. 7 = 1 + ceil(log2 40) waves, 14 requests, and a single string that
    // times out stops the job. (Before probe mode: 3 x (2 x 40 - 1) = 237 timeouts, then every string failed.)
    expect(translateSizes(llm)).toEqual([40, 40, 20, 20, 10, 10, 5, 5, 3, 2, 2, 1, 1, 1]);
    expect(llm.returned.filter((o) => o.kind === 'skipped')).toHaveLength(1);
    // The job failed before writing any cell.
    expect(store.getCell('ru', unitIdOf('HW', 'K0')).status).toBe('empty');
  });

  it('stops on a single string that times out before any answer, keeping the TM reuse already written', async () => {
    const { store, cache } = setup([entry('A', 'BACK'), entry('B', 'BACK'), entry('C', 'PAUSED')]);
    const idA = unitIdOf('HW', 'A');
    store.putCell({ ...store.getCell('ru', idA), text: 'НАЗАД', status: 'approved', basedOnSourceRev: 1, basedOnSource: 'BACK' });
    const llm = new FakeLlmClient(bySize(0), { pool: true });
    await expect(runTranslateJob(store, llm, cache, options())).rejects.toThrow(TIMEOUT_MESSAGE);
    expect(translateSizes(llm)).toEqual([1]);
    expect(store.getCell('ru', unitIdOf('HW', 'B'))).toMatchObject({ text: 'НАЗАД', provenance: `tm:${idA}`, status: 'ai_draft' });
    expect(store.getCell('ru', unitIdOf('HW', 'C')).status).toBe('empty');
  });

  it('finishes every string on an endpoint that answers 10 strings but not 40, never sending more than 10 after its first answer', async () => {
    const { store, cache } = setup(lines(120));
    const llm = new FakeLlmClient(bySize(10), { pool: true });
    const report = await runTranslateJob(store, llm, cache, options({ concurrency: 2 }));
    expect(report).toMatchObject({ requested: 120, written: 120, errors: 0 });
    const sizes = translateSizes(llm);
    // 40, 40 (the third group held) -> 20, 20 -> 10, 10 answered; then the held 40 + 40 and the waiting 20 go out in
    // pieces of the size that was answered: 4 + 4 + 2 requests of 10.
    expect(sizes).toEqual([40, 40, 20, 20, 10, 10, ...Array<number>(10).fill(10)]);
    expect(Math.max(...sizes.slice(sizes.indexOf(10)))).toBe(10);
    for (const i of [0, 57, 119]) expect(store.getCell('ru', unitIdOf('HW', `K${i}`)).text).toBe(`Строка ${i}`);
  });

  it('leaves a healthy endpoint\'s call pattern unchanged: nothing skipped, a timeout after an answer is only split', async () => {
    // Four groups of 40 at concurrency 2. The second request times out and the third fails with a transient 500,
    // both after the first answer landed; the fourth starts only once the timeout has landed, so it would be the one
    // held if a timeout after an answer ever stalled the round.
    const script = () => {
      let translateCall = 0;
      return (r: LlmRequest): LlmOutcome => {
        if (isJudgeRequest(r)) return ok(r.customId, { issues: [] });
        const call = translateCall++;
        if (call === 1) return timeout(r);
        if (call === 2) return { customId: r.customId, kind: 'error', message: 'Custom: 500 overloaded', retryable: true };
        return translateAll(r, toRu);
      };
    };
    const pooled = new FakeLlmClient(script(), { pool: true });
    const pooledSetup = setup(lines(160));
    const report = await runTranslateJob(pooledSetup.store, pooled, pooledSetup.cache, options({ concurrency: 2 }));
    expect(report).toMatchObject({ written: 160, errors: 0 });
    // Today's rules: all four groups go out in round 0 (an answer had landed before the timeout), then the timed-out
    // group is split in two and the 500 is resent whole.
    expect(translateSizes(pooled)).toEqual([40, 40, 40, 40, 20, 20, 40]);
    expect(pooled.returned.some((o) => o.kind === 'skipped')).toBe(false);
    // The same job on a client that ignores shouldContinue sends exactly the same requests.
    const plain = new FakeLlmClient(script());
    const plainSetup = setup(lines(160));
    await runTranslateJob(plainSetup.store, plain, plainSetup.cache, options({ concurrency: 2 }));
    expect(translateSizes(plain)).toEqual(translateSizes(pooled));
  });

  it('never counts a skipped request as an error, a cost or progress', async () => {
    const { store, cache } = setup(lines(120));
    const llm = new FakeLlmClient(bySize(10), { pool: true });
    const events: (JobProgress & { calls: number })[] = [];
    const report = await runTranslateJob(store, llm, cache, options({ concurrency: 2, onProgress: (p) => events.push({ ...p, calls: llm.calls.length }) }));
    expect(llm.returned.filter((o) => o.kind === 'skipped').length).toBeGreaterThan(0);
    expect(report).toMatchObject({ errors: 0, refused: 0, errorSamples: [] });
    // Tokens come from answered requests only (ok() reports 10 in / 5 out each).
    const answered = llm.returned.filter((o) => o.kind === 'ok').length;
    expect(report.inputTokens).toBe(10 * answered);
    expect(report.outputTokens).toBe(5 * answered);
    // No string counts as done before the first answer (the 5th request); done never steps back and ends at 120.
    const translate = events.filter((e) => e.phase === 'translate');
    expect(translate.filter((e) => e.calls <= 4).every((e) => e.done === 0)).toBe(true);
    for (let i = 1; i < translate.length; i++) expect(translate[i]!.done).toBeGreaterThanOrEqual(translate[i - 1]!.done);
    expect(translate.at(-1)).toMatchObject({ done: 120, total: 120 });
  });

  // Amendment 8: Node's own fetch timeout (300 s) is the same timeout as LocHub's AbortSignal -- one fetch call, then
  // the group is split -- proven through the real Custom adapter, not just a scripted outcome.
  describe("Node's fetch timeout through the Custom adapter", () => {
    const custom: CustomEndpointConfig = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      keyHeader: 'bearer',
      structuredOutput: 'json_schema',
      priceIn: 0,
      priceOut: 0,
      maxParallel: 2,
      requestTimeoutSeconds: 90,
      settingsId: 'test-settings-id',
    };
    const chat = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });

    for (const [code, where] of [['UND_ERR_HEADERS_TIMEOUT', 'cause'], ['UND_ERR_BODY_TIMEOUT', 'error']] as const) {
      it(`splits a group after a single fetch call when fetch fails with ${code} on the ${where}`, async () => {
        const { store, cache } = setup([entry('A', 'PAUSED'), entry('B', 'BACK'), entry('C', '{Count} bales left'), entry('D', 'Line 4')]);
        const sizes: number[] = [];
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init!.body)) as { response_format: unknown; messages: { content: string }[] };
          if (JSON.stringify(body.response_format).includes('"issues"')) return chat('{"issues":[]}');
          const items = (JSON.parse(body.messages[1]!.content) as { items: { id: string; source: string }[] }).items;
          sizes.push(items.length);
          if (items.length > 2) {
            const failure = new TypeError('fetch failed');
            throw where === 'cause' ? Object.assign(failure, { cause: Object.assign(new Error('Headers Timeout Error'), { code }) }) : Object.assign(failure, { code });
          }
          const translated = items.map((i) => ({ id: i.id, translation: RU[i.source] ?? toRu(i.source), ambiguity: 'none', alts: [], question: '', terms_used: [] }));
          return chat(JSON.stringify({ items: translated }));
        }) as typeof fetch;
        const llm = new OpenAiCompatibleLlmClient({ provider: 'custom', custom, fetchImpl, apiKey: '' });
        const report = await runTranslateJob(store, llm, cache, options({ concurrency: 2 }));
        // One call for the group of 4 (no fetch-level retry, no whole-group retry), then its two halves.
        expect(sizes).toEqual([4, 2, 2]);
        expect(report).toMatchObject({ written: 4, errors: 0 });
      });
    }
  });
});
