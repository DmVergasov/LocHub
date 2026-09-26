#!/usr/bin/env node
// Bundles Tools/media/demo_project.ts (with esbuild resolved from Service/node_modules, never installed
// here) into a temporary ESM file under Service/, runs it, then removes the temp bundle. Never writes
// or reads anything under Service/ or Web/ besides node_modules resolution and this scratch build dir,
// which is always removed again before this script exits.
//
// Usage: node Tools/media/run_demo.mjs --out <dir>
// Default <out>: <plugin>/Saved/Media/demo (LocHub's Saved/ directory).

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1];
      i++;
    }
  }
  return { out };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url)); // .../LocHub/Tools/media
  const pluginRoot = resolve(scriptDir, '..', '..'); // .../LocHub
  const serviceDir = join(pluginRoot, 'Service');
  const entry = join(scriptDir, 'demo_project.ts');

  const { out } = parseArgs(process.argv.slice(2));
  const outDir = out ? resolve(out) : join(pluginRoot, 'Saved', 'Media', 'demo');
  mkdirSync(outDir, { recursive: true });

  // Resolve esbuild from Service/node_modules without relying on Node's own resolution algorithm (this
  // script lives outside Service/, so a bare `import 'esbuild'` would not find it there).
  const require = createRequire(join(serviceDir, 'package.json'));
  const esbuildEntry = require.resolve('esbuild');
  const { build } = await import(pathToFileURL(esbuildEntry).href);

  // The temp bundle is created as a subdirectory of Service/ itself (not the OS temp dir): with
  // `packages: 'external'` below, the bundle's own npm imports (fastify, @anthropic-ai/sdk, ...) stay as
  // plain `import` specifiers, and Node resolves those by walking up from the importing file's directory —
  // which only finds Service/node_modules if the bundle actually lives under Service/. Bundling everything
  // instead (the old approach) pulled fastify's CJS dependency graph (avvio) into one file, and esbuild's
  // CJS-in-ESM interop shim cannot handle avvio's own conditional `require('node:events')`.
  const tmpBuildDir = mkdtempSync(join(serviceDir, '.demo-build-'));
  const bundlePath = join(tmpBuildDir, 'demo_project.bundle.mjs');

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: bundlePath,
      absWorkingDir: serviceDir,
      packages: 'external',
      logLevel: 'warning',
    });
    for (const warning of result.warnings) console.warn(warning.text);

    const mod = await import(pathToFileURL(bundlePath).href);
    await mod.main(outDir);
  } finally {
    rmSync(tmpBuildDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
