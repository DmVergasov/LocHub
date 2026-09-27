import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiLlmClient } from '../src/gemini.js';
import type { LlmRequest } from '../src/llm.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';

const SCHEMA = { type: 'object', properties: { items: { type: 'array' } }, required: ['items'], additionalProperties: false };
const PARAMS: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'gemini-3.8-flash',
  max_tokens: 16000,
  system: [
    { type: 'text', text: 'RULES' },
    { type: 'text', text: 'CONTEXT' },
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
const ok = (parts: Array<{ text: string; thought?: boolean }>, finishReason = 'STOP') => ({
  candidates: [{ content: { role: 'model', parts }, finishReason }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 7 },
});

describe('GeminiLlmClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });


  it('sends generateContent with the key header, system instruction and responseJsonSchema', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok([{ text: '{"items":[]}' }]));
    const [outcome] = await new GeminiLlmClient({ fetchImpl, apiKey: 'k-gemini' }).runSync([request()], 1);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect((seen[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('k-gemini');
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      systemInstruction: { parts: [{ text: 'RULES\n\nCONTEXT' }] },
      contents: [{ role: 'user', parts: [{ text: '{"items":[]}' }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: SCHEMA, maxOutputTokens: 16000 },
    });
    expect(outcome).toEqual({ customId: 'r1', kind: 'ok', text: '{"items":[]}', inputTokens: 100, outputTokens: 27 });
  });

  // key-contract.md §1/§2: the service reads only LOCHUB_API_KEY, resolved once by the caller and passed down
  // explicitly (providers.ts). GOOGLE_API_KEY/GEMINI_API_KEY (the SDK's own vars) must never be read here, even
  // when set in the process environment and no apiKey option is given.
  it('never reads GOOGLE_API_KEY or GEMINI_API_KEY itself, even when they are set', async () => {
    vi.stubEnv('GOOGLE_API_KEY', 'k-google');
    vi.stubEnv('GEMINI_API_KEY', 'k-gemini');
    const { fetchImpl, seen } = fakeFetch(200, ok([{ text: '{}' }]));
    const [outcome] = await new GeminiLlmClient({ fetchImpl }).runSync([request()], 1);
    expect(seen).toHaveLength(0);
    expect(outcome).toMatchObject({ kind: 'error', message: `Gemini: ${MISSING_KEY_MESSAGE}`, retryable: false });
    vi.unstubAllEnvs();
  });

  it('skips thought parts and joins the answer parts', async () => {
    const { fetchImpl } = fakeFetch(200, ok([{ text: 'thinking...', thought: true }, { text: '{"items"' }, { text: ':[]}' }]));
    const [outcome] = await new GeminiLlmClient({ fetchImpl, apiKey: 'k' }).runSync([request()], 1);
    expect(outcome).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
  });

  it('fails without a network call when no key is given', async () => {
    const { fetchImpl, seen } = fakeFetch(200, ok([{ text: '{}' }]));
    const [outcome] = await new GeminiLlmClient({ fetchImpl }).runSync([request()], 1);
    expect(seen).toHaveLength(0);
    expect(outcome).toEqual({
      customId: 'r1',
      kind: 'error',
      message: `Gemini: ${MISSING_KEY_MESSAGE}`,
      retryable: false,
    });
  });

  it('maps errors, blocks, safety stops and cut-off answers', async () => {
    vi.useFakeTimers();
    const run = async (status: number, body: unknown) => {
      const promise = new GeminiLlmClient({ fetchImpl: fakeFetch(status, body).fetchImpl, apiKey: 'k' }).runSync([request()], 1);
      await vi.advanceTimersByTimeAsync(10_000);
      return (await promise)[0];
    };
    expect(await run(429, { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } })).toEqual({ customId: 'r1', kind: 'error', message: 'Gemini: 429 Resource exhausted', retryable: true });
    expect(await run(503, { error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' } })).toMatchObject({ kind: 'error', retryable: true });
    expect(await run(403, { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } })).toMatchObject({ kind: 'error', retryable: false });
    expect(await run(400, { error: { code: 400, message: 'Bad request', status: 'INVALID_ARGUMENT' } })).toMatchObject({ kind: 'error', retryable: false });
    expect(await run(200, { promptFeedback: { blockReason: 'SAFETY' } })).toEqual({ customId: 'r1', kind: 'refusal' });
    expect(await run(200, ok([{ text: '' }], 'SAFETY'))).toEqual({ customId: 'r1', kind: 'refusal' });
    // RECITATION: Gemini withheld the answer for quoting training data verbatim -- a content block, not a broken reply.
    expect(await run(200, ok([{ text: '' }], 'RECITATION'))).toEqual({ customId: 'r1', kind: 'refusal' });
    expect(await run(200, ok([{ text: '{"items":' }], 'MAX_TOKENS'))).toEqual({ customId: 'r1', kind: 'error', message: 'max_tokens', retryable: true });
  });

  // An empty or non-JSON answer must go through the job's own missing-id retry (parseTranslatedItems finds
  // every id missing), not fail the whole group outright — same as outcomeFromMessage's Anthropic path.
  it('returns an empty or non-JSON answer as ok instead of a final error', async () => {
    const run = async (parts: Array<{ text: string; thought?: boolean }>) =>
      (await new GeminiLlmClient({ fetchImpl: fakeFetch(200, ok(parts)).fetchImpl, apiKey: 'k' }).runSync([request()], 1))[0];
    expect(await run([{ text: '' }])).toEqual({ customId: 'r1', kind: 'ok', text: '', inputTokens: 100, outputTokens: 27 });
    expect(await run([{ text: 'nope' }])).toEqual({ customId: 'r1', kind: 'ok', text: 'nope', inputTokens: 100, outputTokens: 27 });
  });

  // A short rate-limit window must not exhaust the job's retry rounds instantly; the adapter's own fetch
  // retries within one round instead.
  it('retries a 429 with retry-after, then succeeds within the same runOne call', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'retry-after': '2' } });
      return new Response(JSON.stringify(ok([{ text: '{"items":[]}' }])), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const promise = new GeminiLlmClient({ fetchImpl, apiKey: 'k' }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(2000);
    const [outcome] = await promise;
    expect(calls).toBe(2);
    expect(outcome).toMatchObject({ kind: 'ok', text: '{"items":[]}' });
  });

  // Amendment 8: Node's own fetch timeout is reported as the timeout it is (job.ts splits on it), naming Node's 300 s
  // limit -- not as a bare "fetch failed" that job.ts would resend whole every round.
  it('reports Node\'s fetch timeout as a timeout naming the limit that fired', async () => {
    vi.useFakeTimers();
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) });
    }) as typeof fetch;
    const promise = new GeminiLlmClient({ fetchImpl, apiKey: 'k' }).runSync([request()], 1);
    await vi.advanceTimersByTimeAsync(10_000);
    const [outcome] = await promise;
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Gemini: the request timed out after 5 minutes', retryable: true });
  });

  it('has no batch mode and estimates input tokens locally', async () => {
    const client = new GeminiLlmClient({ fetchImpl: fakeFetch(200, {}).fetchImpl, apiKey: 'k' });
    await expect(client.runBatch([request()], 1000)).rejects.toThrow('Batch mode is only available for Anthropic with an API key.');
    expect(await client.countInputTokens(PARAMS)).toBe(Math.ceil(('RULES\n\nCONTEXT'.length + '{"items":[]}'.length) / 3));
  });
});
