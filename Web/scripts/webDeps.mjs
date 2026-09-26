// Moves the vendor chunk out of Resources/LocHubWeb into Source/ThirdParty/LocHubWebDeps (Fab 4.3.7.3.d) and writes its
// licenses. The service serves that folder under the same URL (--web-deps-dir), so "./lochub_web_deps.js" still resolves.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPYRIGHT_LINE } from '../../Tools/release_checks.mjs';
import { packageDirsFromModuleIds, writeThirdPartyNotices } from '../../Tools/thirdparty.mjs';

const webPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK = 'lochub_web_deps.js';

// Same publisher line every shipped C++ file starts with (release_checks.mjs, Fab 4.3.6.1.b). rollupOptions.output.
// banner in vite.config.ts computes this text correctly (traced with Rollup's own renderChunk/generateBundle hooks)
// but does not end up in the bytes this project's Vite build actually writes for either chunk, so it is applied
// here instead, directly to the files Rollup already wrote, right before the vendor chunk is moved out. Idempotent
// (checks the current first line first) so it stays harmless if a future Vite/Rollup upgrade starts honoring the
// addon on its own.
function prependCopyrightOnce(filePath) {
  const current = readFileSync(filePath, 'utf8');
  if (current.startsWith(`${COPYRIGHT_LINE}\n`)) return;
  writeFileSync(filePath, `${COPYRIGHT_LINE}\n${current}`);
}

export function webDepsPlugin() {
  let moduleIds = [];
  return {
    name: 'lochub-web-deps',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunk = bundle[CHUNK];
      if (!chunk || chunk.type !== 'chunk') this.error(`The vendor chunk ${CHUNK} was not produced`);
      moduleIds = chunk.moduleIds;
    },
    writeBundle(options) {
      for (const name of readdirSync(options.dir)) if (name.endsWith('.js')) prependCopyrightOnce(join(options.dir, name));
      const depsDir = resolve(options.dir, '..', '..', 'Source', 'ThirdParty', 'LocHubWebDeps');
      mkdirSync(depsDir, { recursive: true });
      rmSync(join(depsDir, CHUNK), { force: true });
      renameSync(join(options.dir, CHUNK), join(depsDir, CHUNK));
      writeThirdPartyNotices({
        packageDirs: packageDirsFromModuleIds(moduleIds),
        outDir: depsDir,
        overridesDir: resolve(webPackageDir, '..', 'Tools', 'license_overrides'),
      });
    },
  };
}
