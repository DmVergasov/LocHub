import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeLlmClient } from '../src/claudeCode.js';
import { GeminiLlmClient } from '../src/gemini.js';
import { DEFAULT_JOB_OPTIONS } from '../src/job.js';
import { AnthropicLlmClient } from '../src/llm.js';
import { MISSING_KEY_MESSAGE } from '../src/llmShared.js';
import { OPENAI_COMPATIBLE_PROFILES, OpenAiCompatibleLlmClient, type OpenAiCompatibleProfile } from '../src/openaiCompatible.js';
import { apiKeyHealth, billingOf, createLlmClient, jobDefaultsFor, keyIdOf, supportsBatch, type AiConfig } from '../src/providers.js';

const config = (patch: Partial<AiConfig>): AiConfig => ({ provider: 'anthropic', auth: 'api', translateModel: 't', judgeModel: 'j', ...patch });

describe('providers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates the adapter of each provider and auth', () => {
    expect(createLlmClient(config({}), 'D:/P')).toBeInstanceOf(AnthropicLlmClient);
    expect(createLlmClient(config({ auth: 'subscription' }), 'D:/P')).toBeInstanceOf(ClaudeCodeLlmClient);
    for (const provider of ['openai', 'xai', 'deepseek'] as const) expect(createLlmClient(config({ provider }), 'D:/P')).toBeInstanceOf(OpenAiCompatibleLlmClient);
    expect(createLlmClient(config({ provider: 'gemini' }), 'D:/P')).toBeInstanceOf(GeminiLlmClient);
  });

  // createLlmClient used to cast `config.provider as OpenAiCompatibleProvider` for every non-anthropic,
  // non-gemini provider. A wrong branch (e.g. xai/deepseek silently falling into the openai profile) would not
  // be caught by an instanceof check alone, since all three share the same class. Reading the profile the
  // client actually holds catches that: xai/deepseek must not get OpenAI's baseUrl/label.
  it('gives xai and deepseek their own profile, not the OpenAI one', () => {
    const xaiClient = createLlmClient(config({ provider: 'xai' }), 'D:/P') as unknown as { profile: OpenAiCompatibleProfile };
    expect(xaiClient.profile.baseUrl).toBe(OPENAI_COMPATIBLE_PROFILES.xai.baseUrl);
    expect(xaiClient.profile.label).toBe('xAI');
    expect(xaiClient.profile.baseUrl).not.toBe(OPENAI_COMPATIBLE_PROFILES.openai.baseUrl);

    const deepseekClient = createLlmClient(config({ provider: 'deepseek' }), 'D:/P') as unknown as { profile: OpenAiCompatibleProfile };
    expect(deepseekClient.profile.baseUrl).toBe(OPENAI_COMPATIBLE_PROFILES.deepseek.baseUrl);
    expect(deepseekClient.profile.label).toBe('DeepSeek');
    expect(deepseekClient.profile.baseUrl).not.toBe(OPENAI_COMPATIBLE_PROFILES.openai.baseUrl);

    const openaiClient = createLlmClient(config({ provider: 'openai' }), 'D:/P') as unknown as { profile: OpenAiCompatibleProfile };
    expect(openaiClient.profile.baseUrl).toBe(OPENAI_COMPATIBLE_PROFILES.openai.baseUrl);
  });

  it('offers Batch and API billing only where they exist', () => {
    expect(supportsBatch(config({}))).toBe(true);
    expect(supportsBatch(config({ auth: 'subscription' }))).toBe(false);
    expect(supportsBatch(config({ provider: 'openai' }))).toBe(false);
    expect(billingOf(config({ auth: 'subscription' }))).toBe('subscription');
    expect(billingOf(config({ provider: 'gemini' }))).toBe('api');
  });

  // key-contract.md §2: the service reads only LOCHUB_API_KEY, whatever provider is configured -- every
  // provider-specific variable (including Anthropic's own ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) is ignored.
  it('reports readiness from LOCHUB_API_KEY alone, ignoring every provider-specific variable', () => {
    const everyProviderVarSet = {
      ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', XAI_API_KEY: 'd', DEEPSEEK_API_KEY: 'e', GOOGLE_API_KEY: 'f', GEMINI_API_KEY: 'g',
    };
    expect(apiKeyHealth(everyProviderVarSet)).toEqual({ ready: false, detail: MISSING_KEY_MESSAGE });
    // M-4: the detail text for a present key never names the internal variable.
    expect(apiKeyHealth({ ...everyProviderVarSet, LOCHUB_API_KEY: 'test-key-not-real' })).toEqual({ ready: true, detail: 'API key is set' });
    expect(apiKeyHealth({})).toEqual({ ready: false, detail: MISSING_KEY_MESSAGE });
    expect(apiKeyHealth({ LOCHUB_API_KEY: '' })).toEqual({ ready: false, detail: MISSING_KEY_MESSAGE });
  });

  // key-contract.md §3: keyId is the first 12 lowercase hex characters of SHA-1 over the UTF-8 bytes of the
  // key, "" when there is no key. Test vector from the contract: 'abc' -> 'a9993e364706'.
  describe('keyIdOf', () => {
    it('hashes the contract test vector, and treats no key / an empty key as ""', () => {
      expect(keyIdOf('abc')).toBe('a9993e364706');
      expect(keyIdOf(undefined)).toBe('');
      expect(keyIdOf('')).toBe('');
    });
  });

  // The one place that resolves the key passes it down explicitly to every provider client (createLlmClient),
  // so no adapter's SDK/fetch call can fall back to reading its own provider-specific env var -- proven here by
  // stubbing every provider var and checking the client actually holds the explicitly-given key instead.
  it('threads the resolved key explicitly into every provider client, never the SDK/adapter reading its own env var', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-be-ignored');
    vi.stubEnv('OPENAI_API_KEY', 'should-be-ignored');
    vi.stubEnv('GOOGLE_API_KEY', 'should-be-ignored');

    const anthropic = createLlmClient(config({ provider: 'anthropic' }), 'D:/P', 'test-key-not-real') as unknown as { client: Anthropic };
    expect(anthropic.client.apiKey).toBe('test-key-not-real');

    const anthropicNoKey = createLlmClient(config({ provider: 'anthropic' }), 'D:/P', undefined) as unknown as { client: Anthropic };
    expect(anthropicNoKey.client.apiKey).toBeNull();

    const gemini = createLlmClient(config({ provider: 'gemini' }), 'D:/P', 'test-key-not-real') as unknown as { apiKey: string | undefined };
    expect(gemini.apiKey).toBe('test-key-not-real');

    const openai = createLlmClient(config({ provider: 'openai' }), 'D:/P', 'test-key-not-real') as unknown as { apiKey: string | undefined };
    expect(openai.apiKey).toBe('test-key-not-real');
  });

  // The job-defaults construction main() used to build inline, now a pure function tested on its own.
  describe('jobDefaultsFor', () => {
    it('picks sync mode (Now/full price) as the default for every provider/auth, and copies the models', () => {
      expect(jobDefaultsFor(config({ provider: 'anthropic', auth: 'api' }))).toMatchObject({ mode: 'sync', translateModel: 't', judgeModel: 'j' });
      expect(jobDefaultsFor(config({ provider: 'anthropic', auth: 'subscription' }))).toMatchObject({ mode: 'sync', translateModel: 't', judgeModel: 'j' });
      expect(jobDefaultsFor(config({ provider: 'openai' }))).toMatchObject({ mode: 'sync', translateModel: 't', judgeModel: 'j' });
      expect(jobDefaultsFor(config({ provider: 'gemini' }))).toMatchObject({ mode: 'sync', translateModel: 't', judgeModel: 'j' });
    });

    it('takes every other field from DEFAULT_JOB_OPTIONS', () => {
      const defaults = jobDefaultsFor(config({}));
      expect(defaults.groupSize).toBe(DEFAULT_JOB_OPTIONS.groupSize);
      expect(defaults.concurrency).toBe(DEFAULT_JOB_OPTIONS.concurrency);
      expect(defaults.pollMs).toBe(DEFAULT_JOB_OPTIONS.pollMs);
      expect(defaults.maxRepairRounds).toBe(DEFAULT_JOB_OPTIONS.maxRepairRounds);
      expect(defaults.auditPercent).toBe(DEFAULT_JOB_OPTIONS.auditPercent);
      expect(defaults.actor).toBe(DEFAULT_JOB_OPTIONS.actor);
    });
  });
});
