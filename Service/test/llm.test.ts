import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWithCache, ResponseCache } from '../src/cache.js';
import { AnthropicLlmClient, batchKey, outcomeFromMessage, requestId, type LlmClient, type LlmRequest } from '../src/llm.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';
import { FakeLlmClient, ok } from './fakeLlm.js';

const params = (text: string): Anthropic.MessageCreateParamsNonStreaming => ({
  model: 'claude-opus-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: text }],
});

const message = (stop: string, text = '{"items":[]}') =>
  ({ stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 7, output_tokens: 3 } }) as unknown as Anthropic.Message;

describe('requestId', () => {
  it('is a stable 64-hex id that ignores key order', () => {
    const a = requestId({ model: 'm', max_tokens: 1, messages: [] });
    const b = requestId({ messages: [], max_tokens: 1, model: 'm' } as Anthropic.MessageCreateParamsNonStreaming);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('outcomeFromMessage', () => {
  it('maps refusal, max_tokens, model_context_window_exceeded and text', () => {
    expect(outcomeFromMessage('x', message('refusal')).kind).toBe('refusal');
    expect(outcomeFromMessage('x', message('max_tokens'))).toMatchObject({ kind: 'error', message: 'max_tokens', retryable: true });
    expect(outcomeFromMessage('x', message('model_context_window_exceeded' as any))).toMatchObject({ kind: 'error', message: 'max_tokens', retryable: true });
    expect(outcomeFromMessage('x', message('end_turn', 'hi'))).toEqual({ customId: 'x', kind: 'ok', text: 'hi', inputTokens: 7, outputTokens: 3 });
  });
});

describe('AnthropicLlmClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // key-contract.md §1/§2: the resolved LOCHUB_API_KEY is passed down explicitly as `apiKey`, and the SDK must
  // never fall back to reading ANTHROPIC_API_KEY itself. node_modules/@anthropic-ai/sdk/client.js:76-77 only
  // reads that env var when the constructor's own `apiKey` option is `undefined`; passing `null` (what a
  // missing key resolves to below) skips that branch entirely (client.js:134 stores it as-is).
  it('passes the resolved key explicitly to the SDK client, never letting it read ANTHROPIC_API_KEY itself', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-be-ignored');
    const withKey = new AnthropicLlmClient({ apiKey: 'test-key-not-real' }) as unknown as { client: Anthropic };
    expect(withKey.client.apiKey).toBe('test-key-not-real');

    const withoutKey = new AnthropicLlmClient({}) as unknown as { client: Anthropic };
    expect(withoutKey.client.apiKey).toBeNull();
  });

  // I-1: the stock Anthropic client still falls back to its own environment/disk credentials even with an
  // explicit apiKey. Each of the four fallbacks the review found (client.js, node_modules/@anthropic-ai/sdk)
  // must be closed, and proven closed here, not just the ANTHROPIC_API_KEY one above.
  describe('I-1: no fallback to the SDK\'s own environment or credential files', () => {
    it('never reads ANTHROPIC_AUTH_TOKEN: client.authToken stays null (client.js:80)', () => {
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'should-be-ignored');
      const client = new AnthropicLlmClient({ apiKey: 'test-key-not-real' }) as unknown as { client: Anthropic };
      expect(client.client.authToken).toBeNull();
    });

    // client.js:163/179 (_shouldResolveDefaultCredentials): with apiKey and authToken both null, the stock
    // client lazily resolves credentials from a config file / profile / OIDC federation on first request
    // unless this hook returns false. LocHubAnthropic overrides it (llm.ts) -- proven directly, since the
    // resolution only happens when this returns true and nothing else observably distinguishes "no chain
    // was started" from "a chain was started and is still pending".
    it('never resolves the default credential chain: _shouldResolveDefaultCredentials is overridden to false', () => {
      const client = new AnthropicLlmClient({}) as unknown as { client: { _shouldResolveDefaultCredentials(): boolean } };
      expect(client.client._shouldResolveDefaultCredentials()).toBe(false);
    });

    // client.js:70: baseURL defaults to readEnv('ANTHROPIC_BASE_URL'). Owner's ruling: no proxy support, env
    // is not a configuration path for LocHub -- pinned to the public API host explicitly instead.
    it('pins baseURL to the public Anthropic API host, ignoring ANTHROPIC_BASE_URL', () => {
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example/proxy');
      const client = new AnthropicLlmClient({ apiKey: 'test-key-not-real' }) as unknown as { client: Anthropic };
      expect(client.client.baseURL).toBe('https://api.anthropic.com');
    });

    // client.js:116-125: ANTHROPIC_CUSTOM_HEADERS is parsed unconditionally in the constructor and merged
    // into `this._options.defaultHeaders`, which buildHeaders (client.js:838) reads fresh on every request.
    // LocHubAnthropic overwrites it right after super() runs (llm.ts) -- proven here since the parsed
    // env value is the only thing that could put a header there for this client (no defaultHeaders option
    // is ever passed in).
    it('drops ANTHROPIC_CUSTOM_HEADERS instead of merging it into the request headers', () => {
      vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'x-lochub-leak: leaked');
      const client = new AnthropicLlmClient({ apiKey: 'test-key-not-real' }) as unknown as { client: { _options: { defaultHeaders?: unknown } } };
      expect(client.client._options.defaultHeaders).toBeUndefined();
    });
  });

  // I-1: with no key at all, runSync must refuse every request locally -- the contract message, never an
  // SDK/network call (mirrors gemini.ts / openaiCompatible.ts's own missing-key refusal). No `client`
  // override is passed in: hasKey must come from apiKey alone, so this exercises the real (no-key)
  // construction path, not a test double standing in for "has a key". messages.create is mocked (never the
  // real implementation) purely as a trip wire, so a dropped guard fails loudly instead of attempting network.
  it('returns the contract message for every request and makes no SDK call when there is no key', async () => {
    const client = new AnthropicLlmClient({}) as unknown as { client: Anthropic };
    const createSpy = vi.spyOn(client.client.messages, 'create').mockImplementation(async () => {
      throw new Error('must not be called');
    });
    const requests: LlmRequest[] = [{ customId: '1', params: params('a') }, { customId: '2', params: params('b') }];
    const onOutcome = vi.fn();
    const out = await (client as unknown as AnthropicLlmClient).runSync(requests, 2, onOutcome);
    expect(out).toEqual([
      { customId: '1', kind: 'error', message: `Anthropic: ${MISSING_KEY_MESSAGE}`, retryable: false },
      { customId: '2', kind: 'error', message: `Anthropic: ${MISSING_KEY_MESSAGE}`, retryable: false },
    ]);
    expect(onOutcome).toHaveBeenCalledTimes(2);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('throws the contract message from runBatch and countInputTokens when there is no key', async () => {
    const client = new AnthropicLlmClient({});
    await expect(client.runBatch([{ customId: '1', params: params('a') }], 1)).rejects.toThrow(MISSING_KEY_MESSAGE);
    await expect(client.countInputTokens(params('a'))).rejects.toThrow(MISSING_KEY_MESSAGE);
  });

  it('keeps request order in sync mode and maps thrown errors', async () => {
    const fakeSdk = {
      messages: {
        create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
          const text = p.messages[0]!.content as string;
          if (text === 'bad') throw Object.assign(new Error('invalid'), { status: 400 });
          if (text === 'busy') throw Object.assign(new Error('overloaded'), { status: 529 });
          return message('end_turn', text);
        },
      },
    } as unknown as Anthropic;
    const client = new AnthropicLlmClient({ client: fakeSdk });
    const out = await client.runSync(
      [{ customId: '1', params: params('a') }, { customId: '2', params: params('bad') }, { customId: '3', params: params('busy') }],
      2,
    );
    expect(out.map((o) => o.kind)).toEqual(['ok', 'error', 'error']);
    expect(out[1]).toMatchObject({ retryable: false });
    expect(out[2]).toMatchObject({ retryable: true });
  });

  it('maps batch results by custom_id and reports missing ones', async () => {
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async () => ({ id: 'b1', processing_status: 'ended' }),
          results: async () =>
            (async function* () {
              yield { custom_id: '2', result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } } };
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', 'ok') } };
              yield { custom_id: '3', result: { type: 'expired' } };
              yield { custom_id: '5', result: { type: 'errored', error: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } } } };
              yield { custom_id: '6', result: { type: 'errored', error: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } } };
            })(),
        },
      },
    } as unknown as Anthropic;
    const reqs: LlmRequest[] = ['1', '2', '3', '4', '5', '6'].map((id) => ({ customId: id, params: params(id) }));
    const out = await new AnthropicLlmClient({ client: fakeSdk }).runBatch(reqs, 1);
    expect(out.map((o) => [o.customId, o.kind])).toEqual([['1', 'ok'], ['2', 'error'], ['3', 'error'], ['4', 'error'], ['5', 'error'], ['6', 'error']]);
    expect(out[1]).toMatchObject({ retryable: false });
    expect(out[2]).toMatchObject({ retryable: true, message: 'expired' });
    expect(out[3]).toMatchObject({ message: 'missing_result' });
    expect(out[4]).toMatchObject({ retryable: false, message: 'authentication_error: bad key' });
    expect(out[5]).toMatchObject({ retryable: true, message: 'overloaded_error: busy' });
  });

  // A network blip while polling must not fail the whole batch call.
  it('keeps polling through transient retrieve errors with backoff, then returns results', async () => {
    let createCalls = 0;
    let retrieveCalls = 0;
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => {
            createCalls++;
            return { id: 'b1', processing_status: 'in_progress' };
          },
          retrieve: async () => {
            retrieveCalls++;
            if (retrieveCalls <= 2) throw Object.assign(new Error('Connection error.'), { status: 500 });
            return { id: 'b1', processing_status: 'ended' };
          },
          results: async () =>
            (async function* () {
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', 'ok') } };
            })(),
        },
      },
    } as unknown as Anthropic;
    const out = await new AnthropicLlmClient({ client: fakeSdk }).runBatch([{ customId: '1', params: params('a') }], 1);
    expect(out).toEqual([{ customId: '1', kind: 'ok', text: 'ok', inputTokens: 7, outputTokens: 3 }]);
    expect(createCalls).toBe(1);
    expect(retrieveCalls).toBe(3);
  });

  // Retrieve failing for good (never recovers) must still surface as a rejection, not hang forever.
  it('gives up after 10 consecutive retrieve failures', async () => {
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async () => {
            throw Object.assign(new Error('Connection error.'), { status: 500 });
          },
        },
      },
    } as unknown as Anthropic;
    await expect(new AnthropicLlmClient({ client: fakeSdk }).runBatch([{ customId: '1', params: params('a') }], 1)).rejects.toThrow('Connection error.');
  });

  // Persist the batch id right after create, resume it on the next run instead of paying again, and
  // clean the file up only once results are fully collected.
  it('persists an in-flight batch and resumes it on the next call with the same requests', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'lochub-batches-'));
    const requests: LlmRequest[] = [{ customId: '1', params: params('a') }, { customId: '2', params: params('b') }];
    const file = join(batchDir, `${batchKey(requests.map((r) => r.customId))}.json`);

    let createCalls = 0;
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => {
            createCalls++;
            return { id: 'fresh-batch', processing_status: 'ended' };
          },
          retrieve: async (id: string) => ({ id, processing_status: 'ended' }),
          results: async (id: string) =>
            (async function* () {
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', `from ${id}`) } };
              yield { custom_id: '2', result: { type: 'succeeded', message: message('end_turn', `from ${id}`) } };
            })(),
        },
      },
    } as unknown as Anthropic;
    const client = new AnthropicLlmClient({ client: fakeSdk, batchDir });

    const first = await client.runBatch(requests, 1);
    expect(createCalls).toBe(1);
    expect(first.every((o) => o.kind === 'ok' && o.text === 'from fresh-batch')).toBe(true);
    // The batch finished and results were fully collected: the persisted file is gone.
    expect(existsSync(file)).toBe(false);

    // Simulate a crash before collection: a persisted file from an earlier run, naming a still-running batch.
    writeFileSync(file, JSON.stringify({ batchId: 'resumed-batch', customIds: ['1', '2'], createdAt: 't' }));
    const second = await client.runBatch(requests, 1);
    expect(createCalls).toBe(1); // create was not called again
    expect(second.every((o) => o.kind === 'ok' && o.text === 'from resumed-batch')).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  // A persisted descriptor the API no longer serves (wrong workspace/org credential since the crash,
  // past retention, or deleted) must not wedge the job forever. A non-retryable retrieve error on a resumed
  // descriptor drops it and pays for a fresh batch instead of retrying it 10 times and failing.
  it('drops a resumed descriptor whose retrieve throws a non-retryable error and creates a fresh batch', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'lochub-batches-'));
    const requests: LlmRequest[] = [{ customId: '1', params: params('a') }];
    const file = join(batchDir, `${batchKey(requests.map((r) => r.customId))}.json`);
    writeFileSync(file, JSON.stringify({ batchId: 'gone-batch', customIds: ['1'], createdAt: 't' }));

    let createCalls = 0;
    let retrieveCalls = 0;
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => {
            createCalls++;
            return { id: 'fresh-batch', processing_status: 'ended' };
          },
          retrieve: async (id: string) => {
            retrieveCalls++;
            if (id === 'gone-batch') throw Object.assign(new Error('not found'), { status: 404 });
            return { id, processing_status: 'ended' };
          },
          results: async (id: string) =>
            (async function* () {
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', `from ${id}`) } };
            })(),
        },
      },
    } as unknown as Anthropic;

    const out = await new AnthropicLlmClient({ client: fakeSdk, batchDir }).runBatch(requests, 1);
    expect(createCalls).toBe(1);
    expect(retrieveCalls).toBe(1);
    expect(out).toEqual([{ customId: '1', kind: 'ok', text: 'from fresh-batch', inputTokens: 7, outputTokens: 3 }]);
    expect(existsSync(file)).toBe(false);
  });

  // A batch created in *this* call has no descriptor to fall back to; a non-retryable retrieve error is
  // final and must be surfaced, with the (now-orphaned) descriptor cleaned up rather than left to wedge a rerun.
  it('throws on a non-retryable retrieve error for a batch created in this call and removes the descriptor', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'lochub-batches-'));
    const requests: LlmRequest[] = [{ customId: '1', params: params('a') }];
    const file = join(batchDir, `${batchKey(requests.map((r) => r.customId))}.json`);
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async () => {
            throw Object.assign(new Error('unauthorized'), { status: 401 });
          },
        },
      },
    } as unknown as Anthropic;

    await expect(new AnthropicLlmClient({ client: fakeSdk, batchDir }).runBatch(requests, 1)).rejects.toThrow('unauthorized');
    expect(existsSync(file)).toBe(false);
  });

  // A fresh batch (no persisted file yet) must write its descriptor right after create returns,
  // before polling even starts, so a crash mid-poll still leaves something to resume from.
  it('writes the batch descriptor right after create, before polling', async () => {
    const batchDir = mkdtempSync(join(tmpdir(), 'lochub-batches-'));
    const requests: LlmRequest[] = [{ customId: '1', params: params('a') }];
    const file = join(batchDir, `${batchKey(requests.map((r) => r.customId))}.json`);
    let descriptorDuringPoll: unknown;
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async (id: string) => {
            descriptorDuringPoll = JSON.parse(readFileSync(file, 'utf8'));
            return { id, processing_status: 'ended' };
          },
          results: async () =>
            (async function* () {
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', 'ok') } };
            })(),
        },
      },
    } as unknown as Anthropic;
    await new AnthropicLlmClient({ client: fakeSdk, batchDir }).runBatch(requests, 1);
    expect(descriptorDuringPoll).toMatchObject({ batchId: 'b1', customIds: ['1'] });
  });

  // Job progress reads batch mode's own polling via onProgress(succeeded, total). Only a succeeded
  // request can have settled strings — an errored/canceled/expired one is retried or split by the caller and
  // settles nothing — so the count must not include it, even once that request has stopped processing.
  it('reports onProgress from request_counts.succeeded while polling, not from errored/canceled/expired', async () => {
    const counts = [
      { processing: 3, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      { processing: 1, succeeded: 2, errored: 0, canceled: 0, expired: 0 },
      { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 0 },
    ];
    let retrieveCalls = 0;
    const fakeSdk = {
      messages: {
        batches: {
          create: async () => ({ id: 'b1', processing_status: 'in_progress' }),
          retrieve: async () => {
            const request_counts = counts[retrieveCalls]!;
            const isLast = retrieveCalls === counts.length - 1;
            retrieveCalls++;
            return { id: 'b1', processing_status: isLast ? 'ended' : 'in_progress', request_counts };
          },
          results: async () =>
            (async function* () {
              yield { custom_id: '1', result: { type: 'succeeded', message: message('end_turn', 'ok') } };
              yield { custom_id: '2', result: { type: 'succeeded', message: message('end_turn', 'ok') } };
              yield { custom_id: '3', result: { type: 'errored', error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } } };
            })(),
        },
      },
    } as unknown as Anthropic;
    const requests: LlmRequest[] = ['1', '2', '3'].map((id) => ({ customId: id, params: params(id) }));
    const progress: [number, number][] = [];
    await new AnthropicLlmClient({ client: fakeSdk }).runBatch(requests, 1, (succeeded, total) => progress.push([succeeded, total]));
    // The last poll reports errored:1 alongside succeeded:2 — that request must not count as progress.
    expect(progress).toEqual([[0, 3], [2, 3], [2, 3]]);
  });
});

describe('resolveWithCache', () => {
  it('sends only uncached, deduplicated requests and caches valid JSON answers', async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-cache-')));
    const llm = new FakeLlmClient((r) => ok(r.customId, (r.params.messages[0]!.content as string) === 'broken' ? 'not json' : { items: [] }));
    const a: LlmRequest = { customId: 'a', params: params('x') };
    const broken: LlmRequest = { customId: 'b', params: params('broken') };
    const opts = { mode: 'sync' as const, concurrency: 2, pollMs: 1 };

    await resolveWithCache(llm, cache, [a, a, broken], opts);
    expect(llm.calls.map((c) => c.customId)).toEqual(['a', 'b']);
    expect(cache.get('a')?.kind).toBe('ok');
    expect(cache.get('b')).toBeUndefined();

    await resolveWithCache(llm, cache, [a], opts);
    expect(llm.calls).toHaveLength(2);

    await resolveWithCache(llm, cache, [a], { ...opts, fresh: new Set(['a']) });
    expect(llm.calls).toHaveLength(3);
  });

  // A crash mid-round must not lose answers that already came back before it.
  it('caches a sync answer as soon as it arrives, even if a later request in the same round throws', async () => {
    const cache = new ResponseCache(mkdtempSync(join(tmpdir(), 'lochub-cache-')));
    const throwsAfterFirst: LlmClient = {
      async runSync(requests, _concurrency, onOutcome) {
        onOutcome?.(ok(requests[0]!.customId, { items: [] }));
        throw new Error('boom');
      },
      async runBatch(requests) {
        return this.runSync(requests, 1);
      },
      async countInputTokens() {
        return 1;
      },
    };
    const a: LlmRequest = { customId: 'a', params: params('x') };
    const b: LlmRequest = { customId: 'b', params: params('y') };
    await expect(resolveWithCache(throwsAfterFirst, cache, [a, b], { mode: 'sync', concurrency: 2, pollMs: 1 })).rejects.toThrow('boom');
    expect(cache.get('a')?.kind).toBe('ok');
  });
});

describe('ResponseCache', () => {
  // A leftover/corrupt cache file (e.g. from a crash) must not break every later job for that group.
  it('treats an unparsable cache file as a miss and removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lochub-cache-'));
    const cache = new ResponseCache(dir);
    const path = join(dir, 'a.json');
    writeFileSync(path, 'not json');
    expect(cache.get('a')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
  });

  // put() must not leave a .tmp file behind on the happy path.
  it('writes atomically and leaves no .tmp file after a successful put', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lochub-cache-'));
    const cache = new ResponseCache(dir);
    cache.put(ok('a', { items: [] }));
    expect(cache.get('a')?.kind).toBe('ok');
    expect(existsSync(join(dir, 'a.json.tmp'))).toBe(false);
  });
});
