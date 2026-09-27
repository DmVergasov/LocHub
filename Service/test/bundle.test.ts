import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { customSettingsIdOf } from '../src/customEndpoint.js';

const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.push(`${relative(root, path)} ${stat.size} ${stat.mtimeMs}`);
    }
  };
  walk(root);
  return out.sort();
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return (await response.json()) as Record<string, unknown>;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`No /api/health on port ${port} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('release bundle', () => {
  it('runs from a plugin folder with spaces and non-ASCII letters in its path and never writes into it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lochub bundle Проект '));
    const pluginRoot = join(root, 'Plugins', 'LocHub');
    const built = spawnSync(process.execPath, ['scripts/bundle.mjs', '--root', pluginRoot], { cwd: SERVICE_DIR, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);

    const serviceFile = join(pluginRoot, 'Resources', 'LocHubService', 'lochub_service.mjs');
    const serviceText = readFileSync(serviceFile, 'utf8');
    expect(serviceText).toContain('"../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs"');
    expect(serviceText).not.toMatch(/from\s+["'](fastify|@anthropic-ai\/sdk)["']/);
    expect(existsSync(join(pluginRoot, 'Source', 'ThirdParty', 'LocHubNodeDeps', 'LICENSES', 'fastify.txt'))).toBe(true);
    expect(readFileSync(join(pluginRoot, 'Source', 'ThirdParty', 'LocHubNodeDeps', 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toMatch(/^fastify \d/m);
    expect(listTree(pluginRoot).some((line) => line.split(' ')[0].endsWith('.map'))).toBe(false);

    // m-5: the publisher copyright line ships on both bundles. lochub_service.mjs keeps its hashbang on line 1
    // (esbuild inserts the banner right after it, not before).
    const serviceLines = serviceText.split('\n');
    expect(serviceLines[0]).toBe('#!/usr/bin/env node');
    expect(serviceLines[1]).toBe('// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.');
    const depsText = readFileSync(join(pluginRoot, 'Source', 'ThirdParty', 'LocHubNodeDeps', 'lochub_node_deps.mjs'), 'utf8');
    expect(depsText.split('\n')[0]).toBe('// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.');
    expect(depsText).toContain("const require = __lochubCreateRequire(import.meta.url);");

    const before = listTree(pluginRoot);
    const project = join(root, 'My Game');
    mkdirSync(project);
    const port = await freePort();
    const child = spawn(process.execPath, [serviceFile, 'serve', '--project', project, '--port', String(port)], { stdio: 'ignore' });
    try {
      const health = await waitForHealth(port, 20_000);
      expect(health.ok).toBe(true);
      expect(health.projectDir).toBe(resolve(project));
    } finally {
      child.kill();
    }
    expect(listTree(pluginRoot)).toEqual(before);
  }, 60_000);

  // I-1: the editor passes the plugin's own path, which the buyer may have behind a junction/symlink (a
  // second-drive `mklink /J`, or a shared plugin folder symlinked into several projects). The old cli.ts guard
  // compared `import.meta.url` (always the real path Node resolved) against `process.argv[1]` (the path it was
  // given) and silently skipped main() -- exit 0, nothing logged -- whenever those differ. main.ts (bundled as
  // the entry point instead of cli.ts) calls main() unconditionally, so this must pass regardless of how the
  // bundle was reached.
  it('starts when launched through a junction to the plugin folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lochub-junction-'));
    const realRoot = join(root, 'real');
    mkdirSync(realRoot, { recursive: true });
    const pluginRoot = join(realRoot, 'Plugins', 'LocHub');
    const built = spawnSync(process.execPath, ['scripts/bundle.mjs', '--root', pluginRoot], { cwd: SERVICE_DIR, encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);

    const linkedRoot = join(root, 'linked');
    symlinkSync(realRoot, linkedRoot, 'junction');
    const serviceFileViaJunction = join(linkedRoot, 'Plugins', 'LocHub', 'Resources', 'LocHubService', 'lochub_service.mjs');

    const project = join(root, 'My Game');
    mkdirSync(project);
    const port = await freePort();
    const child = spawn(process.execPath, [serviceFileViaJunction, 'serve', '--project', project, '--port', String(port)], { stdio: 'ignore' });
    try {
      const health = await waitForHealth(port, 20_000);
      expect(health.ok).toBe(true);
    } finally {
      child.kill();
    }
  }, 60_000);

  // M-8: cli.ts's main() wiring (config.length into jobDefaultsFor, the Custom endpoint config into
  // createLlmClient) is untested -- dropping it leaves every unit test green, yet health would report
  // "--length-check off" and no ai.endpoint, so the editor would restart the service on every poll. Spawns the
  // real, committed bundle (Resources/LocHubService/lochub_service.mjs) -- the one the editor actually runs --
  // with Custom endpoint and Length Check flags, and reads them back from /api/health.
  // NB-3: the Base URL goes only through LOCHUB_CUSTOM_BASE_URL, exactly as the editor passes it (amendment 1) -- no
  // --base-url on the command line -- so this proves main() reads the environment (cli.test.ts proves the flag still
  // wins when given).
  it('reports Length Check and Custom endpoint settings, Base URL from the environment, through the committed bundle\'s health (M-8)', async () => {
    const serviceFile = join(SERVICE_DIR, '..', 'Resources', 'LocHubService', 'lochub_service.mjs');
    const root = mkdtempSync(join(tmpdir(), 'lochub-custom-health-'));
    const project = join(root, 'My Game');
    mkdirSync(project);
    const port = await freePort();
    // Nothing listens here: the probe reports it unreachable quickly (ECONNREFUSED), which does not block
    // /api/health from answering -- the probe runs in the background (server.ts).
    const deadPort = await freePort();
    const baseUrl = `http://127.0.0.1:${deadPort}/v1?token=x`;
    const child = spawn(
      process.execPath,
      [
        serviceFile, 'serve', '--project', project, '--port', String(port),
        '--provider', 'custom', '--translate-model', 'qwen3:8b', '--judge-model', 'qwen3:8b',
        '--key-header', 'bearer', '--structured-output', 'json_schema',
        '--price-in', '0', '--price-out', '0', '--max-parallel', '2', '--request-timeout', '300',
        '--length-check', 'warning', '--length-scope', 'ui', '--length-ratio', '1.30', '--length-extra', '4', '--length-hint', 'on',
      ],
      { stdio: 'ignore', env: { ...process.env, LOCHUB_CUSTOM_BASE_URL: baseUrl } },
    );
    try {
      const health = await waitForHealth(port, 20_000);
      const ai = health.ai as Record<string, unknown>;
      expect(ai.lengthArgs).toBe('--length-check warning --length-scope ui --length-ratio 1.30 --length-extra 4 --length-hint on');
      expect(ai.customSettingsId).toBe(customSettingsIdOf([baseUrl, 'bearer', 'json_schema', '0', '0', '2', '300']));
      const endpoint = ai.endpoint as Record<string, unknown>;
      expect(endpoint.url).toBe(`http://127.0.0.1:${deadPort}`);
      expect(JSON.stringify(health)).not.toContain('token=x');
      expect(JSON.stringify(health)).not.toContain('/v1');
    } finally {
      child.kill();
    }
  }, 30_000);
});
