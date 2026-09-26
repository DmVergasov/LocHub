import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  COPYRIGHT_LINE, RELEASE_MARKER_FILE, SERVICE_USAGE_PREFIX, checkCopyright, checkDescriptor, checkExtensions, checkForbiddenWords,
  checkForbiddenWordsInPaths, checkLayout, checkNames, checkOutDirSafety, checkPathLengths, checkScriptsLocation,
  checkServiceBundleLoads, checkThirdParty, checkThirdPartyNotices, parseBuildPluginLog,
} from '../release_checks.mjs';

const GOOD_FILES = [
  'LocHub.uplugin',
  'Resources/Icon128.png',
  'Resources/LocHubService/lochub_service.mjs',
  'Resources/LocHubWeb/index.html',
  'Source/LocHubEditor/LocHubEditor.Build.cs',
  'Source/LocHubEditor/Private/LocHubSnapshot.cpp',
  'Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs',
  'Source/ThirdParty/LocHubNodeDeps/THIRD_PARTY_NOTICES.txt',
  'Source/ThirdParty/LocHubNodeDeps/LICENSES/fastify.txt',
];

test('a good layout passes every file-list check', () => {
  for (const check of [checkLayout, checkNames, checkPathLengths, checkExtensions, checkScriptsLocation, checkThirdParty]) {
    assert.deepEqual(check(GOOD_FILES), [], check.name);
  }
});

test('flags folders Fab does not allow, bad names, long paths, executables and maps', () => {
  assert.equal(checkLayout(['Service/package.json', 'Binaries/Win64/x.dll']).length, 2);
  assert.equal(checkNames(['Resources/LocHubWeb/index-abc.js', 'Source/@scope/x.h', 'Source/My File.h']).length, 3);
  assert.equal(checkPathLengths([`Source/${'a'.repeat(170)}.h`]).length, 1);
  assert.deepEqual(checkPathLengths([`Source/${'a'.repeat(150)}.h`]), []);
  assert.equal(checkExtensions(['Resources/node.exe', 'Resources/setup.msi', 'Resources/LocHubWeb/lochub_web.js.map', 'Source/x.pdb']).length, 4);
});

test('scripts live only in the service, web and ThirdParty folders, and every ThirdParty folder has licenses', () => {
  assert.equal(checkScriptsLocation(['Source/LocHubEditor/Private/helper.js']).length, 1);
  assert.equal(checkThirdParty(['Source/ThirdParty/LocHubWebDeps/lochub_web_deps.js']).length, 2);
});

test('every code file starts with the publisher copyright and Epic placeholders are gone', () => {
  const good = new Map([['Source/A.h', `${COPYRIGHT_LINE}\n#pragma once\n`], ['Source/B.cpp', `\uFEFF${COPYRIGHT_LINE}\n`]]);
  assert.deepEqual(checkCopyright(good), []);
  const bad = new Map([['Source/A.h', '#pragma once\n'], ['Source/B.Build.cs', '// Copyright Epic Games, Inc. All Rights Reserved.\n']]);
  assert.equal(checkCopyright(bad).length, 2);
});

test('project names are found case-insensitively', () => {
  assert.equal(checkForbiddenWords(new Map([['Source/A.cpp', 'see /Game/SecretProject/UI']]), ['secretproject']).length, 1);
  assert.deepEqual(checkForbiddenWords(new Map([['Source/A.cpp', 'see /Game/MyGame/UI']]), ['secretproject']), []);
});

const DESCRIPTOR = {
  VersionName: '1.0.0', EngineVersion: '5.6.0', IsBetaVersion: false, IsExperimentalVersion: false, EnabledByDefault: false,
  EditorOnly: true, CanContainContent: false, CreatedBy: 'Dmitrii Vergasov', SupportURL: 'mailto:rim2812@gmail.com',
  CreatedByURL: 'https://github.com/DmVergasov/LocHub',
  Modules: [{ Name: 'LocHubEditor', Type: 'Editor', LoadingPhase: 'Default', PlatformAllowList: ['Win64', 'Mac', 'Linux'] }],
};

test('the descriptor matches the engine it is packaged for; the final release also needs docs and Fab links', () => {
  assert.deepEqual(checkDescriptor(DESCRIPTOR, { engineVersion: '5.6.0', final: false }), []);
  assert.equal(checkDescriptor(DESCRIPTOR, { engineVersion: '5.7.0', final: false }).length, 1);
  assert.equal(checkDescriptor({ ...DESCRIPTOR, Modules: [{ ...DESCRIPTOR.Modules[0], PlatformAllowList: undefined }] }, { engineVersion: '5.6.0', final: false }).length, 1);
  assert.equal(checkDescriptor(DESCRIPTOR, { engineVersion: '5.6.0', final: true }).length, 2);
  const linked = { ...DESCRIPTOR, DocsURL: 'https://example.notion.site/LocHub', FabURL: 'https://www.fab.com/listings/0000' };
  assert.deepEqual(checkDescriptor(linked, { engineVersion: '5.6.0', final: true }), []);
});

test('reads success and the plugin\'s own warnings from a BuildPlugin log', () => {
  const failed = [
    'D:\\bp\\out56\\HostProject\\Plugins\\LocHub\\Source\\LocHubEditor\\Private\\LocHubSyncRunner.cpp(244,36): error C4458: declaration of \'WeakThis\' hides class member',
    'D:\\Games\\UE_5.6\\Engine\\Source\\Runtime\\Core\\Public\\X.h(1,1): warning C4996: engine header, not ours',
    'BUILD FAILED',
  ].join('\n');
  const result = parseBuildPluginLog(failed);
  assert.equal(result.succeeded, false);
  assert.equal(result.problems.length, 1);
  assert.deepEqual(parseBuildPluginLog('Total execution time\nBUILD SUCCESSFUL\n'), { succeeded: true, problems: [] });
});

// M-1: a file or folder literally named after the host project must be caught even with squeaky-clean contents.
test('every staged path is checked for the forbidden word, not just file contents', () => {
  assert.equal(checkForbiddenWordsInPaths(['Source/MyGame/SecretProjectFixture.h', 'Resources/clean.png'], ['secretproject']).length, 1);
  assert.deepEqual(checkForbiddenWordsInPaths(['Source/MyGame/Fixture.h'], ['secretproject']), []);
});

// M-2: THIRD_PARTY_NOTICES.txt and LICENSES/ must agree with each other, not just both exist.
test('the third-party notices file must name every LICENSES file, and only files it names', () => {
  const noticesPath = 'Source/ThirdParty/LocHubWebDeps/THIRD_PARTY_NOTICES.txt';
  const files = [noticesPath, 'Source/ThirdParty/LocHubWebDeps/LICENSES/react.txt', 'Source/ThirdParty/LocHubWebDeps/LICENSES/react_dom.txt'];
  const goodNotices = 'Third-party software bundled in this folder (name version license file):\n\n'
    + 'react 18.0.0 MIT LICENSES/react.txt\nreact-dom 18.0.0 MIT LICENSES/react_dom.txt\n';
  assert.deepEqual(checkThirdPartyNotices(files, new Map([[noticesPath, goodNotices]])), []);

  // LICENSES/react_dom.txt was never committed (or was deleted by hand), but the notices file still names it.
  const missingLicense = files.filter((f) => f !== 'Source/ThirdParty/LocHubWebDeps/LICENSES/react_dom.txt');
  assert.equal(checkThirdPartyNotices(missingLicense, new Map([[noticesPath, goodNotices]])).length, 1);

  // A LICENSES file nothing in the notices names (a stale leftover from a package no longer bundled).
  const staleNotices = 'Third-party software bundled in this folder (name version license file):\n\nreact 18.0.0 MIT LICENSES/react.txt\n';
  assert.equal(checkThirdPartyNotices(files, new Map([[noticesPath, staleNotices]])).length, 1);

  // checkThirdParty already reports a THIRD_PARTY_NOTICES.txt that is missing outright; this check stays quiet then.
  assert.deepEqual(checkThirdPartyNotices(files, new Map()), []);
});

// M-4: --out feeds an unguarded recursive delete.
test('the release marker is a dotfile, so it is never mistaken for a shipped package file', () => {
  assert.match(RELEASE_MARKER_FILE, /^\./);
});

test('refuses an --out that is the plugin root, contains it, or is a drive root; allows a fresh or marked directory', () => {
  const pluginRoot = 'D:/Projects/Game/Plugins/LocHub';
  const base = { pluginRoot, exists: false, isEmpty: false, hasMarker: false };
  assert.equal(checkOutDirSafety({ ...base, outDir: pluginRoot }).length, 1);
  assert.equal(checkOutDirSafety({ ...base, outDir: 'D:/Projects/Game/Plugins' }).length, 1);
  // A drive root is both a drive root and, trivially, a container of the plugin root: both problems are real.
  assert.ok(checkOutDirSafety({ ...base, outDir: 'D:/' }).length > 0);
  assert.deepEqual(checkOutDirSafety({ ...base, outDir: `${pluginRoot}/Saved/Release` }), []);
  assert.equal(checkOutDirSafety({ ...base, outDir: 'D:/Somewhere/preexisting', exists: true, isEmpty: false }).length, 1);
  assert.deepEqual(checkOutDirSafety({ ...base, outDir: 'D:/Somewhere/preexisting', exists: true, isEmpty: false, hasMarker: true }), []);
  assert.deepEqual(checkOutDirSafety({ ...base, outDir: 'D:/Somewhere/preexisting', exists: true, isEmpty: true }), []);
});

// M-5: prove the actual seam Fab install has to survive: running the staged bundle must resolve its relative
// specifier to Source/ThirdParty/LocHubNodeDeps on the staged layout. With no arguments the service exits 2 with
// the expected usage line, proving static imports linked before any code ran.
test('smoke-loads the staged service bundle, catching a broken relative import to the deps bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-smoke-'));
  const serviceDir = join(root, 'LocHub', 'Resources', 'LocHubService');
  const depsDir = join(root, 'LocHub', 'Source', 'ThirdParty', 'LocHubNodeDeps');
  mkdirSync(serviceDir, { recursive: true });
  mkdirSync(depsDir, { recursive: true });
  writeFileSync(join(depsDir, 'lochub_node_deps.mjs'), 'export const helper = () => "ok";\n');
  const bundle = join(serviceDir, 'lochub_service.mjs');

  // Good fixture: exits 2 with the expected usage text.
  writeFileSync(bundle, "import { helper } from '../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs';\nconsole.error('" + SERVICE_USAGE_PREFIX + " arg');\nprocess.exit(2);\n");
  assert.deepEqual(checkServiceBundleLoads(bundle), []);

  // Broken import: missing deps file. The check must fail and the message must match /lochub_service\.mjs/.
  writeFileSync(bundle, "import { helper } from '../../Source/ThirdParty/LocHubNodeDeps/missing.mjs';\n");
  const problems1 = checkServiceBundleLoads(bundle);
  assert.equal(problems1.length, 1);
  assert.match(problems1[0], /lochub_service\.mjs/);

  // Right exit code, wrong text: exits 2 with some other stderr text. The check must fail.
  writeFileSync(bundle, "import { helper } from '../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs';\nconsole.error('Some other text');\nprocess.exit(2);\n");
  const problems2 = checkServiceBundleLoads(bundle);
  assert.equal(problems2.length, 1);

  // Exit 0: exits 0 instead of 2. The check must fail.
  writeFileSync(bundle, "import { helper } from '../../Source/ThirdParty/LocHubNodeDeps/lochub_node_deps.mjs';\nprocess.exit(0);\n");
  const problems3 = checkServiceBundleLoads(bundle);
  assert.equal(problems3.length, 1);
});

test('smoke-loads the real service bundle', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = dirname(dirname(testDir));
  const realBundlePath = join(pluginRoot, 'Resources', 'LocHubService', 'lochub_service.mjs');
  assert.deepEqual(checkServiceBundleLoads(realBundlePath), []);
});
