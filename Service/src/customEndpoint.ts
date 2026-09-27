import { createHash } from 'node:crypto';
import type { EndpointHealth, EndpointStatus } from './contract.js';
import { redactSecrets } from './llmShared.js';

// The Custom (OpenAI-compatible) provider: any server that speaks the OpenAI Chat Completions API -- a local model
// (Ollama, LM Studio, llama.cpp server, vLLM), a router (OpenRouter) or a private deployment (Azure OpenAI v1).
// Everything here is specific to that provider and independent of the chat adapter (openaiCompatible.ts).

// Wire values of --key-header and --structured-output (ULocHubSettings::CustomKeyHeaderToString /
// StructuredOutputToString on the editor side).
export type CustomKeyHeader = 'bearer' | 'api-key';
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'prompt_only';

const CUSTOM_KEY_HEADERS: readonly string[] = ['bearer', 'api-key'];
const STRUCTURED_OUTPUT_MODES: readonly string[] = ['json_schema', 'json_object', 'prompt_only'];

// The serve flags only --provider custom accepts, in the order customSettingsIdOf hashes their values.
export const CUSTOM_FLAGS = ['base-url', 'key-header', 'structured-output', 'price-in', 'price-out', 'max-parallel', 'request-timeout'] as const;
export type CustomFlag = (typeof CUSTOM_FLAGS)[number];

// What an absent flag reads as: the Project Settings defaults. The editor always passes every flag; a hand-typed
// serve line may not.
const CUSTOM_FLAG_DEFAULTS: Readonly<Record<Exclude<CustomFlag, 'base-url'>, string>> = {
  'key-header': 'bearer',
  'structured-output': 'json_schema',
  'price-in': '0',
  'price-out': '0',
  'max-parallel': '2',
  'request-timeout': '300',
};

// Amendment 8: Node's fetch gives up on its own after NODE_FETCH_TIMEOUT_MS (300 s, llmShared.ts), so a larger
// Request Timeout never took effect; the editor's setting and its clamp use the same range.
const REQUEST_TIMEOUT_MIN_SECONDS = 30;
const REQUEST_TIMEOUT_MAX_SECONDS = 300;

export interface CustomEndpointConfig {
  // http(s) URL with one trailing '/' trimmed; may carry a path and a query string. Never sent over HTTP or logged
  // as is: reduceBaseUrl is the only form that leaves the process.
  baseUrl: string;
  keyHeader: CustomKeyHeader;
  structuredOutput: StructuredOutputMode;
  // USD per 1M tokens, for both the translate and the judge model (estimate.ts).
  priceIn: number;
  priceOut: number;
  // Caps the job's request concurrency (providers.ts jobDefaultsFor).
  maxParallel: number;
  requestTimeoutSeconds: number;
  // customSettingsIdOf over the raw flag values; /api/health reports it as ai.customSettingsId so the editor can
  // tell whether its Custom settings are the ones running (FLocHubServiceProcess::IsAiConfigApplied).
  settingsId: string;
}

// First 12 lowercase hex characters of SHA-1 over the raw flag values (as received, before any parsing) joined
// with '\n', in CUSTOM_FLAGS order. The editor hashes the same strings it put on the command line
// (FLocHubServiceProcess::ComputeCustomSettingsId), so neither side has to agree on how a number is formatted.
// Test vector: http://localhost:11434/v1, bearer, json_schema, 0, 0, 2, 600 -> '048a672d4a62'.
export function customSettingsIdOf(rawValues: readonly string[]): string {
  return createHash('sha1').update(rawValues.join('\n'), 'utf8').digest('hex').slice(0, 12);
}

function parsePrice(text: string): number | undefined {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseIntInRange(text: string, min: number, max: number): number | undefined {
  const value = Number(text);
  return /^\d+$/.test(text) && value >= min && value <= max ? value : undefined;
}

// Validates the custom flags cli.ts collected. The base URL itself never goes into an error text: it may carry a
// password or a token in its query.
//
// Amendment 1 (final review, 2026-09-27): the editor no longer puts the Base URL on the command line -- it sets
// LOCHUB_CUSTOM_BASE_URL for the spawn exactly like LOCHUB_API_KEY (Windows logs a failed CreateProcess's whole
// command line; macOS's argument splitter drops a value ending in '='). `envBaseUrl` is that variable's value,
// read and passed in by cli.ts (resolveCustomBaseUrl) so this parser stays pure -- it never reads process.env
// itself. `--base-url` still wins when both are given (manual runs, Tools/media/shoot.mjs); its error texts name
// "--base-url" when the value came from the flag and "Custom Base URL" when it came from the environment, since
// there is no flag to point the user at in that case.
export function parseCustomEndpointFlags(values: Partial<Record<CustomFlag, string>>, envBaseUrl?: string): CustomEndpointConfig | { error: string } {
  const raw = (flag: Exclude<CustomFlag, 'base-url'>): string => values[flag] ?? CUSTOM_FLAG_DEFAULTS[flag];
  const flagBaseUrl = values['base-url'];
  const usingEnv = flagBaseUrl === undefined && envBaseUrl !== undefined && envBaseUrl !== '';
  const baseUrlRaw = flagBaseUrl ?? envBaseUrl ?? '';
  const baseUrlLabel = usingEnv ? 'Custom Base URL' : '--base-url';
  if (baseUrlRaw === '') return { error: 'Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL' };
  let parsed: URL | undefined;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { error: `Invalid ${baseUrlLabel}: it must start with http:// or https://` };
  }
  // fetch refuses a URL with credentials, and the editor would have put them on a command line.
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: `Invalid ${baseUrlLabel}: a user name or password in the URL is not supported; set the key in Project Settings > Plugins > LocHub > AI > API Key` };
  }
  const keyHeader = raw('key-header');
  if (!CUSTOM_KEY_HEADERS.includes(keyHeader)) return { error: `Invalid --key-header ${keyHeader}` };
  const structuredOutput = raw('structured-output');
  if (!STRUCTURED_OUTPUT_MODES.includes(structuredOutput)) return { error: `Invalid --structured-output ${structuredOutput}` };
  const priceIn = parsePrice(raw('price-in'));
  if (priceIn === undefined) return { error: `Invalid --price-in ${raw('price-in')}` };
  const priceOut = parsePrice(raw('price-out'));
  if (priceOut === undefined) return { error: `Invalid --price-out ${raw('price-out')}` };
  const maxParallel = parseIntInRange(raw('max-parallel'), 1, 32);
  if (maxParallel === undefined) return { error: `Invalid --max-parallel ${raw('max-parallel')}` };
  const requestTimeoutSeconds = parseIntInRange(raw('request-timeout'), REQUEST_TIMEOUT_MIN_SECONDS, REQUEST_TIMEOUT_MAX_SECONDS);
  if (requestTimeoutSeconds === undefined) return { error: `Invalid --request-timeout ${raw('request-timeout')}` };
  return {
    baseUrl: baseUrlRaw.endsWith('/') ? baseUrlRaw.slice(0, -1) : baseUrlRaw,
    keyHeader: keyHeader as CustomKeyHeader,
    structuredOutput: structuredOutput as StructuredOutputMode,
    priceIn,
    priceOut,
    maxParallel,
    requestTimeoutSeconds,
    settingsId: customSettingsIdOf([baseUrlRaw, keyHeader, structuredOutput, raw('price-in'), raw('price-out'), raw('max-parallel'), raw('request-timeout')]),
  };
}

// scheme://host[:port] of a base URL: never its path, query, fragment or user info. The only form of a Custom base
// URL that may reach /api/health, an error text or a log line.
export function reduceBaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(invalid URL)';
  }
}

// The route goes at the end of the path and before the query string, so a base URL such as
// https://host/openai/v1?api-version=preview keeps working.
export function endpointUrl(baseUrl: string, path: '/chat/completions' | '/models'): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  return url.toString();
}

// Every http(s) URL in a message, reduced to scheme://host[:port]: an error from fetch or from the server can echo
// the request URL, and a Custom base URL may carry a token in its query or credentials in its authority.
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>,;)]+/gi, (match) => {
    // A sentence may end right after the URL: keep its full stop outside the URL.
    const url = match.replace(/\.+$/, '');
    return reduceBaseUrl(url) + match.slice(url.length);
  });
}

// M-9: scrubUrls only recognizes a URL that carries a scheme. A server can also echo the configured Base URL's
// own path or query with no scheme at all (a bare "Cannot POST /openai/v1/chat/completions", a redirect
// Location value) -- these are split out by their exact string, the same way redactSecrets splits out the key's
// exact value, so a literal character in the query (a comma, for example) cannot defeat a regex-based match.
//
// NB-5: a query value (a token, say) can also be echoed on its own, without its `name=` ("401 invalid token
// abc123"), or percent-decoded. Every value of at least MIN_SCRUBBED_QUERY_VALUE_LENGTH characters is therefore
// replaced with [redacted] as well, both as written in the Base URL and decoded, in one pass (longest first, so a
// value inside another one cannot leave a fragment behind). A shorter value ("v=1") is too common a string to take
// out of a message without mangling it, and one that is part of the reduced URL (its host or port) stays: that
// form is shown anyway.
const MIN_SCRUBBED_QUERY_VALUE_LENGTH = 4;

export function scrubBaseUrlParts(text: string, baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return text;
  }
  let out = text;
  if (parsed.search !== '') out = out.split(parsed.search).join('');
  if (parsed.pathname !== '' && parsed.pathname !== '/') out = out.split(parsed.pathname).join('');
  const reduced = reduceBaseUrl(baseUrl);
  const values = new Set<string>(parsed.searchParams.values());
  for (const pair of parsed.search.slice(1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq !== -1) values.add(pair.slice(eq + 1));
  }
  const secrets = [...values]
    .filter((value) => value.length >= MIN_SCRUBBED_QUERY_VALUE_LENGTH && !reduced.includes(value))
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return out;
  // Whole tokens only: a value such as "json" (from ?format=json) must not eat "json_schema" in a server's reason.
  const alternatives = secrets.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`(?<![A-Za-z0-9_-])(?:${alternatives})(?![A-Za-z0-9_-])`, 'g');
  return out.replace(pattern, '[redacted]');
}

// Amendment 5 (final review, 2026-09-27): shown to the user when a Custom endpoint answers with a redirect --
// never followed, since fetch forwards every header but Authorization to the redirect target (M-10), including
// the api-key header this feature can send.
// The probe puts the reduced URL in front of REDIRECT_REASON ("http://host:port replied with a redirect, ..."), the
// chat path the words "the server" (REDIRECT_MESSAGE) -- the same sentence either way.
const REDIRECT_REASON = 'replied with a redirect, which LocHub does not follow for a Custom endpoint; set Base URL to the final address';
export const REDIRECT_MESSAGE = `the server ${REDIRECT_REASON}`;

// True when fetch's own redirect: 'error' mode aborted the request because the server answered with a 3xx.
// The exact error shape for this case is not part of the fetch spec (unlike a genuine network failure's
// cause.code), so this matches loosely on "redirect" in the error or its cause instead of a fixed shape.
export function isRedirectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return /redirect/i.test(message) || /redirect/i.test(causeMessage);
}

// Azure OpenAI takes the key in api-key; other OpenAI-compatible servers in Authorization: Bearer. No key, no
// header at all: a local server usually needs none, and some reject an empty bearer token.
export function authHeaders(keyHeader: CustomKeyHeader, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return keyHeader === 'api-key' ? { 'api-key': apiKey } : { authorization: `Bearer ${apiKey}` };
}

// Index of the '}' that closes the '{' at `start`, skipping braces inside JSON strings; -1 when it never closes.
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A reasoning model served without a reasoning parser (qwen3:8b, DeepSeek-R1) puts its whole chain of thought
// into content as a leading <think>...</think> block, which may itself contain a draft JSON object -- that draft
// must never win over the real answer that follows. Only a leading block is stripped: one appearing after real
// content is part of the answer, not a preamble.
const LEADING_THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>/i;

// Custom endpoints only (OpenAiCompatibleProfile.tolerantJson): many local models wrap their JSON in a Markdown
// fence or a sentence of prose even when asked not to. Strips a leading <think> block, then returns the first
// balanced top-level {...} that parses as JSON and carries `expectedKey` (when given) over one that does not; falls
// back to the first parseable object when none carries it, or undefined when there is no complete JSON object at
// all -- the caller then keeps the raw text and the job's own parse-error path applies.
export function extractJsonObject(text: string, expectedKey?: string): string | undefined {
  const withoutThink = text.replace(LEADING_THINK_BLOCK, '');
  let start = withoutThink.indexOf('{');
  let firstParseable: string | undefined;
  while (start !== -1) {
    const end = balancedObjectEnd(withoutThink, start);
    // An opening brace that never closes swallows the rest of the text: nothing after it is top-level.
    if (end === -1) break;
    const candidate = withoutThink.slice(start, end + 1);
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (firstParseable === undefined) firstParseable = candidate;
      if (expectedKey !== undefined && parsed !== null && typeof parsed === 'object' && expectedKey in (parsed as Record<string, unknown>)) {
        return candidate;
      }
    } catch {
      // Balanced but not JSON (prose such as "{name}"): the next top-level object starts after it.
    }
    start = withoutThink.indexOf('{', end + 1);
  }
  return firstParseable;
}

// How long the startup GET {base}/models may take before the endpoint counts as unreachable.
export const PROBE_TIMEOUT_MS = 10_000;

// Ollama lists "llama3.2:latest" for a model the user typed as "llama3.2", and its chat route accepts both.
function isListed(model: string, listed: ReadonlySet<string>): boolean {
  return listed.has(model) || (!model.includes(':') && listed.has(`${model}:latest`));
}

// Node's fetch reports a refused or unresolvable host as TypeError('fetch failed') with the reason in cause.code.
// Exported so the chat path (openaiCompatible.ts, M-2) can name the same cause the probe already does, instead of
// losing it behind a bare "fetch failed".
export function networkErrorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return error instanceof Error ? error.message : String(error);
}

// The ids of an OpenAI-style model list ({ data: [{ id }] }), or undefined when the body is not one.
function modelIdsOf(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

// One GET {base}/models at service start (server.ts), never blocking readiness: tells the user early that the
// endpoint is down, rejects the key, or does not serve the configured models. Never throws; every detail it returns
// is redacted and carries only the reduced URL.
export async function probeEndpoint(
  custom: CustomEndpointConfig,
  models: readonly string[],
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<EndpointHealth> {
  const url = reduceBaseUrl(custom.baseUrl);
  const result = (status: EndpointStatus, detail?: string, missingModels?: string[]): EndpointHealth => ({
    url,
    status,
    ...(detail === undefined ? {} : { detail: scrubUrls(redactSecrets(detail)) }),
    ...(missingModels === undefined ? {} : { missingModels }),
  });
  let response: Response;
  try {
    response = await fetchImpl(endpointUrl(custom.baseUrl, '/models'), {
      method: 'GET',
      headers: authHeaders(custom.keyHeader, apiKey),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (timedOut) return result('unreachable', `${url} did not answer within 10 seconds.`);
    if (isRedirectError(error)) return result('unreachable', `${url} ${REDIRECT_REASON}.`);
    return result('unreachable', `Cannot reach ${url} (${networkErrorCode(error)}).`);
  }
  if (response.status === 401 || response.status === 403) {
    return result('unreachable', `${url} refused the request (HTTP ${response.status}): check API Key and Key Header.`);
  }
  const noModelList = (why: string) => result('unknown', `${url} has no model list LocHub can read (GET /models ${why}).`);
  if (!response.ok) return noModelList(`answered HTTP ${response.status}`);
  let listedIds: string[] | undefined;
  try {
    listedIds = modelIdsOf(await response.json());
  } catch {
    listedIds = undefined;
  }
  if (!listedIds) return noModelList('returned no model list');
  const listed = new Set(listedIds);
  const missing = [...new Set(models)].filter((model) => !isListed(model, listed));
  if (missing.length === 0) return result('ok');
  return result('model_missing', `${url} does not list ${missing.join(', ')}.`, missing);
}
