// Pure checks of a staged plugin folder against Fab's technical requirements (spec §1, §5; numbers are Fab's sections).
// Every function returns human-readable problems; an empty list means the check passed.
import { spawnSync } from 'node:child_process';
import { isAbsolute, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const COPYRIGHT_LINE = '// Copyright Dmitrii Vergasov, 2026. All Rights Reserved.';
export const SERVICE_USAGE_PREFIX = 'Usage: node <plugin>/Resources/LocHubService/lochub_service.mjs serve';
const ALLOWED_TOP_LEVEL = new Set(['LocHub.uplugin', 'Config', 'Resources', 'Source']); // 4.3.7.3.a
const NAME_SEGMENT = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/; // 4.3.7.1
const FORBIDDEN_EXTENSIONS = ['.exe', '.msi', '.map', '.pdb']; // 4.3.6.1.e; spec §3 (no maps)
const MAX_PATH = 170; // 4.3.7.3.c, counted with the plugin folder name
const CODE_FILE = /\.(h|cpp|cs)$/;
const SCRIPT_FILE = /\.(js|mjs)$/;
const SCRIPT_HOMES = ['Resources/LocHubService/', 'Resources/LocHubWeb/', 'Source/ThirdParty/'];

export function checkLayout(files) {
  return files.filter((f) => !ALLOWED_TOP_LEVEL.has(f.split('/')[0])).map((f) => `Not allowed in the package (4.3.7.3.a): ${f}`);
}

export function checkNames(files) {
  return files.filter((f) => f.split('/').some((s) => !NAME_SEGMENT.test(s))).map((f) => `Name outside A-Z a-z 0-9 _ (4.3.7.1): ${f}`);
}

export function checkPathLengths(files, pluginFolder = 'LocHub') {
  return files.filter((f) => `${pluginFolder}/${f}`.length > MAX_PATH).map((f) => `Path longer than ${MAX_PATH} (4.3.7.3.c): ${f}`);
}

export function checkExtensions(files) {
  return files.filter((f) => FORBIDDEN_EXTENSIONS.some((e) => f.toLowerCase().endsWith(e))).map((f) => `Forbidden file type: ${f}`);
}

export function checkScriptsLocation(files) {
  return files.filter((f) => SCRIPT_FILE.test(f) && !SCRIPT_HOMES.some((h) => f.startsWith(h))).map((f) => `Script outside Resources/LocHub* and Source/ThirdParty: ${f}`);
}

export function checkThirdParty(files) {
  const dirs = new Set(files.filter((f) => f.startsWith('Source/ThirdParty/')).map((f) => f.split('/').slice(0, 3).join('/')));
  const problems = [];
  for (const dir of dirs) {
    if (!files.includes(`${dir}/THIRD_PARTY_NOTICES.txt`)) problems.push(`${dir} has no THIRD_PARTY_NOTICES.txt (4.3.7.3.d)`);
    if (!files.some((f) => f.startsWith(`${dir}/LICENSES/`) && f.endsWith('.txt'))) problems.push(`${dir} has no LICENSES/*.txt (4.3.7.3.d)`);
  }
  return problems;
}

// M-2: checkThirdParty only asks for *a* notices file and *a* LICENSES/*.txt per ThirdParty folder; it does not
// check that the two agree. A full `npm run build` regenerates both together (thirdparty.mjs), so they can only
// drift apart when someone edits one by hand or an old commit is staged with --skip-npm — which is exactly when
// this needs to catch it. `texts` is the same path->content map checkCopyright/checkForbiddenWords use, so this
// runs unconditionally in checkStaged, npm build or not.
export function checkThirdPartyNotices(files, texts) {
  const problems = [];
  const dirs = new Set(files.filter((f) => f.startsWith('Source/ThirdParty/')).map((f) => f.split('/').slice(0, 3).join('/')));
  for (const dir of dirs) {
    const noticesPath = `${dir}/THIRD_PARTY_NOTICES.txt`;
    const noticesText = texts.get(noticesPath);
    if (noticesText === undefined) continue; // checkThirdParty already reports the missing file
    const licenseFiles = new Set(files.filter((f) => f.startsWith(`${dir}/LICENSES/`) && f.endsWith('.txt')));
    const named = new Set([...noticesText.matchAll(/LICENSES\/(\S+\.txt)/g)].map((m) => `${dir}/LICENSES/${m[1]}`));
    for (const name of named) if (!licenseFiles.has(name)) problems.push(`${noticesPath} names ${name}, which is missing (4.3.7.3.d)`);
    for (const file of licenseFiles) if (!named.has(file)) problems.push(`${file} is not named by any line in ${noticesPath} (4.3.7.3.d)`);
  }
  return problems;
}

export function checkCopyright(texts) {
  const problems = [];
  for (const [path, text] of texts) {
    if (CODE_FILE.test(path) && text.replace(/^﻿/, '').split('\n', 1)[0].trimEnd() !== COPYRIGHT_LINE) problems.push(`First line is not the publisher copyright (4.3.6.1.b): ${path}`);
    else if (text.includes('Copyright Epic Games')) problems.push(`Epic placeholder copyright: ${path}`);
  }
  return problems;
}

export function checkForbiddenWords(texts, words) {
  const problems = [];
  for (const [path, text] of texts) {
    const lower = text.toLowerCase();
    for (const word of words) if (lower.includes(word.toLowerCase())) problems.push(`"${word}" found in ${path}`);
  }
  return problems;
}

// M-1: checkForbiddenWords only sees files TEXT_EXTENSIONS reads into `texts`, and never looks at a path itself.
// A file or folder literally named after the host project (e.g. Source/.../SecretProjectFixture.h) would pass
// with clean contents. Every staged path is checked here, independent of extension or content.
export function checkForbiddenWordsInPaths(files, words) {
  const problems = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    for (const word of words) if (lower.includes(word.toLowerCase())) problems.push(`"${word}" found in the path ${file}`);
  }
  return problems;
}

export function checkDescriptor(d, { engineVersion, final }) {
  const problems = [];
  const expect = (ok, what) => { if (!ok) problems.push(`LocHub.uplugin: ${what}`); };
  expect(d.EngineVersion === engineVersion, `EngineVersion must be ${engineVersion} (4.3.6.a)`);
  expect(/^\d+\.\d+\.\d+$/.test(d.VersionName ?? ''), 'VersionName must be x.y.z');
  expect(d.IsBetaVersion === false && !d.IsExperimentalVersion, 'no beta or experimental flag');
  expect(d.EnabledByDefault === false, 'EnabledByDefault must be false');
  expect(d.EditorOnly === true && d.CanContainContent === false, 'EditorOnly true, CanContainContent false');
  expect(d.CreatedBy === 'Dmitrii Vergasov', 'CreatedBy');
  expect(d.SupportURL === 'mailto:rim2812@gmail.com', 'SupportURL');
  expect(d.CreatedByURL === 'https://github.com/DmVergasov/LocHub', 'CreatedByURL');
  expect((d.Modules ?? []).length > 0 && d.Modules.every((m) => JSON.stringify(m.PlatformAllowList) === '["Win64","Mac","Linux"]'), 'every module needs PlatformAllowList ["Win64","Mac","Linux"] (4.3.6.b)');
  if (final) {
    expect(/^https:\/\//.test(d.DocsURL ?? ''), 'DocsURL must be the public documentation link (4.3.8)');
    expect(/^https:\/\/www\.fab\.com\//.test(d.FabURL ?? ''), 'FabURL must be the Fab listing link (4.3.6.c)');
  }
  return problems;
}

export function parseBuildPluginLog(text) {
  const problems = [...new Set(text.split(/\r?\n/).filter((l) => /(warning|error) [A-Z]*\d+:|: (warning|error):/i.test(l) && /[\\/]LocHub[\\/]/.test(l)))];
  return { succeeded: /BUILD SUCCESSFUL/.test(text) && !/BUILD FAILED/.test(text), problems };
}

// M-4: release.mjs's first act is `rmSync(outDir, { recursive: true, force: true })`. `--out .` from the plugin
// root, or an ancestor, or a drive root, deletes far more than release.mjs's own output.
//
// "Created by release.mjs" (so a re-run may replace it) is defined as: outDir does not exist yet, is empty, or
// already contains RELEASE_MARKER_FILE. release.mjs writes that marker immediately after it (re)creates outDir,
// before doing anything else with it; a directory with unrelated content and no marker is refused rather than
// silently wiped, on the theory that release.mjs is the only writer that would ever put the marker there.
export const RELEASE_MARKER_FILE = '.lochub-release-out';

export function checkOutDirSafety({ outDir, pluginRoot, exists, isEmpty, hasMarker }) {
  const problems = [];
  const resolvedOut = resolve(outDir);
  const resolvedRoot = resolve(pluginRoot);
  const rel = relative(resolvedOut, resolvedRoot);
  const containsPluginRoot = resolvedOut === resolvedRoot || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
  if (containsPluginRoot) problems.push(`--out ${outDir} is the plugin root or an ancestor of it; refusing to delete it`);
  if (parse(resolvedOut).root === resolvedOut) problems.push(`--out ${outDir} is a drive root; refusing to delete it`);
  if (exists && !isEmpty && !hasMarker) {
    problems.push(`--out ${outDir} already exists, is not empty, and has no ${RELEASE_MARKER_FILE} marker from a previous release.mjs run; refusing to delete it`);
  }
  return problems;
}

// M-5: proves the seam BuildPluginCommand.Automation.cs's install has to get right (see release.mjs's own comment
// at the call site) before BuildPlugin spends minutes compiling a package that would never have loaded. Running
// the bundle with no arguments resolves its relative `../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs`
// specifier from the staged layout, exactly as a Fab install would; a broken relative import or a missing deps
// file exits with code 1 and ERR_MODULE_NOT_FOUND before any output, instead of only surfacing on a player's
// machine.
//
// With no arguments the service exits with code 2 and prints its usage line to stderr. Static imports are linked
// before any code runs, so exit 2 plus the expected usage prefix proves the deps resolved and the bundle loaded.
export function checkServiceBundleLoads(bundlePath) {
  const result = spawnSync(process.execPath, [bundlePath], { encoding: 'utf8' });
  if (result.status === 2 && result.stderr.startsWith(SERVICE_USAGE_PREFIX)) return [];
  return [`Smoke-load of ${bundlePath} failed (exit ${result.status ?? 'signal ' + result.signal}):\n${result.stderr || result.stdout}`];
}
