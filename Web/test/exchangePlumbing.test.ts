import { describe, expect, it, vi } from 'vitest';
import { ApiError, LocHubApi } from '../src/api/client';
import { EditorBridge } from '../src/bridge';
import { pickTextFile, saveTextFile } from '../src/files';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

const noop = () => true;
const XLIFF_TYPES = 'XLIFF files (*.xlf)|*.xlf|All files (*.*)|*.*';

describe('translation exchange plumbing', () => {
  it('pickTextFile hands the editor dialog the file-type filter it is given', async () => {
    const seen: unknown[] = [];
    const bridge = new EditorBridge(new LocHubApi('', createFakeApi().fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      picktextfile: (title: string, fileTypes: string) => {
        seen.push([title, fileTypes]);
        return JSON.stringify({ cancelled: true });
      },
    }));
    await pickTextFile(bridge, 'Import translations', '.csv,.xlf', 'Translation files (*.csv;*.xlf)|*.csv;*.xlf');
    expect(seen).toEqual([['Import translations', 'Translation files (*.csv;*.xlf)|*.csv;*.xlf']]);
  });

  it('saveTextFile hands the editor dialog its title and filter', async () => {
    const seen: unknown[] = [];
    const bridge = new EditorBridge(new LocHubApi('', createFakeApi().fetch), () => ({
      openorigin: noop,
      setpreviewculture: noop,
      applylive: noop,
      savetextfile: (title: string, defaultFileName: string, fileTypes: string, text: string) => {
        seen.push([title, defaultFileName, fileTypes, text]);
        return JSON.stringify({ cancelled: false, path: 'D:/x/lochub-de.xlf' });
      },
    }));
    expect(await saveTextFile(bridge, 'lochub-de.xlf', '<xliff/>', XLIFF_TYPES, 'Export translations', 'application/xliff+xml;charset=utf-8')).toEqual({
      path: 'D:/x/lochub-de.xlf',
    });
    expect(seen).toEqual([['Export translations', 'lochub-de.xlf', XLIFF_TYPES, '<xliff/>']]);
  });

  it('saveTextFile gives a browser download the media type it is given', async () => {
    const bridge = new EditorBridge(new LocHubApi('', createFakeApi().fetch), () => undefined);
    let blob: Blob | undefined;
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob;
      return 'blob:mock';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await saveTextFile(bridge, 'lochub-de.xlf', '<xliff/>', XLIFF_TYPES, 'Export translations', 'application/xliff+xml;charset=utf-8');
    expect(blob?.type).toBe('application/xliff+xml;charset=utf-8');
    create.mockRestore();
    revoke.mockRestore();
  });

  it('LocHubApi.importTranslations posts the request as JSON to /api/import', async () => {
    const fake = createFakeApi({ units: [makeUnit('Pause', 'PAUSED')] });
    const request = {
      culture: 'ru',
      actor: 'Alex',
      dryRun: true,
      overwriteConflicts: false,
      acceptConfirm: false,
      entries: [{ unitId: 'id-Pause', text: 'ПАУЗА', approved: false }],
    };
    const result = await new LocHubApi('', fake.fetch).importTranslations(request);
    expect(fake.requests.at(-1)).toEqual({ method: 'POST', path: '/api/import', body: request });
    expect(result.rows).toEqual([{ index: 0, unitId: 'id-Pause', outcome: 'changed', issues: [], before: '', after: 'ПАУЗА' }]);
    expect(result.counts.changed).toBe(1);
    expect(typeof result.digest).toBe('string');
  });

  describe("fakeApi's /api/import mirrors the service's amended rules (M-7)", () => {
    it('a carried-over approval (the cell was already approved at export) never approves new text', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved', revision: 1 }) } } });
      const api = new LocHubApi('', fake.fetch);
      const result = await api.importTranslations({
        culture: 'ru',
        actor: 'Alex',
        dryRun: false,
        overwriteConflicts: false,
        acceptConfirm: false,
        entries: [{ unitId: unit.id, text: 'ПАУЗА!', approved: true }],
      });
      expect(result.rows[0]).toMatchObject({ outcome: 'changed' });
      expect(fake.state.cells.ru![unit.id]).toMatchObject({ text: 'ПАУЗА!', status: 'edited' });
    });

    it('an overwritten conflict never approves, even when the file text equals the cell text and marks it approved', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'edited', revision: 2 }) } } });
      const api = new LocHubApi('', fake.fetch);
      const entries = [{ unitId: unit.id, text: 'ПАУЗА', approved: true, exportedRevision: 1 }];
      const previewFlags = { culture: 'ru', actor: '', dryRun: true, overwriteConflicts: true, acceptConfirm: false, entries };
      const preview = await api.importTranslations(previewFlags);
      expect(preview.rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
      const result = await api.importTranslations({ ...previewFlags, actor: 'Alex', dryRun: false, previewDigest: preview.digest });
      expect(result.rows[0]).toMatchObject({ outcome: 'changed', conflict: true });
      expect(fake.state.cells.ru![unit.id]).toMatchObject({ text: 'ПАУЗА', status: 'edited' });
    });

    it('an explicit approval of an approved-but-outdated string with the same text re-approves it, instead of unchanged', async () => {
      const unit = makeUnit('Pause', 'PAUSED NOW', { sourceRev: 2 });
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'approved', basedOnSourceRev: 1, revision: 3 }) } } });
      const api = new LocHubApi('', fake.fetch);
      const result = await api.importTranslations({
        culture: 'ru',
        actor: 'Alex',
        dryRun: false,
        overwriteConflicts: false,
        acceptConfirm: false,
        entries: [{ unitId: unit.id, source: unit.source, text: 'ПАУЗА', approved: true }],
      });
      expect(result.rows[0]).toMatchObject({ outcome: 'approved' });
      expect(fake.state.cells.ru![unit.id]).toMatchObject({ status: 'approved', text: 'ПАУЗА' });
    });

    it('refuses a stale apply (previewDigest no longer matches) with 409 preview_stale, writing nothing', async () => {
      const unit = makeUnit('Pause', 'PAUSED');
      const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 }) } } });
      const api = new LocHubApi('', fake.fetch);
      const entries = [{ unitId: unit.id, text: 'ПАУЗА!', approved: false }];
      const preview = await api.importTranslations({ culture: 'ru', actor: '', dryRun: true, overwriteConflicts: false, acceptConfirm: false, entries });
      // Someone else edits the cell after the preview, before the apply.
      fake.state.cells.ru![unit.id] = { ...fake.state.cells.ru![unit.id]!, text: 'ПАУЗА??', revision: 9 };
      const error = await api
        .importTranslations({ culture: 'ru', actor: 'Alex', dryRun: false, overwriteConflicts: false, acceptConfirm: false, entries, previewDigest: preview.digest })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(409);
      expect((error as ApiError).body).toMatchObject({ error: 'preview_stale' });
      expect(fake.state.cells.ru![unit.id]!.text).toBe('ПАУЗА??');
      // No previewDigest at all is unaffected (backward compatible): the same stale write goes through.
      const applied = await api.importTranslations({ culture: 'ru', actor: 'Alex', dryRun: false, overwriteConflicts: false, acceptConfirm: false, entries });
      expect(applied.rows[0]).toMatchObject({ outcome: 'changed' });
      expect(fake.state.cells.ru![unit.id]!.text).toBe('ПАУЗА!');
    });
  });
});
