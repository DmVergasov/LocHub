// Asserts the shipped web layout after `vite build` (spec §3): fixed names, the vendor chunk in Source/ThirdParty with
// its licenses, relative references that the service can serve, and no source maps.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPYRIGHT_LINE } from '../../Tools/release_checks.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webDir = join(pluginRoot, 'Resources', 'LocHubWeb');
const depsDir = join(pluginRoot, 'Source', 'ThirdParty', 'LocHubWebDeps');
const problems = [];
const list = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

const web = list(webDir);
// The favicon ships alongside the built app (Vite copies public/ into outDir): four fixed names, not three.
if (web.join(',') !== 'favicon.svg,index.html,lochub_web.css,lochub_web.js') problems.push(`Resources/LocHubWeb holds ${web.join(', ') || 'nothing'}`);
const deps = list(depsDir);
if (deps.join(',') !== 'LICENSES,THIRD_PARTY_NOTICES.txt,lochub_web_deps.js') problems.push(`LocHubWebDeps holds ${deps.join(', ') || 'nothing'}`);
for (const license of ['react.txt', 'react_dom.txt', 'scheduler.txt', 'tanstack_react_virtual.txt', 'tanstack_virtual_core.txt']) {
  if (!list(join(depsDir, 'LICENSES')).includes(license)) problems.push(`Missing LICENSES/${license}`);
}
if (web.includes('index.html')) {
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');
  if (!html.includes('src="./lochub_web.js"')) problems.push('index.html does not load ./lochub_web.js');
  if (!html.includes('href="./lochub_web.css"')) problems.push('index.html does not load ./lochub_web.css');
}
// Rollup writes import specifiers in single quotes, esbuild in double quotes: accept both.
if (web.includes('lochub_web.js')) {
  const webJs = readFileSync(join(webDir, 'lochub_web.js'), 'utf8');
  if (!/["']\.\/lochub_web_deps\.js["']/.test(webJs)) problems.push('lochub_web.js does not import ./lochub_web_deps.js');
  // Fab 4.3.7.3.d: third-party code only in Source/ThirdParty. Vite's own modulepreload polyfill (MIT) must stay
  // off (Web/vite.config.ts build.modulePreload.polyfill: false) rather than get inlined into our entry chunk.
  if (/function polyfill\(\)/.test(webJs)) problems.push('lochub_web.js still inlines the modulepreload polyfill');
  if (webJs.split('\n', 1)[0] !== COPYRIGHT_LINE) problems.push('lochub_web.js is missing the publisher copyright banner');
}
if (deps.includes('lochub_web_deps.js')) {
  const depsJs = readFileSync(join(depsDir, 'lochub_web_deps.js'), 'utf8');
  if (/["']\.\/lochub_web\.js["']/.test(depsJs)) problems.push('lochub_web_deps.js imports lochub_web.js back (circular chunks)');
  if (depsJs.split('\n', 1)[0] !== COPYRIGHT_LINE) problems.push('lochub_web_deps.js is missing the publisher copyright banner');
}
if ([...web, ...deps].some((name) => name.endsWith('.map'))) problems.push('Source maps must not ship');

if (problems.length > 0) {
  console.error(`Web layout check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Web layout OK');
