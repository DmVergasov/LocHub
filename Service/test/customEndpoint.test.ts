import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authHeaders,
  customSettingsIdOf,
  endpointUrl,
  extractJsonObject,
  isRedirectError,
  networkErrorCode,
  parseCustomEndpointFlags,
  PROBE_TIMEOUT_MS,
  probeEndpoint,
  reduceBaseUrl,
  scrubBaseUrlParts,
  scrubUrls,
  type CustomEndpointConfig,
} from '../src/customEndpoint.js';

describe('parseCustomEndpointFlags', () => {
  it('parses every flag and hashes the raw values into the settings id the editor computes', () => {
    expect(
      parseCustomEndpointFlags({
        'base-url': 'https://example.test/openai/v1',
        'key-header': 'api-key',
        'structured-output': 'prompt_only',
        'price-in': '0.15',
        'price-out': '0.6',
        'max-parallel': '4',
        'request-timeout': '120',
      }),
    ).toEqual({
      baseUrl: 'https://example.test/openai/v1',
      keyHeader: 'api-key',
      structuredOutput: 'prompt_only',
      priceIn: 0.15,
      priceOut: 0.6,
      maxParallel: 4,
      requestTimeoutSeconds: 120,
      // Cross-language vector: LocHub.CustomEndpoint.SettingsId pins the same value on the C++ side.
      settingsId: '27d001e56f42',
    });
  });

  it('defaults every flag but the base URL to the Project Settings defaults', () => {
    expect(parseCustomEndpointFlags({ 'base-url': 'http://localhost:11434/v1' })).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      keyHeader: 'bearer',
      structuredOutput: 'json_schema',
      priceIn: 0,
      priceOut: 0,
      maxParallel: 2,
      // Amendment 8: Request Timeout defaults to 300 s (Node's own fetch limit), not 600.
      requestTimeoutSeconds: 300,
      settingsId: customSettingsIdOf(['http://localhost:11434/v1', 'bearer', 'json_schema', '0', '0', '2', '300']),
    });
  });

  it('trims one trailing slash and keeps a query string', () => {
    expect(parseCustomEndpointFlags({ 'base-url': 'http://localhost:11434/v1/' })).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
    expect(parseCustomEndpointFlags({ 'base-url': 'https://example.test/openai/v1?api-version=preview' })).toMatchObject({
      baseUrl: 'https://example.test/openai/v1?api-version=preview',
    });
  });

  it('refuses a missing, non-http(s) or credential-carrying base URL, never echoing the URL', () => {
    expect(parseCustomEndpointFlags({})).toEqual({ error: 'Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL' });
    for (const url of ['localhost:11434/v1', 'ftp://example.test/v1', 'not a url']) {
      expect(parseCustomEndpointFlags({ 'base-url': url })).toEqual({ error: 'Invalid --base-url: it must start with http:// or https://' });
    }
    const withPassword = parseCustomEndpointFlags({ 'base-url': 'http://user:secret-pw@localhost:11434/v1' });
    expect(withPassword).toEqual({
      error: 'Invalid --base-url: a user name or password in the URL is not supported; set the key in Project Settings > Plugins > LocHub > AI > API Key',
    });
    expect(JSON.stringify(withPassword)).not.toContain('secret-pw');
  });

  // Amendment 1: the editor now sets LOCHUB_CUSTOM_BASE_URL for the spawn instead of a --base-url flag; a manual
  // run (Tools/media/shoot.mjs) can still use the flag, which wins when both are given.
  describe('env seam (LOCHUB_CUSTOM_BASE_URL)', () => {
    it('flag wins when both a flag and an env value are given', () => {
      expect(parseCustomEndpointFlags({ 'base-url': 'http://localhost:11434/v1' }, 'http://other-host:9999/v1')).toMatchObject({
        baseUrl: 'http://localhost:11434/v1',
      });
    });

    it('uses the env value when no flag is given', () => {
      expect(parseCustomEndpointFlags({}, 'http://localhost:11434/v1')).toMatchObject({ baseUrl: 'http://localhost:11434/v1' });
    });

    it('is required from either source, and names "Custom Base URL" (not --base-url) once the value came from the environment', () => {
      expect(parseCustomEndpointFlags({}, undefined)).toEqual({ error: 'Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL' });
      expect(parseCustomEndpointFlags({}, '')).toEqual({ error: 'Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL' });
      expect(parseCustomEndpointFlags({}, 'not a url')).toEqual({ error: 'Invalid Custom Base URL: it must start with http:// or https://' });
      const withPassword = parseCustomEndpointFlags({}, 'http://user:secret-pw@localhost:11434/v1');
      expect(withPassword).toEqual({
        error: 'Invalid Custom Base URL: a user name or password in the URL is not supported; set the key in Project Settings > Plugins > LocHub > AI > API Key',
      });
      expect(JSON.stringify(withPassword)).not.toContain('secret-pw');
    });
  });

  it('refuses unknown or out-of-range values', () => {
    const base = { 'base-url': 'http://localhost:11434/v1' };
    expect(parseCustomEndpointFlags({ ...base, 'key-header': 'x-api-key' })).toEqual({ error: 'Invalid --key-header x-api-key' });
    expect(parseCustomEndpointFlags({ ...base, 'structured-output': 'yaml' })).toEqual({ error: 'Invalid --structured-output yaml' });
    for (const price of ['-1', 'abc', '', 'Infinity']) {
      expect(parseCustomEndpointFlags({ ...base, 'price-in': price })).toEqual({ error: `Invalid --price-in ${price}` });
    }
    expect(parseCustomEndpointFlags({ ...base, 'price-out': '-0.5' })).toEqual({ error: 'Invalid --price-out -0.5' });
    for (const count of ['0', '33', '2.5', 'two']) {
      expect(parseCustomEndpointFlags({ ...base, 'max-parallel': count })).toEqual({ error: `Invalid --max-parallel ${count}` });
    }
    // Amendment 8: 30-300 -- Node's fetch gives up after 300 s on its own, so 301 and up (600, the old default,
    // 3600, the old maximum) are refused instead of silently acting as 300.
    for (const seconds of ['29', '301', '600', '3600', '60s']) {
      expect(parseCustomEndpointFlags({ ...base, 'request-timeout': seconds })).toEqual({ error: `Invalid --request-timeout ${seconds}` });
    }
    for (const seconds of ['30', '300']) {
      expect(parseCustomEndpointFlags({ ...base, 'request-timeout': seconds })).toMatchObject({ requestTimeoutSeconds: Number(seconds) });
    }
  });
});

describe('customSettingsIdOf', () => {
  it('is the first 12 hex characters of SHA-1 over the raw values joined with newlines', () => {
    const values = ['http://localhost:11434/v1', 'bearer', 'json_schema', '0', '0', '2', '600'];
    expect(customSettingsIdOf(values)).toBe(createHash('sha1').update(values.join('\n')).digest('hex').slice(0, 12));
    expect(customSettingsIdOf(values)).toBe('048a672d4a62');
  });
});

describe('reduceBaseUrl', () => {
  it('keeps only scheme://host[:port]', () => {
    expect(reduceBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(reduceBaseUrl('https://user:secret-pw@example.test:8443/openai/v1?token=secret-token#part')).toBe('https://example.test:8443');
    expect(reduceBaseUrl('https://example.test:443/v1')).toBe('https://example.test');
    expect(reduceBaseUrl('not a url')).toBe('(invalid URL)');
  });
});

describe('endpointUrl', () => {
  it('appends the route to the path, before any query string', () => {
    expect(endpointUrl('http://localhost:11434/v1', '/chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
    expect(endpointUrl('https://api.deepseek.com', '/chat/completions')).toBe('https://api.deepseek.com/chat/completions');
    expect(endpointUrl('https://example.test/openai/v1/?api-version=preview', '/models')).toBe('https://example.test/openai/v1/models?api-version=preview');
  });
});

describe('scrubUrls', () => {
  it('reduces every URL in a message and keeps a full stop after it', () => {
    expect(scrubUrls('fetch failed for http://user:secret-pw@127.0.0.1:11434/v1/chat/completions?token=secret-token, retrying')).toBe(
      'fetch failed for http://127.0.0.1:11434, retrying',
    );
    expect(scrubUrls('Cannot reach https://example.test/openai/v1?token=secret-token.')).toBe('Cannot reach https://example.test.');
    expect(scrubUrls('no url here')).toBe('no url here');
  });
});

// M-9: scrubUrls only catches a URL that carries a scheme. scrubBaseUrlParts additionally splits out the exact
// path and query of the *configured* base URL, so a bare echo (no scheme) or a literal character scrubUrls's
// regex would stop at (a comma inside a query) cannot leak either.
describe('scrubBaseUrlParts', () => {
  it('removes the configured base URL\'s bare path from a message with no scheme', () => {
    expect(scrubBaseUrlParts('Cannot POST /openai/v1/chat/completions', 'http://127.0.0.1:11434/openai/v1')).toBe('Cannot POST /chat/completions');
  });

  it('removes the exact query string by its literal value, including a comma scrubUrls\'s regex would stop at', () => {
    expect(scrubBaseUrlParts('upstream rejected /v1?token=a,b', 'http://127.0.0.1:11434/v1?token=a,b')).toBe('upstream rejected ');
  });

  it('redacts a query value only as a whole token, never inside a longer word', () => {
    const baseUrl = 'http://127.0.0.1:11434/v1?format=json&token=abc123';
    expect(scrubBaseUrlParts('json_schema is not supported', baseUrl)).toBe('json_schema is not supported');
    expect(scrubBaseUrlParts('bad token abc123; expected json', baseUrl)).toBe('bad token [redacted]; expected [redacted]');
  });

  // NB-5: a server can echo a query value alone, without its name, or percent-decoded.
  it('redacts each query value of 4+ characters echoed on its own, raw or decoded, and keeps short values and the host', () => {
    const baseUrl = 'http://127.0.0.1:11434/v1?token=abc123&tenant=my%20team&v=1';
    expect(scrubBaseUrlParts('401 invalid token abc123', baseUrl)).toBe('401 invalid token [redacted]');
    expect(scrubBaseUrlParts('unknown tenant my team (my%20team)', baseUrl)).toBe('unknown tenant [redacted] ([redacted])');
    // "1" is too short to take out of a message; the reduced URL's own host/port is never touched.
    expect(scrubBaseUrlParts('v=1 at http://127.0.0.1:11434', baseUrl)).toBe('v=1 at http://127.0.0.1:11434');
    expect(scrubBaseUrlParts('rejected 11434', 'http://127.0.0.1:11434/v1?port=11434')).toBe('rejected 11434');
  });

  it('leaves the message alone when the base URL has no path or query, or is not itself a valid URL', () => {
    expect(scrubBaseUrlParts('hello /v1 world', 'http://127.0.0.1:11434')).toBe('hello /v1 world');
    expect(scrubBaseUrlParts('hello world', 'not a url')).toBe('hello world');
  });
});

describe('isRedirectError', () => {
  it('matches "redirect" in the error message or its cause, and nothing else', () => {
    expect(isRedirectError(Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect, redirect mode is set to error') }))).toBe(true);
    expect(isRedirectError(new Error('Redirect count exceeded'))).toBe(true);
    expect(isRedirectError(new TypeError('fetch failed'))).toBe(false);
    expect(isRedirectError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
  });
});

describe('networkErrorCode', () => {
  it('prefers cause.code, then falls back to the error message', () => {
    expect(networkErrorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('ECONNREFUSED');
    expect(networkErrorCode(new TypeError('fetch failed'))).toBe('fetch failed');
  });
});

describe('authHeaders', () => {
  it('sends Authorization: Bearer or api-key, and nothing without a key', () => {
    expect(authHeaders('bearer', 'test-key-not-real')).toEqual({ authorization: 'Bearer test-key-not-real' });
    expect(authHeaders('api-key', 'test-key-not-real')).toEqual({ 'api-key': 'test-key-not-real' });
    expect(authHeaders('bearer', undefined)).toEqual({});
    expect(authHeaders('api-key', '')).toEqual({});
  });
});

describe('extractJsonObject', () => {
  it('takes the JSON object out of a Markdown fence', () => {
    expect(extractJsonObject('```json\n{"items":[]}\n```')).toBe('{"items":[]}');
  });

  it('takes the JSON object out of prose, ignoring braces inside JSON strings', () => {
    // One unbalanced '}' inside a JSON string: a scanner that counts it would close the object too early.
    const json = '{"items":[{"id":"a","translation":"Only } left"}]}';
    expect(extractJsonObject(`Sure! Here it is:\n${json}\nHope this helps.`)).toBe(json);
  });

  it('skips a balanced brace pair that is not JSON and takes the next object', () => {
    expect(extractJsonObject('Keep {name} as is. {"items":[]}')).toBe('{"items":[]}');
    expect(extractJsonObject('{"a":1} and then {"b":2}')).toBe('{"a":1}');
  });

  it('returns undefined when there is no complete JSON object', () => {
    expect(extractJsonObject('I cannot translate this.')).toBeUndefined();
    expect(extractJsonObject('{"items": [')).toBeUndefined();
  });

  // M-4: a reasoning model with no reasoning parser (qwen3:8b, DeepSeek-R1) puts its whole chain of thought,
  // including a draft answer, into a leading <think> block ahead of the real answer.
  it('strips a leading <think> block before looking for the JSON object', () => {
    expect(extractJsonObject('<think>maybe {"items":[{"id":"a","translation":"draft"}]}</think>\n{"items":[]}')).toBe('{"items":[]}');
    expect(extractJsonObject('  <think>\nplanning...\n</think>{"items":[]}')).toBe('{"items":[]}');
  });

  it('prefers the balanced object carrying the expected top-level key over the first one', () => {
    // The draft inside <think> is stripped first, so this also proves expectedKey is not needed to survive it --
    // but a model can still put an unrelated object (a scratch note) ahead of the real answer outside any block.
    expect(extractJsonObject('{"note":"scratch"} then {"items":[{"id":"a","translation":"x"}]}', 'items')).toBe(
      '{"items":[{"id":"a","translation":"x"}]}',
    );
    // No object carries the key: falls back to the first parseable one, same as no expectedKey at all.
    expect(extractJsonObject('{"a":1} and then {"b":2}', 'items')).toBe('{"a":1}');
  });
});

describe('probeEndpoint', () => {
  const custom: CustomEndpointConfig = {
    baseUrl: 'http://127.0.0.1:11434/v1?token=secret-token',
    keyHeader: 'bearer',
    structuredOutput: 'json_schema',
    priceIn: 0,
    priceOut: 0,
    maxParallel: 2,
    requestTimeoutSeconds: 600,
    settingsId: 'test-settings-id',
  };
  const HOST = 'http://127.0.0.1:11434';
  const reply = (status: number, body: unknown) =>
    (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
  const failing = (error: Error) =>
    (async () => {
      throw error;
    }) as unknown as typeof fetch;
  const models = (...ids: string[]) => ({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks GET <base>/models once, before the query, with the configured auth header and a 10 s timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(models('qwen3:8b')), { status: 200 });
    }) as typeof fetch;
    await probeEndpoint({ ...custom, keyHeader: 'api-key' }, ['qwen3:8b'], 'test-key-not-real', fetchImpl);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/v1/models?token=secret-token');
    expect(seen[0]!.init.method).toBe('GET');
    expect(seen[0]!.init.headers).toEqual({ 'api-key': 'test-key-not-real' });
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it("is ok when every configured model is listed, accepting Ollama's :latest tag for a bare model name", async () => {
    expect(await probeEndpoint(custom, ['qwen3:8b', 'qwen3:8b'], undefined, reply(200, models('qwen3:8b')))).toEqual({ url: HOST, status: 'ok' });
    expect(await probeEndpoint(custom, ['llama3.2', 'qwen3:8b'], undefined, reply(200, models('llama3.2:latest', 'qwen3:8b')))).toEqual({ url: HOST, status: 'ok' });
  });

  it('lists the configured models the endpoint does not serve', async () => {
    expect(await probeEndpoint(custom, ['qwen3:8b', 'llama3.2:70b'], undefined, reply(200, models('qwen3:8b')))).toEqual({
      url: HOST,
      status: 'model_missing',
      detail: 'http://127.0.0.1:11434 does not list llama3.2:70b.',
      missingModels: ['llama3.2:70b'],
    });
  });

  it('reports a network error, a timeout and a rejected key as unreachable, never with the key or the full URL', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    });
    expect(await probeEndpoint(custom, ['qwen3:8b'], undefined, failing(refused))).toEqual({
      url: HOST,
      status: 'unreachable',
      detail: 'Cannot reach http://127.0.0.1:11434 (ECONNREFUSED).',
    });
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(await probeEndpoint(custom, ['qwen3:8b'], undefined, failing(timeout))).toEqual({
      url: HOST,
      status: 'unreachable',
      detail: 'http://127.0.0.1:11434 did not answer within 10 seconds.',
    });
    for (const status of [401, 403]) {
      const rejected = await probeEndpoint(custom, ['qwen3:8b'], 'test-key-not-real', reply(status, { error: { message: 'Incorrect API key provided: test-key-not-real' } }));
      expect(rejected).toEqual({ url: HOST, status: 'unreachable', detail: `http://127.0.0.1:11434 refused the request (HTTP ${status}): check API Key and Key Header.` });
    }
    const leaky = await probeEndpoint(custom, ['qwen3:8b'], undefined, failing(new TypeError('fetch failed for http://127.0.0.1:11434/v1/models?token=secret-token')));
    expect(leaky.status).toBe('unreachable');
    expect(JSON.stringify(leaky)).not.toContain('secret-token');
    expect(JSON.stringify(leaky)).not.toContain('/v1');
  });

  // M-10/amendment 5: never follow a redirect (fetch forwards api-key, unlike Authorization, cross-origin).
  it('sends redirect: "error" and reports a redirect as unreachable, naming what to do', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect, redirect mode is set to error') });
    }) as unknown as typeof fetch;
    const result = await probeEndpoint(custom, ['qwen3:8b'], undefined, fetchImpl);
    expect(seen[0]!.redirect).toBe('error');
    expect(result).toEqual({
      url: HOST,
      status: 'unreachable',
      // NB-6: one sentence with the URL as its subject, like its siblings ("... did not answer within 10 seconds.").
      detail: `${HOST} replied with a redirect, which LocHub does not follow for a Custom endpoint; set Base URL to the final address.`,
    });
  });

  it('reports a server without a readable model list as unknown', async () => {
    for (const status of [404, 405]) {
      expect(await probeEndpoint(custom, ['qwen3:8b'], undefined, reply(status, { error: 'not found' }))).toEqual({
        url: HOST,
        status: 'unknown',
        detail: `http://127.0.0.1:11434 has no model list LocHub can read (GET /models answered HTTP ${status}).`,
      });
    }
    for (const body of ['<html>not json</html>', { models: [] }]) {
      expect(await probeEndpoint(custom, ['qwen3:8b'], undefined, reply(200, body))).toEqual({
        url: HOST,
        status: 'unknown',
        detail: 'http://127.0.0.1:11434 has no model list LocHub can read (GET /models returned no model list).',
      });
    }
  });
});
