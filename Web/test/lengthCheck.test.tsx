import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge } from '../src/bridge';
import { mergeCulture, withCell, withUnit, type GridRow } from '../src/grid/model';
import { CellPanel } from '../src/review/CellPanel';
import { createFakeApi, makeCell, makeUnit, rowsFromState } from './fakeApi';

const COUNTER_TITLE = 'Visible characters / Length Check limit';

describe('grid model: Length Check limits', () => {
  const unit = makeUnit('Pause', 'PAUSED');
  const merged = () => mergeCulture(new Map(), 'ru', [{ unit, cell: makeCell(unit.id, 'ru', { text: 'ПАУЗА' }), outdated: false, lengthLimit: 12 }]);

  it("keeps each row's lengthLimit on its culture cell", () => {
    expect(merged().get(unit.id)!.cells.ru!.lengthLimit).toBe(12);
  });

  it('keeps the limit when a cell is written back', () => {
    const next = withCell(merged(), makeCell(unit.id, 'ru', { text: 'СТОП' }));
    expect(next.get(unit.id)!.cells.ru).toMatchObject({ cell: expect.objectContaining({ text: 'СТОП' }), lengthLimit: 12 });
  });

  it('keeps the limit for an unchanged source, and drops it once the source changed under the reviewer', () => {
    expect(withUnit(merged(), { ...unit, sourceRev: 2 }).get(unit.id)!.cells.ru!.lengthLimit).toBe(12);
    expect(withUnit(merged(), { ...unit, source: 'GAME PAUSED', sourceRev: 2 }).get(unit.id)!.cells.ru!.lengthLimit).toBeUndefined();
  });

  it("re-merging a changed unit keeps the incoming culture's new limit and drops the other cultures' stale ones", () => {
    let data = mergeCulture(merged(), 'de', [{ unit, cell: makeCell(unit.id, 'de', { text: 'PAUSE' }), outdated: false, lengthLimit: 12 }]);
    const changed = { ...unit, source: 'GAME PAUSED', sourceRev: 2 };
    data = mergeCulture(data, 'ru', [{ unit: changed, cell: makeCell(unit.id, 'ru', { text: 'ИГРА НА ПАУЗЕ' }), outdated: false, lengthLimit: 19 }]);
    expect(data.get(unit.id)!.cells.ru!.lengthLimit).toBe(19);
    expect(data.get(unit.id)!.cells.de!.lengthLimit).toBeUndefined();
  });
});

describe('CellPanel: Length Check counter', () => {
  // 'Осталось {Count} тюков' has 15 visible characters: the argument counts 0.
  function renderPanel(lengthLimit: number | null | undefined) {
    const unit = makeUnit('Bales', '{Count} bales left');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y' }) } },
    });
    const api = new LocHubApi('', fake.fetch);
    const row = rowsFromState(fake.state, ['ru'])[0]!;
    const limited: GridRow = { ...row, cells: { ru: { ...row.cells.ru!, lengthLimit } } };
    render(<CellPanel api={api} bridge={new EditorBridge(api, () => undefined)} row={limited} culture="ru" editorConnected={false} neighbors={[]} onCell={() => {}} />);
  }

  it('shows the visible length of the draft against the limit', () => {
    renderPanel(20);
    const counter = screen.getByTitle(COUNTER_TITLE);
    expect(counter.textContent).toBe('15/20');
    expect(counter.className).toBe('length-counter');
  });

  it('turns into a warning once the draft is over the limit, as the reviewer types', async () => {
    const user = userEvent.setup();
    renderPanel(20);
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось совсем немного тюков');
    const counter = screen.getByTitle(COUNTER_TITLE);
    expect(counter.textContent).toBe('29/20');
    expect(counter.className).toBe('length-counter over');
  });

  it('is hidden when the string has no limit', () => {
    renderPanel(null);
    expect(screen.queryByTitle(COUNTER_TITLE)).toBeNull();
  });

  it('is hidden with an older service that sends no limit at all', () => {
    renderPanel(undefined);
    expect(screen.queryByTitle(COUNTER_TITLE)).toBeNull();
  });
});

// M-2: a Warning-level too_long is a hint that blocks nothing (unlike a hard issue), so it must not read as the
// same blocking-error red the issues list defaults to.
describe('CellPanel: too_long issue style (M-2)', () => {
  function renderPanelWithLimit(limit: number, severity: 'soft' | 'confirm' = 'soft') {
    const unit = makeUnit('Bales', '{Count} bales left');
    const fake = createFakeApi({
      units: [unit],
      cells: { ru: { [unit.id]: makeCell(unit.id, 'ru', { text: 'Осталось {Count} тюков', status: 'ai_draft', band: 'Y' }) } },
    });
    fake.state.lengthLimits = { [unit.id]: limit };
    fake.state.lengthCheckSeverity = severity;
    const api = new LocHubApi('', fake.fetch);
    const row = rowsFromState(fake.state, ['ru'])[0]!;
    render(<CellPanel api={api} bridge={new EditorBridge(api, () => undefined)} row={row} culture="ru" editorConnected={false} neighbors={[]} onCell={() => {}} />);
  }

  it('draws a Warning-level (soft) too_long hint in the warning style, not the blocking-error red', async () => {
    renderPanelWithLimit(10); // 'Осталось {Count} тюков' is 15 visible characters, already over 10
    const issue = await screen.findByText('Too long for the UI: 15/10 characters (Length Check in Project Settings)');
    expect(issue.tagName).toBe('LI');
    expect(issue.className).toBe('soft');
  });

  it('keeps the blocking-error red for a hard issue in the same list', async () => {
    const user = userEvent.setup();
    renderPanelWithLimit(10);
    await screen.findByText('Too long for the UI: 15/10 characters (Length Check in Project Settings)');
    const field = screen.getByLabelText('Translation');
    await user.clear(field);
    await user.type(field, 'Осталось {{Broken}');
    const hardIssue = await screen.findByText('Unknown arguments: Broken');
    expect(hardIssue.className).toBe('');
  });
});
