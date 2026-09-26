import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { licenseFileName, packageDirsFromModuleIds, writeThirdPartyNotices } from '../thirdparty.mjs';

function makePackage(root, relDir, name, license, licenseFile) {
  const dir = join(root, ...relDir.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', license }));
  if (licenseFile) writeFileSync(join(dir, licenseFile), `${name} license text`);
  return dir;
}

test('maps module ids to package folders: scoped, nested, virtual and Windows ids', () => {
  const ids = [
    'C:\\p\\node_modules\\@scope\\pkg\\lib\\a.js',
    'C:/p/node_modules/@scope/pkg/lib/b.js',
    '\0C:/p/node_modules/react/index.js?commonjs-exports',
    'C:/p/node_modules/a/node_modules/b/index.js',
    'C:/p/src/own.ts',
    '\0vite/preload-helper.js',
  ];
  assert.deepEqual(packageDirsFromModuleIds(ids).map((d) => d.replaceAll('\\', '/')), [
    'C:/p/node_modules/@scope/pkg',
    'C:/p/node_modules/a/node_modules/b',
    'C:/p/node_modules/react',
  ]);
});

test('names license files with letters, digits and underscores only', () => {
  assert.equal(licenseFileName('@anthropic-ai/sdk'), 'anthropic_ai_sdk.txt');
  assert.equal(licenseFileName('ipaddr.js'), 'ipaddr_js.txt');
  assert.equal(licenseFileName('react-dom'), 'react_dom.txt');
});

test('copies package licenses, falls back to overrides and lists every package', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const a = makePackage(root, 'node_modules/@scope/pkg', '@scope/pkg', 'MIT', 'LICENSE');
  const b = makePackage(root, 'node_modules/b', 'b', 'ISC', 'license.md');
  const c = makePackage(root, 'node_modules/no-file', 'no-file', 'MIT', null);
  const overrides = join(root, 'overrides');
  mkdirSync(overrides);
  writeFileSync(join(overrides, 'no_file.txt'), 'upstream MIT text');
  const out = join(root, 'out');
  mkdirSync(join(out, 'LICENSES'), { recursive: true });
  writeFileSync(join(out, 'LICENSES', 'stale.txt'), 'from an older build');

  const packages = writeThirdPartyNotices({ packageDirs: [a, b, c], outDir: out, overridesDir: overrides });

  assert.deepEqual(readdirSync(join(out, 'LICENSES')).sort(), ['b.txt', 'no_file.txt', 'scope_pkg.txt']);
  assert.equal(readFileSync(join(out, 'LICENSES', 'no_file.txt'), 'utf8'), 'upstream MIT text');
  assert.deepEqual(packages.map((p) => p.name), ['@scope/pkg', 'b', 'no-file']);
  const notices = readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /@scope\/pkg 1\.2\.3 MIT/);
  assert.match(notices, /b 1\.2\.3 ISC/);
});

test('fails the build when a package has no license anywhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const c = makePackage(root, 'node_modules/nothing', 'nothing', 'MIT', null);
  assert.throws(
    () => writeThirdPartyNotices({ packageDirs: [c], outDir: join(root, 'out'), overridesDir: join(root, 'none') }),
    /nothing@1\.2\.3/,
  );
  assert.equal(existsSync(join(root, 'out', 'THIRD_PARTY_NOTICES.txt')), false);
});

test('refuses two packages that map to one license file name', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const x = makePackage(root, 'node_modules/fast-uri', 'fast-uri', 'MIT', 'LICENSE');
  const y = makePackage(root, 'node_modules/fast_uri', 'fast_uri', 'MIT', 'LICENSE');
  assert.throws(() => writeThirdPartyNotices({ packageDirs: [x, y], outDir: join(root, 'out'), overridesDir: root }), /fast_uri\.txt/);
});

test('two versions of the same package with byte-identical license text (modulo line endings) share one file', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const older = makePackage(root, 'node_modules/consumer-a/node_modules/fast-uri', 'fast-uri', 'BSD-3-Clause', null);
  writeFileSync(join(older, 'package.json'), JSON.stringify({ name: 'fast-uri', version: '3.1.8', license: 'BSD-3-Clause' }));
  writeFileSync(join(older, 'LICENSE'), 'fast-uri license text\r\nsecond line\r\n');
  const newer = makePackage(root, 'node_modules/fast-uri', 'fast-uri', 'BSD-3-Clause', null);
  writeFileSync(join(newer, 'package.json'), JSON.stringify({ name: 'fast-uri', version: '4.2.1', license: 'BSD-3-Clause' }));
  writeFileSync(join(newer, 'LICENSE'), 'fast-uri license text\nsecond line\n');
  const out = join(root, 'out');

  const packages = writeThirdPartyNotices({ packageDirs: [older, newer], outDir: out, overridesDir: join(root, 'overrides') });

  assert.deepEqual(readdirSync(join(out, 'LICENSES')).sort(), ['fast_uri.txt']);
  assert.deepEqual(
    packages.map((p) => `${p.name}@${p.version}`),
    ['fast-uri@3.1.8', 'fast-uri@4.2.1'],
  );
  const notices = readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /^fast-uri 3\.1\.8 BSD-3-Clause LICENSES\/fast_uri\.txt$/m);
  assert.match(notices, /^fast-uri 4\.2\.1 BSD-3-Clause LICENSES\/fast_uri\.txt$/m);
});

test('two versions of the same package with different license text get one file each', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const older = makePackage(root, 'node_modules/consumer-a/node_modules/process-warning', 'process-warning', 'MIT', 'LICENSE');
  writeFileSync(join(older, 'package.json'), JSON.stringify({ name: 'process-warning', version: '4.0.1', license: 'MIT' }));
  writeFileSync(join(older, 'LICENSE'), 'process-warning v4 license text');
  const newer = makePackage(root, 'node_modules/process-warning', 'process-warning', 'MIT', 'LICENSE');
  writeFileSync(join(newer, 'package.json'), JSON.stringify({ name: 'process-warning', version: '5.1.0', license: 'MIT' }));
  writeFileSync(join(newer, 'LICENSE'), 'process-warning v5 license text, materially different');
  const out = join(root, 'out');

  const packages = writeThirdPartyNotices({ packageDirs: [older, newer], outDir: out, overridesDir: join(root, 'overrides') });

  assert.deepEqual(readdirSync(join(out, 'LICENSES')).sort(), ['process_warning_4_0_1.txt', 'process_warning_5_1_0.txt']);
  assert.equal(readFileSync(join(out, 'LICENSES', 'process_warning_4_0_1.txt'), 'utf8'), 'process-warning v4 license text');
  assert.equal(readFileSync(join(out, 'LICENSES', 'process_warning_5_1_0.txt'), 'utf8'), 'process-warning v5 license text, materially different');
  assert.deepEqual(
    packages.map((p) => `${p.name}@${p.version}`),
    ['process-warning@4.0.1', 'process-warning@5.1.0'],
  );
  const notices = readFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
  assert.match(notices, /^process-warning 4\.0\.1 MIT LICENSES\/process_warning_4_0_1\.txt$/m);
  assert.match(notices, /^process-warning 5\.1\.0 MIT LICENSES\/process_warning_5_1_0\.txt$/m);
});

test('the same package dir reached twice counts once', () => {
  const root = mkdtempSync(join(tmpdir(), 'lochub-thirdparty-'));
  const a = makePackage(root, 'node_modules/b', 'b', 'ISC', 'LICENSE');
  const out = join(root, 'out');

  const packages = writeThirdPartyNotices({ packageDirs: [a, a], outDir: out, overridesDir: join(root, 'overrides') });

  assert.deepEqual(packages.map((p) => p.name), ['b']);
  assert.deepEqual(readdirSync(join(out, 'LICENSES')).sort(), ['b.txt']);
});
