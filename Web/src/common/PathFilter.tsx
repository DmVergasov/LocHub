import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

// A known path (an asset/file for the Grid's Asset filter, a job group key for the Jobs "Group" filter) with how
// many rows it covers, so the suggestion popover can show "DA_Hints_Seated — 12" (path/folder filter).
export interface PathEntry {
  path: string;
  count: number;
}

export interface PathSuggestion {
  value: string;
  count: number;
  // A folder prefix ("this folder and everything under it", a value ending in "/"), not one of the known paths
  // itself.
  folder: boolean;
}

const MAX_SUGGESTIONS = 50;

// The folder-prefix ancestors of a path, deepest last: "/Game/MyGame/Input/Hints/DA_Hints_Seated" ->
// ["/Game/", "/Game/MyGame/", "/Game/MyGame/Input/", "/Game/MyGame/Input/Hints/"]. A flat path with no
// "/" (or only a single segment) has none. A path that itself ends in "/" stops one slash short of its own full
// length, so its own ancestors never include the path itself as a "folder" (that would offer the exact same value
// twice: once as the file/path match, once as a folder suggestion). Scans "/" positions with indexOf instead of
// split/filter/join (this perf-sensitive path, at 50k entries, spends most of its time here): equivalent for a
// normal path (a single leading slash if any, no consecutive slashes), which is the only shape any real asset/file
// path or group key takes.
function folderPrefixesOf(path: string): string[] {
  const prefixes: string[] = [];
  let idx = path.indexOf('/', path.startsWith('/') ? 1 : 0);
  while (idx >= 0 && idx < path.length - 1) {
    prefixes.push(path.slice(0, idx + 1));
    idx = path.indexOf('/', idx + 1);
  }
  return prefixes;
}

// Every folder-prefix ancestor of every entry, with the string count rolled up under it: built once per
// `entries` (a single O(entries × depth) pass) so a folder suggestion's count is a map lookup instead of a fresh
// `entries.filter(...).reduce(...)` scan for every matching folder on every keystroke — at 50k entries and a few
// hundred matching folders that scan was the O(folders × entries) cost a keystroke used to pay.
export function buildFolderTotals(entries: readonly PathEntry[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    for (const folder of folderPrefixesOf(entry.path)) totals.set(folder, (totals.get(folder) ?? 0) + entry.count);
  }
  return totals;
}

interface RankedSuggestion extends PathSuggestion {
  rank: number; // 0 = prefix match, 1 = substring match elsewhere; precomputed once, not per sort comparison.
}

// Suggestions for the typed substring (case-insensitive): every known path whose text contains it, plus the
// folder-prefix ancestors of those matches that themselves contain it too (so typing "hints" offers
// ".../Input/Hints/" but not ".../Input/"). Ranked prefix-match first, then by count, capped at 50. `folderTotals`
// is optional (buildFolderTotals(entries) otherwise) so a caller that only wants a one-off answer, or a test,
// does not have to build it first; a component that calls this on every keystroke should memoize it on `entries`.
export function pathSuggestions(entries: readonly PathEntry[], query: string, folderTotals?: Map<string, number>): PathSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  // A needle as short as "a" matches most of a large set, so both loops below avoid per-item work that used to
  // scale with the match count: rank is precomputed once per candidate rather than re-lowercased on every sort
  // comparison, and the tie-break is a plain comparison (this file's own sort order does not need locale
  // collation) instead of localeCompare, which is markedly slower at this size.
  const rankOf = (lower: string) => (lower.startsWith(needle) ? 0 : 1);

  const fileMatches: RankedSuggestion[] = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    if (lower.includes(needle)) fileMatches.push({ value: entry.path, count: entry.count, folder: false, rank: rankOf(lower) });
  }

  // Every known folder (folderTotals's keys — every entry's ancestors, not just this needle's matches) that
  // itself contains the needle: because a folder is a literal prefix of any entry under it, whenever the folder's
  // own text contains the needle, every entry under it trivially does too, so this is exactly the folder set
  // "walk each match's ancestors and keep the ones that contain it" would produce, without re-walking `entries`
  // (already-known ancestors only number in the low thousands even at 50k entries, unlike the matches themselves).
  const totals = folderTotals ?? buildFolderTotals(entries);
  const folderMatches: RankedSuggestion[] = [];
  for (const [folder, count] of totals) {
    const lower = folder.toLowerCase();
    if (lower.includes(needle)) folderMatches.push({ value: folder, count, folder: true, rank: rankOf(lower) });
  }

  const all: RankedSuggestion[] = [...fileMatches, ...folderMatches];
  all.sort((a, b) => a.rank - b.rank || b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return all.slice(0, MAX_SUGGESTIONS).map(({ value, count, folder }) => ({ value, count, folder }));
}

export interface PathFilterProps {
  value: string;
  onChange: (value: string) => void;
  entries: readonly PathEntry[];
  ariaLabel: string;
  placeholder?: string;
}

// A text input with a suggestion popover over a set of known paths (path/folder filter): used for the
// Grid toolbar's Asset filter and Jobs' Group filter. Follows the popover/Escape/outside-click pattern of
// KeyDetails.tsx and GridView's ColumnsPicker.
export function PathFilter({ value, onChange, entries, ariaLabel, placeholder }: PathFilterProps) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  // The typed text follows the applied value whenever it changes from outside (the × clear button, or a filter
  // reset elsewhere), so the box never shows stale text next to a filter that no longer matches it.
  useEffect(() => {
    setText(value);
  }, [value]);

  // Cached across renders and rebuilt only when `entries` itself changes, not on every keystroke: a folder's
  // count is then a map lookup. Built lazily, the first time a non-empty filter actually needs it — an idle
  // filter (nothing typed yet) never pays the totals-map build cost at 50k rows.
  const folderTotalsRef = useRef<{ entries: readonly PathEntry[]; totals: Map<string, number> } | null>(null);
  const suggestions = useMemo(() => {
    if (!text.trim()) return [];
    if (folderTotalsRef.current === null || folderTotalsRef.current.entries !== entries) {
      folderTotalsRef.current = { entries, totals: buildFolderTotals(entries) };
    }
    return pathSuggestions(entries, text, folderTotalsRef.current.totals);
  }, [entries, text]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);

  // Escape (below) needs to also drop whatever was typed, not just close the popover: otherwise a later blur
  // still commits the abandoned text.
  const cancel = useCallback(() => {
    setText(value);
    close();
  }, [value, close]);

  const apply = useCallback(
    (next: string) => {
      setText(next);
      onChange(next);
      close();
    },
    [onChange, close],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapRef.current?.contains(event.target as Node | null)) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, cancel]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      // -1 (no highlight, back to the typed text), not 0: an ArrowDown to the top suggestion followed by
      // ArrowUp must be able to return here, or Enter can never apply the typed text once anything was
      // highlighted.
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = open ? suggestions[activeIndex] : undefined;
      apply(chosen ? chosen.value : text.trim());
    }
    // Escape is handled by the document-level listener above (open only), so it also closes on a blur-less Esc.
  };

  // Applies whatever was typed once focus actually leaves the widget entirely (Tab, or clicking a control
  // outside it), so Estimate/Run never silently act on an unapplied filter. Placed on the wrapping element, not
  // just the input: React's onBlur bubbles (it is really `focusout` under the hood), so this also runs when
  // focus leaves via an intermediate Tab stop inside the widget (the Clear button) on its way further out —
  // only the very last blur, the one whose relatedTarget is no longer inside the widget, actually commits. A
  // focus change that leaves the browser window entirely (e.g. clicking into a native host view outside the
  // DOM) reports no relatedTarget and must not be treated as "left the widget" either. A blur with nothing new
  // typed just closes the popover, so it never lingers once the input is no longer focused.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!document.hasFocus()) return;
    if (wrapRef.current?.contains(event.relatedTarget as Node | null)) return;
    const t = text.trim();
    if (t !== value) apply(t);
    else close();
  };

  const clear = () => apply('');

  return (
    <div className={`path-filter filter-pill${value !== '' ? ' active' : ''}`} ref={wrapRef} onBlur={onBlur}>
      <input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {value !== '' && (
        <button type="button" className="filter-clear" aria-label={`Clear ${ariaLabel}`} onClick={clear}>
          ×
        </button>
      )}
      {open && suggestions.length > 0 && (
        <ul
          className="path-filter-popover"
          role="listbox"
          id={listId}
          aria-label={`${ariaLabel} suggestions`}
          onMouseDown={(e) => e.preventDefault()}
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.value}>
              <button
                type="button"
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => apply(suggestion.value)}
              >
                {suggestion.value} — {suggestion.count}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
