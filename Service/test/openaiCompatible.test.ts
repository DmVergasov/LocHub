import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { customProfileOf, OpenAiCompatibleLlmClient } from '../src/openaiCompatible.js';
import type { LlmRequest } from '../src/llm.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';
import type { CustomEndpointConfig } from '../src/customEndpoint.js';

const SCHEMA = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'], additionalProperties: false };
const PARAMS: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'gpt-6-sol',
  max_tokens: 16000,
  system: [
    { type: 'text', text: 'RULES' },
    { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ],
  messages: [{ role: 'user', content: '{"items":[]}' }],
  output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
};
const request = (customId = 'r1'): LlmRequest => ({ customId, params: PARAMS });

interface Seen { url: string; init: RequestInit }
function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const ok = (content: string, usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20 }, finish = 'stop') => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
  usage,
});
// The one resolved LOCHUB_API_KEY value (key-contract.md §1/§2), passed down explicitly regardless of provider.
const apiKey = 'test-key-not-real';

describe('OpenAiCompatibleLlmClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });


  it('sends an OpenAI chat request with a strict json_schema, max_completion_tokens and reasoning_effort', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok('{"items":[]}'));
    const client = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey });
    const [outcome] = await client.runSync([request()], 1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toEqual({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'RULES\n\nCONTEXT' },
        { role: 'user', content: '{"items":[]}' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'lochub_response', schema: SCHEMA, strict: true } },
      max_completion_tokens: 16000,
      reasoning_effort: 'low',
    });
    expect(outcome).toEqual({ customId: 'r1', kind: 'ok', text: '{"items":[]}', inputTokens: 100, outputTokens: 20 });
  });

  it('adds xAI reasoning tokens to the output count', async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 30 } };
    const { fetchImpl, seen } = fakeFetch(200, ok('{"items":[]}', usage));
    const [outcome] = await new OpenAiCompatibleLlmClient({ provider: 'xai', fetchImpl, apiKey }).runSync([request()], 1);
    expect(seen[0]!.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(outcome).toMatchObject({ kind: 'ok', outputTokens: 50 });
  });

  it('uses json_object and the schema in the system prompt for DeepSeek, with max_tokens and no effort', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok('{"items":[]}'));
    await new OpenAiCompatibleLlmClient({ provider: 'deepseek', fetchImpl, apiKey }).runSync([request()], 1);
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(seen[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toBe(`RULES\n\nCONTEXT\n\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(SCHEMA)}`);
    expect(body.max_tokens).toBe(16000);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('fails every request without a network call when no key is given', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok('{}'));
    const outcomes = await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey: undefined }).runSync([request('a'), request('b')], 2);
    expect(seen).toHaveLength(0);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        customId: outcome.customId,
        kind: 'error',
        message: `OpenAI: ${MISSING_KEY_MESSAGE}`,
        retryable: false,
      });
    }
  });

  // key-contract.md §1/§2: the service reads only LOCHUB_API_KEY, resolved once by the caller and passed down
  // explicitly (providers.ts). OPENAI_API_KEY (the SDK's own var) must never be read here, even when set.
  it('never reads OPENAI_API_KEY itself, even when it is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'k-openai-should-be-ignored');
    const { fetchImpl, seen } = fakeFetch(200, ok('{}'));
    const [outcome] = await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl }).runSync([request()], 1);
    expect(seen).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: 'error', message: `OpenAI: ${MISSING_KEY_MESSAGE}`, retryable: false });
    vi.unstubAllEnvs();
  });

  it('retries a plain 429 and 5xx, but not an exhausted balance, a 402, a 401 or a 400', async () => {
    vi.useFakeTimers();
    const cases: Array<[number, unknown, boolean]> = [
      [429, { error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, true],
      [503, { error: { message: 'Server is overloaded', code: 'server_is_overloaded' } }, true],
      [429, { error: { message: 'Credit balance exhausted', code: 'credit_balance_exhausted' } }, false],
      [429, { error: { message: 'You exceeded your quota', code: 'insufficient_quota' } }, false],
      [402, { error: { message: 'Insufficient Balance' } }, false],
      [401, { error: { message: 'Incorrect API key' } }, false],
      [400, { error: { message: 'Bad request' } }, false],
    ];
    for (const [status, body, retryable] of cases) {
      const { fetchImpl } = fakeFetch(status, body);
      const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey }).runSync([request()], 1);
      await vi.advanceTimersByTimeAsync(10_000);
      const [outcome] = await promise;
      expect(outcome).toMatchObject({ kind: 'error', retryable });
      expect((outcome as { message: string }).message).toBe(`OpenAI: ${status} ${(body as { error: { message: string } }).error.message}`);
    }
  });

  // An empty or non-JSON answer must go through the job's own missing-id retry (parseTranslatedItems finds
  // every id missing), not fail the whole group outright — same as outcomeFromMessage's Anthropic path.
  it('maps a cut-off answer to max_tokens, a content filter to refusal, and returns an empty or non-JSON answer as ok', async () => {
    const run = async (body: unknown) => (await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: fakeFetch(200, body).fetchImpl, apiKey }).runSync([request()], 1))[0];
    expect(await run(ok('{"items":', undefined, 'length'))).toEqual({ customId: 'r1', kind: 'error', message: 'max_tokens', retryable: true });
    expect(await run(ok('', undefined, 'content_filter'))).toEqual({ customId: 'r1', kind: 'refusal' });
    expect(await run({ choices: [{ message: { role: 'assistant', content: null, refusal: 'I cannot help' }, finish_reason: 'stop' }] })).toEqual({ customId: 'r1', kind: 'refusal' });
    expect(await run(ok(''))).toEqual({ customId: 'r1', kind: 'ok', text: '', inputTokens: 100, outputTokens: 20 });
    expect(await run(ok('not json'))).toEqual({ customId: 'r1', kind: 'ok', text: 'not json', inputTokens: 100, outputTokens: 20 });
  });

  // M-2: names the network-failure cause (falling back to the raw message when there is no cause.code), like the
  // Custom probe already does, instead of a bare "fetch failed" -- this applies to every provider, not just Custom.
  it('turns a network failure into a retryable error naming the reduced host and the cause', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'OpenAI: cannot reach https://api.openai.com (fetch failed)', retryable: true });
  });

  // A short rate-limit window must not exhaust the job's retry rounds instantly; the adapter's own fetch
  // retries within one round instead.
  it('retries a 429 with retry-after, then succeeds within the same runOne call', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify(ok('{"items":[]}')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(2000);
    const [outcome] = await promise;
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
  });

  it('keeps outcome order under concurrency and reports each outcome', async () => {
    const { fetchImpl } = fakeFetch(200, ok('{"items":[]}'));
    const reported: string[] = [];
    const outcomes = await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey }).runSync([request('a'), request('b'), request('c')], 2, (o) => reported.push(o.customId));
    expect(outcomes.map((o) => o.customId)).toEqual(['a', 'b', 'c']);
    expect(reported.sort()).toEqual(['a', 'b', 'c']);
  });

  it('has no batch mode and estimates input tokens locally', async () => {
    const client = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: fakeFetch(200, {}).fetchImpl, apiKey });
    await expect(client.runBatch([request()], 1000)).rejects.toThrow('Batch mode is only available for Anthropic with an API key.');
    expect(await client.countInputTokens(PARAMS)).toBe(Math.ceil(('RULES\n\nCONTEXT'.length + '{"items":[]}'.length) / 3));
  });
});

describe('OpenAiCompatibleLlmClient with a Custom endpoint', () => {
  const custom: CustomEndpointConfig = {
    baseUrl: 'http://127.0.0.1:11434/v1?token=secret-token',
    keyHeader: 'bearer',
    structuredOutput: 'json_schema',
    priceIn: 0,
    priceOut: 0,
    maxParallel: 2,
    requestTimeoutSeconds: 90,
    settingsId: 'test-settings-id',
  };
  const customClient = (patch: Partial<CustomEndpointConfig>, fetchImpl: typeof fetch, key: string | undefined = apiKey) =>
    new OpenAiCompatibleLlmClient({ provider: 'custom', custom: { ...custom, ...patch }, fetchImpl, apiKey: key });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds its profile from the endpoint settings', () => {
    expect(customProfileOf(custom)).toEqual({
      label: 'Custom',
      baseUrl: 'http://127.0.0.1:11434/v1?token=secret-token',
      schemaMode: 'json_schema',
      maxTokensField: null,
      sendsEffort: false,
      reasoningAddsToOutput: false,
      keyHeader: 'bearer',
      keyRequired: false,
      requestTimeoutMs: 90_000,
      tolerantJson: true,
      retryTimeouts: false,
    });
  });

  it('posts to <base>/chat/completions before the query, with a strict json_schema and no reasoning_effort', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok('{"items":[]}'));
    await customClient({}, fetchImpl).runSync([request()], 1);
    expect(seen[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions?token=secret-token');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      model: 'gpt-6-sol',
      messages: [
        { role: 'system', content: 'RULES\n\nCONTEXT' },
        { role: 'user', content: '{"items":[]}' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'lochub_response', schema: SCHEMA, strict: true } },
    });
  });

  // I-2: an ordinary-context vLLM/TGI deployment refuses any request whose prompt plus max_tokens exceeds its
  // context; a fixed max_tokens/max_completion_tokens of 16000 (PARAMS) would make the very first round fail.
  it('sends neither max_tokens nor max_completion_tokens (I-2), unlike a built-in provider', async () => {
    const customRun = fakeFetch(200, ok('{"items":[]}'));
    await customClient({}, customRun.fetchImpl).runSync([request()], 1);
    const customBody = JSON.parse(String(customRun.seen[0]!.init.body));
    expect(customBody).not.toHaveProperty('max_tokens');
    expect(customBody).not.toHaveProperty('max_completion_tokens');

    const openai = fakeFetch(200, ok('{"items":[]}'));
    await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: openai.fetchImpl, apiKey }).runSync([request()], 1);
    expect(JSON.parse(String(openai.seen[0]!.init.body))).toHaveProperty('max_completion_tokens', 16000);
  });

  it('sends json_object with the schema in the system prompt, and no response_format at all for prompt_only', async () => {
    const objectRun = fakeFetch(200, ok('{"items":[]}'));
    await customClient({ structuredOutput: 'json_object' }, objectRun.fetchImpl).runSync([request()], 1);
    const objectBody = JSON.parse(String(objectRun.seen[0]!.init.body));
    expect(objectBody.response_format).toEqual({ type: 'json_object' });
    expect(objectBody.messages[0].content).toBe(`RULES\n\nCONTEXT\n\nAnswer with one JSON object that matches this JSON Schema:\n${JSON.stringify(SCHEMA)}`);

    const promptRun = fakeFetch(200, ok('{"items":[]}'));
    await customClient({ structuredOutput: 'prompt_only' }, promptRun.fetchImpl).runSync([request()], 1);
    const promptBody = JSON.parse(String(promptRun.seen[0]!.init.body));
    expect(promptBody).not.toHaveProperty('response_format');
    expect(promptBody.messages[0].content).toBe(objectBody.messages[0].content);
  });

  it('sends the key as api-key for Azure, and no auth header at all without a key while still making the request', async () => {
    const azure = fakeFetch(200, ok('{"items":[]}'));
    await customClient({ keyHeader: 'api-key' }, azure.fetchImpl).runSync([request()], 1);
    const azureHeaders = azure.seen[0]!.init.headers as Record<string, string>;
    expect(azureHeaders['api-key']).toBe(apiKey);
    expect(azureHeaders).not.toHaveProperty('authorization');

    // '' (not undefined, which would pick up customClient's default key) is how the service passes "no key".
    const local = fakeFetch(200, ok('{"items":[]}'));
    const [outcome] = await customClient({}, local.fetchImpl, '').runSync([request()], 1);
    expect(local.seen).toHaveLength(1);
    const localHeaders = local.seen[0]!.init.headers as Record<string, string>;
    expect(localHeaders).not.toHaveProperty('authorization');
    expect(localHeaders).not.toHaveProperty('api-key');
    expect(outcome).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
  });

  it('pulls the JSON object out of a fenced or prose-wrapped answer, and leaves anything else to the parse-error path', async () => {
    const run = async (content: string) => (await customClient({}, fakeFetch(200, ok(content)).fetchImpl).runSync([request()], 1))[0];
    expect(await run('```json\n{"items":[]}\n```')).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
    expect(await run('Sure! Here is the result:\n{"items":[{"id":"a","translation":"{Count} left"}]}\nLet me know.')).toMatchObject({
      kind: 'ok',
      text: '{"items":[{"id":"a","translation":"{Count} left"}]}',
    });
    // No JSON object at all: the raw text goes on unchanged, and the job's parse-error path (parseTranslatedItems
    // finds every id missing) handles it exactly like a malformed answer from any other provider.
    expect(await run('I cannot translate this.')).toMatchObject({ kind: 'ok', text: 'I cannot translate this.' });
  });

  // M-4: a reasoning model with no reasoning parser (qwen3:8b, DeepSeek-R1) puts its chain of thought -- which may
  // itself contain a draft answer -- into a leading <think> block; that draft must never win over the real one.
  it('strips a leading <think> block and prefers the object carrying the request\'s expected key ("items")', async () => {
    const run = async (content: string) => (await customClient({}, fakeFetch(200, ok(content)).fetchImpl).runSync([request()], 1))[0];
    expect(await run('<think>draft: {"items":[{"id":"a","translation":"wrong"}]}</think>\n{"items":[]}')).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
    expect(await run('{"note":"scratch"} then {"items":[{"id":"a","translation":"right"}]}')).toMatchObject({
      kind: 'ok',
      text: '{"items":[{"id":"a","translation":"right"}]}',
    });
  });

  it('keeps built-in providers strict: a fenced answer is passed on as is', async () => {
    const fenced = '```json\n{"items":[]}\n```';
    const [outcome] = await new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: fakeFetch(200, ok(fenced)).fetchImpl, apiKey }).runSync([request()], 1);
    expect(outcome).toMatchObject({ kind: 'ok', text: fenced });
  });

  // M-5: a proxy that omits usage (or just completion_tokens) must not report 0 in/0 out on a priced endpoint.
  it('falls back to an approximate token count when usage is missing or incomplete', async () => {
    const noUsage = { choices: [{ message: { role: 'assistant', content: '{"items":[]}' }, finish_reason: 'stop' }] };
    const [outcome] = await customClient({}, fakeFetch(200, noUsage).fetchImpl).runSync([request()], 1);
    expect(outcome).toMatchObject({ kind: 'ok', inputTokens: Math.ceil(('RULES\n\nCONTEXT'.length + '{"items":[]}'.length) / 3), outputTokens: Math.ceil('{"items":[]}'.length / 3) });

    const partialUsage = { choices: [{ message: { role: 'assistant', content: '{"items":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 42 } };
    const [partial] = await customClient({}, fakeFetch(200, partialUsage).fetchImpl).runSync([request()], 1);
    expect(partial).toMatchObject({ kind: 'ok', inputTokens: 42, outputTokens: Math.ceil('{"items":[]}'.length / 3) });
  });

  // NB-7: a stripped <think> block was still generated (and billed): the estimate covers the raw content.
  it('estimates missing output tokens from the whole content, reasoning block included', async () => {
    const content = `<think>${'reasoning '.repeat(30)}</think>\n{"items":[]}`;
    const noUsage = { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
    const [outcome] = await customClient({}, fakeFetch(200, noUsage).fetchImpl).runSync([request()], 1);
    expect(outcome).toMatchObject({ kind: 'ok', text: '{"items":[]}', outputTokens: Math.ceil(content.length / 3) });
  });

  it('times each request out after the configured seconds, says so, and does not retry the timeout at the fetch level (I-1)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    await customClient({}, fakeFetch(200, ok('{"items":[]}')).fetchImpl).runSync([request()], 1);
    expect(timeoutSpy).toHaveBeenCalledWith(90_000);

    let calls = 0;
    const timingOut = (async () => {
      calls++;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch;
    const [outcome] = await customClient({}, timingOut).runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Custom: the request timed out after 90 seconds', retryable: true });
    // The built-in retry envelope (3 attempts) would show calls === 3; retryTimeouts: false on the Custom profile
    // returns on the very first timeout, with no backoff sleep to wait for.
    expect(calls).toBe(1);
  });

  it('keeps its own timeout sentence intact when a Base URL query value is one of its words', async () => {
    const timingOut = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch;
    const [outcome] = await customClient({ baseUrl: 'http://127.0.0.1:11434/v1?mode=after&kind=request' }, timingOut).runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Custom: the request timed out after 90 seconds', retryable: true });
  });

  // Amendment 8/NB-1: Node's fetch gives up after 300 s on its own (UND_ERR_HEADERS_TIMEOUT/UND_ERR_BODY_TIMEOUT, on
  // the error or its cause). That is the same timeout as the configured one: one fetch call, the same message, so
  // job.ts splits the group -- not "cannot reach", not three attempts, not a whole-group retry.
  for (const [code, where] of [['UND_ERR_HEADERS_TIMEOUT', 'cause'], ['UND_ERR_BODY_TIMEOUT', 'error']] as const) {
    it(`reports ${code} on the ${where} as a timeout after one fetch call`, async () => {
      let calls = 0;
      const nodeTimeout = (async () => {
        calls++;
        const failure = new TypeError('fetch failed');
        throw where === 'cause' ? Object.assign(failure, { cause: Object.assign(new Error('Timeout Error'), { code }) }) : Object.assign(failure, { code });
      }) as typeof fetch;
      const [outcome] = await customClient({}, nodeTimeout).runSync([request()], 1);
      expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Custom: the request timed out after 90 seconds', retryable: true });
      expect(calls).toBe(1);
    });
  }

  it('names Node\'s 300 s limit for a built-in provider whose own limit (10 minutes) never got the chance to fire', async () => {
    vi.useFakeTimers();
    const nodeTimeout = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    }) as typeof fetch;
    const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: nodeTimeout, apiKey }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'OpenAI: the request timed out after 5 minutes', retryable: true });
  });

  // Built-in providers keep the existing (generous, fixed) timeout envelope: only Custom's retryTimeouts is false.
  it('still retries a built-in provider\'s timeout at the fetch level', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const timingOut = (async () => {
      calls++;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch;
    const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl: timingOut, apiKey }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    expect(calls).toBe(3);
  });

  it('names the network-failure cause, like the probe (M-2), instead of a bare "fetch failed"', async () => {
    vi.useFakeTimers();
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    });
    const failing = (async () => {
      throw refused;
    }) as typeof fetch;
    const promise = customClient({}, failing).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Custom: cannot reach http://127.0.0.1:11434 (ECONNREFUSED)', retryable: true });
  });

  it('never puts the base URL path, query or credentials into an error message', async () => {
    // Not a timeout, so retryTimeouts: false does not apply here -- this is the ordinary (non-timeout) network
    // error envelope, which still retries 3 times, hence the fake timers.
    vi.useFakeTimers();
    const failing = (async () => {
      throw new TypeError('fetch failed for http://user:secret-pw@127.0.0.1:11434/v1/chat/completions?token=secret-token');
    }) as typeof fetch;
    const promise = customClient({}, failing).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome.kind).toBe('error');
    expect(JSON.stringify(outcome)).not.toContain('secret-token');
    expect(JSON.stringify(outcome)).not.toContain('secret-pw');
    expect(JSON.stringify(outcome)).not.toContain('/v1');
  });

  // M-10/amendment 5: fetch strips only Authorization on a cross-origin redirect, not api-key -- never follow one.
  it('sends redirect: "error" and reports a redirect as a non-retryable error naming what to do, after one attempt', async () => {
    const seen: RequestInit[] = [];
    const redirecting = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect, redirect mode is set to error') });
    }) as unknown as typeof fetch;
    const [outcome] = await customClient({}, redirecting).runSync([request()], 1);
    expect(seen[0]!.redirect).toBe('error');
    // NB-6: the server answers the same redirect every time -- final at the fetch level too, no retry envelope.
    expect(seen).toHaveLength(1);
    expect(outcome).toEqual({
      customId: 'r1',
      kind: 'error',
      message: 'Custom: the server replied with a redirect, which LocHub does not follow for a Custom endpoint; set Base URL to the final address',
      retryable: false,
    });
  });

  // I-4 (hard rule: a behavior without a test that fails when it breaks): the URL scrub on the HTTP-error path.
  it('scrubs the base URL out of a 404 error that echoes the request URL (I-4)', async () => {
    const notFound = fakeFetch(404, { error: { message: 'No route http://127.0.0.1:11434/v1/chat/completions?token=secret-token' } });
    const [outcome] = await customClient({}, notFound.fetchImpl).runSync([request()], 1);
    expect(outcome.kind).toBe('error');
    expect(JSON.stringify(outcome)).not.toContain('secret-token');
    expect(JSON.stringify(outcome)).not.toContain('/v1');
  });

  // M-1: not every OpenAI-compatible server answers the OpenAI error shape -- each of these must still surface a
  // usable reason instead of the generic "Custom: <status> request failed".
  describe('error reasons in non-OpenAI shapes (M-1)', () => {
    // A 5xx status is transient (isTransientStatus) and gets the normal retry envelope before this outcome is
    // ever returned; fake timers keep that fast regardless of the status under test.
    const reason = async (status: number, body: unknown) => {
      vi.useFakeTimers();
      const fetchImpl = (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
      const promise = customClient({}, fetchImpl).runSync([request()], 1);
      await vi.advanceTimersByTimeAsync(10_000);
      const [outcome] = await promise;
      return outcome;
    };

    it('reads a non-JSON body (an nginx error page)', async () => {
      const outcome = await reason(502, '<html>502 Bad Gateway</html>');
      expect(outcome).toMatchObject({ kind: 'error', message: 'Custom: 502 <html>502 Bad Gateway</html>' });
    });

    it('reads a string error (TGI)', async () => {
      const outcome = await reason(422, { error: 'Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096' });
      expect(outcome).toMatchObject({ kind: 'error', message: "Custom: 422 Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096" });
    });

    it('reads a top-level message (older vLLM)', async () => {
      const outcome = await reason(400, { message: "'max_tokens' or 'max_completion_tokens' is too large" });
      expect(outcome).toMatchObject({ kind: 'error', message: "Custom: 400 'max_tokens' or 'max_completion_tokens' is too large" });
    });

    it('reads detail (FastAPI wrappers)', async () => {
      const outcome = await reason(400, { detail: 'model not found' });
      expect(outcome).toMatchObject({ kind: 'error', message: 'Custom: 400 model not found' });
    });

    it('cuts the reason to 200 characters', async () => {
      const outcome = await reason(400, { error: { message: 'x'.repeat(500) } });
      expect((outcome as { message: string }).message.length).toBe(200);
    });
  });

  // M-9: a query string that itself contains a comma must not leak past scrubUrls's regex.
  it('scrubs the configured base URL\'s bare path/query out of an error, comma included', async () => {
    const baseUrl = 'http://127.0.0.1:11434/openai/v1?token=a,b';
    const bareEcho = fakeFetch(404, { error: { message: 'Cannot POST /openai/v1/chat/completions?token=a,b' } });
    const [outcome] = await customClient({ baseUrl }, bareEcho.fetchImpl).runSync([request()], 1);
    expect(JSON.stringify(outcome)).not.toContain('token=a,b');
    expect(JSON.stringify(outcome)).not.toContain('/openai/v1');
  });

  // NB-5: a server can echo the Base URL's query token alone, without "token=" and without any URL around it.
  it('redacts a bare query token the server echoes in its error', async () => {
    const unauthorized = fakeFetch(401, { error: { message: 'invalid token secret-token' } });
    const [outcome] = await customClient({}, unauthorized.fetchImpl).runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Custom: 401 invalid token [redacted]', retryable: false });
  });

  // M-3/amendment 4: an n-slot semaphore gates every request across jobs (concurrent runSync calls on one
  // instance), not just within one job's own `concurrency` argument.
  it('never runs more than Max Parallel Requests requests at once, across two concurrent runSync calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(JSON.stringify(ok('{"items":[]}')), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = customClient({ maxParallel: 2 }, fetchImpl);
    const requests = Array.from({ length: 4 }, (_, i) => request(`r${i}`));
    // Two separate runSync calls, as two jobs running at once would make -- each with its own (higher) job
    // concurrency, so only the client-level semaphore can be what keeps the total at maxParallel.
    await Promise.all([client.runSync(requests.slice(0, 2), 2), client.runSync(requests.slice(2), 2)]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
