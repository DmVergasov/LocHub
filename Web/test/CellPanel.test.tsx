import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocHubApi } from '../src/api/client';
import type { Cell } from '../src/api/types';
import { EditorBridge, type UeLocHubBinding } from '../src/bridge';
import type { GridRow } from '../src/grid/model';
import { CellPanel } from '../src/review/CellPanel';
import { createFakeApi, makeCell, makeUnit, rowsFromState } from './fakeApi';

// Mirrors how App/QueueView wire onCell in production: the row shown is the one just written back, so a second
// action sends the revision the reviewer actually saw. A bare vi.fn() that never updates `row` would make the
// component's own second action look stale to the optimistic-concurrency check.
function Harness({ api, bridge, initialRow, culture, onCellSpy }: { api: LocHubApi; bridge: EditorBridge; initialRow: GridRow; culture: string; onCellSpy: (cell: Cell) => void }) {
  const [row, setRow] = useState(initialRow);
  const onCell = (cell: Cell) => {
    onCellSpy(cell);
    setRow((current) => ({ ...current, cells: { ...current.cells, [cell.culture]: { cell, outdated: false } } }));
  };
  return <CellPanel api={api} bridge={bridge} row={row} culture={culture} editorConnected={false} neighbors={[]} onCell={onCell} />;
}

function setup(binding?: UeLocHubBinding) {
  const unit = makeUnit('Bales', '{Count} bales left');
  const fake = createFakeApi({
    units: [unit],
    cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y', alts: ['Ещё {Count} тюков', 'Тюков: {Count}'] }) } },
  });
  const api = new LocHubApi('', fake.fetch);
  const onCell = vi.fn();
  const row = rowsFromState(fake.state, ['ru'])[0]!;
  render(<Harness api={api} bridge={new EditorBridge(api, () => binding)} initialRow={row} culture="ru" onCellSpy={onCell} />);
  return { fake, onCell };
}

describe('CellPanel', () => {
  it('approves the text as shown, and saves a changed draft as an edit', async () => {
    const user = userEvent.setup();
    const { fake, onCell } = setup();
    await user.click(screen.getByRole('button', { name: 'Approve (A)' }));
    await waitFor(() => expect(onCell).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' })));
    await user.click(screen.getByRole('button', { name: 'Use 2' }));
    expect((screen.getByLabelText('Translation') as HTMLTextAreaElement).value).toBe('Тюков: {Count}');
    await user.click(screen.getByRole('button', { name: 'Approve (A)' }));
    await waitFor(() => expect(onCell).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'edited', text: 'Тюков: {Count}' })));
    // The live format check (item 1 of the UX approve brief) also fires POSTs of its own as the draft changes;
    // this assertion is only about the actions the two clicks took.
    expect(fake.calls.filter((call) => call.startsWith('POST') && !call.endsWith('/check'))).toEqual(['POST /api/cells/ru/id-Bales/approve', 'POST /api/cells/ru/id-Bales/edit']);
  });

  it('shows precheck issues of a rejected edit', async () => {
    const user = userEvent.setup();
    setup();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    await user.click(screen.getByRole('button', { name: 'Save edit' }));
    expect(await screen.findByText('Unknown arguments: Broken')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Precheck failed');
  });

  it('keeps the reject reason when the reject fails, and clears it after a successful reject', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    const units = fake.state.units;
    fake.state.units = [];
    const reason = screen.getByLabelText('Reject reason') as HTMLInputElement;
    await user.type(reason, 'Wrong case');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Unknown unit id-Bales');
    expect(reason.value).toBe('Wrong case');
    fake.state.units = units;
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reason.value).toBe(''));
  });

  it('offers a copyable path instead of Open when no editor is reachable', () => {
    setup();
    expect(screen.getByText('Source/MyGame/Private/Bales.cpp:10')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy path' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect((screen.getByRole('button', { name: 'Apply live' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the origin and applies the draft through the editor binding', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    setup({
      openorigin: (origin) => {
        seen.push(origin);
        return true;
      },
      setpreviewculture: () => true,
      applylive: (culture, json) => {
        seen.push(`${culture} ${json}`);
        return true;
      },
    });
    await user.click(screen.getByRole('button', { name: 'Open Source/MyGame/Private/Bales.cpp:10' }));
    await user.click(screen.getByRole('button', { name: 'Apply live' }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toBe('Source/MyGame/Private/Bales.cpp(10)');
    expect(JSON.parse(seen[1]!.slice(3))).toEqual([{ namespace: 'HW', key: 'Bales', source: '{Count} bales left', translation: 'Осталось {Count} тюков' }]);
  });

  it('sends a context question to the inbox', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    await user.type(screen.getByLabelText('Context question'), 'Bales of hay or of cotton?');
    await user.click(screen.getByRole('button', { name: 'Ask for context' }));
    expect(await screen.findByText('Question sent to the Inbox.')).toBeTruthy();
    expect(fake.state.inbox[0]).toMatchObject({ unitId: 'id-Bales', culture: 'ru', question: 'Bales of hay or of cotton?' });
  });

  it('a stale approve shows the service message, refreshes the card and writes nothing', async () => {
    const user = userEvent.setup();
    const { fake, onCell } = setup();
    // The unit's sourceRev moved (e.g. a Push) after this card loaded, so the expectedSourceRev it sends is stale.
    fake.state.units = fake.state.units.map((u) => (u.id === 'id-Bales' ? { ...u, sourceRev: u.sourceRev + 1 } : u));
    await user.click(screen.getByRole('button', { name: 'Approve (A)' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This string changed since you opened it (new source text or a newer translation). Review it again.',
    );
    expect(onCell).toHaveBeenCalledWith(expect.objectContaining({ unitId: 'id-Bales', status: 'ai_draft' }));
    expect(fake.state.cells.ru?.['id-Bales']?.status).toBe('ai_draft');
  });

  it('passes the fake unit to onUnit on a stale answer', async () => {
    const user = userEvent.setup();
    const unit = makeUnit('Bales', '{Count} bales left');
    const fake = createFakeApi({ units: [unit], cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft' }) } } });
    const api = new LocHubApi('', fake.fetch);
    const onCell = vi.fn();
    const onUnit = vi.fn();
    const row = rowsFromState(fake.state, ['ru'])[0]!;
    render(<CellPanel api={api} bridge={new EditorBridge(api, () => undefined)} row={row} culture="ru" editorConnected={false} neighbors={[]} onCell={onCell} onUnit={onUnit} />);
    fake.state.units = fake.state.units.map((u) => (u.id === unit.id ? { ...u, sourceRev: 2 } : u));
    await user.click(screen.getByRole('button', { name: 'Approve (A)' }));
    await waitFor(() => expect(onUnit).toHaveBeenCalledWith(expect.objectContaining({ id: unit.id, sourceRev: 2 })));
  });

  it('reloads history after Translate again', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    const before = fake.calls.filter((call) => call.endsWith('/history')).length;
    await user.type(screen.getByLabelText('Retranslate note'), 'Use plural');
    await user.click(screen.getByRole('button', { name: 'Translate again' }));
    await screen.findByText('New suggestion below.');
    const after = fake.calls.filter((call) => call.endsWith('/history')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('shows a message when the clipboard copy fails', async () => {
    const user = userEvent.setup();
    setup();
    const original = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    try {
      await user.click(screen.getByRole('button', { name: 'Copy path' }));
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Copy failed — select the path and copy it by hand.');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
    }
  });
});

// UX approve brief (2026-09-26): a live format check runs as the card opens and as the draft changes, and
// Approve/Save edit are disabled while it (or a known needs_fix rule) would refuse the click.
describe('CellPanel — live check gates Approve and Save edit', () => {
  const approveButton = () => screen.getByRole('button', { name: 'Approve (A)' }) as HTMLButtonElement;
  const saveButton = () => screen.getByRole('button', { name: 'Save edit' }) as HTMLButtonElement;
  const FIX_TITLE = 'Fix the problems above first';

  it('disables Approve (with the title) once the draft has a hard issue, and re-enables it once fixed', async () => {
    const user = userEvent.setup();
    setup();
    await waitFor(() => expect(approveButton().disabled).toBe(false));
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    await waitFor(() => expect(approveButton().disabled).toBe(true));
    expect(approveButton().title).toBe(FIX_TITLE);

    await user.clear(field);
    await user.type(field, 'Ещё {{Count} тюков'); // "{{" types a literal "{" (userEvent's own escape syntax)
    await waitFor(() => expect(approveButton().disabled).toBe(false));
  });

  it('never blocks Approve on a soft-only (untranslated) issue', async () => {
    const user = userEvent.setup();
    setup();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, '{{Count} bales left'); // identical to the source: soft 'untranslated' only
    await screen.findByText('Translation is identical to the source');
    expect(approveButton().disabled).toBe(false);
  });

  // Check tiers: the service re-checks a needs_fix cell instead of refusing it outright, so its text decides.
  it('lets a needs_fix draft through when its text passes, without an edit', async () => {
    const unit = makeUnit('Bales', '{Count} bales left');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'needs_fix', band: 'R' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    const row = rowsFromState(fake.state, ['ru'])[0]!;
    render(<CellPanel api={api} bridge={new EditorBridge(api, () => undefined)} row={row} culture="ru" editorConnected={false} neighbors={[]} onCell={() => {}} />);
    await waitFor(() => expect(fake.calls.some((call) => call.endsWith('/check'))).toBe(true));
    expect(approveButton().disabled).toBe(false);
  });

  it('disables Save edit (with the title) for a hard issue', async () => {
    const user = userEvent.setup();
    setup();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(saveButton().title).toBe(FIX_TITLE);
  });

  it('leaves Approve enabled when the live check itself fails (network/500), and shows no error banner', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    fake.state.checkFails = true;
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(approveButton().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let a stale check response overwrite a newer one', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    fake.state.holdChecks = true;
    const field = screen.getByLabelText('Translation');

    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}'); // hard issue, sent first
    await waitFor(() => expect(fake.pendingChecks.length).toBe(1));

    await user.clear(field);
    await user.type(field, 'Ещё {{Count} тюков'); // no issues, sent second
    await waitFor(() => expect(fake.pendingChecks.length).toBe(2));

    fake.pendingChecks[1]!.resolve(); // the newer request answers first
    await waitFor(() => expect(approveButton().disabled).toBe(false));

    fake.pendingChecks[0]!.resolve(); // the stale hard-issue response arrives late; must be ignored
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(approveButton().disabled).toBe(false);
  });

  // I-1: a retranslate's suggestion has its own issues (computed for the suggestion text, not the draft) and
  // must never gate Approve/Save edit for the reviewer's current, unrelated draft.
  it('does not let a hard issue on the new suggestion block a valid, unchanged draft', async () => {
    const user = userEvent.setup();
    const { fake } = setup();
    fake.state.retranslateIssues = [{ code: 'args_extra', severity: 'hard', message: 'Unknown arguments: Cnt' }];
    await waitFor(() => expect(approveButton().disabled).toBe(false));

    await user.type(screen.getByLabelText('Retranslate note'), 'Use plural');
    await user.click(screen.getByRole('button', { name: 'Translate again' }));
    await screen.findByText('New suggestion below.');

    expect(approveButton().disabled).toBe(false);
    expect(saveButton().disabled).toBe(true); // saveDisabled also requires draft !== cell.text; unrelated to I-1
    expect(screen.getByText('Unknown arguments: Cnt')).toBeTruthy(); // shown, but only next to the suggestion
  });

  // I-1 reverse case: a draft that already has a hard issue must stay blocked after a retranslate, even though
  // clearMessages() runs as part of that action and the suggestion itself came back clean.
  it('keeps a hard-issue draft blocked after Translate again', async () => {
    const user = userEvent.setup();
    setup();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    await waitFor(() => expect(approveButton().disabled).toBe(true));

    await user.type(screen.getByLabelText('Retranslate note'), 'Use plural');
    await user.click(screen.getByRole('button', { name: 'Translate again' }));
    await screen.findByText('New suggestion below.');

    expect(approveButton().disabled).toBe(true);
  });
});

// Check tiers (owner-approved): a 'hard' issue (Unreal rejects the text) blocks the buttons; a 'confirm' issue
// (valid for Unreal, looks wrong) keeps them enabled as "Approve anyway" / "Save anyway", and the click sends the
// confirm codes it showed as `accept`.
describe('CellPanel — confirm issues can be approved anyway', () => {
  const WARNING_LINE = 'Unreal accepts this text, but it looks wrong. Approve anyway if it is intended.';

  function setupConfirm(status: Cell['status'] = 'ai_draft') {
    const unit = makeUnit('Bales', '{Count} bales left');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Тюков осталось', status, band: 'R' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    const onCell = vi.fn();
    const row = rowsFromState(fake.state, ['ru'])[0]!;
    render(<Harness api={api} bridge={new EditorBridge(api, () => undefined)} initialRow={row} culture="ru" onCellSpy={onCell} />);
    return { fake, onCell };
  }

  it('keeps Approve enabled as "Approve anyway", shows the warning line, and sends accept', async () => {
    const user = userEvent.setup();
    const { fake, onCell } = setupConfirm();
    const approve = (await screen.findByRole('button', { name: 'Approve anyway' })) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    expect(screen.getByText(WARNING_LINE)).toBeTruthy();
    expect(screen.getByText('Missing arguments: Count').closest('ul')?.classList.contains('confirm')).toBe(true);

    await user.click(approve);
    await waitFor(() => expect(onCell).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' })));
    expect(fake.requests.find((r) => r.path.endsWith('/approve'))?.body).toMatchObject({ accept: ['args_missing'] });
  });

  it('labels Save edit "Save anyway" for a confirm-only draft and sends accept', async () => {
    const user = userEvent.setup();
    const { fake, onCell } = setupConfirm();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Тюков нет');
    const save = (await screen.findByRole('button', { name: 'Save anyway' })) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    await waitFor(() => expect(onCell).toHaveBeenCalledWith(expect.objectContaining({ status: 'edited', text: 'Тюков нет' })));
    expect(fake.requests.find((r) => r.path.endsWith('/edit'))?.body).toMatchObject({ text: 'Тюков нет', accept: ['args_missing'] });
  });

  it('a needs_fix cell with only confirm issues can be approved anyway without an edit', async () => {
    setupConfirm('needs_fix');
    expect(((await screen.findByRole('button', { name: 'Approve anyway' })) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a hard issue still disables the buttons, with no "anyway" labels and no warning line', async () => {
    const user = userEvent.setup();
    setupConfirm();
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Тюков {{Broken}');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Approve (A)' }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Save edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(WARNING_LINE)).toBeNull();
  });

  it('shows an accepted approve in the history as one line', async () => {
    const user = userEvent.setup();
    setupConfirm();
    await user.click(await screen.findByRole('button', { name: 'Approve anyway' }));
    expect(await screen.findByText(/reviewer approved anyway \(args_missing\): Тюков осталось to Тюков осталось/)).toBeTruthy();
  });
});

// UX approve brief item 9: the neighbours table needs a visible label so it doesn't read as an unlabeled row.
describe('CellPanel — neighbours table caption', () => {
  it('shows the caption when the group has other strings', () => {
    const unit = makeUnit('Bales', '{Count} bales left');
    const neighbor = makeUnit('Sacks', 'SACK SOURCE');
    const fake = createFakeApi({
      units: [unit, neighbor],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    const rows = rowsFromState(fake.state, ['ru']);
    render(
      <CellPanel
        api={api}
        bridge={new EditorBridge(api, () => undefined)}
        row={rows[0]!}
        culture="ru"
        editorConnected={false}
        neighbors={[rows[1]!]}
        onCell={() => {}}
      />,
    );
    expect(screen.getByText('Other strings in this group')).toBeTruthy();
  });

  it('renders no caption (or table) when the group has no other strings', () => {
    setup();
    expect(screen.queryByText('Other strings in this group')).toBeNull();
  });
});
