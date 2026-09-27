import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, readBriefFile, resolveApiKey, resolveCustomBaseUrl, USAGE } from '../src/cli.js';
import { LENGTH_CHECK_OFF, lengthArgsOf } from '../src/lengthCheck.js';

describe('parseCliArgs', () => {
  it('parses serve with defaults and always binds loopback', () => {
    expect(parseCliArgs(['serve', '--project', 'D:/Projects/MyGame'])).toEqual({
      projectDir: 'D:/Projects/MyGame',
      port: 47810,
      host: '127.0.0.1',
      policy: 'validated',
      ai: { provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
      length: { mode: 'off', scope: 'ui', ratio: 1.3, extra: 4, ratios: {}, hint: true },
    });
  });

  it('accepts a port and the strict policy', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--port', '5000', '--policy', 'approved_only'])).toMatchObject({ port: 5000, policy: 'approved_only' });
  });

  it('accepts --auth subscription for the default (Anthropic) provider', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--auth', 'subscription'])).toMatchObject({
      ai: { provider: 'anthropic', auth: 'subscription', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
    });
  });

  it('parses the provider, auth and both models', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'openai', '--translate-model', 'gpt-6-sol', '--judge-model', 'gpt-6-luna'])).toMatchObject({
      ai: { provider: 'openai', auth: 'api', translateModel: 'gpt-6-sol', judgeModel: 'gpt-6-luna' },
    });
  });

  it('defaults to Anthropic with the API key and the default models; an empty model means the default', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--translate-model', ''])).toMatchObject({
      ai: { provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
    });
  });

  // Assert the three exact error texts, not only that an `error` field exists.
  it('rejects an unknown provider, a subscription outside Anthropic and a missing model for other providers', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'mistral'])).toEqual({ error: `Invalid provider mistral\n${USAGE}` });
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'openai', '--auth', 'subscription', '--translate-model', 'a', '--judge-model', 'b'])).toEqual({
      error: `--auth subscription is only available for --provider anthropic\n${USAGE}`,
    });
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'gemini', '--translate-model', 'a'])).toEqual({
      error: `--provider gemini needs --translate-model and --judge-model\n${USAGE}`,
    });
  });

  it('passes the web folders through, spaces and non-ASCII letters included, and omits them when not given', () => {
    const webDir = 'C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/Marketplace/LocHub/Resources/LocHubWeb';
    const webDepsDir = 'D:/Проекты/LocHub/Source/ThirdParty/LocHubWebDeps';
    expect(parseCliArgs(['serve', '--project', 'P', '--web-dir', webDir, '--web-deps-dir', webDepsDir])).toMatchObject({ webDir, webDepsDir });
    const plain = parseCliArgs(['serve', '--project', 'P']);
    expect('error' in plain).toBe(false);
    expect('webDir' in plain || 'webDepsDir' in plain).toBe(false);
  });

  it('reports usage errors', () => {
    expect(parseCliArgs([])).toHaveProperty('error');
    expect(parseCliArgs(['serve'])).toHaveProperty('error');
    expect(parseCliArgs(['serve', '--project', 'P', '--port', 'abc'])).toHaveProperty('error');
    expect(parseCliArgs(['serve', '--project', 'P', '--policy', 'yolo'])).toHaveProperty('error');
  });

  it('passes --brief-file through, and omits it when not given', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--brief-file', 'D:/Projects/MyGame/Saved/LocHub/brief.md'])).toMatchObject({
      briefFile: 'D:/Projects/MyGame/Saved/LocHub/brief.md',
    });
    const plain = parseCliArgs(['serve', '--project', 'P']);
    expect('error' in plain).toBe(false);
    expect('briefFile' in plain).toBe(false);
  });

  it('rejects a custom flag with any other provider, like --auth subscription outside Anthropic', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'openai', '--translate-model', 'a', '--judge-model', 'b', '--base-url', 'http://localhost:11434/v1'])).toEqual({
      error: `--base-url is only available for --provider custom\n${USAGE}`,
    });
    expect(parseCliArgs(['serve', '--project', 'P', '--max-parallel', '2'])).toEqual({ error: `--max-parallel is only available for --provider custom\n${USAGE}` });
  });

  it('still requires both models for the custom provider', () => {
    expect(parseCliArgs(['serve', '--project', 'P', '--provider', 'custom', '--translate-model', 'qwen3:8b', '--base-url', 'http://localhost:11434/v1'])).toEqual({
      error: `--provider custom needs --translate-model and --judge-model\n${USAGE}`,
    });
  });
});

describe('parseCliArgs --provider custom', () => {
  const serve = ['serve', '--project', 'P', '--provider', 'custom', '--translate-model', 'qwen3:8b', '--judge-model', 'qwen3:8b'];

  it('passes the endpoint settings through as ai.custom, with the settings id the editor computes', () => {
    expect(
      parseCliArgs([
        ...serve,
        '--base-url', 'https://example.test/openai/v1',
        '--key-header', 'api-key',
        '--structured-output', 'prompt_only',
        '--price-in', '0.15',
        '--price-out', '0.6',
        '--max-parallel', '4',
        '--request-timeout', '120',
      ]),
    ).toEqual({
      projectDir: 'P',
      port: 47810,
      host: '127.0.0.1',
      policy: 'validated',
      ai: {
        provider: 'custom',
        auth: 'api',
        translateModel: 'qwen3:8b',
        judgeModel: 'qwen3:8b',
        custom: {
          baseUrl: 'https://example.test/openai/v1',
          keyHeader: 'api-key',
          structuredOutput: 'prompt_only',
          priceIn: 0.15,
          priceOut: 0.6,
          maxParallel: 4,
          requestTimeoutSeconds: 120,
          settingsId: '27d001e56f42',
        },
      },
      length: { mode: 'off', scope: 'ui', ratio: 1.3, extra: 4, ratios: {}, hint: true },
    });
  });

  it('rejects a custom endpoint without a usable base URL, never echoing the URL', () => {
    expect(parseCliArgs(serve, {})).toEqual({ error: `Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL\n${USAGE}` });
    expect(parseCliArgs([...serve, '--base-url', 'localhost:11434/v1'], {})).toEqual({ error: `Invalid --base-url: it must start with http:// or https://\n${USAGE}` });
    const withPassword = parseCliArgs([...serve, '--base-url', 'http://user:secret-pw@localhost:11434/v1'], {});
    expect('error' in withPassword ? withPassword.error : '').toContain('user name or password');
    expect(JSON.stringify(withPassword)).not.toContain('secret-pw');
  });

  // Amendment 1: the editor sets LOCHUB_CUSTOM_BASE_URL for the spawn instead of putting the Base URL on the
  // command line; --base-url (a manual run, Tools/media/shoot.mjs) still wins when both are given.
  describe('env seam (LOCHUB_CUSTOM_BASE_URL)', () => {
    const withoutUrl = ['serve', '--project', 'P', '--provider', 'custom', '--translate-model', 'qwen3:8b', '--judge-model', 'qwen3:8b'];

    it('the --base-url flag wins over the environment', () => {
      const result = parseCliArgs([...withoutUrl, '--base-url', 'http://from-flag:11434/v1'], { LOCHUB_CUSTOM_BASE_URL: 'http://from-env:11434/v1' });
      expect('error' in result ? result.error : (result.ai.custom?.baseUrl ?? '')).toBe('http://from-flag:11434/v1');
    });

    it('falls back to LOCHUB_CUSTOM_BASE_URL when no --base-url flag is given', () => {
      const result = parseCliArgs(withoutUrl, { LOCHUB_CUSTOM_BASE_URL: 'http://from-env:11434/v1' });
      expect('error' in result ? result.error : (result.ai.custom?.baseUrl ?? '')).toBe('http://from-env:11434/v1');
    });

    it('is required from either source, and errors as "Custom Base URL" once the env value is what is invalid', () => {
      expect(parseCliArgs(withoutUrl, {})).toEqual({ error: `Custom Base URL is required: pass --base-url or set LOCHUB_CUSTOM_BASE_URL\n${USAGE}` });
      expect(parseCliArgs(withoutUrl, { LOCHUB_CUSTOM_BASE_URL: 'not a url' })).toEqual({
        error: `Invalid Custom Base URL: it must start with http:// or https://\n${USAGE}`,
      });
    });
  });
});

describe('resolveCustomBaseUrl', () => {
  it('reads LOCHUB_CUSTOM_BASE_URL, treating an empty value as absent', () => {
    expect(resolveCustomBaseUrl({ LOCHUB_CUSTOM_BASE_URL: 'http://localhost:11434/v1' })).toBe('http://localhost:11434/v1');
    expect(resolveCustomBaseUrl({})).toBeUndefined();
    expect(resolveCustomBaseUrl({ LOCHUB_CUSTOM_BASE_URL: '' })).toBeUndefined();
  });
});

describe('resolveApiKey', () => {
  // key-contract.md §1/§2: the service reads only LOCHUB_API_KEY -- every provider-specific variable is
  // ignored, and an empty value means no key, same as an absent one.
  it('reads only LOCHUB_API_KEY, ignoring every provider-specific variable', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b', GOOGLE_API_KEY: 'c' })).toBeUndefined();
    expect(resolveApiKey({ LOCHUB_API_KEY: 'test-key-not-real' })).toBe('test-key-not-real');
    expect(resolveApiKey({})).toBeUndefined();
    expect(resolveApiKey({ LOCHUB_API_KEY: '' })).toBeUndefined();
  });
});

describe('readBriefFile', () => {
  it('an absent flag (undefined path) reads as an empty brief, hashing to the SHA-1 of empty input', () => {
    expect(readBriefFile(undefined)).toEqual({ text: '', sha1: createHash('sha1').update('').digest('hex') });
  });

  it('a missing file reads the same as an absent flag', () => {
    expect(readBriefFile('D:/does/not/exist/brief.md')).toEqual({ text: '', sha1: createHash('sha1').update('').digest('hex') });
  });

  it('strips a UTF-8 BOM from the text but hashes the raw bytes, BOM included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lochub-cli-brief-'));
    const path = join(dir, 'brief.md');
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Open-world job simulator.', 'utf8')]);
    writeFileSync(path, raw);
    const result = readBriefFile(path);
    expect(result.text).toBe('Open-world job simulator.');
    expect(result.sha1).toBe(createHash('sha1').update(raw).digest('hex'));
    // The BOM's bytes are part of the hash: stripping it from the text must not also change what was hashed.
    expect(result.sha1).not.toBe(createHash('sha1').update('Open-world job simulator.').digest('hex'));
  });
});

describe('parseCliArgs: Length Check flags', () => {
  // The exact strings the editor builds (LocHubLengthCheckTests.cpp, LocHub.LengthCheck.Arguments): parsing them and
  // writing them back with lengthArgsOf must give the same string, or the editor would restart the service forever.
  const DEFAULTS = '--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4 --length-hint on';
  const EVERYTHING = '--length-check confirm --length-scope all --length-ratio 1.00 --length-extra 100 --length-ratios de=1.50,ja=5.00,pt-BR=1.20 --length-hint off';
  const parse = (...flags: string[]) => parseCliArgs(['serve', '--project', 'P', ...flags]);

  it('is off when no length flag is given (an older plugin)', () => {
    expect(parse()).toMatchObject({ length: LENGTH_CHECK_OFF });
  });

  it('parses every flag', () => {
    expect(parse(...EVERYTHING.split(' '))).toMatchObject({
      length: { mode: 'confirm', scope: 'all', ratio: 1, extra: 100, ratios: { de: 1.5, ja: 5, 'pt-BR': 1.2 }, hint: false },
    });
  });

  it("round-trips the editor's flag strings through lengthArgsOf", () => {
    for (const flags of [DEFAULTS, EVERYTHING, '--length-check off']) {
      const config = parse(...flags.split(' '));
      if ('error' in config) throw new Error(config.error);
      expect(lengthArgsOf(config.length)).toBe(flags);
    }
  });

  it('rejects each malformed flag with a usage error', () => {
    const ratiosError = (value: string) => `Invalid --length-ratios ${value} (<culture>=<ratio>,... with each culture once and ratios from 1 to 5)\n${USAGE}`;
    expect(parse('--length-check', 'sometimes')).toEqual({ error: `Invalid --length-check sometimes\n${USAGE}` });
    expect(parse('--length-scope', 'ui-only')).toEqual({ error: `Invalid --length-scope ui-only\n${USAGE}` });
    for (const ratio of ['0.9', '5.5', 'abc'])
      expect(parse('--length-ratio', ratio)).toEqual({ error: `Invalid --length-ratio ${ratio} (a number from 1 to 5)\n${USAGE}` });
    for (const extra of ['101', '2.5'])
      expect(parse('--length-extra', extra)).toEqual({ error: `Invalid --length-extra ${extra} (a whole number from 0 to 100)\n${USAGE}` });
    for (const ratios of ['de=9', 'de DE=1.5', 'de=1.5,DE=1.4', 'de', '1de=1.5'])
      expect(parse('--length-ratios', ratios)).toEqual({ error: ratiosError(ratios) });
    expect(parse('--length-hint', 'maybe')).toEqual({ error: `Invalid --length-hint maybe\n${USAGE}` });
  });
});
