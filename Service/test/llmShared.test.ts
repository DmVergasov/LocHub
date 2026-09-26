import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, redactSecrets } from '../src/llmShared.js';

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
    expect(result).toEqual({ status: 200, json: { ok: true } });
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
    expect(result).toEqual({ status: 200, json: { ok: true } });
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
    expect(result).toEqual({ status: 500, json: { error: 'boom' } });
    randomSpy.mockRestore();
  });

  it('does not retry a plain 400 (one fetch only)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 400, body: { error: 'bad' } }]);
    const result = await fetchWithRetry('http://x', () => ({}), { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 400, json: { error: 'bad' } });
  });

  it('does not retry a status the caller marks final despite looking retryable (FINAL_ERROR_CODES on a 429)', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429, body: { error: { code: 'credit_balance_exhausted' } } }]);
    const result = await fetchWithRetry('http://x', () => ({}), {
      fetchImpl,
      isFinal: (status, json) => status === 429 && (json as { error?: { code?: string } }).error?.code === 'credit_balance_exhausted',
    });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ status: 429, json: { error: { code: 'credit_balance_exhausted' } } });
  });

  it('retries a thrown network error, then succeeds', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = fakeFetch(['network-error', { status: 200, body: { ok: true } }]);
    const promise = fetchWithRetry('http://x', () => ({}), { fetchImpl });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(calls).toHaveLength(2);
    expect(result).toEqual({ status: 200, json: { ok: true } });
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
