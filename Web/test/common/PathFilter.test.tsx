import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PathFilter, pathSuggestions, type PathEntry } from '../../src/common/PathFilter';

const ASSETS: PathEntry[] = [
  { path: '/Game/MyGame/Input/Hints/DA_Hints_Seated', count: 12 },
  { path: '/Game/MyGame/Input/Hints/DA_Hints_Standing', count: 4 },
  { path: '/Game/MyGame/UI/WBP_Pause', count: 30 },
  { path: 'Source/MyGame/Private/Baler.cpp', count: 2 },
];

describe('pathSuggestions', () => {
  it('matches paths containing the substring, case-insensitively, capped at 50', () => {
    const result = pathSuggestions(ASSETS, 'HINTS');
    expect(result.map((s) => s.value)).toEqual(
      expect.arrayContaining(['/Game/MyGame/Input/Hints/DA_Hints_Seated', '/Game/MyGame/Input/Hints/DA_Hints_Standing']),
    );
  });

  it('returns no suggestions for an empty query', () => {
    expect(pathSuggestions(ASSETS, '')).toEqual([]);
    expect(pathSuggestions(ASSETS, '   ')).toEqual([]);
  });

  it('offers the folder prefix of matching paths as a suggestion, and ranks it against the full paths by count', () => {
    const result = pathSuggestions(ASSETS, 'hints');
    const folder = result.find((s) => s.value === '/Game/MyGame/Input/Hints/');
    expect(folder).toBeTruthy();
    expect(folder!.folder).toBe(true);
    expect(folder!.count).toBe(16); // 12 + 4, rolled up from both matching assets under that folder
    // Does not offer shallower ancestors that do not themselves contain the needle.
    expect(result.some((s) => s.value === '/Game/MyGame/Input/')).toBe(false);
    expect(result.some((s) => s.value === '/Game/')).toBe(false);
  });

  it('ranks prefix matches before substring matches, then by count', () => {
    const entries: PathEntry[] = [
      { path: 'ZZZPause', count: 100 },
      { path: 'PauseMenu', count: 1 },
    ];
    const result = pathSuggestions(entries, 'pause');
    expect(result.map((s) => s.value)).toEqual(['PauseMenu', 'ZZZPause']);
  });

  it('gives no folder suggestions for a flat path with no slashes', () => {
    const result = pathSuggestions([{ path: 'Hud', count: 3 }], 'hud');
    expect(result).toEqual([{ value: 'Hud', count: 3, folder: false }]);
  });

  it('does not offer a folder suggestion identical to a path entry that itself ends in "/"', () => {
    const entries: PathEntry[] = [{ path: '/Game/MyGame/Input/Hints/', count: 5 }];
    const result = pathSuggestions(entries, 'hints');
    const matches = result.filter((s) => s.value === '/Game/MyGame/Input/Hints/');
    expect(matches).toHaveLength(1); // not one file match and one identical folder match
    expect(matches[0]!.folder).toBe(false);
  });
});

function renderFilter(value = '', onChange = vi.fn(), entries = ASSETS) {
  render(<PathFilter value={value} onChange={onChange} entries={entries} ariaLabel="Asset" placeholder="Any asset or file" />);
  return { onChange };
}

describe('PathFilter', () => {
  it('is a combobox with a listbox of options, showing "path — count"', () => {
    renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(input, { target: { value: 'pause' } });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');
    expect(listbox).toBeTruthy();
    expect(options.some((o) => o.textContent === '/Game/MyGame/UI/WBP_Pause — 30')).toBe(true);
  });

  it('choosing a suggestion applies its exact value and closes the popover', () => {
    const { onChange } = renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'baler' } });
    fireEvent.click(screen.getByRole('option', { name: /Baler\.cpp/ }));
    expect(onChange).toHaveBeenCalledWith('Source/MyGame/Private/Baler.cpp');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter applies the typed text as-is when nothing is highlighted', () => {
    const { onChange } = renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'custom/typed/path' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('custom/typed/path');
  });

  it('ArrowDown highlights an option and Enter applies it', () => {
    const { onChange } = renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'hints' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalled();
    const applied = onChange.mock.calls[0]?.[0] as string;
    expect(applied.toLowerCase()).toContain('hints');
  });

  // ArrowUp used to stop at index 0 (the first suggestion), so once ArrowDown had highlighted anything, a
  // keyboard user could never get back to "nothing highlighted" and Enter always picked a suggestion instead of
  // the typed text.
  it('ArrowDown then ArrowUp returns to no highlight, and Enter applies the typed text as-is', () => {
    const { onChange } = renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'hints' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('hints');
  });

  it('Escape closes the popover', () => {
    renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'pause' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape also discards the typed text, so a later blur does not commit it', () => {
    const { onChange } = renderFilter('/Game/MyGame/UI/WBP_Pause');
    const input = screen.getByRole('combobox', { name: 'Asset' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'typed but abandoned' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(input.value).toBe('/Game/MyGame/UI/WBP_Pause');
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an outside click closes the popover', () => {
    renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'pause' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a Clear × button only while a value is applied, and clicking it clears the value', () => {
    const onChange = vi.fn();
    const { rerender } = render(<PathFilter value="" onChange={onChange} entries={ASSETS} ariaLabel="Asset" />);
    expect(screen.queryByRole('button', { name: 'Clear Asset' })).toBeNull();
    rerender(<PathFilter value="/Game/MyGame/UI/WBP_Pause" onChange={onChange} entries={ASSETS} ariaLabel="Asset" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear Asset' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('follows an externally-applied value (e.g. the × clear) in the input text', () => {
    const { rerender } = render(<PathFilter value="/Game/MyGame/UI/WBP_Pause" onChange={vi.fn()} entries={ASSETS} ariaLabel="Asset" />);
    expect((screen.getByRole('combobox', { name: 'Asset' }) as HTMLInputElement).value).toBe('/Game/MyGame/UI/WBP_Pause');
    rerender(<PathFilter value="" onChange={vi.fn()} entries={ASSETS} ariaLabel="Asset" />);
    expect((screen.getByRole('combobox', { name: 'Asset' }) as HTMLInputElement).value).toBe('');
  });

  it('commits the typed text on blur, same as Enter, without needing a suggestion click', () => {
    const { onChange } = renderFilter();
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'custom/typed/path' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('custom/typed/path');
  });

  it('does not re-apply on blur when nothing was typed, but still closes the popover', () => {
    const { onChange } = renderFilter('/Game/MyGame/UI/WBP_Pause');
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'pause' } });
    fireEvent.change(input, { target: { value: '/Game/MyGame/UI/WBP_Pause' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a blur that moves focus to the Clear button leaves the click to that button, not to the blur commit', () => {
    const onChange = vi.fn();
    render(<PathFilter value="/Game/MyGame/UI/WBP_Pause" onChange={onChange} entries={ASSETS} ariaLabel="Asset" />);
    const input = screen.getByRole('combobox', { name: 'Asset' });
    const clearButton = screen.getByRole('button', { name: 'Clear Asset' });
    fireEvent.change(input, { target: { value: 'typed but not applied' } });
    fireEvent.blur(input, { relatedTarget: clearButton });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(clearButton);
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('still commits on the blur that finally leaves the widget, even when an intermediate Tab stop landed on the Clear button first', () => {
    const onChange = vi.fn();
    render(<PathFilter value="/Game/MyGame/UI/WBP_Pause" onChange={onChange} entries={ASSETS} ariaLabel="Asset" />);
    const input = screen.getByRole('combobox', { name: 'Asset' });
    const clearButton = screen.getByRole('button', { name: 'Clear Asset' });
    fireEvent.change(input, { target: { value: 'custom/typed/path' } });
    fireEvent.blur(input, { relatedTarget: clearButton }); // Tab lands on Clear first: still inside the widget
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(clearButton, { relatedTarget: document.body }); // Tab again: now actually leaves the widget
    expect(onChange).toHaveBeenCalledWith('custom/typed/path');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ignores a blur when the whole document has lost focus (e.g. clicking into a native host view outside the DOM)', () => {
    const onChange = vi.fn();
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(<PathFilter value="/Game/MyGame/UI/WBP_Pause" onChange={onChange} entries={ASSETS} ariaLabel="Asset" />);
    const input = screen.getByRole('combobox', { name: 'Asset' });
    fireEvent.change(input, { target: { value: 'custom/typed/path' } });
    fireEvent.blur(input, { relatedTarget: null });
    expect(onChange).not.toHaveBeenCalled();
    hasFocusSpy.mockRestore();
  });

  describe('a11y', () => {
    it('gives every option a stable id and points aria-activedescendant at the highlighted one', () => {
      renderFilter();
      const input = screen.getByRole('combobox', { name: 'Asset' });
      fireEvent.change(input, { target: { value: 'hints' } });
      expect(input.getAttribute('aria-activedescendant')).toBeNull();
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      const options = screen.getAllByRole('option');
      const active = options.find((o) => o.getAttribute('aria-selected') === 'true')!;
      expect(active.id).toBeTruthy();
      expect(input.getAttribute('aria-activedescendant')).toBe(active.id);
      options.forEach((option) => expect(option.id).toBeTruthy());
    });

    it('keeps every option out of the Tab order (navigation is keyboard-only via the input)', () => {
      renderFilter();
      const input = screen.getByRole('combobox', { name: 'Asset' });
      fireEvent.change(input, { target: { value: 'pause' } });
      for (const option of screen.getAllByRole('option')) expect(option.getAttribute('tabindex')).toBe('-1');
    });

    it('closes the popover when focus leaves the widget entirely (e.g. Tab to the next control)', () => {
      renderFilter();
      const input = screen.getByRole('combobox', { name: 'Asset' });
      fireEvent.change(input, { target: { value: 'pause' } });
      expect(screen.getByRole('listbox')).toBeTruthy();
      fireEvent.blur(input, { relatedTarget: document.body });
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });
});
