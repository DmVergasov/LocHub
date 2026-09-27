import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { emptyCell, type Cell, type CellEvent, type Culture, type GlossaryTerm, type InboxItem, type PluralForms, type Unit } from './contract.js';
import { canonicalJson, compareCodeUnits } from './ids.js';
import { PLURAL_CATEGORIES, pluralCategories, type PluralType } from './precheck.js';

// A source control sync (git pull, p4 sync…) (or any other outside edit) to Localization/LocHub/* while the
// service holds it in memory: save() would otherwise silently overwrite the external change with its own stale
// snapshot. Thrown by save() when changedOnDisk() is true; the caller maps it to 409 (server.ts).
export class StoreChangedOnDiskError extends Error {
  constructor() {
    super('Localization/LocHub changed on disk since the service loaded it (a source control sync?). Restart the LocHub service.');
    this.name = 'StoreChangedOnDiskError';
  }
}

interface FileStat {
  size: number;
  mtimeMs: number;
}

// Fingerprint of every data file save() can write, keyed by file name. events.*.jsonl is excluded on purpose
// (declined-to-judge item, promoted): it is append-only and read on demand, not part of the in-memory snapshot
// save() rewrites, so an external append to it must not be treated as a conflicting edit.
function fingerprintOf(dataDir: string): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  const stat = (name: string) => {
    const path = join(dataDir, name);
    if (!existsSync(path)) return;
    const s = statSync(path);
    out.set(name, { size: s.size, mtimeMs: s.mtimeMs });
  };
  stat('units.jsonl');
  stat('inbox.jsonl');
  if (existsSync(dataDir)) {
    for (const name of readdirSync(dataDir)) {
      if (/^cells\..+\.jsonl$/.test(name) || /^glossary\..+\.jsonl$/.test(name) || /^style\..+\.md$/.test(name)) stat(name);
    }
  }
  return out;
}

function fingerprintsEqual(a: ReadonlyMap<string, FileStat>, b: ReadonlyMap<string, FileStat>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, stat] of a) {
    const other = b.get(name);
    if (!other || other.size !== stat.size || other.mtimeMs !== stat.mtimeMs) return false;
  }
  return true;
}

// Source of truth in git: sorted JSONL files. This class is the in-memory index rebuilt on every start.
export class LocHubStore {
  readonly units = new Map<string, Unit>();
  readonly cells = new Map<Culture, Map<string, Cell>>();
  readonly glossary = new Map<Culture, GlossaryTerm[]>();
  readonly style = new Map<Culture, string>();
  readonly inbox = new Map<string, InboxItem>();
  // The engine's plural forms per culture from the Pushes since the service started, latest value per culture.
  // Persisted to pluralFormsPath (updatePluralForms), separate from dataDir: they describe the running
  // engine, not project data, so they do not belong in the committed Localization/LocHub. Every Push sends
  // them again, so a missing or unreadable file just means "nothing pushed yet" -- today's Node fallback.
  readonly pluralForms = new Map<Culture, PluralForms>();

  // Snapshot taken at load() and again at the end of every save(); changedOnDisk() compares against it.
  private fingerprint = new Map<string, FileStat>();

  private constructor(
    readonly dataDir: string,
    // Absent for a caller that does not care about surviving a restart (most tests): pluralForms then behaves
    // exactly as before this fix, in-memory only.
    private readonly pluralFormsPath?: string,
  ) {}

  static load(dataDir: string, pluralFormsPath?: string): LocHubStore {
    mkdirSync(dataDir, { recursive: true });
    const store = new LocHubStore(dataDir, pluralFormsPath);
    for (const unit of readJsonl<Unit>(join(dataDir, 'units.jsonl'))) store.units.set(unit.id, unit);
    for (const item of readJsonl<InboxItem>(join(dataDir, 'inbox.jsonl'))) store.inbox.set(item.id, item);
    for (const file of readdirSync(dataDir)) {
      const cells = /^cells\.(.+)\.jsonl$/.exec(file);
      if (cells) {
        const map = new Map<string, Cell>();
        for (const cell of readJsonl<Cell>(join(dataDir, file))) map.set(cell.unitId, cell);
        store.cells.set(cells[1]!, map);
        continue;
      }
      const glossary = /^glossary\.(.+)\.jsonl$/.exec(file);
      if (glossary) {
        store.glossary.set(glossary[1]!, readJsonl<GlossaryTerm>(join(dataDir, file)));
        continue;
      }
      const style = /^style\.(.+)\.md$/.exec(file);
      if (style) store.style.set(style[1]!, stripBom(readFileSync(join(dataDir, file), 'utf8')));
    }
    store.fingerprint = fingerprintOf(dataDir);
    store.loadPluralForms();

    // Same guard save() runs before writing, run here too: a checkout that already holds e.g. both
    // cells.ru.jsonl and cells.RU.jsonl (produced on a case-insensitive filesystem by two commits that
    // each thought their spelling was new) must fail fast at startup with the same clear message, instead
    // of loading silently and only surfacing the collision on the first save().
    assertNoCaseCollisions([store.cells.keys(), store.glossary.keys(), store.style.keys()]);
    return store;
  }

  // A missing file is the ordinary case (no pluralFormsPath given, or nothing pushed since this project's
  // Saved/ folder was last cleared): pluralCategoriesFor's Node fallback covers it silently. A present but
  // unreadable/corrupt file (a crash mid-write with no .tmp to recover from, hand-edited, from a future
  // service version) falls back the same way, but is worth one operator-visible line -- it is not the
  // ordinary case and the file only ever holds a small cache, not project data.
  private loadPluralForms(): void {
    if (!this.pluralFormsPath || !existsSync(this.pluralFormsPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.pluralFormsPath, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      for (const [culture, forms] of Object.entries(parsed as Record<string, unknown>)) {
        if (isPluralForms(forms)) this.pluralForms.set(culture, { cardinal: [...forms.cardinal], ordinal: [...forms.ordinal] });
      }
    } catch (error) {
      console.warn(`${this.pluralFormsPath}: could not read the stored engine plural forms (${(error as Error).message}); using Node's own plural rules until the next Push`);
    }
  }

  // True when a data file save() would write has been added, removed or changed since load() or the last
  // save() (a source control sync, e.g. git pull, while the service runs). /api/health reports it; save()
  // refuses to write when true.
  changedOnDisk(): boolean {
    return !fingerprintsEqual(this.fingerprint, fingerprintOf(this.dataDir));
  }

  // Callers that stage a write (putCell/appendEvent) ahead of save() — every
  // server.ts handler and job.ts's commit batches — must check freshness before staging anything, not only
  // inside save(). appendEvent is a plain, immediate append: if save() were the only gate, a 409 on the save
  // step would leave an event already written to events.*.jsonl with no matching cell, a phantom `after` that
  // a later reconcile mistakes for LocHub's own text. Throws the same error save() throws.
  assertFresh(): void {
    if (this.changedOnDisk()) throw new StoreChangedOnDiskError();
  }

  cellsFor(culture: Culture): Map<string, Cell> {
    let map = this.cells.get(culture);
    if (!map) {
      map = new Map();
      this.cells.set(culture, map);
    }
    return map;
  }

  // Pure read: an unknown culture must not create a map entry (a later save() would then write an empty
  // file for it, which on a case-insensitive filesystem can truncate a differently-cased culture's data).
  // cellsFor stays the writer path used by putCell.
  getCell(culture: Culture, unitId: string): Cell {
    return this.cells.get(culture)?.get(unitId) ?? emptyCell(unitId, culture);
  }

  putCell(cell: Cell): void {
    this.cellsFor(cell.culture).set(cell.unitId, cell);
  }

  // The plural categories precheck and the prompt use for a culture: the engine's (it validates on Pull) when a
  // Push reported them, else Node's own ICU answer.
  pluralCategoriesFor(culture: Culture, type: PluralType): string[] {
    return this.pluralForms.get(culture)?.[type] ?? pluralCategories(culture, type);
  }

  // Called by Push (applySnapshot) for whatever pluralForms a snapshot carried -- latest value per culture,
  // a culture the snapshot leaves out keeps its current forms. Persists to pluralFormsPath, but only when
  // something actually changed, so a resend of unchanged forms or a pluralForms-less Push (an older plugin,
  // or nothing to report) never touches the file.
  updatePluralForms(forms: Readonly<Record<Culture, PluralForms>>): void {
    let changed = false;
    for (const [culture, value] of Object.entries(forms)) {
      const next: PluralForms = { cardinal: [...value.cardinal], ordinal: [...value.ordinal] };
      const current = this.pluralForms.get(culture);
      if (!current || !sameForms(current, next)) changed = true;
      this.pluralForms.set(culture, next);
    }
    if (changed) this.savePluralForms();
  }

  private savePluralForms(): void {
    if (!this.pluralFormsPath) return;
    const out: Record<string, PluralForms> = {};
    for (const [culture, forms] of this.pluralForms) out[culture] = forms;
    try {
      mkdirSync(dirname(this.pluralFormsPath), { recursive: true });
      writeFileAtomic(this.pluralFormsPath, canonicalJson(out));
    } catch (error) {
      // m-2: this file is only a cache of the engine's last Push (see the field comment above), not project
      // data, so a write failure (a read-only Saved/, an AV lock on the .tmp file) must not fail the Push that
      // got this far -- log once and keep serving the forms already in memory; the next successful Push (or a
      // restart, once the path is writable again) writes them. Mirrors loadPluralForms's own catch below.
      console.warn(`${this.pluralFormsPath}: could not save the engine plural forms (${(error as Error).message}); keeping them in memory only`);
    }
  }

  save(): void {
    // Refuse to overwrite an external edit (a source control sync, e.g. git pull, mid-session) with a stale
    // in-memory snapshot: check first, before any write, and write nothing when the data files moved under us.
    // Callers that stage putCell/appendEvent before save() must call assertFresh() themselves too — this check
    // alone is too late to stop an appendEvent that already landed on disk.
    this.assertFresh();

    // Defence in depth: the API boundary already rejects a culture that collides case-insensitively with an
    // existing one, but a caller that writes to the store directly must not be able to truncate another
    // culture's file by inserting e.g. "RU" next to "ru" — checked across cells/glossary/style together,
    // not per map, since "ru" in cells and "RU" in style are just as much a collision.
    assertNoCaseCollisions([this.cells.keys(), this.glossary.keys(), this.style.keys()]);

    const units = [...this.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
    writeJsonl(join(this.dataDir, 'units.jsonl'), units);
    for (const [culture, map] of this.cells) {
      const cells = [...map.values()]
        .filter((c) => c.status !== 'empty')
        .sort((a, b) => compareCodeUnits(a.unitId, b.unitId));
      writeJsonl(this.pathFor(`cells.${culture}.jsonl`), cells);
    }
    for (const [culture, terms] of this.glossary) {
      const sorted = [...terms].sort((a, b) => compareCodeUnits(a.term, b.term));
      writeJsonl(this.pathFor(`glossary.${culture}.jsonl`), sorted);
    }
    for (const [culture, text] of this.style) writeFileAtomic(this.pathFor(`style.${culture}.md`), text);
    const inbox = [...this.inbox.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
    writeJsonl(join(this.dataDir, 'inbox.jsonl'), inbox);

    // Own writes must not trip the next changedOnDisk() check: refresh the baseline to what is on disk now.
    this.fingerprint = fingerprintOf(this.dataDir);
  }

  appendEvent(event: CellEvent): void {
    appendFileSync(this.pathFor(`events.${event.culture}.jsonl`), canonicalJson(event) + '\n', 'utf8');
  }

  // Cell history for the card view; the event log is append-only and read on demand.
  readEvents(culture: Culture, unitId: string): CellEvent[] {
    return readJsonl<CellEvent>(this.pathFor(`events.${culture}.jsonl`)).filter((e) => e.unitId === unitId);
  }

  // Several events in one write per culture file (an import applies many rows at once).
  appendEvents(events: readonly CellEvent[]): void {
    const byCulture = new Map<Culture, string>();
    for (const event of events) byCulture.set(event.culture, (byCulture.get(event.culture) ?? '') + canonicalJson(event) + '\n');
    for (const [culture, lines] of byCulture) appendFileSync(this.pathFor(`events.${culture}.jsonl`), lines, 'utf8');
  }

  // The newest event time (ms since epoch) per unit of one culture, skipping the `ignore` actions: import uses it to
  // tell whether a cell changed after a translator's file was exported. Tolerant of a torn last line and of a bad
  // timestamp, like afterTextsByUnit below.
  latestEventTimes(culture: Culture, ignore: ReadonlySet<string>): Map<string, number> {
    const out = new Map<string, number>();
    const path = this.pathFor(`events.${culture}.jsonl`);
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event: CellEvent;
      try {
        event = JSON.parse(trimmed) as CellEvent;
      } catch {
        continue;
      }
      if (ignore.has(event.action)) continue;
      const time = Date.parse(event.ts);
      if (Number.isNaN(time)) continue;
      if (time > (out.get(event.unitId) ?? Number.NEGATIVE_INFINITY)) out.set(event.unitId, time);
    }
    return out;
  }

  // Every text LocHub itself has ever produced for a cell of this culture, keyed by unit id: Push uses
  // this to tell a stale export (a text LocHub already produced, now reappearing from the archive) from a
  // genuine human edit. Reads the whole events file once per call instead of once per archive entry.
  //
  // appendEvent is not atomic against a crash mid-write, so the log can end in a torn last line. Push
  // must not fail wholesale over it, unlike readEvents/history, so unparsable lines are skipped (and
  // counted) here instead of throwing like the strict readJsonl used elsewhere.
  afterTextsByUnit(culture: Culture): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const path = this.pathFor(`events.${culture}.jsonl`);
    if (!existsSync(path)) return out;
    let skipped = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event: CellEvent;
      try {
        event = JSON.parse(trimmed) as CellEvent;
      } catch {
        skipped++;
        continue;
      }
      const set = out.get(event.unitId) ?? new Set<string>();
      set.add(event.after);
      out.set(event.unitId, set);
    }
    if (skipped > 0) console.warn(`${path}: skipped ${skipped} unparsable event line(s)`);
    return out;
  }

  // Defence in depth against path traversal: the API boundary already rejects a culture outside
  // CULTURE_RE, but every per-culture file path is resolved and checked here too, in case a caller reaches
  // the store directly with an unvalidated value.
  private pathFor(name: string): string {
    const base = resolve(this.dataDir);
    const resolved = resolve(base, name);
    if (resolved !== base && !resolved.startsWith(base + sep)) throw new Error(`Path escapes data dir: ${name}`);
    return resolved;
  }
}

// Defensive shape check for the persisted plural_forms.json: this file is only ever written by
// savePluralForms(), but loadPluralForms() must still not crash or half-apply a hand-edited or
// version-skewed one -- an entry that fails this check is simply left out, same as one this service never
// pushed.
function isPluralForms(value: unknown): value is PluralForms {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isCategoryList(v.cardinal) && isCategoryList(v.ordinal);
}

function isCategoryList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === 'string' && PLURAL_CATEGORIES.has(c));
}

function sameForms(a: PluralForms, b: PluralForms): boolean {
  return sameList(a.cardinal, b.cardinal) && sameList(a.ordinal, b.ordinal);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function assertNoCaseCollisions(keySets: readonly Iterable<string>[]): void {
  const seen = new Map<string, string>();
  for (const keys of keySets) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      const existing = seen.get(lower);
      if (existing !== undefined && existing !== key) throw new Error(`culture keys "${existing}" and "${key}" differ only in case`);
      seen.set(lower, key);
    }
  }
}

// A Windows editor (Notepad, VS Code with a BOM-on-save setting) can leave a UTF-8 BOM (U+FEFF) at the start
// of a file; Node's readFileSync does not strip it, and it would otherwise glue itself to the first JSON
// line (breaking JSON.parse) or to the first character of a style guide's text.
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  stripBom(readFileSync(path, 'utf8'))
    .split('\n')
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSON (${(error as Error).message})`);
      }
    });
  return out;
}

// Write to a sibling .tmp file and rename over the target, so a crash mid-write never leaves a
// truncated or partial file in place — only an ignored .tmp leftover, or the previous good version.
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileAtomic(path, rows.map((row) => canonicalJson(row) + '\n').join(''));
}
