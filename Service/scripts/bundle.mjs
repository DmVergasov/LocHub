// Builds the two files the plugin ships for the service (spec §3, Fab 4.3.7.3.d):
//   Resources/LocHubService/lochub_service.mjs            -- our code, one ESM file
//   Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs -- the npm packages it uses, plus LICENSES/
// No minification and no source maps: the shipped code stays readable for review.
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packageDirsFromModuleIds, writeThirdPartyNotices } from '../../Tools/thirdparty.mjs';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { root: { type: 'string', default: resolve(serviceDir, '..') } } });
const pluginRoot = resolve(values.root);
const depsDir = join(pluginRoot, 'Source', 'ThirdParty', 'LocHubNodeDeps');
// The service bundle reaches the deps bundle by this relative specifier; the plugin layout is fixed (spec §3).
const DEPS_SPECIFIER = '../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs';
// m-5: the publisher notice, first line of both shipped bundles (esbuild puts a banner after an entry's own
// hashbang line, so on lochub_service.mjs -- whose entry, main.ts, starts with #!/usr/bin/env node -- this
// lands as line 2, and the hashbang itself stays line 1).
const COPYRIGHT_BANNER = '// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.';

const common = {
  absWorkingDir: serviceDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
};

const deps = await build({
  ...common,
  entryPoints: [join(serviceDir, 'src', 'deps.ts')],
  outfile: join(depsDir, 'lochub_node_deps.mjs'),
  metafile: true,
  // Copyright first (deps.ts has no hashbang, so this banner text is the literal start of the file), then the
  // createRequire shim: CommonJS packages inside an ESM bundle require() Node built-ins, and esbuild's own
  // shim throws without a real require. Order matters -- swapping them would still work at runtime, but the
  // copyright would no longer be the file's first line.
  banner: {
    js: `${COPYRIGHT_BANNER}\nimport { createRequire as __lochubCreateRequire } from 'node:module';\nconst require = __lochubCreateRequire(import.meta.url);`,
  },
});

const ownCodeOnly = {
  name: 'lochub-own-code-only',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/deps\.js$/ }, () => ({ path: DEPS_SPECIFIER, external: true }));
    // The entry point arrives here too, as an absolute Windows path ("D:\\...\\cli.ts"), which the filter also matches.
    builder.onResolve({ filter: /^[^./]/ }, (args) =>
      args.kind === 'entry-point' || args.path.startsWith('node:')
        ? undefined
        : { errors: [{ text: `npm import "${args.path}" outside src/deps.ts: re-export it from src/deps.ts` }] },
    );
  },
};

await build({
  ...common,
  // main.ts, not cli.ts: it calls main() unconditionally, with no realpath/argv[1] guard that a
  // junction/symlinked plugin path can defeat (I-1) -- cli.ts stays importable side-effect-free for tests.
  entryPoints: [join(serviceDir, 'src', 'main.ts')],
  outfile: join(pluginRoot, 'Resources', 'LocHubService', 'lochub_service.mjs'),
  plugins: [ownCodeOnly],
  banner: { js: COPYRIGHT_BANNER },
});

const packages = writeThirdPartyNotices({
  packageDirs: packageDirsFromModuleIds(Object.keys(deps.metafile.inputs).map((input) => resolve(serviceDir, input))),
  outDir: depsDir,
  overridesDir: resolve(serviceDir, '..', 'Tools', 'license_overrides'),
});
console.log(`Service bundle: ${packages.length} npm packages -> ${depsDir}`);
