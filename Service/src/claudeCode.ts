import type Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmClient, LlmOutcome, LlmRequest } from './llm.js';
import { approxTokens, systemTextOf, userTextOf } from './llmShared.js';

// Every child is killed if it runs longer than this; a stuck `claude -p` must not hang a job forever.
const CHILD_TIMEOUT_MS = 10 * 60 * 1000;
// `claude auth status --json` is a lightweight local check; 15s is generous for a cold CLI start.
const AUTH_PROBE_TIMEOUT_MS = 15_000;

// Env vars an editor launched from inside a Claude Code terminal inherits. A present API key or CLAUDECODE
// marker would silently switch the child CLI off the subscription and onto (or into) another session.
const ENV_VARS_TO_STRIP = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) {
    if (ENV_VARS_TO_STRIP.has(key) || key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  // Set when the child process itself could not be started (e.g. ENOENT: `claude` not on PATH).
  spawnError?: NodeJS.ErrnoException;
  // Set when CHILD_TIMEOUT_MS (or the probe's own timeoutMs) elapsed and the child was killed.
  timedOut?: boolean;
}

export interface ProcessRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  // Written to the child's stdin, then the stream is closed.
  stdin: string;
  timeoutMs: number;
}

// Injectable so tests never start a real `claude` process (constructor option, like AnthropicLlmClientOptions.client).
export type ProcessRunner = (args: string[], options: ProcessRunOptions) => Promise<SpawnResult>;

// The command is a parameter only so tests can drive the real spawn path with `node` instead of `claude`.
export function createProcessRunner(command: string): ProcessRunner {
  return (args, { cwd, env, stdin, timeoutMs }) =>
    new Promise<SpawnResult>((resolve) => {
      const child = spawn(command, args, { cwd, env, windowsHide: true });
      // Raw chunks, decoded once at the end: a Cyrillic character split across two chunks would otherwise turn into
      // U+FFFD and break the JSON.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (spawnError: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ stdout: text(stdoutChunks), stderr: text(stderrChunks), exitCode: null, spawnError });
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout: text(stdoutChunks), stderr: text(stderrChunks), exitCode, timedOut });
      });
      // A child that dies before reading its input makes this write fail with EPIPE; unhandled, that 'error' event
      // would crash the whole service. The outcome itself is reported by 'close' / 'error' above.
      child.stdin?.on('error', () => {});
      child.stdin?.write(stdin);
      child.stdin?.end();
    });
}

export const defaultProcessRunner: ProcessRunner = createProcessRunner('claude');

// Claude Code walks up from its cwd and loads every CLAUDE.md it finds; a cwd inside the repo would pull the
// project's own (large) CLAUDE.md into every call. This isolated root lives outside the repo entirely, one
// subfolder per project (so two projects served at once do not collide) plus a shared, always-empty `prompts`
// sibling for the system-prompt files (never written into the cwd itself).
function isolatedRoot(): string {
  return join(tmpdir(), 'lochub-claude');
}

function isolatedCwd(projectDir: string): string {
  const hash = createHash('sha1').update(projectDir, 'utf8').digest('hex').slice(0, 12);
  return join(isolatedRoot(), hash);
}

function buildArgs(params: Anthropic.MessageCreateParamsNonStreaming, systemPromptFile: string): string[] {
  return [
    '-p',
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    '',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--model',
    params.model,
    '--effort',
    String(params.output_config?.effort ?? ''),
    '--system-prompt-file',
    systemPromptFile,
    '--json-schema',
    JSON.stringify(params.output_config?.format?.schema ?? {}),
  ];
}

// Overload/5xx-looking messages are worth a retry (the subscription hit a momentary server problem); a usage
// limit or an auth message will not succeed on retry and is final.
const RETRYABLE_MESSAGE_PATTERN = /overloaded?|internal server error|internal_server_error|\b5\d\d\b/i;

function mapResultToOutcome(customId: string, result: SpawnResult): LlmOutcome {
  if (result.spawnError) {
    if (result.spawnError.code === 'ENOENT') {
      return { customId, kind: 'error', message: 'Claude Code (claude) was not found on PATH. Install it and run "claude" once to sign in.', retryable: false };
    }
    // Some other failure to even start the child: not the documented ENOENT case, but still not a JSON
    // result from Claude Code, so treated the same way as the general spawn-failure branch below.
    return { customId, kind: 'error', message: result.spawnError.message.slice(0, 300), retryable: false };
  }
  if (result.timedOut) {
    return { customId, kind: 'error', message: 'Claude Code (claude) timed out after 10 minutes.', retryable: true };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout.trim());
  } catch {
    // Non-JSON stdout or a non-zero exit without JSON: nothing more to key off than stderr.
    return { customId, kind: 'error', message: result.stderr.slice(0, 300), retryable: false };
  }

  const body = payload as { is_error?: unknown; result?: unknown; structured_output?: unknown; usage?: Record<string, unknown> };
  if (body.is_error === true) {
    const text = typeof body.result === 'string' ? body.result : '';
    return { customId, kind: 'error', message: `Claude Code: ${text}`, retryable: RETRYABLE_MESSAGE_PATTERN.test(text) };
  }
  if (body.structured_output !== undefined && body.structured_output !== null) {
    const usage = body.usage ?? {};
    const num = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
    return {
      customId,
      kind: 'ok',
      text: JSON.stringify(body.structured_output),
      inputTokens: num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens'),
      outputTokens: num('output_tokens'),
    };
  }
  return { customId, kind: 'error', message: 'Claude Code returned no structured output', retryable: false };
}

export interface ClaudeCodeLlmClientOptions {
  // The project directory the service was started for; only its hash names the isolated cwd, so two
  // projects served at once on different ports get different, non-colliding cwds.
  projectDir: string;
  runner?: ProcessRunner;
}

export class ClaudeCodeLlmClient implements LlmClient {
  // The subscription backend has no countTokens equivalent (see countInputTokens below); every count is a guess.
  readonly countsAreApproximate = true;
  private readonly runner: ProcessRunner;
  private readonly cwd: string;
  private readonly promptsDir: string;

  constructor(options: ClaudeCodeLlmClientOptions) {
    this.runner = options.runner ?? defaultProcessRunner;
    this.cwd = isolatedCwd(options.projectDir);
    this.promptsDir = join(isolatedRoot(), 'prompts');
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.promptsDir, { recursive: true });
  }

  // Ignores LlmClient.runSync's shouldContinue (see there): a timed-out `claude` child is reported as an ordinary
  // retryable error, not a timeout the job probes on.
  async runSync(requests: LlmRequest[], concurrency: number, onOutcome?: (outcome: LlmOutcome) => void): Promise<LlmOutcome[]> {
    const out = new Array<LlmOutcome>(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const index = next++;
        const outcome = await this.runOne(requests[index]!);
        out[index] = outcome;
        onOutcome?.(outcome);
      }
    };
    // At most 4 `claude` children at once regardless of the caller's concurrency (a subscription seat is
    // meant for one interactive user, not an unbounded batch of parallel CLI processes).
    const workerCount = Math.max(1, Math.min(concurrency, 4, requests.length));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return out;
  }

  async runBatch(_requests: LlmRequest[], _pollMs: number): Promise<LlmOutcome[]> {
    throw new Error('Batch mode needs an API key (LocHub AI Backend = API Key).');
  }

  async countInputTokens(params: Anthropic.MessageCreateParamsNonStreaming): Promise<number> {
    // Approximation, no network call: the subscription backend has no countTokens endpoint (approxTokens: ~3
    // characters per token, one per CJK character); +1200 is the measured per-call CLI process overhead (process
    // start, restricted tool listing, structured-output scaffolding) seen on 2026-09-26.
    return approxTokens(systemTextOf(params) + userTextOf(params)) + 1200;
  }

  private async runOne(request: LlmRequest): Promise<LlmOutcome> {
    // Unique per call: two jobs can send the same request at once, and each deletes its own file when done.
    const promptFile = join(this.promptsDir, `${request.customId}-${randomUUID()}.txt`);
    writeFileSync(promptFile, systemTextOf(request.params), 'utf8');
    try {
      const args = buildArgs(request.params, promptFile);
      const options: ProcessRunOptions = {
        cwd: this.cwd,
        env: scrubEnv(process.env),
        stdin: userTextOf(request.params),
        timeoutMs: CHILD_TIMEOUT_MS,
      };
      const result = await this.runner(args, options);
      return mapResultToOutcome(request.customId, result);
    } finally {
      try {
        unlinkSync(promptFile);
      } catch {
        // Already gone, or never created because the runner threw synchronously; either way nothing to clean up.
      }
    }
  }
}

export interface ClaudeAuthStatus {
  ready: boolean;
  detail: string;
}

const AUTH_NOT_SIGNED_IN: ClaudeAuthStatus = { ready: false, detail: 'Claude Code is not signed in: run "claude" once and sign in.' };
const AUTH_NOT_FOUND: ClaudeAuthStatus = { ready: false, detail: 'Claude Code (claude) was not found on PATH.' };
const AUTH_SIGNED_IN: ClaudeAuthStatus = { ready: true, detail: 'Signed in to Claude Code' };

// Run once at server startup and cached by the caller (server.ts): checks whether the CLI is signed in to a
// Claude subscription, without ever inspecting (let alone logging) the account e-mail or any token the real
// `claude auth status --json` output also carries.
export async function checkClaudeAuthStatus(runner: ProcessRunner = defaultProcessRunner): Promise<ClaudeAuthStatus> {
  const result = await runner(['auth', 'status', '--json'], { cwd: tmpdir(), env: scrubEnv(process.env), stdin: '', timeoutMs: AUTH_PROBE_TIMEOUT_MS });
  if (result.spawnError?.code === 'ENOENT') return AUTH_NOT_FOUND;
  if (result.spawnError || result.timedOut) return AUTH_NOT_SIGNED_IN;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { loggedIn?: unknown };
    if (result.exitCode === 0 && parsed.loggedIn === true) return AUTH_SIGNED_IN;
  } catch {
    // Falls through to "not signed in" below: same detail as a clean exit 0 with loggedIn: false, since
    // neither case lets us claim the CLI is missing or that it is actually signed in.
  }
  return AUTH_NOT_SIGNED_IN;
}
