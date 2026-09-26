// Request-boundary checks shared by server.ts: the culture guard (a differently-cased or
// path-traversing culture must never reach a file path, an empty-map insert, or the store) and payload
// shape validation for the plugin's Push and Ack (a malformed entry must be rejected whole, before any
// store change, rather than partially applied and crashing later reads).
import { PLURAL_CATEGORIES } from './precheck.js';
import type { LocHubStore } from './store.js';

// BCP-47-ish: a 2-3 letter primary subtag, then any number of '-'-separated 2-8 char alphanumeric subtags.
export const CULTURE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Returns the first problem with `culture`, or null when it is safe to use as a file-path component and to
// key the store's per-culture maps. A value that only differs in case from a culture the store already
// holds is rejected too: cells.ru.jsonl and cells.RU.jsonl are the same file on NTFS. `extra`
// lets the caller widen the comparison to cultures that have no cells/glossary/style yet — a job just
// started or being estimated for one spelling must still block a differently-cased one elsewhere.
export function checkCulture(store: LocHubStore, culture: unknown, extra: Iterable<string> = []): string | null {
  if (typeof culture !== 'string' || !CULTURE_RE.test(culture)) return 'Invalid culture';
  for (const existing of cultureKeysOf(store, extra)) {
    if (existing !== culture && existing.toLowerCase() === culture.toLowerCase()) return `Culture must be spelled "${existing}"`;
  }
  return null;
}

function* cultureKeysOf(store: LocHubStore, extra: Iterable<string>): IterableIterator<string> {
  yield* store.cells.keys();
  yield* store.glossary.keys();
  yield* store.style.keys();
  yield* extra;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

const ENTRY_STRING_FIELDS = ['namespace', 'key', 'source', 'origin', 'devNotes', 'groupKey'] as const;

// Validates a Push body. Returns the first problem, naming its index, or null when the whole snapshot is
// well-formed (target/nativeCulture/cultures are filled in with defaults by the caller and are not checked
// here). An old client's headSha/dirty fields, if still sent, are simply not looked at: they are unknown fields
// this function never rejects.
export function validateSnapshot(body: unknown): string | null {
  if (!isRecord(body)) return 'Snapshot must be an object';
  if (!Array.isArray(body.entries)) return 'entries must be an array';
  for (let i = 0; i < body.entries.length; i++) {
    const error = validateEntry(body.entries[i], i);
    if (error) return error;
  }
  if (body.archives !== undefined) {
    const error = validateArchives(body.archives);
    if (error) return error;
  }
  if (body.coverage !== undefined) {
    const error = validateCoverage(body.coverage);
    if (error) return error;
  }
  if (body.pluralForms !== undefined) {
    const error = validatePluralForms(body.pluralForms);
    if (error) return error;
  }
  return null;
}

// Optional (an older plugin does not send it). Every present culture carries both types as a non-empty list
// of CLDR category names: the engine always reports at least 'other'.
function validatePluralForms(pluralForms: unknown): string | null {
  if (!isRecord(pluralForms)) return 'pluralForms must be an object';
  const seen = new Map<string, string>();
  for (const [culture, forms] of Object.entries(pluralForms)) {
    if (!CULTURE_RE.test(culture)) return `pluralForms key "${culture}" is not a valid culture`;
    const existing = seen.get(culture.toLowerCase());
    if (existing !== undefined) return `pluralForms keys "${existing}" and "${culture}" differ only in case`;
    seen.set(culture.toLowerCase(), culture);
    if (!isRecord(forms)) return `pluralForms.${culture} must be an object`;
    for (const type of ['cardinal', 'ordinal'] as const) {
      const list = forms[type];
      const valid = Array.isArray(list) && list.length > 0 && list.every((c) => typeof c === 'string' && PLURAL_CATEGORIES.has(c));
      if (!valid) return `pluralForms.${culture}.${type} must be a non-empty array of plural categories`;
    }
  }
  return null;
}

function validateEntry(entry: unknown, index: number): string | null {
  if (!isRecord(entry)) return `entries[${index}] must be an object`;
  for (const field of ENTRY_STRING_FIELDS) {
    if (typeof entry[field] !== 'string') return `entries[${index}].${field} must be a string`;
  }
  if (!isStringMap(entry.metadata)) return `entries[${index}].metadata must be an object of strings`;
  return null;
}

// Exported so POST /api/reconcile can validate its `archives` body with the exact rules Push applies,
// without duplicating them.
export function validateArchives(archives: unknown): string | null {
  if (!isRecord(archives)) return 'archives must be an object';
  // A culture just starting a job has no committed cells/glossary/style to compare against, so a
  // snapshot carrying two archive keys that differ only in case must be caught within the payload itself.
  const seen = new Map<string, string>();
  for (const [culture, list] of Object.entries(archives)) {
    if (!CULTURE_RE.test(culture)) return `archives key "${culture}" is not a valid culture`;
    const lower = culture.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined && existing !== culture) return `archives keys "${existing}" and "${culture}" differ only in case`;
    seen.set(lower, culture);
    if (!Array.isArray(list)) return `archives.${culture} must be an array`;
    for (let i = 0; i < list.length; i++) {
      const error = validateArchiveEntry(list[i], culture, i);
      if (error) return error;
    }
  }
  return null;
}

function validateArchiveEntry(entry: unknown, culture: string, index: number): string | null {
  if (!isRecord(entry)) return `archives.${culture}[${index}] must be an object`;
  for (const field of ['namespace', 'key', 'translation', 'source'] as const) {
    if (typeof entry[field] !== 'string') return `archives.${culture}[${index}].${field} must be a string`;
  }
  return null;
}

const COVERAGE_STRING_FIELDS = ['kind', 'file', 'text'] as const;

function validateCoverage(coverage: unknown): string | null {
  if (!Array.isArray(coverage)) return 'coverage must be an array';
  for (let i = 0; i < coverage.length; i++) {
    const finding = coverage[i];
    if (!isRecord(finding)) return `coverage[${i}] must be an object`;
    for (const field of COVERAGE_STRING_FIELDS) {
      if (typeof finding[field] !== 'string') return `coverage[${i}].${field} must be a string`;
    }
    if (typeof finding.line !== 'number') return `coverage[${i}].line must be a number`;
  }
  return null;
}

// Validates a POST /api/reconcile body: just the `archives` object of a Push snapshot, same rules as Push.
export function validateReconcileBody(body: unknown): string | null {
  if (!isRecord(body)) return 'Body must be an object';
  return validateArchives(body.archives);
}

// Validates the optional expectedRevision/expectedSourceRev fields of a cell action body (optimistic
// concurrency). Both are optional — absent means "don't check that field", exactly today's behaviour for the
// plugin and older web clients — but a present value that isn't a number is a 400.
export function validateExpected(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'number') return 'expectedRevision must be a number';
  if (body.expectedSourceRev !== undefined && typeof body.expectedSourceRev !== 'number') return 'expectedSourceRev must be a number';
  return null;
}

// Validates the optional `accept` of an approve/edit body: the confirm issue codes the reviewer saw and approves
// anyway (cells.ts). Absent means none; anything but an array of strings is a 400.
export function validateAccept(body: unknown): string | null {
  if (!isRecord(body) || body.accept === undefined) return null;
  if (!Array.isArray(body.accept) || !body.accept.every((code) => typeof code === 'string')) return 'accept must be an array of strings';
  return null;
}

// Validates the optional groupPrefix on POST /api/jobs and /api/jobs/estimate (path/folder filter):
// present means non-empty and at most 512 chars, and it is mutually exclusive with groupKey (a request naming
// both is ambiguous about which scope wins, so it is refused rather than silently picking one).
export function validateJobScope(body: { groupKey?: unknown; groupPrefix?: unknown }): string | null {
  if (body.groupPrefix === undefined) return null;
  if (typeof body.groupPrefix !== 'string' || body.groupPrefix.length === 0 || body.groupPrefix.length > 512) return 'invalid_scope';
  if (typeof body.groupKey === 'string') return 'invalid_scope';
  return null;
}

// Validates an /api/export/ack body.
export function validateAck(body: unknown): string | null {
  if (!isRecord(body)) return 'Ack must be an object';
  if (typeof body.culture !== 'string') return 'culture must be a string';
  if (!Array.isArray(body.written)) return 'written must be an array';
  if (!Array.isArray(body.rejected)) return 'rejected must be an array';
  for (let i = 0; i < body.written.length; i++) {
    const row = body.written[i];
    if (!isRecord(row) || typeof row.unitId !== 'string' || typeof row.translation !== 'string')
      return `written[${i}] must have string unitId and translation`;
  }
  for (let i = 0; i < body.rejected.length; i++) {
    const row = body.rejected[i];
    if (!isRecord(row) || typeof row.unitId !== 'string' || typeof row.translation !== 'string')
      return `rejected[${i}] must have string unitId and translation`;
    if (!Array.isArray(row.errors) || !row.errors.every((e) => typeof e === 'string')) return `rejected[${i}].errors must be a string array`;
  }
  return null;
}
