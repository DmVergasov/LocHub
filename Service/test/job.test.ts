import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ResponseCache } from '../src/cache.js';
import { editCell, rejectCell } from '../src/cells.js';
import type { SnapshotEntry } from '../src/contract.js';
import { unitIdOf } from '../src/ids.js';
import { DEFAULT_JOB_OPTIONS, runTranslateJob, type JobOptions, type JobProgress } from '../src/job.js';
import type { LlmOutcome, LlmRequest } from '../src/llm.js';
import { answerQuestion, recordQuestion } from '../src/memory.js';
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
    expect(cell).toMatchObject({ text: 'ПАУЗА', status: 'ai_draft', band: 'G', provenance: 'ai:claude-opus-5-5+translate-v1', revision: 1 });
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
    expect(cell).toMatchObject({ text: 'ПАУЗА (вручную)', status: 'edited', band: '', qaFlags: [], revision: 1 });
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
