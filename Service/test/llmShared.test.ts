import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmOutcome, LlmRequest } from '../src/llm.js';
import {
  approxOutputTokens,
  fetchWithRetry,
  isFetchTimeout,
  isTimeoutMessage,
  redactSecrets,
  runPool,
  timedOutAfterMs,
  timeoutMessage,
} from '../src/llmShared.js';

describe('redactSecrets', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces the exact value of LOCHUB_API_KEY when it is set and non-empty', () => {
    vi.stubEnv('LOCHUB_API_KEY', 'my-actual-secret-value');
    expect(redactSecrets('OpenAI: 401 Incorrect API key provided: my-actual-secret-value')).toBe('OpenAI: 401 Incorrect API key provided: [redacted]');
  });

  it('does not touch LOCHUB_API_KEY when it is unset or empty', () => {
    vi.stubEnv('LOCHUB_API_KEY', '');
    expect(redactSecrets('my-actual-secret-value stays')).toBe('my-actual-secret-value stays');
  });

  it('redacts an sk-, xai- or AIza-shaped token even when it is not the configured env value', () => {
    expect(redactSecrets('key: sk-abcdef123456')).toBe('key: [redacted]');
    expect(redactSecrets('key: xai-abcdef123456')).toBe('key: [redacted]');
    expect(redactSecrets('key: AIzaSyAbCdEfGhIjKlMnOp')).toBe('key: [redacted]');
  });

  it('redacts a Bearer token', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_123')).toBe('Authorization: [redacted]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('OpenAI: 404 The model `gpt-6-sool` does not exist')).toBe('OpenAI: 404 The model `gpt-6-sool` does not exist');
  });

  it('redacts a real-shaped OpenAI masked-key 401 message', () => {
    const text = "Incorrect API key provided: sk-proj-****...abcd. You can find your API key at https://platform.openai.com/account/api-keys.";
    expect(redactSecrets(text)).toBe('Incorrect API key provided: [redacted]...abcd. You can find your API key at https://platform.openai.com/account/api-keys.');
  });

  it('does not treat an ordinary word containing "sk-"/"xai-" as a key', () => {
    expect(redactSecrets('a risk-assessment step ran first')).toBe('a risk-assessment step ran first');
    expect(redactSecrets('a prefixai-suffix identifier stays whole')).toBe('a prefixai-suffix identifier stays whole');
  });
});

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | 'network-error'>) {
    const calls: number[] = [];
    let i = 0;
    const fetchImpl = (async () => {
      calls.push(Date.now());
      const next = responses[Math.min(i, responses.length - 1)]!;
      i++;
      if (next === 'network-error') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it('retries a 429 with retry-after in seconds, succeeding after the exact wait', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true } }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ status: 200, text: JSON.stringify({ ok: true }), json: { ok: true } });
  });

  it('retries a 429 with retry-after as an HTTP date, waiting until that date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const retryAt = new Date('2026-01-01T00:00:03.000Z').toUTCString();
    const { fetchImpl, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': retryAt } }, { status: 200, body: { ok: true } }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ status: 200, text: JSON.stringify({ ok: true }), json: { ok: true } });
  });

  it('retries a 500 up to the retry budget, then returns the last attempt with no sleep after it (3 fetches, exactly two backoff waits)', async () => {
    vi.useFakeTimers();
    // Math.random pinned at 0.5 makes both jittered waits exact: attempt 0 (base 500 ms) waits 500 ms, attempt 1
    // (base 1 000 ms) waits 1 000 ms — 1 500 ms total before the third, final attempt.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { fetchImpl, calls } = fakeFetch([{ status: 500, body: { error: 'boom' } }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(1499);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(calls).toHaveLength(3);
    expect(result).toEqual({ status: 500, text: JSON.stringify({ error: 'boom' }), json: { error: 'boom' } });
    randomSpy.mockRestore();
  });

  it('does not retry a plain 400 (one fetch only)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 400, body: { error: 'bad' } }]);
    const result = await fetchWithRetry('http://x', () => ({}), { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 400, text: JSON.stringify({ error: 'bad' }), json: { error: 'bad' } });
  });

  it('does not retry a status the caller marks final despite looking retryable (FINAL_ERROR_CODES on a 429)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429, body: { error: { code: 'credit_balance_exhausted' } } }]);
    const result = await fetchWithRetry('http://x', () => ({}), {
      fetchImpl,
      isFinal: (status, json) => status === 429 && (json as { error?: { code?: string } }).error?.code === 'credit_balance_exhausted',
    });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 429, text: JSON.stringify({ error: { code: 'credit_balance_exhausted' } }), json: { error: { code: 'credit_balance_exhausted' } } });
  });

  // I-1: for a Custom endpoint, a request that times out is returned on the very first attempt instead of
  // going through the normal 3-attempt envelope -- job.ts splits the group instead of waiting for a bare retry.
  it('does not retry a timeout when retryTimeouts is false, but a plain network error still gets the normal envelope', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    let timeoutCalls = 0;
    const timingOut = (async () => {
      timeoutCalls++;
      throw timeoutError;
    }) as typeof fetch;
    const result = await fetchWithRetry('http://x', () => ({}), { fetchImpl: timingOut, retryTimeouts: false });
    expect(result).toEqual({ networkError: timeoutError });
    // The proof that matters: a real retry (the pre-fix behavior) would still throw the same error and match
    // the assertion above, but would call the fetch impl 3 times, not 1.
    expect(timeoutCalls).toBe(1);

    vi.useFakeTimers();
    const { fetchImpl: plainFetch, calls: plainCalls } = fakeFetch(['network-error']);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl: plainFetch, retryTimeouts: false });
    await vi.advanceTimersByTimeAsync(10_000);
    const plainResult = await promise;
    expect(plainCalls).toHaveLength(3);
    expect(plainResult).toMatchObject({ networkError: expect.any(TypeError) });
  });

  // Amendment 8/NB-1: Node's fetch gives up after 300 s on its own, with a code on the error or on its cause; that
  // is the same timeout as LocHub's AbortSignal, so with retryTimeouts: false it is returned after one call too.
  describe("Node's own fetch timeout (UND_ERR_HEADERS_TIMEOUT / UND_ERR_BODY_TIMEOUT)", () => {
    const failures = {
      'UND_ERR_HEADERS_TIMEOUT on the cause': () =>
        Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }),
      'UND_ERR_BODY_TIMEOUT on the error': () => Object.assign(new TypeError('fetch failed'), { code: 'UND_ERR_BODY_TIMEOUT' }),
    };
    for (const [name, failure] of Object.entries(failures)) {
      it(`returns ${name} on the first attempt when retryTimeouts is false`, async () => {
        const error = failure();
        let calls = 0;
        const fetchImpl = (async () => {
          calls++;
          throw error;
        }) as typeof fetch;
        expect(await fetchWithRetry('http://x', () => ({}), { fetchImpl, retryTimeouts: false })).toEqual({ networkError: error });
        expect(calls).toBe(1);
      });
    }

    it('treats a body read that times out as the timed-out request, not as an empty answer', async () => {
      const bodyTimeout = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) });
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return {
          status: 200,
          headers: new Headers(),
          text: async () => {
            throw bodyTimeout;
          },
        } as unknown as Response;
      }) as typeof fetch;
      expect(await fetchWithRetry('http://x', () => ({}), { fetchImpl, retryTimeouts: false })).toEqual({ networkError: bodyTimeout });
      expect(calls).toBe(1);
    });

    it('classifies both codes and LocHub\'s own AbortSignal as a timeout, and nothing else', () => {
      expect(isFetchTimeout(failures['UND_ERR_HEADERS_TIMEOUT on the cause']())).toBe(true);
      expect(isFetchTimeout(failures['UND_ERR_BODY_TIMEOUT on the error']())).toBe(true);
      expect(isFetchTimeout(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
      expect(isFetchTimeout(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe(false);
      expect(isFetchTimeout(new TypeError('fetch failed'))).toBe(false);
    });

    it('names the limit that actually fired: Node\'s 300 s when it is the shorter one', () => {
      const nodeTimeout = failures['UND_ERR_HEADERS_TIMEOUT on the cause']();
      const ownTimeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      expect(timeoutMessage(timedOutAfterMs(nodeTimeout, 600_000))).toBe('the request timed out after 5 minutes');
      expect(timeoutMessage(timedOutAfterMs(nodeTimeout, 90_000))).toBe('the request timed out after 90 seconds');
      expect(timeoutMessage(timedOutAfterMs(ownTimeout, 600_000))).toBe('the request timed out after 10 minutes');
      expect(isTimeoutMessage(`Custom: ${timeoutMessage(90_000)}`)).toBe(true);
      expect(isTimeoutMessage('Custom: 504 Gateway Timeout')).toBe(false);
    });
  });

  // NB-6: a network error the caller marks final (a refused redirect) is returned on the first attempt.
  it('does not retry a network error the caller marks final', async () => {
    const { fetchImpl, calls } = fakeFetch(['network-error']);
    const result = await fetchWithRetry('http://x', () => ({}), { fetchImpl, isFinalNetworkError: () => true });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ networkError: expect.any(TypeError) });
  });

  it('retries a thrown network error, then succeeds', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch(['network-error', { status: 200, body: { ok: true } }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ status: 200, text: JSON.stringify({ ok: true }), json: { ok: true } });
  });

  it('returns the network error itself once every attempt throws', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch(['network-error']);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ networkError: expect.any(TypeError) });
  });

  it('caps a huge retry-after at 60 000 ms', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '3600' } }, { status: 200, body: {} }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(calls).toHaveLength(2);
  });

  it('uses jittered exponential backoff within the documented bounds (not asserting the exact value)', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch([{ status: 500 }, { status: 200, body: {} }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    // 500 ms * 2^0 = 500 ms base, +/-25%: the wait is always within [375, 625) ms — must not resolve before the
    // lower bound, and must have resolved by the upper one.
    await vi.advanceTimersByTimeAsync(374);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(251);
    await promise;
    expect(calls).toHaveLength(2);
  });

  it('rebuilds the request init on every attempt (fresh AbortSignal per try)', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fakeFetch([{ status: 429, headers: { 'retry-after-ms': '10' } }, { status: 200, body: {} }]);
    let builds = 0;
    const promise = fetchWithRetry('http://x', () => {
      builds++;
      return {};
    }, { fetchImpl });
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(builds).toBe(2);
  });
});

// M-5: the same three-characters-per-token guess approxInputTokens already uses, for a proxy's chat response
// that omits usage entirely or omits completion_tokens.
describe('approxOutputTokens', () => {
  it('guesses about one token per three characters, rounding up', () => {
    expect(approxOutputTokens('')).toBe(0);
    expect(approxOutputTokens('abc')).toBe(1);
    expect(approxOutputTokens('abcd')).toBe(2);
    expect(approxOutputTokens('{"items":[]}')).toBe(4);
  });
});

// Amendment 9: runPool's shouldContinue is asked before each request that has not started yet.
describe('runPool', () => {
  const requests = (count: number): LlmRequest[] =>
    Array.from({ length: count }, (_, i) => ({ customId: `r${i}`, params: { model: 'm', max_tokens: 1, messages: [] } }));
  const answer = (request: LlmRequest): LlmOutcome => ({ customId: request.customId, kind: 'ok', text: '{}', inputTokens: 1, outputTokens: 1 });

  it('never sends a request the hook declines, resolves it as skipped, and does not report it through onOutcome', async () => {
    const sent: string[] = [];
    const reported: string[] = [];
    // Declines everything once the first outcome has landed.
    const out = await runPool(
      requests(5),
      2,
      async (request) => {
        sent.push(request.customId);
        return answer(request);
      },
      (outcome) => reported.push(outcome.customId),
      () => reported.length === 0,
    );
    // Both workers start before any outcome lands (r0, r1); every later request is declined.
    expect(sent).toEqual(['r0', 'r1']);
    expect(reported).toEqual(['r0', 'r1']);
    expect(out.map((o) => o.kind)).toEqual(['ok', 'ok', 'skipped', 'skipped', 'skipped']);
    expect(out[2]).toEqual({ customId: 'r2', kind: 'skipped' });
  });

  it('sends everything when the hook never declines or is absent', async () => {
    for (const hook of [() => true, undefined]) {
      const sent: string[] = [];
      const out = await runPool(requests(4), 2, async (request) => {
        sent.push(request.customId);
        return answer(request);
      }, undefined, hook);
      expect(sent).toEqual(['r0', 'r1', 'r2', 'r3']);
      expect(out.every((o) => o.kind === 'ok')).toBe(true);
    }
  });
});
