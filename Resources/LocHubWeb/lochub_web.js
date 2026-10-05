// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { r as reactExports, j as jsxRuntimeExports, u as useVirtualizer, c as clientExports } from "./lochub_web_deps.js";
class ApiError extends Error {
  constructor(status, body, message) {
    super(message);
    __publicField(this, "status");
    __publicField(this, "body");
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}
const PAGE_LIMIT = 1e3;
const ALL_CELLS_CONCURRENCY = 4;
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (; ; ) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === void 0 || value === "" || value === false) continue;
    search.set(key, value === true ? "1" : String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : "";
}
const segment = encodeURIComponent;
function expectedBody(expected) {
  return expected ? { expectedRevision: expected.revision, expectedSourceRev: expected.sourceRev } : {};
}
function acceptBody(accept) {
  return accept && accept.length > 0 ? { accept: [...accept] } : {};
}
class LocHubApi {
  constructor(baseUrl = "", fetchImpl = (input, init) => fetch(input, init)) {
    __publicField(this, "baseUrl");
    __publicField(this, "fetchImpl");
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }
  async request(method, path, body) {
    const init = { method };
    if (method !== "GET") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body ?? {});
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    let parsed;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : void 0;
    } catch {
      parsed = void 0;
    }
    if (!response.ok) {
      const errorBody = parsed !== null && typeof parsed === "object" ? parsed : {};
      throw new ApiError(response.status, errorBody, errorBody.message ?? errorBody.error ?? `${method} ${path} failed: ${response.status}`);
    }
    return parsed;
  }
  health() {
    return this.request("GET", "/api/health");
  }
  meta() {
    return this.request("GET", "/api/meta");
  }
  cells(culture, query = {}) {
    return this.request("GET", `/api/cells${queryString({ culture, ...query })}`);
  }
  // Fetches the first page alone to learn `total`, then the remaining pages with up to 4 requests in flight at
  // once, concatenated back into offset order regardless of which one resolves first. `total` can itself grow
  // between rounds (a unit was added to the culture while this was still paging); each round re-reads the
  // latest known total and fetches whatever offsets it now covers that were not fetched yet, looping until a
  // round reports no further growth. Offsets only ever increase across rounds, so appending each round's pages
  // after the previous one keeps the result in offset order throughout.
  async allCells(culture) {
    const first = await this.cells(culture, { limit: PAGE_LIMIT, offset: 0 });
    const rows = first.rows.slice();
    let total = first.total;
    let nextOffset = PAGE_LIMIT;
    while (nextOffset < total) {
      const offsets = [];
      for (; nextOffset < total; nextOffset += PAGE_LIMIT) offsets.push(nextOffset);
      const pages = await mapWithConcurrency(offsets, ALL_CELLS_CONCURRENCY, (offset) => this.cells(culture, { limit: PAGE_LIMIT, offset }));
      for (const page of pages) {
        rows.push(...page.rows);
        if (page.total > total) total = page.total;
      }
    }
    return rows;
  }
  approve(culture, unitId, expected, accept) {
    return this.request("POST", `/api/cells/${segment(culture)}/${segment(unitId)}/approve`, { ...expectedBody(expected), ...acceptBody(accept) });
  }
  edit(culture, unitId, text, expected, accept) {
    return this.request("POST", `/api/cells/${segment(culture)}/${segment(unitId)}/edit`, { text, ...expectedBody(expected), ...acceptBody(accept) });
  }
  reject(culture, unitId, note, expected) {
    return this.request("POST", `/api/cells/${segment(culture)}/${segment(unitId)}/reject`, { note, ...expectedBody(expected) });
  }
  // Read-only live format check, run against the draft as the reviewer types it: same precheck approve/edit
  // run, so the card can show why a draft would be refused before the click.
  check(culture, unitId, text) {
    return this.request("POST", `/api/cells/${segment(culture)}/${segment(unitId)}/check`, { text });
  }
  // Translation exchange (CONTRACT.md, POST /api/import): a dry run for the preview, then the same request with
  // dryRun false to apply it.
  importTranslations(request) {
    return this.request("POST", "/api/import", request);
  }
  retranslate(culture, unitId, note, asRule) {
    return this.request("POST", `/api/cells/${segment(culture)}/${segment(unitId)}/retranslate`, { note, asRule });
  }
  history(culture, unitId) {
    return this.request("GET", `/api/cells/${segment(culture)}/${segment(unitId)}/history`);
  }
  estimate(scope) {
    return this.request("POST", "/api/jobs/estimate", scope);
  }
  // maxUsd is undefined under the subscription backend (CONTRACT.md: ignored, not required) and skipEstimate is
  // undefined for a normal Run (JobsView's Run button, after Estimate) -- JSON.stringify drops an
  // undefined-valued key, so the body simply omits whichever of the two does not apply.
  startJob(scope, maxUsd, skipEstimate) {
    return this.request("POST", "/api/jobs", { ...scope, maxUsd, skipEstimate });
  }
  job(id) {
    return this.request("GET", `/api/jobs/${segment(id)}`);
  }
  // Job resume: the newest job record of the culture (running, else the most recently started finished/failed
  // one), so a view that lost its job id (e.g. remounted after a tab switch) can find it again. A 404 (the
  // culture has no job) resolves to undefined rather than throwing, since that is the normal, expected case.
  async currentJob(culture) {
    try {
      return await this.request("GET", `/api/jobs${queryString({ culture })}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return void 0;
      throw error;
    }
  }
  glossary(culture) {
    return this.request("GET", `/api/glossary/${segment(culture)}`);
  }
  saveGlossary(culture, terms) {
    return this.request("PUT", `/api/glossary/${segment(culture)}`, terms);
  }
  style(culture) {
    return this.request("GET", `/api/style/${segment(culture)}`);
  }
  saveStyle(culture, text) {
    return this.request("PUT", `/api/style/${segment(culture)}`, { text });
  }
  inbox(filter = {}) {
    return this.request("GET", `/api/inbox${queryString(filter)}`);
  }
  askContext(culture, unitId, question) {
    return this.request("POST", "/api/inbox", { culture, unitId, question });
  }
  answer(id, answer) {
    return this.request("POST", `/api/inbox/${segment(id)}/answer`, { answer });
  }
  dismiss(id) {
    return this.request("POST", `/api/inbox/${segment(id)}/dismiss`, {});
  }
  summary(culture) {
    return this.request("GET", `/api/summary${queryString({ culture })}`);
  }
  coverage() {
    return this.request("GET", "/api/coverage");
  }
  bridgeCommand(name, args) {
    return this.request("POST", "/api/bridge/command", { name, args });
  }
}
const STORAGE_KEY = "lochub.gridExtraColumns";
function visibleCultures(all, chosen, active) {
  if (chosen === void 0) return active ? [active] : [];
  const set = new Set(chosen.filter((code) => all.includes(code)));
  if (active) set.add(active);
  return all.filter((code) => set.has(code));
}
function extraColumns(visible, active, previous) {
  return visible.filter((code) => code !== active || ((previous == null ? void 0 : previous.includes(code)) ?? false));
}
function isStringArray$1(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function loadChosenColumns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return void 0;
    const parsed = JSON.parse(raw);
    return isStringArray$1(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function saveChosenColumns(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
  }
}
const CODE_TEXT = {
  editor_not_connected: "The editor is not connected.",
  job_running: "A job for this culture is already running."
};
function errorText(error) {
  if (error instanceof ApiError) {
    const code = error.body.error;
    if (code && code in CODE_TEXT) return CODE_TEXT[code];
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
const CSV_FILE_TYPES = "CSV files (*.csv)|*.csv|All files (*.*)|*.*";
const EXPORT_TITLE = "Export CSV";
const CSV_MIME = "text/csv;charset=utf-8";
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function pickFileFromBrowser(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      var _a;
      const file = (_a = input.files) == null ? void 0 : _a[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      void file.arrayBuffer().then(
        (buffer) => resolve({ name: file.name, bytes: new Uint8Array(buffer) }),
        () => resolve(null)
      );
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}
function downloadInBrowser(name, text, mime) {
  const blob = new Blob(["\uFEFF" + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return {};
}
async function pickTextFile(bridge, title, accept, fileTypes = CSV_FILE_TYPES) {
  if (!bridge.canPickFile()) return pickFileFromBrowser(accept);
  const result = await bridge.pickFile(title, fileTypes);
  if (result.cancelled) return null;
  return { name: result.name, bytes: base64ToBytes(result.base64) };
}
async function saveTextFile(bridge, name, text, fileTypes = CSV_FILE_TYPES, title = EXPORT_TITLE, mime = CSV_MIME) {
  if (!bridge.canSaveFile()) return downloadInBrowser(name, text, mime);
  const result = await bridge.saveFile(title, name, fileTypes, text);
  if (result.cancelled) return null;
  return { path: result.path };
}
const BOM = 65279;
function decodeUtf8(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The file is not UTF-8. Save it as "CSV UTF-8" and import again.');
  }
  return text.charCodeAt(0) === BOM ? text.slice(1) : text;
}
const DELIMITER_CANDIDATES = [",", ";", "	"];
function headerLine(text) {
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (inQuotes) {
        inQuotes = false;
      } else if (atFieldStart) {
        inQuotes = true;
      }
      atFieldStart = false;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) return text.slice(0, i);
    if (!inQuotes) atFieldStart = ch === "," || ch === ";" || ch === "	";
  }
  return text;
}
function detectDelimiter(text) {
  const line = headerLine(text);
  const counts = { ",": 0, ";": 0, "	": 0 };
  let inQuotes = false;
  let atFieldStart = true;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
        continue;
      }
      if (inQuotes) {
        inQuotes = false;
      } else if (atFieldStart) {
        inQuotes = true;
      }
      atFieldStart = false;
      continue;
    }
    if (!inQuotes && ch in counts) {
      counts[ch] = (counts[ch] ?? 0) + 1;
      atFieldStart = true;
      continue;
    }
    if (!inQuotes) atFieldStart = false;
  }
  let best = ",";
  let bestCount = counts[","];
  for (const candidate of DELIMITER_CANDIDATES) {
    if (counts[candidate] > bestCount) {
      best = candidate;
      bestCount = counts[candidate];
    }
  }
  return best;
}
function parseCsv(text) {
  var _a;
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field2 = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field2);
    field2 = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field2 += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field2 += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (field2.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field2 += ch;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field2 += ch;
    i += 1;
  }
  if (field2.length > 0 || row.length > 0) endRow();
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") rows.pop();
    else break;
  }
  const headerLength = ((_a = rows[0]) == null ? void 0 : _a.length) ?? 0;
  for (let r = 1; r < rows.length; r += 1) {
    const current = rows[r];
    while (current.length < headerLength) current.push("");
  }
  return rows;
}
const TERM_ALIASES = /* @__PURE__ */ new Set(["term", "source", "source term"]);
const TRANSLATION_ALIASES = /* @__PURE__ */ new Set(["translation", "target"]);
const DNT_ALIASES = /* @__PURE__ */ new Set(["dnt", "do not translate", "keep"]);
const NOTE_ALIASES = /* @__PURE__ */ new Set(["note", "comment"]);
const DNT_TRUE = /* @__PURE__ */ new Set(["yes", "y", "true", "1", "x", "+"]);
const DNT_FALSE = /* @__PURE__ */ new Set(["no", "n", "false", "0", "-", ""]);
const normalizeCultureKey = (value) => value.trim().toLowerCase().replace(/_/g, "-");
function parseDnt(raw) {
  const value = raw.trim().toLowerCase();
  if (DNT_TRUE.has(value)) return true;
  if (DNT_FALSE.has(value)) return false;
  return void 0;
}
function resolveColumns(header, cultures, nativeCulture, activeCulture) {
  const trimmed = header.map((cell) => cell.trim());
  const lower = trimmed.map((cell) => cell.toLowerCase());
  const used = /* @__PURE__ */ new Set();
  let termIndex = lower.findIndex((cell) => TERM_ALIASES.has(cell));
  if (termIndex === -1 && nativeCulture) {
    const nativeKey = normalizeCultureKey(nativeCulture);
    termIndex = trimmed.findIndex((cell) => normalizeCultureKey(cell) === nativeKey);
  }
  if (termIndex === -1) throw new Error('No "term" column. The first row must name the columns, e.g. term,translation,dnt,note.');
  used.add(termIndex);
  const cultureIndexes = /* @__PURE__ */ new Map();
  let translationIndex = -1;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (TRANSLATION_ALIASES.has(lower[i])) {
      translationIndex = i;
      break;
    }
  }
  if (translationIndex !== -1) {
    cultureIndexes.set(activeCulture, translationIndex);
    used.add(translationIndex);
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    if (used.has(i)) continue;
    const key = normalizeCultureKey(trimmed[i]);
    const match = cultures.find((culture) => normalizeCultureKey(culture) === key);
    if (!match) continue;
    if (match === activeCulture && translationIndex !== -1) {
      throw new Error(`Both "translation" and "${activeCulture}" columns fill ${activeCulture}; keep one.`);
    }
    if (!cultureIndexes.has(match)) {
      cultureIndexes.set(match, i);
      used.add(i);
    }
  }
  let dntIndex;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (DNT_ALIASES.has(lower[i])) {
      dntIndex = i;
      used.add(i);
      break;
    }
  }
  let noteIndex;
  for (let i = 0; i < lower.length; i += 1) {
    if (used.has(i)) continue;
    if (NOTE_ALIASES.has(lower[i])) {
      noteIndex = i;
      used.add(i);
      break;
    }
  }
  if (cultureIndexes.size === 0 && dntIndex === void 0) {
    throw new Error(`No translation column: add "translation" or one column per culture (${cultures.join(", ")}).`);
  }
  const ignoredColumns = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (!used.has(i)) ignoredColumns.push(trimmed[i]);
  }
  return { termIndex, cultureIndexes, dntIndex, noteIndex, ignoredColumns };
}
function readGlossaryCsv(rows, options) {
  const { cultures, nativeCulture, activeCulture } = options;
  const header = rows[0];
  if (!header) throw new Error('No "term" column. The first row must name the columns, e.g. term,translation,dnt,note.');
  const columns = resolveColumns(header, cultures, nativeCulture, activeCulture);
  const dntOnlyCulture = columns.cultureIndexes.size === 0 ? activeCulture : void 0;
  const skipped = [];
  const byKey = /* @__PURE__ */ new Map();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rowIndex + 1;
    const row = rows[rowIndex];
    const term = (row[columns.termIndex] ?? "").trim();
    if (term === "") {
      skipped.push({ line, reason: "empty term" });
      continue;
    }
    let dnt;
    if (columns.dntIndex !== void 0) {
      const raw = row[columns.dntIndex] ?? "";
      const parsed = parseDnt(raw);
      if (parsed === void 0) {
        skipped.push({ line, reason: `dnt value "${raw.trim()}" is not yes/no` });
        continue;
      }
      dnt = parsed;
    }
    const note = columns.noteIndex !== void 0 ? (row[columns.noteIndex] ?? "").trim() : void 0;
    const perCulture = /* @__PURE__ */ new Map();
    if (dntOnlyCulture !== void 0) {
      if (dnt === true) perCulture.set(dntOnlyCulture, void 0);
    } else {
      for (const [culture, index] of columns.cultureIndexes) {
        const raw = (row[index] ?? "").trim();
        if (raw.length > 0) perCulture.set(culture, raw);
        else if (dnt === true) perCulture.set(culture, void 0);
      }
    }
    if (perCulture.size === 0) {
      skipped.push({ line, reason: "no translation" });
      continue;
    }
    const key = term.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      skipped.push({ line: existing.line, reason: `duplicate of line ${line}` });
      byKey.delete(key);
    }
    byKey.set(key, { term, line, dnt, note, perCulture });
  }
  const byCulture = {};
  for (const entry of byKey.values()) {
    for (const [culture, translation] of entry.perCulture) {
      (byCulture[culture] ?? (byCulture[culture] = [])).push({ term: entry.term, translation, dnt: entry.dnt, note: entry.note });
    }
  }
  skipped.sort((a, b) => a.line - b.line);
  return { byCulture, skipped, ignoredColumns: columns.ignoredColumns };
}
function mergeGlossary(existing, incoming) {
  const key = (value) => value.trim().toLowerCase();
  const terms = existing.map((term) => ({ ...term }));
  const indexByKey = new Map(terms.map((term, index) => [key(term.term), index]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const incomingTerm of incoming) {
    const existingIndex = indexByKey.get(key(incomingTerm.term));
    if (existingIndex === void 0) {
      terms.push({
        term: incomingTerm.term,
        translation: incomingTerm.translation ?? "",
        dnt: incomingTerm.dnt ?? false,
        note: incomingTerm.note ?? ""
      });
      indexByKey.set(key(incomingTerm.term), terms.length - 1);
      added += 1;
      continue;
    }
    const current = terms[existingIndex];
    const next = { ...current };
    let changed = false;
    if (incomingTerm.translation !== void 0 && incomingTerm.translation !== "") {
      if (next.translation !== incomingTerm.translation) changed = true;
      next.translation = incomingTerm.translation;
    }
    if (incomingTerm.dnt !== void 0) {
      if (next.dnt !== incomingTerm.dnt) changed = true;
      next.dnt = incomingTerm.dnt;
    }
    if (incomingTerm.note !== void 0 && incomingTerm.note !== "") {
      if (next.note !== incomingTerm.note) changed = true;
      next.note = incomingTerm.note;
    }
    terms[existingIndex] = next;
    if (changed) updated += 1;
    else unchanged += 1;
  }
  return { terms, added, updated, unchanged };
}
function needsQuoting(value) {
  return value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r");
}
const FORMULA_INJECTION_PREFIXES = /* @__PURE__ */ new Set(["=", "+", "-", "@"]);
function csvField(value) {
  const guarded = FORMULA_INJECTION_PREFIXES.has(value[0] ?? "") ? `	${value}` : value;
  return needsQuoting(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
function glossaryToCsv(terms) {
  const lines = ["term,translation,dnt,note"];
  for (const term of terms) {
    lines.push([csvField(term.term), csvField(term.translation), term.dnt ? "yes" : "no", csvField(term.note)].join(","));
  }
  return lines.map((line) => `${line}\r
`).join("");
}
const normalize = (text) => text.trim().toLowerCase();
function changedTerms(before, after) {
  const previous = new Map(before.map((term) => [normalize(term.term), term]));
  return after.filter((term) => {
    const old = previous.get(normalize(term.term));
    return !old || old.translation !== term.translation || old.dnt !== term.dnt;
  });
}
function rowsUsingTerm(rows, culture, term) {
  const needle = normalize(term.term);
  const expected = normalize(term.dnt ? term.term : term.translation);
  if (!needle || !expected) return [];
  return rows.filter((row) => {
    var _a;
    const cell = (_a = row.cells[culture]) == null ? void 0 : _a.cell;
    return (cell == null ? void 0 : cell.status) === "ai_draft" && row.unit.source.toLowerCase().includes(needle) && !cell.text.toLowerCase().includes(expected);
  });
}
function termFixNote(term) {
  return term.dnt ? `Glossary: keep "${term.term}" untranslated.` : `Glossary: translate "${term.term}" as "${term.translation}".`;
}
function glossaryUnsaved(current, saved) {
  if (current.length !== saved.length) return true;
  return current.some((term, index) => {
    const other = saved[index];
    return term.term !== other.term || term.translation !== other.translation || term.dnt !== other.dnt || term.note !== other.note;
  });
}
const EMPTY_TERM = { term: "", translation: "", dnt: false, note: "" };
function GlossaryView({ api: api2, culture, rows, onCell, onTermFix, bridge, cultures, nativeCulture }) {
  const [terms, setTerms] = reactExports.useState([]);
  const [saved, setSaved] = reactExports.useState([]);
  const [style, setStyle] = reactExports.useState("");
  const [fixes, setFixes] = reactExports.useState([]);
  const [notice, setNotice] = reactExports.useState("");
  const [error, setError] = reactExports.useState("");
  const [preview, setPreview] = reactExports.useState(null);
  const [importing, setImporting] = reactExports.useState(false);
  const [pickingImport, setPickingImport] = reactExports.useState(false);
  const [exporting, setExporting] = reactExports.useState(false);
  const cultureRef = reactExports.useRef(culture);
  const previewDialogRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    cultureRef.current = culture;
  }, [culture]);
  reactExports.useEffect(() => {
    var _a;
    if (preview) (_a = previewDialogRef.current) == null ? void 0 : _a.focus();
  }, [preview]);
  reactExports.useEffect(() => {
    let alive = true;
    setFixes([]);
    setPreview(null);
    setImporting(false);
    Promise.all([api2.glossary(culture), api2.style(culture)]).then(
      ([glossary, guide]) => {
        if (!alive) return;
        setTerms(glossary);
        setSaved(glossary);
        setStyle(guide.text);
      },
      (e) => {
        if (alive) setError(errorText(e));
      }
    );
    return () => {
      alive = false;
    };
  }, [api2, culture]);
  const update = (index, patch) => setTerms((list) => list.map((term, i) => i === index ? { ...term, ...patch } : term));
  const saveGlossary = async () => {
    const savingCulture = culture;
    setError("");
    setNotice("");
    const clean = terms.filter((term) => term.term.trim().length > 0);
    try {
      await api2.saveGlossary(savingCulture, clean);
      if (cultureRef.current !== savingCulture) return;
      const next = changedTerms(saved, clean).map((term) => ({ term, culture: savingCulture, unitIds: rowsUsingTerm(rows, savingCulture, term).map((row) => row.unit.id) })).filter((fix) => fix.unitIds.length > 0);
      setFixes(next);
      setSaved(clean);
      setTerms(clean);
      setNotice("Glossary saved.");
    } catch (e) {
      if (cultureRef.current !== savingCulture) return;
      setError(errorText(e));
    }
  };
  const applyFix = async (fix) => {
    setError("");
    try {
      for (const unitId of fix.unitIds) onCell((await api2.reject(fix.culture, unitId, termFixNote(fix.term))).cell);
      setFixes((list) => list.filter((candidate) => candidate !== fix));
      onTermFix({ culture: fix.culture, unitIds: fix.unitIds });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const startImport = async () => {
    if (pickingImport) return;
    setPickingImport(true);
    setError("");
    setNotice("");
    try {
      if (glossaryUnsaved(terms, saved)) {
        setError("Save your glossary changes before importing.");
        return;
      }
      const picked = await pickTextFile(bridge, "Import glossary CSV", ".csv,text/csv");
      if (!picked) return;
      const text = decodeUtf8(picked.bytes);
      const csvRows = parseCsv(text);
      const { byCulture, skipped, ignoredColumns } = readGlossaryCsv(csvRows, { cultures, nativeCulture, activeCulture: culture });
      const perCulture = [];
      for (const [cultureCode, incoming] of Object.entries(byCulture)) {
        const existing = cultureCode === culture ? saved : await api2.glossary(cultureCode);
        const merged = mergeGlossary(existing, incoming);
        perCulture.push({ culture: cultureCode, added: merged.added, updated: merged.updated });
      }
      setPreview({ byCulture, perCulture, skipped, ignoredColumns });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPickingImport(false);
    }
  };
  const cancelImport = () => setPreview(null);
  const confirmImport = async () => {
    if (!preview) return;
    if (glossaryUnsaved(terms, saved)) {
      setError("Save your glossary changes before importing.");
      return;
    }
    const importingCulture = culture;
    setImporting(true);
    setError("");
    const savedCultures = [];
    let loopError;
    try {
      for (const [cultureCode, incoming] of Object.entries(preview.byCulture)) {
        try {
          const existing = await api2.glossary(cultureCode);
          const merged = mergeGlossary(existing, incoming);
          await api2.saveGlossary(cultureCode, merged.terms);
          savedCultures.push(cultureCode);
        } catch (e) {
          loopError = e;
          break;
        }
      }
      if (cultureRef.current !== importingCulture) {
        const switchedTo = cultureRef.current;
        if (savedCultures.includes(switchedTo)) {
          try {
            const refreshed = await api2.glossary(switchedTo);
            if (cultureRef.current === switchedTo) {
              setSaved(refreshed);
              setTerms(refreshed);
            }
          } catch {
          }
        }
        return;
      }
      if (savedCultures.includes(importingCulture)) {
        const before = saved;
        const refreshed = await api2.glossary(importingCulture);
        if (cultureRef.current !== importingCulture) return;
        const nextFixes = changedTerms(before, refreshed).map((term) => ({ term, culture: importingCulture, unitIds: rowsUsingTerm(rows, importingCulture, term).map((row) => row.unit.id) })).filter((fix) => fix.unitIds.length > 0);
        setFixes(nextFixes);
        setSaved(refreshed);
        setTerms(refreshed);
      }
      if (loopError) {
        setError(`Import stopped: ${errorText(loopError)}. Saved: ${savedCultures.length > 0 ? savedCultures.join(", ") : "no cultures"}.`);
      } else {
        const summary = preview.perCulture.map((p) => `${p.culture} ${p.added} new${p.updated > 0 ? `, ${p.updated} updated` : ""}`).join("; ");
        setNotice(`Imported: ${summary}.`);
      }
    } catch (e) {
      if (cultureRef.current === importingCulture) setError(errorText(e));
    } finally {
      setPreview(null);
      setImporting(false);
    }
  };
  const exportGlossary = async () => {
    if (exporting) return;
    setExporting(true);
    setError("");
    setNotice("");
    try {
      const clean = terms.filter((term) => term.term.trim().length > 0);
      const csv = glossaryToCsv(clean);
      const name = `glossary-${culture}.csv`;
      const result = await saveTextFile(bridge, name, csv);
      if (!result) return;
      setNotice(result.path ? `Saved to ${result.path}` : `Downloaded ${name}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const saveStyle = async () => {
    setError("");
    setNotice("");
    try {
      await api2.saveStyle(culture, style);
      setNotice("Style guide saved.");
    } catch (e) {
      setError(errorText(e));
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "glossary", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("h2", { children: [
      "Glossary (",
      culture,
      ")"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("table", { className: "terms", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("thead", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Term" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Translation" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Do not translate" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Note" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", {})
      ] }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("tbody", { children: terms.map((term, index) => /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("input", { "aria-label": `Term ${index + 1}`, value: term.term, onChange: (e) => update(index, { term: e.target.value }) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("input", { "aria-label": `Translation ${index + 1}`, value: term.translation, disabled: term.dnt, onChange: (e) => update(index, { translation: e.target.value }) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", "aria-label": `Do not translate ${index + 1}`, checked: term.dnt, onChange: (e) => update(index, { dnt: e.target.checked }) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("input", { "aria-label": `Note ${index + 1}`, value: term.note, onChange: (e) => update(index, { note: e.target.value }) }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => setTerms((list) => list.filter((_, i) => i !== index)), children: "Remove" }) })
      ] }, index)) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => setTerms((list) => [...list, { ...EMPTY_TERM }]), children: "Add term" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void saveGlossary(), children: "Save glossary" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void startImport(), disabled: pickingImport, children: "Import CSV…" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void exportGlossary(), disabled: exporting, children: "Export CSV" })
    ] }),
    preview && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "import-preview", role: "dialog", "aria-label": "Import glossary", ref: previewDialogRef, tabIndex: -1, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Import preview" }),
      preview.perCulture.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: "No terms to import." }) : /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: preview.perCulture.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
        p.culture,
        ": ",
        p.added,
        " new, ",
        p.updated,
        " updated"
      ] }, p.culture)) }),
      preview.skipped.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "skipped", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("h4", { children: "Skipped rows" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: preview.skipped.slice(0, 20).map((s) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          "Line ",
          s.line,
          ": ",
          s.reason
        ] }, s.line)) })
      ] }),
      preview.ignoredColumns.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
        "Ignored columns: ",
        preview.ignoredColumns.join(", ")
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void confirmImport(), disabled: importing || preview.perCulture.length === 0, children: importing ? "Importing…" : "Import" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: cancelImport, disabled: importing, children: "Cancel" })
      ] })
    ] }),
    fixes.map((fix) => /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "term-fix", children: [
      '"',
      fix.term.term,
      '" appears in ',
      fix.unitIds.length,
      " ",
      fix.culture,
      " AI ",
      fix.unitIds.length === 1 ? "draft" : "drafts",
      " that do not follow it.",
      " ",
      /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", onClick: () => void applyFix(fix), children: [
        "Apply to ",
        fix.unitIds.length,
        " ",
        fix.unitIds.length === 1 ? "string" : "strings"
      ] })
    ] }, fix.term.term)),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("h2", { children: [
      "Style guide (",
      culture,
      ")"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("textarea", { "aria-label": "Style guide", rows: 10, value: style, onChange: (e) => setStyle(e.target.value) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "actions", children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void saveStyle(), children: "Save style guide" }) }),
    notice && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "notice", role: "status", children: notice }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
function emptyCell(unitId, culture) {
  return {
    unitId,
    culture,
    text: "",
    status: "empty",
    basedOnSourceRev: 0,
    basedOnSource: "",
    provenance: "",
    ambiguity: "none",
    alts: [],
    question: "",
    note: "",
    suggestion: "",
    judgeIssues: [],
    qaFlags: [],
    band: "",
    archiveHash: "",
    revision: 0
  };
}
function isOutdated(unit, cell) {
  return cell.status !== "empty" && cell.text.length > 0 && cell.basedOnSourceRev < unit.sourceRev;
}
const EXPORTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/i;
const LINE_SUFFIX = /(?:\((\d+)\)|:(\d+))$/;
const FILE_EXTENSION = /\.(c|cc|cpp|cs|csv|h|hpp|inl|ini|json|py|rml|txt)$/i;
function parseOrigin(origin) {
  let path = origin.trim().replaceAll("\\", "/");
  let line = 0;
  const suffix = LINE_SUFFIX.exec(path);
  if (suffix && suffix.index > 1) {
    line = Number(suffix[1] ?? suffix[2]);
    path = path.slice(0, suffix.index);
  }
  if (path.length === 0) return { kind: "unknown", path: "", line: 0 };
  if (path.startsWith("/") && !FILE_EXTENSION.test(path)) {
    if (path.startsWith("/Script/")) return { kind: "unknown", path, line: 0 };
    return { kind: "asset", path: path.split(".")[0] ?? path, line: 0 };
  }
  return { kind: "file", path: path.replace(/^\/+/, ""), line };
}
function originLabel(origin) {
  return origin.kind === "file" && origin.line > 0 ? `${origin.path}:${origin.line}` : origin.path;
}
function describeOrigin(origin) {
  const parsed = parseOrigin(origin);
  if (parsed.kind !== "asset") return { ...parsed, member: "" };
  const normalized = origin.trim().replaceAll("\\", "/");
  const prefix = `${parsed.path}.`;
  return { ...parsed, member: normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "" };
}
const NO_FILTERS = { q: "", status: "", band: "", outdated: false, namespace: "", asset: "" };
function compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
function computeSearch(unit, cells) {
  return [unit.key, unit.source, ...Object.values(cells).map((c) => c.cell.text)].join(" ").toLowerCase();
}
function mergeCulture(data, culture, rows) {
  const next = new Map(data);
  for (const { unit, cell, outdated, lengthLimit } of rows) {
    const existing = next.get(unit.id);
    const cells = { ...(existing == null ? void 0 : existing.cells) ?? {}, [culture]: { cell, outdated, lengthLimit } };
    if (existing !== void 0 && (existing.unit.sourceRev !== unit.sourceRev || existing.unit.source !== unit.source)) {
      const refreshedCells = {};
      const sourceChanged = existing.unit.source !== unit.source;
      for (const [c, gridCell] of Object.entries(cells)) {
        const lengthLimit2 = c === culture || !sourceChanged ? gridCell.lengthLimit : void 0;
        refreshedCells[c] = { cell: gridCell.cell, outdated: isOutdated(unit, gridCell.cell), lengthLimit: lengthLimit2 };
      }
      next.set(unit.id, { unit, cells: refreshedCells, search: computeSearch(unit, refreshedCells) });
      continue;
    }
    const base = (existing == null ? void 0 : existing.search) ?? `${unit.key} ${unit.source}`.toLowerCase();
    next.set(unit.id, { unit, cells, search: `${base} ${cell.text.toLowerCase()}` });
  }
  return next;
}
function dropCultures(data, cultures) {
  if (cultures.length === 0) return data;
  const next = new Map(data);
  for (const [id, row] of next) {
    if (!cultures.some((c) => c in row.cells)) continue;
    const cells = { ...row.cells };
    for (const c of cultures) delete cells[c];
    next.set(id, { ...row, cells, search: computeSearch(row.unit, cells) });
  }
  return next;
}
function withCell(data, cell) {
  var _a;
  const row = data.get(cell.unitId);
  if (!row) return data;
  const next = new Map(data);
  const cells = { ...row.cells, [cell.culture]: { cell, outdated: isOutdated(row.unit, cell), lengthLimit: (_a = row.cells[cell.culture]) == null ? void 0 : _a.lengthLimit } };
  next.set(cell.unitId, { ...row, cells, search: computeSearch(row.unit, cells) });
  return next;
}
function withUnit(data, unit) {
  const row = data.get(unit.id);
  if (!row) return data;
  const next = new Map(data);
  const cells = {};
  for (const [culture, gridCell] of Object.entries(row.cells)) {
    const lengthLimit = unit.source === row.unit.source ? gridCell.lengthLimit : void 0;
    cells[culture] = { cell: gridCell.cell, outdated: isOutdated(unit, gridCell.cell), lengthLimit };
  }
  next.set(unit.id, { unit, cells, search: computeSearch(unit, cells) });
  return next;
}
function sortRows(data) {
  return [...data.values()].sort((a, b) => compareText(a.unit.namespace, b.unit.namespace) || compareText(a.unit.key, b.unit.key));
}
function assetOf(unit) {
  const origin = parseOrigin(unit.origin);
  return origin.kind === "unknown" ? "" : origin.path;
}
function matchesPath(candidate, filter) {
  return filter.endsWith("/") ? candidate.startsWith(filter) : candidate === filter;
}
function filterRows(rows, culture, filters) {
  const needle = filters.q.trim().toLowerCase();
  const { status: statusFilter, band: bandFilter, outdated: outdatedFilter, namespace: namespaceFilter, asset: assetFilter } = filters;
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const gridCell = row.cells[culture];
    if (statusFilter && ((gridCell == null ? void 0 : gridCell.cell.status) ?? "empty") !== statusFilter) continue;
    const band = (gridCell == null ? void 0 : gridCell.cell.band) ?? "";
    if (bandFilter === "none" && band !== "") continue;
    if (bandFilter !== "" && bandFilter !== "none" && band !== bandFilter) continue;
    if (outdatedFilter && !(gridCell == null ? void 0 : gridCell.outdated)) continue;
    if (namespaceFilter && row.unit.namespace !== namespaceFilter) continue;
    if (assetFilter && !matchesPath(assetOf(row.unit), assetFilter)) continue;
    if (needle && !(row.search ?? computeSearch(row.unit, row.cells)).includes(needle)) continue;
    results.push(row);
  }
  return results;
}
function facets(rows) {
  const namespaces = /* @__PURE__ */ new Set();
  for (const row of rows) namespaces.add(row.unit.namespace);
  return { namespaces: [...namespaces].sort(compareText) };
}
function assetPathEntries(rows) {
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const asset = assetOf(row.unit);
    if (asset) counts.set(asset, (counts.get(asset) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}
function cellTone(gridCell) {
  if (!gridCell || gridCell.cell.status === "empty") return "tone-empty";
  if (gridCell.outdated) return "tone-outdated";
  switch (gridCell.cell.status) {
    case "approved":
    case "edited":
    case "human_edit":
      return "tone-done";
    case "needs_fix":
    case "rejected":
      return "tone-bad";
    default:
      return `tone-band-${gridCell.cell.band || "none"}`;
  }
}
function statusChip(gridCell) {
  const tone = cellTone(gridCell);
  if (tone === "tone-empty") return void 0;
  if (tone === "tone-outdated") return { label: "Outdated", tone };
  if (tone === "tone-done") {
    const label = gridCell.cell.status === "approved" ? "Approved" : gridCell.cell.status === "edited" ? "Edited" : "Human";
    return { label, tone };
  }
  if (tone === "tone-bad") {
    const label = gridCell.cell.status === "needs_fix" ? "Needs fix" : "Rejected";
    return { label, tone };
  }
  return { label: "Draft", tone };
}
function liveEntries(rows, culture) {
  return rows.flatMap((row) => {
    var _a;
    const cell = (_a = row.cells[culture]) == null ? void 0 : _a.cell;
    if (!cell || cell.text.length === 0 || cell.status === "rejected" || cell.status === "needs_fix") return [];
    return [{ namespace: row.unit.namespace, key: row.unit.key, source: row.unit.source, translation: cell.text }];
  });
}
function exportStatus(row) {
  return row.outdated ? "outdated" : row.cell.status;
}
function sameCulture(a, b) {
  const normalize2 = (code) => code.trim().toLowerCase().replace(/_/g, "-");
  return normalize2(a) === normalize2(b);
}
const EXCHANGE_CSV_COLUMNS = ["namespace", "key", "source", "translation", "status", "context", "notes", "max_length", "lochub_id", "lochub_revision"];
const REQUIRED_COLUMNS_MESSAGE = 'The CSV needs a "translation" column and either "lochub_id" or both "namespace" and "key" (the header row LocHub exports).';
const GUARDED_START = /* @__PURE__ */ new Set([...FORMULA_INJECTION_PREFIXES, "	"]);
function guard(value) {
  return GUARDED_START.has(value[0] ?? "") ? `	${value}` : value;
}
function unguard(value) {
  return value[0] === "	" && GUARDED_START.has(value[1] ?? "") ? value.slice(1) : value;
}
function field(value) {
  const guarded = guard(value);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
function exchangeToCsv(rows) {
  const lines = [EXCHANGE_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const limit = row.lengthLimit ?? null;
    lines.push(
      [
        field(row.unit.namespace),
        field(row.unit.key),
        field(row.unit.source),
        field(row.cell.text),
        exportStatus(row),
        field(row.unit.origin),
        field(row.unit.devNotes),
        limit === null ? "" : String(limit),
        field(row.unit.id),
        // Always written, including 0 for a string that was empty at export: the import's conflict check (the
        // conflict rule) needs the revision to notice a LocHub write made after the export to a string that was
        // empty then.
        String(row.cell.revision)
      ].join(",")
    );
  }
  return lines.map((line) => `${line}\r
`).join("");
}
function readExchangeCsv(text) {
  var _a, _b;
  const rows = parseCsv(text);
  const headerRow = rows[0] ?? [];
  const header = headerRow.map((name) => name.trim().toLowerCase());
  const column = (name) => header.indexOf(name);
  const translation = column("translation");
  const id = column("lochub_id");
  const namespace = column("namespace");
  const key = column("key");
  if (translation < 0 || id < 0 && (namespace < 0 || key < 0)) throw new Error(REQUIRED_COLUMNS_MESSAGE);
  const source = column("source");
  const status = column("status");
  const revision = column("lochub_revision");
  const known = new Set(EXCHANGE_CSV_COLUMNS);
  const ignoredColumns = headerRow.filter((name, i) => name.trim() !== "" && !known.has(header[i])).map((name) => name.trim());
  const entries = [];
  const labels = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.every((value2) => value2.trim() === "")) continue;
    const value = (index) => index < 0 ? void 0 : unguard(cells[index] ?? "");
    const entry = { text: value(translation) ?? "", approved: (value(status) ?? "").trim().toLowerCase() === "approved" };
    const unitId = (_a = value(id)) == null ? void 0 : _a.trim();
    if (unitId) entry.unitId = unitId;
    if (namespace >= 0 && key >= 0) {
      entry.namespace = value(namespace) ?? "";
      entry.key = value(key) ?? "";
    }
    const sourceText = value(source);
    if (sourceText) entry.source = sourceText;
    const exported = ((_b = value(revision)) == null ? void 0 : _b.trim()) ?? "";
    if (/^\d+$/.test(exported)) entry.exportedRevision = Number(exported);
    entries.push(entry);
    labels.push(entry.key !== void 0 ? `Row ${r + 1}: ${entry.namespace}/${entry.key}` : `Row ${r + 1}`);
  }
  return { format: "csv", entries, labels, ignoredColumns, copyOfSource: entries.map(() => false) };
}
const ESCAPE$1 = "`";
const ESCAPED_CHARS = /* @__PURE__ */ new Set(["`", "{", "}", "|"]);
const TAG$1 = /<[\w.-]+(?:\s+[\w.-]+="[^"]*")*\s*\/?>/y;
const MODIFIER_NAME = /[A-Za-z]+\(/y;
function modifierEnd(text, start) {
  let inQuotes = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === ESCAPE$1 && i + 1 < text.length) {
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ")") return i + 1;
  }
  return -1;
}
function splitInlineCodes(text) {
  const parts = [];
  let plain = "";
  const code = (value) => {
    if (plain) parts.push({ code: false, text: plain });
    plain = "";
    parts.push({ code: true, text: value });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const nextChar = text[i + 1];
    if (c === ESCAPE$1 && nextChar && ESCAPED_CHARS.has(nextChar)) {
      plain += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "{") {
      const close = text.indexOf("}", i + 1);
      if (close < 0) {
        plain += text.slice(i);
        break;
      }
      const after = close + 1;
      if (text[after] === "|") {
        MODIFIER_NAME.lastIndex = after + 1;
        if (MODIFIER_NAME.test(text)) {
          const end = modifierEnd(text, MODIFIER_NAME.lastIndex);
          const stop = end < 0 ? text.length : end;
          plain += text.slice(i, stop);
          i = stop;
          continue;
        }
      }
      code(text.slice(i, after));
      i = after;
      continue;
    }
    if (c === "<") {
      if (text.startsWith("</>", i)) {
        code("</>");
        i += 3;
        continue;
      }
      TAG$1.lastIndex = i;
      const tag = TAG$1.exec(text);
      if (tag) {
        code(tag[0]);
        i += tag[0].length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  if (plain) parts.push({ code: false, text: plain });
  return parts;
}
const XLIFF_NS = "urn:oasis:names:tc:xliff:document:1.2";
const LOCHUB_NS = "urn:lochub:xliff";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const TARGET_STATE = {
  ai_draft: "needs-review-translation",
  needs_fix: "needs-review-translation",
  edited: "translated",
  human_edit: "translated",
  approved: "final",
  rejected: "needs-translation",
  outdated: "needs-translation"
};
const XML_INVALID = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F￾￿]|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]");
const CODE_ELEMENTS = /* @__PURE__ */ new Set(["ph", "x", "bx", "ex", "it", "bpt", "ept"]);
const EMPTY_BY_ID = /* @__PURE__ */ new Set(["x", "bx", "ex"]);
const COPY_SOURCE_STATES = /* @__PURE__ */ new Set(["new", "needs-translation"]);
function element(doc, name, attributes = {}) {
  const el = doc.createElementNS(XLIFF_NS, name);
  for (const [attribute, value] of Object.entries(attributes)) el.setAttribute(attribute, value);
  return el;
}
function appendSegment(doc, parent, text, sourceCodes) {
  const codes = [];
  const unused = sourceCodes ? [...sourceCodes] : [];
  let nextId = sourceCodes ? sourceCodes.length : 0;
  for (const part of splitInlineCodes(text)) {
    if (!part.code) {
      parent.appendChild(doc.createTextNode(part.text));
      continue;
    }
    const match = unused.findIndex((code) => code.text === part.text);
    const id = match >= 0 ? unused.splice(match, 1)[0].id : ++nextId;
    const ph = element(doc, "ph", { id: String(id) });
    ph.textContent = part.text;
    parent.appendChild(ph);
    codes.push({ id, text: part.text });
  }
  return codes;
}
function exchangeToXliff(rows, options) {
  const broken = rows.filter((row) => [row.unit.source, row.cell.text, row.unit.devNotes, row.unit.origin].some((text) => XML_INVALID.test(text)));
  if (broken.length > 0) {
    const names = broken.slice(0, 5).map((row) => `${row.unit.namespace}/${row.unit.key}`).join(", ");
    throw new Error(
      `XLIFF cannot store the control characters in ${broken.length} string(s) (${names}${broken.length > 5 ? ", …" : ""}). Export CSV instead, or filter these strings out.`
    );
  }
  const doc = document.implementation.createDocument(XLIFF_NS, "xliff", null);
  const root2 = doc.documentElement;
  root2.setAttribute("version", "1.2");
  root2.setAttributeNS(XMLNS_NS, "xmlns:lochub", LOCHUB_NS);
  const file = element(doc, "file", {
    original: `LocHub/${options.culture}`,
    "source-language": options.sourceCulture,
    "target-language": options.culture,
    datatype: "plaintext",
    date: options.date
  });
  const body = element(doc, "body");
  for (const row of rows) {
    const status = exportStatus(row);
    const unit = element(doc, "trans-unit", { id: row.unit.id, resname: `${row.unit.namespace}/${row.unit.key}` });
    unit.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
    unit.setAttributeNS(LOCHUB_NS, "lochub:revision", String(row.cell.revision));
    const limit = row.lengthLimit ?? null;
    if (limit !== null) {
      unit.setAttribute("maxwidth", String(limit));
      unit.setAttribute("size-unit", "char");
    }
    if (status === "approved") unit.setAttribute("approved", "yes");
    const source = element(doc, "source");
    const codes = appendSegment(doc, source, row.unit.source, null);
    unit.appendChild(source);
    if (row.cell.text.length > 0) {
      const target = element(doc, "target", { state: TARGET_STATE[status] ?? "needs-review-translation" });
      appendSegment(doc, target, row.cell.text, codes);
      unit.appendChild(target);
    }
    if (row.unit.devNotes) {
      const developer = element(doc, "note", { from: "developer" });
      developer.textContent = row.unit.devNotes;
      unit.appendChild(developer);
    }
    const location = element(doc, "note", { from: "location" });
    location.textContent = row.unit.origin;
    unit.appendChild(location);
    body.appendChild(doc.createTextNode("\n"));
    body.appendChild(unit);
  }
  body.appendChild(doc.createTextNode("\n"));
  file.appendChild(body);
  root2.appendChild(file);
  const xml = new XMLSerializer().serializeToString(doc).replace(/\r/g, "&#13;");
  return `<?xml version="1.0" encoding="UTF-8"?>
${xml}
`;
}
function childElement(parent, name) {
  return Array.from(parent.children).find((child) => child.localName === name);
}
function descendants(parent, name) {
  return Array.from(parent.getElementsByTagName("*")).filter((el) => el.localName === name);
}
function segmentText(node, sourceCodes) {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) out += child.nodeValue ?? "";
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child;
      const inner = segmentText(el, sourceCodes);
      out += inner === "" && EMPTY_BY_ID.has(el.localName) ? sourceCodes.get(el.getAttribute("id") ?? "") ?? "" : inner;
    }
  }
  return out;
}
function codesById(source) {
  const codes = /* @__PURE__ */ new Map();
  for (const el of Array.from(source.getElementsByTagName("*"))) {
    const id = el.getAttribute("id");
    if (id !== null && CODE_ELEMENTS.has(el.localName) && !codes.has(id)) codes.set(id, segmentText(el, /* @__PURE__ */ new Map()));
  }
  return codes;
}
function readXliff(text, culture) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("The file is not valid XML, so it cannot be read as XLIFF.");
  const root2 = doc.documentElement;
  if (root2.localName !== "xliff") throw new Error("The file is not XLIFF (no <xliff> root element).");
  const version = root2.getAttribute("version") ?? "";
  if (version !== "" && !version.startsWith("1.")) throw new Error(`XLIFF ${version} is not supported. Export XLIFF 1.2 from your translation tool.`);
  const entries = [];
  const labels = [];
  const copyOfSource = [];
  for (const file of descendants(root2, "file")) {
    const target = file.getAttribute("target-language");
    if (target && !sameCulture(target, culture)) throw new Error(`This file is for ${target}, not ${culture}. Switch the Grid to ${target} or pick the ${culture} file.`);
    const date = file.getAttribute("date");
    const exportedAt = date && EXPORTED_AT_PATTERN.test(date) && !Number.isNaN(Date.parse(date)) ? date : void 0;
    for (const unit of descendants(file, "trans-unit")) {
      const sourceEl = childElement(unit, "source");
      const targetEl = childElement(unit, "target");
      const codes = sourceEl ? codesById(sourceEl) : /* @__PURE__ */ new Map();
      const source = sourceEl ? segmentText(sourceEl, codes) : void 0;
      let translation = targetEl ? segmentText(targetEl, codes) : "";
      const isCopyOfSource = targetEl !== void 0 && translation === source && COPY_SOURCE_STATES.has(targetEl.getAttribute("state") ?? "");
      if (isCopyOfSource) translation = "";
      const entry = { text: translation, approved: unit.getAttribute("approved") === "yes" };
      const id = unit.getAttribute("id");
      if (id) entry.unitId = id;
      if (source !== void 0) entry.source = source;
      const revision = unit.getAttributeNS(LOCHUB_NS, "revision");
      if (revision !== null && /^\d+$/.test(revision)) entry.exportedRevision = Number(revision);
      if (exportedAt) entry.exportedAt = exportedAt;
      entries.push(entry);
      labels.push(unit.getAttribute("resname") || id || `Unit ${entries.length}`);
      copyOfSource.push(isCopyOfSource);
    }
  }
  return { format: "xliff", entries, labels, ignoredColumns: [], copyOfSource };
}
const TRANSLATION_FILE_ACCEPT = ".csv,.xlf,.xliff,.xml";
function decodeXml(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return decodeUtf8(bytes);
  } catch {
    throw new Error("The file is neither UTF-8 nor UTF-16 text.");
  }
}
function parseTranslationFile(name, bytes, culture) {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "csv") return readExchangeCsv(decodeUtf8(bytes));
  if (extension === "xlf" || extension === "xliff" || extension === "xml") {
    const text = decodeXml(bytes);
    if (extension === "xml" && !text.includes("<xliff")) throw new Error("This XML file is not XLIFF.");
    return readXliff(text, culture);
  }
  throw new Error("Choose a .csv, .xlf, .xliff or .xml file.");
}
const REVIEWER_KEY = "lochub.reviewerName";
const LIST_LIMIT = 200;
const TRANSLATION_FILE_TYPES = "Translation files (*.csv;*.xlf;*.xliff;*.xml)|*.csv;*.xlf;*.xliff;*.xml|All files (*.*)|*.*";
const SAVE_AS = {
  csv: { extension: "csv", fileTypes: "CSV files (*.csv)|*.csv|All files (*.*)|*.*", mime: "text/csv;charset=utf-8" },
  xliff: { extension: "xlf", fileTypes: "XLIFF files (*.xlf)|*.xlf|All files (*.*)|*.*", mime: "application/xliff+xml;charset=utf-8" }
};
const SKIPPED = /* @__PURE__ */ new Set(["stale", "unknown", "empty", "hard"]);
const SKIP_REASON = {
  stale: "the source text changed since the export",
  unknown: "no such string in this project"
};
const EMPTY_REASON = "no translation in the file (an import never clears one)";
const COPY_OF_SOURCE_REASON = "copy of the source (not translated)";
function messages(row, severities) {
  return (row.issues ?? []).filter((issue) => severities.includes(issue.severity)).map((issue) => issue.message).join("; ");
}
function isWarningRow(row) {
  return messages(row, ["confirm"]) !== "" && messages(row, ["hard"]) === "" && !["unknown", "stale", "empty", "conflict"].includes(row.outcome);
}
function describeRow(row, label, copyOfSource) {
  if (row.outcome === "hard") return `${label}: format problem: ${messages(row, ["hard"])}`;
  if (row.outcome === "empty") return `${label}: ${copyOfSource ? COPY_OF_SOURCE_REASON : EMPTY_REASON}`;
  const reason = SKIP_REASON[row.outcome];
  if (reason) return `${label}: ${reason}`;
  if (row.outcome === "unchanged") return label;
  if (row.outcome === "confirm") return `${label}: ${messages(row, ["confirm"])}`;
  const change = row.outcome === "approved" ? `approve "${row.after ?? ""}"` : `"${row.before || "(empty)"}" → "${row.after ?? ""}"`;
  const approvedToo = row.outcome === "changed_approved" ? " (approved)" : "";
  const notes = messages(row, ["confirm", "soft"]);
  return `${label}: ${change}${approvedToo}${notes ? ` — ${notes}` : ""}`;
}
function groupsOf(result) {
  const pick = (test) => result.rows.filter(test);
  return [
    { title: "Changed", rows: pick((row) => row.outcome === "changed" || row.outcome === "changed_approved") },
    { title: "Approved", rows: pick((row) => row.outcome === "approved") },
    { title: "Unchanged", rows: pick((row) => row.outcome === "unchanged") },
    { title: "Skipped", rows: pick((row) => SKIPPED.has(row.outcome)) },
    { title: "Conflicts", rows: pick((row) => row.outcome === "conflict") },
    { title: "Needs confirmation", rows: pick((row) => row.outcome === "confirm") }
  ];
}
function ExchangeActions({ api: api2, bridge, culture, cultures, nativeCulture, filtered, totalCount, onImported, now = () => /* @__PURE__ */ new Date() }) {
  const [panel, setPanel] = reactExports.useState("none");
  const [exportCulture, setExportCulture] = reactExports.useState(culture);
  const [format, setFormat] = reactExports.useState("csv");
  const [scope, setScope] = reactExports.useState("filtered");
  const [preview, setPreview] = reactExports.useState(null);
  const [reviewer, setReviewer] = reactExports.useState(loadReviewer);
  const [busy, setBusy] = reactExports.useState(false);
  const [notice, setNotice] = reactExports.useState("");
  const [error, setError] = reactExports.useState("");
  const request = (target, dryRun) => ({
    culture,
    actor: reviewer.trim(),
    dryRun,
    overwriteConflicts: target.overwriteConflicts,
    acceptConfirm: target.acceptConfirm,
    entries: target.parsed.entries
  });
  const close = () => {
    setPanel("none");
    setPreview(null);
    setError("");
  };
  const openExport = () => {
    setPanel("export");
    setPreview(null);
    setExportCulture(culture);
    setError("");
    setNotice("");
  };
  const sourceUnknown = format === "xliff" && nativeCulture === "";
  const runExport = async () => {
    if (busy || sourceUnknown) return;
    setBusy(true);
    setError("");
    try {
      const exportedAt = now().toISOString();
      const ids = new Set(filtered.map((row) => row.unit.id));
      const all = await api2.allCells(exportCulture);
      const rows = (scope === "all" ? all : all.filter((row) => ids.has(row.unit.id))).slice().sort((a, b) => compareText(a.unit.namespace, b.unit.namespace) || compareText(a.unit.key, b.unit.key));
      if (rows.length === 0) {
        setError("Nothing to export: no strings match.");
        return;
      }
      const text = format === "csv" ? exchangeToCsv(rows) : exchangeToXliff(rows, { culture: exportCulture, sourceCulture: nativeCulture, date: exportedAt });
      const target = SAVE_AS[format];
      const name = `lochub-${exportCulture}.${target.extension}`;
      const saved = await saveTextFile(bridge, name, text, target.fileTypes, "Export translations", target.mime);
      if (!saved) return;
      setNotice(saved.path ? `Saved to ${saved.path}` : `Downloaded ${name}`);
      setPanel("none");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const startImport = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPanel("none");
    setPreview(null);
    try {
      const picked = await pickTextFile(bridge, "Import translations", TRANSLATION_FILE_ACCEPT, TRANSLATION_FILE_TYPES);
      if (!picked) return;
      const parsed = parseTranslationFile(picked.name, picked.bytes, culture);
      if (parsed.entries.length === 0) {
        setError(`${picked.name} has no strings to import.`);
        return;
      }
      const draft = { parsed, overwriteConflicts: false, acceptConfirm: false };
      const result = await api2.importTranslations(request(draft, true));
      setPreview({ fileName: picked.name, result, ...draft });
      setPanel("import");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const rerun = async (patch) => {
    if (!preview || busy) return;
    const next = { ...preview, ...patch };
    setBusy(true);
    setError("");
    try {
      const result = await api2.importTranslations(request(next, true));
      setPreview({ ...next, result });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const applyImport = async () => {
    if (!preview || busy || reviewer.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      const result = await api2.importTranslations({ ...request(preview, false), previewDigest: preview.result.digest });
      saveReviewer(reviewer.trim());
      const applied = result.counts.changed + result.counts.changed_approved + result.counts.approved;
      setNotice(`Imported ${applied} ${applied === 1 ? "string" : "strings"} into ${culture}.`);
      setPreview(null);
      setPanel("none");
      onImported();
    } catch (e) {
      const staleResult = e instanceof ApiError && e.body.error === "preview_stale" ? e.body.result : void 0;
      if (staleResult) {
        setPreview({ ...preview, result: staleResult });
        setError("Strings changed in LocHub since this preview. Check it again, then Import.");
      } else {
        setError(errorText(e));
      }
    } finally {
      setBusy(false);
    }
  };
  const labelOf = (row) => (preview == null ? void 0 : preview.parsed.labels[row.index]) ?? `String ${row.index + 1}`;
  const conflictCount = preview ? preview.result.rows.filter((row) => row.conflict).length : 0;
  const warningCount = preview ? preview.result.rows.filter(isWarningRow).length : 0;
  const applicable = preview ? preview.result.counts.changed + preview.result.counts.changed_approved + preview.result.counts.approved : 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: openExport, disabled: busy, children: "Export…" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void startImport(), disabled: busy, children: "Import…" }),
    notice && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "notice", role: "status", children: notice }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "error", role: "alert", children: error }),
    panel === "export" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "import-preview exchange-panel", role: "dialog", "aria-label": "Export translations", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Export translations" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Culture",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsx("select", { "aria-label": "Export culture", value: exportCulture, onChange: (e) => setExportCulture(e.target.value), children: cultures.map((code) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: code, children: code }, code)) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Format",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { "aria-label": "Export format", value: format, onChange: (e) => setFormat(e.target.value), children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "csv", children: "CSV (spreadsheets)" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "xliff", children: "XLIFF 1.2 (CAT tools)" })
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Strings",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { "aria-label": "Export scope", value: scope, onChange: (e) => setScope(e.target.value), children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "filtered", children: `Strings matching the current filters (${filtered.length})` }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "all", children: `All strings (${totalCount})` })
        ] })
      ] }),
      sourceUnknown && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "Push, then Refresh, so LocHub knows the source culture: XLIFF needs it." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "primary", onClick: () => void runExport(), disabled: busy || sourceUnknown, children: "Export" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: close, disabled: busy, children: "Cancel" })
      ] })
    ] }),
    panel === "import" && preview && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "import-preview exchange-panel", role: "dialog", "aria-label": "Import translations", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: `Import into ${culture}` }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: `${preview.fileName}: ${preview.parsed.entries.length} ${preview.parsed.entries.length === 1 ? "string" : "strings"} (${preview.parsed.format === "csv" ? "CSV" : "XLIFF"})` }),
      groupsOf(preview.result).map((group) => /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("summary", { children: `${group.title} (${group.rows.length})` }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("ul", { children: [
          group.rows.slice(0, LIST_LIMIT).map((row) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: describeRow(row, labelOf(row), preview.parsed.copyOfSource[row.index] ?? false) }, row.index)),
          group.rows.length > LIST_LIMIT && /* @__PURE__ */ jsxRuntimeExports.jsx("li", { className: "muted", children: `…and ${group.rows.length - LIST_LIMIT} more` })
        ] })
      ] }, group.title)),
      preview.parsed.ignoredColumns.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: `Ignored columns: ${preview.parsed.ignoredColumns.join(", ")}` }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Reviewer name",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { "aria-label": "Reviewer name", value: reviewer, maxLength: 64, onChange: (e) => setReviewer(e.target.value) })
      ] }),
      conflictCount > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: preview.overwriteConflicts, disabled: busy, onChange: (e) => void rerun({ overwriteConflicts: e.target.checked }) }),
        ` Overwrite conflicts (${conflictCount})`
      ] }),
      warningCount > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: preview.acceptConfirm, disabled: busy, onChange: (e) => void rerun({ acceptConfirm: e.target.checked }) }),
        ` Import anyway: ${warningCount} ${warningCount === 1 ? "string" : "strings"} with warnings`
      ] }),
      reviewer.trim() === "" && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "Enter your name: it is recorded as the reviewer of every imported string." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "primary", onClick: () => void applyImport(), disabled: busy || reviewer.trim() === "" || applicable === 0, children: "Import" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: close, disabled: busy, children: "Cancel" })
      ] })
    ] })
  ] });
}
function loadReviewer() {
  try {
    return localStorage.getItem(REVIEWER_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveReviewer(name) {
  try {
    localStorage.setItem(REVIEWER_KEY, name);
  } catch {
  }
}
const MAX_SUGGESTIONS = 50;
function folderPrefixesOf(path) {
  const prefixes = [];
  let idx = path.indexOf("/", path.startsWith("/") ? 1 : 0);
  while (idx >= 0 && idx < path.length - 1) {
    prefixes.push(path.slice(0, idx + 1));
    idx = path.indexOf("/", idx + 1);
  }
  return prefixes;
}
function buildFolderTotals(entries) {
  const totals = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    for (const folder of folderPrefixesOf(entry.path)) totals.set(folder, (totals.get(folder) ?? 0) + entry.count);
  }
  return totals;
}
function pathSuggestions(entries, query, folderTotals) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const rankOf = (lower) => lower.startsWith(needle) ? 0 : 1;
  const fileMatches = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    if (lower.includes(needle)) fileMatches.push({ value: entry.path, count: entry.count, folder: false, rank: rankOf(lower) });
  }
  const totals = folderTotals ?? buildFolderTotals(entries);
  const folderMatches = [];
  for (const [folder, count] of totals) {
    const lower = folder.toLowerCase();
    if (lower.includes(needle)) folderMatches.push({ value: folder, count, folder: true, rank: rankOf(lower) });
  }
  const all = [...fileMatches, ...folderMatches];
  all.sort((a, b) => a.rank - b.rank || b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return all.slice(0, MAX_SUGGESTIONS).map(({ value, count, folder }) => ({ value, count, folder }));
}
function PathFilter({ value, onChange, entries, ariaLabel, placeholder }) {
  const [text, setText] = reactExports.useState(value);
  const [open, setOpen] = reactExports.useState(false);
  const [activeIndex, setActiveIndex] = reactExports.useState(-1);
  const wrapRef = reactExports.useRef(null);
  const listId = reactExports.useId();
  const optionId = (index) => `${listId}-option-${index}`;
  reactExports.useEffect(() => {
    setText(value);
  }, [value]);
  const folderTotalsRef = reactExports.useRef(null);
  const suggestions = reactExports.useMemo(() => {
    if (!text.trim()) return [];
    if (folderTotalsRef.current === null || folderTotalsRef.current.entries !== entries) {
      folderTotalsRef.current = { entries, totals: buildFolderTotals(entries) };
    }
    return pathSuggestions(entries, text, folderTotalsRef.current.totals);
  }, [entries, text]);
  const close = reactExports.useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
  }, []);
  const cancel = reactExports.useCallback(() => {
    setText(value);
    close();
  }, [value, close]);
  const apply = reactExports.useCallback(
    (next) => {
      setText(next);
      onChange(next);
      close();
    },
    [onChange, close]
  );
  reactExports.useEffect(() => {
    if (!open) return void 0;
    const onPointerDown = (event) => {
      var _a;
      if ((_a = wrapRef.current) == null ? void 0 : _a.contains(event.target)) return;
      close();
    };
    const onKeyDown2 = (event) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown2);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown2);
    };
  }, [open, close, cancel]);
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = open ? suggestions[activeIndex] : void 0;
      apply(chosen ? chosen.value : text.trim());
    }
  };
  const onBlur = (event) => {
    var _a;
    if (!document.hasFocus()) return;
    if ((_a = wrapRef.current) == null ? void 0 : _a.contains(event.relatedTarget)) return;
    const t = text.trim();
    if (t !== value) apply(t);
    else close();
  };
  const clear = () => apply("");
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `path-filter filter-pill${value !== "" ? " active" : ""}`, ref: wrapRef, onBlur, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "input",
      {
        type: "text",
        role: "combobox",
        "aria-label": ariaLabel,
        "aria-expanded": open,
        "aria-controls": listId,
        "aria-autocomplete": "list",
        "aria-activedescendant": activeIndex >= 0 ? optionId(activeIndex) : void 0,
        placeholder,
        value: text,
        onChange: (e) => {
          setText(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        },
        onFocus: () => setOpen(true),
        onKeyDown
      }
    ),
    value !== "" && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "filter-clear", "aria-label": `Clear ${ariaLabel}`, onClick: clear, children: "×" }),
    open && suggestions.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(
      "ul",
      {
        className: "path-filter-popover",
        role: "listbox",
        id: listId,
        "aria-label": `${ariaLabel} suggestions`,
        onMouseDown: (e) => e.preventDefault(),
        children: suggestions.map((suggestion, index) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "button",
          {
            type: "button",
            id: optionId(index),
            role: "option",
            tabIndex: -1,
            "aria-selected": index === activeIndex,
            className: index === activeIndex ? "active" : void 0,
            onMouseDown: (e) => e.preventDefault(),
            onClick: () => apply(suggestion.value),
            children: [
              suggestion.value,
              " — ",
              suggestion.count
            ]
          }
        ) }, suggestion.value))
      }
    )
  ] });
}
function OriginActions({ unit, bridge, editorConnected, onBeforeAction, onError, openLabel, showPath = true }) {
  const origin = parseOrigin(unit.origin);
  if (origin.kind === "unknown") return null;
  const label = originLabel(origin);
  const route = bridge.route(editorConnected);
  const openOrigin = async () => {
    onBeforeAction == null ? void 0 : onBeforeAction();
    try {
      const opened = await bridge.openOrigin({ unitId: unit.id, namespace: unit.namespace, key: unit.key, origin: unit.origin }, editorConnected);
      if (!opened) onError("The editor could not open this origin.");
    } catch (e) {
      onError(errorText(e));
    }
  };
  const copyPath = () => {
    var _a;
    onBeforeAction == null ? void 0 : onBeforeAction();
    void ((_a = navigator.clipboard) == null ? void 0 : _a.writeText(label).catch(() => onError("Copy failed — select the path and copy it by hand.")));
  };
  if (route !== "none") {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void openOrigin(), children: openLabel ?? `Open ${label}` });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    showPath && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: label }),
      " "
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", title: "The editor is not connected", onClick: copyPath, children: "Copy path" })
  ] });
}
const POPOVER_WIDTH = 360;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
function popoverTop(anchor, height, viewportHeight) {
  const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height);
  const below = Math.max(anchor.bottom + ANCHOR_GAP, VIEWPORT_MARGIN);
  if (below <= maxTop) return below;
  const above = anchor.top - ANCHOR_GAP - height;
  if (above >= VIEWPORT_MARGIN) return above;
  return maxTop;
}
function popoverStyle(anchor, height) {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN);
  const left = Math.min(Math.max(anchor.left, VIEWPORT_MARGIN), maxLeft);
  return { position: "fixed", top: popoverTop(anchor, height, window.innerHeight), left };
}
function KeyDetails({ unit, bridge, editorConnected, anchor, onClose }) {
  const [error, setError] = reactExports.useState("");
  const [height, setHeight] = reactExports.useState(0);
  const dialogRef = reactExports.useRef(null);
  const described = describeOrigin(unit.origin);
  const kind = unit.metadata["LocHub.Kind"];
  const otherMetadata = Object.entries(unit.metadata).filter(([metaKey]) => metaKey !== "LocHub.Kind");
  reactExports.useEffect(() => {
    var _a;
    (_a = dialogRef.current) == null ? void 0 : _a.focus();
  }, []);
  reactExports.useLayoutEffect(() => {
    var _a;
    setHeight(((_a = dialogRef.current) == null ? void 0 : _a.getBoundingClientRect().height) ?? 0);
  }, [error]);
  reactExports.useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose("escape");
    };
    const onPointerDown = (event) => {
      var _a;
      const target = event.target;
      if ((_a = dialogRef.current) == null ? void 0 : _a.contains(target)) return;
      if (target instanceof Element && target.closest(".grid-row .key")) return;
      onClose("outside");
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);
  const whereLabel = described.kind === "asset" ? "Asset" : described.kind === "file" ? "C++ file" : "Unknown";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { ref: dialogRef, className: "key-details", role: "dialog", "aria-label": "Key details", tabIndex: -1, style: popoverStyle(anchor, height), children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("dl", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Namespace" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: unit.namespace || "(none)" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Key" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { className: "key-value", children: unit.key }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Where" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("dd", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: whereLabel }),
        described.kind === "asset" && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: described.path }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "where-member", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", children: "Member" }),
            " ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: described.member })
          ] })
        ] }),
        described.kind === "file" && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: originLabel(described) }),
        described.kind === "unknown" && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: unit.origin || "unknown" })
      ] }),
      kind !== void 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Kind" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: kind })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Group" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: unit.groupKey || "none" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Dev notes" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: unit.devNotes || "none" }),
      otherMetadata.map(([metaKey, value]) => /* @__PURE__ */ jsxRuntimeExports.jsxs(reactExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: metaKey }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: value })
      ] }, metaKey))
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "actions", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      OriginActions,
      {
        unit,
        bridge,
        editorConnected,
        onBeforeAction: () => setError(""),
        onError: setError,
        openLabel: "Open in editor",
        showPath: false
      }
    ) }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
function useDebouncedValue(value, delayMs) {
  const [debounced, setDebounced] = reactExports.useState(value);
  reactExports.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
const SEARCH_DEBOUNCE_MS = 150;
const GRID_ROW_HEIGHT = 36;
const GRID_HEADER_HEIGHT = 36;
const STATUSES$1 = ["empty", "ai_draft", "needs_fix", "approved", "edited", "human_edit", "rejected"];
const STATUS_LABEL = {
  empty: "Untranslated",
  ai_draft: "Draft",
  needs_fix: "Needs fix",
  approved: "Approved",
  edited: "Edited",
  human_edit: "Human",
  rejected: "Rejected"
};
const BANDS = [
  { value: "", label: "Any band" },
  { value: "R", label: "Red" },
  { value: "Y", label: "Yellow" },
  { value: "G", label: "Green" },
  { value: "none", label: "No band" }
];
function FilterPill({ label, active, onClear, children }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: `filter-pill${active ? " active" : ""}`, children: [
    children,
    active && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "filter-clear", "aria-label": `Clear ${label}`, onClick: onClear, children: "×" })
  ] });
}
const KEY_COL_WIDTH = 200;
const SOURCE_MIN = 280;
const CULTURE_MIN = 260;
const GRID_GAP = 4;
function ColumnsPicker({
  cultures,
  visible,
  active,
  onVisible
}) {
  const [open, setOpen] = reactExports.useState(false);
  const popoverRef = reactExports.useRef(null);
  const buttonRef = reactExports.useRef(null);
  const close = reactExports.useCallback((returnFocus) => {
    var _a;
    setOpen(false);
    if (returnFocus) (_a = buttonRef.current) == null ? void 0 : _a.focus();
  }, []);
  reactExports.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event) => {
      var _a;
      const target = event.target;
      if ((_a = popoverRef.current) == null ? void 0 : _a.contains(target)) return;
      if (target instanceof Element && target.closest(".columns-toggle")) return;
      close(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, close]);
  const toggle = (code, checked) => {
    if (code === active) return;
    const next = new Set(visible);
    if (checked) next.add(code);
    else next.delete(code);
    next.add(active);
    onVisible(cultures.filter((c) => next.has(c)));
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "columns-picker", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        className: "columns-toggle",
        ref: buttonRef,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        onClick: () => setOpen((current) => !current),
        children: [
          "Columns",
          visible.length > 1 ? ` (${visible.length})` : ""
        ]
      }
    ),
    open && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { ref: popoverRef, className: "columns-popover", role: "dialog", "aria-label": "Columns", children: cultures.map((code) => {
      const isActive = code === active;
      const checked = isActive || visible.includes(code);
      return /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            type: "checkbox",
            checked,
            disabled: isActive,
            title: isActive ? "The active culture is always shown" : void 0,
            onChange: (e) => toggle(code, e.target.checked)
          }
        ),
        code
      ] }, code);
    }) })
  ] });
}
function GridView({
  rows,
  cultures,
  visible,
  onVisible,
  culture,
  nativeCulture,
  filters,
  onFilters,
  onOpenCell,
  onApplyLive,
  canApplyLive,
  bridge,
  editorConnected,
  scrollMemory,
  loadedCultures,
  loading,
  toolbarExtra
}) {
  var _a;
  const isLoaded = (c) => loadedCultures.includes(c);
  const isFailed = (c) => !isLoaded(c) && !loading;
  const cultureLoaded = isLoaded(culture);
  const debouncedQuery = useDebouncedValue(filters.q, SEARCH_DEBOUNCE_MS);
  const filtered = reactExports.useMemo(
    () => filterRows(rows, culture, {
      q: debouncedQuery,
      status: filters.status,
      band: filters.band,
      outdated: filters.outdated,
      namespace: filters.namespace,
      asset: filters.asset
    }),
    [rows, culture, filters.status, filters.band, filters.outdated, filters.namespace, filters.asset, debouncedQuery]
  );
  const { namespaces } = reactExports.useMemo(() => facets(rows), [rows]);
  const assetEntries = reactExports.useMemo(() => assetPathEntries(rows), [rows]);
  const scrollRef = reactExports.useRef(null);
  const keyButtons = reactExports.useRef(/* @__PURE__ */ new Map());
  const [openKey, setOpenKey] = reactExports.useState(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: 20,
    scrollMargin: GRID_HEADER_HEIGHT,
    initialOffset: () => scrollMemory.top
  });
  reactExports.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = scrollMemory.top;
    el.scrollLeft = scrollMemory.left;
  }, []);
  reactExports.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollMemory.top = el.scrollTop;
      scrollMemory.left = el.scrollLeft;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollMemory]);
  const columns = `${KEY_COL_WIDTH}px minmax(${SOURCE_MIN}px, 2fr) ${visible.map(() => `minmax(${CULTURE_MIN}px, 2fr)`).join(" ")}`;
  const gapCount = visible.length + 1;
  const minWidth = KEY_COL_WIDTH + SOURCE_MIN + visible.length * CULTURE_MIN + gapCount * GRID_GAP;
  const sourceLeft = KEY_COL_WIDTH;
  const set = (patch) => onFilters({ ...filters, ...patch });
  const toggleKeyDetails = (unitId, button) => {
    setOpenKey((current) => (current == null ? void 0 : current.unitId) === unitId ? null : { unitId, anchor: button.getBoundingClientRect() });
  };
  const closeKeyDetails = reactExports.useCallback((returnFocus) => {
    setOpenKey((current) => {
      var _a2;
      if (returnFocus && current) (_a2 = keyButtons.current.get(current.unitId)) == null ? void 0 : _a2.focus();
      return null;
    });
  }, []);
  const handleCloseKeyDetails = reactExports.useCallback((reason) => closeKeyDetails(reason === "escape"), [closeKeyDetails]);
  reactExports.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !openKey) return;
    const onScroll = () => closeKeyDetails(false);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [openKey, closeKeyDetails]);
  const openUnit = openKey ? (_a = rows.find((row) => row.unit.id === openKey.unitId)) == null ? void 0 : _a.unit : void 0;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "grid-view", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "toolbar", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "search-wrap", children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          type: "search",
          "aria-label": "Search",
          placeholder: "Search key, source or shown translations",
          value: filters.q,
          onChange: (e) => set({ q: e.target.value })
        }
      ) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(FilterPill, { label: "Status", active: filters.status !== "", onClear: () => set({ status: "" }), children: /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { "aria-label": "Status", value: filters.status, onChange: (e) => set({ status: e.target.value }), children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "", children: "Any status" }),
        STATUSES$1.map((status) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: status, children: STATUS_LABEL[status] }, status))
      ] }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(FilterPill, { label: "Band", active: filters.band !== "", onClear: () => set({ band: "" }), children: /* @__PURE__ */ jsxRuntimeExports.jsx("select", { "aria-label": "Band", value: filters.band, onChange: (e) => set({ band: e.target.value }), children: BANDS.map((band) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: band.value, children: band.label }, band.value)) }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: `filter-pill toggle-chip${filters.outdated ? " active" : ""}`, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", className: "visually-hidden", checked: filters.outdated, onChange: (e) => set({ outdated: e.target.checked }) }),
          " Outdated"
        ] }),
        filters.outdated && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "filter-clear", "aria-label": "Clear Outdated", onClick: () => set({ outdated: false }), children: "×" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(FilterPill, { label: "Namespace", active: filters.namespace !== "", onClear: () => set({ namespace: "" }), children: /* @__PURE__ */ jsxRuntimeExports.jsxs("select", { "aria-label": "Namespace", value: filters.namespace, onChange: (e) => set({ namespace: e.target.value }), children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "", children: "Any namespace" }),
        namespaces.map((namespace) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: namespace, children: namespace || "(empty)" }, namespace))
      ] }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(PathFilter, { value: filters.asset, onChange: (value) => set({ asset: value }), entries: assetEntries, ariaLabel: "Asset", placeholder: "Any asset or file" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "count", children: cultureLoaded ? `${filtered.length} of ${rows.length} strings` : isFailed(culture) ? "" : "Loading…" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", onClick: onApplyLive, disabled: !canApplyLive, title: "Show every translation of this culture in the editor without a Pull", children: [
        "Apply ",
        culture,
        " live"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(ColumnsPicker, { cultures, visible, active: culture, onVisible }),
      toolbarExtra == null ? void 0 : toolbarExtra(filtered)
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { ref: scrollRef, className: "grid-scroll", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "grid-header", style: { gridTemplateColumns: columns, minWidth }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "sticky-col", style: { left: 0 }, children: "Key" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "sticky-col", style: { left: sourceLeft }, children: [
          "Source (",
          nativeCulture || "native",
          ")"
        ] }),
        visible.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: c === culture ? "focus" : void 0, children: c }, c))
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "grid-body", style: { height: virtualizer.getTotalSize(), minWidth }, children: virtualizer.getVirtualItems().map((item) => {
        const row = filtered[item.index];
        if (!row) return null;
        const top = item.start - virtualizer.options.scrollMargin;
        return /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            className: "grid-row",
            style: { height: item.size, transform: `translateY(${top}px)`, gridTemplateColumns: columns },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "button",
                {
                  type: "button",
                  className: "key ellipsis sticky-col",
                  style: { left: 0 },
                  ref: (el) => {
                    if (el) keyButtons.current.set(row.unit.id, el);
                    else keyButtons.current.delete(row.unit.id);
                  },
                  title: `${row.unit.namespace} / ${row.unit.key}`,
                  "aria-haspopup": "dialog",
                  "aria-expanded": (openKey == null ? void 0 : openKey.unitId) === row.unit.id,
                  onClick: (e) => toggleKeyDetails(row.unit.id, e.currentTarget),
                  children: row.unit.key
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "source sticky-col", style: { left: sourceLeft }, title: row.unit.source, children: row.unit.source }),
              visible.map((c) => {
                const loaded = isLoaded(c);
                const failed = !loaded && isFailed(c);
                const gridCell = loaded ? row.cells[c] : void 0;
                const chip = statusChip(gridCell);
                return /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", className: "cell", title: loaded || failed ? (gridCell == null ? void 0 : gridCell.cell.status) ?? "empty" : "Loading…", onClick: () => onOpenCell(c, row.unit.id), children: !loaded && !failed ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cell-text muted", children: "Loading…" }) : chip ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cell-text", children: (gridCell == null ? void 0 : gridCell.cell.text) ?? "" }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `status-chip ${chip.tone}`, children: chip.label })
                ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "cell-text muted", children: (gridCell == null ? void 0 : gridCell.cell.text) || "—" }) }, c);
              })
            ]
          },
          row.unit.id
        );
      }) })
    ] }),
    openKey && openUnit && /* @__PURE__ */ jsxRuntimeExports.jsx(
      KeyDetails,
      {
        unit: openUnit,
        bridge,
        editorConnected,
        anchor: openKey.anchor,
        onClose: handleCloseKeyDetails
      },
      openKey.unitId
    )
  ] });
}
function useGridData(api2, cultures) {
  const [data, setData] = reactExports.useState(() => /* @__PURE__ */ new Map());
  const [loading, setLoading] = reactExports.useState(false);
  const [error, setError] = reactExports.useState("");
  const requestRef = reactExports.useRef(0);
  const loadedRef = reactExports.useRef([]);
  const [loadedCultures, setLoadedCultures] = reactExports.useState([]);
  const setLoaded = reactExports.useCallback((next) => {
    loadedRef.current = next;
    setLoadedCultures(next);
  }, []);
  const reloadingRef = reactExports.useRef(false);
  const cultureKey = cultures.join("|");
  const reload = reactExports.useCallback(async () => {
    const id = ++requestRef.current;
    const list = cultureKey ? cultureKey.split("|") : [];
    reloadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all(list.map(async (culture) => ({ culture, rows: await api2.allCells(culture) })));
      if (id === requestRef.current) {
        let next = /* @__PURE__ */ new Map();
        for (const { culture, rows: rows2 } of results) next = mergeCulture(next, culture, rows2);
        setData(next);
        setLoaded(list);
      }
    } catch (e) {
      if (id === requestRef.current) {
        setError(errorText(e));
      }
    } finally {
      if (id === requestRef.current) {
        setLoading(false);
        reloadingRef.current = false;
      }
    }
  }, [api2, cultureKey]);
  reactExports.useEffect(() => {
    const wanted = cultureKey ? cultureKey.split("|") : [];
    const wantedSet = new Set(wanted);
    const loaded = loadedRef.current;
    const added = wanted.filter((c) => !loaded.includes(c));
    const removed = loaded.filter((c) => !wantedSet.has(c));
    if (added.length === 0 && removed.length === 0) return void 0;
    if (reloadingRef.current) {
      void reload();
      return void 0;
    }
    const id = ++requestRef.current;
    if (removed.length > 0) {
      setData((previous) => dropCultures(previous, removed));
      setLoaded(loadedRef.current.filter((c) => wantedSet.has(c)));
    }
    if (added.length === 0) return void 0;
    setLoading(true);
    setError("");
    let cancelled = false;
    Promise.all(added.map(async (culture) => ({ culture, rows: await api2.allCells(culture) }))).then((results) => {
      if (cancelled || id !== requestRef.current) return;
      setData((previous) => {
        let next = previous;
        for (const { culture, rows: rows2 } of results) next = mergeCulture(next, culture, rows2);
        return next;
      });
      setLoaded([...loadedRef.current, ...added]);
    }).catch((e) => {
      if (!cancelled && id === requestRef.current) setError(errorText(e));
    }).finally(() => {
      if (!cancelled && id === requestRef.current) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [api2, cultureKey, reload]);
  reactExports.useEffect(() => {
    return () => {
      ++requestRef.current;
    };
  }, []);
  const updateCell = reactExports.useCallback((cell) => setData((previous) => withCell(previous, cell)), []);
  const updateUnit = reactExports.useCallback((unit) => setData((previous) => withUnit(previous, unit)), []);
  const rows = reactExports.useMemo(() => sortRows(data), [data]);
  return { rows, loading, error, reload, updateCell, updateUnit, loadedCultures };
}
function groupPathEntries(rows, culture) {
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const groupKey = row.unit.groupKey;
    if (!groupKey) continue;
    const gridCell = row.cells[culture];
    const status = (gridCell == null ? void 0 : gridCell.cell.status) ?? "empty";
    const needsWork = status === "empty" || status === "rejected" || status === "needs_fix" || ((gridCell == null ? void 0 : gridCell.outdated) ?? false);
    if (!needsWork) continue;
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }));
}
function canRun(estimate, maxUsd) {
  if (!estimate || typeof estimate.usd !== "number") return false;
  if (estimate.usd === 0) return true;
  const limit = Number(maxUsd);
  return maxUsd.trim() !== "" && Number.isFinite(limit) && limit >= estimate.usd;
}
function suggestMaxUsd(usd) {
  return (Math.ceil(usd * 120 - 1e-9) / 100).toFixed(2);
}
function formatUsd(usd) {
  return `$${usd.toFixed(2)}`;
}
const PHASE_LABELS = {
  translate: "Translating",
  repair: "Fixing",
  judge: "Checking",
  write: "Writing"
};
function noDollarsNote(billing, estimate) {
  if (billing === "subscription") return "uses your Claude subscription limits";
  return estimate.pricesUnset ? "no price set" : "price unknown for this model";
}
function JobProgressBar({ progress: { phase, done, total } }) {
  const label = total === 0 ? `${PHASE_LABELS[phase]}…` : `${PHASE_LABELS[phase]} · ${done} / ${total} strings`;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "job-progress", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "job-progress-track",
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": total,
        "aria-valuenow": done,
        "aria-label": "Job progress",
        children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "job-progress-fill", style: { width: total > 0 ? `${done / total * 100}%` : "0%" } })
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "job-progress-label muted", children: label })
  ] });
}
function JobReportLine({ report }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
      "Written ",
      report.written,
      " · suggestions ",
      report.suggestions,
      " · needs fix ",
      report.needsFix,
      " · refused ",
      report.refused,
      " · errors ",
      report.errors,
      " · questions",
      " ",
      report.questions,
      " · R ",
      report.bands.R,
      " / Y ",
      report.bands.Y,
      " / G ",
      report.bands.G,
      " · ",
      report.inputTokens.toLocaleString("en-US"),
      " input /",
      " ",
      report.outputTokens.toLocaleString("en-US"),
      " output tokens"
    ] }),
    report.errorSamples && report.errorSamples.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "job-errors", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h4", { children: "Error reasons" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: report.errorSamples.map((sample, index) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: sample }, index)) })
    ] })
  ] });
}
function JobsView({ api: api2, culture, rows = [], billing = "api", aiReady = true, aiDetail = "", preset, onJobDone, pollMs = 1e3 }) {
  const [group, setGroup] = reactExports.useState("");
  const [unitIds, setUnitIds] = reactExports.useState((preset == null ? void 0 : preset.unitIds) ?? []);
  const groupEntries = reactExports.useMemo(() => groupPathEntries(rows, culture), [rows, culture]);
  const [estimate, setEstimate] = reactExports.useState();
  const [maxUsd, setMaxUsd] = reactExports.useState("");
  const [job, setJob] = reactExports.useState();
  const [error, setError] = reactExports.useState("");
  const [starting, setStarting] = reactExports.useState(false);
  const [jobStatusUnknown, setJobStatusUnknown] = reactExports.useState(false);
  const [estimating, setEstimating] = reactExports.useState(false);
  const startCountRef = reactExports.useRef(0);
  const estimateGenRef = reactExports.useRef(0);
  const resetEstimate = () => {
    estimateGenRef.current++;
    setEstimate(void 0);
    setMaxUsd("");
    setEstimating(false);
  };
  reactExports.useEffect(() => {
    setUnitIds((preset == null ? void 0 : preset.unitIds) ?? []);
    resetEstimate();
  }, [preset]);
  reactExports.useEffect(() => {
    resetEstimate();
  }, [culture]);
  reactExports.useEffect(() => {
    let cancelled = false;
    setJob(void 0);
    setJobStatusUnknown(false);
    api2.currentJob(culture).then((current) => {
      if (!cancelled && current) setJob(current);
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, [api2, culture]);
  reactExports.useEffect(() => {
    if (!job || job.status !== "running" || jobStatusUnknown) return void 0;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api2.job(job.id);
        if (!cancelled) {
          setJob(next);
          if (next.status !== "running") onJobDone();
          setJobStatusUnknown(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(errorText(e));
          setJobStatusUnknown(true);
        }
      }
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api2, job, onJobDone, pollMs, jobStatusUnknown]);
  const groupScope = group === "" ? {} : group.endsWith("/") ? { groupPrefix: group } : { groupKey: group };
  const scope = { culture, mode: "sync", ...groupScope, ...unitIds.length > 0 ? { unitIds } : {} };
  const running = (job == null ? void 0 : job.status) === "running";
  const noDollars = billing === "subscription" || (estimate == null ? void 0 : estimate.usd) === null || (estimate == null ? void 0 : estimate.usd) === 0;
  const strings = estimate ? estimate.strings ?? estimate.items : 0;
  const runEstimate = async () => {
    if (estimating) return;
    const gen = ++estimateGenRef.current;
    setEstimating(true);
    setError("");
    try {
      const { estimate: next } = await api2.estimate(scope);
      if (gen !== estimateGenRef.current) return;
      setEstimate(next);
      setMaxUsd(typeof next.usd === "number" ? suggestMaxUsd(next.usd) : "");
    } catch (e) {
      if (gen !== estimateGenRef.current) return;
      setError(errorText(e));
    } finally {
      if (gen === estimateGenRef.current) setEstimating(false);
    }
  };
  const start = async (options = {}) => {
    const startId = ++startCountRef.current;
    if (startId !== 1) {
      startCountRef.current--;
      return;
    }
    setStarting(true);
    setError("");
    try {
      const { jobId, estimate: accepted } = await api2.startJob(
        scope,
        options.skipEstimate || noDollars ? void 0 : Number(maxUsd),
        options.skipEstimate
      );
      setJob({ id: jobId, culture, status: "running", estimate: accepted });
      setJobStatusUnknown(false);
    } catch (e) {
      const runningJobId = e instanceof ApiError && e.body.error === "job_running" ? e.body.jobId : void 0;
      if (runningJobId) {
        try {
          setJob(await api2.job(runningJobId));
          setJobStatusUnknown(false);
        } catch {
          setError(errorText(e));
        }
      } else {
        setError(errorText(e));
      }
    } finally {
      startCountRef.current--;
      setStarting(false);
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "jobs", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("h2", { children: [
      "Translate ",
      culture
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "form-row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Group",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          PathFilter,
          {
            value: group,
            onChange: (next) => {
              setGroup(next);
              resetEstimate();
            },
            entries: groupEntries,
            ariaLabel: "Group",
            placeholder: "all groups"
          }
        )
      ] }),
      unitIds.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { children: [
        unitIds.length,
        " selected ",
        unitIds.length === 1 ? "string" : "strings",
        " ",
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            onClick: () => {
              setUnitIds([]);
              resetEstimate();
            },
            children: "Clear selection"
          }
        )
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void runEstimate(), disabled: running || !aiReady || estimating, "aria-busy": estimating, title: aiReady ? void 0 : aiDetail, children: estimating ? "Estimating…" : "Estimate" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          type: "button",
          onClick: () => void start({ skipEstimate: true }),
          disabled: running || !aiReady || estimating || starting,
          title: "Starts right away: no cost estimate and no Max USD limit. The job report shows the real cost.",
          children: "Run without estimate"
        }
      )
    ] }),
    estimating && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", role: "status", children: "Estimating the cost…" }),
    estimate && strings === 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: group !== "" ? "No strings match this group." : "Nothing to translate." }),
    estimate && strings > 0 && estimate.items === 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "estimate", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
        strings,
        " strings reuse translation memory or cached answers — no translate cost is estimated; judging may still run."
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void start(), disabled: running || starting || !aiReady, title: aiReady ? void 0 : aiDetail, children: "Run" })
    ] }),
    estimate && estimate.items > 0 && noDollars && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "estimate", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
        "≈ ",
        estimate.items,
        " strings in ",
        estimate.requests,
        " requests · ≈ ",
        estimate.inputTokens.toLocaleString("en-US"),
        " input /",
        " ",
        estimate.outputTokens.toLocaleString("en-US"),
        " output tokens ·",
        " ",
        noDollarsNote(billing, estimate)
      ] }),
      estimate.pricesUnset && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "Custom endpoint prices are 0 in Project Settings; Max USD cannot limit spending." }),
      estimate.approximate && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "≈ Approximate: token counts are estimated from text length; the job report shows the real usage." }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void start(), disabled: running || starting || !aiReady, title: aiReady ? void 0 : aiDetail, children: "Run" })
    ] }),
    estimate && estimate.items > 0 && !noDollars && typeof estimate.usd === "number" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "estimate", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
        estimate.approximate ? "≈ " : "",
        estimate.items,
        " strings in ",
        estimate.requests,
        " requests · ",
        estimate.inputTokens.toLocaleString("en-US"),
        " input /",
        " ",
        estimate.outputTokens.toLocaleString("en-US"),
        " output tokens · estimated ",
        formatUsd(estimate.usd)
      ] }),
      estimate.approximate && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "≈ Approximate: token counts are estimated from text length; the job report shows the real usage." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
        "Max USD ",
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { inputMode: "decimal", value: maxUsd, onChange: (e) => setMaxUsd(e.target.value) })
      ] }),
      " ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void start(), disabled: !canRun(estimate, maxUsd) || running || starting || !aiReady, title: aiReady ? void 0 : aiDetail, children: "Run" }),
      !canRun(estimate, maxUsd) && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "Max USD must cover the estimate." })
    ] }),
    job && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "job", children: [
      jobStatusUnknown ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: "Job status unknown — the service may have restarted." }) : job.status === "running" && job.progress ? /* @__PURE__ */ jsxRuntimeExports.jsx(JobProgressBar, { progress: job.progress }) : /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: `Job ${job.status}` }),
      !jobStatusUnknown && job.report && /* @__PURE__ */ jsxRuntimeExports.jsx(JobReportLine, { report: job.report }),
      !jobStatusUnknown && job.error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", children: job.error })
    ] }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
function CoverageView({ api: api2 }) {
  const [report, setReport] = reactExports.useState();
  const [error, setError] = reactExports.useState("");
  reactExports.useEffect(() => {
    api2.coverage().then(setReport, (e) => setError(errorText(e)));
  }, [api2]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "coverage", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: "Coverage" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
      "Player-visible strings that bypass localization, as reported by the last Push",
      (report == null ? void 0 : report.pushedAt) ? ` (${report.pushedAt})` : "",
      "."
    ] }),
    report && report.findings.length === 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: "No findings." }),
    report && report.findings.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("table", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("thead", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Kind" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Location" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("th", { children: "Text" })
      ] }) }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("tbody", { children: report.findings.map((finding, index) => /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: finding.kind }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: /* @__PURE__ */ jsxRuntimeExports.jsxs("code", { children: [
          finding.file,
          ":",
          finding.line
        ] }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: finding.text })
      ] }, index)) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Visual pass" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
      "Run the game with ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "-LEETIFYUnlocalized" }),
      ": every text without a translation is drawn in leetspeak, so hard-coded strings stand out on screen."
    ] }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
const STATUSES = ["open", "answered", "applied", "dismissed"];
function InboxView({ api: api2, culture }) {
  const [status, setStatus] = reactExports.useState("open");
  const [rows, setRows] = reactExports.useState([]);
  const [answers, setAnswers] = reactExports.useState({});
  const [error, setError] = reactExports.useState("");
  const requestRef = reactExports.useRef(0);
  const load = reactExports.useCallback(() => {
    const id = ++requestRef.current;
    api2.inbox({ status, culture }).then(
      (result) => {
        if (id === requestRef.current) setRows(result.rows);
      },
      (e) => {
        if (id === requestRef.current) setError(errorText(e));
      }
    );
  }, [api2, status, culture]);
  reactExports.useEffect(() => {
    load();
  }, [load]);
  const act = async (action) => {
    setError("");
    try {
      await action();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "inbox", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { children: "Inbox" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tabs", children: STATUSES.map((candidate) => /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", "aria-pressed": candidate === status, onClick: () => setStatus(candidate), children: candidate }, candidate)) }),
    rows.length === 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
      "No ",
      status,
      " questions."
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "inbox-list", children: rows.map(({ item, unit }) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "question", children: item.question }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
        item.askedBy,
        " · ",
        item.culture,
        " · ",
        unit ? `${unit.namespace} / ${unit.key}: ${unit.source}` : "unit no longer exists"
      ] }),
      (unit == null ? void 0 : unit.devNotes) && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
        "Dev notes: ",
        unit.devNotes
      ] }),
      item.status === "open" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "answer", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "textarea",
          {
            "aria-label": `Answer to ${item.id}`,
            rows: 2,
            value: answers[item.id] ?? "",
            onChange: (e) => setAnswers((all) => ({ ...all, [item.id]: e.target.value }))
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void act(() => api2.answer(item.id, answers[item.id] ?? "")), children: "Answer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void act(() => api2.dismiss(item.id)), children: "Dismiss" })
      ] }),
      item.status === "answered" && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
        "Answer: ",
        item.answer,
        " (written into DevNotes on the next Pull)"
      ] }),
      item.status === "applied" && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
        "Answer: ",
        item.answer
      ] })
    ] }, item.id)) }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
function missRate(summary) {
  return summary.audit.sampled > 0 ? summary.audit.corrected / summary.audit.sampled : void 0;
}
function percent(part, total) {
  return total > 0 ? `${Math.round(part / total * 100)}%` : "0%";
}
function SummaryView({ api: api2, culture }) {
  const [summary, setSummary] = reactExports.useState();
  const [error, setError] = reactExports.useState("");
  const requestRef = reactExports.useRef(0);
  reactExports.useEffect(() => {
    const id = ++requestRef.current;
    api2.summary(culture).then(
      (result) => {
        if (id === requestRef.current) setSummary(result);
      },
      (e) => {
        if (id === requestRef.current) setError(errorText(e));
      }
    );
  }, [api2, culture]);
  if (!summary) return error ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error }) : /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "Loading…" });
  const triaged = summary.byBand.R + summary.byBand.Y + summary.byBand.G;
  const miss = missRate(summary);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "summary", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("h2", { children: [
      "Summary (",
      culture,
      ")"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
      summary.total,
      " strings · ",
      summary.outdated,
      " outdated · ",
      summary.openQuestions,
      " open questions"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "bands", children: ["R", "Y", "G"].map((band) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `band-bar band-${band}`, style: { flexGrow: Math.max(summary.byBand[band], 1e-3) }, children: [
      band,
      " ",
      summary.byBand[band],
      " (",
      percent(summary.byBand[band], triaged),
      ")"
    ] }, band)) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("table", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("tbody", { children: Object.entries(summary.byStatus).map(([status, count]) => /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: status }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: count })
    ] }, status)) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: miss === void 0 ? "Blind audit: no sampled green strings reviewed yet." : `Blind audit: ${summary.audit.corrected} of ${summary.audit.sampled} sampled green strings were corrected, triage miss rate ${percent(summary.audit.corrected, summary.audit.sampled)}.` })
  ] });
}
const ESCAPE = "`";
function readModifier(s, start) {
  const match = /^[A-Za-z]+/.exec(s.slice(start));
  if (!match) return void 0;
  let i = start + match[0].length;
  if (s[i] !== "(") return void 0;
  const bodyStart = i + 1;
  let inQuotes = false;
  for (i = bodyStart; i < s.length; i++) {
    const c = s[i];
    if (c === ESCAPE) {
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (c === ")") return { name: match[0], body: s.slice(bodyStart, i), end: i + 1 };
  }
  return void 0;
}
function parseModifier(arg, name, body) {
  const lower = name.toLowerCase();
  const kind = lower === "plural" || lower === "ordinal" || lower === "gender" || lower === "hpp" ? lower : "other";
  const forms = {};
  const positional = [];
  for (const part of splitTopLevel(body)) {
    const eq = kind === "plural" || kind === "ordinal" ? part.indexOf("=") : -1;
    if (eq > 0) forms[part.slice(0, eq).trim()] = unquote(part.slice(eq + 1).trim());
    else positional.push(unquote(part.trim()));
  }
  return { arg, kind, name, forms, positional };
}
function splitTopLevel(body) {
  const parts = [];
  let braces = 0;
  let parens = 0;
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === ESCAPE && i + 1 < body.length) {
      current += c + body[i + 1];
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === "{") braces++;
      else if (c === "}") braces--;
      else if (c === "(") parens++;
      else if (c === ")") parens--;
      else if (c === "," && braces === 0 && parens === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += c;
  }
  if (current.trim().length > 0 || parts.length > 0) parts.push(current);
  return parts;
}
function unquote(value) {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
const ESCAPABLE = /* @__PURE__ */ new Set(["`", "{", "}", "|"]);
const TAG = /<(?:\/|[\w.-]+(?:\s+[\w.-]+="[^"]*")*\s*\/?)>/y;
const NONSPACING_MARK = /^[\p{Mn}\p{Me}]$/u;
const ZERO_WIDTH = /^[\u200B\u200C\u200D\uFEFF]$/;
const WIDE = [
  [4352, 4447],
  // Hangul Jamo initial consonants
  [11904, 12350],
  // CJK and Kangxi radicals, ideographic description, CJK symbols and punctuation
  [12353, 13311],
  // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, Kanbun, CJK strokes, enclosed CJK
  [13312, 19903],
  // CJK unified ideographs extension A
  [19968, 40959],
  // CJK unified ideographs
  [43360, 43391],
  // Hangul Jamo extended-A
  [44032, 55203],
  // Hangul syllables
  [63744, 64255],
  // CJK compatibility ideographs
  [65072, 65103],
  // CJK compatibility forms
  [65280, 65376],
  // Fullwidth forms
  [65504, 65510],
  // Fullwidth signs
  [127744, 128591],
  // Emoji: misc symbols and pictographs, emoticons
  [129280, 129535],
  // Emoji: supplemental symbols and pictographs
  [131072, 262141]
  // CJK unified ideographs extension B and later
];
function codePointWidth(codePoint) {
  const char = String.fromCodePoint(codePoint);
  if (NONSPACING_MARK.test(char) || ZERO_WIDTH.test(char)) return 0;
  return WIDE.some(([first, last]) => codePoint >= first && codePoint <= last) ? 2 : 1;
}
const ENTITIES = ["&amp;", "&lt;", "&gt;", "&quot;"];
function visibleLength(text) {
  let length = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "`" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      length += 1;
      i += 2;
      continue;
    }
    if (c === "&") {
      const entity = ENTITIES.find((e) => text.startsWith(e, i));
      if (entity) {
        length += 1;
        i += entity.length;
        continue;
      }
    }
    if (c === "<") {
      TAG.lastIndex = i;
      const tag = TAG.exec(text);
      if (tag) {
        i += tag[0].length;
        continue;
      }
    }
    if (c === "{") {
      const end = text.indexOf("}", i + 1);
      if (end >= 0) {
        const modifier = text[end + 1] === "|" ? readModifier(text, end + 2) : void 0;
        const parsed = modifier ? parseModifier(text.slice(i + 1, end).trim(), modifier.name, modifier.body) : void 0;
        if (modifier && parsed && parsed.kind !== "other" && parsed.name === parsed.kind) {
          const branches = [...Object.values(parsed.forms), ...parsed.positional];
          length += Math.max(0, ...branches.map((branch) => visibleLength(branch)));
          i = modifier.end;
        } else {
          i = end + 1;
        }
        continue;
      }
    }
    const codePoint = text.codePointAt(i);
    length += codePointWidth(codePoint);
    i += codePoint > 65535 ? 2 : 1;
  }
  return length;
}
function formatArgs(source) {
  const names = /* @__PURE__ */ new Set();
  for (const match of source.matchAll(new RegExp("(?<!`)\\{([^{}|`]+)\\}", "g"))) {
    const name = match[1];
    if (name !== void 0) names.add(name);
  }
  return [...names];
}
function useDebouncedDraft(value, delayMs) {
  const [debounced, setDebounced] = reactExports.useState(value);
  reactExports.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
const CHECK_DEBOUNCE_MS = 300;
const FIX_PROBLEMS_TITLE = "Fix the problems above first";
const CONFIRM_LINE = "Unreal accepts this text, but it looks wrong. Approve anyway if it is intended.";
const CHECK_WARNINGS_NOTICE = "Check the warnings, then click Approve anyway.";
const LENGTH_COUNTER_TITLE = "Visible characters / Length Check limit";
function historyVerb(event) {
  if (!event.accepted || event.accepted.length === 0) return event.action;
  return `${event.action === "approve" ? "approved" : "saved"} anyway (${event.accepted.join(", ")})`;
}
function CellPanel({ api: api2, bridge, row, culture, editorConnected, neighbors, blind = false, onCell, onUnit, handleRef }) {
  const { unit } = row;
  const gridCell = row.cells[culture];
  const cell = (gridCell == null ? void 0 : gridCell.cell) ?? emptyCell(unit.id, culture);
  const [draft, setDraft] = reactExports.useState(cell.text);
  const [issues, setIssues] = reactExports.useState([]);
  const [suggestionIssues, setSuggestionIssues] = reactExports.useState([]);
  const [error, setError] = reactExports.useState("");
  const [notice, setNotice] = reactExports.useState("");
  const [rejectNote, setRejectNote] = reactExports.useState("");
  const [retranslateNote, setRetranslateNote] = reactExports.useState("");
  const [asRule, setAsRule] = reactExports.useState(false);
  const [question, setQuestion] = reactExports.useState("");
  const [history, setHistory] = reactExports.useState([]);
  const editRef = reactExports.useRef(null);
  const rejectRef = reactExports.useRef(null);
  const contextRef = reactExports.useRef(null);
  const route = bridge.route(editorConnected);
  const origin = parseOrigin(unit.origin);
  const args = formatArgs(unit.source);
  const lengthLimit = (gridCell == null ? void 0 : gridCell.lengthLimit) ?? null;
  const draftLength = visibleLength(draft);
  const loadHistory = reactExports.useCallback(() => {
    api2.history(culture, unit.id).then(setHistory, (e) => setError(errorText(e)));
  }, [api2, culture, unit.id]);
  reactExports.useEffect(() => {
    loadHistory();
  }, [loadHistory]);
  const debouncedDraft = useDebouncedDraft(draft, CHECK_DEBOUNCE_MS);
  const checkSeqRef = reactExports.useRef(0);
  const [recheckSeq, setRecheckSeq] = reactExports.useState(0);
  reactExports.useEffect(() => {
    let alive = true;
    const seq = ++checkSeqRef.current;
    api2.check(culture, unit.id, debouncedDraft).then(
      (result) => {
        if (alive && checkSeqRef.current === seq) setIssues(result.issues);
      },
      () => {
      }
    );
    return () => {
      alive = false;
    };
  }, [api2, culture, unit.id, debouncedDraft, recheckSeq]);
  const hasHardIssue = issues.some((issue) => issue.severity === "hard");
  const confirmIssues = hasHardIssue ? [] : issues.filter((issue) => issue.severity === "confirm");
  const listedIssues = hasHardIssue ? issues : issues.filter((issue) => issue.severity !== "confirm");
  const accept = [...new Set(confirmIssues.map((issue) => issue.code))];
  const needsConfirm = accept.length > 0;
  const approveDisabled = hasHardIssue;
  const saveDisabled = draft === cell.text || hasHardIssue;
  const clearMessages = () => {
    setError("");
    setNotice("");
  };
  const run = async (action, done) => {
    clearMessages();
    try {
      const { cell: next } = await action();
      onCell(next);
      setDraft(next.text);
      setNotice(done);
      loadHistory();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.body.error === "stale_cell") {
        if (e.body.cell) {
          onCell(e.body.cell);
          setDraft(e.body.cell.text);
        }
        if (e.body.unit) onUnit == null ? void 0 : onUnit(e.body.unit);
        setError(errorText(e));
        return false;
      }
      if (e instanceof ApiError && e.body.issues) setIssues(e.body.issues);
      setError(errorText(e));
      return false;
    }
  };
  const expected = { revision: cell.revision, sourceRev: unit.sourceRev };
  const save = () => run(() => api2.edit(culture, unit.id, draft, expected, accept), "Saved.");
  const approve = () => draft !== cell.text ? save() : run(() => api2.approve(culture, unit.id, expected, accept), "Approved.");
  const reject = (event) => {
    event.preventDefault();
    void run(() => api2.reject(culture, unit.id, rejectNote, expected), "Rejected: the string goes back to translation.").then((ok) => {
      if (ok) setRejectNote("");
    });
  };
  const retranslate = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      const result = await api2.retranslate(culture, unit.id, retranslateNote, asRule);
      onCell(result.cell);
      setSuggestionIssues(result.issues);
      setRecheckSeq((n) => n + 1);
      setNotice(asRule ? "New suggestion below; the note was added to the style guide." : "New suggestion below.");
      loadHistory();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const ask = async (event) => {
    event.preventDefault();
    clearMessages();
    try {
      await api2.askContext(culture, unit.id, question);
      setQuestion("");
      setNotice("Question sent to the Inbox.");
    } catch (e) {
      setError(errorText(e));
    }
  };
  const applyLive = async () => {
    clearMessages();
    try {
      const applied = await bridge.applyLive(culture, [{ namespace: unit.namespace, key: unit.key, source: unit.source, translation: draft }], editorConnected);
      if (applied) setNotice(`Applied live in the editor (${culture} preview).`);
      else setError("The editor did not apply the text.");
    } catch (e) {
      setError(errorText(e));
    }
  };
  reactExports.useImperativeHandle(handleRef, () => ({
    // The queue's A hotkey calls this directly, bypassing the Approve button's own `disabled` attribute — so
    // the key press must not be silently ignored while blocked, it must surface the same message a click would.
    approve: () => {
      if (approveDisabled) {
        setNotice(FIX_PROBLEMS_TITLE);
        return;
      }
      if (needsConfirm) {
        setNotice(CHECK_WARNINGS_NOTICE);
        return;
      }
      void approve();
    },
    pickAlternative: (index) => {
      const alternative = cell.alts[index];
      if (alternative !== void 0) setDraft(alternative);
    },
    focusEdit: () => {
      var _a;
      return (_a = editRef.current) == null ? void 0 : _a.focus();
    },
    focusReject: () => {
      var _a;
      return (_a = rejectRef.current) == null ? void 0 : _a.focus();
    },
    focusContext: () => {
      var _a;
      return (_a = contextRef.current) == null ? void 0 : _a.focus();
    }
  }));
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("article", { className: "cell-panel", "aria-label": `${unit.namespace} ${unit.key}`, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "cell-head", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: unit.namespace || "(no namespace)" }),
      " / ",
      /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: unit.key }),
      !blind && cell.band && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `chip band-${cell.band}`, children: cell.band }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "chip", children: cell.status }),
      (gridCell == null ? void 0 : gridCell.outdated) && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "chip outdated", children: "outdated" })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Source" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "source-text", children: unit.source }),
      (gridCell == null ? void 0 : gridCell.outdated) && cell.basedOnSource && /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "muted", children: [
        "Translated from: ",
        cell.basedOnSource
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("h3", { children: [
        "Translation (",
        culture,
        ")"
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("textarea", { ref: editRef, "aria-label": "Translation", rows: 3, value: draft, onChange: (e) => setDraft(e.target.value) }),
      lengthLimit !== null && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: draftLength > lengthLimit ? "length-counter over" : "length-counter", title: LENGTH_COUNTER_TITLE, children: `${draftLength}/${lengthLimit}` }),
      listedIssues.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "issues", children: listedIssues.map((issue, index) => (
        // A soft issue (e.g. a Warning-level too_long, or "Translation is identical to the source") is a
        // hint that blocks nothing; only a hard issue is the blocking-error red the list defaults to (M-2).
        /* @__PURE__ */ jsxRuntimeExports.jsx("li", { className: issue.severity === "soft" ? "soft" : void 0, children: issue.message }, index)
      )) }),
      needsConfirm && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "confirm-issues", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: CONFIRM_LINE }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "issues confirm", children: confirmIssues.map((issue, index) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: issue.message }, index)) })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void approve(), disabled: approveDisabled, title: approveDisabled ? FIX_PROBLEMS_TITLE : void 0, children: needsConfirm ? "Approve anyway" : "Approve (A)" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => void save(), disabled: saveDisabled, title: hasHardIssue ? FIX_PROBLEMS_TITLE : void 0, children: needsConfirm ? "Save anyway" : "Save edit" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            onClick: () => void applyLive(),
            disabled: route === "none" || draft.length === 0,
            title: route === "none" ? "The editor is not connected" : "Show this text in the editor without a Pull",
            children: "Apply live"
          }
        )
      ] }),
      cell.suggestion && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "suggestion", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { children: [
          "Suggestion: ",
          cell.suggestion,
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: () => setDraft(cell.suggestion), children: "Use suggestion" })
        ] }),
        suggestionIssues.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "issues suggestion-issues", children: suggestionIssues.map((issue, index) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: issue.message }, index)) })
      ] }),
      cell.alts.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("ol", { className: "alts", children: cell.alts.slice(0, 3).map((alternative, index) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", onClick: () => setDraft(alternative), children: [
          "Use ",
          index + 1
        ] }),
        " ",
        alternative
      ] }, index)) })
    ] }),
    cell.judgeIssues.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Judge" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "judge", children: cell.judgeIssues.map((issue, index) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: issue.severity }),
        " ",
        issue.category,
        ": ",
        issue.why,
        issue.fix && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          " (fix: ",
          issue.fix,
          ")"
        ] })
      ] }, index)) })
    ] }),
    cell.question && /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Model question" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { children: cell.question })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "Context" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("dl", { className: "context", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Origin" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("dd", { children: [
          origin.kind === "unknown" && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", children: unit.origin || "unknown" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(OriginActions, { unit, bridge, editorConnected, onBeforeAction: clearMessages, onError: setError })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Dev notes" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: unit.devNotes || "none" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Arguments" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: args.length > 0 ? args.map((name) => `{${name}}`).join(" ") : "none" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Group" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: unit.groupKey || "none" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dt", { children: "Provenance" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("dd", { children: cell.provenance || "none" })
      ] }),
      neighbors.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("table", { className: "neighbors", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("caption", { children: "Other strings in this group" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("tbody", { children: neighbors.map((neighbor) => {
          var _a;
          return /* @__PURE__ */ jsxRuntimeExports.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: neighbor.unit.source }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("td", { children: ((_a = neighbor.cells[culture]) == null ? void 0 : _a.cell.text) ?? "" })
          ] }, neighbor.unit.id);
        }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { className: "forms", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("form", { onSubmit: reject, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { ref: rejectRef, "aria-label": "Reject reason", placeholder: "What is wrong? (R)", value: rejectNote, onChange: (e) => setRejectNote(e.target.value) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "submit", children: "Reject" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("form", { onSubmit: (e) => void retranslate(e), children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { "aria-label": "Retranslate note", placeholder: "Explain, then translate again", value: retranslateNote, onChange: (e) => setRetranslateNote(e.target.value) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("input", { type: "checkbox", checked: asRule, onChange: (e) => setAsRule(e.target.checked) }),
          " as a style rule"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "submit", disabled: retranslateNote.trim().length === 0, children: "Translate again" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("form", { onSubmit: (e) => void ask(e), children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("input", { ref: contextRef, "aria-label": "Context question", placeholder: "What context is missing? (N)", value: question, onChange: (e) => setQuestion(e.target.value) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "submit", disabled: question.trim().length === 0, children: "Ask for context" })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { children: "History" }),
      history.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", children: "No changes yet." }) : /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { className: "history", children: history.map((event, index) => /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("time", { children: event.ts }),
        " ",
        event.actor,
        " ",
        historyVerb(event),
        ": ",
        event.before || "(empty)",
        " to ",
        event.after || "(empty)"
      ] }, index)) })
    ] }),
    notice && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "notice", role: "status", children: notice }),
    error && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error })
  ] });
}
const KEYMAP = {
  j: "next",
  k: "prev",
  a: "approve",
  e: "edit",
  "1": "alt1",
  "2": "alt2",
  "3": "alt3",
  r: "reject",
  n: "context"
};
function queueAction(event, inTextField) {
  if (inTextField || event.ctrlKey || event.metaKey || event.altKey) return void 0;
  return KEYMAP[event.key.toLowerCase()];
}
function isTextField(element2) {
  if (!element2) return false;
  const tag = element2.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element2.isContentEditable === true;
}
const IN_REVIEW = /* @__PURE__ */ new Set(["ai_draft", "needs_fix"]);
const BAND_RANK = { R: 1, Y: 2, G: 3 };
function rank(row, culture) {
  var _a;
  const cell = (_a = row.cells[culture]) == null ? void 0 : _a.cell;
  if (!cell) return 9;
  if (cell.status === "needs_fix") return 0;
  return BAND_RANK[cell.band] ?? 4;
}
function buildQueue(rows, culture) {
  return rows.filter((row) => {
    var _a;
    const cell = (_a = row.cells[culture]) == null ? void 0 : _a.cell;
    if (!cell || !IN_REVIEW.has(cell.status)) return false;
    return cell.status === "needs_fix" || cell.band !== "G" || cell.qaFlags.includes("audit");
  }).sort((a, b) => rank(a, culture) - rank(b, culture));
}
function QueueView({ api: api2, bridge, rows, culture, editorConnected, onCell, onUnit }) {
  const queue = reactExports.useMemo(() => buildQueue(rows, culture), [rows, culture]);
  const [index, setIndex] = reactExports.useState(0);
  const panel = reactExports.useRef(null);
  const lastIndex = Math.max(queue.length - 1, 0);
  const trackedUnitId = reactExports.useRef(void 0);
  const trackedIndex = trackedUnitId.current !== void 0 ? queue.findIndex((row) => row.unit.id === trackedUnitId.current) : -1;
  const position = trackedIndex >= 0 ? trackedIndex : Math.min(index, lastIndex);
  const current = queue[position];
  reactExports.useEffect(() => {
    trackedUnitId.current = current == null ? void 0 : current.unit.id;
    setIndex(position);
  }, [position, current]);
  reactExports.useEffect(() => {
    const onKeyDown = (event) => {
      var _a, _b;
      const inField = isTextField(document.activeElement);
      if (inField && event.key === "Escape") {
        document.activeElement.blur();
        return;
      }
      const action = queueAction(event, inField);
      if (!action) return;
      event.preventDefault();
      const handle = panel.current;
      switch (action) {
        case "next": {
          const next = Math.min(position + 1, lastIndex);
          trackedUnitId.current = (_a = queue[next]) == null ? void 0 : _a.unit.id;
          setIndex(next);
          break;
        }
        case "prev": {
          const prev = Math.max(position - 1, 0);
          trackedUnitId.current = (_b = queue[prev]) == null ? void 0 : _b.unit.id;
          setIndex(prev);
          break;
        }
        case "approve":
          handle == null ? void 0 : handle.approve();
          break;
        case "edit":
          handle == null ? void 0 : handle.focusEdit();
          break;
        case "alt1":
          handle == null ? void 0 : handle.pickAlternative(0);
          break;
        case "alt2":
          handle == null ? void 0 : handle.pickAlternative(1);
          break;
        case "alt3":
          handle == null ? void 0 : handle.pickAlternative(2);
          break;
        case "reject":
          handle == null ? void 0 : handle.focusReject();
          break;
        case "context":
          handle == null ? void 0 : handle.focusContext();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [queue, position, lastIndex]);
  if (!current) return /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "empty", children: [
    "Nothing to review in ",
    culture,
    "."
  ] });
  const neighbors = rows.filter((r) => r.unit.groupKey === current.unit.groupKey && r.unit.id !== current.unit.id).slice(0, 8);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "queue", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "queue-bar", children: [
      position + 1,
      " / ",
      queue.length,
      " · J/K next/previous · A approve · E edit · 1-3 alternative · R reject · N ask for context · Esc leaves a field"
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      CellPanel,
      {
        handleRef: panel,
        api: api2,
        bridge,
        row: current,
        culture,
        editorConnected,
        neighbors,
        blind: true,
        onCell,
        onUnit
      },
      `${current.unit.id}:${culture}`
    )
  ] });
}
const SIMPLE_VIEWS = ["grid", "queue", "glossary", "jobs", "coverage", "summary", "inbox"];
function parseView(hash) {
  let parts;
  try {
    parts = hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  } catch {
    return { name: "grid" };
  }
  const [name, first, second] = parts;
  if (name === "card" && first && second) return { name: "card", culture: first, unitId: second };
  const simple = SIMPLE_VIEWS.find((candidate) => candidate === name);
  return simple ? { name: simple } : { name: "grid" };
}
function viewHref(view) {
  if (view.name === "card") return `#/card/${encodeURIComponent(view.culture)}/${encodeURIComponent(view.unitId)}`;
  return `#/${view.name}`;
}
function useView() {
  const [view, setView] = reactExports.useState(() => parseView(window.location.hash));
  reactExports.useEffect(() => {
    const onHashChange = () => setView(parseView(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const navigate = reactExports.useCallback((next) => {
    window.location.hash = viewHref(next);
  }, []);
  return [view, navigate];
}
const NAV = [
  { view: { name: "grid" }, label: "Grid" },
  { view: { name: "queue" }, label: "Review" },
  { view: { name: "glossary" }, label: "Glossary" },
  { view: { name: "jobs" }, label: "Jobs" },
  { view: { name: "coverage" }, label: "Coverage" },
  { view: { name: "summary" }, label: "Summary" },
  { view: { name: "inbox" }, label: "Inbox" }
];
function editorStatus(health, route) {
  if (!health) return "Service offline";
  if (route === "direct") return "Editor: this tab";
  if (route === "relay") return "Editor: connected";
  return "Editor: offline";
}
const AI_PROVIDER_LABEL = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  custom: "Custom"
};
const ENDPOINT_STATUS_LABEL = {
  checking: "checking endpoint…",
  ok: "endpoint OK",
  model_missing: "model missing",
  unreachable: "unreachable",
  unknown: "no model list"
};
function aiBadgeTone(ready, endpoint) {
  if ((endpoint == null ? void 0 : endpoint.status) === "unreachable") return " endpoint-error";
  if (!ready || (endpoint == null ? void 0 : endpoint.status) === "model_missing") return " warning";
  return "";
}
function AiBadge({ health }) {
  if (!health) return null;
  const ai = health.ai;
  if (!ai) return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "ai-status", children: "AI: Anthropic" });
  const isCurrentShape = typeof ai.provider === "string" && ai.provider in AI_PROVIDER_LABEL;
  const endpoint = isCurrentShape ? ai.endpoint : void 0;
  const host = endpoint ? ` (${endpoint.url.replace(/^https?:\/\//, "")})` : "";
  const probe = endpoint ? ` · ${ENDPOINT_STATUS_LABEL[endpoint.status] ?? endpoint.status}` : "";
  const label = isCurrentShape ? `AI: ${AI_PROVIDER_LABEL[ai.provider]}${ai.auth === "subscription" ? " (subscription)" : ""}${host} · ${ai.translateModel} / ${ai.judgeModel}${probe}` : "AI: Anthropic";
  const title = ai.ready ? (endpoint == null ? void 0 : endpoint.detail) ?? "" : ai.detail;
  return /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `ai-status${aiBadgeTone(ai.ready, endpoint)}`, title, children: label });
}
const THEME_KEY = "lochub.theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
function readStoredTheme$1() {
  try {
    const stored2 = localStorage.getItem(THEME_KEY);
    return stored2 === "light" || stored2 === "dark" ? stored2 : void 0;
  } catch {
    return void 0;
  }
}
function ThemeToggle() {
  const [theme, setTheme] = reactExports.useState(() => readStoredTheme$1() ?? currentTheme());
  const next = theme === "dark" ? "light" : "dark";
  reactExports.useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
    }
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", "aria-label": "Toggle theme", onClick: toggle, children: next === "dark" ? "Dark" : "Light" });
}
function neighborsOf(rows, row) {
  return rows.filter((candidate) => candidate.unit.groupKey === row.unit.groupKey && candidate.unit.id !== row.unit.id).slice(0, 8);
}
const SYNC_LABEL = { push: "Push", dryrun: "Dry run", pull: "Pull" };
const SYNC_BUSY_LABEL = { push: "Pushing…", dryrun: "Checking…", pull: "Pulling…" };
const SYNC_TITLE = {
  push: "Send the gathered strings to LocHub (a dry run and a confirmation come first)",
  dryrun: "Show what a Push would add, change and retire",
  pull: "Write released translations into the archives and compile .locres"
};
const SYNC_ACTIONS = ["push", "dryrun", "pull"];
function syncOutcomeClass(outcome) {
  if (outcome.cancelled) return "cancelled";
  return outcome.success ? "ok" : "failed";
}
function SyncResultPanel({ outcome, onDismiss }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: `sync-result ${syncOutcomeClass(outcome)}`, role: "status", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: outcome.summary }),
    outcome.details.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("summary", { children: "Details" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { children: outcome.details.map((line, index) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: line }, index)) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: onDismiss, children: "Dismiss" })
  ] });
}
function App({ api: api2, bridge, healthMs = 5e3 }) {
  var _a, _b, _c, _d;
  const [view, navigate] = useView();
  const [meta, setMeta] = reactExports.useState({ nativeCulture: "", cultures: [] });
  const [chosenCulture, setChosenCulture] = reactExports.useState("");
  const [chosenColumns, setChosenColumns] = reactExports.useState(() => loadChosenColumns());
  const [health, setHealth] = reactExports.useState();
  const [filters, setFilters] = reactExports.useState(NO_FILTERS);
  const [jobPreset, setJobPreset] = reactExports.useState();
  const [error, setError] = reactExports.useState("");
  const [syncing, setSyncing] = reactExports.useState(null);
  const [syncResult, setSyncResult] = reactExports.useState(null);
  const gridScroll = reactExports.useRef({ top: 0, left: 0 });
  const cultures = reactExports.useMemo(() => [...meta.cultures].sort(), [meta.cultures]);
  const culture = cultures.includes(chosenCulture) ? chosenCulture : cultures[0] ?? "";
  const visible = reactExports.useMemo(() => visibleCultures(cultures, chosenColumns, culture), [cultures, chosenColumns, culture]);
  const grid = useGridData(api2, visible);
  const reviewCount = reactExports.useMemo(() => buildQueue(grid.rows, culture).length, [grid.rows, culture]);
  const editorConnected = (health == null ? void 0 : health.editorConnected) ?? false;
  const route = bridge.route(editorConnected);
  const { reload } = grid;
  const onVisible = reactExports.useCallback((list) => {
    const extras = extraColumns(list, culture, chosenColumns);
    setChosenColumns(extras);
    saveChosenColumns(extras);
  }, [culture, chosenColumns]);
  reactExports.useEffect(() => {
    const poll = () => {
      api2.health().then(setHealth, () => setHealth(void 0));
    };
    poll();
    const timer = window.setInterval(poll, healthMs);
    return () => window.clearInterval(timer);
  }, [api2, healthMs]);
  const lastJobsFinished = reactExports.useRef(void 0);
  const onJobDone = reactExports.useCallback(() => {
    void reload();
  }, [reload]);
  reactExports.useEffect(() => {
    const seen = health == null ? void 0 : health.jobsFinished;
    if (seen === void 0) return;
    if (lastJobsFinished.current !== void 0 && seen > lastJobsFinished.current) {
      void reload();
    }
    lastJobsFinished.current = seen;
  }, [health == null ? void 0 : health.jobsFinished, reload]);
  const lastLengthArgs = reactExports.useRef(void 0);
  reactExports.useEffect(() => {
    var _a2;
    const seen = (_a2 = health == null ? void 0 : health.ai) == null ? void 0 : _a2.lengthArgs;
    if (seen === void 0) return;
    if (lastLengthArgs.current !== void 0 && seen !== lastLengthArgs.current) {
      void reload();
    }
    lastLengthArgs.current = seen;
  }, [(_a = health == null ? void 0 : health.ai) == null ? void 0 : _a.lengthArgs, reload]);
  const loadMeta = reactExports.useCallback(() => {
    return api2.meta().then(setMeta, (e) => setError(errorText(e)));
  }, [api2]);
  reactExports.useEffect(() => {
    void loadMeta();
  }, [loadMeta]);
  const refresh = reactExports.useCallback(() => {
    void reload();
    void loadMeta();
  }, [reload, loadMeta]);
  const runSync = async (action) => {
    setSyncing(action);
    try {
      const outcome = await bridge.sync(action);
      setSyncResult(outcome);
      if (outcome.success && (action === "push" || action === "pull")) refresh();
    } catch (e) {
      setSyncResult({ success: false, cancelled: false, summary: errorText(e), details: [] });
    } finally {
      setSyncing(null);
    }
  };
  const run = async (action, failure) => {
    setError("");
    try {
      if (!await action()) setError(failure);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const applyAllLive = () => void run(() => bridge.applyLive(culture, liveEntries(grid.rows, culture), editorConnected), "Nothing was applied: no translations, or the editor refused them.");
  const previewCulture = () => void run(() => bridge.setPreviewCulture(culture, editorConnected), "The editor did not switch the preview culture.");
  let content;
  if (cultures.length === 0) {
    content = /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { className: "empty", children: [
      "No strings yet. If the project has no Game localization target, run Tools ",
      ">",
      " LocHub ",
      ">",
      " Set Up Localization Target in the editor. Then press Push to send your strings to LocHub."
    ] });
  } else if (view.name === "card") {
    const row = grid.rows.find((candidate) => candidate.unit.id === view.unitId);
    content = row ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "card-view", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: viewHref({ name: "grid" }), children: "Back to the grid" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        CellPanel,
        {
          api: api2,
          bridge,
          row,
          culture: view.culture,
          editorConnected,
          neighbors: neighborsOf(grid.rows, row),
          onCell: grid.updateCell,
          onUnit: grid.updateUnit
        },
        `${row.unit.id}:${view.culture}`
      )
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "empty", children: grid.loading ? "Loading…" : "This string is not in the grid." });
  } else if (view.name === "queue") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(QueueView, { api: api2, bridge, rows: grid.rows, culture, editorConnected, onCell: grid.updateCell, onUnit: grid.updateUnit });
  } else if (view.name === "glossary") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(
      GlossaryView,
      {
        api: api2,
        culture,
        rows: grid.rows,
        onCell: grid.updateCell,
        onTermFix: (scope) => {
          setJobPreset(scope);
          navigate({ name: "jobs" });
        },
        bridge,
        cultures,
        nativeCulture: meta.nativeCulture
      }
    );
  } else if (view.name === "jobs") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(
      JobsView,
      {
        api: api2,
        culture,
        rows: grid.rows,
        billing: ((_b = health == null ? void 0 : health.ai) == null ? void 0 : _b.auth) === "subscription" ? "subscription" : "api",
        aiReady: ((_c = health == null ? void 0 : health.ai) == null ? void 0 : _c.ready) ?? true,
        aiDetail: ((_d = health == null ? void 0 : health.ai) == null ? void 0 : _d.detail) ?? "",
        preset: jobPreset,
        onJobDone
      }
    );
  } else if (view.name === "coverage") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(CoverageView, { api: api2 });
  } else if (view.name === "summary") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(SummaryView, { api: api2, culture });
  } else if (view.name === "inbox") {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(InboxView, { api: api2, culture });
  } else {
    content = /* @__PURE__ */ jsxRuntimeExports.jsx(
      GridView,
      {
        rows: grid.rows,
        cultures,
        visible,
        onVisible,
        culture,
        nativeCulture: meta.nativeCulture,
        filters,
        onFilters: setFilters,
        onOpenCell: (cellCulture, unitId) => navigate({ name: "card", culture: cellCulture, unitId }),
        onApplyLive: applyAllLive,
        canApplyLive: route !== "none" && culture !== "",
        bridge,
        editorConnected,
        scrollMemory: gridScroll.current,
        loadedCultures: grid.loadedCultures,
        loading: grid.loading,
        toolbarExtra: (filtered) => (
          // Keyed by culture: switching culture closes an open preview instead of importing into the new culture.
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            ExchangeActions,
            {
              api: api2,
              bridge,
              culture,
              cultures,
              nativeCulture: meta.nativeCulture,
              filtered,
              totalCount: grid.rows.length,
              onImported: () => void reload()
            },
            culture
          )
        )
      }
    );
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "app", children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("header", { className: "top", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "top-row", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("strong", { className: "brand", children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("img", { className: "brand-logo", src: "./favicon.svg", alt: "", width: 20, height: 20 }),
          "LocHub"
        ] }),
        meta.nativeCulture && /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "context-line muted", children: [
          meta.nativeCulture,
          " → ",
          cultures.length,
          " ",
          cultures.length === 1 ? "culture" : "cultures"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "spacer" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("select", { className: "culture", "aria-label": "Culture", value: culture, onChange: (e) => setChosenCulture(e.target.value), children: cultures.map((code) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: code, children: code }, code)) }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("button", { type: "button", onClick: previewCulture, disabled: route === "none" || culture === "", children: [
          "Preview ",
          culture || "culture",
          " in editor"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: `editor-status route-${route}`, children: editorStatus(health, route) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(AiBadge, { health }),
        bridge.canSync() && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "sync-actions", children: SYNC_ACTIONS.map((action) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            type: "button",
            className: action === "push" ? "primary" : void 0,
            onClick: () => void runSync(action),
            disabled: syncing !== null,
            title: SYNC_TITLE[action],
            children: syncing === action ? SYNC_BUSY_LABEL[action] : SYNC_LABEL[action]
          },
          action
        )) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { type: "button", onClick: refresh, disabled: grid.loading, children: grid.loading ? "Loading…" : "Refresh" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(ThemeToggle, {})
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "top-row", children: /* @__PURE__ */ jsxRuntimeExports.jsx("nav", { children: NAV.map((item) => /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: viewHref(item.view), "aria-current": item.view.name === view.name ? "page" : void 0, children: item.view.name === "queue" && reviewCount > 0 ? `${item.label} (${reviewCount})` : item.label }, item.label)) }) })
    ] }),
    (health == null ? void 0 : health.ai) && !health.ai.ready && health.ai.detail && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "notice warning", role: "alert", children: health.ai.detail }),
    syncResult && /* @__PURE__ */ jsxRuntimeExports.jsx(SyncResultPanel, { outcome: syncResult, onDismiss: () => setSyncResult(null) }),
    (health == null ? void 0 : health.stale) && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "banner stale", role: "alert", children: "Localization/LocHub changed on disk. Restart the LocHub service (Tools > LocHub > Restart Service), then Refresh." }),
    (error || grid.error) && /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "error", role: "alert", children: error || grid.error }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("main", { children: content })
  ] });
}
const UNREADABLE_SYNC_OUTCOME = { success: false, cancelled: false, summary: "The editor sent an unreadable sync result.", details: [] };
function isPickFileResult(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  if (candidate.cancelled === true) return true;
  return candidate.cancelled === false && typeof candidate.name === "string" && typeof candidate.base64 === "string";
}
function isSaveFileResult(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  if (candidate.cancelled === true) return true;
  return candidate.cancelled === false && typeof candidate.path === "string";
}
function parseFileResult(raw, isValid, what) {
  const fail = () => {
    throw new Error(`The editor sent an unreadable ${what} result.`);
  };
  if (typeof raw !== "string") return fail();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!isValid(parsed)) return fail();
  return parsed;
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseSyncOutcome(raw) {
  if (typeof raw !== "string") return UNREADABLE_SYNC_OUTCOME;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE_SYNC_OUTCOME;
  }
  if (parsed === null || typeof parsed !== "object") return UNREADABLE_SYNC_OUTCOME;
  const candidate = parsed;
  if (typeof candidate.success !== "boolean" || typeof candidate.cancelled !== "boolean" || typeof candidate.summary !== "string" || !isStringArray(candidate.details))
    return UNREADABLE_SYNC_OUTCOME;
  return { success: candidate.success, cancelled: candidate.cancelled, summary: candidate.summary, details: candidate.details };
}
function rejectionText(error) {
  return error instanceof Error ? error.message : String(error);
}
function findBinding(scope = globalThis) {
  var _a;
  const candidate = (_a = scope == null ? void 0 : scope.ue) == null ? void 0 : _a.lochub;
  if (!candidate) return void 0;
  const complete = typeof candidate.openorigin === "function" && typeof candidate.setpreviewculture === "function" && typeof candidate.applylive === "function";
  return complete ? candidate : void 0;
}
function routeFor(binding, editorConnected) {
  if (binding) return "direct";
  return editorConnected ? "relay" : "none";
}
async function succeeded(result) {
  return await Promise.resolve(result) !== false;
}
class EditorBridge {
  constructor(api2, binding = () => findBinding()) {
    __publicField(this, "api");
    __publicField(this, "binding");
    this.api = api2;
    this.binding = binding;
  }
  route(editorConnected) {
    return routeFor(this.binding(), editorConnected);
  }
  // Sync (Push / Dry run / Pull) exists only as the direct in-tab binding, with no relay route for it: an
  // external browser, or an editor build that predates this change, must hide the buttons instead of calling it.
  canSync() {
    var _a;
    return typeof ((_a = this.binding()) == null ? void 0 : _a.sync) === "function";
  }
  async sync(action) {
    const binding = this.binding();
    if (typeof (binding == null ? void 0 : binding.sync) !== "function") throw new Error("Push and Pull run only in the editor tab.");
    let raw;
    try {
      raw = await binding.sync(action);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseSyncOutcome(raw);
  }
  // File access (CSV Import/Export) exists only as the direct in-tab binding, same reasoning as Sync: files.ts
  // uses these to feature-detect and falls back to a browser <input>/Blob download when they are missing.
  canPickFile() {
    var _a;
    return typeof ((_a = this.binding()) == null ? void 0 : _a.picktextfile) === "function";
  }
  canSaveFile() {
    var _a;
    return typeof ((_a = this.binding()) == null ? void 0 : _a.savetextfile) === "function";
  }
  async pickFile(title, fileTypes) {
    const binding = this.binding();
    if (typeof (binding == null ? void 0 : binding.picktextfile) !== "function") throw new Error("File access runs only in the editor tab.");
    let raw;
    try {
      raw = await binding.picktextfile(title, fileTypes);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseFileResult(raw, isPickFileResult, "file picker");
  }
  async saveFile(title, defaultFileName, fileTypes, text) {
    const binding = this.binding();
    if (typeof (binding == null ? void 0 : binding.savetextfile) !== "function") throw new Error("File access runs only in the editor tab.");
    let raw;
    try {
      raw = await binding.savetextfile(title, defaultFileName, fileTypes, text);
    } catch (error) {
      throw new Error(rejectionText(error));
    }
    return parseFileResult(raw, isSaveFileResult, "save file");
  }
  async openOrigin(args, editorConnected) {
    const binding = this.binding();
    if (binding) return succeeded(binding.openorigin(args.origin));
    return this.relay("OpenOrigin", { ...args }, editorConnected);
  }
  async setPreviewCulture(culture, editorConnected) {
    const binding = this.binding();
    if (binding) return succeeded(binding.setpreviewculture(culture));
    return this.relay("SetPreviewCulture", { culture }, editorConnected);
  }
  async applyLive(culture, entries, editorConnected) {
    if (entries.length === 0) return false;
    const binding = this.binding();
    if (binding) return succeeded(binding.applylive(culture, JSON.stringify(entries)));
    return this.relay("ApplyLive", { culture, entries }, editorConnected);
  }
  // The tab never relays: the same editor would run the command twice (direct call plus SSE).
  async relay(name, args, editorConnected) {
    if (!editorConnected) return false;
    await this.api.bridgeCommand(name, args);
    return true;
  }
}
function readStoredTheme() {
  try {
    return localStorage.getItem("lochub.theme");
  } catch {
    return null;
  }
}
const isEditorHost = new URLSearchParams(window.location.search).get("host") === "editor";
const stored = readStoredTheme();
document.documentElement.dataset.theme = stored === "light" || stored === "dark" ? stored : isEditorHost ? "dark" : "auto";
const api = new LocHubApi();
const root = document.getElementById("root");
if (root) {
  clientExports.createRoot(root).render(
    /* @__PURE__ */ jsxRuntimeExports.jsx(reactExports.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(App, { api, bridge: new EditorBridge(api) }) })
  );
}
