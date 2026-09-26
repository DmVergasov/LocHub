import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge, type UeLocHubBinding } from '../src/bridge';
import { GlossaryView } from '../src/glossary/GlossaryView';
import { createFakeApi, makeCell, makeUnit, rowsFromState } from './fakeApi';

const noop = () => true;

// Base64 of the UTF-8 bytes of `text`, the same encoding the editor's PickTextFile sends real file bytes as.
function toBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('GlossaryView', () => {
  it('saves a changed term and re-queues the AI drafts that ignore it', async () => {
    const user = userEvent.setup();
    const loaded = makeUnit('A', 'Bale loaded');
    const approved = makeUnit('B', 'Bale count');
    const fake = createFakeApi({
      units: [loaded, approved],
      cells: {
        ru: {
          [loaded.id]: makeCell(loaded.id, 'ru', { text: 'Кипа загружена', status: 'ai_draft' }),
          [approved.id]: makeCell(approved.id, 'ru', { text: 'Кипы', status: 'approved' }),
        },
      },
      glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }] },
      style: { ru: 'Use "ты".' },
    });
    const onCell = vi.fn();
    const onTermFix = vi.fn();
    const api = new LocHubApi('', fake.fetch);
    render(
      <GlossaryView
        api={api}
        culture="ru"
        rows={rowsFromState(fake.state, ['ru'])}
        onCell={onCell}
        onTermFix={onTermFix}
        bridge={new EditorBridge(api, () => undefined)}
        cultures={['ru']}
        nativeCulture="en"
      />,
    );

    const translation = await screen.findByDisplayValue('кипа');
    expect((screen.getByLabelText('Style guide') as HTMLTextAreaElement).value).toBe('Use "ты".');
    await user.clear(translation);
    await user.type(translation, 'тюк');
    // A blank row left by "Add term" must never reach the service: PUT refuses the whole list over one empty term.
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await user.click(screen.getByRole('button', { name: 'Save glossary' }));
    await user.click(await screen.findByRole('button', { name: 'Apply to 1 string' }));

    await waitFor(() => expect(onTermFix).toHaveBeenCalledWith({ culture: 'ru', unitIds: ['id-A'] }));
    expect(fake.state.glossary.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: false, note: '' }]);
    expect(fake.state.cells.ru?.['id-A']).toMatchObject({ status: 'rejected', note: 'Glossary: translate "bale" as "тюк".' });
    expect(fake.state.cells.ru?.['id-B']?.status).toBe('approved');
    expect(onCell).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'id-A', status: 'rejected' }));
  });

  it('clears a pending fix and never applies it under a later culture', async () => {
    const user = userEvent.setup();
    const unit = makeUnit('A', 'Bale loaded');
    const fake = createFakeApi({
      units: [unit],
      cells: {
        ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Кипа загружена', status: 'ai_draft' }) },
        de: { [unit.id]: makeCell(unit.id, 'de', { text: 'Ballen geladen', status: 'approved' }) },
      },
      glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }], de: [] },
      style: { ru: '', de: '' },
    });
    const api = new LocHubApi('', fake.fetch);
    const rows = rowsFromState(fake.state, ['ru', 'de']);
    const bridge = new EditorBridge(api, () => undefined);
    const { rerender } = render(
      <GlossaryView api={api} culture="ru" rows={rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />,
    );

    const translation = await screen.findByDisplayValue('кипа');
    await user.clear(translation);
    await user.type(translation, 'тюк');
    await user.click(screen.getByRole('button', { name: 'Save glossary' }));
    await screen.findByRole('button', { name: 'Apply to 1 string' });

    // Switching the header culture must drop the fix computed for "ru": the Apply button disappears...
    rerender(<GlossaryView api={api} culture="de" rows={rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Apply to/ })).toBeNull());

    // ...and no reject ever goes out for "de" — the approved German cell must stay untouched.
    expect(fake.calls.some((call) => call.includes('/de/'))).toBe(false);
    expect(fake.state.cells.de?.[unit.id]?.status).toBe('approved');
  });

  it('does not let a culture switch during saveGlossary overwrite the newly-selected culture\'s own view', async () => {
    const user = userEvent.setup();
    const unit = makeUnit('A', 'Bale loaded');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Кипа загружена', status: 'ai_draft' }) }, de: {} },
      glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }], de: [] },
      style: { ru: '', de: '' },
    });
    let resolvePut: (() => void) | undefined;
    const wrappedFetch: typeof fake.fetch = async (input, init) => {
      const url = new URL(input, 'http://lochub.test');
      if (init?.method === 'PUT' && url.pathname === '/api/glossary/ru') {
        await new Promise<void>((resolve) => {
          resolvePut = resolve;
        });
      }
      return fake.fetch(input, init);
    };
    const api = new LocHubApi('', wrappedFetch);
    const rows = rowsFromState(fake.state, ['ru', 'de']);
    const bridge = new EditorBridge(api, () => undefined);
    const { rerender } = render(
      <GlossaryView api={api} culture="ru" rows={rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />,
    );

    const translation = await screen.findByDisplayValue('кипа');
    await user.clear(translation);
    await user.type(translation, 'тюк');
    await user.click(screen.getByRole('button', { name: 'Save glossary' }));
    await waitFor(() => expect(resolvePut).toBeTruthy());

    // Switch culture while the PUT above is still in flight.
    rerender(<GlossaryView api={api} culture="de" rows={rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />);
    await screen.findByText('Glossary (de)');

    resolvePut?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByText('Glossary saved.')).toBeNull();
    expect(screen.queryByDisplayValue('тюк')).toBeNull();
  });

  it('saves the style guide', async () => {
    const user = userEvent.setup();
    const fake = createFakeApi({ style: { ru: '' } });
    const api = new LocHubApi('', fake.fetch);
    render(
      <GlossaryView
        api={api}
        culture="ru"
        rows={[]}
        onCell={vi.fn()}
        onTermFix={vi.fn()}
        bridge={new EditorBridge(api, () => undefined)}
        cultures={['ru']}
        nativeCulture="en"
      />,
    );
    await user.type(screen.getByLabelText('Style guide'), 'Short imperative buttons.');
    await user.click(screen.getByRole('button', { name: 'Save style guide' }));
    expect(await screen.findByText('Style guide saved.')).toBeTruthy();
    expect(fake.state.style.ru).toBe('Short imperative buttons.');
  });

  describe('Import CSV', () => {
    function setup() {
      const loaded = makeUnit('A', 'Bale loaded');
      const fake = createFakeApi({
        units: [loaded],
        cells: { ru: { [loaded.id]: makeCell(loaded.id, 'ru', { text: 'Кипа загружена', status: 'ai_draft' }) }, de: {} },
        glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }], de: [] },
        style: { ru: '', de: '' },
      });
      const api = new LocHubApi('', fake.fetch);
      const rows = rowsFromState(fake.state, ['ru', 'de']);
      return { fake, api, rows, loaded };
    }

    function renderWithBinding(setupResult: ReturnType<typeof setup>, binding: Partial<UeLocHubBinding>, onCell = vi.fn(), onTermFix = vi.fn()) {
      const bridge = new EditorBridge(setupResult.api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, ...binding }) as UeLocHubBinding);
      return {
        bridge,
        onCell,
        onTermFix,
        ...render(
          <GlossaryView
            api={setupResult.api}
            culture="ru"
            rows={setupResult.rows}
            onCell={onCell}
            onTermFix={onTermFix}
            bridge={bridge}
            cultures={['ru', 'de']}
            nativeCulture="en"
          />,
        ),
      };
    }

    it('previews per-culture counts, imports both cultures, and reports the same "Apply to N strings" fix as Save', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru,de\r\nbale,тюк,Ballen\r\nmower,косилка,Mäher\r\n';
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));

      const dialog = await screen.findByRole('dialog', { name: 'Import glossary' });
      expect(await screen.findByText('ru: 1 new, 1 updated')).toBeTruthy();
      expect(await screen.findByText('de: 2 new, 0 updated')).toBeTruthy();

      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByText('Imported: ru 1 new, 1 updated; de 2 new.')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull();
      expect(dialog).toBeDefined();

      expect(s.fake.state.glossary.ru).toEqual([
        { term: 'bale', translation: 'тюк', dnt: false, note: '' },
        { term: 'mower', translation: 'косилка', dnt: false, note: '' },
      ]);
      expect(s.fake.state.glossary.de).toEqual([
        { term: 'bale', translation: 'Ballen', dnt: false, note: '' },
        { term: 'mower', translation: 'Mäher', dnt: false, note: '' },
      ]);

      // Same "Apply to N strings" computation as Save glossary: the AI draft using "bale" without the new
      // translation gets a fix; "mower" touches no unit in this fixture, so it produces no fix at all.
      await screen.findByRole('button', { name: 'Apply to 1 string' });
      expect(await screen.findByDisplayValue('тюк')).toBeTruthy();
    });

    it('moves focus onto the import preview dialog as soon as it opens', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru\r\nbale,тюк\r\n';
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));

      const dialog = await screen.findByRole('dialog', { name: 'Import glossary' });
      expect(document.activeElement).toBe(dialog);
    });

    it('refuses to import over unsaved on-screen edits, without ever opening the file picker', async () => {
      const user = userEvent.setup();
      const s = setup();
      const picktextfile = vi.fn(() => JSON.stringify({ cancelled: true }));
      renderWithBinding(s, { picktextfile });

      const translation = await screen.findByDisplayValue('кипа');
      await user.clear(translation);
      await user.type(translation, 'тюк');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));

      expect(await screen.findByText('Save your glossary changes before importing.')).toBeTruthy();
      expect(picktextfile).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull();
    });

    it('re-checks unsaved edits when confirming, not only when opening the picker: an edit made while the preview is open blocks Import too', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru\r\nbale,тюк\r\n';
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      const translation = await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });

      // The table stays live underneath the preview; this edit happens after the preview already opened.
      await user.clear(translation);
      await user.type(translation, 'тюк-edited');

      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByText('Save your glossary changes before importing.')).toBeTruthy();
      expect(screen.getByRole('dialog', { name: 'Import glossary' })).toBeTruthy(); // the preview stays open
      expect(screen.getByDisplayValue('тюк-edited')).toBeTruthy(); // the edit is kept, not reverted
      expect(s.fake.calls.some((call) => call.startsWith('PUT /api/glossary'))).toBe(false);
    });

    it('does not let a culture switch during confirmImport overwrite the newly-selected culture\'s own view', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru\r\nbale,тюк\r\n';
      const { rerender, bridge } = renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });

      // Let the PUT go through the real fake route (its own re-merge GET too, the first call to 'ru'); only the
      // post-PUT refresh GET (the second call) is held open, so a culture switch can land while it is in flight.
      let ruGlossaryCalls = 0;
      let resolveStaleRefresh: (terms: { term: string; translation: string; dnt: boolean; note: string }[]) => void = () => {};
      const glossarySpy = vi.spyOn(s.api, 'glossary').mockImplementation(async (cultureCode: string) => {
        if (cultureCode === 'ru') {
          ruGlossaryCalls += 1;
          if (ruGlossaryCalls > 1) return new Promise((resolve) => { resolveStaleRefresh = resolve; });
        }
        return s.fake.state.glossary[cultureCode] ?? [];
      });

      await user.click(screen.getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(s.fake.state.glossary.ru).toEqual([{ term: 'bale', translation: 'тюк', dnt: false, note: '' }]));

      rerender(<GlossaryView api={s.api} culture="de" rows={s.rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull());
      expect(screen.queryByDisplayValue('кипа')).toBeNull(); // "de"'s own (empty) glossary is showing now

      resolveStaleRefresh([{ term: 'bale', translation: 'тюк', dnt: false, note: '' }]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(screen.queryByDisplayValue('тюк')).toBeNull(); // the stale "ru" refresh never landed on the "de" view
      expect(screen.queryByText(/^Imported:/)).toBeNull();
      glossarySpy.mockRestore();
    });

    it('re-fetches a culture switched to mid-import when that culture is itself part of the import, so a load effect that read it before the PUT landed does not leave a stale view for a later Save to overwrite', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru,de\r\nbale,тюк,Ballen\r\n';
      const { rerender, bridge } = renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });

      // Hold "de"'s own PUT open so the culture switch below — and the load effect's GET it triggers — lands
      // before this import's write to "de" actually reaches the server.
      let resolveDePut: (() => void) | undefined;
      const saveSpy = vi.spyOn(s.api, 'saveGlossary').mockImplementation(async (cultureCode, terms) => {
        if (cultureCode === 'de') await new Promise<void>((resolve) => { resolveDePut = resolve; });
        s.fake.state.glossary[cultureCode] = terms;
        return { ok: true } as const;
      });

      await user.click(screen.getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(resolveDePut).toBeTruthy());

      rerender(<GlossaryView api={s.api} culture="de" rows={s.rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />);
      await screen.findByText('Glossary (de)');
      expect(screen.queryByDisplayValue('Ballen')).toBeNull(); // the load effect's GET beat the PUT to "de"

      resolveDePut?.();
      await waitFor(() => expect(screen.getByDisplayValue('Ballen')).toBeTruthy());
      saveSpy.mockRestore();
    });

    it('reloads the active culture after a partial failure and names which cultures were saved', async () => {
      const user = userEvent.setup();
      const s = setup();
      s.fake.state.failGlossaryPutCultures = ['de'];
      const csv = 'term,ru,de\r\nbale,тюк,Ballen\r\nmower,косилка,Mäher\r\n';
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByText('Import stopped: boom saving de. Saved: ru.')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull();
      // The active culture (ru) is among the saved ones: its table reloads with the imported terms...
      expect(await screen.findByDisplayValue('тюк')).toBeTruthy();
      expect(s.fake.state.glossary.ru).toEqual([
        { term: 'bale', translation: 'тюк', dnt: false, note: '' },
        { term: 'mower', translation: 'косилка', dnt: false, note: '' },
      ]);
      // ...while de never saved.
      expect(s.fake.state.glossary.de).toEqual([]);
    });

    it('closes the dialog and shows an error when the post-import refresh fails', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru\r\nbale,тюк\r\n';
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });

      // Let the PUT go through the real fake route, but fail only the refresh GET that follows it.
      let glossaryCalls = 0;
      const glossarySpy = vi.spyOn(s.api, 'glossary').mockImplementation(async (cultureCode: string) => {
        glossaryCalls += 1;
        if (cultureCode === 'ru' && glossaryCalls > 1) throw new Error('refresh boom');
        return s.fake.state.glossary[cultureCode] ?? [];
      });

      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByText('refresh boom')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull();
      expect((screen.getByRole('button', { name: 'Import CSV…' }) as HTMLButtonElement).disabled).toBe(false);
      glossarySpy.mockRestore();
    });

    it('closes the import preview and clears the importing flag on a culture switch', async () => {
      const user = userEvent.setup();
      const s = setup();
      const csv = 'term,ru,de\r\nbale,тюк,Ballen\r\n';
      const { rerender, bridge } = renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'glossary.csv', base64: toBase64(csv) }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));
      await screen.findByRole('dialog', { name: 'Import glossary' });

      rerender(
        <GlossaryView api={s.api} culture="de" rows={s.rows} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru', 'de']} nativeCulture="en" />,
      );

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull());
    });

    it('shows "No terms to import." and disables Import when the file has no importable rows', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: 'empty.csv', base64: toBase64('term,ru\r\n') }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));

      await screen.findByRole('dialog', { name: 'Import glossary' });
      expect(screen.getByText('No terms to import.')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('ignores a second "Import CSV…" click while the picker is in flight', async () => {
      const user = userEvent.setup();
      const s = setup();
      let resolvePick: (value: string) => void = () => {};
      const picktextfile = vi.fn(() => new Promise<string>((resolve) => { resolvePick = resolve; }));
      renderWithBinding(s, { picktextfile });

      await screen.findByDisplayValue('кипа');
      const button = screen.getByRole('button', { name: 'Import CSV…' });
      await user.click(button);
      await user.click(button);

      expect(picktextfile).toHaveBeenCalledTimes(1);
      resolvePick(JSON.stringify({ cancelled: true }));
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    });

    it('does nothing when the file picker is cancelled', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderWithBinding(s, { picktextfile: () => JSON.stringify({ cancelled: true }) });

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Import CSV…' }));

      expect(screen.queryByRole('dialog', { name: 'Import glossary' })).toBeNull();
      expect(screen.queryByText(/^Imported:/)).toBeNull();
      expect(s.fake.state.glossary.ru).toEqual([{ term: 'bale', translation: 'кипа', dnt: false, note: '' }]);
      expect(s.fake.calls.some((call) => call.startsWith('PUT /api/glossary'))).toBe(false);
    });
  });

  describe('Export CSV', () => {
    it('calls savetextfile with the on-screen glossary as CSV and reports the saved path', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }] }, style: { ru: '' } });
      const api = new LocHubApi('', fake.fetch);
      const seen: unknown[] = [];
      const bridge = new EditorBridge(
        api,
        () =>
          ({
            openorigin: noop,
            setpreviewculture: noop,
            applylive: noop,
            savetextfile: (title: string, defaultFileName: string, fileTypes: string, text: string) => {
              seen.push([title, defaultFileName, fileTypes, text]);
              return JSON.stringify({ cancelled: false, path: 'D:/x/glossary-ru.csv' });
            },
          }) as UeLocHubBinding,
      );
      render(<GlossaryView api={api} culture="ru" rows={[]} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru']} nativeCulture="en" />);

      await screen.findByDisplayValue('кипа');
      await user.click(screen.getByRole('button', { name: 'Export CSV' }));

      expect(await screen.findByText('Saved to D:/x/glossary-ru.csv')).toBeTruthy();
      expect(seen).toEqual([['Export CSV', 'glossary-ru.csv', 'CSV files (*.csv)|*.csv|All files (*.*)|*.*', 'term,translation,dnt,note\r\nbale,кипа,no,\r\n']]);
    });

    it('ignores a second "Export CSV" click while the save dialog is in flight', async () => {
      const user = userEvent.setup();
      const fake = createFakeApi({ glossary: { ru: [{ term: 'bale', translation: 'кипа', dnt: false, note: '' }] }, style: { ru: '' } });
      const api = new LocHubApi('', fake.fetch);
      let resolveSave: (value: string) => void = () => {};
      const savetextfile = vi.fn(() => new Promise<string>((resolve) => { resolveSave = resolve; }));
      const bridge = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, savetextfile }) as UeLocHubBinding);
      render(<GlossaryView api={api} culture="ru" rows={[]} onCell={vi.fn()} onTermFix={vi.fn()} bridge={bridge} cultures={['ru']} nativeCulture="en" />);

      await screen.findByDisplayValue('кипа');
      const button = screen.getByRole('button', { name: 'Export CSV' });
      await user.click(button);
      await user.click(button);

      expect(savetextfile).toHaveBeenCalledTimes(1);
      resolveSave(JSON.stringify({ cancelled: true }));
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    });
  });
});
