#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BridgeHub } from './bridge.js';
import { ResponseCache } from './cache.js';
import type { ReleasePolicy } from './contract.js';
import { DEFAULT_JOB_OPTIONS } from './job.js';
import { AI_PROVIDERS, createLlmClient, jobDefaultsFor, type AiAuth, type AiConfig, type AiProvider } from './providers.js';
import { buildServer } from './server.js';
import { LocHubStore, stripBom } from './store.js';

// m-6: there is no `lochub` executable (package.json has no `bin`) -- this is the real invocation
// FLocHubServiceProcess::StartNode runs (Node.js on the built bundle), not a CLI the user installs.
export const USAGE =
  'Usage: node <plugin>/Resources/LocHubService/lochub_service.mjs serve --project <ProjectDir> [--port 47810] [--policy validated|approved_only] ' +
  '[--provider anthropic|openai|xai|deepseek|gemini] [--auth api|subscription] [--translate-model <id>] [--judge-model <id>]' +
  ' [--web-dir <dir>] [--web-deps-dir <dir>] [--brief-file <path>]';

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

export function parseCliArgs(argv: string[]): CliConfig | { error: string } {
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
  // Local mode: loopback only, no inbound access from other machines.
  return {
    projectDir: values.project,
    port,
    host: '127.0.0.1',
    policy: values.policy,
    ai: { provider, auth, translateModel, judgeModel },
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
  const store = LocHubStore.load(join(config.projectDir, 'Localization', 'LocHub'), join(config.projectDir, 'Saved', 'LocHub', 'plural_forms.json'));
  // Subscription auth needs no provider key at all, so this only runs for `--auth api`.
  const apiKey = config.ai.auth === 'api' ? resolveApiKey(process.env) : undefined;
  const llm = createLlmClient(config.ai, resolve(config.projectDir), apiKey);
  const { text: brief, sha1: briefSha1 } = readBriefFile(config.briefFile);
  const jobDefaults = { ...jobDefaultsFor(config.ai), brief };
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
