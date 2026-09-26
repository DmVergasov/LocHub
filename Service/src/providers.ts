import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ClaudeCodeLlmClient } from './claudeCode.js';
import { GeminiLlmClient } from './gemini.js';
import { DEFAULT_JOB_OPTIONS, type JobDefaults } from './job.js';
import { AnthropicLlmClient, type LlmClient } from './llm.js';
import { MISSING_KEY_MESSAGE } from './llmShared.js';
import { OpenAiCompatibleLlmClient } from './openaiCompatible.js';

export type AiProvider = 'anthropic' | 'openai' | 'xai' | 'deepseek' | 'gemini';
export type AiAuth = 'api' | 'subscription';

export interface AiConfig {
  provider: AiProvider;
  auth: AiAuth;
  translateModel: string;
  judgeModel: string;
}

export interface AiHealth extends AiConfig {
  batch: boolean;
  ready: boolean;
  detail: string;
  // Lowercase hex SHA-1 of the --brief-file file's raw bytes as read (before any BOM strip); an absent or missing
  // file hashes to the SHA-1 of empty input. Lets the editor plugin's IsAiConfigApplied tell a Project Settings
  // brief edit apart from an unrelated AI settings change without ever comparing the brief text itself.
  briefSha1: string;
  // First 12 lowercase hex characters of SHA-1 over the UTF-8 bytes of LOCHUB_API_KEY, or "" when there is no
  // key (key-contract.md §3). The editor computes the same value from its Project Settings key and treats the
  // service as applied only when the two are equal; absent (an older service) counts as applied.
  keyId: string;
}

export const AI_PROVIDERS: readonly AiProvider[] = ['anthropic', 'openai', 'xai', 'deepseek', 'gemini'];

// key-contract.md §3: first 12 lowercase hex characters of SHA-1 over the UTF-8 bytes of the key. Test vector:
// keyIdOf('abc') === 'a9993e364706'. Empty or absent means no key, and hashes to "".
export function keyIdOf(apiKey: string | undefined): string {
  if (!apiKey) return '';
  return createHash('sha1').update(apiKey, 'utf8').digest('hex').slice(0, 12);
}

// Batch mode exists only for Anthropic billed per token; the subscription and every other provider run sync only.
export function supportsBatch(config: AiConfig): boolean {
  return config.provider === 'anthropic' && config.auth === 'api';
}

// The subscription is not billed per token; every other provider/auth combination is billed through its API key.
export function billingOf(config: AiConfig): 'api' | 'subscription' {
  return config.auth;
}

// Readiness from the environment only (no network call): the service reads only LOCHUB_API_KEY
// (key-contract.md §2) -- no per-provider variable, whatever `auth: 'api'` provider is configured.
// M-4: the detail text for a present key never names the internal variable -- it is sent over HTTP and
// could reach a screen (Web/src/App.tsx shows ai.detail while !ai.ready today, but nothing guarantees a
// future caller only reads it in that state).
export function apiKeyHealth(env: NodeJS.ProcessEnv): { ready: boolean; detail: string } {
  return env.LOCHUB_API_KEY ? { ready: true, detail: 'API key is set' } : { ready: false, detail: MISSING_KEY_MESSAGE };
}

// apiKey is the resolved LOCHUB_API_KEY value (or undefined for no key / the subscription path), read once at
// startup by the caller (cli.ts's resolveApiKey) and passed down explicitly here so no adapter's SDK/fetch call
// ever falls back to reading its own provider-specific env var (key-contract.md §1/§2).
export function createLlmClient(config: AiConfig, projectDir: string, apiKey?: string): LlmClient {
  switch (config.provider) {
    case 'anthropic':
      return config.auth === 'subscription'
        ? new ClaudeCodeLlmClient({ projectDir })
        : new AnthropicLlmClient({ apiKey, batchDir: join(projectDir, 'Saved', 'LocHub', 'batches') });
    case 'gemini':
      return new GeminiLlmClient({ apiKey });
    case 'openai':
    case 'xai':
    case 'deepseek':
      return new OpenAiCompatibleLlmClient({ provider: config.provider, apiKey });
    default: {
      // Exhaustiveness check: a new AiProvider added without a branch here fails to compile instead of
      // silently falling through to the wrong adapter (this replaces `as OpenAiCompatibleProvider`).
      const exhaustive: never = config.provider;
      throw new Error(`Unknown AI provider: ${exhaustive as string}`);
    }
  }
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'anthropic',
  auth: 'api',
  translateModel: DEFAULT_JOB_OPTIONS.translateModel,
  judgeModel: DEFAULT_JOB_OPTIONS.judgeModel,
};

// The job-defaults construction used to live inline in cli.ts's main(); pulled out here so it is one
// pure function both the CLI and (via server.ts) buildServer can share and test on its own.
export function jobDefaultsFor(ai: AiConfig): JobDefaults {
  return {
    ...DEFAULT_JOB_OPTIONS,
    translateModel: ai.translateModel,
    judgeModel: ai.judgeModel,
    // Now (sync) is the default for every provider; Batch is an explicit choice, and only Anthropic
    // billed per token supports it.
    mode: 'sync',
  };
}
