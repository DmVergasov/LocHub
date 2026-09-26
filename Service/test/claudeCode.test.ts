import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkClaudeAuthStatus, ClaudeCodeLlmClient, createProcessRunner, type ProcessRunOptions, type ProcessRunner, type SpawnResult } from '../src/claudeCode.js';
import type { LlmRequest } from '../src/llm.js';

interface RecordedCall {
  args: string[];
  options: ProcessRunOptions;
  // Captured at call time, before ClaudeCodeLlmClient deletes the file once the runner settles.
  promptFileContent: string;
}

function fakeRunner(respond: (call: RecordedCall) => SpawnResult | Promise<SpawnResult>): { runner: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: ProcessRunner = async (args, options) => {
    const systemPromptFile = args[args.indexOf('--system-prompt-file') + 1]!;
    const call: RecordedCall = { args, options, promptFileContent: readFileSync(systemPromptFile, 'utf8') };
    calls.push(call);
    return respond(call);
  };
  return { runner, calls };
}

const okJson = (body: Record<string, unknown>): SpawnResult => ({ stdout: JSON.stringify(body), stderr: '', exitCode: 0 });

const PARAMS: Anthropic.MessageCreateParamsNonStreaming = {
  model: 'claude-opus-5',
  max_tokens: 16000,
  system: [
    { type: 'text', text: 'RULES' },
    { type: 'text', text: 'CONTEXT' },
  ],
  messages: [{ role: 'user', content: '{"group":"g1"}' }],
  output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
};

function request(customId = 'r1'): LlmRequest {
  return { customId, params: PARAMS };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ClaudeCodeLlmClient', () => {
  it('builds the exact CLI args, writes the system text to a file, and sends the user content on stdin', async () => {
    const { runner, calls } = fakeRunner(() => okJson({ is_error: false, structured_output: { translation: 'x' }, usage: {} }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'D:/Projects/MyGame', runner });
    await client.runSync([request()], 1);

    expect(calls).toHaveLength(1);
    const { args, options, promptFileContent } = calls[0]!;
    const at = (flag: string) => args[args.indexOf(flag) + 1];

    expect(args[0]).toBe('-p');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(at('--tools')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(at('--output-format')).toBe('json');
    expect(at('--model')).toBe('claude-opus-5');
    expect(at('--effort')).toBe('low');
    expect(at('--json-schema')).toBe(JSON.stringify({ type: 'object' }));
    expect(args).not.toContain('--bare');

    expect(promptFileContent).toBe('RULES\n\nCONTEXT');
    expect(options.stdin).toBe('{"group":"g1"}');
  });

  it('never passes --bare (it forces API-key-only auth and kills the subscription)', async () => {
    const { runner, calls } = fakeRunner(() => okJson({ is_error: false, structured_output: {}, usage: {} }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    await client.runSync([request()], 1);
    expect(calls[0]!.args).not.toContain('--bare');
  });

  it('scrubs API-key and Claude Code env vars but keeps unrelated ones', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-be-removed');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'tok-should-be-removed');
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('SOME_OTHER_VAR', 'keep-me');
    const { runner, calls } = fakeRunner(() => okJson({ is_error: false, structured_output: {}, usage: {} }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    await client.runSync([request()], 1);
    const { env } = calls[0]!.options;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.SOME_OTHER_VAR).toBe('keep-me');
  });

  it('runs in an empty cwd outside the project directory', async () => {
    const projectDir = 'D:/Projects/MyGame';
    const { runner, calls } = fakeRunner(() => okJson({ is_error: false, structured_output: {}, usage: {} }));
    const client = new ClaudeCodeLlmClient({ projectDir, runner });
    await client.runSync([request()], 1);
    const { cwd } = calls[0]!.options;
    expect(cwd.toLowerCase().startsWith(projectDir.toLowerCase())).toBe(false);
    expect(cwd).toContain('lochub-claude');
    expect(existsSync(cwd)).toBe(true);
  });

  it('maps a successful run to ok with the three input-token counters summed', async () => {
    const { runner } = fakeRunner(() =>
      okJson({
        subtype: 'success',
        is_error: false,
        result: '{"translation":"x"}',
        structured_output: { translation: 'x' },
        usage: { input_tokens: 2, cache_creation_input_tokens: 1153, cache_read_input_tokens: 0, output_tokens: 68 },
      }),
    );
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'ok', text: JSON.stringify({ translation: 'x' }), inputTokens: 1155, outputTokens: 68 });
  });

  it('maps is_error to a retryable outcome when the message looks like an overload', async () => {
    const { runner } = fakeRunner(() => okJson({ is_error: true, result: 'Overloaded: please retry later (529)' }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Claude Code: Overloaded: please retry later (529)', retryable: true });
  });

  it('maps is_error to a non-retryable outcome for a usage-limit message', async () => {
    const { runner } = fakeRunner(() => okJson({ is_error: true, result: 'Usage limit reached for this account' }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Claude Code: Usage limit reached for this account', retryable: false });
  });

  it('maps is_error to a non-retryable outcome for an auth message', async () => {
    const { runner } = fakeRunner(() => okJson({ is_error: true, result: 'Not authenticated. Run "claude" to sign in.' }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Claude Code: Not authenticated. Run "claude" to sign in.', retryable: false });
  });

  it('errors when the CLI succeeds but returns no structured_output', async () => {
    const { runner } = fakeRunner(() => okJson({ is_error: false, result: 'plain text answer' }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: 'Claude Code returned no structured output', retryable: false });
  });

  it('errors with the first 300 chars of stderr on non-JSON stdout', async () => {
    const longStderr = 'boom '.repeat(100);
    expect(longStderr.length).toBeGreaterThan(300);
    const { runner } = fakeRunner(() => ({ stdout: 'not json at all', stderr: longStderr, exitCode: 1 }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request()], 1);
    expect(outcome).toEqual({ customId: 'r1', kind: 'error', message: longStderr.slice(0, 300), retryable: false });
  });

  it('maps ENOENT to a fixed not-installed error for every request, not retryable', async () => {
    const spawnError = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { runner } = fakeRunner(() => ({ stdout: '', stderr: '', exitCode: null, spawnError }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const outcomes = await client.runSync([request('a'), request('b')], 2);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({
        customId: expect.any(String),
        kind: 'error',
        message: 'Claude Code (claude) was not found on PATH. Install it and run "claude" once to sign in.',
        retryable: false,
      });
    }
  });

  it('caps concurrency at 4 even when more requests and concurrency are given', async () => {
    let active = 0;
    let maxActive = 0;
    const { runner, calls } = fakeRunner(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return okJson({ is_error: false, structured_output: {}, usage: {} });
    });
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const requests = Array.from({ length: 9 }, (_, i) => request(`r${i}`));
    await client.runSync(requests, 9);
    expect(calls).toHaveLength(9);
    expect(maxActive).toBe(4);
  });

  it('runBatch always throws: batch mode needs an API key', async () => {
    const { runner } = fakeRunner(() => okJson({}));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    await expect(client.runBatch([], 1000)).rejects.toThrow('Batch mode needs an API key (LocHub AI Backend = API Key).');
  });

  it('countInputTokens approximates from character length plus the CLI overhead', async () => {
    const { runner } = fakeRunner(() => okJson({}));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const expectedChars = 'RULES\n\nCONTEXT'.length + '{"group":"g1"}'.length;
    const tokens = await client.countInputTokens(PARAMS);
    expect(tokens).toBe(Math.ceil(expectedChars / 3) + 1200);
  });
});

describe('checkClaudeAuthStatus', () => {
  it('is ready when the CLI reports loggedIn: true', async () => {
    const calls: Array<{ args: string[]; options: ProcessRunOptions }> = [];
    const runner: ProcessRunner = async (args, options) => {
      calls.push({ args, options });
      return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0 };
    };
    const status = await checkClaudeAuthStatus(runner);
    expect(status).toEqual({ ready: true, detail: 'Signed in to Claude Code' });
    expect(calls[0]!.args).toEqual(['auth', 'status', '--json']);
  });

  it('is not ready with a sign-in hint when loggedIn: false', async () => {
    const runner: ProcessRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: '', exitCode: 0 });
    const status = await checkClaudeAuthStatus(runner);
    expect(status).toEqual({ ready: false, detail: 'Claude Code is not signed in: run "claude" once and sign in.' });
  });

  it('is not ready with a not-found hint on ENOENT', async () => {
    const spawnError = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const runner: ProcessRunner = async () => ({ stdout: '', stderr: '', exitCode: null, spawnError });
    const status = await checkClaudeAuthStatus(runner);
    expect(status).toEqual({ ready: false, detail: 'Claude Code (claude) was not found on PATH.' });
  });

  it('scrubs the env and uses a 15s timeout, same as the translate calls', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-should-be-removed');
    let seen: ProcessRunOptions | undefined;
    const runner: ProcessRunner = async (_args, options) => {
      seen = options;
      return { stdout: JSON.stringify({ loggedIn: true }), stderr: '', exitCode: 0 };
    };
    await checkClaudeAuthStatus(runner);
    expect(seen?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen?.timeoutMs).toBe(15_000);
  });
});

// The real spawn path, driven with `node` instead of `claude` (same code, different command).
describe('createProcessRunner (real child process)', () => {
  const node = createProcessRunner(process.execPath);
  const options = (stdin: string, timeoutMs = 10_000): ProcessRunOptions => ({ cwd: process.cwd(), env: process.env, stdin, timeoutMs });

  it('decodes a UTF-8 character split across two stdout chunks', async () => {
    // U+041F (Cyrillic PE) is D0 9F; the two bytes arrive as separate chunks.
    const script = 'process.stdout.write(Buffer.from([0xd0])); setTimeout(() => process.stdout.write(Buffer.from([0x9f])), 100);';
    const result = await node(['-e', script], options(''));
    expect(result.stdout).toBe('П');
  });

  it('survives a child that exits without reading a large stdin', async () => {
    const result = await node(['-e', 'process.exit(3)'], options('x'.repeat(8 * 1024 * 1024)));
    expect(result.exitCode).toBe(3);
  });

  it('kills a child that outlives the timeout and reports it', async () => {
    const result = await node(['-e', 'setTimeout(() => {}, 30000)'], options('', 300));
    expect(result.timedOut).toBe(true);
  });
});

describe('ClaudeCodeLlmClient prompt files and timeouts', () => {
  it('gives two concurrent calls of the same request different prompt files', async () => {
    const { runner, calls } = fakeRunner(() => okJson({ is_error: false, structured_output: {}, usage: {} }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const same = request('same');
    await Promise.all([client.runSync([same], 1), client.runSync([same], 1)]);
    const files = calls.map((call) => call.args[call.args.indexOf('--system-prompt-file') + 1]);
    expect(files).toHaveLength(2);
    expect(files[0]).not.toBe(files[1]);
  });

  it('maps a timed-out child to a retryable error', async () => {
    const { runner } = fakeRunner(() => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }));
    const client = new ClaudeCodeLlmClient({ projectDir: 'P', runner });
    const [outcome] = await client.runSync([request('slow')], 1);
    expect(outcome).toMatchObject({ kind: 'error', retryable: true, message: 'Claude Code (claude) timed out after 10 minutes.' });
  });
});
