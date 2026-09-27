import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { App } from '../src/App';
import { EditorBridge, type UeLocHubBinding } from '../src/bridge';
import { GridView } from '../src/grid/GridView';
import { NO_FILTERS, type GridRow } from '../src/grid/model';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

const noop = () => true;

function toBase64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The project has de and ru; App opens on the first sorted culture, de.
function setupApp() {
  const pause = makeUnit('Pause', 'PAUSED');
  const fake = createFakeApi({ units: [pause], cells: { de: { [pause.id]: makeCell(pause.id, 'de', { text: 'PAUSE', status: 'ai_draft', revision: 1 }) }, ru: {} } });
  const api = new LocHubApi('', fake.fetch);
  const csv = 'lochub_id,translation\r\nid-Pause,Pausiert\r\n';
  const binding = {
    openorigin: noop,
    setpreviewculture: noop,
    applylive: noop,
    picktextfile: () => JSON.stringify({ cancelled: false, name: 'lochub-de.csv', base64: toBase64(csv) }),
  } as UeLocHubBinding;
  render(<App api={api} bridge={new EditorBridge(api, () => binding)} healthMs={60_000} />);
  return { fake };
}

describe('Grid toolbar translation exchange', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('hands toolbarExtra exactly the rows the Grid shows after its filters', () => {
    const pause = makeUnit('Pause', 'PAUSED');
    const quit = makeUnit('Quit', 'Quit');
    const rows: GridRow[] = [pause, quit].map((unit) => ({ unit, cells: { ru: { cell: makeCell(unit.id, 'ru'), outdated: false } } }));
    const seen: string[][] = [];
    const api = new LocHubApi('', createFakeApi().fetch);
    render(
      <GridView
        rows={rows}
        cultures={['ru']}
        visible={['ru']}
        onVisible={() => undefined}
        culture="ru"
        nativeCulture="en"
        filters={{ ...NO_FILTERS, q: 'pause' }}
        onFilters={() => undefined}
        onOpenCell={() => undefined}
        onApplyLive={() => undefined}
        canApplyLive={false}
        bridge={new EditorBridge(api, () => undefined)}
        editorConnected={false}
        scrollMemory={{ top: 0, left: 0 }}
        loadedCultures={['ru']}
        loading={false}
        toolbarExtra={(filtered) => {
          seen.push(filtered.map((row) => row.unit.id));
          return <button type="button">Extra</button>;
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Extra' })).toBeTruthy();
    expect(seen.at(-1)).toEqual([pause.id]);
  });

  it('imports a translator file from the Grid toolbar and refreshes the Grid', async () => {
    const user = userEvent.setup();
    setupApp();
    expect(await screen.findByText('PAUSE')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    await screen.findByRole('dialog', { name: 'Import translations' });
    await user.type(screen.getByLabelText('Reviewer name'), 'Alex');
    await user.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Pausiert')).toBeTruthy();
  });

  it('closes an open import preview when the culture changes', async () => {
    const user = userEvent.setup();
    const { fake } = setupApp();
    await screen.findByText('PAUSE');
    await user.click(screen.getByRole('button', { name: 'Import…' }));
    await screen.findByRole('dialog', { name: 'Import translations' });
    fireEvent.change(screen.getByLabelText('Culture'), { target: { value: 'ru' } });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import translations' })).toBeNull());
    expect(fake.requests.filter((request) => request.path === '/api/import' && request.body.dryRun === false)).toEqual([]);
  });
});
