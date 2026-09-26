// Which culture columns the grid shows, and remembering that choice across sessions. Pure and DOM/localStorage-free
// except for the two storage functions, so the picking logic (visibleCultures) is unit-tested without a DOM.

// Holds the extra columns only, never the active culture. The previous key stored the whole visible list, active
// culture included, which kept a former active culture on screen after switching; its lists are ignored on purpose.
const STORAGE_KEY = 'lochub.gridExtraColumns';

// chosen === undefined means nothing was ever stored (first run): show only the active culture. Otherwise the
// stored list is filtered down to real project cultures (one may have been retired since it was chosen) and the
// active culture is added if it is not already there, so switching culture never hides the string you are editing.
export function visibleCultures(all: readonly string[], chosen: readonly string[] | undefined, active: string): string[] {
  if (chosen === undefined) return active ? [active] : [];
  const set = new Set(chosen.filter((code) => all.includes(code)));
  if (active) set.add(active);
  return all.filter((code) => set.has(code));
}

// What the Columns picker's new visible list means as a stored choice. The active culture is always shown, so it
// is kept only if it was already picked as an extra column while another culture was active; storing it otherwise
// would leave it behind as a column once the user switches culture.
export function extraColumns(visible: readonly string[], active: string, previous: readonly string[] | undefined): string[] {
  return visible.filter((code) => code !== active || (previous?.includes(code) ?? false));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// The editor's embedded CEF profile (or a private browser window) can refuse localStorage access entirely; every
// read and write is wrapped so a refusal degrades to "nothing was ever stored" instead of crashing the app.
export function loadChosenColumns(): string[] | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isStringArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveChosenColumns(list: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Best effort: losing the remembered columns is fine, crashing the app is not.
  }
}
