#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BridgeHub } from './bridge.js';
import { ResponseCache } from './cache.js';
import type { ReleasePolicy } from './contract.js';
import { CUSTOM_FLAGS, parseCustomEndpointFlags, type CustomEndpointConfig, type CustomFlag } from './customEndpoint.js';
import { DEFAULT_JOB_OPTIONS } from './job.js';
import { LENGTH_CHECK_OFF, type LengthCheckConfig } from './lengthCheck.js';
import { AI_PROVIDERS, createLlmClient, jobDefaultsFor, type AiAuth, type AiConfig, type AiProvider } from './providers.js';
import { buildServer } from './server.js';
import { LocHubStore, stripBom } from './store.js';

// m-6: there is no `lochub` executable (package.json has no `bin`) -- this is the real invocation
// FLocHubServiceProcess::StartNode runs (Node.js on the built bundle), not a CLI the user installs.
export const USAGE =
  'Usage: node <plugin>/Resources/LocHubService/lochub_service.mjs serve --project <ProjectDir> [--port 47810] [--policy validated|approved_only] ' +
  '[--provider anthropic|openai|xai|deepseek|gemini|custom] [--auth api|subscription] [--translate-model <id>] [--judge-model <id>]' +
  ' [--web-dir <dir>] [--web-deps-dir <dir>] [--brief-file <path>]' +
  ' [--base-url <url> | env LOCHUB_CUSTOM_BASE_URL] [--key-header bearer|api-key] [--structured-output json_schema|json_object|prompt_only]' +
  ' [--price-in <usd>] [--price-out <usd>] [--max-parallel <1-32>] [--request-timeout <30-300>]' +
  ' [--length-check off|warning|confirm] [--length-scope ui|all] [--length-ratio <1-5>] [--length-extra <0-100>] [--length-ratios <culture>=<ratio>,...] [--length-hint on|off]';

export interface CliConfig {
  projectDir: string;
  port: number;
  host: '127.0.0.1';
  policy: ReleasePolicy;
  ai: AiConfig;
  // Resources/LocHubWeb and Source/ThirdParty/LocHubWebDeps of the plugin; absent: the service answers the API only.
  webDir?: string;
  webDepsDir?: string;
  // Project Settings' Project Brief, written by the editor before every start (Saved/LocHub/brief.md); absent:
  // an old plugin build, or a caller with no brief to give -- an empty brief either way.
  briefFile?: string;
  // Project Settings > Plugins > LocHub > Length Check (--length-* flags); LENGTH_CHECK_OFF when none is given.
  length: LengthCheckConfig;
}

// Read once at start: --brief-file names a UTF-8 text file (a BOM is tolerated and stripped from the text the
// job/prompt code sees); an absent flag or a missing file means an empty brief. `sha1` hashes the raw bytes as
// read, BOM included, so /api/health's ai.briefSha1 can be compared byte for byte against the hash the editor
// computed when it wrote the file (LocHubServiceProcess::WriteBriefFile).
export function readBriefFile(path: string | undefined): { text: string; sha1: string } {
  const bytes = path && existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  return { text: stripBom(bytes.toString('utf8')), sha1 };
}

// Read once at start, like readBriefFile: LOCHUB_API_KEY is the only source of a provider key
// (key-contract.md §1/§2) -- empty or absent means no key. Resolved here and passed explicitly to
// createLlmClient so no adapter's SDK/fetch call ever falls back to reading its own env var.
export function resolveApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.LOCHUB_API_KEY || undefined;
}

// Amendment 1 (final review, 2026-09-27): the editor sets this for the spawn exactly like LOCHUB_API_KEY, and the
// serve line it builds no longer carries --base-url at all (Windows logs a failed CreateProcess's whole command
// line; macOS's argument splitter drops a value ending in '='). --base-url still wins when a caller passes both
// (manual runs, Tools/media/shoot.mjs) -- see parseCustomEndpointFlags.
export function resolveCustomBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.LOCHUB_CUSTOM_BASE_URL || undefined;
}

const RATIO_TEXT = /^\d+(?:\.\d+)?$/;
const EXTRA_TEXT = /^\d+$/;
// A culture or language code as the editor sends it (FLocHubServiceProcess::BuildLengthArguments): ASCII letters,
// digits, '-' and '_', starting with a letter.
const CULTURE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

function parseRatio(text: string): number | undefined {
  if (!RATIO_TEXT.test(text)) return undefined;
  const ratio = Number(text);
  return ratio >= 1 && ratio <= 5 ? ratio : undefined;
}

// The --length-* flags. An absent flag keeps LENGTH_CHECK_OFF's value, so a caller that passes none (an older
// plugin) runs with the check off.
function parseLengthFlags(values: Record<string, unknown>): LengthCheckConfig | { error: string } {
  const flag = (name: string): string | undefined => (typeof values[name] === 'string' ? (values[name] as string) : undefined);
  const mode = flag('length-check') ?? LENGTH_CHECK_OFF.mode;
  if (mode !== 'off' && mode !== 'warning' && mode !== 'confirm') return { error: `Invalid --length-check ${mode}` };
  const scope = flag('length-scope') ?? LENGTH_CHECK_OFF.scope;
  if (scope !== 'ui' && scope !== 'all') return { error: `Invalid --length-scope ${scope}` };
  const ratioText = flag('length-ratio');
  const ratio = ratioText === undefined ? LENGTH_CHECK_OFF.ratio : parseRatio(ratioText);
  if (ratio === undefined) return { error: `Invalid --length-ratio ${ratioText} (a number from 1 to 5)` };
  const extraText = flag('length-extra');
  const extra = extraText === undefined ? LENGTH_CHECK_OFF.extra : Number(extraText);
  if (extraText !== undefined && (!EXTRA_TEXT.test(extraText) || extra > 100))
    return { error: `Invalid --length-extra ${extraText} (a whole number from 0 to 100)` };
  const ratiosText = flag('length-ratios') ?? '';
  const ratios: Record<string, number> = {};
  const seen = new Set<string>();
  for (const pair of ratiosText === '' ? [] : ratiosText.split(',')) {
    const [culture = '', value = '', ...rest] = pair.split('=');
    const parsed = parseRatio(value);
    if (rest.length > 0 || !CULTURE_KEY.test(culture) || parsed === undefined || seen.has(culture.toLowerCase()))
      return { error: `Invalid --length-ratios ${ratiosText} (<culture>=<ratio>,... with each culture once and ratios from 1 to 5)` };
    seen.add(culture.toLowerCase());
    ratios[culture] = parsed;
  }
  const hint = flag('length-hint') ?? (LENGTH_CHECK_OFF.hint ? 'on' : 'off');
  if (hint !== 'on' && hint !== 'off') return { error: `Invalid --length-hint ${hint}` };
  return { mode, scope, ratio, extra, ratios, hint: hint === 'on' };
}

// `env` defaults to the real process environment; a caller (tests) passes a fake one so this stays reproducible
// regardless of what LOCHUB_CUSTOM_BASE_URL happens to be set to in the shell that runs it.
export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        port: { type: 'string', default: '47810' },
        policy: { type: 'string', default: 'validated' },
        provider: { type: 'string', default: 'anthropic' },
        auth: { type: 'string', default: 'api' },
        'translate-model': { type: 'string', default: '' },
        'judge-model': { type: 'string', default: '' },
        'web-dir': { type: 'string', default: '' },
        'web-deps-dir': { type: 'string', default: '' },
        'brief-file': { type: 'string', default: '' },
        // --provider custom only; no defaults here, so "given with another provider" stays detectable.
        'base-url': { type: 'string' },
        'key-header': { type: 'string' },
        'structured-output': { type: 'string' },
        'price-in': { type: 'string' },
        'price-out': { type: 'string' },
        'max-parallel': { type: 'string' },
        'request-timeout': { type: 'string' },
        'length-check': { type: 'string' },
        'length-scope': { type: 'string' },
        'length-ratio': { type: 'string' },
        'length-extra': { type: 'string' },
        'length-ratios': { type: 'string' },
        'length-hint': { type: 'string' },
      },
    });
  } catch (error) {
    return { error: `${(error as Error).message}\n${USAGE}` };
  }
  const { values, positionals } = parsed;
  if (positionals[0] !== 'serve' || !values.project) return { error: USAGE };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `Invalid port ${values.port}\n${USAGE}` };
  if (values.policy !== 'validated' && values.policy !== 'approved_only') return { error: `Invalid policy ${values.policy}\n${USAGE}` };
  if (!(AI_PROVIDERS as readonly string[]).includes(values.provider as string)) return { error: `Invalid provider ${values.provider}\n${USAGE}` };
  const provider = values.provider as AiProvider;
  if (values.auth !== 'api' && values.auth !== 'subscription') return { error: `Invalid auth ${values.auth}\n${USAGE}` };
  const auth = values.auth as AiAuth;
  if (auth === 'subscription' && provider !== 'anthropic') return { error: `--auth subscription is only available for --provider anthropic\n${USAGE}` };
  // An empty string (the option's own default, or an explicit --translate-model '') means "not given".
  const translateModelArg = values['translate-model'] || undefined;
  const judgeModelArg = values['judge-model'] || undefined;
  let translateModel: string;
  let judgeModel: string;
  if (provider === 'anthropic') {
    translateModel = translateModelArg ?? DEFAULT_JOB_OPTIONS.translateModel;
    judgeModel = judgeModelArg ?? DEFAULT_JOB_OPTIONS.judgeModel;
  } else {
    // Model lists go stale faster than the plugin ships: every other provider requires an
    // explicit model instead of a guessed default.
    if (!translateModelArg || !judgeModelArg) return { error: `--provider ${provider} needs --translate-model and --judge-model\n${USAGE}` };
    translateModel = translateModelArg;
    judgeModel = judgeModelArg;
  }
  // The Custom endpoint flags: validated for --provider custom, a usage error with any other provider (the same
  // shape as the --auth subscription rejection above).
  const customValues: Partial<Record<CustomFlag, string>> = {};
  for (const flag of CUSTOM_FLAGS) {
    const value = values[flag];
    if (value !== undefined) customValues[flag] = value;
  }
  let custom: CustomEndpointConfig | undefined;
  if (provider === 'custom') {
    const parsedCustom = parseCustomEndpointFlags(customValues, resolveCustomBaseUrl(env));
    if ('error' in parsedCustom) return { error: `${parsedCustom.error}\n${USAGE}` };
    custom = parsedCustom;
  } else {
    const stray = CUSTOM_FLAGS.find((flag) => customValues[flag] !== undefined);
    if (stray) return { error: `--${stray} is only available for --provider custom\n${USAGE}` };
  }
  const length = parseLengthFlags(values);
  if ('error' in length) return { error: `${length.error}\n${USAGE}` };
  // Local mode: loopback only, no inbound access from other machines.
  return {
    projectDir: values.project,
    port,
    host: '127.0.0.1',
    policy: values.policy,
    ai: { provider, auth, translateModel, judgeModel, ...(custom ? { custom } : {}) },
    length,
    ...(values['web-dir'] ? { webDir: values['web-dir'] } : {}),
    ...(values['web-deps-dir'] ? { webDepsDir: values['web-deps-dir'] } : {}),
    ...(values['brief-file'] ? { briefFile: values['brief-file'] } : {}),
  };
}

// Started unconditionally by src/main.ts (the bundle's actual entry point) -- never by importing this file, so
// a test that imports parseCliArgs/resolveApiKey/readBriefFile from here never starts a server as a side effect.
// See main.ts for why this file no longer runs main() itself (I-1: the old `import.meta.url === argv[1]` guard
// compares a realpath to the path the caller gave, which never match through a junction/symlink -- the editor
// passes the plugin's own path, exits 0 and logs nothing when that path is a junction).
export async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  if ('error' in config) {
    console.error(config.error);
    process.exit(2);
  }
  // The engine's plural forms from the last Push, persisted so they survive the service restart the editor
  // runs on every AI/brief setting change: Saved/LocHub, like the response cache below, not Localization/LocHub
  // (source-controlled) -- they describe the running engine, not project data.
  const store = LocHubStore.load(join(config.projectDir, 'Localization', 'LocHub'), join(config.projectDir, 'Saved', 'LocHub', 'plural_forms.json'), join(config.projectDir, 'Saved', 'LocHub', 'native_culture.json'));
  // Subscription auth needs no provider key at all, so this only runs for `--auth api`.
  const apiKey = config.ai.auth === 'api' ? resolveApiKey(process.env) : undefined;
  const llm = createLlmClient(config.ai, resolve(config.projectDir), apiKey);
  const { text: brief, sha1: briefSha1 } = readBriefFile(config.briefFile);
  const jobDefaults = { ...jobDefaultsFor(config.ai), brief, lengthCheck: config.length };
  const app = buildServer({
    store,
    llm,
    cache: new ResponseCache(join(config.projectDir, 'Saved', 'LocHub', 'cache')),
    jobDefaults,
    briefSha1,
    bridge: new BridgeHub(),
    policy: config.policy,
    webRoot: config.webDir,
    webDepsRoot: config.webDepsDir,
    port: config.port,
    projectDir: resolve(config.projectDir),
    ai: config.ai,
  });
  await app.listen({ port: config.port, host: config.host });
  console.log(`LocHub listening on http://${config.host}:${config.port} (units: ${store.units.size})`);
}
