import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extraColumns, loadChosenColumns, saveChosenColumns, visibleCultures } from '../src/grid/columns';

describe('visibleCultures', () => {
  it('shows only the active culture when nothing is stored yet', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], undefined, 'de')).toEqual(['de']);
  });

  it('shows nothing when nothing is stored and there is no active culture', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], undefined, '')).toEqual([]);
  });

  it('filters the stored list to project cultures and adds the active one, ordered as in "all"', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], ['fr'], 'de')).toEqual(['de', 'fr']);
  });

  it('drops a stored culture that is no longer a project culture', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], ['xx', 'fr'], '')).toEqual(['fr']);
  });

  it('keeps the stored list unchanged when the active culture is already in it', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], ['de', 'fr'], 'de')).toEqual(['de', 'fr']);
  });

  it('does not add an empty active culture to an empty stored list', () => {
    expect(visibleCultures(['de', 'fr', 'ru'], [], '')).toEqual([]);
  });
});

describe('extraColumns', () => {
  it('drops the active culture: it is always shown, so storing it would keep it after the culture changes', () => {
    expect(extraColumns(['de', 'fr'], 'de', undefined)).toEqual(['fr']);
    expect(extraColumns(['de', 'fr'], 'de', ['fr'])).toEqual(['fr']);
  });

  it('keeps the active culture when it was already picked as an extra column under another active culture', () => {
    expect(extraColumns(['de', 'fr'], 'de', ['de'])).toEqual(['de', 'fr']);
  });

  it('removes a culture the user unchecked', () => {
    expect(extraColumns(['de'], 'de', ['de', 'fr'])).toEqual(['de']);
  });
});

describe('loadChosenColumns / saveChosenColumns', () => {
  const KEY = 'lochub.gridExtraColumns';

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads undefined when nothing is stored', () => {
    expect(loadChosenColumns()).toBeUndefined();
  });

  it('round-trips a saved list', () => {
    saveChosenColumns(['fr', 'ru']);
    expect(loadChosenColumns()).toEqual(['fr', 'ru']);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(['fr', 'ru']));
  });

  it('reads undefined for malformed JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadChosenColumns()).toBeUndefined();
  });

  it('reads undefined for a JSON value that is not an array of strings', () => {
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(loadChosenColumns()).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify(['fr', 3]));
    expect(loadChosenColumns()).toBeUndefined();
  });

  it('reads undefined instead of throwing when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked (CEF profile or private window)');
    });
    expect(loadChosenColumns()).toBeUndefined();
  });

  it('does not throw when localStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked (CEF profile or private window)');
    });
    expect(() => saveChosenColumns(['fr'])).not.toThrow();
  });
});
