// Collects the license of every npm package that ends up in a shipped bundle (Fab 4.3.7.3.d: third-party code only in
// Source/ThirdParty, with proof of its license). Used by Service/scripts/bundle.mjs and Web/scripts/webDeps.mjs.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

export function packageDirsFromModuleIds(moduleIds) {
  const dirs = new Set();
  for (const raw of moduleIds) {
    const id = raw.replace(/^\0/, '').split('?')[0].replaceAll('\\', '/');
    const marker = '/node_modules/';
    const at = id.lastIndexOf(marker);
    if (at < 0) continue;
    const rest = id.slice(at + marker.length).split('/');
    const nameParts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
    dirs.add([id.slice(0, at), 'node_modules', ...nameParts].join('/').replaceAll('/', sep));
  }
  return [...dirs].sort();
}

export function licenseFileName(packageName) {
  return `${packageName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.txt`;
}

function resolveLicenseSource(dir, name, version, overridesDir, overrideFileName) {
  const own = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort()[0];
  if (own) return join(dir, own);
  const override = join(overridesDir, overrideFileName);
  if (existsSync(override)) return override;
  throw new Error(`No license file for ${name}@${version}: add ${override} with the upstream license text`);
}

// A dependency tree legitimately contains two versions of the same package (e.g. ajv wants fast-uri@^3,
// fast-json-stringify wants fast-uri@^4). Each version gets its own package.json and license file on disk,
// so both are recorded; whether they share one LICENSES/<name>.txt or get one file per version depends on
// whether the two license texts actually match.
function versionedLicenseFileName(name, version) {
  return `${licenseFileName(name).replace(/\.txt$/, '')}_${version.replace(/\./g, '_')}.txt`;
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function writeThirdPartyNotices({ packageDirs, outDir, overridesDir }) {
  // The same package dir can be reached through more than one module id; it still counts once.
  const uniqueDirs = [...new Set(packageDirs)];

  const byName = new Map();
  for (const dir of uniqueDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN';
    let versions = byName.get(manifest.name);
    if (!versions) byName.set(manifest.name, (versions = new Map()));
    if (!versions.has(manifest.version)) versions.set(manifest.version, { dir, license });
  }

  const packages = [];
  const fileSources = new Map();
  const registerFile = (fileName, name, source) => {
    const existing = fileSources.get(fileName);
    // Two different packages whose names only collide after licenseFileName() sanitising must still throw;
    // two versions of the same package sharing one file (registered twice, same name) must not.
    if (existing && existing.name !== name) throw new Error(`Two packages map to ${fileName}: ${existing.name} and ${name}`);
    if (!existing) fileSources.set(fileName, { name, source });
  };

  for (const [name, versions] of byName) {
    const entries = [...versions.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    if (entries.length === 1) {
      const [version, { dir, license }] = entries[0];
      const fileName = licenseFileName(name);
      const source = resolveLicenseSource(dir, name, version, overridesDir, fileName);
      registerFile(fileName, name, source);
      packages.push({ name, version, license, fileName });
      continue;
    }

    // Multiple versions of the same package name: decide by comparing their license texts.
    const resolved = entries.map(([version, { dir, license }]) => ({
      version,
      license,
      source: resolveLicenseSource(dir, name, version, overridesDir, versionedLicenseFileName(name, version)),
    }));
    const texts = resolved.map((r) => normalizeLineEndings(readFileSync(r.source, 'utf8')));
    const identical = texts.every((text) => text === texts[0]);

    if (identical) {
      const fileName = licenseFileName(name);
      registerFile(fileName, name, resolved[0].source);
      for (const r of resolved) packages.push({ name, version: r.version, license: r.license, fileName });
    } else {
      for (const r of resolved) {
        const fileName = versionedLicenseFileName(name, r.version);
        registerFile(fileName, name, r.source);
        packages.push({ name, version: r.version, license: r.license, fileName });
      }
    }
  }

  // Code-point order, not localeCompare: the notices file must come out byte-identical on every machine.
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  const licensesDir = join(outDir, 'LICENSES');
  rmSync(licensesDir, { recursive: true, force: true });
  mkdirSync(licensesDir, { recursive: true });
  for (const [fileName, { source }] of fileSources) copyFileSync(source, join(licensesDir, fileName));
  const lines = packages.map((p) => `${p.name} ${p.version} ${p.license} LICENSES/${p.fileName}`);
  writeFileSync(
    join(outDir, 'THIRD_PARTY_NOTICES.txt'),
    `Third-party software bundled in this folder (name version license file):\n\n${lines.join('\n')}\n`,
  );
  return packages.map(({ name, version, license }) => ({ name, version, license }));
}
