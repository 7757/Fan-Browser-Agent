#!/usr/bin/env node
// Keep every product-version source aligned from one command.
//
//   node scripts/bump-version.mjs 0.4.4
//   node scripts/bump-version.mjs --check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRERELEASE = String.raw`[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*`;
const SEMVER_SOURCE = String.raw`\d+\.\d+\.\d+(?:-${PRERELEASE})?`;
const SEMVER = new RegExp(`^${SEMVER_SOURCE}$`);

function usage() {
  console.error(
    'Usage:\n' +
      '  node scripts/bump-version.mjs <x.y.z>\n' +
      '  node scripts/bump-version.mjs --check',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === '--check';
if (args.length !== 1 || (!checkOnly && !SEMVER.test(args[0]))) usage();

const field = (file, label, regex) => ({ file, label, regex });
const versionFields = [
  field('package.json', 'root package', /^(\s*"version"\s*:\s*")([^"]+)("[,])$/m),
  field(
    'apps/desktop/package.json',
    'desktop package',
    /^(\s*"version"\s*:\s*")([^"]+)("[,])$/m,
  ),
  field(
    'pyproject.toml',
    'Python project',
    /(\[project\][\s\S]*?^version\s*=\s*")([^"]+)(")/m,
  ),
  field(
    'uv.lock',
    'Python lock',
    /(\[\[package\]\]\r?\nname = "fan-agent"\r?\nversion = ")([^"]+)(")/,
  ),
  field('fan_cli/__init__.py', 'Python runtime', /(__version__\s*=\s*")([^"]+)(")/),
  field(
    'README.md',
    'English Apple Silicon package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-mac-arm64\\.dmg)`),
  ),
  field(
    'README.md',
    'English Intel package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-mac-x64\\.dmg)`),
  ),
  field(
    'README.md',
    'English Windows package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-win-x64\\.exe)`),
  ),
  field(
    'README.md',
    'English version notice',
    new RegExp(`(Version )(${SEMVER_SOURCE})( is an unsigned early preview)`),
  ),
  field(
    'README.zh-CN.md',
    'Chinese Apple Silicon package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-mac-arm64\\.dmg)`),
  ),
  field(
    'README.zh-CN.md',
    'Chinese Intel package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-mac-x64\\.dmg)`),
  ),
  field(
    'README.zh-CN.md',
    'Chinese Windows package',
    new RegExp(`(Fan-)(${SEMVER_SOURCE})(-win-x64\\.exe)`),
  ),
  field(
    'README.zh-CN.md',
    'Chinese version notice',
    new RegExp(`(^|\\n)(${SEMVER_SOURCE})( 是尚未进行商业代码签名的早期预览版)`),
  ),
];

const fileNames = new Set([...versionFields.map(({ file }) => file), 'package-lock.json']);
const files = new Map(
  [...fileNames].map((file) => [file, fs.readFileSync(path.join(REPO, file), 'utf8')]),
);

function parseJson(file) {
  try {
    return JSON.parse(files.get(file));
  } catch (error) {
    throw new Error(`${file}: invalid JSON (${error.message})`);
  }
}

function captureOne({ file, label, regex }, source = files.get(file), capture = 2) {
  const flags = `${regex.flags.replace('g', '')}g`;
  const matches = [...source.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${file}: expected one ${label} version, found ${matches.length}`);
  }
  return matches[0][capture];
}

const rootPackage = parseJson('package.json');
parseJson('apps/desktop/package.json');
const packageLock = parseJson('package-lock.json');
if (!packageLock.packages?.[''] || !packageLock.packages?.['apps/desktop']) {
  throw new Error('package-lock.json: expected root and desktop workspace entries');
}

function observedVersions() {
  return [
    ...versionFields.map((item) => [item.label, captureOne(item)]),
    ['npm lock root', packageLock.version],
    ['npm lock root workspace', packageLock.packages[''].version],
    ['npm lock desktop workspace', packageLock.packages['apps/desktop'].version],
  ];
}

const releaseDateField = field(
  'fan_cli/__init__.py',
  'release date',
  /(__release_date__\s*=\s*")([^"]+)(")/,
);

function validReleaseDate(value) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function check() {
  const expected = rootPackage.version;
  const releaseDate = captureOne(releaseDateField);
  const errors = observedVersions()
    .filter(([, version]) => version !== expected)
    .map(([label, version]) => `${label}: expected ${expected}, found ${version ?? 'missing'}`);

  if (!SEMVER.test(expected ?? '')) {
    errors.unshift(`package.json: invalid version ${JSON.stringify(expected)}`);
  }
  if (!validReleaseDate(releaseDate)) {
    errors.push(`fan_cli/__init__.py: invalid release date ${JSON.stringify(releaseDate)}`);
  }

  const notes = `apps/desktop/release-notes/${expected}.md`;
  if (!fs.existsSync(path.join(REPO, notes))) errors.push(`${notes}: release notes are missing`);

  if (errors.length > 0) {
    console.error('Version check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`Version check passed: ${expected} (${releaseDate})`);
}

if (checkOnly) {
  check();
  process.exit(0);
}

// Validate every expected field before writing anything. A stale file shape
// therefore cannot leave the repository with only half of a version bump.
observedVersions();
captureOne(releaseDateField);

const version = args[0];
const now = new Date();
const releaseDate = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
const updated = new Map(files);

for (const item of versionFields) {
  updated.set(item.file, updated.get(item.file).replace(item.regex, `$1${version}$3`));
}
updated.set(
  releaseDateField.file,
  updated.get(releaseDateField.file).replace(releaseDateField.regex, `$1${releaseDate}$3`),
);

packageLock.version = version;
packageLock.packages[''].version = version;
packageLock.packages['apps/desktop'].version = version;
const newline = files.get('package-lock.json').includes('\r\n') ? '\r\n' : '\n';
updated.set(
  'package-lock.json',
  `${JSON.stringify(packageLock, null, 2).replace(/\n/g, newline)}${newline}`,
);

for (const [file, source] of updated) {
  if (source === files.get(file)) continue;
  fs.writeFileSync(path.join(REPO, file), source, 'utf8');
  console.log(`Updated ${file}`);
}

console.log(`\nVersion updated to ${version}; release date updated to ${releaseDate}.`);
console.log(`Create apps/desktop/release-notes/${version}.md, then run:`);
console.log('  node scripts/bump-version.mjs --check');
