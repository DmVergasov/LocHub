import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge } from '../src/bridge';
import { sortRows, withCell, type GridData, type GridRow } from '../src/grid/model';
import { QueueView } from '../src/review/QueueView';
import { createFakeApi, makeCell, makeUnit, rowsFromState } from './fakeApi';

function Harness({ api, initial }: { api: LocHubApi; initial: GridRow[] }) {
  const [data, setData] = useState<GridData>(() => new Map(initial.map((r) => [r.unit.id, r])));
  const rows = useMemo(() => sortRows(data), [data]);
  const bridge = useMemo(() => new EditorBridge(api, () => undefined), [api]);
  return <QueueView api={api} bridge={bridge} rows={rows} culture="ru" editorConnected={false} onCell={(cell) => setData((d) => withCell(d, cell))} />;
}

// Different groups: the card lists group neighbours, which would put both sources on screen at once.
function setup() {
  const red = makeUnit('Red', 'RED SOURCE', { groupKey: 'Pause' });
  const yellow = makeUnit('Yellow', 'YELLOW SOURCE', { groupKey: 'Hud' });
  const fake = createFakeApi({
    units: [red, yellow],
    cells: {
      ru: {
        [red.id]: makeCell(red.id, 'ru', { text: 'красный', status: 'ai_draft', band: 'R', alts: ['алый', 'багровый'] }),
        [yellow.id]: makeCell(yellow.id, 'ru', { text: 'жёлтый', status: 'ai_draft', band: 'Y' }),
      },
    },
  });
  const api = new LocHubApi('', fake.fetch);
  render(<Harness api={api} initial={rowsFromState(fake.state, ['ru'])} />);
  return fake;
}

describe('QueueView', () => {
  it('moves with J/K and approves with A', async () => {
    const user = userEvent.setup();
    const fake = setup();
    expect(screen.getByText('RED SOURCE')).toBeTruthy();
    expect(screen.queryByText('YELLOW SOURCE')).toBeNull();
    await user.keyboard('j');
    expect(screen.getByText('YELLOW SOURCE')).toBeTruthy();
    await user.keyboard('k');
    expect(screen.getByText('RED SOURCE')).toBeTruthy();
    await user.keyboard('a');
    await waitFor(() => expect(screen.getByText('YELLOW SOURCE')).toBeTruthy());
    expect(screen.getByText(/^1 \/ 1/)).toBeTruthy();
    expect(fake.calls).toContain('POST /api/cells/ru/id-Red/approve');
  });

  it('does not treat typing in a field as hotkeys', async () => {
    const user = userEvent.setup();
    const fake = setup();
    await user.type(screen.getByLabelText('Translation'), 'ajr');
    expect(screen.getByText('RED SOURCE')).toBeTruthy();
    // The live format check also POSTs as the draft changes; this assertion is only about hotkey actions.
    expect(fake.calls.filter((call) => call.startsWith('POST') && !call.endsWith('/check'))).toEqual([]);
    expect((screen.getByLabelText('Translation') as HTMLTextAreaElement).value).toBe('красныйajr');
  });

  it('focuses fields with E, R, N and fills alternatives with 1-3', async () => {
    const user = userEvent.setup();
    setup();
    await user.keyboard('2');
    expect((screen.getByLabelText('Translation') as HTMLTextAreaElement).value).toBe('багровый');
    await user.keyboard('r');
    expect(document.activeElement).toBe(screen.getByLabelText('Reject reason'));
    await user.keyboard('{Escape}n');
    expect(document.activeElement).toBe(screen.getByLabelText('Context question'));
    await user.keyboard('{Escape}e');
    expect(document.activeElement).toBe(screen.getByLabelText('Translation'));
  });

  it('keeps the same unit and its typed draft when the queue rebuilds around it (a reload after a job finishes can resort it)', async () => {
    const user = userEvent.setup();
    const a = makeUnit('A', 'A SOURCE', { groupKey: 'Hud' });
    const b = makeUnit('B', 'B SOURCE', { groupKey: 'Hud' });
    const c = makeUnit('C', 'C SOURCE', { groupKey: 'Hud' });
    const fake = createFakeApi({
      units: [a, b, c],
      cells: {
        ru: {
          [a.id]: makeCell(a.id, 'ru', { text: 'a', status: 'ai_draft', band: 'Y' }),
          [b.id]: makeCell(b.id, 'ru', { text: 'b', status: 'ai_draft', band: 'Y' }),
          [c.id]: makeCell(c.id, 'ru', { text: 'c', status: 'ai_draft', band: 'Y' }),
        },
      },
    });
    const api = new LocHubApi('', fake.fetch);
    const bridge = new EditorBridge(api, () => undefined);
    const rows = rowsFromState(fake.state, ['ru']);

    const { rerender } = render(<QueueView api={api} bridge={bridge} rows={rows} culture="ru" editorConnected={false} onCell={() => {}} />);

    expect(screen.getByText('A SOURCE')).toBeTruthy();
    await user.keyboard('j'); // move to B
    expect(screen.getByText('B SOURCE')).toBeTruthy();

    const translation = screen.getByLabelText('Translation') as HTMLTextAreaElement;
    await user.type(translation, '-draft');
    expect(translation.value).toBe('b-draft');

    // Simulate a reload after a job finishes: a fresh red draft lands ahead of B in rank order (red/needs-fix
    // sorts before yellow), reshuffling every position after it.
    const z = makeUnit('Z', 'Z SOURCE', { groupKey: 'Hud' });
    const zRow: GridRow = { unit: z, cells: { ru: { cell: makeCell(z.id, 'ru', { text: '', status: 'ai_draft', band: 'R' }), outdated: false } } };
    rerender(<QueueView api={api} bridge={bridge} rows={[zRow, ...rows]} culture="ru" editorConnected={false} onCell={() => {}} />);

    expect(screen.getByText('B SOURCE')).toBeTruthy(); // still the same card, not whatever landed at the old numeric slot
    expect((screen.getByLabelText('Translation') as HTMLTextAreaElement).value).toBe('b-draft'); // the draft survived
  });

  // UX approve brief item 2: the A hotkey calls the imperative handle directly, bypassing the DOM button's own
  // disabled attribute, so CellPanel must gate it itself instead of silently swallowing the key press.
  it('does not call approve via the A hotkey while Approve is blocked, and shows the same notice instead', async () => {
    const user = userEvent.setup();
    const red = makeUnit('Red', 'RED SOURCE', { groupKey: 'Pause' });
    const fake = createFakeApi({
      units: [red],
      cells: { ru: { [red.id]: makeCell(red.id, 'ru', { text: 'красный {Broken}', status: 'needs_fix', band: 'R' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<Harness api={api} initial={rowsFromState(fake.state, ['ru'])} />);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Approve (A)' }) as HTMLButtonElement).disabled).toBe(true));

    await user.keyboard('a');
    expect(await screen.findByText('Fix the problems above first')).toBeTruthy();
    // The card's own live check still POSTs on open; only the actual approve/edit/reject actions must be absent.
    expect(fake.calls.filter((call) => call.startsWith('POST') && !call.endsWith('/check'))).toEqual([]);
  });

  // Check tiers: overriding a 'confirm' issue takes the explicit "Approve anyway" click, never the A hotkey.
  it('does not approve a confirm-only text via the A hotkey, and says to check the warnings', async () => {
    const user = userEvent.setup();
    const count = makeUnit('Count', '{Count} LEFT', { groupKey: 'Pause' });
    const fake = createFakeApi({
      units: [count],
      cells: { ru: { [count.id]: makeCell(count.id, 'ru', { text: 'осталось', status: 'ai_draft', band: 'R' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    render(<Harness api={api} initial={rowsFromState(fake.state, ['ru'])} />);
    await screen.findByRole('button', { name: 'Approve anyway' });

    await user.keyboard('a');
    expect(await screen.findByText('Check the warnings, then click Approve anyway.')).toBeTruthy();
    expect(fake.calls.filter((call) => call.startsWith('POST') && !call.endsWith('/check'))).toEqual([]);
  });
});
