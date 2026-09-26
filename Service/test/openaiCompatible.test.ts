import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleLlmClient } from '../src/openaiCompatible.js';
import type { LlmRequest } from '../src/llm.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';

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

  it('turns a network failure into a retryable error', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const promise = new OpenAiCompatibleLlmClient({ provider: 'openai', fetchImpl, apiKey }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'OpenAI: fetch failed', retryable: true });
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
