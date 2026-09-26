import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCliArgs, readBriefFile, resolveApiKey, USAGE } from '../src/cli.js';

describe('parseCliArgs', () => {
  it('parses serve with defaults and always binds loopback', () => {
    expect(parseCliArgs(['serve', '--project', 'D:/Projects/MyGame'])).toEqual({
      projectDir: 'D:/Projects/MyGame',
      port: 47810,
      host: '127.0.0.1',
      policy: 'validated',
      ai: { provider: 'anthropic', auth: 'api', translateModel: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5' },
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
