#!/usr/bin/env node
// LocHub release (spec §5): builds the service and web bundles, stages the Fab package, checks it, runs BuildPlugin
// (and, with --automation, the LocHub.* tests) with every engine, and writes one zip per engine version.
// It never opens or touches an editor project of yours; --automation refuses to run while any editor is open.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as checks from './release_checks.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = ['LocHub.uplugin', 'Config', 'Resources', 'Source'];
// .svg is here so checkForbiddenWords also reads Resources/LocHubIcon.svg and Resources/LocHubWeb/favicon.svg (M-1).
const TEXT_EXTENSIONS = new Set(['.h', '.cpp', '.cs', '.uplugin', '.ini', '.js', '.mjs', '.css', '.html', '.txt', '.json', '.svg']);
const RULES_DLL_LOCK = /MarketplaceRules\.dll' because it is being used by another process/;
// A bare "tar.exe" can resolve to Git for Windows' bundled GNU tar (usr/bin ahead of System32 on PATH), which
// mishandles a "D:\..." archive path as a remote host spec and, even given -a, never writes a real Zip container
// for a .zip suffix (it only recognizes compressors like gzip/xz). The Windows-native tar.exe (bsdtar/libarchive,
// always in System32) does both correctly, so it is invoked by its full path rather than by PATH lookup.
const TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const { values: args } = parseArgs({
  options: {
    engines: { type: 'string' },
    out: { type: 'string' },
    'log-dir': { type: 'string' },
    forbid: { type: 'string', multiple: true, default: [] },
    final: { type: 'boolean', default: false },
    'skip-npm': { type: 'boolean', default: false },
    'skip-build-plugin': { type: 'boolean', default: false },
    automation: { type: 'boolean', default: false },
  },
});
const outDir = resolve(args.out ?? join(PLUGIN_ROOT, 'Saved', 'Release'));
const logDir = resolve(args['log-dir'] ?? join(outDir, 'logs'));
const engines = (args.engines ?? '').split(',').filter(Boolean).map((pair) => {
  const [version, dir] = pair.split('=');
  if (!/^5\.\d+$/.test(version ?? '') || !dir || !existsSync(join(dir, 'Engine'))) fail(`Bad --engines entry "${pair}": expected 5.x=<engine root>`);
  return { version, tag: version.replace('.', '_'), dir: resolve(dir) };
});
if (engines.length === 0) fail('Pass --engines 5.6=<dir>,5.7=<dir>,5.8=<dir>');

function fail(message) { console.error(`release: ${message}`); process.exit(1); }
// Wraps an argument with spaces in quotes, but leaves pre-quoted UE switches (-ExecCmds="...") alone: the engine
// parses its raw command line, and a quote around the whole "-Switch=a b" token hides the value from FParse::Value.
const quote = (s) => (/\s/.test(s) && !s.includes('"') ? `"${s}"` : s);
function run(command, commandArgs, cwd, logFile) {
  const result = spawnSync(quote(command), commandArgs.map(quote), { cwd, shell: true, encoding: 'utf8', maxBuffer: 1 << 30 });
  writeFileSync(logFile, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.status ?? 1;
}
function listFiles(root) {
  const out = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else out.push(relative(root, p).replaceAll('\\', '/')); } };
  walk(root);
  return out.sort();
}
function checkStaged(root, engineVersion) {
  const files = listFiles(root);
  const texts = new Map(files.filter((f) => TEXT_EXTENSIONS.has(extname(f).toLowerCase())).map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const descriptor = JSON.parse(texts.get('LocHub.uplugin'));
  return [
    ...checks.checkLayout(files), ...checks.checkNames(files), ...checks.checkPathLengths(files), ...checks.checkExtensions(files),
    ...checks.checkScriptsLocation(files), ...checks.checkThirdParty(files), ...checks.checkThirdPartyNotices(files, texts),
    ...checks.checkCopyright(texts), ...checks.checkForbiddenWords(texts, args.forbid), ...checks.checkForbiddenWordsInPaths(files, args.forbid),
    ...checks.checkDescriptor(descriptor, { engineVersion, final: args.final }),
  ];
}

// M-4: refuse an --out whose recursive delete below would take out the plugin's own sources, a whole drive, or
// someone else's non-empty directory that release.mjs never created (see checkOutDirSafety's own comment).
{
  const outDirExists = existsSync(outDir);
  const outDirEmpty = outDirExists && readdirSync(outDir).length === 0;
  const outDirHasMarker = outDirExists && existsSync(join(outDir, checks.RELEASE_MARKER_FILE));
  const outDirProblems = checks.checkOutDirSafety({ outDir, pluginRoot: PLUGIN_ROOT, exists: outDirExists, isEmpty: outDirEmpty, hasMarker: outDirHasMarker });
  if (outDirProblems.length > 0) fail(outDirProblems.join('\n'));
}
rmSync(outDir, { recursive: true, force: true, maxRetries: 3 });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, checks.RELEASE_MARKER_FILE), 'Written by Tools/release.mjs so a later run recognizes this directory as its own output.\n');
mkdirSync(logDir, { recursive: true });

// 1. Bundles, from the sources, with their own tests first.
if (!args['skip-npm']) {
  for (const pkg of ['Service', 'Web']) {
    for (const step of [['ci'], ['test'], ['run', 'build']]) {
      const log = join(logDir, `release-npm-${pkg.toLowerCase()}-${step.at(-1)}.log`);
      if (run('npm', step, join(PLUGIN_ROOT, pkg), log) !== 0) fail(`${pkg}: npm ${step.join(' ')} failed; see ${log}`);
    }
  }
}

// 2-3. One staging copy per engine: only the shipped folders, the engine's EngineVersion, then every check.
const zips = [];
for (const engine of engines) {
  const stage = join(outDir, `stage_${engine.tag}`, 'LocHub');
  for (const entry of SHIPPED) if (existsSync(join(PLUGIN_ROOT, entry))) cpSync(join(PLUGIN_ROOT, entry), join(stage, entry), { recursive: true });
  const descriptorPath = join(stage, 'LocHub.uplugin');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  descriptor.EngineVersion = `${engine.version}.0`;
  writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, '\t')}\n`);
  const problems = checkStaged(stage, `${engine.version}.0`);
  if (problems.length > 0) fail(`UE ${engine.version} package check failed:\n- ${problems.join('\n- ')}`);

  // M-5: smoke-load the staged service bundle before spending minutes on BuildPlugin, on the exact layout Fab
  // installs (relative import to Source/ThirdParty/LocHubNodeDeps and all); a broken bundle should fail here.
  const serviceProblems = checks.checkServiceBundleLoads(join(stage, 'Resources', 'LocHubService', 'lochub_service.mjs'));
  if (serviceProblems.length > 0) fail(`UE ${engine.version} service bundle smoke load failed:\n- ${serviceProblems.join('\n- ')}`);

  // 4. BuildPlugin with this engine (one engine at a time: parallel runs lock MarketplaceRules.dll).
  const buildDir = join(outDir, `build_${engine.tag}`);
  if (!args['skip-build-plugin']) {
    const log = join(logDir, `buildplugin-${engine.tag}.log`);
    const runUat = join(engine.dir, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
    const uatArgs = ['BuildPlugin', `-Plugin=${descriptorPath}`, `-Package=${buildDir}`, '-Rocket', '-TargetPlatforms=Win64'];
    run(runUat, uatArgs, PLUGIN_ROOT, log);
    if (RULES_DLL_LOCK.test(readFileSync(log, 'utf8'))) {
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30']);
      run(runUat, uatArgs, PLUGIN_ROOT, log);
    }
    const result = checks.parseBuildPluginLog(readFileSync(log, 'utf8'));
    if (!result.succeeded || result.problems.length > 0) fail(`BuildPlugin UE ${engine.version} failed or warned (4.3.6.2); see ${log}\n${result.problems.join('\n')}`);
  }

  // Optional: LocHub.* automation on a throwaway host project with the freshly built binaries.
  if (args.automation) {
    if (args['skip-build-plugin']) fail('--automation needs the BuildPlugin output');
    const tasks = spawnSync('tasklist', ['/FI', 'IMAGENAME eq UnrealEditor.exe', '/NH'], { encoding: 'utf8' }).stdout ?? '';
    if (tasks.includes('UnrealEditor.exe')) fail('An editor is running: close it before --automation (one engine process at a time).');
    const host = join(outDir, `host_${engine.tag}`);
    cpSync(buildDir, join(host, 'Plugins', 'LocHub'), { recursive: true });
    writeFileSync(join(host, 'LocHubHost.uproject'), JSON.stringify({ FileVersion: 3, EngineAssociation: engine.version, Plugins: [{ Name: 'LocHub', Enabled: true }] }, null, '\t'));
    const log = join(logDir, `automation-${engine.tag}.log`);
    const editor = join(engine.dir, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
    run(editor, [join(host, 'LocHubHost.uproject'), '-ExecCmds="Automation RunTests LocHub."', '-TestExit="Automation Test Queue Empty"',
      '-unattended', '-nullrhi', '-nosplash', '-nosound', `-abslog="${log}"`], host, join(logDir, `automation-${engine.tag}-stdout.log`));
    const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const passed = (text.match(/Test Completed\. Result=\{Success\}/g) ?? []).length;
    const failed = (text.match(/Test Completed\. Result=\{Fail\}/g) ?? []).length;
    if (passed === 0 || failed > 0) fail(`LocHub.* on UE ${engine.version}: ${passed} passed, ${failed} failed; see ${log}`);
    console.log(`UE ${engine.version}: LocHub.* ${passed} passed`);
  }

  // 5. The Fab zip of this engine, from the staging copy (never from the build output: no Binaries/Intermediate).
  const zip = join(outDir, `LocHub_${engine.tag}.zip`);
  if (spawnSync(TAR, ['-a', '-c', '-f', zip, '-C', dirname(stage), 'LocHub']).status !== 0) fail(`Could not write ${zip}`);
  const entries = (spawnSync(TAR, ['-t', '-f', zip], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/).filter((e) => e && !e.endsWith('/'));
  const zipProblems = checks.checkLayout(entries.map((e) => e.replace(/^LocHub\//, '')));
  if (zipProblems.length > 0 || !entries.every((e) => e.startsWith('LocHub/'))) fail(`Zip layout is wrong in ${zip}`);
  zips.push(`${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
}
console.log(`Release ready:\n${zips.join('\n')}`);
