import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocHubApi } from '../src/api/client';
import { EditorBridge, type UeLocHubBinding } from '../src/bridge';
import { GridView } from '../src/grid/GridView';
import { popoverTop } from '../src/grid/KeyDetails';
import { filterRows, NO_FILTERS, type GridFilters, type GridRow } from '../src/grid/model';
import { createFakeApi, makeCell, makeUnit } from './fakeApi';

// A counting wrapper around the real filterRows (every other export of the module passes through unchanged), so
// the memoization test below can tell how many times the hot per-keystroke path actually ran.
vi.mock('../src/grid/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/grid/model')>();
  return { ...actual, filterRows: vi.fn(actual.filterRows) };
});

function bigGrid(count: number): GridRow[] {
  return Array.from({ length: count }, (_, i) => {
    const unit = makeUnit(`K${i}`, `Source ${i}`);
    return { unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { text: `Перевод ${i}`, status: 'ai_draft', band: 'G' }), outdated: false } } };
  });
}

// Same convention as CellPanel.test.tsx: a real EditorBridge with a fake window.ue.lochub binding (direct route)
// or none at all (relay/none route, depending on editorConnected).
function makeBridge(binding?: UeLocHubBinding): EditorBridge {
  const api = new LocHubApi('', createFakeApi().fetch);
  return new EditorBridge(api, () => binding);
}

function renderGrid(
  rows: GridRow[],
  q = '',
  onOpenCell = vi.fn(),
  bridge: EditorBridge = makeBridge(),
  editorConnected = false,
  cultures: string[] = ['ru'],
  visible: string[] = cultures,
  onVisible = vi.fn(),
  scrollMemory: { top: number; left: number } = { top: 0, left: 0 },
  // Every culture already loaded and no fetch in flight: the shape most tests here want (a grid that already has
  // its data), so a test about something else does not have to spell these two out itself.
  loadedCultures: readonly string[] = cultures,
  loading = false,
) {
  return render(
    <GridView
      rows={rows}
      cultures={cultures}
      visible={visible}
      onVisible={onVisible}
      culture="ru"
      nativeCulture="en"
      filters={{ ...NO_FILTERS, q }}
      onFilters={() => undefined}
      onOpenCell={onOpenCell}
      onApplyLive={() => undefined}
      canApplyLive={false}
      bridge={bridge}
      editorConnected={editorConnected}
      scrollMemory={scrollMemory}
      loadedCultures={loadedCultures}
      loading={loading}
    />,
  );
}

function keyDetailsDialog() {
  return screen.getByRole('dialog', { name: 'Key details' });
}

describe('GridView', () => {
  it('renders only a window of 10 000 rows', () => {
    const { container } = renderGrid(bigGrid(10_000));
    const rendered = container.querySelectorAll('.grid-row').length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
    expect(screen.getByText('10000 of 10000 strings')).toBeTruthy();
  });

  it('searches across all rows, not only the rendered ones', () => {
    renderGrid(bigGrid(10_000), 'Source 42');
    expect(screen.getByText('111 of 10000 strings')).toBeTruthy();
  });

  it('keeps the header inside the single .grid-scroll scroller, so header and body scroll together on both axes', () => {
    renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }]);
    const scroller = document.querySelector('.grid-scroll') as HTMLElement;
    expect(scroller.querySelector('.grid-header')).toBeTruthy();
  });

  describe('fluid columns (layout D)', () => {
    it('uses a px width for Key and minmax( for Source and each visible culture, so columns grow with the window', () => {
      renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'ru'], ['ru']);
      const header = document.querySelector('.grid-header') as HTMLElement;
      const columns = header.style.gridTemplateColumns;
      const tracks = columns.split(' minmax(');
      expect(tracks[0]).toMatch(/^\d+px$/);
      expect(columns.match(/minmax\(/g)?.length).toBe(2); // Source + the one visible culture (ru; de is hidden)
    });

    it('gives the header and the body a min-width and no fixed width, so they stretch to the scroller', () => {
      renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }], '', vi.fn(), makeBridge(), false, ['ru'], ['ru']);
      const header = document.querySelector('.grid-header') as HTMLElement;
      const body = document.querySelector('.grid-body') as HTMLElement;
      expect(header.style.minWidth).not.toBe('');
      expect(header.style.width).toBe('');
      expect(body.style.minWidth).not.toBe('');
      expect(body.style.width).toBe('');
    });

    it('grows the min-width with the number of visible culture columns', () => {
      renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['ru']);
      const oneCulture = Number.parseInt(document.querySelector('.grid-header')!.getAttribute('style')!.match(/min-width:\s*(\d+)px/)![1]!, 10);
      renderGrid([{ unit: makeUnit('K1', 'Source 1'), cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['de', 'fr', 'ru']);
      const headers = document.querySelectorAll('.grid-header');
      const threeCultures = Number.parseInt(headers[headers.length - 1]!.getAttribute('style')!.match(/min-width:\s*(\d+)px/)![1]!, 10);
      expect(threeCultures).toBeGreaterThan(oneCulture);
    });

    it('gives the key cell an ellipsis class, so a long hex key does not overflow into Source', () => {
      renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }]);
      const keyButton = screen.getByRole('button', { name: 'K0' });
      expect(keyButton.className).toContain('ellipsis');
    });
  });

  it('opens the card of a clicked culture cell', () => {
    const onOpenCell = vi.fn();
    renderGrid(bigGrid(3), '', onOpenCell);
    fireEvent.click(screen.getByText('Перевод 1'));
    expect(onOpenCell).toHaveBeenCalledWith('ru', 'id-K1');
  });

  describe('key details popover', () => {
    it('opens with namespace, key, "Asset", the package path and the member for an asset origin', () => {
      const unit = makeUnit('E_Gait', 'Gait names', {
        namespace: '',
        origin: '/Game/Blueprints/Data/E_Gait.E_Gait.DisplayNameMap(0 - Value).DisplayNameMap',
      });
      renderGrid([{ unit, cells: {} }]);
      fireEvent.click(screen.getByRole('button', { name: 'E_Gait' }));
      const dialog = keyDetailsDialog();
      expect(within(dialog).getByText('(none)')).toBeTruthy();
      expect(within(dialog).getByText('E_Gait')).toBeTruthy();
      expect(within(dialog).getByText('Asset')).toBeTruthy();
      expect(within(dialog).getByText('/Game/Blueprints/Data/E_Gait')).toBeTruthy();
      expect(within(dialog).getByText('E_Gait.DisplayNameMap(0 - Value).DisplayNameMap')).toBeTruthy();
    });

    it('shows a C++ file as "C++ file" with path:line, and an empty origin as "Unknown"', () => {
      const cpp = makeUnit('Cpp', 'Cpp source'); // default origin Source/MyGame/Private/Cpp.cpp(10)
      const empty = makeUnit('Empty', 'Empty source', { origin: '' });
      renderGrid([
        { unit: cpp, cells: {} },
        { unit: empty, cells: {} },
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'Cpp' }));
      let dialog = keyDetailsDialog();
      expect(within(dialog).getByText('C++ file')).toBeTruthy();
      expect(within(dialog).getByText('Source/MyGame/Private/Cpp.cpp:10')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
      dialog = keyDetailsDialog();
      expect(within(dialog).getByText('Unknown')).toBeTruthy();
      expect(within(dialog).getByText('unknown')).toBeTruthy();
    });

    it('calls bridge.openOrigin from "Open in editor" when connected; offers only "Copy path" when not', () => {
      const unit = makeUnit('Bales', 'Bales source', { origin: '/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Text' });
      const seen: string[] = [];
      const bridge = makeBridge({
        openorigin: (origin) => {
          seen.push(origin);
          return true;
        },
        setpreviewculture: () => true,
        applylive: () => true,
      });
      renderGrid([{ unit, cells: {} }], '', vi.fn(), bridge, true);
      fireEvent.click(screen.getByRole('button', { name: 'Bales' }));
      const dialog = keyDetailsDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Open in editor' }));
      expect(seen).toEqual(['/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Text']);
      expect(within(dialog).queryByRole('button', { name: 'Copy path' })).toBeNull();
    });

    it('offers "Copy path" and no Open button when the editor is disconnected', () => {
      const unit = makeUnit('Bales', 'Bales source', { origin: '/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Text' });
      renderGrid([{ unit, cells: {} }], '', vi.fn(), makeBridge(undefined), false);
      fireEvent.click(screen.getByRole('button', { name: 'Bales' }));
      const dialog = keyDetailsDialog();
      expect(within(dialog).queryByRole('button', { name: 'Open in editor' })).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Copy path' })).toBeTruthy();
    });

    it('closes on Escape and returns focus to the key button; clicking a second key switches to it', () => {
      const first = makeUnit('First', 'First source');
      const second = makeUnit('Second', 'Second source', { namespace: 'Other' });
      renderGrid([
        { unit: first, cells: {} },
        { unit: second, cells: {} },
      ]);
      const firstButton = screen.getByRole('button', { name: 'First' });
      fireEvent.click(firstButton);
      expect(keyDetailsDialog()).toBeTruthy();
      const secondButton = screen.getByRole('button', { name: 'Second' });
      fireEvent.click(secondButton);
      const dialog = keyDetailsDialog();
      expect(within(dialog).getByText('Second')).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Key details' })).toBeNull();
      expect(document.activeElement).toBe(secondButton);
    });

    it('closes when the grid scrolls', () => {
      const unit = makeUnit('Scrolled', 'Scrolled source');
      renderGrid([{ unit, cells: {} }]);
      fireEvent.click(screen.getByRole('button', { name: 'Scrolled' }));
      expect(screen.queryByRole('dialog', { name: 'Key details' })).toBeTruthy();
      fireEvent.scroll(document.querySelector('.grid-scroll')!);
      expect(screen.queryByRole('dialog', { name: 'Key details' })).toBeNull();
    });

    it('places the popover below the key, above it when it does not fit below, and pinned when it fits neither', () => {
      const anchor = { top: 100, bottom: 120 };
      expect(popoverTop(anchor, 200, 800)).toBe(124);
      const low = { top: 700, bottom: 720 };
      expect(popoverTop(low, 200, 800)).toBe(496);
      expect(popoverTop({ top: 150, bottom: 170 }, 700, 800)).toBe(92);
      expect(popoverTop(anchor, 900, 800)).toBe(8);
    });

    it('clicking the same key again closes the dialog', () => {
      const unit = makeUnit('Toggle', 'Toggle source');
      renderGrid([{ unit, cells: {} }]);
      const button = screen.getByRole('button', { name: 'Toggle' });
      fireEvent.click(button);
      expect(screen.queryByRole('dialog', { name: 'Key details' })).toBeTruthy();
      fireEvent.click(button);
      expect(screen.queryByRole('dialog', { name: 'Key details' })).toBeNull();
    });

    it('shows Kind from metadata and other metadata rows; omits the Kind row when absent', () => {
      const withKind = makeUnit('WithKind', 'Source A', { metadata: { 'LocHub.Kind': 'Quest', Team: 'Design' } });
      const withoutKind = makeUnit('NoKind', 'Source B', { metadata: { Team: 'Design' } });
      renderGrid([
        { unit: withKind, cells: {} },
        { unit: withoutKind, cells: {} },
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'WithKind' }));
      let dialog = keyDetailsDialog();
      expect(within(dialog).getByText('Kind')).toBeTruthy();
      expect(within(dialog).getByText('Quest')).toBeTruthy();
      expect(within(dialog).getByText('Team')).toBeTruthy();
      expect(within(dialog).getByText('Design')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'NoKind' }));
      dialog = keyDetailsDialog();
      expect(within(dialog).queryByText('Kind')).toBeNull();
    });
  });

  describe('columns picker', () => {
    it('renders only the visible culture columns, not every project culture', () => {
      const unit = makeUnit('K0', 'Source 0');
      renderGrid([{ unit, cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['fr', 'ru']);
      const header = document.querySelector('.grid-header') as HTMLElement;
      expect(within(header).queryByText('de')).toBeNull();
      expect(within(header).getByText('fr')).toBeTruthy();
      expect(within(header).getByText('ru')).toBeTruthy();
    });

    it('shows the count in the "Columns" button label when more than one culture is visible', () => {
      renderGrid([{ unit: makeUnit('K0', 'Source 0'), cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['ru']);
      expect(screen.getByRole('button', { name: 'Columns' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('checkbox', { name: 'fr' }));
    });

    it('opens a popover listing every project culture; the active culture is checked and disabled', () => {
      const unit = makeUnit('K0', 'Source 0');
      renderGrid([{ unit, cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['ru']);
      const button = screen.getByRole('button', { name: 'Columns' });
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
      const popover = screen.getByRole('dialog', { name: 'Columns' });
      const de = within(popover).getByRole('checkbox', { name: 'de' }) as HTMLInputElement;
      const ru = within(popover).getByRole('checkbox', { name: 'ru' }) as HTMLInputElement;
      expect(de.checked).toBe(false);
      expect(de.disabled).toBe(false);
      expect(ru.checked).toBe(true);
      expect(ru.disabled).toBe(true);
      expect(ru.title).toBe('The active culture is always shown');
    });

    it('toggling a checkbox calls onVisible with the new visible list', () => {
      const onVisible = vi.fn();
      const unit = makeUnit('K0', 'Source 0');
      renderGrid([{ unit, cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['ru'], onVisible);
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      const popover = screen.getByRole('dialog', { name: 'Columns' });
      fireEvent.click(within(popover).getByRole('checkbox', { name: 'fr' }));
      expect(onVisible).toHaveBeenCalledWith(['fr', 'ru']);
    });

    it('closes the popover on Escape', () => {
      const unit = makeUnit('K0', 'Source 0');
      renderGrid([{ unit, cells: {} }], '', vi.fn(), makeBridge(), false, ['de', 'fr', 'ru'], ['ru']);
      fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
      expect(screen.queryByRole('dialog', { name: 'Columns' })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Columns' })).toBeNull();
    });
  });

  describe('filter pills', () => {
    function renderWithFilters(filters: GridFilters, onFilters = vi.fn()) {
      render(
        <GridView
          rows={bigGrid(2)}
          cultures={['ru']}
          visible={['ru']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={filters}
          onFilters={onFilters}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={['ru']}
          loading={false}
        />,
      );
      return onFilters;
    }

    it('shows no "Clear <filter>" buttons when every filter is at its default', () => {
      renderWithFilters(NO_FILTERS);
      expect(screen.queryByRole('button', { name: 'Clear Status' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Band' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Namespace' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Asset' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear Outdated' })).toBeNull();
    });

    it('shows "Clear Status" only while Status is active, and clicking it resets only the status filter', () => {
      const onFilters = renderWithFilters({ ...NO_FILTERS, status: 'approved', namespace: 'HW' });
      expect(screen.queryByRole('button', { name: 'Clear Namespace' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Clear Status' }));
      expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, status: '', namespace: 'HW' });
    });

    it('shows "Clear Outdated" only while the Outdated toggle is on, and clicking it resets only that filter', () => {
      const onFilters = renderWithFilters({ ...NO_FILTERS, outdated: true, band: 'G' });
      fireEvent.click(screen.getByRole('button', { name: 'Clear Outdated' }));
      expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, outdated: false, band: 'G' });
      // The checkbox stays in the DOM and labelled, so existing label-based queries keep working.
      expect(screen.getByLabelText('Outdated')).toBeTruthy();
    });

    it('shows readable Status option labels (statusChip() wording), keeping the raw CellStatus as the option value', () => {
      renderWithFilters(NO_FILTERS);
      const select = screen.getByLabelText('Status') as HTMLSelectElement;
      const options = within(select)
        .getAllByRole('option')
        .map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent }));
      expect(options).toEqual([
        { value: '', text: 'Any status' },
        { value: 'empty', text: 'Untranslated' },
        { value: 'ai_draft', text: 'Draft' },
        { value: 'needs_fix', text: 'Needs fix' },
        { value: 'approved', text: 'Approved' },
        { value: 'edited', text: 'Edited' },
        { value: 'human_edit', text: 'Human' },
        { value: 'rejected', text: 'Rejected' },
      ]);
    });

    describe('Asset PathFilter (path/folder filter)', () => {
      function renderWithRows(rows: GridRow[], filters: GridFilters, onFilters = vi.fn()) {
        render(
          <GridView
            rows={rows}
            cultures={['ru']}
            visible={['ru']}
            onVisible={vi.fn()}
            culture="ru"
            nativeCulture="en"
            filters={filters}
            onFilters={onFilters}
            onOpenCell={vi.fn()}
            onApplyLive={() => undefined}
            canApplyLive={false}
            bridge={makeBridge()}
            editorConnected={false}
            scrollMemory={{ top: 0, left: 0 }}
            loadedCultures={['ru']}
            loading={false}
          />,
        );
        return onFilters;
      }

      it('shows a combobox suggesting asset paths with counts, and applies the exact value on selection', () => {
        const unit = makeUnit('K0', 'Source 0', { origin: '/Game/UI/WBP_Pause.WBP_Pause:WidgetTree.Text' });
        const onFilters = renderWithRows([{ unit, cells: {} }], NO_FILTERS);
        const combobox = screen.getByRole('combobox', { name: 'Asset' });
        fireEvent.change(combobox, { target: { value: 'pause' } });
        fireEvent.click(screen.getByRole('option', { name: '/Game/UI/WBP_Pause — 1' }));
        expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, asset: '/Game/UI/WBP_Pause' });
      });

      it('shows "Clear Asset" only while the Asset filter is active, and clicking it resets only that filter', () => {
        const onFilters = renderWithFilters({ ...NO_FILTERS, asset: '/Game/UI/WBP_Pause', namespace: 'HW' });
        expect(screen.getByRole('button', { name: 'Clear Asset' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Clear Asset' }));
        expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, asset: '', namespace: 'HW' });
      });
    });
  });

  describe('loading state for a not-yet-loaded culture column', () => {
    it('shows "Loading…" cells for a visible culture absent from loadedCultures, leaving an already-loaded column untouched', () => {
      const unit = makeUnit('K0', 'Source 0');
      render(
        <GridView
          rows={[{ unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { text: 'Перевод', status: 'ai_draft', band: 'G' }), outdated: false } } }]}
          cultures={['ru', 'de']}
          visible={['ru', 'de']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={NO_FILTERS}
          onFilters={() => undefined}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={['ru']}
          loading={true}
        />,
      );
      expect(screen.getByText('Перевод')).toBeTruthy(); // "ru" is loaded: its real text shows
      const deCell = screen.getByRole('button', { name: /Loading…/ });
      expect(deCell.title).toBe('Loading…');
    });

    it('shows "Loading…" instead of a misleading "0 of N" count while the active culture itself is not yet loaded', () => {
      const unit = makeUnit('K0', 'Source 0');
      render(
        <GridView
          rows={[{ unit, cells: {} }]}
          cultures={['ru']}
          visible={['ru']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={{ ...NO_FILTERS, status: 'approved' }}
          onFilters={() => undefined}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={[]}
          loading={true}
        />,
      );
      expect(screen.getByText('Loading…', { selector: '.count' })).toBeTruthy();
      expect(screen.queryByText(/of 1 strings/)).toBeNull();
    });

    it('shows the count, not "Loading…", when every visible culture is already in loadedCultures', () => {
      renderGrid(bigGrid(1));
      expect(screen.getByText('1 of 1 strings')).toBeTruthy();
      expect(screen.queryByText('Loading…')).toBeNull();
    });

    it('shows "Loading…" only while a fetch is actually in flight: once it settles, a still-unloaded column shows a blank cell instead of "Loading…" forever', () => {
      const unit = makeUnit('K0', 'Source 0');
      render(
        <GridView
          rows={[{ unit, cells: { ru: { cell: makeCell(unit.id, 'ru', { text: 'Перевод', status: 'ai_draft', band: 'G' }), outdated: false } } }]}
          cultures={['ru', 'de']}
          visible={['ru', 'de']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={NO_FILTERS}
          onFilters={() => undefined}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={['ru']}
          loading={false}
        />,
      );
      expect(screen.queryByRole('button', { name: /Loading…/ })).toBeNull();
      const deCell = screen.getByRole('button', { name: '—' });
      expect(deCell.title).toBe('empty');
    });

    it('shows the plain count, not "Loading…", once the active culture itself failed to load rather than still loading', () => {
      const unit = makeUnit('K0', 'Source 0');
      render(
        <GridView
          rows={[{ unit, cells: {} }]}
          cultures={['ru']}
          visible={['ru']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={NO_FILTERS}
          onFilters={() => undefined}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={[]}
          loading={false}
        />,
      );
      expect(screen.queryByText('Loading…', { selector: '.count' })).toBeNull();
    });
  });

  describe('search debounce', () => {
    function renderWithQuery(rows: GridRow[], filters: GridFilters, onFilters = vi.fn()) {
      const { rerender } = render(
        <GridView
          rows={rows}
          cultures={['ru']}
          visible={['ru']}
          onVisible={vi.fn()}
          culture="ru"
          nativeCulture="en"
          filters={filters}
          onFilters={onFilters}
          onOpenCell={vi.fn()}
          onApplyLive={() => undefined}
          canApplyLive={false}
          bridge={makeBridge()}
          editorConnected={false}
          scrollMemory={{ top: 0, left: 0 }}
          loadedCultures={['ru']}
          loading={false}
        />,
      );
      const rerenderWith = (nextFilters: GridFilters) =>
        rerender(
          <GridView
            rows={rows}
            cultures={['ru']}
            visible={['ru']}
            onVisible={vi.fn()}
            culture="ru"
            nativeCulture="en"
            filters={nextFilters}
            onFilters={onFilters}
            onOpenCell={vi.fn()}
            onApplyLive={() => undefined}
            canApplyLive={false}
            bridge={makeBridge()}
            editorConnected={false}
            scrollMemory={{ top: 0, left: 0 }}
            loadedCultures={['ru']}
            loading={false}
          />,
        );
      return { onFilters, rerenderWith };
    }

    it('shows the search placeholder naming the loaded cultures only', () => {
      renderGrid(bigGrid(1));
      expect(screen.getByPlaceholderText('Search key, source or shown translations')).toBeTruthy();
    });

    it('keeps the search box instant, but delays which rows are filtered by 150ms', () => {
      vi.useFakeTimers();
      try {
        const rows = bigGrid(3); // 'Source 0', 'Source 1', 'Source 2'
        const { onFilters, rerenderWith } = renderWithQuery(rows, NO_FILTERS);
        expect(screen.getByText('3 of 3 strings')).toBeTruthy();

        const input = screen.getByLabelText('Search');
        fireEvent.change(input, { target: { value: 'Source 1' } });
        expect(onFilters).toHaveBeenCalledWith({ ...NO_FILTERS, q: 'Source 1' });

        // App owns `filters` and would re-render GridView with the new q; simulate that here.
        rerenderWith({ ...NO_FILTERS, q: 'Source 1' });
        // Right after the prop changes, filtering has not caught up yet (debounced).
        expect(screen.getByText('3 of 3 strings')).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(150);
        });
        expect(screen.getByText('1 of 3 strings')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('memoizes filterRows on the individual filter fields plus the debounced query, so three quick query changes within 150ms add at most one call', () => {
      vi.useFakeTimers();
      try {
        const rows = bigGrid(3);
        const filterRowsMock = vi.mocked(filterRows);
        const { rerenderWith } = renderWithQuery(rows, NO_FILTERS);
        filterRowsMock.mockClear(); // drop whatever the initial mount itself called

        rerenderWith({ ...NO_FILTERS, q: 'S' });
        act(() => vi.advanceTimersByTime(30));
        rerenderWith({ ...NO_FILTERS, q: 'So' });
        act(() => vi.advanceTimersByTime(30));
        rerenderWith({ ...NO_FILTERS, q: 'Sou' });
        // Only the last of the three debounce timers ever reaches its own 150ms deadline; the earlier two were
        // cleared by the next keystroke before they could fire (App.tsx's own `filters` object changes on every
        // one of these keystrokes too — a memo keyed on that whole object would recompute on each of them).
        act(() => vi.advanceTimersByTime(150));

        expect(filterRowsMock.mock.calls.length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
