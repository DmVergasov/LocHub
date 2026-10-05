import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocHubApi, type FetchLike } from '../src/api/client';
import { EditorBridge, type UeLocHubBinding } from '../src/bridge';
import { ExchangeActions } from '../src/exchange/ExchangeActions';
import { createFakeApi, makeCell, makeUnit, rowsFromState } from './fakeApi';

const noop = () => true;

// Base64 of the UTF-8 bytes of `text`, the same encoding the editor's PickTextFile sends file bytes in.
function toBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function setup() {
  const pause = makeUnit('Pause', 'PAUSED');
  const count = makeUnit('Count', '{Count} bales left');
  const title = makeUnit('Title', 'Thornreach');
  const fake = createFakeApi({
    units: [pause, count, title],
    cells: {
      ru: {
        [pause.id]: makeCell(pause.id, 'ru', { text: 'ПАУЗА', status: 'ai_draft', revision: 1 }),
        [count.id]: makeCell(count.id, 'ru', { text: 'Осталось {Count} тюков', status: 'edited', revision: 2 }),
      },
      de: {},
    },
  });
  return { fake, api: new LocHubApi('', fake.fetch), pause, count };
}

function renderActions(s: ReturnType<typeof setup>, binding: Partial<UeLocHubBinding>, nativeCulture = 'en') {
  const bridge = new EditorBridge(s.api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, ...binding }) as UeLocHubBinding);
  const onImported = vi.fn();
  const rows = rowsFromState(s.fake.state, ['ru']);
  render(
    <ExchangeActions
      api={s.api}
      bridge={bridge}
      culture="ru"
      cultures={['de', 'ru']}
      nativeCulture={nativeCulture}
      filtered={rows.slice(0, 2)}
      totalCount={rows.length}
      onImported={onImported}
      now={() => new Date('2026-09-27T10:00:00.000Z')}
    />,
  );
  return { onImported };
}

const pick = (name: string, text: string) => () => JSON.stringify({ cancelled: false, name, base64: toBase64(text) });
const importBodies = (s: ReturnType<typeof setup>) => s.fake.requests.filter((request) => request.path === '/api/import').map((request) => request.body);

const XLIFF = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:lochub="urn:lochub:xliff">
<file original="LocHub/ru" source-language="en" target-language="ru" datatype="plaintext" date="2026-09-27T09:00:00.000Z"><body>
<trans-unit id="id-Pause" resname="HW/Pause" lochub:revision="1"><source>PAUSED</source><target state="translated">ПАУЗА!</target></trans-unit>
<trans-unit id="id-Count" resname="HW/Count" lochub:revision="1"><source><ph id="1">{Count}</ph> bales left</source><target state="translated">Осталось <ph id="1">{Count}</ph> кип</target></trans-unit>
<trans-unit id="id-Title" resname="HW/Title"><source>Thornreach (old)</source><target state="translated">Торнрич</target></trans-unit>
<trans-unit id="id-Gone" resname="HW/Gone"><source>Gone</source><target state="translated">Нет</target></trans-unit>
</body></file></xliff>`;

describe('ExchangeActions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('Export…', () => {
    it('exports the strings matching the current filters as CSV by default, sorted, through the save dialog', async () => {
      const user = userEvent.setup();
      const s = setup();
      const saved: string[][] = [];
      renderActions(s, {
        savetextfile: (title: string, name: string, fileTypes: string, text: string) => {
          saved.push([title, name, fileTypes, text]);
          return JSON.stringify({ cancelled: false, path: 'D:/x/lochub-ru.csv' });
        },
      });

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      const dialog = screen.getByRole('dialog', { name: 'Export translations' });
      expect((screen.getByLabelText('Export culture') as HTMLSelectElement).value).toBe('ru');
      expect((screen.getByLabelText('Export format') as HTMLSelectElement).value).toBe('csv');
      expect(within(screen.getByLabelText('Export scope')).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Strings matching the current filters (2)',
        'All strings (3)',
      ]);
      await user.click(within(dialog).getByRole('button', { name: 'Export' }));

      expect(await screen.findByText('Saved to D:/x/lochub-ru.csv')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Export translations' })).toBeNull();
      const [title, name, fileTypes, text] = saved[0]!;
      expect([title, name, fileTypes]).toEqual(['Export translations', 'lochub-ru.csv', 'CSV files (*.csv)|*.csv|All files (*.*)|*.*']);
      const lines = text!.split('\r\n');
      expect(lines[0]).toBe('namespace,key,source,translation,status,context,notes,max_length,lochub_id,lochub_revision');
      expect(lines[1]!.startsWith('HW,Count,{Count} bales left,Осталось {Count} тюков,edited,')).toBe(true);
      expect(lines[1]!.endsWith(',id-Count,2')).toBe(true);
      expect(lines[2]!.startsWith('HW,Pause,PAUSED,ПАУЗА,ai_draft,')).toBe(true);
      expect(lines.slice(3)).toEqual(['']);
    });

    it('exports every string of another culture as XLIFF 1.2', async () => {
      const user = userEvent.setup();
      const s = setup();
      const saved: string[][] = [];
      renderActions(s, {
        savetextfile: (title: string, name: string, fileTypes: string, text: string) => {
          saved.push([title, name, fileTypes, text]);
          return JSON.stringify({ cancelled: false, path: 'D:/x/lochub-de.xlf' });
        },
      });

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      await user.selectOptions(screen.getByLabelText('Export culture'), 'de');
      await user.selectOptions(screen.getByLabelText('Export format'), 'xliff');
      await user.selectOptions(screen.getByLabelText('Export scope'), 'all');
      await user.click(within(screen.getByRole('dialog', { name: 'Export translations' })).getByRole('button', { name: 'Export' }));

      await screen.findByText('Saved to D:/x/lochub-de.xlf');
      const [, name, fileTypes, text] = saved[0]!;
      expect([name, fileTypes]).toEqual(['lochub-de.xlf', 'XLIFF files (*.xlf)|*.xlf|All files (*.*)|*.*']);
      expect(text).toContain('source-language="en" target-language="de" datatype="plaintext" date="2026-09-27T10:00:00.000Z"');
      expect(text!.match(/<trans-unit /g)).toHaveLength(3);
    });

    it("writes the target's native culture as the XLIFF source language", async () => {
      const user = userEvent.setup();
      const s = setup();
      const saved: string[] = [];
      renderActions(s, {
        savetextfile: (_title: string, _name: string, _fileTypes: string, text: string) => {
          saved.push(text);
          return JSON.stringify({ cancelled: false, path: 'D:/x/lochub-ru.xlf' });
        },
      }, 'zh-Hans');

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      await user.selectOptions(screen.getByLabelText('Export format'), 'xliff');
      await user.click(within(screen.getByRole('dialog', { name: 'Export translations' })).getByRole('button', { name: 'Export' }));

      await screen.findByText('Saved to D:/x/lochub-ru.xlf');
      expect(saved[0]).toContain('source-language="zh-Hans" target-language="ru"');
    });

    it('does not guess the XLIFF source language: Export waits for a Push to report it', async () => {
      const user = userEvent.setup();
      const s = setup();
      const savetextfile = vi.fn(() => JSON.stringify({ cancelled: false, path: 'D:/x/out' }));
      renderActions(s, { savetextfile }, '');

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      await user.selectOptions(screen.getByLabelText('Export format'), 'xliff');
      const dialog = screen.getByRole('dialog', { name: 'Export translations' });
      expect((within(dialog).getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(dialog).getByText('Push, then Refresh, so LocHub knows the source culture: XLIFF needs it.')).toBeTruthy();
      expect(savetextfile).not.toHaveBeenCalled();
    });

    it('still exports CSV while the source culture is unknown', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderActions(s, { savetextfile: () => JSON.stringify({ cancelled: false, path: 'D:/x/lochub-ru.csv' }) }, '');

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      const dialog = screen.getByRole('dialog', { name: 'Export translations' });
      expect(within(dialog).queryByText('Push, then Refresh, so LocHub knows the source culture: XLIFF needs it.')).toBeNull();
      await user.click(within(dialog).getByRole('button', { name: 'Export' }));
      expect(await screen.findByText('Saved to D:/x/lochub-ru.csv')).toBeTruthy();
    });

    it('captures the export date before the paged cells fetch, not after', async () => {
      const user = userEvent.setup();
      const s = setup();
      const EARLY = '2026-09-27T10:00:00.000Z';
      const LATE = '2026-09-27T10:05:00.000Z';
      let cellsFetched = false;
      // now() advances the moment the (possibly multi-page) GET /api/cells fetch has happened, so a call made
      // before the fetch reads EARLY and a call made after it reads LATE: this distinguishes the two orderings.
      const fetchImpl: FetchLike = async (input, init) => {
        const result = await s.fake.fetch(input, init);
        if (input.includes('/api/cells')) cellsFetched = true;
        return result;
      };
      const api = new LocHubApi('', fetchImpl);
      const saved: string[] = [];
      const binding: Partial<UeLocHubBinding> = {
        savetextfile: (_title: string, _name: string, _fileTypes: string, text: string) => {
          saved.push(text);
          return JSON.stringify({ cancelled: false, path: 'D:/x/lochub-ru.xlf' });
        },
      };
      const bridge = new EditorBridge(api, () => ({ openorigin: noop, setpreviewculture: noop, applylive: noop, ...binding }) as UeLocHubBinding);
      const rows = rowsFromState(s.fake.state, ['ru']);
      render(
        <ExchangeActions
          api={api}
          bridge={bridge}
          culture="ru"
          cultures={['de', 'ru']}
          nativeCulture="en"
          filtered={rows.slice(0, 2)}
          totalCount={rows.length}
          onImported={() => {}}
          now={() => new Date(cellsFetched ? LATE : EARLY)}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Export…' }));
      await user.selectOptions(screen.getByLabelText('Export format'), 'xliff');
      await user.click(within(screen.getByRole('dialog', { name: 'Export translations' })).getByRole('button', { name: 'Export' }));

      await screen.findByText('Saved to D:/x/lochub-ru.xlf');
      expect(saved[0]).toContain(`date="${EARLY}"`);
    });
  });

  describe('Import…', () => {
    it('previews an XLIFF file by outcome and imports it under the reviewer name', async () => {
      const user = userEvent.setup();
      const s = setup();
      const { onImported } = renderActions(s, { picktextfile: pick('lochub-ru.xlf', XLIFF) });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByRole('dialog', { name: 'Import translations' });
      expect(screen.getByText('Import into ru')).toBeTruthy();
      for (const summary of ['Changed (1)', 'Approved (0)', 'Unchanged (0)', 'Skipped (2)', 'Conflicts (1)', 'Needs confirmation (0)']) {
        expect(screen.getByText(summary)).toBeTruthy();
      }
      expect(screen.getByText('HW/Pause: "ПАУЗА" → "ПАУЗА!"')).toBeTruthy();
      expect(screen.getByText('HW/Title: the source text changed since the export')).toBeTruthy();
      expect(screen.getByText('HW/Gone: no such string in this project')).toBeTruthy();
      expect(screen.getByText('HW/Count: "Осталось {Count} тюков" → "Осталось {Count} кип"')).toBeTruthy();
      expect(screen.queryByText(/Import anyway/)).toBeNull();

      const importButton = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
      expect(importButton.disabled).toBe(true);
      await user.type(screen.getByLabelText('Reviewer name'), 'Alex');
      expect(importButton.disabled).toBe(false);
      await user.click(importButton);

      expect(await screen.findByText('Imported 1 string into ru.')).toBeTruthy();
      expect(screen.queryByRole('dialog', { name: 'Import translations' })).toBeNull();
      expect(importBodies(s).at(-1)).toMatchObject({
        culture: 'ru',
        actor: 'Alex',
        dryRun: false,
        overwriteConflicts: false,
        acceptConfirm: false,
        previewDigest: expect.any(String),
      });
      expect(s.fake.state.cells.ru![s.pause.id]).toMatchObject({ text: 'ПАУЗА!', status: 'edited' });
      expect(s.fake.state.cells.ru![s.count.id]!.text).toBe('Осталось {Count} тюков');
      expect(onImported).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('lochub.reviewerName')).toBe('Alex');
    });

    it('"Overwrite conflicts" re-runs the preview and goes into the import request', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderActions(s, { picktextfile: pick('lochub-ru.xlf', XLIFF) });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await user.click(await screen.findByLabelText('Overwrite conflicts (1)'));
      await waitFor(() => expect(screen.getByText('Changed (2)')).toBeTruthy());
      expect(screen.getByText('Conflicts (0)')).toBeTruthy();
      expect(importBodies(s).at(-1)).toMatchObject({ dryRun: true, overwriteConflicts: true });

      await user.type(screen.getByLabelText('Reviewer name'), 'Alex');
      await user.click(screen.getByRole('button', { name: 'Import' }));
      await screen.findByText('Imported 2 strings into ru.');
      expect(importBodies(s).at(-1)).toMatchObject({ dryRun: false, overwriteConflicts: true });
      expect(s.fake.state.cells.ru![s.count.id]!.text).toBe('Осталось {Count} кип');
    });

    it('"Import anyway" lets strings with warnings through, and goes into the import request', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderActions(s, { picktextfile: pick('sheet.csv', 'lochub_id,translation\r\nid-Count,Осталось тюков\r\n') });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByText('Needs confirmation (1)');
      expect(screen.getByText('Row 2: Missing arguments: Count')).toBeTruthy();
      await user.type(screen.getByLabelText('Reviewer name'), 'Alex');
      expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);

      await user.click(screen.getByLabelText('Import anyway: 1 string with warnings'));
      await waitFor(() => expect(screen.getByText('Changed (1)')).toBeTruthy());
      expect(screen.getByText('Row 2: "Осталось {Count} тюков" → "Осталось тюков" — Missing arguments: Count')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Import' }));
      await screen.findByText('Imported 1 string into ru.');
      expect(importBodies(s).at(-1)).toMatchObject({ dryRun: false, acceptConfirm: true, overwriteConflicts: false });
    });

    it('gives every skipped string its reason and marks an approved change', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderActions(s, {
        picktextfile: pick('sheet.csv', 'lochub_id,translation,status\r\nid-Pause,,\r\nid-Count,Осталось {Broken} тюков,\r\nid-Title,Торнрич,approved\r\n'),
      });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByRole('dialog', { name: 'Import translations' });
      expect(screen.getByText('Row 2: no translation in the file (an import never clears one)')).toBeTruthy();
      expect(screen.getByText('Row 3: format problem: Unknown arguments: Broken')).toBeTruthy();
      expect(screen.getByText('Row 4: "(empty)" → "Торнрич" (approved)')).toBeTruthy();
    });

    it('labels a CAT tool\'s copy-of-source pre-fill differently from a genuinely blank translation', async () => {
      const user = userEvent.setup();
      const s = setup();
      const xliffMixed = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2" xmlns:lochub="urn:lochub:xliff">
<file original="LocHub/ru" source-language="en" target-language="ru" datatype="plaintext"><body>
<trans-unit id="id-Pause" resname="HW/Pause"><source>PAUSED</source></trans-unit>
<trans-unit id="id-Title" resname="HW/Title"><source>Thornreach</source><target state="new">Thornreach</target></trans-unit>
</body></file></xliff>`;
      renderActions(s, { picktextfile: pick('lochub-ru.xlf', xliffMixed) });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByRole('dialog', { name: 'Import translations' });
      expect(screen.getByText('HW/Pause: no translation in the file (an import never clears one)')).toBeTruthy();
      expect(screen.getByText('HW/Title: copy of the source (not translated)')).toBeTruthy();
    });

    it('refuses a stale apply and shows the fresh preview instead of silently applying different rows', async () => {
      const user = userEvent.setup();
      const s = setup();
      renderActions(s, { picktextfile: pick('sheet.csv', 'lochub_id,translation\r\nid-Pause,ПАУЗА!\r\n') });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByText('Changed (1)');
      // Another tab, an AI job or a Push writes the same cell between the preview and Import.
      s.fake.state.cells.ru![s.pause.id] = { ...s.fake.state.cells.ru![s.pause.id]!, text: 'ПАУЗА?', revision: 5 };
      await user.type(screen.getByLabelText('Reviewer name'), 'Alex');
      await user.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByText('Strings changed in LocHub since this preview. Check it again, then Import.')).toBeTruthy();
      expect(screen.getByRole('dialog', { name: 'Import translations' })).toBeTruthy();
      expect(screen.getByText('Row 2: "ПАУЗА?" → "ПАУЗА!"')).toBeTruthy();
      expect(s.fake.state.cells.ru![s.pause.id]!.text).toBe('ПАУЗА?');
      expect(importBodies(s).filter((b) => b.dryRun === false)).toHaveLength(1);
    });

    it('fills in the remembered reviewer name and lists CSV columns it ignores', async () => {
      const user = userEvent.setup();
      localStorage.setItem('lochub.reviewerName', 'Sam');
      const s = setup();
      renderActions(s, { picktextfile: pick('sheet.csv', 'lochub_id,translation,comment\r\nid-Pause,ПАУЗА!,typo fixed\r\n') });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await screen.findByRole('dialog', { name: 'Import translations' });
      expect((screen.getByLabelText('Reviewer name') as HTMLInputElement).value).toBe('Sam');
      expect(screen.getByText('Ignored columns: comment')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('refuses a file for another culture and an unsupported file before any request', async () => {
      const user = userEvent.setup();
      const s = setup();
      let file = { name: 'lochub-de.xlf', text: XLIFF.replace('target-language="ru"', 'target-language="de"') };
      renderActions(s, { picktextfile: () => JSON.stringify({ cancelled: false, name: file.name, base64: toBase64(file.text) }) });

      await user.click(screen.getByRole('button', { name: 'Import…' }));
      expect((await screen.findByRole('alert')).textContent).toBe('This file is for de, not ru. Switch the Grid to de or pick the ru file.');
      file = { name: 'notes.txt', text: 'hello' };
      await user.click(screen.getByRole('button', { name: 'Import…' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Choose a .csv, .xlf, .xliff or .xml file.'));
      expect(importBodies(s)).toEqual([]);
      expect(screen.queryByRole('dialog', { name: 'Import translations' })).toBeNull();
    });
  });
});
