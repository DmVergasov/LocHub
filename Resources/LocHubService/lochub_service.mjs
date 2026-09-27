#!/usr/bin/env node
// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.

// src/cli.ts
import { createHash as createHash8 } from "node:crypto";
import { existsSync as existsSync5, readFileSync as readFileSync5 } from "node:fs";
import { join as join7, resolve as resolve3 } from "node:path";
import { parseArgs } from "node:util";

// src/bridge.ts
var HEARTBEAT_MS = 15e3;
var BridgeHub = class {
  clients = /* @__PURE__ */ new Set();
  add(write) {
    this.clients.add(write);
    return () => this.clients.delete(write);
  }
  get connected() {
    return this.clients.size;
  }
  send(command) {
    const chunk = `event: command
data: ${JSON.stringify(command)}

`;
    for (const write of this.clients) write(chunk);
    return this.clients.size;
  }
};
function attachEditorStream(hub, write, heartbeatMs = HEARTBEAT_MS) {
  write(": connected\n\n");
  const remove = hub.add(write);
  const timer = setInterval(() => write(": ping\n\n"), heartbeatMs);
  return () => {
    clearInterval(timer);
    remove();
  };
}

// src/cache.ts
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
function writeFileAtomic(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
var ResponseCache = class {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  get(customId) {
    const path = join(this.dir, `${customId}.json`);
    if (!existsSync(path)) return void 0;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      try {
        unlinkSync(path);
      } catch {
      }
      return void 0;
    }
  }
  put(outcome) {
    if (outcome.kind !== "ok") return;
    writeFileAtomic(join(this.dir, `${outcome.customId}.json`), JSON.stringify(outcome));
  }
};
async function resolveWithCache(llm, cache, requests, opts) {
  const out = /* @__PURE__ */ new Map();
  const queued = /* @__PURE__ */ new Set();
  const toSend = [];
  for (const request of requests) {
    if (out.has(request.customId) || queued.has(request.customId)) continue;
    const cached = opts.fresh?.has(request.customId) ? void 0 : cache.get(request.customId);
    if (cached) {
      out.set(request.customId, cached);
      opts.onOutcome?.(cached);
    } else {
      queued.add(request.customId);
      toSend.push(request);
    }
  }
  if (toSend.length === 0) return out;
  const cacheIfWorthKeeping = (outcome) => {
    if (outcome.kind === "ok" && isJsonObject(outcome.text)) cache.put(outcome);
  };
  if (opts.mode === "batch") {
    const results = await llm.runBatch(toSend, opts.pollMs, opts.onBatchProgress);
    for (const outcome of results) {
      out.set(outcome.customId, outcome);
      cacheIfWorthKeeping(outcome);
      opts.onOutcome?.(outcome);
    }
  } else {
    const results = await llm.runSync(
      toSend,
      opts.concurrency,
      (outcome) => {
        cacheIfWorthKeeping(outcome);
        opts.onOutcome?.(outcome);
      },
      opts.shouldContinue
    );
    for (const outcome of results) out.set(outcome.customId, outcome);
  }
  return out;
}
function isJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

// src/customEndpoint.ts
import { createHash } from "node:crypto";

// src/llmShared.ts
var REQUEST_TIMEOUT_MS = 10 * 60 * 1e3;
var NODE_FETCH_TIMEOUT_MS = 3e5;
var NODE_FETCH_TIMEOUT_CODES = /* @__PURE__ */ new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
function nodeFetchTimeoutCode(error) {
  const own = error?.code;
  if (typeof own === "string" && NODE_FETCH_TIMEOUT_CODES.has(own)) return own;
  const cause = error?.cause?.code;
  return typeof cause === "string" && NODE_FETCH_TIMEOUT_CODES.has(cause) ? cause : void 0;
}
function isFetchTimeout(error) {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  return nodeFetchTimeoutCode(error) !== void 0;
}
function timedOutAfterMs(error, configuredMs) {
  return nodeFetchTimeoutCode(error) !== void 0 ? Math.min(configuredMs, NODE_FETCH_TIMEOUT_MS) : configuredMs;
}
function describeDuration(ms) {
  const seconds = Math.round(ms / 1e3);
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
var TIMEOUT_MARK = "the request timed out after";
function timeoutMessage(ms) {
  return `${TIMEOUT_MARK} ${describeDuration(ms)}`;
}
function isTimeoutMessage(message) {
  return message.includes(TIMEOUT_MARK);
}
var BATCH_UNAVAILABLE_MESSAGE = "Batch mode is only available for Anthropic with an API key.";
var MISSING_KEY_MESSAGE = "No API key: enter it in Project Settings > Plugins > LocHub > AI > API Key.";
function systemTextOf(params) {
  const { system } = params;
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
}
function userTextOf(params) {
  const first = params.messages[0];
  if (!first) return "";
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}
function schemaOf(params) {
  return params.output_config?.format?.schema ?? {};
}
function effortOf(params) {
  const effort = params.output_config?.effort;
  return typeof effort === "string" ? effort : void 0;
}
function approxInputTokens(params) {
  return Math.ceil((systemTextOf(params).length + userTextOf(params).length) / 3);
}
function approxOutputTokens(text) {
  return Math.ceil(text.length / 3);
}
var KEY_ENV_VAR = "LOCHUB_API_KEY";
var SECRET_SHAPED_PATTERNS = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_*-]{6,}/g,
  /(?<![A-Za-z0-9])xai-[A-Za-z0-9_*-]{6,}/g,
  /AIza[0-9A-Za-z_-]{10,}/g,
  /Bearer\s+\S+/g
];
function redactSecrets(text) {
  let out = text;
  const value = process.env[KEY_ENV_VAR];
  if (value) out = out.split(value).join("[redacted]");
  for (const pattern of SECRET_SHAPED_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
var FETCH_RETRY_MAX_RETRIES = 2;
var RETRY_AFTER_CAP_MS = 6e4;
var BACKOFF_BASE_MS = 500;
var BACKOFF_CAP_MS = 8e3;
var BACKOFF_JITTER_RATIO = 0.25;
var TRANSIENT_STATUSES = /* @__PURE__ */ new Set([408, 409, 429]);
function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}
function sleep(ms) {
  return new Promise((resolve4) => setTimeout(resolve4, ms));
}
function jitteredBackoffMs(attempt) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  const jitter = base * BACKOFF_JITTER_RATIO;
  return Math.min(Math.max(base - jitter + Math.random() * (2 * jitter), 0), BACKOFF_CAP_MS);
}
function retryAfterMsFrom(headers) {
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, RETRY_AFTER_CAP_MS);
  }
  const after = headers.get("retry-after");
  if (after === null) return void 0;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1e3, RETRY_AFTER_CAP_MS);
  const at = Date.parse(after);
  if (Number.isNaN(at)) return void 0;
  return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_CAP_MS);
}
async function fetchWithRetry(url, buildInit, opts) {
  for (let attempt = 0; ; attempt++) {
    let response;
    let text;
    try {
      response = await opts.fetchImpl(url, buildInit());
      text = await response.text().catch((bodyError) => {
        if (isFetchTimeout(bodyError)) throw bodyError;
        return "";
      });
    } catch (networkError) {
      const timedOut = isFetchTimeout(networkError);
      const final = opts.isFinalNetworkError?.(networkError) ?? false;
      if (final || timedOut && opts.retryTimeouts === false || attempt >= FETCH_RETRY_MAX_RETRIES) return { networkError };
      await sleep(jitteredBackoffMs(attempt));
      continue;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    const isFinal = opts.isFinal?.(response.status, json) ?? false;
    if (isFinal || !isTransientStatus(response.status) || attempt >= FETCH_RETRY_MAX_RETRIES) return { status: response.status, text, json };
    await sleep(retryAfterMsFrom(response.headers) ?? jitteredBackoffMs(attempt));
  }
}
async function runPool(requests, concurrency, runOne, onOutcome, shouldContinue) {
  const out = new Array(requests.length);
  let next = 0;
  const worker = async () => {
    while (next < requests.length) {
      const index = next++;
      if (shouldContinue && !shouldContinue()) {
        out[index] = { customId: requests[index].customId, kind: "skipped" };
        continue;
      }
      const outcome = await runOne(requests[index]);
      out[index] = outcome;
      onOutcome?.(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
  return out;
}

// src/customEndpoint.ts
var CUSTOM_KEY_HEADERS = ["bearer", "api-key"];
var STRUCTURED_OUTPUT_MODES = ["json_schema", "json_object", "prompt_only"];
var CUSTOM_FLAGS = ["base-url", "key-header", "structured-output", "price-in", "price-out", "max-parallel", "request-timeout"];
var CUSTOM_FLAG_DEFAULTS = {
  "key-header": "bearer",
  "structured-output": "json_schema",
  "price-in": "0",
  "price-out": "0",
  "max-parallel": "2",
  "request-timeout": "300"
};
var REQUEST_TIMEOUT_MIN_SECONDS = 30;
var REQUEST_TIMEOUT_MAX_SECONDS = 300;
function customSettingsIdOf(rawValues) {
  return createHash("sha1").update(rawValues.join("\n"), "utf8").digest("hex").slice(0, 12);
}
function parsePrice(text) {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
function parseIntInRange(text, min, max) {
  const value = Number(text);
  return /^\d+$/.test(text) && value >= min && value <= max ? value : void 0;
}
function parseCustomEndpointFlags(values, envBaseUrl) {
  const raw = (flag) => values[flag] ?? CUSTOM_FLAG_DEFAULTS[flag];
  const flagBaseUrl = values["base-url"];
  const usingEnv = flagBaseUrl === void 0 && envBaseUrl !== void 0 && envBaseUrl !== "";
  const baseUrlRaw = flagBaseUrl ?? envBaseUrl ?? "";
  const baseUrlLabel = usingEnv ? "Custom Base URL" : "--base-url";
  if (baseUrlRaw === "") return { error: "Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL" };
  let parsed;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    parsed = void 0;
  }
  if (!parsed || parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `Invalid ${baseUrlLabel}: it must start with http:// or https://` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: `Invalid ${baseUrlLabel}: a user name or password in the URL is not supported; set the key in Project Settings > Plugins > LocHub > AI > API Key` };
  }
  const keyHeader = raw("key-header");
  if (!CUSTOM_KEY_HEADERS.includes(keyHeader)) return { error: `Invalid --key-header ${keyHeader}` };
  const structuredOutput = raw("structured-output");
  if (!STRUCTURED_OUTPUT_MODES.includes(structuredOutput)) return { error: `Invalid --structured-output ${structuredOutput}` };
  const priceIn = parsePrice(raw("price-in"));
  if (priceIn === void 0) return { error: `Invalid --price-in ${raw("price-in")}` };
  const priceOut = parsePrice(raw("price-out"));
  if (priceOut === void 0) return { error: `Invalid --price-out ${raw("price-out")}` };
  const maxParallel = parseIntInRange(raw("max-parallel"), 1, 32);
  if (maxParallel === void 0) return { error: `Invalid --max-parallel ${raw("max-parallel")}` };
  const requestTimeoutSeconds = parseIntInRange(raw("request-timeout"), REQUEST_TIMEOUT_MIN_SECONDS, REQUEST_TIMEOUT_MAX_SECONDS);
  if (requestTimeoutSeconds === void 0) return { error: `Invalid --request-timeout ${raw("request-timeout")}` };
  return {
    baseUrl: baseUrlRaw.endsWith("/") ? baseUrlRaw.slice(0, -1) : baseUrlRaw,
    keyHeader,
    structuredOutput,
    priceIn,
    priceOut,
    maxParallel,
    requestTimeoutSeconds,
    settingsId: customSettingsIdOf([baseUrlRaw, keyHeader, structuredOutput, raw("price-in"), raw("price-out"), raw("max-parallel"), raw("request-timeout")])
  };
}
function reduceBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(invalid URL)";
  }
}
function endpointUrl(baseUrl, path) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  return url.toString();
}
function scrubUrls(text) {
  return text.replace(/https?:\/\/[^\s"'<>,;)]+/gi, (match) => {
    const url = match.replace(/\.+$/, "");
    return reduceBaseUrl(url) + match.slice(url.length);
  });
}
var MIN_SCRUBBED_QUERY_VALUE_LENGTH = 4;
function scrubBaseUrlParts(text, baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return text;
  }
  let out = text;
  if (parsed.search !== "") out = out.split(parsed.search).join("");
  if (parsed.pathname !== "" && parsed.pathname !== "/") out = out.split(parsed.pathname).join("");
  const reduced = reduceBaseUrl(baseUrl);
  const values = new Set(parsed.searchParams.values());
  for (const pair of parsed.search.slice(1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq !== -1) values.add(pair.slice(eq + 1));
  }
  const secrets = [...values].filter((value) => value.length >= MIN_SCRUBBED_QUERY_VALUE_LENGTH && !reduced.includes(value)).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return out;
  const alternatives = secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${alternatives})(?![A-Za-z0-9_-])`, "g");
  return out.replace(pattern, "[redacted]");
}
var REDIRECT_REASON = "replied with a redirect, which LocHub does not follow for a Custom endpoint; set Base URL to the final address";
var REDIRECT_MESSAGE = `the server ${REDIRECT_REASON}`;
function isRedirectError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error?.cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return /redirect/i.test(message) || /redirect/i.test(causeMessage);
}
function authHeaders(keyHeader, apiKey) {
  if (!apiKey) return {};
  return keyHeader === "api-key" ? { "api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
}
function balancedObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
var LEADING_THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>/i;
function extractJsonObject(text, expectedKey) {
  const withoutThink = text.replace(LEADING_THINK_BLOCK, "");
  let start = withoutThink.indexOf("{");
  let firstParseable;
  while (start !== -1) {
    const end = balancedObjectEnd(withoutThink, start);
    if (end === -1) break;
    const candidate = withoutThink.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (firstParseable === void 0) firstParseable = candidate;
      if (expectedKey !== void 0 && parsed !== null && typeof parsed === "object" && expectedKey in parsed) {
        return candidate;
      }
    } catch {
    }
    start = withoutThink.indexOf("{", end + 1);
  }
  return firstParseable;
}
var PROBE_TIMEOUT_MS = 1e4;
function isListed(model, listed) {
  return listed.has(model) || !model.includes(":") && listed.has(`${model}:latest`);
}
function networkErrorCode(error) {
  const cause = error?.cause;
  if (cause && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}
function modelIdsOf(body) {
  const data = body?.data;
  if (!Array.isArray(data)) return void 0;
  return data.flatMap((entry) => {
    const id = entry?.id;
    return typeof id === "string" ? [id] : [];
  });
}
async function probeEndpoint(custom, models, apiKey, fetchImpl = fetch) {
  const url = reduceBaseUrl(custom.baseUrl);
  const result = (status, detail, missingModels) => ({
    url,
    status,
    ...detail === void 0 ? {} : { detail: scrubUrls(redactSecrets(detail)) },
    ...missingModels === void 0 ? {} : { missingModels }
  });
  let response;
  try {
    response = await fetchImpl(endpointUrl(custom.baseUrl, "/models"), {
      method: "GET",
      headers: authHeaders(custom.keyHeader, apiKey),
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) return result("unreachable", `${url} did not answer within 10 seconds.`);
    if (isRedirectError(error)) return result("unreachable", `${url} ${REDIRECT_REASON}.`);
    return result("unreachable", `Cannot reach ${url} (${networkErrorCode(error)}).`);
  }
  if (response.status === 401 || response.status === 403) {
    return result("unreachable", `${url} refused the request (HTTP ${response.status}): check API Key and Key Header.`);
  }
  const noModelList = (why) => result("unknown", `${url} has no model list LocHub can read (GET /models ${why}).`);
  if (!response.ok) return noModelList(`answered HTTP ${response.status}`);
  let listedIds;
  try {
    listedIds = modelIdsOf(await response.json());
  } catch {
    listedIds = void 0;
  }
  if (!listedIds) return noModelList("returned no model list");
  const listed = new Set(listedIds);
  const missing = [...new Set(models)].filter((model) => !isListed(model, listed));
  if (missing.length === 0) return result("ok");
  return result("model_missing", `${url} does not list ${missing.join(", ")}.`, missing);
}

// src/contract.ts
var KIND_METADATA_KEY = "LocHub.Kind";
var BRIDGE_COMMANDS = ["OpenOrigin", "SetPreviewCulture", "ApplyLive"];
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
function keepAudit(cell) {
  return cell.qaFlags.filter((flag) => flag === "audit");
}
var EXPORTED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/i;
var IMPORT_OUTCOMES = ["changed", "approved", "changed_approved", "unchanged", "stale", "unknown", "empty", "conflict", "hard", "confirm"];

// src/ids.ts
import { createHash as createHash2 } from "node:crypto";
function unitIdOf(namespace, key) {
  return createHash2("sha256").update(JSON.stringify([namespace, key]), "utf8").digest("hex").slice(0, 16);
}
function textHash(text) {
  return createHash2("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}
function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/ueText.ts
var ESCAPE = "`";
function parsePattern(text) {
  const result = { args: [], modifiers: [], errors: [] };
  scanPattern(text, result, /* @__PURE__ */ new Set());
  return result;
}
function scanPattern(s, out, seen) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ESCAPE && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (c === "}") {
      out.errors.push(`Unmatched '}' at ${i}`);
      i++;
      continue;
    }
    if (c !== "{") {
      i++;
      continue;
    }
    const end = s.indexOf("}", i + 1);
    if (end < 0) {
      out.errors.push(`Unclosed '{' at ${i}`);
      return;
    }
    const name = s.slice(i + 1, end).trim();
    if (name.length === 0) {
      out.errors.push(`Empty argument at ${i}`);
    } else if (!seen.has(name)) {
      seen.add(name);
      out.args.push(name);
    }
    i = end + 1;
    if (s[i] !== "|") continue;
    const mod = readModifier(s, i + 1);
    if (!mod) {
      out.errors.push(`Malformed modifier after {${name}}`);
      return;
    }
    const parsed = parseModifier(name, mod.name, mod.body);
    out.modifiers.push(parsed);
    if (parsed.kind === "other") {
      out.errors.push(`Unreal does not recognize the modifier "|${parsed.name}(" on {${name}}; it will print as literal text, not be evaluated`);
    } else if (parsed.name !== parsed.kind) {
      out.errors.push(`Modifier names are case-sensitive in Unreal: "|${parsed.name}(" on {${name}} must be "|${parsed.kind}(", or it will print as literal text`);
    } else if (parsed.kind === "plural" || parsed.kind === "ordinal") {
      const empty = Object.entries(parsed.forms).filter(([, v]) => v === "").map(([k]) => k);
      if (empty.length > 0)
        out.errors.push(
          `|${parsed.kind} on {${name}} has an empty value for ${empty.map((k) => `"${k}"`).join(", ")}; Unreal fails to compile the whole modifier and prints it as literal text`
        );
    }
    for (const value of [...Object.values(parsed.forms), ...parsed.positional]) scanPattern(value, out, seen);
    i = mod.end;
  }
}
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
var OPEN_TAG = /<([\w.-]+)((?:\s+[\w.-]+="[^"]*")*)\s*(\/?)>/g;
function summarizeRichTags(text) {
  const names = [];
  let selfClosing = 0;
  for (const m of text.matchAll(OPEN_TAG)) {
    names.push(m[1]);
    if (m[3] === "/") selfClosing++;
  }
  const closers = text.split("</>").length - 1;
  return { names: names.sort(), closers, selfClosing };
}
function countRichTextTags(text) {
  let opening = 0;
  let closing = 0;
  let tagOpen = false;
  let tagLength = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<") {
      tagOpen = true;
      tagLength = 0;
    } else if (tagOpen) {
      if (c === ">") {
        if (text[i - 1] === "/") {
          if (tagLength === 1) closing++;
        } else if (!(tagLength === 2 && text[i - 2] === "b" && text[i - 1] === "r")) {
          opening++;
        }
        tagOpen = false;
      }
      tagLength++;
    }
  }
  return { opening, closing };
}
function richTextTagsBalanced(source, translation) {
  const tr = countRichTextTags(translation);
  if (tr.opening === tr.closing) return true;
  const src = countRichTextTags(source);
  return src.opening === tr.opening && src.closing === tr.closing;
}
function normalizeForCosmetic(s) {
  return s.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?…:;,]+$/u, "").trim();
}
function isCosmeticChange(before, after) {
  if (before === after) return false;
  if (normalizeForCosmetic(before) !== normalizeForCosmetic(after)) return false;
  if (parsePattern(before).args.join("\0") !== parsePattern(after).args.join("\0")) return false;
  return summarizeRichTags(before).names.join("|") === summarizeRichTags(after).names.join("|");
}

// src/lengthCheck.ts
var LENGTH_CHECK_OFF = { mode: "off", scope: "ui", ratio: 1.3, extra: 4, ratios: {}, hint: true };
var ESCAPABLE = /* @__PURE__ */ new Set(["`", "{", "}", "|"]);
var TAG = /<(?:\/|[\w.-]+(?:\s+[\w.-]+="[^"]*")*\s*\/?)>/y;
var NONSPACING_MARK = /^[\p{Mn}\p{Me}]$/u;
var ZERO_WIDTH = /^[\u200B\u200C\u200D\uFEFF]$/;
var WIDE = [
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
var ENTITIES = ["&amp;", "&lt;", "&gt;", "&quot;"];
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
function ratioFor(culture, config) {
  const entries = Object.entries(config.ratios);
  const find = (code) => entries.find(([key]) => key.toLowerCase() === code.toLowerCase())?.[1];
  return find(culture) ?? find(culture.split("-")[0]) ?? config.ratio;
}
function lengthLimitFor(unit, culture, config) {
  if (config.mode === "off") return null;
  if (config.scope === "ui" && unit.metadata[KIND_METADATA_KEY] !== "ui") return null;
  const length = visibleLength(unit.source);
  if (length === 0) return null;
  return Math.ceil(length * Math.round(ratioFor(culture, config) * 100) / 100) + config.extra;
}
function lengthArgsOf(config) {
  if (config.mode === "off") return "--length-check off";
  const ratios = Object.entries(config.ratios).map(([culture, ratio]) => `${culture}=${ratio.toFixed(2)}`);
  return [
    `--length-check ${config.mode}`,
    `--length-scope ${config.scope}`,
    `--length-ratio ${config.ratio.toFixed(2)}`,
    `--length-extra ${config.extra}`,
    ...ratios.length > 0 ? [`--length-ratios ${ratios.join(",")}`] : [],
    `--length-hint ${config.hint ? "on" : "off"}`
  ].join(" ");
}

// src/precheck.ts
var TOO_LONG_CODE = "too_long";
var PLURAL_CATEGORIES = /* @__PURE__ */ new Set(["zero", "one", "two", "few", "many", "other"]);
var PLURAL_FORM_NAME = /^[A-Za-z0-9_]+$/;
function pluralCategories(culture, type) {
  return [...new Intl.PluralRules(culture, { type }).resolvedOptions().pluralCategories];
}
function hasHardIssues(issues) {
  return issues.some((i) => i.severity === "hard");
}
function blocksAutoAccept(issues) {
  return issues.some((i) => i.severity !== "soft");
}
function confirmCodes(issues) {
  return [...new Set(issues.filter((i) => i.severity === "confirm").map((i) => i.code))];
}
function precheck(source, translation, culture, opts) {
  if (translation.trim().length === 0) return [{ code: "empty", severity: "hard", message: "Translation is empty" }];
  const issues = [];
  const src = parsePattern(source);
  const tr = parsePattern(translation);
  for (const error of tr.errors) issues.push({ code: "syntax", severity: "hard", message: error });
  const missing = src.args.filter((a) => !tr.args.includes(a));
  const extra = tr.args.filter((a) => !src.args.includes(a));
  if (missing.length > 0)
    issues.push({ code: "args_missing", severity: "confirm", message: `Missing arguments: ${missing.join(", ")}` });
  if (extra.length > 0)
    issues.push({ code: "args_extra", severity: "hard", message: `Unknown arguments: ${extra.join(", ")}` });
  const categoriesOf = opts.plurals ?? ((type) => pluralCategories(culture, type));
  for (const m of src.modifiers) {
    if (m.kind !== "plural" && m.kind !== "ordinal") continue;
    if (categoriesOf(m.kind === "plural" ? "cardinal" : "ordinal").length === 1) continue;
    if (!tr.modifiers.some((t) => t.arg === m.arg && t.kind === m.kind))
      issues.push({ code: "plural_dropped", severity: "confirm", message: `{${m.arg}} lost its |${m.kind}(...) modifier` });
  }
  for (const m of tr.modifiers) {
    if (m.kind !== "plural" && m.kind !== "ordinal") continue;
    const have = Object.keys(m.forms);
    const unreadable = have.filter((k) => !PLURAL_FORM_NAME.test(k));
    if (unreadable.length > 0) {
      issues.push({
        code: "syntax",
        severity: "hard",
        message: `|${m.kind} on {${m.arg}} has form names Unreal cannot read: ${unreadable.map((k) => `"${k}"`).join(", ")}`
      });
      continue;
    }
    const required = categoriesOf(m.kind === "plural" ? "cardinal" : "ordinal");
    if (required.length === 1) {
      issues.push({
        code: "plural_redundant",
        severity: "hard",
        message: `{${m.arg}}|${m.kind} is not allowed in ${culture}: it has a single plural form \u2014 write the argument without the modifier`
      });
      continue;
    }
    const unknown = have.filter((k) => !PLURAL_CATEGORIES.has(k));
    const absent = required.filter((k) => !have.includes(k));
    const unused = have.filter((k) => PLURAL_CATEGORIES.has(k) && !required.includes(k));
    if (unknown.length > 0)
      issues.push({
        code: "plural_unknown_form",
        severity: "confirm",
        message: `|${m.kind} on {${m.arg}} has forms Unreal ignores: ${unknown.join(", ")}`
      });
    if (absent.length > 0)
      issues.push({
        code: "plural_forms_missing",
        severity: "hard",
        message: `|${m.kind} on {${m.arg}} is missing forms required by ${culture}: ${absent.join(", ")}`
      });
    if (unused.length > 0)
      issues.push({
        code: "plural_form_unused",
        severity: "hard",
        message: `|${m.kind} on {${m.arg}} has forms ${culture} does not use: ${unused.join(", ")} (it uses ${required.join(", ")})`
      });
  }
  const srcTags = summarizeRichTags(source);
  const trTags = summarizeRichTags(translation);
  if (srcTags.names.join("|") !== trTags.names.join("|") || srcTags.closers !== trTags.closers)
    issues.push({
      code: "rich_tags",
      severity: "confirm",
      message: `Rich text tags differ: source [${srcTags.names.join(", ")}], translation [${trTags.names.join(", ")}]`
    });
  if (!richTextTagsBalanced(source, translation)) {
    const { opening, closing } = countRichTextTags(translation);
    issues.push({
      code: "rich_tags_unbalanced",
      severity: "hard",
      message: `Rich text tags are not balanced: ${opening} opening tag(s) but ${closing} closing '</>'`
    });
  }
  for (const term of opts.dntTerms) {
    if (source.includes(term) && !translation.includes(term))
      issues.push({ code: "dnt", severity: "confirm", message: `Do-not-translate term "${term}" must stay verbatim` });
  }
  const withoutDnt = opts.dntTerms.reduce((acc, t) => acc.split(t).join(""), source);
  if (translation.trim() === source.trim() && new RegExp("\\p{L}{3,}", "u").test(withoutDnt))
    issues.push({ code: "untranslated", severity: "soft", message: "Translation is identical to the source" });
  if (opts.length) {
    const length = visibleLength(translation);
    if (length > opts.length.limit)
      issues.push({
        code: TOO_LONG_CODE,
        severity: opts.length.severity,
        message: `Too long for the UI: ${length}/${opts.length.limit} characters (Length Check in Project Settings)`
      });
  }
  return issues;
}

// src/triage.ts
function bandFor(input) {
  if (input.refused || blocksAutoAccept(input.precheck) || input.judge.some((j) => j.severity !== "minor")) return "R";
  if (input.ambiguity === "guessed") return input.unit.metadata[KIND_METADATA_KEY] === "ui" ? "R" : "Y";
  if (input.ambiguity === "context" || input.judge.length > 0 || input.precheck.length > 0) return "Y";
  return "G";
}
function isAuditSample(unitId, culture, percent) {
  return parseInt(textHash(`${unitId}|${culture}|audit`).slice(0, 8), 16) % 100 < percent;
}

// src/cells.ts
var CellActionError = class extends Error {
  constructor(message, statusCode = 422, issues = []) {
    super(message);
    this.statusCode = statusCode;
    this.issues = issues;
    this.name = "CellActionError";
  }
};
var StaleCellError = class extends Error {
  constructor(cell, unit) {
    super("This string changed since you opened it (new source text or a newer translation). Review it again.");
    this.cell = cell;
    this.unit = unit;
    this.name = "StaleCellError";
  }
};
function checkFresh(unit, cell, expected) {
  if (!expected) return;
  if (expected.revision !== void 0 && expected.revision !== cell.revision) throw new StaleCellError(cell, unit);
  if (expected.sourceRev !== void 0 && expected.sourceRev !== unit.sourceRev) throw new StaleCellError(cell, unit);
}
function dntTermsOf(store, culture) {
  return (store.glossary.get(culture) ?? []).filter((t) => t.dnt).map((t) => t.term);
}
function requireUnit(store, unitId) {
  const unit = store.units.get(unitId);
  if (!unit || unit.state !== "active") throw new CellActionError(`Unknown unit ${unitId}`, 404);
  return unit;
}
function precheckOptionsFor(store, culture, unit, lengthCheck) {
  const options = { dntTerms: dntTermsOf(store, culture), plurals: (type) => store.pluralCategoriesFor(culture, type) };
  const limit = lengthLimitFor(unit, culture, lengthCheck);
  if (limit !== null) options.length = { limit, severity: lengthCheck.mode === "confirm" ? "confirm" : "soft" };
  return options;
}
function checkTranslation(store, culture, unit, text, lengthCheck) {
  return precheck(unit.source, text, culture, precheckOptionsFor(store, culture, unit, lengthCheck));
}
function checkCell(store, culture, unitId, text, lengthCheck = LENGTH_CHECK_OFF) {
  return checkTranslation(store, culture, requireUnit(store, unitId), text, lengthCheck);
}
function checkOrThrow(store, culture, unit, text, accept, lengthCheck) {
  const issues = checkTranslation(store, culture, unit, text, lengthCheck);
  if (hasHardIssues(issues)) throw new CellActionError("Translation fails the format check", 422, issues);
  const accepted = confirmCodes(issues);
  const unconfirmed = accepted.filter((code) => !accept.includes(code));
  if (unconfirmed.length > 0) throw new CellActionError(`Confirm these warnings to go ahead anyway: ${unconfirmed.join(", ")}`, 422, issues);
  return { issues, accepted };
}
function commit(store, before, after, action, actor, accepted = []) {
  store.putCell(after);
  store.appendEvent({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    unitId: after.unitId,
    culture: after.culture,
    action,
    actor,
    before: before.text,
    after: after.text,
    ...accepted.length > 0 ? { accepted: [...accepted] } : {}
  });
  return after;
}
function approvedCell(unit, cell) {
  return { ...cell, status: "approved", basedOnSourceRev: unit.sourceRev, basedOnSource: unit.source, qaFlags: keepAudit(cell), revision: cell.revision + 1 };
}
function editedCell(unit, cell, text, actor) {
  return {
    ...cell,
    text,
    status: "edited",
    basedOnSourceRev: unit.sourceRev,
    basedOnSource: unit.source,
    provenance: `human:${actor}`,
    ambiguity: "none",
    alts: [],
    question: "",
    note: "",
    suggestion: "",
    judgeIssues: [],
    qaFlags: keepAudit(cell),
    revision: cell.revision + 1
  };
}
function approveCell(store, culture, unitId, actor, expected, accept = [], lengthCheck = LENGTH_CHECK_OFF) {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  if (cell.text.length === 0) throw new CellActionError("Nothing to approve");
  const { accepted } = checkOrThrow(store, culture, unit, cell.text, accept, lengthCheck);
  return commit(store, cell, approvedCell(unit, cell), "approve", actor, accepted);
}
function editCell(store, culture, unitId, text, actor, expected, accept = [], lengthCheck = LENGTH_CHECK_OFF) {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  const { issues, accepted } = checkOrThrow(store, culture, unit, text, accept, lengthCheck);
  const band = bandFor({ unit, ambiguity: "none", precheck: issues, judge: [], refused: false });
  return commit(store, cell, { ...editedCell(unit, cell, text, actor), band }, "edit", actor, accepted);
}
function rejectCell(store, culture, unitId, note, actor, expected) {
  const unit = requireUnit(store, unitId);
  const cell = store.getCell(culture, unitId);
  checkFresh(unit, cell, expected);
  return commit(store, cell, { ...cell, status: "rejected", note, revision: cell.revision + 1 }, "reject", actor);
}
var EXPORTABLE = {
  validated: /* @__PURE__ */ new Set(["ai_draft", "approved", "edited", "human_edit"]),
  approved_only: /* @__PURE__ */ new Set(["approved", "edited", "human_edit"])
};
function exportForPull(store, culture, policy) {
  const out = [];
  for (const unit of store.units.values()) {
    if (unit.state !== "active") continue;
    const cell = store.getCell(culture, unit.id);
    if (!EXPORTABLE[policy].has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    out.push({ unitId: unit.id, namespace: unit.namespace, key: unit.key, source: unit.source, translation: cell.text });
  }
  return out.sort((a, b) => compareCodeUnits(a.unitId, b.unitId));
}
function applyExportAck(store, ack) {
  const cells = store.cellsFor(ack.culture);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const written of ack.written) {
    const cell = cells.get(written.unitId);
    if (!cell) continue;
    const hash = textHash(written.translation);
    if (cell.archiveHash !== hash) {
      store.appendEvent({ ts: now, unitId: written.unitId, culture: ack.culture, action: "exported", actor: "engine", before: cell.text, after: written.translation });
    }
    store.putCell({ ...cell, archiveHash: hash });
  }
  for (const rejected of ack.rejected) {
    const cell = cells.get(rejected.unitId);
    if (!cell || rejected.translation !== cell.text) continue;
    store.putCell({
      ...cell,
      status: "needs_fix",
      band: "R",
      qaFlags: [.../* @__PURE__ */ new Set([...cell.qaFlags, "engine_rejected"])],
      question: rejected.errors.join("; "),
      revision: cell.revision + 1
    });
    store.appendEvent({ ts: now, unitId: rejected.unitId, culture: ack.culture, action: "engine_rejected", actor: "engine", before: cell.text, after: cell.text });
  }
}

// src/grouping.ts
var UNGROUPED = "(ungrouped)";
function needsWork(unit, cell) {
  if (unit.state !== "active") return false;
  if (cell.status === "empty" || cell.status === "rejected" || cell.status === "needs_fix") return true;
  return isOutdated(unit, cell);
}
function selectWork(store, culture, filter) {
  const ids = filter?.unitIds ? new Set(filter.unitIds) : void 0;
  const out = [];
  for (const unit of store.units.values()) {
    if (ids && !ids.has(unit.id)) continue;
    if (filter?.groupKey !== void 0 && unit.groupKey !== filter.groupKey) continue;
    if (filter?.groupPrefix !== void 0 && !unit.groupKey.startsWith(filter.groupPrefix)) continue;
    const cell = store.getCell(culture, unit.id);
    if (needsWork(unit, cell)) out.push({ unit, cell });
  }
  return out.sort((a, b) => compareCodeUnits(a.unit.id, b.unit.id));
}
var NEIGHBOR_STATUSES = /* @__PURE__ */ new Set(["ai_draft", "approved", "edited", "human_edit"]);
function neighborsOf(store, culture, groupKey, exclude, max) {
  const out = [];
  const units = [...store.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const unit of units) {
    if (out.length >= max) break;
    if (unit.state !== "active" || unit.groupKey !== groupKey || exclude.has(unit.id)) continue;
    const cell = store.getCell(culture, unit.id);
    if (!NEIGHBOR_STATUSES.has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    out.push({ source: unit.source, translation: cell.text });
  }
  return out;
}
function buildGroups(items, maxSize) {
  const byKey = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.unit.groupKey || UNGROUPED;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  const groups = [];
  for (const key of [...byKey.keys()].sort(compareCodeUnits)) {
    const list = byKey.get(key).sort((a, b) => compareCodeUnits(a.unit.id, b.unit.id));
    for (let i = 0; i < list.length; i += maxSize) groups.push({ groupKey: key, items: list.slice(i, i + maxSize) });
  }
  return groups;
}

// src/llm.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { Anthropic } from "../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs";
function requestId(params) {
  return createHash3("sha256").update(canonicalJson(params), "utf8").digest("hex");
}
function outcomeFromMessage(customId, message) {
  if (message.stop_reason === "refusal") return { customId, kind: "refusal" };
  if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
    return { customId, kind: "error", message: "max_tokens", retryable: true };
  }
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  return { customId, kind: "ok", text, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}
function isRetryableError(error) {
  const raw = error?.status;
  const status = typeof raw === "number" ? raw : void 0;
  return status === void 0 || status === 408 || status === 409 || status === 429 || status >= 500;
}
function errorOutcome(customId, error) {
  return { customId, kind: "error", message: error instanceof Error ? error.message : String(error), retryable: isRetryableError(error) };
}
var sleep2 = (ms) => new Promise((resolve4) => setTimeout(resolve4, ms));
var FINAL_BATCH_ERRORS = /* @__PURE__ */ new Set(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "billing_error"]);
var MAX_RETRIEVE_FAILURES = 10;
var MAX_BACKOFF_MS = 6e4;
function batchKey(customIds) {
  return createHash3("sha256").update([...customIds].sort().join("\n"), "utf8").digest("hex");
}
function writeFileAtomic2(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync2(tmp, content, "utf8");
  renameSync2(tmp, path);
}
var LocHubAnthropic = class extends Anthropic {
  constructor(options) {
    super(options);
    this._options.defaultHeaders = options?.defaultHeaders;
  }
  _shouldResolveDefaultCredentials() {
    return false;
  }
};
var AnthropicLlmClient = class {
  client;
  batchDir;
  // False only when there is truly no key to authenticate with: every call is refused locally, without
  // ever reaching the SDK/network (I-1 -- an ungated caller, not just an ungated route, must never make a
  // billed or credentialed call on LocHub's behalf with no key configured).
  hasKey;
  constructor(options = {}) {
    this.client = options.client ?? new LocHubAnthropic({ apiKey: options.apiKey || null, authToken: null, baseURL: "https://api.anthropic.com" });
    this.hasKey = options.client !== void 0 || !!options.apiKey;
    this.batchDir = options.batchDir;
  }
  // Ignores LlmClient.runSync's shouldContinue (see there): the SDK retries its own timeouts and reports none the
  // job probes on.
  async runSync(requests, concurrency, onOutcome) {
    if (!this.hasKey) {
      const out2 = requests.map((r) => ({ customId: r.customId, kind: "error", message: `Anthropic: ${MISSING_KEY_MESSAGE}`, retryable: false }));
      out2.forEach((outcome) => onOutcome?.(outcome));
      return out2;
    }
    const out = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const index = next++;
        const request = requests[index];
        let outcome;
        try {
          outcome = outcomeFromMessage(request.customId, await this.client.messages.create(request.params));
        } catch (error) {
          outcome = errorOutcome(request.customId, error);
        }
        out[index] = outcome;
        onOutcome?.(outcome);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, requests.length)) }, worker));
    return out;
  }
  async runBatch(requests, pollMs, onProgress) {
    if (requests.length === 0) return [];
    if (!this.hasKey) throw new Error(MISSING_KEY_MESSAGE);
    const file = this.batchDir ? join2(this.batchDir, `${batchKey(requests.map((r) => r.customId))}.json`) : void 0;
    let resumed = file !== void 0 && existsSync2(file);
    let batchId;
    let status;
    if (resumed) {
      batchId = JSON.parse(readFileSync2(file, "utf8")).batchId;
      status = "in_progress";
    } else {
      ({ batchId, status } = await this.createBatch(requests, file));
    }
    let waitMs = pollMs;
    let failures = 0;
    const byId = /* @__PURE__ */ new Map();
    for (; ; ) {
      try {
        while (status !== "ended") {
          await sleep2(waitMs);
          const retrieved = await this.client.messages.batches.retrieve(batchId);
          status = retrieved.processing_status;
          const counts = retrieved.request_counts;
          onProgress?.(counts.succeeded, requests.length);
          failures = 0;
          waitMs = pollMs;
        }
        for await (const entry of await this.client.messages.batches.results(batchId)) {
          const result = entry.result;
          if (result.type === "succeeded") {
            byId.set(entry.custom_id, outcomeFromMessage(entry.custom_id, result.message));
          } else if (result.type === "errored") {
            const apiError = result.error.error;
            byId.set(entry.custom_id, {
              customId: entry.custom_id,
              kind: "error",
              message: `${apiError.type}: ${apiError.message}`,
              retryable: !FINAL_BATCH_ERRORS.has(apiError.type)
            });
          } else {
            byId.set(entry.custom_id, { customId: entry.custom_id, kind: "error", message: result.type, retryable: true });
          }
        }
        break;
      } catch (error) {
        if (!isRetryableError(error)) {
          if (file && existsSync2(file)) unlinkSync2(file);
          if (!resumed) throw error;
          resumed = false;
          byId.clear();
          ({ batchId, status } = await this.createBatch(requests, file));
          failures = 0;
          waitMs = pollMs;
          continue;
        }
        failures++;
        if (failures >= MAX_RETRIEVE_FAILURES) throw error;
        waitMs = Math.min(Math.max(MAX_BACKOFF_MS, pollMs), waitMs * 2);
        if (status === "ended") await sleep2(waitMs);
      }
    }
    if (file && existsSync2(file)) unlinkSync2(file);
    return requests.map((r) => byId.get(r.customId) ?? { customId: r.customId, kind: "error", message: "missing_result", retryable: true });
  }
  async createBatch(requests, file) {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({ custom_id: r.customId, params: r.params }))
    });
    if (file) {
      mkdirSync2(this.batchDir, { recursive: true });
      const descriptor = { batchId: batch.id, customIds: requests.map((r) => r.customId), createdAt: (/* @__PURE__ */ new Date()).toISOString() };
      writeFileAtomic2(file, JSON.stringify(descriptor));
    }
    return { batchId: batch.id, status: batch.processing_status };
  }
  async countInputTokens(params) {
    if (!this.hasKey) throw new Error(MISSING_KEY_MESSAGE);
    const counted = await this.client.messages.countTokens({ model: params.model, system: params.system, messages: params.messages });
    return counted.input_tokens;
  }
};

// src/memory.ts
var TM_STATUSES = /* @__PURE__ */ new Set(["approved", "edited", "human_edit"]);
function buildTmIndex(store, culture) {
  const index = /* @__PURE__ */ new Map();
  const units = [...store.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const unit of units) {
    if (unit.state !== "active" || index.has(unit.source)) continue;
    const cell = store.getCell(culture, unit.id);
    if (!TM_STATUSES.has(cell.status) || cell.text.length === 0 || isOutdated(unit, cell)) continue;
    index.set(unit.source, { text: cell.text, donorId: unit.id });
  }
  return index;
}
function recordQuestion(store, culture, unitId, question, askedBy, now) {
  const text = question.trim();
  if (text.length === 0) return void 0;
  const id = textHash(`${unitId}|${culture}|${text}`);
  const existing = store.inbox.get(id);
  if (existing) return existing;
  const item = { id, unitId, culture, question: text, askedBy, status: "open", answer: "", created: now, answered: "" };
  store.inbox.set(id, item);
  return item;
}
function requireItem(store, id) {
  const item = store.inbox.get(id);
  if (!item) throw new CellActionError(`Unknown inbox item ${id}`, 404);
  return item;
}
function answerQuestion(store, id, answer, now) {
  const item = requireItem(store, id);
  const text = answer.trim();
  if (text.length === 0) throw new CellActionError("Answer is empty");
  const next = { ...item, status: "answered", answer: text, answered: now };
  store.inbox.set(id, next);
  return next;
}
function dismissQuestion(store, id) {
  const next = { ...requireItem(store, id), status: "dismissed" };
  store.inbox.set(id, next);
  return next;
}
function markApplied(store, ids) {
  let count = 0;
  for (const id of ids) {
    const item = store.inbox.get(id);
    if (!item || item.status !== "answered") continue;
    store.inbox.set(id, { ...item, status: "applied" });
    count++;
  }
  return count;
}
function singleLine(text) {
  return text.replace(/\r\n|\r|\n/g, " ").trim();
}
function answerLine(item) {
  return `Q: ${singleLine(item.question)} A: ${singleLine(item.answer)}`;
}
function reachedDevNotes(store, item) {
  const devNotes = store.units.get(item.unitId)?.devNotes ?? "";
  const line = answerLine(item);
  return devNotes.split(/\r\n|\r|\n/).some((l) => l.trim() === line);
}
function answersByUnit(store) {
  const out = /* @__PURE__ */ new Map();
  const items = [...store.inbox.values()].filter((i) => i.status === "answered" || i.status === "applied" && !reachedDevNotes(store, i)).sort((a, b) => compareCodeUnits(a.id, b.id));
  for (const item of items) {
    const list = out.get(item.unitId) ?? [];
    list.push(answerLine(item));
    out.set(item.unitId, list);
  }
  return out;
}

// src/prompt.ts
var PROMPT_VERSION = "translate-v2";
var TRANSLATE_RULES = [
  "You translate video game strings from English into the target culture for an Unreal Engine 5 game.",
  "Hard rules:",
  "- Keep every {Argument} exactly as written: same names, same case. Never translate argument names.",
  "- Keep format modifiers {Arg}|plural(...), {Arg}|ordinal(...), {Arg}|gender(...), {Arg}|hpp(...).",
  "  Inside plural and ordinal use the CLDR categories of the target culture and write every required category.",
  "  When the target culture has a single plural (or ordinal) category, the engine rejects the modifier: write the",
  "  argument plainly, with no |plural(...) or |ordinal(...), even when the source has one.",
  "  You may add |plural(...) to an existing numeric argument when the target culture needs more than one category.",
  "- The backtick is an escape character: `{ `} `| and `` must stay exactly as written.",
  '- Keep rich text tags exactly: <Style>text</> and self-closing <img id="..."/>; keep the entities &quot; &lt; &gt; &amp;.',
  "- Keep leading and trailing spaces and line breaks. Keep ALL CAPS when the source is ALL CAPS.",
  "- Glossary terms marked DNT stay verbatim; other glossary terms use the given translation, inflected as grammar requires.",
  "- The strings of one request belong together (same asset, screen or quest): keep terminology and tone consistent.",
  "Per item:",
  "- ambiguity = none when the meaning is clear, context when the given context decided between readings, guessed when you had to guess.",
  "- When ambiguity is guessed, put up to 3 alternative translations into alts and a short question for the developer into question.",
  "- Otherwise alts is an empty array and question is an empty string.",
  "- terms_used lists the glossary terms you applied.",
  "- If an item has prev_source and prev (an earlier source and its translation), make the minimal edit of prev that matches the new source.",
  "- If an item has reviewer_note or answers, follow them: they come from the developers.",
  "- If an item has rejected_translation, a reviewer rejected that text: return a different translation.",
  "- neighbors are already translated strings of the same screen or asset: stay consistent with them.",
  "- If an item has previous_attempt and errors, return a corrected translation that fixes every listed error.",
  "- If an item has maxLength, keep the translation within maxLength visible characters: placeholders and tags count 0, CJK characters count 2. Prefer a natural shorter wording over abbreviations.",
  "Return exactly one result per input id."
].join("\n");
var JUDGE_RULES = [
  "You review translations of video game strings from English into the target culture.",
  "Report only real problems: wrong meaning, wrong or inconsistent terminology against the glossary,",
  "ungrammatical or unnatural target text, wrong tone or register against the style guide, broken locale conventions.",
  "severity: critical = misleads the player or is offensive; major = wrong meaning or clearly wrong grammar;",
  "minor = wording a native speaker would improve.",
  "Do not report placeholders, format modifiers or markup: code checks them.",
  "For each issue give the full corrected translation in fix. Return an empty issues array when everything is fine."
].join("\n");
var TRANSLATE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          translation: { type: "string" },
          ambiguity: { type: "string", enum: ["none", "context", "guessed"] },
          alts: { type: "array", items: { type: "string" } },
          question: { type: "string" },
          terms_used: { type: "array", items: { type: "string" } }
        },
        required: ["id", "translation", "ambiguity", "alts", "question", "terms_used"],
        additionalProperties: false
      }
    }
  },
  required: ["items"],
  additionalProperties: false
};
var JUDGE_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["minor", "major", "critical"] },
          category: { type: "string" },
          why: { type: "string" },
          fix: { type: "string" }
        },
        required: ["id", "severity", "category", "why", "fix"],
        additionalProperties: false
      }
    }
  },
  required: ["issues"],
  additionalProperties: false
};
function buildCultureBlock(ctx) {
  const glossary = ctx.glossary.length === 0 ? "(empty)" : ctx.glossary.map((t) => t.dnt ? `- ${t.term} => DNT (keep verbatim)` : `- ${t.term} => ${t.translation}${t.note ? ` (${t.note})` : ""}`).join("\n");
  return [
    `Target culture: ${ctx.culture}`,
    `Plural categories (cardinal): ${(ctx.plurals?.cardinal ?? pluralCategories(ctx.culture, "cardinal")).join(", ")}`,
    `Plural categories (ordinal): ${(ctx.plurals?.ordinal ?? pluralCategories(ctx.culture, "ordinal")).join(", ")}`,
    "",
    "Project brief:",
    ctx.brief || "(none)",
    "",
    "Style guide:",
    ctx.style || "(none)",
    "",
    "Glossary:",
    glossary
  ].join("\n");
}
function systemBlocks(rules, ctx) {
  return [
    { type: "text", text: rules },
    { type: "text", text: buildCultureBlock(ctx), cache_control: { type: "ephemeral", ttl: "1h" } }
  ];
}
function buildTranslateParams(ctx, group, model, extras = {}) {
  const { repair, neighbors = [], answers, maxLength } = extras;
  const items = group.items.map(({ unit, cell }) => {
    const item = {
      id: unit.id,
      source: unit.source,
      origin: unit.origin,
      dev_notes: unit.devNotes,
      args: parsePattern(unit.source).args
    };
    if (Object.keys(unit.metadata).length > 0) item.metadata = unit.metadata;
    if (isOutdated(unit, cell)) {
      item.prev_source = cell.basedOnSource;
      item.prev = cell.text;
    }
    if (cell.status === "rejected" && cell.note) item.reviewer_note = cell.note;
    if (cell.status === "needs_fix" && cell.question) item.reviewer_note = cell.question;
    if (cell.status === "rejected" && cell.text) item.rejected_translation = cell.text;
    const unitAnswers = answers?.get(unit.id);
    if (unitAnswers && unitAnswers.length > 0) item.answers = unitAnswers;
    const fix = repair?.get(unit.id);
    if (fix) {
      item.previous_attempt = fix.previous;
      item.errors = fix.errors;
    }
    const limit = maxLength?.get(unit.id);
    if (limit !== void 0) item.maxLength = limit;
    return item;
  });
  const body = { group: group.groupKey };
  if (neighbors.length > 0) body.neighbors = neighbors;
  body.items = items;
  return {
    model,
    max_tokens: 16e3,
    system: systemBlocks(TRANSLATE_RULES, ctx),
    messages: [{ role: "user", content: canonicalJson(body) }],
    output_config: { effort: "low", format: { type: "json_schema", schema: TRANSLATE_SCHEMA } }
  };
}
function buildJudgeParams(ctx, group, translations, model) {
  const items = group.items.filter(({ unit }) => translations.has(unit.id)).map(({ unit }) => ({ id: unit.id, source: unit.source, translation: translations.get(unit.id), dev_notes: unit.devNotes, origin: unit.origin }));
  return {
    model,
    max_tokens: 16e3,
    system: systemBlocks(JUDGE_RULES, ctx),
    messages: [{ role: "user", content: canonicalJson({ group: group.groupKey, items }) }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: JUDGE_SCHEMA } }
  };
}

// src/job.ts
var DEFAULT_JOB_OPTIONS = {
  mode: "sync",
  translateModel: "claude-opus-5-5",
  judgeModel: "claude-sonnet-5",
  brief: "",
  groupSize: 40,
  concurrency: 8,
  pollMs: 6e4,
  maxRepairRounds: 2,
  auditPercent: 4,
  actor: "ai",
  lengthCheck: LENGTH_CHECK_OFF
};
var MAX_NEIGHBORS = 20;
var AMBIGUITIES = ["none", "context", "guessed"];
var SEVERITIES = ["minor", "major", "critical"];
var MAX_TRANSLATE_ATTEMPTS = 4;
var MAX_ERROR_SAMPLES = 3;
var MAX_ERROR_SAMPLE_LENGTH = 300;
var SHORTEN_INSTRUCTION = "Shorten it while keeping the meaning, every placeholder and every tag.";
function cultureContext(store, culture, brief) {
  return {
    culture,
    brief,
    style: store.style.get(culture) ?? "",
    glossary: store.glossary.get(culture) ?? [],
    plurals: { cardinal: store.pluralCategoriesFor(culture, "cardinal"), ordinal: store.pluralCategoriesFor(culture, "ordinal") }
  };
}
function planWork(store, opts) {
  const tm = buildTmIndex(store, opts.culture);
  const tmHits = [];
  const rest = [];
  for (const item of selectWork(store, opts.culture, opts.filter)) {
    const eligible = item.cell.status !== "rejected" && item.cell.status !== "needs_fix";
    const match = eligible ? tm.get(item.unit.source) : void 0;
    const issues = match ? precheck(item.unit.source, match.text, opts.culture, precheckOptionsFor(store, opts.culture, item.unit, opts.lengthCheck)) : void 0;
    const reusable = match !== void 0 && match.donorId !== item.unit.id && !blocksAutoAccept(issues);
    if (reusable) tmHits.push({ item, match, issues });
    else rest.push(item);
  }
  return { ctx: cultureContext(store, opts.culture, opts.brief), tmHits, groups: buildGroups(rest, opts.groupSize) };
}
function bypassesCache(group) {
  return group.items.some((w) => w.cell.status === "needs_fix" || w.cell.status === "rejected");
}
function translateParamsFor(store, ctx, group, opts, repair) {
  const exclude = new Set(group.items.map((w) => w.unit.id));
  return buildTranslateParams(ctx, group, opts.translateModel, {
    repair,
    neighbors: neighborsOf(store, opts.culture, group.groupKey, exclude, MAX_NEIGHBORS),
    answers: answersByUnit(store),
    maxLength: promptLimits(group, opts)
  });
}
function promptLimits(group, opts) {
  const limits = /* @__PURE__ */ new Map();
  if (!opts.lengthCheck.hint) return limits;
  for (const { unit } of group.items) {
    const limit = lengthLimitFor(unit, opts.culture, opts.lengthCheck);
    if (limit !== null) limits.set(unit.id, limit);
  }
  return limits;
}
function repairMessage(issue) {
  return issue.code === TOO_LONG_CODE ? `${issue.message}. ${SHORTEN_INSTRUCTION}` : issue.message;
}
function parseTranslatedItems(text, group) {
  const wanted = new Set(group.items.map((w) => w.unit.id));
  const items = /* @__PURE__ */ new Map();
  for (const entry of listField(text, "items")) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!wanted.has(id) || items.has(id) || typeof entry.translation !== "string") continue;
    items.set(id, {
      translation: entry.translation,
      ambiguity: AMBIGUITIES.includes(entry.ambiguity) ? entry.ambiguity : "guessed",
      alts: Array.isArray(entry.alts) ? entry.alts.filter((a) => typeof a === "string").slice(0, 3) : [],
      question: typeof entry.question === "string" ? entry.question : ""
    });
  }
  return { items, missing: group.items.filter((w) => !items.has(w.unit.id)) };
}
function parseJudgeIssues(text, ids) {
  if (!isObjectWithArray(text, "issues")) return void 0;
  const out = /* @__PURE__ */ new Map();
  for (const entry of listField(text, "issues")) {
    const id = typeof entry.id === "string" ? entry.id : "";
    if (!ids.has(id) || !SEVERITIES.includes(entry.severity)) continue;
    const list = out.get(id) ?? [];
    list.push({
      severity: entry.severity,
      category: String(entry.category ?? ""),
      why: String(entry.why ?? ""),
      fix: String(entry.fix ?? "")
    });
    out.set(id, list);
  }
  return out;
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isObjectWithArray(text, field) {
  const value = parseJson(text);
  return value !== null && typeof value === "object" && Array.isArray(value[field]);
}
function listField(text, field) {
  if (!isObjectWithArray(text, field)) return [];
  const list = parseJson(text)[field];
  return list.filter((e) => e !== null && typeof e === "object");
}
function splitGroup(group) {
  const middle = Math.ceil(group.items.length / 2);
  return [
    { groupKey: group.groupKey, items: group.items.slice(0, middle) },
    { groupKey: group.groupKey, items: group.items.slice(middle) }
  ];
}
function capGroup(group, max) {
  const count = group.items.length;
  if (count <= max) return [group];
  const pieces = Math.ceil(count / max);
  return Array.from({ length: pieces }, (_, i) => ({
    groupKey: group.groupKey,
    items: group.items.slice(Math.floor(i * count / pieces), Math.floor((i + 1) * count / pieces))
  }));
}
function isTimeoutOutcome(outcome) {
  return outcome.kind === "error" && isTimeoutMessage(outcome.message);
}
function toRequest(params) {
  return { customId: requestId(params), params };
}
function translateSettledIds(outcome, group, parsed) {
  if (outcome.kind === "skipped") return [];
  if (outcome.kind === "ok") return [...(parsed ?? parseTranslatedItems(outcome.text, group)).items.keys()];
  if (outcome.kind === "refusal" || outcome.kind === "error" && (outcome.message === "max_tokens" || isTimeoutMessage(outcome.message)))
    return group.items.length > 1 ? [] : [group.items[0].unit.id];
  if (outcome.kind === "error" && outcome.retryable) return [];
  return group.items.map((w) => w.unit.id);
}
async function runTranslateJob(store, llm, cache, opts) {
  const culture = opts.culture;
  const plan = planWork(store, opts);
  const ctx = plan.ctx;
  const work = plan.groups.flatMap((g) => g.items);
  const report = {
    culture,
    requested: work.length + plan.tmHits.length,
    tm: 0,
    written: 0,
    suggestions: 0,
    needsFix: 0,
    refused: 0,
    errors: 0,
    questions: 0,
    bands: { R: 0, Y: 0, G: 0 },
    inputTokens: 0,
    outputTokens: 0,
    errorSamples: []
  };
  if (report.requested === 0) return report;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  store.assertFresh();
  for (const { item, match, issues } of plan.tmHits) {
    const cell = store.getCell(culture, item.unit.id);
    const tooLong2 = issues.some((i) => i.code === TOO_LONG_CODE);
    store.putCell({
      ...cell,
      text: match.text,
      status: "ai_draft",
      basedOnSourceRev: item.unit.sourceRev,
      basedOnSource: item.unit.source,
      provenance: `tm:${match.donorId}`,
      ambiguity: "none",
      alts: [],
      question: "",
      note: "",
      suggestion: "",
      judgeIssues: [],
      qaFlags: [...keepAudit(cell), "tm", ...tooLong2 ? [TOO_LONG_CODE] : []],
      band: tooLong2 ? "Y" : "G",
      revision: cell.revision + 1
    });
    store.appendEvent({ ts: now, unitId: item.unit.id, culture, action: "tm", actor: opts.actor, before: cell.text, after: match.text });
    report.tm++;
    report.bands[tooLong2 ? "Y" : "G"]++;
  }
  if (plan.tmHits.length > 0) store.save();
  if (work.length === 0) {
    store.save();
    return report;
  }
  const byId = new Map(work.map((w) => [w.unit.id, w]));
  const startRevision = new Map(work.map((w) => [w.unit.id, w.cell.revision]));
  const results = /* @__PURE__ */ new Map();
  const failed = /* @__PURE__ */ new Map();
  const errorMessages = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  const resolve4 = async (requests, onOutcome, onBatchProgress, shouldContinue) => {
    const outcomes = await resolveWithCache(llm, cache, requests, {
      mode: opts.mode,
      concurrency: opts.concurrency,
      pollMs: opts.pollMs,
      fresh: seen,
      onOutcome,
      onBatchProgress,
      shouldContinue
    });
    for (const r of requests) if (outcomes.get(r.customId)?.kind !== "skipped") seen.add(r.customId);
    for (const o of outcomes.values()) {
      if (o.kind !== "ok") continue;
      report.inputTokens += o.inputTokens;
      report.outputTokens += o.outputTokens;
    }
    return outcomes;
  };
  const onProgress = opts.onProgress;
  const translateTotal = work.length;
  const translateSettled = /* @__PURE__ */ new Set();
  let translateHighWater = 0;
  const reportTranslate = (done) => {
    translateHighWater = Math.max(translateHighWater, Math.min(done, translateTotal));
    onProgress?.({ phase: "translate", done: translateHighWater, total: translateTotal });
  };
  const markTranslateSettled = (ids) => {
    let changed = false;
    for (const id of ids) if (!translateSettled.has(id)) {
      translateSettled.add(id);
      changed = true;
    }
    if (changed) reportTranslate(translateSettled.size);
  };
  reportTranslate(0);
  const maxTranslateRounds = MAX_TRANSLATE_ATTEMPTS + Math.ceil(Math.log2(Math.max(2, opts.groupSize)));
  const lastReason = /* @__PURE__ */ new Map();
  let answered = false;
  let probing = false;
  let largestAnswered = 0;
  let held = [];
  let pending = plan.groups;
  let budgetUsed = 0;
  for (let round = 0; pending.length > 0 && budgetUsed < maxTranslateRounds; round++) {
    const requests = pending.map((group) => ({ group, request: toRequest(translateParamsFor(store, ctx, group, opts)) }));
    for (const { group, request } of requests) if (bypassesCache(group)) seen.add(request.customId);
    const groupByCustomId = new Map(requests.map((r) => [r.request.customId, r.group]));
    const parsedByCustomId = /* @__PURE__ */ new Map();
    const roundItemsTotal = pending.reduce((sum, g) => sum + g.items.length, 0);
    const settledBeforeRound = translateSettled.size;
    let roundRemaining;
    let roundStalled = false;
    const outcomes = await resolve4(
      requests.map((r) => r.request),
      (outcome) => {
        const group = groupByCustomId.get(outcome.customId);
        if (outcome.kind === "ok") {
          answered = true;
          largestAnswered = Math.max(largestAnswered, group.items.length);
        } else if (!answered && isTimeoutOutcome(outcome)) {
          roundStalled = true;
          probing = true;
          return;
        }
        const parsed = outcome.kind === "ok" ? parseTranslatedItems(outcome.text, group) : void 0;
        if (parsed) parsedByCustomId.set(outcome.customId, parsed);
        markTranslateSettled(translateSettledIds(outcome, group, parsed));
      },
      (succeeded, total) => {
        if (roundRemaining === void 0) roundRemaining = roundItemsTotal - (translateSettled.size - settledBeforeRound);
        const cap = Math.max(0, roundRemaining - 1);
        const estimate = Math.min(cap, Math.floor(roundRemaining * succeeded / Math.max(1, total)));
        reportTranslate(translateSettled.size + estimate);
      },
      () => !roundStalled
    );
    if (round === 0 && requests.length > 0) {
      const roundOutcomes = requests.map((r) => outcomes.get(r.request.customId));
      const firstHardError = roundOutcomes.find((o) => o.kind === "error" && !o.retryable);
      if (firstHardError && roundOutcomes.every((o) => o.kind === "error" && !o.retryable)) {
        throw new Error(redactSecrets(firstHardError.message));
      }
    }
    const retry = [];
    const skipped = [];
    const timedOut = [];
    for (const { group, request } of requests) {
      const outcome = outcomes.get(request.customId);
      if (outcome.kind === "skipped") {
        skipped.push(group);
      } else if (!answered && isTimeoutOutcome(outcome)) {
        for (const w of group.items) {
          lastReason.set(w.unit.id, "error");
          errorMessages.set(w.unit.id, outcome.message);
        }
        timedOut.push({ group, message: outcome.message });
      } else if (outcome.kind === "ok") {
        const parsed = parsedByCustomId.get(request.customId);
        for (const [id, item] of parsed.items) results.set(id, item);
        if (parsed.missing.length > 0) {
          for (const w of parsed.missing) errorMessages.set(w.unit.id, "The model returned no translation for this string.");
          retry.push({ groupKey: group.groupKey, items: parsed.missing });
        }
      } else if (outcome.kind === "refusal" || outcome.kind === "error" && (outcome.message === "max_tokens" || isTimeoutMessage(outcome.message))) {
        const reason = outcome.kind === "refusal" ? "refused" : "error";
        for (const w of group.items) lastReason.set(w.unit.id, reason);
        if (outcome.kind === "error") for (const w of group.items) errorMessages.set(w.unit.id, outcome.message);
        if (group.items.length > 1) retry.push(...splitGroup(group));
        else {
          failed.set(group.items[0].unit.id, reason);
          markTranslateSettled([group.items[0].unit.id]);
        }
      } else if (outcome.kind === "error" && outcome.retryable) {
        for (const w of group.items) {
          lastReason.set(w.unit.id, "error");
          errorMessages.set(w.unit.id, outcome.message);
        }
        retry.push(group);
      } else {
        for (const w of group.items) {
          failed.set(w.unit.id, "error");
          errorMessages.set(w.unit.id, outcome.message);
        }
      }
    }
    if (timedOut.length > 0) {
      const probe = timedOut.reduce((largest, t) => t.group.items.length > largest.group.items.length ? t : largest);
      if (probe.group.items.length === 1) throw new Error(redactSecrets(probe.message));
      for (const group of skipped) for (const w of group.items) {
        lastReason.set(w.unit.id, "error");
        errorMessages.set(w.unit.id, probe.message);
      }
      held.push(...skipped, ...retry, ...timedOut.filter((t) => t !== probe).map((t) => t.group));
      pending = splitGroup(probe.group);
      continue;
    }
    retry.push(...skipped);
    if (probing && answered) {
      pending = [...retry, ...held].flatMap((group) => capGroup(group, largestAnswered));
      held = [];
      probing = false;
    } else if (retry.length === 0 && held.length > 0) {
      pending = held;
      held = [];
    } else {
      pending = retry;
    }
    budgetUsed++;
  }
  for (const group of [...pending, ...held])
    for (const w of group.items) if (!results.has(w.unit.id) && !failed.has(w.unit.id)) failed.set(w.unit.id, lastReason.get(w.unit.id) ?? "error");
  markTranslateSettled(work.map((w) => w.unit.id));
  const checks = /* @__PURE__ */ new Map();
  const recheck = (ids) => {
    for (const id of ids ?? results.keys()) {
      const item = results.get(id);
      if (!item) continue;
      const { unit } = byId.get(id);
      checks.set(id, precheck(unit.source, item.translation, culture, precheckOptionsFor(store, culture, unit, opts.lengthCheck)));
    }
  };
  recheck();
  const lengthRepaired = /* @__PURE__ */ new Set();
  const tooLong = (id) => checks.get(id).some((i) => i.code === TOO_LONG_CODE);
  for (let round = 0; round < opts.maxRepairRounds; round++) {
    const broken = [...results.keys()].filter((id) => blocksAutoAccept(checks.get(id)) || tooLong(id) && !lengthRepaired.has(id));
    if (broken.length === 0) break;
    const safeBefore = broken.filter((id) => !blocksAutoAccept(checks.get(id)));
    const previousItems = new Map(safeBefore.map((id) => [id, results.get(id)]));
    for (const id of broken) if (tooLong(id)) lengthRepaired.add(id);
    const repairTotal = broken.length;
    let repairDone = 0;
    const repair = new Map(
      broken.map((id) => [
        id,
        { previous: results.get(id).translation, errors: checks.get(id).filter((i) => i.severity !== "soft" || i.code === TOO_LONG_CODE).map(repairMessage) }
      ])
    );
    const groups = buildGroups(broken.map((id) => byId.get(id)), opts.groupSize);
    const requests = groups.map((group) => ({ group, request: toRequest(translateParamsFor(store, ctx, group, opts, repair)) }));
    const repairGroupByCustomId = new Map(requests.map((r) => [r.request.customId, r.group]));
    for (const { request } of requests) seen.add(request.customId);
    onProgress?.({ phase: "repair", done: 0, total: repairTotal });
    const outcomes = await resolve4(requests.map((r) => r.request), (outcome) => {
      repairDone += repairGroupByCustomId.get(outcome.customId).items.length;
      onProgress?.({ phase: "repair", done: repairDone, total: repairTotal });
    });
    for (const { group, request } of requests) {
      const outcome = outcomes.get(request.customId);
      if (outcome.kind !== "ok") continue;
      for (const [id, item] of parseTranslatedItems(outcome.text, group).items) results.set(id, item);
    }
    recheck();
    for (const [id, previous] of previousItems) if (blocksAutoAccept(checks.get(id))) results.set(id, previous);
    if (previousItems.size > 0) recheck(previousItems.keys());
  }
  const sampledErrorMessages = /* @__PURE__ */ new Set();
  const addErrorSample = (message) => {
    const s = redactSecrets(message).slice(0, MAX_ERROR_SAMPLE_LENGTH);
    if (sampledErrorMessages.has(s)) return;
    sampledErrorMessages.add(s);
    if (report.errorSamples.length < MAX_ERROR_SAMPLES) report.errorSamples.push(s);
  };
  const judged = /* @__PURE__ */ new Map();
  const judgeFailed = /* @__PURE__ */ new Set();
  const judgeable = [...results.keys()].filter((id) => !blocksAutoAccept(checks.get(id)));
  const translations = new Map([...results].map(([id, item]) => [id, item.translation]));
  const judgeGroups = buildGroups(judgeable.map((id) => byId.get(id)), opts.groupSize);
  const judgeRequests = judgeGroups.map((group) => ({
    group,
    request: toRequest(buildJudgeParams(ctx, group, translations, opts.judgeModel))
  }));
  const judgeGroupByCustomId = new Map(judgeRequests.map((r) => [r.request.customId, r.group]));
  const judgeTotal = judgeable.length;
  let judgeDone = 0;
  if (judgeRequests.length > 0) onProgress?.({ phase: "judge", done: 0, total: judgeTotal });
  const judgeOutcomes = judgeRequests.length > 0 ? await resolve4(judgeRequests.map((r) => r.request), (outcome) => {
    judgeDone += judgeGroupByCustomId.get(outcome.customId).items.length;
    onProgress?.({ phase: "judge", done: judgeDone, total: judgeTotal });
  }) : /* @__PURE__ */ new Map();
  for (const { group, request } of judgeRequests) {
    const ids = new Set(group.items.map((w) => w.unit.id));
    const outcome = judgeOutcomes.get(request.customId);
    const parsed = outcome?.kind === "ok" ? parseJudgeIssues(outcome.text, ids) : void 0;
    if (!parsed) {
      for (const id of ids) judgeFailed.add(id);
      addErrorSample(`Judge: ${outcome?.kind === "error" ? outcome.message : "The judge returned malformed output."}`);
      continue;
    }
    for (const [id, issues] of parsed) judged.set(id, issues);
  }
  store.assertFresh();
  onProgress?.({ phase: "write", done: 0, total: work.length });
  for (const w of work) {
    const id = w.unit.id;
    const cell = store.getCell(culture, id);
    const item = results.get(id);
    if (!item) {
      const refused = failed.get(id) === "refused";
      if (refused) report.refused++;
      else {
        report.errors++;
        const message = errorMessages.get(id);
        if (message !== void 0) addErrorSample(message);
      }
      if (cell.revision !== startRevision.get(id)) continue;
      store.putCell({
        ...cell,
        status: cell.text ? cell.status : "needs_fix",
        band: "R",
        qaFlags: [...keepAudit(cell), refused ? "refused" : "llm_error"],
        revision: cell.revision + 1
      });
      store.appendEvent({ ts: now, unitId: id, culture, action: refused ? "ai_refused" : "ai_error", actor: opts.actor, before: cell.text, after: cell.text });
      report.bands.R++;
      continue;
    }
    if (cell.revision !== startRevision.get(id)) {
      store.putCell({ ...cell, suggestion: item.translation });
      store.appendEvent({ ts: now, unitId: id, culture, action: "ai_suggestion", actor: opts.actor, before: cell.text, after: item.translation });
      report.suggestions++;
      continue;
    }
    const issues = checks.get(id) ?? [];
    const judgeIssues = judged.get(id) ?? [];
    const blocked = blocksAutoAccept(issues);
    let band = bandFor({ unit: w.unit, ambiguity: item.ambiguity, precheck: issues, judge: judgeIssues, refused: false });
    if (judgeFailed.has(id) && band === "G") band = "Y";
    const qaFlags = [.../* @__PURE__ */ new Set([...keepAudit(cell), ...issues.map((i) => i.code)])];
    if (judgeFailed.has(id) && !blocked) qaFlags.push("judge_failed");
    if (band === "G" && isAuditSample(id, culture, opts.auditPercent) && !qaFlags.includes("audit")) qaFlags.push("audit");
    store.putCell({
      ...cell,
      text: item.translation,
      status: blocked ? "needs_fix" : "ai_draft",
      basedOnSourceRev: w.unit.sourceRev,
      basedOnSource: w.unit.source,
      provenance: `ai:${opts.translateModel}+${PROMPT_VERSION}`,
      ambiguity: item.ambiguity,
      alts: item.alts,
      question: item.question,
      note: "",
      // A suggestion set while the job ran (e.g. a retranslate that did not bump the revision) survives
      // the job's own write; the reviewer accepts or discards it through the edit action.
      suggestion: cell.suggestion,
      judgeIssues,
      qaFlags,
      band,
      revision: cell.revision + 1
    });
    store.appendEvent({ ts: now, unitId: id, culture, action: blocked ? "ai_needs_fix" : "ai_draft", actor: opts.actor, before: cell.text, after: item.translation });
    const before = store.inbox.size;
    if (item.ambiguity !== "none") recordQuestion(store, culture, id, item.question, opts.actor, now);
    report.questions += store.inbox.size - before;
    if (blocked) report.needsFix++;
    else report.written++;
    if (band === "R" || band === "Y" || band === "G") report.bands[band]++;
  }
  onProgress?.({ phase: "write", done: work.length, total: work.length });
  store.save();
  return report;
}

// src/providers.ts
import { createHash as createHash5 } from "node:crypto";
import { join as join4 } from "node:path";

// src/claudeCode.ts
import { spawn } from "node:child_process";
import { createHash as createHash4, randomUUID } from "node:crypto";
import { mkdirSync as mkdirSync3, unlinkSync as unlinkSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var CHILD_TIMEOUT_MS = 10 * 60 * 1e3;
var AUTH_PROBE_TIMEOUT_MS = 15e3;
var ENV_VARS_TO_STRIP = /* @__PURE__ */ new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
function scrubEnv(source) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (ENV_VARS_TO_STRIP.has(key) || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}
function createProcessRunner(command) {
  return (args, { cwd, env, stdin, timeoutMs }) => new Promise((resolve4) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    const text = (chunks) => Buffer.concat(chunks).toString("utf8");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", (spawnError) => {
      clearTimeout(timer);
      resolve4({ stdout: text(stdoutChunks), stderr: text(stderrChunks), exitCode: null, spawnError });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve4({ stdout: text(stdoutChunks), stderr: text(stderrChunks), exitCode, timedOut });
    });
    child.stdin?.on("error", () => {
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
var defaultProcessRunner = createProcessRunner("claude");
function isolatedRoot() {
  return join3(tmpdir(), "lochub-claude");
}
function isolatedCwd(projectDir) {
  const hash = createHash4("sha1").update(projectDir, "utf8").digest("hex").slice(0, 12);
  return join3(isolatedRoot(), hash);
}
function buildArgs(params, systemPromptFile) {
  return [
    "-p",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    params.model,
    "--effort",
    String(params.output_config?.effort ?? ""),
    "--system-prompt-file",
    systemPromptFile,
    "--json-schema",
    JSON.stringify(params.output_config?.format?.schema ?? {})
  ];
}
var RETRYABLE_MESSAGE_PATTERN = /overloaded?|internal server error|internal_server_error|\b5\d\d\b/i;
function mapResultToOutcome(customId, result) {
  if (result.spawnError) {
    if (result.spawnError.code === "ENOENT") {
      return { customId, kind: "error", message: 'Claude Code (claude) was not found on PATH. Install it and run "claude" once to sign in.', retryable: false };
    }
    return { customId, kind: "error", message: result.spawnError.message.slice(0, 300), retryable: false };
  }
  if (result.timedOut) {
    return { customId, kind: "error", message: "Claude Code (claude) timed out after 10 minutes.", retryable: true };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    return { customId, kind: "error", message: result.stderr.slice(0, 300), retryable: false };
  }
  const body = payload;
  if (body.is_error === true) {
    const text = typeof body.result === "string" ? body.result : "";
    return { customId, kind: "error", message: `Claude Code: ${text}`, retryable: RETRYABLE_MESSAGE_PATTERN.test(text) };
  }
  if (body.structured_output !== void 0 && body.structured_output !== null) {
    const usage = body.usage ?? {};
    const num = (key) => typeof usage[key] === "number" ? usage[key] : 0;
    return {
      customId,
      kind: "ok",
      text: JSON.stringify(body.structured_output),
      inputTokens: num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens"),
      outputTokens: num("output_tokens")
    };
  }
  return { customId, kind: "error", message: "Claude Code returned no structured output", retryable: false };
}
var ClaudeCodeLlmClient = class {
  // The subscription backend has no countTokens equivalent (see countInputTokens below); every count is a guess.
  countsAreApproximate = true;
  runner;
  cwd;
  promptsDir;
  constructor(options) {
    this.runner = options.runner ?? defaultProcessRunner;
    this.cwd = isolatedCwd(options.projectDir);
    this.promptsDir = join3(isolatedRoot(), "prompts");
    mkdirSync3(this.cwd, { recursive: true });
    mkdirSync3(this.promptsDir, { recursive: true });
  }
  // Ignores LlmClient.runSync's shouldContinue (see there): a timed-out `claude` child is reported as an ordinary
  // retryable error, not a timeout the job probes on.
  async runSync(requests, concurrency, onOutcome) {
    const out = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const index = next++;
        const outcome = await this.runOne(requests[index]);
        out[index] = outcome;
        onOutcome?.(outcome);
      }
    };
    const workerCount = Math.max(1, Math.min(concurrency, 4, requests.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return out;
  }
  async runBatch(_requests, _pollMs) {
    throw new Error("Batch mode needs an API key (LocHub AI Backend = API Key).");
  }
  async countInputTokens(params) {
    const chars = systemTextOf(params).length + userTextOf(params).length;
    return Math.ceil(chars / 3) + 1200;
  }
  async runOne(request) {
    const promptFile = join3(this.promptsDir, `${request.customId}-${randomUUID()}.txt`);
    writeFileSync3(promptFile, systemTextOf(request.params), "utf8");
    try {
      const args = buildArgs(request.params, promptFile);
      const options = {
        cwd: this.cwd,
        env: scrubEnv(process.env),
        stdin: userTextOf(request.params),
        timeoutMs: CHILD_TIMEOUT_MS
      };
      const result = await this.runner(args, options);
      return mapResultToOutcome(request.customId, result);
    } finally {
      try {
        unlinkSync3(promptFile);
      } catch {
      }
    }
  }
};
var AUTH_NOT_SIGNED_IN = { ready: false, detail: 'Claude Code is not signed in: run "claude" once and sign in.' };
var AUTH_NOT_FOUND = { ready: false, detail: "Claude Code (claude) was not found on PATH." };
var AUTH_SIGNED_IN = { ready: true, detail: "Signed in to Claude Code" };
async function checkClaudeAuthStatus(runner = defaultProcessRunner) {
  const result = await runner(["auth", "status", "--json"], { cwd: tmpdir(), env: scrubEnv(process.env), stdin: "", timeoutMs: AUTH_PROBE_TIMEOUT_MS });
  if (result.spawnError?.code === "ENOENT") return AUTH_NOT_FOUND;
  if (result.spawnError || result.timedOut) return AUTH_NOT_SIGNED_IN;
  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (result.exitCode === 0 && parsed.loggedIn === true) return AUTH_SIGNED_IN;
  } catch {
  }
  return AUTH_NOT_SIGNED_IN;
}

// src/gemini.ts
var BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
var REFUSAL_REASONS = /* @__PURE__ */ new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);
function buildGenerateBody(params) {
  return {
    systemInstruction: { parts: [{ text: systemTextOf(params) }] },
    contents: [{ role: "user", parts: [{ text: userTextOf(params) }] }],
    // responseJsonSchema takes full JSON Schema; responseSchema is an OpenAPI subset that may not accept
    // additionalProperties (confirmed only by the first live call).
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schemaOf(params), maxOutputTokens: params.max_tokens }
  };
}
function outcomeFromGenerateResponse(customId, status, json) {
  if (status !== 200) {
    const retryable = status === 408 || status === 429 || status >= 500;
    return { customId, kind: "error", message: `Gemini: ${status} ${json.error?.message ?? "request failed"}`.slice(0, 300), retryable };
  }
  if (json.promptFeedback?.blockReason) return { customId, kind: "refusal" };
  const candidate = json.candidates?.[0];
  if (candidate?.finishReason && REFUSAL_REASONS.has(candidate.finishReason)) return { customId, kind: "refusal" };
  if (candidate?.finishReason === "MAX_TOKENS") return { customId, kind: "error", message: "max_tokens", retryable: true };
  const text = (candidate?.content?.parts ?? []).filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("");
  const usage = json.usageMetadata ?? {};
  return { customId, kind: "ok", text, inputTokens: usage.promptTokenCount ?? 0, outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) };
}
var GeminiLlmClient = class {
  // No free token-count endpoint (llmShared.ts's approxInputTokens doc comment); every count is a guess.
  countsAreApproximate = true;
  fetchImpl;
  apiKey;
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
  }
  async runSync(requests, concurrency, onOutcome, shouldContinue) {
    return runPool(requests, concurrency, (request) => this.runOne(request), onOutcome, shouldContinue);
  }
  async runBatch(_requests, _pollMs) {
    throw new Error(BATCH_UNAVAILABLE_MESSAGE);
  }
  async countInputTokens(params) {
    return approxInputTokens(params);
  }
  async runOne(request) {
    if (!this.apiKey) return { customId: request.customId, kind: "error", message: `Gemini: ${MISSING_KEY_MESSAGE}`, retryable: false };
    const result = await fetchWithRetry(
      `${BASE_URL}/${encodeURIComponent(request.params.model)}:generateContent`,
      () => ({
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(buildGenerateBody(request.params)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }),
      { fetchImpl: this.fetchImpl }
    );
    if ("networkError" in result) {
      const { networkError } = result;
      const timedOut = isFetchTimeout(networkError);
      const message = timedOut ? timeoutMessage(timedOutAfterMs(networkError, REQUEST_TIMEOUT_MS)) : networkError instanceof Error ? networkError.message : String(networkError);
      return { customId: request.customId, kind: "error", message: `Gemini: ${message}`, retryable: true };
    }
    return outcomeFromGenerateResponse(request.customId, result.status, result.json);
  }
};

// src/openaiCompatible.ts
var OPENAI_COMPATIBLE_PROFILES = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    schemaMode: "json_schema",
    maxTokensField: "max_completion_tokens",
    sendsEffort: true,
    reasoningAddsToOutput: false,
    keyHeader: "bearer",
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true
  },
  xai: {
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    schemaMode: "json_schema",
    maxTokensField: "max_completion_tokens",
    sendsEffort: true,
    reasoningAddsToOutput: true,
    keyHeader: "bearer",
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    schemaMode: "json_object",
    maxTokensField: "max_tokens",
    sendsEffort: false,
    reasoningAddsToOutput: false,
    keyHeader: "bearer",
    keyRequired: true,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tolerantJson: false,
    retryTimeouts: true
  }
};
function customProfileOf(custom) {
  return {
    label: "Custom",
    baseUrl: custom.baseUrl,
    schemaMode: custom.structuredOutput,
    maxTokensField: null,
    sendsEffort: false,
    reasoningAddsToOutput: false,
    keyHeader: custom.keyHeader,
    keyRequired: false,
    requestTimeoutMs: custom.requestTimeoutSeconds * 1e3,
    tolerantJson: true,
    retryTimeouts: false
  };
}
var SCHEMA_NAME = "lochub_response";
var JSON_OBJECT_INSTRUCTION = "Answer with one JSON object that matches this JSON Schema:";
var FINAL_ERROR_CODES = /* @__PURE__ */ new Set(["credit_balance_exhausted", "insufficient_quota"]);
function buildChatBody(profile, params) {
  const schema = schemaOf(params);
  let system = systemTextOf(params);
  let responseFormat;
  if (profile.schemaMode === "json_schema") {
    responseFormat = { type: "json_schema", json_schema: { name: SCHEMA_NAME, schema, strict: true } };
  } else {
    system = `${system}

${JSON_OBJECT_INSTRUCTION}
${JSON.stringify(schema)}`;
    if (profile.schemaMode === "json_object") responseFormat = { type: "json_object" };
  }
  const body = {
    model: params.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userTextOf(params) }
    ],
    ...responseFormat === void 0 ? {} : { response_format: responseFormat },
    // I-2: a Custom endpoint's profile.maxTokensField is null -- neither field is sent, and the server's own
    // default applies instead of a fixed 16000 that an ordinary-context vLLM/TGI deployment would refuse outright.
    ...profile.maxTokensField === null ? {} : { [profile.maxTokensField]: params.max_tokens }
  };
  const effort = effortOf(params);
  if (profile.sendsEffort && effort) body.reasoning_effort = effort;
  return body;
}
function isRetryableStatus(status, code) {
  if (code && FINAL_ERROR_CODES.has(code)) return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
function reasonFromErrorBody(json, rawText) {
  const error = json.error;
  if (error && typeof error === "object" && typeof error.message === "string" && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  if (typeof json.message === "string" && json.message !== "") return json.message;
  if (typeof json.detail === "string" && json.detail !== "") return json.detail;
  const trimmed = rawText.trim();
  return trimmed !== "" ? trimmed : "request failed";
}
function expectedKeyOf(params) {
  const required = schemaOf(params).required;
  const first = Array.isArray(required) ? required[0] : void 0;
  return typeof first === "string" ? first : void 0;
}
function scrubEndpointMessage(text, baseUrl) {
  return scrubBaseUrlParts(scrubUrls(text), baseUrl);
}
function outcomeFromChatResponse(customId, profile, params, status, json, rawText) {
  if (status !== 200) {
    const code = (json.error && typeof json.error === "object" ? json.error.code : void 0) ?? void 0;
    const reason = scrubEndpointMessage(reasonFromErrorBody(json, rawText), profile.baseUrl);
    const message = redactSecrets(`${profile.label}: ${status} ${reason}`).slice(0, 200);
    return { customId, kind: "error", message, retryable: isRetryableStatus(status, code) };
  }
  const choice = json.choices?.[0];
  if (choice?.finish_reason === "content_filter" || choice?.message?.refusal) return { customId, kind: "refusal" };
  if (choice?.finish_reason === "length") return { customId, kind: "error", message: "max_tokens", retryable: true };
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const text = profile.tolerantJson ? extractJsonObject(content, expectedKeyOf(params)) ?? content : content;
  const usage = json.usage;
  const reasoning = profile.reasoningAddsToOutput ? usage?.completion_tokens_details?.reasoning_tokens ?? 0 : 0;
  const inputTokens = usage?.prompt_tokens ?? approxInputTokens(params);
  const outputTokens = (usage?.completion_tokens ?? approxOutputTokens(content)) + reasoning;
  return { customId, kind: "ok", text, inputTokens, outputTokens };
}
var Semaphore = class {
  available;
  queue = [];
  constructor(slots) {
    this.available = slots;
  }
  async acquire() {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise((resolve4) => this.queue.push(resolve4));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.available++;
  }
};
var OpenAiCompatibleLlmClient = class {
  // No free token-count endpoint (llmShared.ts's approxInputTokens doc comment); every count is a guess.
  countsAreApproximate = true;
  profile;
  fetchImpl;
  apiKey;
  // Custom endpoints only (M-3): caps this instance's total in-flight requests at Max Parallel Requests, across
  // every job. Built-in providers have no such cap -- a job's own `concurrency` is enough for them.
  semaphore;
  constructor(options) {
    this.profile = options.provider === "custom" ? customProfileOf(options.custom) : OPENAI_COMPATIBLE_PROFILES[options.provider];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiKey = options.apiKey;
    this.semaphore = options.provider === "custom" ? new Semaphore(options.custom.maxParallel) : void 0;
  }
  async runSync(requests, concurrency, onOutcome, shouldContinue) {
    return runPool(requests, concurrency, (request) => this.runOne(request), onOutcome, shouldContinue);
  }
  async runBatch(_requests, _pollMs) {
    throw new Error(BATCH_UNAVAILABLE_MESSAGE);
  }
  async countInputTokens(params) {
    return approxInputTokens(params);
  }
  async runOne(request) {
    const { profile } = this;
    if (profile.keyRequired && !this.apiKey) return { customId: request.customId, kind: "error", message: `${profile.label}: ${MISSING_KEY_MESSAGE}`, retryable: false };
    await this.semaphore?.acquire();
    try {
      const result = await fetchWithRetry(
        endpointUrl(profile.baseUrl, "/chat/completions"),
        () => ({
          method: "POST",
          headers: { ...authHeaders(profile.keyHeader, this.apiKey), "content-type": "application/json" },
          body: JSON.stringify(buildChatBody(profile, request.params)),
          // M-10/amendment 5: a cross-origin redirect would forward every header but Authorization (api-key
          // included), so a redirect is refused outright instead of followed.
          redirect: "error",
          signal: AbortSignal.timeout(profile.requestTimeoutMs)
        }),
        {
          fetchImpl: this.fetchImpl,
          // FINAL_ERROR_CODES rides a 429 (an exhausted balance) but never succeeds on retry.
          isFinal: (status, body) => {
            const error = body.error;
            const code = error && typeof error === "object" ? error.code ?? "" : "";
            return status === 429 && FINAL_ERROR_CODES.has(code);
          },
          retryTimeouts: profile.retryTimeouts,
          // NB-6: the server answers the same redirect every time, so a refused one is final at the fetch level too.
          isFinalNetworkError: isRedirectError
        }
      );
      if ("networkError" in result) {
        const { networkError } = result;
        const timedOut = isFetchTimeout(networkError);
        const redirected = !timedOut && isRedirectError(networkError);
        const message = timedOut ? timeoutMessage(timedOutAfterMs(networkError, profile.requestTimeoutMs)) : redirected ? REDIRECT_MESSAGE : scrubEndpointMessage(`cannot reach ${reduceBaseUrl(profile.baseUrl)} (${networkErrorCode(networkError)})`, profile.baseUrl);
        return {
          customId: request.customId,
          kind: "error",
          message: `${profile.label}: ${message}`,
          retryable: !redirected
        };
      }
      return outcomeFromChatResponse(request.customId, profile, request.params, result.status, result.json, result.text);
    } finally {
      this.semaphore?.release();
    }
  }
};

// src/providers.ts
var AI_PROVIDERS = ["anthropic", "openai", "xai", "deepseek", "gemini", "custom"];
var NO_KEY_NEEDED_DETAIL = "No API key (not required for a custom endpoint)";
function keyIdOf(apiKey) {
  if (!apiKey) return "";
  return createHash5("sha1").update(apiKey, "utf8").digest("hex").slice(0, 12);
}
function supportsBatch(config) {
  return config.provider === "anthropic" && config.auth === "api";
}
function billingOf(config) {
  return config.auth;
}
function apiKeyHealth(env, provider = "anthropic") {
  if (env.LOCHUB_API_KEY) return { ready: true, detail: "API key is set" };
  return provider === "custom" ? { ready: true, detail: NO_KEY_NEEDED_DETAIL } : { ready: false, detail: MISSING_KEY_MESSAGE };
}
function createLlmClient(config, projectDir, apiKey) {
  switch (config.provider) {
    case "anthropic":
      return config.auth === "subscription" ? new ClaudeCodeLlmClient({ projectDir }) : new AnthropicLlmClient({ apiKey, batchDir: join4(projectDir, "Saved", "LocHub", "batches") });
    case "gemini":
      return new GeminiLlmClient({ apiKey });
    case "openai":
    case "xai":
    case "deepseek":
      return new OpenAiCompatibleLlmClient({ provider: config.provider, apiKey });
    case "custom":
      if (!config.custom) throw new Error("The custom provider needs its endpoint settings (--base-url and the other custom flags).");
      return new OpenAiCompatibleLlmClient({ provider: "custom", custom: config.custom, apiKey });
    default: {
      const exhaustive = config.provider;
      throw new Error(`Unknown AI provider: ${exhaustive}`);
    }
  }
}
var DEFAULT_AI_CONFIG = {
  provider: "anthropic",
  auth: "api",
  translateModel: DEFAULT_JOB_OPTIONS.translateModel,
  judgeModel: DEFAULT_JOB_OPTIONS.judgeModel
};
function jobDefaultsFor(ai) {
  return {
    ...DEFAULT_JOB_OPTIONS,
    translateModel: ai.translateModel,
    judgeModel: ai.judgeModel,
    // Now (sync) is the default for every provider; Batch is an explicit choice, and only Anthropic
    // billed per token supports it.
    mode: "sync",
    // M-3/amendment 4: a Custom endpoint is often one local GPU. The real cap on concurrent requests is now the
    // semaphore inside OpenAiCompatibleLlmClient, shared across every job; this concurrency is just this one
    // job's own worker count, so every configured value (1-32) takes effect instead of being silently capped at
    // DEFAULT_JOB_OPTIONS.concurrency (8).
    ...ai.custom ? {
      concurrency: ai.custom.maxParallel,
      customPrice: { input: ai.custom.priceIn, output: ai.custom.priceOut }
    } : {}
  };
}

// src/server.ts
import { createHash as createHash7, randomUUID as randomUUID2 } from "node:crypto";
import { Fastify } from "../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs";

// src/estimate.ts
var PRICES_PER_MTOK = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "grok-4.7": { input: 2, output: 6 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },
  "deepseek-flash": { input: 0.3, output: 1.2 },
  // deepseek-v4-flash is a retired model id the API still accepts, routed to deepseek-flash server-side (design
  // doc §2); priced the same so a paid run on that id keeps its budget check instead of silently pricing free.
  "deepseek-v4-flash": { input: 0.3, output: 1.2 },
  "gemini-3.1-pro-preview": { input: 2, output: 12 },
  // Google announced a price rise for this model to 1.50 / 7.50 USD per million tokens effective 2027-01-01;
  // update this entry then, or a job on the default Gemini translate model can cost up to twice this estimate.
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5 }
};
var OUTPUT_TOKENS_PER_ITEM = 150;
var JUDGE_OUTPUT_TOKENS_PER_ITEM = 40;
var BudgetExceededError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceededError";
  }
};
function priceOf(model, customPrice) {
  return customPrice ?? PRICES_PER_MTOK[model] ?? null;
}
var ESTIMATE_CONCURRENCY = 8;
var MAX_COUNT_CACHE_ENTRIES = 5e4;
var TokenCountCache = class {
  counts = /* @__PURE__ */ new Map();
  get(id) {
    return this.counts.get(id);
  }
  // Only a real count is ever remembered here — estimateJob never calls this for an approxInputTokens fallback.
  remember(id, tokens) {
    if (!this.counts.has(id) && this.counts.size >= MAX_COUNT_CACHE_ENTRIES) this.counts.clear();
    this.counts.set(id, tokens);
  }
};
function isRateLimitOrOverloaded(error) {
  const err = error;
  const status = typeof err?.status === "number" ? err.status : void 0;
  const type = typeof err?.type === "string" ? err.type : void 0;
  return status === 429 || status === 529 || type === "rate_limit_error" || type === "overloaded_error";
}
async function estimateJob(store, llm, cache, opts, billing = "api", extra = {}) {
  const translatePrice = priceOf(opts.translateModel, opts.customPrice);
  const judgePrice = priceOf(opts.judgeModel, opts.customPrice);
  const pricesUnset = opts.customPrice !== void 0 && opts.customPrice.input === 0 && opts.customPrice.output === 0;
  const plan = planWork(store, opts);
  let strings = plan.tmHits.length;
  const toCount = [];
  for (const group of plan.groups) {
    const params = translateParamsFor(store, plan.ctx, group, opts);
    if (!bypassesCache(group) && cache.get(requestId(params))) {
      strings += group.items.length;
      continue;
    }
    toCount.push({ customId: requestId(params), group, params });
  }
  let requests = 0;
  let items = 0;
  let inputTokens = 0;
  let approximate = false;
  if (extra.skipNetwork) {
    for (const { group, params } of toCount) {
      requests++;
      items += group.items.length;
      inputTokens += approxInputTokens(params);
    }
    approximate = toCount.length > 0;
  } else {
    const countCache = extra.countCache ?? new TokenCountCache();
    const rawErrors = /* @__PURE__ */ new Map();
    const approxIds = /* @__PURE__ */ new Set();
    const state = { stop: "none" };
    const currentStop = () => state.stop;
    let firstHardError;
    const counted = await runPool(
      toCount.map((t) => ({ customId: t.customId, params: t.params })),
      ESTIMATE_CONCURRENCY,
      async (request) => {
        const remembered = countCache.get(request.customId);
        if (remembered !== void 0) return { customId: request.customId, kind: "ok", text: "", inputTokens: remembered, outputTokens: 0 };
        if (state.stop === "fail") return { customId: request.customId, kind: "error", message: "count_skipped", retryable: false };
        if (state.stop === "approximate") {
          approxIds.add(request.customId);
          return { customId: request.customId, kind: "ok", text: "", inputTokens: approxInputTokens(request.params), outputTokens: 0 };
        }
        try {
          const tokens = await llm.countInputTokens(request.params);
          countCache.remember(request.customId, tokens);
          if (llm.countsAreApproximate) approxIds.add(request.customId);
          return { customId: request.customId, kind: "ok", text: "", inputTokens: tokens, outputTokens: 0 };
        } catch (error) {
          if (isRateLimitOrOverloaded(error)) {
            if (state.stop === "none") state.stop = "approximate";
            approxIds.add(request.customId);
            return { customId: request.customId, kind: "ok", text: "", inputTokens: approxInputTokens(request.params), outputTokens: 0 };
          }
          if (currentStop() !== "fail") {
            state.stop = "fail";
            firstHardError = error;
          }
          rawErrors.set(request.customId, error);
          return { customId: request.customId, kind: "error", message: "count_failed", retryable: false };
        }
      }
    );
    if (state.stop === "fail") throw firstHardError;
    for (let i = 0; i < toCount.length; i++) {
      const outcome = counted[i];
      if (outcome.kind !== "ok") throw rawErrors.get(outcome.customId);
      requests++;
      items += toCount[i].group.items.length;
      inputTokens += outcome.inputTokens;
    }
    approximate = approxIds.size > 0;
  }
  strings += items;
  const translateOut = items * OUTPUT_TOKENS_PER_ITEM;
  const judgeIn = inputTokens + translateOut;
  const judgeOut = items * JUDGE_OUTPUT_TOKENS_PER_ITEM;
  const discount = opts.mode === "batch" ? 0.5 : 1;
  const usd = translatePrice && judgePrice ? (inputTokens * translatePrice.input + translateOut * translatePrice.output + judgeIn * judgePrice.input + judgeOut * judgePrice.output) / 1e6 * discount : null;
  return {
    requests,
    items,
    strings,
    inputTokens,
    outputTokens: translateOut + judgeOut,
    usd,
    billing,
    ...approximate ? { approximate: true } : {},
    ...pricesUnset ? { pricesUnset: true } : {}
  };
}
function assertWithinBudget(estimate, maxUsd) {
  if (estimate.usd !== null && estimate.usd > maxUsd)
    throw new BudgetExceededError(`Estimated $${estimate.usd.toFixed(2)} exceeds the limit of $${maxUsd.toFixed(2)}`);
}

// src/exchange.ts
import { createHash as createHash6 } from "node:crypto";
var ImportRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ImportRequestError";
  }
};
var ImportPreviewStaleError = class extends Error {
  constructor(result) {
    super("LocHub changed since the preview. Check the new preview and import again.");
    this.result = result;
    this.name = "ImportPreviewStaleError";
  }
};
var MAX_ACTOR_LENGTH = 64;
var ISO_DATE_TIME = EXPORTED_AT_PATTERN;
var UNCHANGING_ACTIONS = /* @__PURE__ */ new Set(["exported", "ai_suggestion"]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function optionalString(entry, field, index) {
  const value = entry[field];
  if (value === void 0) return void 0;
  if (typeof value !== "string") throw new ImportRequestError(`entries[${index}].${field} must be a string`);
  return value;
}
function parseEntry(raw, index) {
  if (!isRecord(raw)) throw new ImportRequestError(`entries[${index}] must be an object`);
  if (typeof raw.text !== "string") throw new ImportRequestError(`entries[${index}].text must be a string`);
  if (typeof raw.approved !== "boolean") throw new ImportRequestError(`entries[${index}].approved must be true or false`);
  const entry = { text: raw.text, approved: raw.approved };
  for (const field of ["unitId", "namespace", "key", "source"]) {
    const value = optionalString(raw, field, index);
    if (value !== void 0) entry[field] = value;
  }
  if (raw.exportedRevision !== void 0) {
    const revision = raw.exportedRevision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0)
      throw new ImportRequestError(`entries[${index}].exportedRevision must be a whole number`);
    entry.exportedRevision = revision;
  }
  const exportedAt = optionalString(raw, "exportedAt", index);
  if (exportedAt !== void 0) {
    const match = ISO_DATE_TIME.exec(exportedAt);
    const time = match ? Date.parse(match[1] ? exportedAt : `${exportedAt}Z`) : Number.NaN;
    if (Number.isNaN(time)) throw new ImportRequestError(`entries[${index}].exportedAt must be a date (ISO 8601)`);
    entry.exportedAt = new Date(time).toISOString();
  }
  return entry;
}
function parseImportRequest(body) {
  if (!isRecord(body)) throw new ImportRequestError("Body must be a JSON object");
  if (typeof body.culture !== "string") throw new ImportRequestError("culture is required");
  if (typeof body.actor !== "string") throw new ImportRequestError("actor must be a string");
  const { dryRun, overwriteConflicts, acceptConfirm } = body;
  if (typeof dryRun !== "boolean") throw new ImportRequestError("dryRun must be true or false");
  if (typeof overwriteConflicts !== "boolean") throw new ImportRequestError("overwriteConflicts must be true or false");
  if (typeof acceptConfirm !== "boolean") throw new ImportRequestError("acceptConfirm must be true or false");
  const actor = Array.from(body.actor.trim()).slice(0, MAX_ACTOR_LENGTH).join("");
  if (!dryRun && actor.length === 0) throw new ImportRequestError("actor is required: the reviewer name recorded on every imported string");
  if (body.previewDigest !== void 0 && typeof body.previewDigest !== "string") throw new ImportRequestError("previewDigest must be a string");
  if (!Array.isArray(body.entries)) throw new ImportRequestError("entries must be an array");
  const entries = body.entries.map((raw, index) => parseEntry(raw, index));
  return { culture: body.culture, actor, dryRun, overwriteConflicts, acceptConfirm, previewDigest: body.previewDigest, entries };
}
function resolveUnits(store, entries) {
  const byName = /* @__PURE__ */ new Map();
  for (const unit of store.units.values()) if (unit.state === "active") byName.set(JSON.stringify([unit.namespace, unit.key]), unit);
  const seen = /* @__PURE__ */ new Set();
  return entries.map((entry) => {
    let unit;
    if (entry.unitId !== void 0) {
      const found = store.units.get(entry.unitId);
      unit = found?.state === "active" ? found : void 0;
    }
    if (!unit && entry.key !== void 0) unit = byName.get(JSON.stringify([entry.namespace ?? "", entry.key]));
    if (unit) {
      if (seen.has(unit.id)) throw new ImportRequestError(`The file has the same string twice (${unit.namespace}/${unit.key}); keep one and import again.`);
      seen.add(unit.id);
    }
    return unit;
  });
}
function runImport(store, request, check) {
  const units = resolveUnits(store, request.entries);
  let lastChange;
  const changedAfter = (unitId, exportedAt) => {
    lastChange ??= store.latestEventTimes(request.culture, UNCHANGING_ACTIONS);
    return (lastChange.get(unitId) ?? Number.NEGATIVE_INFINITY) > Date.parse(exportedAt);
  };
  const rows = [];
  const applied = [];
  request.entries.forEach((entry, index) => {
    const unit = units[index];
    if (!unit) {
      rows.push({ index, outcome: "unknown" });
      return;
    }
    if (entry.source !== void 0 && entry.source !== unit.source) {
      rows.push({ index, unitId: unit.id, outcome: "stale" });
      return;
    }
    if (entry.text.trim().length === 0) {
      rows.push({ index, unitId: unit.id, outcome: "empty" });
      return;
    }
    const cell = store.getCell(request.culture, unit.id);
    const approves = entry.approved && (cell.status !== "approved" || entry.source !== void 0 && isOutdated(unit, cell));
    if (entry.text === cell.text && !approves) {
      rows.push({ index, unitId: unit.id, outcome: "unchanged" });
      return;
    }
    const conflict = entry.exportedRevision !== void 0 ? entry.exportedRevision !== cell.revision : entry.exportedAt !== void 0 && changedAfter(unit.id, entry.exportedAt);
    const issues = check(unit, entry.text);
    const accepted = confirmCodes(issues);
    let outcome;
    if (conflict && !request.overwriteConflicts) outcome = "conflict";
    else if (hasHardIssues(issues)) outcome = "hard";
    else if (accepted.length > 0 && !request.acceptConfirm) outcome = "confirm";
    else {
      const carriedOverApproval = cell.status === "approved";
      const kind = conflict ? "changed" : entry.text === cell.text ? "approved" : entry.approved && !carriedOverApproval ? "changed_approved" : "changed";
      applied.push({ unit, cell, entry, outcome: kind, accepted });
      outcome = kind;
    }
    rows.push({ index, unitId: unit.id, outcome, ...conflict ? { conflict: true } : {}, issues, before: cell.text, after: entry.text });
  });
  const counts = Object.fromEntries(IMPORT_OUTCOMES.map((outcome) => [outcome, 0]));
  for (const row of rows) counts[row.outcome]++;
  const digest = createHash6("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16);
  const result = { rows, counts, digest };
  if (!request.dryRun && request.previewDigest !== void 0 && request.previewDigest !== digest) throw new ImportPreviewStaleError(result);
  if (!request.dryRun && applied.length > 0) apply(store, request, applied);
  return result;
}
function apply(store, request, applied) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const events = [];
  for (const { unit, cell, entry, outcome, accepted } of applied) {
    const next = outcome === "approved" ? approvedCell(unit, cell) : { ...editedCell(unit, cell, entry.text, request.actor), ...outcome === "changed_approved" ? { status: "approved" } : {} };
    store.putCell(next);
    events.push({
      ts,
      unitId: unit.id,
      culture: request.culture,
      action: "import",
      actor: request.actor,
      before: cell.text,
      after: next.text,
      ...accepted.length > 0 ? { accepted: [...accepted] } : {}
    });
  }
  try {
    store.save();
  } catch (error) {
    for (const { cell } of applied) store.putCell(cell);
    throw error;
  }
  store.appendEvents(events);
}

// src/push.ts
function reconcileArchiveEntries(store, units, archives, actor) {
  const cellWrites = [];
  const events = [];
  let humanEdits = 0;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  for (const [culture, entries] of Object.entries(archives)) {
    const pastAfters = store.afterTextsByUnit(culture);
    for (const archived of entries) {
      const id = unitIdOf(archived.namespace, archived.key);
      const unit = units.get(id);
      if (!unit || archived.translation.length === 0) continue;
      if (archived.source !== unit.source) continue;
      const cell = store.getCell(culture, id);
      const hash = textHash(archived.translation);
      if (archived.translation === cell.text || hash === cell.archiveHash) continue;
      if (pastAfters.get(id)?.has(archived.translation)) continue;
      cellWrites.push({
        ...cell,
        text: archived.translation,
        status: "human_edit",
        provenance: "human:archive",
        basedOnSourceRev: unit.sourceRev,
        basedOnSource: unit.source,
        archiveHash: hash,
        band: "",
        judgeIssues: [],
        qaFlags: keepAudit(cell),
        suggestion: "",
        revision: cell.revision + 1
      });
      events.push({ ts: now, unitId: id, culture, action: "human_edit", actor, before: cell.text, after: archived.translation });
      humanEdits++;
    }
  }
  return { cellWrites, events, humanEdits };
}
function reconcileArchives(store, archives, actor = "pull") {
  const { cellWrites, events, humanEdits } = reconcileArchiveEntries(store, store.units, archives, actor);
  for (const cell of cellWrites) store.putCell(cell);
  for (const event of events) store.appendEvent(event);
  return humanEdits;
}
function applySnapshot(store, snapshot, actor = "push", opts = {}) {
  const report = { added: 0, changed: 0, cosmetic: 0, tombstoned: 0, revived: 0, humanEdits: 0 };
  const present = /* @__PURE__ */ new Set();
  const units = new Map(store.units);
  for (const entry of snapshot.entries) {
    const id = unitIdOf(entry.namespace, entry.key);
    present.add(id);
    const old = units.get(id);
    if (!old) {
      units.set(id, {
        id,
        namespace: entry.namespace,
        key: entry.key,
        source: entry.source,
        sourceRev: 1,
        state: "active",
        origin: entry.origin,
        devNotes: entry.devNotes,
        metadata: { ...entry.metadata },
        groupKey: entry.groupKey
      });
      report.added++;
      continue;
    }
    const next = { ...old, origin: entry.origin, devNotes: entry.devNotes, metadata: { ...entry.metadata }, groupKey: entry.groupKey };
    if (old.state === "tombstone") {
      next.state = "active";
      report.revived++;
    }
    if (old.source !== entry.source) {
      if (isCosmeticChange(old.source, entry.source)) {
        report.cosmetic++;
      } else {
        next.sourceRev = old.sourceRev + 1;
        report.changed++;
      }
      next.source = entry.source;
    }
    units.set(id, next);
  }
  for (const unit of units.values()) {
    if (unit.state === "active" && !present.has(unit.id)) {
      units.set(unit.id, { ...unit, state: "tombstone" });
      report.tombstoned++;
    }
  }
  const { cellWrites, events, humanEdits } = reconcileArchiveEntries(store, units, snapshot.archives, actor);
  report.humanEdits = humanEdits;
  if (!opts.dryRun) {
    store.units.clear();
    for (const [id, unit] of units) store.units.set(id, unit);
    for (const cell of cellWrites) store.putCell(cell);
    for (const event of events) store.appendEvent(event);
    store.updatePluralForms(snapshot.pluralForms ?? {});
  }
  return report;
}

// src/retranslate.ts
async function retranslateWithNote(store, llm, opts, unitId, note, asRule) {
  const culture = opts.culture;
  const unit = store.units.get(unitId);
  if (!unit || unit.state !== "active") throw new CellActionError(`Unknown unit ${unitId}`, 404);
  const text = note.trim();
  if (text.length === 0) throw new CellActionError("Note is empty");
  const current = store.getCell(culture, unitId);
  const group = { groupKey: unit.groupKey, items: [{ unit, cell: { ...current, status: "rejected", note: text } }] };
  const params = translateParamsFor(store, cultureContext(store, culture, opts.brief), group, opts);
  const [outcome] = await llm.runSync([{ customId: requestId(params), params }], 1);
  if (!outcome || outcome.kind !== "ok") {
    const message = outcome?.kind === "refusal" ? "The model refused this string" : outcome?.kind === "error" ? `The model call failed: ${redactSecrets(outcome.message)}` : "The model call failed";
    throw new CellActionError(message, 502);
  }
  const item = parseTranslatedItems(outcome.text, group).items.get(unitId);
  if (!item) throw new CellActionError("The model returned no translation for this string", 502);
  const issues = checkTranslation(store, culture, unit, item.translation, opts.lengthCheck);
  store.assertFresh();
  const latest = store.getCell(culture, unitId);
  const cell = { ...latest, suggestion: item.translation };
  store.putCell(cell);
  store.appendEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), unitId, culture, action: "ai_suggestion", actor: "reviewer", before: latest.text, after: item.translation });
  if (asRule) {
    const style = (store.style.get(culture) ?? "").trimEnd();
    const rule = `- ${text}`;
    if (!style.split("\n").includes(rule)) store.style.set(culture, `${style}${style ? "\n" : ""}${rule}
`);
  }
  store.save();
  return { cell, issues };
}

// src/store.ts
import { appendFileSync, existsSync as existsSync3, mkdirSync as mkdirSync4, readdirSync, readFileSync as readFileSync3, renameSync as renameSync3, statSync, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname, join as join5, resolve, sep } from "node:path";
var StoreChangedOnDiskError = class extends Error {
  constructor() {
    super("Localization/LocHub changed on disk since the service loaded it (a source control sync?). Restart the LocHub service.");
    this.name = "StoreChangedOnDiskError";
  }
};
function fingerprintOf(dataDir) {
  const out = /* @__PURE__ */ new Map();
  const stat = (name) => {
    const path = join5(dataDir, name);
    if (!existsSync3(path)) return;
    const s = statSync(path);
    out.set(name, { size: s.size, mtimeMs: s.mtimeMs });
  };
  stat("units.jsonl");
  stat("inbox.jsonl");
  if (existsSync3(dataDir)) {
    for (const name of readdirSync(dataDir)) {
      if (/^cells\..+\.jsonl$/.test(name) || /^glossary\..+\.jsonl$/.test(name) || /^style\..+\.md$/.test(name)) stat(name);
    }
  }
  return out;
}
function fingerprintsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, stat] of a) {
    const other = b.get(name);
    if (!other || other.size !== stat.size || other.mtimeMs !== stat.mtimeMs) return false;
  }
  return true;
}
var LocHubStore = class _LocHubStore {
  constructor(dataDir, pluralFormsPath) {
    this.dataDir = dataDir;
    this.pluralFormsPath = pluralFormsPath;
  }
  units = /* @__PURE__ */ new Map();
  cells = /* @__PURE__ */ new Map();
  glossary = /* @__PURE__ */ new Map();
  style = /* @__PURE__ */ new Map();
  inbox = /* @__PURE__ */ new Map();
  // The engine's plural forms per culture from the Pushes since the service started, latest value per culture.
  // Persisted to pluralFormsPath (updatePluralForms), separate from dataDir: they describe the running
  // engine, not project data, so they do not belong in the committed Localization/LocHub. Every Push sends
  // them again, so a missing or unreadable file just means "nothing pushed yet" -- today's Node fallback.
  pluralForms = /* @__PURE__ */ new Map();
  // Snapshot taken at load() and again at the end of every save(); changedOnDisk() compares against it.
  fingerprint = /* @__PURE__ */ new Map();
  static load(dataDir, pluralFormsPath) {
    mkdirSync4(dataDir, { recursive: true });
    const store = new _LocHubStore(dataDir, pluralFormsPath);
    for (const unit of readJsonl(join5(dataDir, "units.jsonl"))) store.units.set(unit.id, unit);
    for (const item of readJsonl(join5(dataDir, "inbox.jsonl"))) store.inbox.set(item.id, item);
    for (const file of readdirSync(dataDir)) {
      const cells = /^cells\.(.+)\.jsonl$/.exec(file);
      if (cells) {
        const map = /* @__PURE__ */ new Map();
        for (const cell of readJsonl(join5(dataDir, file))) map.set(cell.unitId, cell);
        store.cells.set(cells[1], map);
        continue;
      }
      const glossary = /^glossary\.(.+)\.jsonl$/.exec(file);
      if (glossary) {
        store.glossary.set(glossary[1], readJsonl(join5(dataDir, file)));
        continue;
      }
      const style = /^style\.(.+)\.md$/.exec(file);
      if (style) store.style.set(style[1], stripBom(readFileSync3(join5(dataDir, file), "utf8")));
    }
    store.fingerprint = fingerprintOf(dataDir);
    store.loadPluralForms();
    assertNoCaseCollisions([store.cells.keys(), store.glossary.keys(), store.style.keys()]);
    return store;
  }
  // A missing file is the ordinary case (no pluralFormsPath given, or nothing pushed since this project's
  // Saved/ folder was last cleared): pluralCategoriesFor's Node fallback covers it silently. A present but
  // unreadable/corrupt file (a crash mid-write with no .tmp to recover from, hand-edited, from a future
  // service version) falls back the same way, but is worth one operator-visible line -- it is not the
  // ordinary case and the file only ever holds a small cache, not project data.
  loadPluralForms() {
    if (!this.pluralFormsPath || !existsSync3(this.pluralFormsPath)) return;
    try {
      const parsed = JSON.parse(readFileSync3(this.pluralFormsPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      for (const [culture, forms] of Object.entries(parsed)) {
        if (isPluralForms(forms)) this.pluralForms.set(culture, { cardinal: [...forms.cardinal], ordinal: [...forms.ordinal] });
      }
    } catch (error) {
      console.warn(`${this.pluralFormsPath}: could not read the stored engine plural forms (${error.message}); using Node's own plural rules until the next Push`);
    }
  }
  // True when a data file save() would write has been added, removed or changed since load() or the last
  // save() (a source control sync, e.g. git pull, while the service runs). /api/health reports it; save()
  // refuses to write when true.
  changedOnDisk() {
    return !fingerprintsEqual(this.fingerprint, fingerprintOf(this.dataDir));
  }
  // Callers that stage a write (putCell/appendEvent) ahead of save() — every
  // server.ts handler and job.ts's commit batches — must check freshness before staging anything, not only
  // inside save(). appendEvent is a plain, immediate append: if save() were the only gate, a 409 on the save
  // step would leave an event already written to events.*.jsonl with no matching cell, a phantom `after` that
  // a later reconcile mistakes for LocHub's own text. Throws the same error save() throws.
  assertFresh() {
    if (this.changedOnDisk()) throw new StoreChangedOnDiskError();
  }
  cellsFor(culture) {
    let map = this.cells.get(culture);
    if (!map) {
      map = /* @__PURE__ */ new Map();
      this.cells.set(culture, map);
    }
    return map;
  }
  // Pure read: an unknown culture must not create a map entry (a later save() would then write an empty
  // file for it, which on a case-insensitive filesystem can truncate a differently-cased culture's data).
  // cellsFor stays the writer path used by putCell.
  getCell(culture, unitId) {
    return this.cells.get(culture)?.get(unitId) ?? emptyCell(unitId, culture);
  }
  putCell(cell) {
    this.cellsFor(cell.culture).set(cell.unitId, cell);
  }
  // The plural categories precheck and the prompt use for a culture: the engine's (it validates on Pull) when a
  // Push reported them, else Node's own ICU answer.
  pluralCategoriesFor(culture, type) {
    return this.pluralForms.get(culture)?.[type] ?? pluralCategories(culture, type);
  }
  // Called by Push (applySnapshot) for whatever pluralForms a snapshot carried -- latest value per culture,
  // a culture the snapshot leaves out keeps its current forms. Persists to pluralFormsPath, but only when
  // something actually changed, so a resend of unchanged forms or a pluralForms-less Push (an older plugin,
  // or nothing to report) never touches the file.
  updatePluralForms(forms) {
    let changed = false;
    for (const [culture, value] of Object.entries(forms)) {
      const next = { cardinal: [...value.cardinal], ordinal: [...value.ordinal] };
      const current = this.pluralForms.get(culture);
      if (!current || !sameForms(current, next)) changed = true;
      this.pluralForms.set(culture, next);
    }
    if (changed) this.savePluralForms();
  }
  savePluralForms() {
    if (!this.pluralFormsPath) return;
    const out = {};
    for (const [culture, forms] of this.pluralForms) out[culture] = forms;
    try {
      mkdirSync4(dirname(this.pluralFormsPath), { recursive: true });
      writeFileAtomic3(this.pluralFormsPath, canonicalJson(out));
    } catch (error) {
      console.warn(`${this.pluralFormsPath}: could not save the engine plural forms (${error.message}); keeping them in memory only`);
    }
  }
  save() {
    this.assertFresh();
    assertNoCaseCollisions([this.cells.keys(), this.glossary.keys(), this.style.keys()]);
    const units = [...this.units.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
    writeJsonl(join5(this.dataDir, "units.jsonl"), units);
    for (const [culture, map] of this.cells) {
      const cells = [...map.values()].filter((c) => c.status !== "empty").sort((a, b) => compareCodeUnits(a.unitId, b.unitId));
      writeJsonl(this.pathFor(`cells.${culture}.jsonl`), cells);
    }
    for (const [culture, terms] of this.glossary) {
      const sorted = [...terms].sort((a, b) => compareCodeUnits(a.term, b.term));
      writeJsonl(this.pathFor(`glossary.${culture}.jsonl`), sorted);
    }
    for (const [culture, text] of this.style) writeFileAtomic3(this.pathFor(`style.${culture}.md`), text);
    const inbox = [...this.inbox.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
    writeJsonl(join5(this.dataDir, "inbox.jsonl"), inbox);
    this.fingerprint = fingerprintOf(this.dataDir);
  }
  appendEvent(event) {
    appendFileSync(this.pathFor(`events.${event.culture}.jsonl`), canonicalJson(event) + "\n", "utf8");
  }
  // Cell history for the card view; the event log is append-only and read on demand.
  readEvents(culture, unitId) {
    return readJsonl(this.pathFor(`events.${culture}.jsonl`)).filter((e) => e.unitId === unitId);
  }
  // Several events in one write per culture file (an import applies many rows at once).
  appendEvents(events) {
    const byCulture = /* @__PURE__ */ new Map();
    for (const event of events) byCulture.set(event.culture, (byCulture.get(event.culture) ?? "") + canonicalJson(event) + "\n");
    for (const [culture, lines] of byCulture) appendFileSync(this.pathFor(`events.${culture}.jsonl`), lines, "utf8");
  }
  // The newest event time (ms since epoch) per unit of one culture, skipping the `ignore` actions: import uses it to
  // tell whether a cell changed after a translator's file was exported. Tolerant of a torn last line and of a bad
  // timestamp, like afterTextsByUnit below.
  latestEventTimes(culture, ignore) {
    const out = /* @__PURE__ */ new Map();
    const path = this.pathFor(`events.${culture}.jsonl`);
    if (!existsSync3(path)) return out;
    for (const line of readFileSync3(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
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
  afterTextsByUnit(culture) {
    const out = /* @__PURE__ */ new Map();
    const path = this.pathFor(`events.${culture}.jsonl`);
    if (!existsSync3(path)) return out;
    let skipped = 0;
    for (const line of readFileSync3(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        skipped++;
        continue;
      }
      const set = out.get(event.unitId) ?? /* @__PURE__ */ new Set();
      set.add(event.after);
      out.set(event.unitId, set);
    }
    if (skipped > 0) console.warn(`${path}: skipped ${skipped} unparsable event line(s)`);
    return out;
  }
  // Defence in depth against path traversal: the API boundary already rejects a culture outside
  // CULTURE_RE, but every per-culture file path is resolved and checked here too, in case a caller reaches
  // the store directly with an unvalidated value.
  pathFor(name) {
    const base = resolve(this.dataDir);
    const resolved = resolve(base, name);
    if (resolved !== base && !resolved.startsWith(base + sep)) throw new Error(`Path escapes data dir: ${name}`);
    return resolved;
  }
};
function isPluralForms(value) {
  if (value === null || typeof value !== "object") return false;
  const v = value;
  return isCategoryList(v.cardinal) && isCategoryList(v.ordinal);
}
function isCategoryList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === "string" && PLURAL_CATEGORIES.has(c));
}
function sameForms(a, b) {
  return sameList(a.cardinal, b.cardinal) && sameList(a.ordinal, b.ordinal);
}
function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function assertNoCaseCollisions(keySets) {
  const seen = /* @__PURE__ */ new Map();
  for (const keys of keySets) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      const existing = seen.get(lower);
      if (existing !== void 0 && existing !== key) throw new Error(`culture keys "${existing}" and "${key}" differ only in case`);
      seen.set(lower, key);
    }
  }
}
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function readJsonl(path) {
  if (!existsSync3(path)) return [];
  const out = [];
  stripBom(readFileSync3(path, "utf8")).split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      out.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
  return out;
}
function writeFileAtomic3(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync4(tmp, content, "utf8");
  renameSync3(tmp, path);
}
function writeJsonl(path, rows) {
  writeFileAtomic3(path, rows.map((row) => canonicalJson(row) + "\n").join(""));
}

// src/summary.ts
var CORRECTED = /* @__PURE__ */ new Set(["edited", "rejected", "human_edit"]);
function summarize(store, culture) {
  const summary = {
    culture,
    total: 0,
    byStatus: {},
    byBand: { R: 0, Y: 0, G: 0 },
    outdated: 0,
    openQuestions: 0,
    audit: { sampled: 0, corrected: 0 }
  };
  for (const unit of store.units.values()) {
    if (unit.state !== "active") continue;
    const cell = store.getCell(culture, unit.id);
    summary.total++;
    summary.byStatus[cell.status] = (summary.byStatus[cell.status] ?? 0) + 1;
    if (cell.band === "R" || cell.band === "Y" || cell.band === "G") summary.byBand[cell.band]++;
    if (isOutdated(unit, cell)) summary.outdated++;
    if (cell.qaFlags.includes("audit")) {
      summary.audit.sampled++;
      if (CORRECTED.has(cell.status)) summary.audit.corrected++;
    }
  }
  for (const item of store.inbox.values()) if (item.culture === culture && item.status === "open") summary.openQuestions++;
  return summary;
}

// src/web.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
import { extname, join as join6, resolve as resolve2, sep as sep2 } from "node:path";
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};
function resolveWebFile(webRoot, requestUrl) {
  const root = resolve2(webRoot);
  const pathPart = requestUrl.split(/[?#]/, 1)[0] ?? "/";
  let relative;
  try {
    relative = decodeURIComponent(pathPart);
  } catch {
    return void 0;
  }
  const target = resolve2(root, `.${relative.startsWith("/") ? "" : "/"}${relative}`);
  if (target !== root && !target.startsWith(root + sep2)) return void 0;
  const file = target === root ? join6(root, "index.html") : target;
  return existsSync4(file) && statSync2(file).isFile() ? file : void 0;
}
function registerWebApp(app, webRoot, depsRoot) {
  const handler = async (request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Unknown API route" });
    const file = resolveWebFile(webRoot, request.url) ?? (depsRoot ? resolveWebFile(depsRoot, request.url) : void 0);
    if (!file) {
      if (!existsSync4(join6(webRoot, "index.html")))
        return reply.code(503).type("text/plain; charset=utf-8").send(
          'The LocHub web app is missing: Resources/LocHubWeb/index.html was not found in the plugin. Reinstall the plugin; in the source repository run "npm run build" in Web/.'
        );
      return reply.code(404).type("text/plain; charset=utf-8").send("Not found");
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    return reply.code(200).type(type).header("cache-control", "no-cache").send(readFileSync4(file));
  };
  app.get("/", handler);
  app.get("/*", handler);
}

// src/validate.ts
var CULTURE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
function checkCulture(store, culture, extra = []) {
  if (typeof culture !== "string" || !CULTURE_RE.test(culture)) return "Invalid culture";
  for (const existing of cultureKeysOf(store, extra)) {
    if (existing !== culture && existing.toLowerCase() === culture.toLowerCase()) return `Culture must be spelled "${existing}"`;
  }
  return null;
}
function* cultureKeysOf(store, extra) {
  yield* store.cells.keys();
  yield* store.glossary.keys();
  yield* store.style.keys();
  yield* extra;
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringMap(value) {
  return isRecord2(value) && Object.values(value).every((v) => typeof v === "string");
}
var ENTRY_STRING_FIELDS = ["namespace", "key", "source", "origin", "devNotes", "groupKey"];
function validateSnapshot(body) {
  if (!isRecord2(body)) return "Snapshot must be an object";
  if (!Array.isArray(body.entries)) return "entries must be an array";
  for (let i = 0; i < body.entries.length; i++) {
    const error = validateEntry(body.entries[i], i);
    if (error) return error;
  }
  if (body.archives !== void 0) {
    const error = validateArchives(body.archives);
    if (error) return error;
  }
  if (body.coverage !== void 0) {
    const error = validateCoverage(body.coverage);
    if (error) return error;
  }
  if (body.pluralForms !== void 0) {
    const error = validatePluralForms(body.pluralForms);
    if (error) return error;
  }
  return null;
}
function validatePluralForms(pluralForms) {
  if (!isRecord2(pluralForms)) return "pluralForms must be an object";
  const seen = /* @__PURE__ */ new Map();
  for (const [culture, forms] of Object.entries(pluralForms)) {
    if (!CULTURE_RE.test(culture)) return `pluralForms key "${culture}" is not a valid culture`;
    const existing = seen.get(culture.toLowerCase());
    if (existing !== void 0) return `pluralForms keys "${existing}" and "${culture}" differ only in case`;
    seen.set(culture.toLowerCase(), culture);
    if (!isRecord2(forms)) return `pluralForms.${culture} must be an object`;
    for (const type of ["cardinal", "ordinal"]) {
      const list = forms[type];
      const valid = Array.isArray(list) && list.length > 0 && list.every((c) => typeof c === "string" && PLURAL_CATEGORIES.has(c));
      if (!valid) return `pluralForms.${culture}.${type} must be a non-empty array of plural categories`;
    }
  }
  return null;
}
function validateEntry(entry, index) {
  if (!isRecord2(entry)) return `entries[${index}] must be an object`;
  for (const field of ENTRY_STRING_FIELDS) {
    if (typeof entry[field] !== "string") return `entries[${index}].${field} must be a string`;
  }
  if (!isStringMap(entry.metadata)) return `entries[${index}].metadata must be an object of strings`;
  return null;
}
function validateArchives(archives) {
  if (!isRecord2(archives)) return "archives must be an object";
  const seen = /* @__PURE__ */ new Map();
  for (const [culture, list] of Object.entries(archives)) {
    if (!CULTURE_RE.test(culture)) return `archives key "${culture}" is not a valid culture`;
    const lower = culture.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== void 0 && existing !== culture) return `archives keys "${existing}" and "${culture}" differ only in case`;
    seen.set(lower, culture);
    if (!Array.isArray(list)) return `archives.${culture} must be an array`;
    for (let i = 0; i < list.length; i++) {
      const error = validateArchiveEntry(list[i], culture, i);
      if (error) return error;
    }
  }
  return null;
}
function validateArchiveEntry(entry, culture, index) {
  if (!isRecord2(entry)) return `archives.${culture}[${index}] must be an object`;
  for (const field of ["namespace", "key", "translation", "source"]) {
    if (typeof entry[field] !== "string") return `archives.${culture}[${index}].${field} must be a string`;
  }
  return null;
}
var COVERAGE_STRING_FIELDS = ["kind", "file", "text"];
function validateCoverage(coverage) {
  if (!Array.isArray(coverage)) return "coverage must be an array";
  for (let i = 0; i < coverage.length; i++) {
    const finding = coverage[i];
    if (!isRecord2(finding)) return `coverage[${i}] must be an object`;
    for (const field of COVERAGE_STRING_FIELDS) {
      if (typeof finding[field] !== "string") return `coverage[${i}].${field} must be a string`;
    }
    if (typeof finding.line !== "number") return `coverage[${i}].line must be a number`;
  }
  return null;
}
function validateReconcileBody(body) {
  if (!isRecord2(body)) return "Body must be an object";
  return validateArchives(body.archives);
}
function validateExpected(body) {
  if (!isRecord2(body)) return null;
  if (body.expectedRevision !== void 0 && typeof body.expectedRevision !== "number") return "expectedRevision must be a number";
  if (body.expectedSourceRev !== void 0 && typeof body.expectedSourceRev !== "number") return "expectedSourceRev must be a number";
  return null;
}
function validateAccept(body) {
  if (!isRecord2(body) || body.accept === void 0) return null;
  if (!Array.isArray(body.accept) || !body.accept.every((code) => typeof code === "string")) return "accept must be an array of strings";
  return null;
}
function validateJobScope(body) {
  if (body.groupPrefix === void 0) return null;
  if (typeof body.groupPrefix !== "string" || body.groupPrefix.length === 0 || body.groupPrefix.length > 512) return "invalid_scope";
  if (typeof body.groupKey === "string") return "invalid_scope";
  return null;
}
function validateAck(body) {
  if (!isRecord2(body)) return "Ack must be an object";
  if (typeof body.culture !== "string") return "culture must be a string";
  if (!Array.isArray(body.written)) return "written must be an array";
  if (!Array.isArray(body.rejected)) return "rejected must be an array";
  for (let i = 0; i < body.written.length; i++) {
    const row = body.written[i];
    if (!isRecord2(row) || typeof row.unitId !== "string" || typeof row.translation !== "string")
      return `written[${i}] must have string unitId and translation`;
  }
  for (let i = 0; i < body.rejected.length; i++) {
    const row = body.rejected[i];
    if (!isRecord2(row) || typeof row.unitId !== "string" || typeof row.translation !== "string")
      return `rejected[${i}] must have string unitId and translation`;
    if (!Array.isArray(row.errors) || !row.errors.every((e) => typeof e === "string")) return `rejected[${i}].errors must be a string array`;
  }
  return null;
}

// src/server.ts
function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? fallback : Math.min(max, Math.max(min, parsed));
}
function jobOptionsFrom(body, defaults) {
  if (typeof body.culture !== "string" || body.culture.length === 0) return void 0;
  return {
    ...defaults,
    culture: body.culture,
    mode: body.mode === "sync" || body.mode === "batch" ? body.mode : defaults.mode,
    filter: {
      groupKey: typeof body.groupKey === "string" ? body.groupKey : void 0,
      groupPrefix: typeof body.groupPrefix === "string" ? body.groupPrefix : void 0,
      unitIds: Array.isArray(body.unitIds) ? body.unitIds.filter((u) => typeof u === "string") : void 0
    }
  };
}
function sendCellError(reply, error) {
  if (error instanceof StaleCellError) return reply.code(409).send({ error: "stale_cell", message: error.message, cell: error.cell, unit: error.unit });
  if (error instanceof CellActionError) return reply.code(error.statusCode).send({ error: error.message, issues: error.issues });
  throw error;
}
function buildServer(deps) {
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StoreChangedOnDiskError) return reply.code(409).send({ error: "files_changed_on_disk", message: error.message });
    reply.send(error);
  });
  const jobs = /* @__PURE__ */ new Map();
  const starting = /* @__PURE__ */ new Set();
  let jobsFinished = 0;
  const { store } = deps;
  const estimateCountCache = new TokenCountCache();
  const ai = deps.ai ?? DEFAULT_AI_CONFIG;
  const env = deps.env ?? process.env;
  const jobDefaults = deps.jobDefaults ?? jobDefaultsFor(ai);
  const briefSha1 = deps.briefSha1 ?? createHash7("sha1").update("").digest("hex");
  const subscriptionHealthPromise = ai.auth === "subscription" ? (deps.authProbe ?? (() => checkClaudeAuthStatus()))() : void 0;
  let endpointHealth = ai.custom ? { url: reduceBaseUrl(ai.custom.baseUrl), status: "checking" } : void 0;
  if (ai.custom) {
    void probeEndpoint(ai.custom, [ai.translateModel, ai.judgeModel], env.LOCHUB_API_KEY, deps.endpointFetch).then((probed) => {
      endpointHealth = probed;
    });
  }
  function cultureGuard(culture, reply) {
    const inFlight = [...starting, ...[...jobs.values()].filter((j) => j.status === "running").map((j) => j.culture)];
    const error = checkCulture(store, culture, inFlight);
    if (error) reply.code(400).send({ error });
    return error === null;
  }
  app.addHook("onRequest", async (request, reply) => {
    const host = (request.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${deps.port}` && host !== `localhost:${deps.port}`) return reply.code(403).send({ error: "Forbidden host" });
    if (request.headers["sec-fetch-site"] === "cross-site") return reply.code(403).send({ error: "cross_site" });
    if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.startsWith("application/json")) return reply.code(415).send({ error: "Content-Type must be application/json" });
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "frame-ancestors 'none'");
    return payload;
  });
  let coverage = { pushedAt: "", findings: [] };
  let lastPush = { nativeCulture: "", cultures: [] };
  function translationCultures() {
    const cultures = new Set(lastPush.cultures);
    for (const [culture, cells] of store.cells) if (cells.size > 0) cultures.add(culture);
    cultures.delete(lastPush.nativeCulture);
    return cultures;
  }
  app.get("/api/health", async () => {
    const { custom, ...aiPublic } = ai;
    const aiHealth = {
      ...aiPublic,
      batch: supportsBatch(ai),
      briefSha1,
      keyId: keyIdOf(env.LOCHUB_API_KEY),
      lengthArgs: lengthArgsOf(jobDefaults.lengthCheck),
      ...custom ? { customSettingsId: custom.settingsId } : {},
      ...endpointHealth ? { endpoint: endpointHealth } : {},
      ...subscriptionHealthPromise ? await subscriptionHealthPromise : apiKeyHealth(env, ai.provider)
    };
    return {
      ok: true,
      units: store.units.size,
      editorConnected: deps.bridge.connected > 0,
      pid: process.pid,
      projectDir: deps.projectDir ?? "",
      stale: store.changedOnDisk(),
      // The editor plugin reads this to avoid restarting the service under a running job when the AI settings
      // change. Not `starting` (being estimated, no record yet) — only a real job record.
      jobRunning: [...jobs.values()].some((j) => j.status === "running"),
      jobsFinished,
      ai: aiHealth
    };
  });
  app.post("/api/reconcile", async (request, reply) => {
    store.assertFresh();
    const validationError = validateReconcileBody(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    const { archives } = request.body;
    for (const culture of Object.keys(archives)) {
      if (!cultureGuard(culture, reply)) return;
    }
    const humanEdits = reconcileArchives(store, archives, "pull");
    store.save();
    return { humanEdits };
  });
  app.post("/api/push", async (request, reply) => {
    const dryRun = request.query.dryRun === "1";
    if (!dryRun) store.assertFresh();
    const validationError = validateSnapshot(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    const snapshot = request.body;
    const full = { archives: {}, cultures: [], nativeCulture: "en", target: "", ...snapshot };
    for (const culture of [...Object.keys(full.archives), ...Object.keys(full.pluralForms ?? {})]) {
      if (!cultureGuard(culture, reply)) return;
    }
    const report = applySnapshot(store, full, "push", { dryRun });
    if (dryRun) return report;
    if (Array.isArray(full.coverage)) coverage = { pushedAt: (/* @__PURE__ */ new Date()).toISOString(), findings: full.coverage };
    lastPush = {
      nativeCulture: typeof full.nativeCulture === "string" ? full.nativeCulture : "",
      cultures: Array.isArray(full.cultures) ? full.cultures.filter((c) => typeof c === "string") : []
    };
    store.save();
    return report;
  });
  app.get("/api/cells", async (request, reply) => {
    const q = request.query;
    const culture = q.culture;
    if (!cultureGuard(culture, reply)) return;
    const needle = q.q?.toLowerCase();
    const rows = [...store.units.values()].filter((unit) => unit.state === "active").sort((a, b) => compareCodeUnits(a.id, b.id)).map((unit) => {
      const cell = store.getCell(culture, unit.id);
      return { unit, cell, outdated: isOutdated(unit, cell) };
    }).filter(
      (row) => (!q.band || row.cell.band === q.band) && (!q.status || row.cell.status === q.status) && (!q.flag || row.cell.qaFlags.includes(q.flag)) && (!q.groupKey || row.unit.groupKey === q.groupKey) && (q.outdated !== "1" || row.outdated) && (!needle || row.unit.source.toLowerCase().includes(needle) || row.cell.text.toLowerCase().includes(needle))
    );
    const limit = intParam(q.limit, 200, 1, 1e3);
    const offset = intParam(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const page = rows.slice(offset, offset + limit).map((row) => ({ ...row, lengthLimit: lengthLimitFor(row.unit, culture, jobDefaults.lengthCheck) }));
    return { total: rows.length, rows: page };
  });
  app.post("/api/cells/:culture/:unitId/:action", async (request, reply) => {
    store.assertFresh();
    const { culture, unitId, action } = request.params;
    if (!cultureGuard(culture, reply)) return;
    const body = request.body ?? {};
    const expectedError = validateExpected(body) ?? validateAccept(body);
    if (expectedError) return reply.code(400).send({ error: expectedError });
    const accept = body.accept ?? [];
    const expected = body.expectedRevision !== void 0 || body.expectedSourceRev !== void 0 ? { revision: body.expectedRevision, sourceRev: body.expectedSourceRev } : void 0;
    const actor = typeof body.actor === "string" ? body.actor : "reviewer";
    try {
      let cell;
      if (action === "approve") cell = approveCell(store, culture, unitId, actor, expected, accept, jobDefaults.lengthCheck);
      else if (action === "edit") {
        if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
        cell = editCell(store, culture, unitId, body.text, actor, expected, accept, jobDefaults.lengthCheck);
      } else if (action === "reject") cell = rejectCell(store, culture, unitId, typeof body.note === "string" ? body.note : "", actor, expected);
      else return reply.code(404).send({ error: `Unknown action ${action}` });
      store.save();
      return { cell };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });
  app.get("/api/export", async (request, reply) => {
    const culture = request.query.culture;
    if (!cultureGuard(culture, reply)) return;
    return { culture, policy: deps.policy, entries: exportForPull(store, culture, deps.policy) };
  });
  app.post("/api/export/ack", async (request, reply) => {
    store.assertFresh();
    if (!cultureGuard(request.body?.culture, reply)) return;
    const validationError = validateAck(request.body);
    if (validationError) return reply.code(400).send({ error: validationError });
    applyExportAck(store, request.body);
    store.save();
    return { ok: true };
  });
  app.post("/api/jobs", async (request, reply) => {
    const body = request.body ?? {};
    const opts = jobOptionsFrom(body, jobDefaults);
    if (!opts) return reply.code(400).send({ error: "culture is required" });
    const scopeError = validateJobScope(body);
    if (scopeError) return reply.code(400).send({ error: scopeError });
    if (opts.mode === "batch" && !supportsBatch(ai)) return reply.code(400).send({ error: "batch_unavailable", message: BATCH_UNAVAILABLE_MESSAGE });
    if (ai.auth === "api") {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: "ai_not_ready", message: health.detail });
    }
    const skipEstimate = body.skipEstimate === true;
    if (!skipEstimate && body.maxUsd !== void 0 && !(typeof body.maxUsd === "number" && Number.isFinite(body.maxUsd) && body.maxUsd > 0)) {
      return reply.code(400).send({ error: "invalid_maxUsd", message: "maxUsd must be a finite positive number" });
    }
    if (!cultureGuard(opts.culture, reply)) return;
    const culture = opts.culture;
    if (starting.has(culture)) return reply.code(409).send({ error: "job_running" });
    const runningJob = [...jobs.values()].find((j) => j.culture === culture && j.status === "running");
    if (runningJob) return reply.code(409).send({ error: "job_running", jobId: runningJob.id });
    starting.add(culture);
    try {
      const estimate = await estimateJob(
        store,
        deps.llm,
        deps.cache,
        opts,
        billingOf(ai),
        skipEstimate ? { skipNetwork: true } : { countCache: estimateCountCache }
      );
      if (!skipEstimate && billingOf(ai) === "api" && estimate.usd !== null && estimate.usd !== 0) {
        if (typeof body.maxUsd !== "number") return reply.code(400).send({ error: "culture and maxUsd are required" });
        try {
          assertWithinBudget(estimate, body.maxUsd);
        } catch (error) {
          if (error instanceof BudgetExceededError) return reply.code(422).send({ error: "budget", message: error.message, estimate });
          throw error;
        }
      }
      const record = { id: randomUUID2(), culture, status: "running", estimate, startedAt: (/* @__PURE__ */ new Date()).toISOString() };
      jobs.set(record.id, record);
      opts.onProgress = (progress) => {
        record.progress = progress;
      };
      runTranslateJob(store, deps.llm, deps.cache, opts).then((report) => {
        record.status = "done";
        record.report = report;
        jobsFinished++;
      }).catch((error) => {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        jobsFinished++;
      });
      return reply.code(202).send({ jobId: record.id, estimate });
    } finally {
      starting.delete(culture);
    }
  });
  app.get("/api/jobs", async (request, reply) => {
    const culture = request.query.culture;
    if (!cultureGuard(culture, reply)) return;
    const records = [...jobs.values()].filter((j) => j.culture === culture);
    const running = records.find((j) => j.status === "running");
    const newest = running ?? records.reduce((best, j) => !best || j.startedAt >= best.startedAt ? j : best, void 0);
    return newest ?? reply.code(404).send({ error: "Unknown job" });
  });
  app.get("/api/jobs/:id", async (request, reply) => {
    const record = jobs.get(request.params.id);
    return record ?? reply.code(404).send({ error: "Unknown job" });
  });
  app.get("/api/glossary/:culture", async (request, reply) => {
    const { culture } = request.params;
    if (!cultureGuard(culture, reply)) return;
    return store.glossary.get(culture) ?? [];
  });
  app.put("/api/glossary/:culture", async (request, reply) => {
    store.assertFresh();
    const { culture } = request.params;
    if (!cultureGuard(culture, reply)) return;
    const terms = request.body;
    if (!Array.isArray(terms)) return reply.code(400).send({ error: "Body must be an array of terms" });
    const valid = terms.every(
      (t) => t !== null && typeof t === "object" && typeof t.term === "string" && t.term !== "" && typeof t.translation === "string" && typeof t.dnt === "boolean" && typeof t.note === "string"
    );
    if (!valid) return reply.code(400).send({ error: "Each term needs term, translation, dnt and note" });
    store.glossary.set(culture, terms);
    store.save();
    return { ok: true };
  });
  app.get("/api/bridge/stream", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const detach = attachEditorStream(deps.bridge, (chunk) => reply.raw.write(chunk));
    reply.raw.on("close", detach);
    reply.raw.on("error", detach);
  });
  app.post("/api/bridge/command", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.name !== "string" || !BRIDGE_COMMANDS.includes(body.name))
      return reply.code(400).send({ error: "Unknown command" });
    const args = body.args !== null && typeof body.args === "object" ? body.args : {};
    const delivered = deps.bridge.send({ name: body.name, args });
    if (delivered === 0) return reply.code(409).send({ error: "editor_not_connected" });
    return reply.code(202).send({ delivered });
  });
  app.get("/api/coverage", async () => coverage);
  app.post("/api/jobs/estimate", async (request, reply) => {
    const body = request.body ?? {};
    const opts = jobOptionsFrom(body, jobDefaults);
    if (!opts) return reply.code(400).send({ error: "culture is required" });
    const scopeError = validateJobScope(body);
    if (scopeError) return reply.code(400).send({ error: scopeError });
    if (opts.mode === "batch" && !supportsBatch(ai)) return reply.code(400).send({ error: "batch_unavailable", message: BATCH_UNAVAILABLE_MESSAGE });
    if (ai.auth === "api") {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: "ai_not_ready", message: health.detail });
    }
    if (!cultureGuard(opts.culture, reply)) return;
    return { estimate: await estimateJob(store, deps.llm, deps.cache, opts, billingOf(ai), { countCache: estimateCountCache }) };
  });
  app.post("/api/cells/:culture/:unitId/retranslate", async (request, reply) => {
    const { culture, unitId } = request.params;
    if (!cultureGuard(culture, reply)) return;
    if (ai.auth === "api") {
      const health = apiKeyHealth(env, ai.provider);
      if (!health.ready) return reply.code(400).send({ error: "ai_not_ready", message: health.detail });
    }
    const body = request.body ?? {};
    if (typeof body.note !== "string") return reply.code(400).send({ error: "note is required" });
    try {
      store.assertFresh();
      return await retranslateWithNote(store, deps.llm, { ...jobDefaults, culture }, unitId, body.note, body.asRule === true);
    } catch (error) {
      return sendCellError(reply, error);
    }
  });
  app.get("/api/cells/:culture/:unitId/history", async (request, reply) => {
    const { culture, unitId } = request.params;
    if (!cultureGuard(culture, reply)) return;
    return store.readEvents(culture, unitId);
  });
  app.post("/api/cells/:culture/:unitId/check", async (request, reply) => {
    const { culture, unitId } = request.params;
    if (!cultureGuard(culture, reply)) return;
    const body = request.body ?? {};
    if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
    try {
      return { issues: checkCell(store, culture, unitId, body.text, jobDefaults.lengthCheck) };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });
  app.post("/api/import", async (request, reply) => {
    try {
      const body = parseImportRequest(request.body);
      if (!cultureGuard(body.culture, reply)) return;
      if (!translationCultures().has(body.culture)) return reply.code(400).send({ error: `${body.culture} is not a translation culture of this project` });
      if (!body.dryRun) store.assertFresh();
      const check = (unit, text) => checkCell(store, body.culture, unit.id, text, jobDefaults.lengthCheck);
      return runImport(store, body, check);
    } catch (error) {
      if (error instanceof ImportRequestError) return reply.code(400).send({ error: error.message });
      if (error instanceof ImportPreviewStaleError) return reply.code(409).send({ error: "preview_stale", message: error.message, result: error.result });
      throw error;
    }
  });
  app.get("/api/style/:culture", async (request, reply) => {
    const { culture } = request.params;
    if (!cultureGuard(culture, reply)) return;
    return { text: store.style.get(culture) ?? "" };
  });
  app.put("/api/style/:culture", async (request, reply) => {
    store.assertFresh();
    const { culture } = request.params;
    if (!cultureGuard(culture, reply)) return;
    const body = request.body ?? {};
    if (typeof body.text !== "string") return reply.code(400).send({ error: "text is required" });
    store.style.set(culture, body.text);
    store.save();
    return { ok: true };
  });
  app.get("/api/inbox", async (request, reply) => {
    const q = request.query;
    if (q.culture !== void 0 && !cultureGuard(q.culture, reply)) return;
    const rows = [...store.inbox.values()].filter((item) => (!q.status || item.status === q.status) && (!q.culture || item.culture === q.culture)).sort((a, b) => compareCodeUnits(a.created, b.created) || compareCodeUnits(a.id, b.id)).map((item) => {
      const unit = store.units.get(item.unitId);
      return {
        item,
        unit: unit ? { namespace: unit.namespace, key: unit.key, source: unit.source, origin: unit.origin, devNotes: unit.devNotes } : null
      };
    });
    return { rows };
  });
  app.post("/api/inbox/applied", async (request, reply) => {
    store.assertFresh();
    const body = request.body ?? {};
    if (!Array.isArray(body.ids)) return reply.code(400).send({ error: "ids[] is required" });
    const applied = markApplied(store, body.ids.filter((id) => typeof id === "string"));
    store.save();
    return { applied };
  });
  app.post("/api/inbox/:id/:action", async (request, reply) => {
    store.assertFresh();
    const { id, action } = request.params;
    const body = request.body ?? {};
    try {
      let item;
      if (action === "answer") item = answerQuestion(store, id, typeof body.answer === "string" ? body.answer : "", (/* @__PURE__ */ new Date()).toISOString());
      else if (action === "dismiss") item = dismissQuestion(store, id);
      else return reply.code(404).send({ error: `Unknown action ${action}` });
      store.save();
      return { item };
    } catch (error) {
      return sendCellError(reply, error);
    }
  });
  app.get("/api/summary", async (request, reply) => {
    const culture = request.query.culture;
    if (!cultureGuard(culture, reply)) return;
    return summarize(store, culture);
  });
  app.get("/api/meta", async () => {
    const usable = [...translationCultures()].filter((culture) => checkCulture(store, culture) === null);
    return { nativeCulture: lastPush.nativeCulture, cultures: usable.sort(compareCodeUnits) };
  });
  app.post("/api/inbox", async (request, reply) => {
    store.assertFresh();
    const body = request.body ?? {};
    if (!cultureGuard(body.culture, reply)) return;
    if (typeof body.unitId !== "string" || typeof body.question !== "string")
      return reply.code(400).send({ error: "unitId and question are required" });
    if (!store.units.has(body.unitId)) return reply.code(404).send({ error: `Unknown unit ${body.unitId}` });
    const item = recordQuestion(store, body.culture, body.unitId, body.question, "reviewer", (/* @__PURE__ */ new Date()).toISOString());
    if (!item) return reply.code(422).send({ error: "Question is empty" });
    store.save();
    return reply.code(201).send({ item });
  });
  if (deps.webRoot) registerWebApp(app, deps.webRoot, deps.webDepsRoot);
  return app;
}

// src/cli.ts
var USAGE = "Usage: node <plugin>/Resources/LocHubService/lochub_service.mjs serve --project <ProjectDir> [--port 47810] [--policy validated|approved_only] [--provider anthropic|openai|xai|deepseek|gemini|custom] [--auth api|subscription] [--translate-model <id>] [--judge-model <id>] [--web-dir <dir>] [--web-deps-dir <dir>] [--brief-file <path>] [--base-url <url> | env LOCHUB_CUSTOM_BASE_URL] [--key-header bearer|api-key] [--structured-output json_schema|json_object|prompt_only] [--price-in <usd>] [--price-out <usd>] [--max-parallel <1-32>] [--request-timeout <30-300>] [--length-check off|warning|confirm] [--length-scope ui|all] [--length-ratio <1-5>] [--length-extra <0-100>] [--length-ratios <culture>=<ratio>,...] [--length-hint on|off]";
function readBriefFile(path) {
  const bytes = path && existsSync5(path) ? readFileSync5(path) : Buffer.alloc(0);
  const sha1 = createHash8("sha1").update(bytes).digest("hex");
  return { text: stripBom(bytes.toString("utf8")), sha1 };
}
function resolveApiKey(env) {
  return env.LOCHUB_API_KEY || void 0;
}
function resolveCustomBaseUrl(env) {
  return env.LOCHUB_CUSTOM_BASE_URL || void 0;
}
var RATIO_TEXT = /^\d+(?:\.\d+)?$/;
var EXTRA_TEXT = /^\d+$/;
var CULTURE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
function parseRatio(text) {
  if (!RATIO_TEXT.test(text)) return void 0;
  const ratio = Number(text);
  return ratio >= 1 && ratio <= 5 ? ratio : void 0;
}
function parseLengthFlags(values) {
  const flag = (name) => typeof values[name] === "string" ? values[name] : void 0;
  const mode = flag("length-check") ?? LENGTH_CHECK_OFF.mode;
  if (mode !== "off" && mode !== "warning" && mode !== "confirm") return { error: `Invalid --length-check ${mode}` };
  const scope = flag("length-scope") ?? LENGTH_CHECK_OFF.scope;
  if (scope !== "ui" && scope !== "all") return { error: `Invalid --length-scope ${scope}` };
  const ratioText = flag("length-ratio");
  const ratio = ratioText === void 0 ? LENGTH_CHECK_OFF.ratio : parseRatio(ratioText);
  if (ratio === void 0) return { error: `Invalid --length-ratio ${ratioText} (a number from 1 to 5)` };
  const extraText = flag("length-extra");
  const extra = extraText === void 0 ? LENGTH_CHECK_OFF.extra : Number(extraText);
  if (extraText !== void 0 && (!EXTRA_TEXT.test(extraText) || extra > 100))
    return { error: `Invalid --length-extra ${extraText} (a whole number from 0 to 100)` };
  const ratiosText = flag("length-ratios") ?? "";
  const ratios = {};
  const seen = /* @__PURE__ */ new Set();
  for (const pair of ratiosText === "" ? [] : ratiosText.split(",")) {
    const [culture = "", value = "", ...rest] = pair.split("=");
    const parsed = parseRatio(value);
    if (rest.length > 0 || !CULTURE_KEY.test(culture) || parsed === void 0 || seen.has(culture.toLowerCase()))
      return { error: `Invalid --length-ratios ${ratiosText} (<culture>=<ratio>,... with each culture once and ratios from 1 to 5)` };
    seen.add(culture.toLowerCase());
    ratios[culture] = parsed;
  }
  const hint = flag("length-hint") ?? (LENGTH_CHECK_OFF.hint ? "on" : "off");
  if (hint !== "on" && hint !== "off") return { error: `Invalid --length-hint ${hint}` };
  return { mode, scope, ratio, extra, ratios, hint: hint === "on" };
}
function parseCliArgs(argv, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        port: { type: "string", default: "47810" },
        policy: { type: "string", default: "validated" },
        provider: { type: "string", default: "anthropic" },
        auth: { type: "string", default: "api" },
        "translate-model": { type: "string", default: "" },
        "judge-model": { type: "string", default: "" },
        "web-dir": { type: "string", default: "" },
        "web-deps-dir": { type: "string", default: "" },
        "brief-file": { type: "string", default: "" },
        // --provider custom only; no defaults here, so "given with another provider" stays detectable.
        "base-url": { type: "string" },
        "key-header": { type: "string" },
        "structured-output": { type: "string" },
        "price-in": { type: "string" },
        "price-out": { type: "string" },
        "max-parallel": { type: "string" },
        "request-timeout": { type: "string" },
        "length-check": { type: "string" },
        "length-scope": { type: "string" },
        "length-ratio": { type: "string" },
        "length-extra": { type: "string" },
        "length-ratios": { type: "string" },
        "length-hint": { type: "string" }
      }
    });
  } catch (error) {
    return { error: `${error.message}
${USAGE}` };
  }
  const { values, positionals } = parsed;
  if (positionals[0] !== "serve" || !values.project) return { error: USAGE };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `Invalid port ${values.port}
${USAGE}` };
  if (values.policy !== "validated" && values.policy !== "approved_only") return { error: `Invalid policy ${values.policy}
${USAGE}` };
  if (!AI_PROVIDERS.includes(values.provider)) return { error: `Invalid provider ${values.provider}
${USAGE}` };
  const provider = values.provider;
  if (values.auth !== "api" && values.auth !== "subscription") return { error: `Invalid auth ${values.auth}
${USAGE}` };
  const auth = values.auth;
  if (auth === "subscription" && provider !== "anthropic") return { error: `--auth subscription is only available for --provider anthropic
${USAGE}` };
  const translateModelArg = values["translate-model"] || void 0;
  const judgeModelArg = values["judge-model"] || void 0;
  let translateModel;
  let judgeModel;
  if (provider === "anthropic") {
    translateModel = translateModelArg ?? DEFAULT_JOB_OPTIONS.translateModel;
    judgeModel = judgeModelArg ?? DEFAULT_JOB_OPTIONS.judgeModel;
  } else {
    if (!translateModelArg || !judgeModelArg) return { error: `--provider ${provider} needs --translate-model and --judge-model
${USAGE}` };
    translateModel = translateModelArg;
    judgeModel = judgeModelArg;
  }
  const customValues = {};
  for (const flag of CUSTOM_FLAGS) {
    const value = values[flag];
    if (value !== void 0) customValues[flag] = value;
  }
  let custom;
  if (provider === "custom") {
    const parsedCustom = parseCustomEndpointFlags(customValues, resolveCustomBaseUrl(env));
    if ("error" in parsedCustom) return { error: `${parsedCustom.error}
${USAGE}` };
    custom = parsedCustom;
  } else {
    const stray = CUSTOM_FLAGS.find((flag) => customValues[flag] !== void 0);
    if (stray) return { error: `--${stray} is only available for --provider custom
${USAGE}` };
  }
  const length = parseLengthFlags(values);
  if ("error" in length) return { error: `${length.error}
${USAGE}` };
  return {
    projectDir: values.project,
    port,
    host: "127.0.0.1",
    policy: values.policy,
    ai: { provider, auth, translateModel, judgeModel, ...custom ? { custom } : {} },
    length,
    ...values["web-dir"] ? { webDir: values["web-dir"] } : {},
    ...values["web-deps-dir"] ? { webDepsDir: values["web-deps-dir"] } : {},
    ...values["brief-file"] ? { briefFile: values["brief-file"] } : {}
  };
}
async function main() {
  const config = parseCliArgs(process.argv.slice(2));
  if ("error" in config) {
    console.error(config.error);
    process.exit(2);
  }
  const store = LocHubStore.load(join7(config.projectDir, "Localization", "LocHub"), join7(config.projectDir, "Saved", "LocHub", "plural_forms.json"));
  const apiKey = config.ai.auth === "api" ? resolveApiKey(process.env) : void 0;
  const llm = createLlmClient(config.ai, resolve3(config.projectDir), apiKey);
  const { text: brief, sha1: briefSha1 } = readBriefFile(config.briefFile);
  const jobDefaults = { ...jobDefaultsFor(config.ai), brief, lengthCheck: config.length };
  const app = buildServer({
    store,
    llm,
    cache: new ResponseCache(join7(config.projectDir, "Saved", "LocHub", "cache")),
    jobDefaults,
    briefSha1,
    bridge: new BridgeHub(),
    policy: config.policy,
    webRoot: config.webDir,
    webDepsRoot: config.webDepsDir,
    port: config.port,
    projectDir: resolve3(config.projectDir),
    ai: config.ai
  });
  await app.listen({ port: config.port, host: config.host });
  console.log(`LocHub listening on http://${config.host}:${config.port} (units: ${store.units.size})`);
}

// src/main.ts
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
