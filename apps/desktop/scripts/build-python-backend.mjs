#!/usr/bin/env node
// Build the bundled Python backend for a packaged Fan release. This replaces
// the git-clone-on-first-launch distribution inherited from the OSS lineage.
//
// Produces two directories that electron-builder ships via extraResources:
//   apps/desktop/build/python/    a FULL python-build-standalone install with
//                                 all locked deps in its own site-packages
//   apps/desktop/build/fan-src/   the pruned repo source (fan_cli, agent, …)
//
// WHY NOT A VENV: a venv references its base interpreter twice — bin/python is
// a symlink into the build machine's uv dir, and pyvenv.cfg pins the base's
// ABSOLUTE path for the stdlib. Neither survives a move to a user machine, and
// a packaged app's resources cannot be rewritten at first launch. So we ship
// the standalone interpreter itself (python-build-standalone is relocatable by
// design: sys.prefix derives from the binary's location) and install the
// locked deps straight into its site-packages. Zero external references.
//
// Runtime (main.cjs::createBundledBackend):
//   <resources>/python/bin/python3 -m fan_cli.main   PYTHONPATH=<resources>/fan-src
// ~/.fan is self-initialized by the backend (fan_cli/config.py::ensure_fan_home).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const {
  PACKAGED_REQUIRED_EXTRAS,
  assertNoForbiddenSourceRoots,
  assertNoPythonBytecode,
  assertRequiredLegalFiles
} = require('../electron/packaged-backend-policy.cjs')
const DESKTOP = path.resolve(__dirname, '..')
const REPO = path.resolve(__dirname, '../../..')
const BUILD = path.join(DESKTOP, 'build')
const PY_OUT = path.join(BUILD, 'python')
const SRC_OUT = path.join(BUILD, 'fan-src')
const REQ_FILE = path.join(BUILD, 'requirements.export.txt')
const PY_VERSION = '3.11'
const IS_WIN = process.platform === 'win32'

// Top-level entries that must NOT ship in fan-src: the desktop app itself,
// node deps, VCS, build artifacts, dev venvs, reference clones and caches.
const EXCLUDE_TOP = new Set([
  'apps', 'node_modules', '.git', 'build', 'dist', '.venv', 'venv',
  'tests', 'testbed', 'cankao', 'backups', 'designs', 'docs', '__pycache__', '.pytest_cache',
  '.ruff_cache', '.mypy_cache', '.idea', '.vscode', 'website', '.claude',
  '.pnpm-store', '.tmp', 'fan_agent.egg-info'
])
const EXCLUDE_TOP_FILES = new Set([
  'AGENTS.md',
  '.env.example',
  '.gitattributes',
  '.gitignore',
  'MANIFEST.in',
  'package-lock.json',
  'package.json',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'setup.py',
  'uv.lock',
  'run_tests.sh',
  'run_tests_parallel.py',
  'test_durations.json'
])
const EXCLUDE_RELATIVE_FILES = new Set([
  'scripts/run_tests.sh',
  'scripts/run_tests_parallel.py'
])
const EXCLUDE_FILE_SUFFIX = ['.pyc', '.pyo', '.log']
const EXCLUDE_FILE_NAMES = new Set([
  '.DS_Store',
  'dom-llm-log.jsonl',
  'dom-pipeline-log.jsonl',
  'find-visual-log.jsonl',
  'grounding_debug.jsonl'
])
const BUNDLED_PACKAGE_TEST_DIR_SUFFIXES = [
  'site-packages/sniffio/_tests',
  'site-packages/setuptools/tests',
  'site-packages/setuptools/_distutils/tests',
  'site-packages/setuptools/_distutils/compilers/C/tests'
]

function isExcludedSourceFileName(name) {
  const unrotatedName = name.replace(/\.\d+$/, '')
  return (
    EXCLUDE_FILE_NAMES.has(unrotatedName) ||
    EXCLUDE_FILE_SUFFIX.some(suffix => unrotatedName.endsWith(suffix))
  )
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: REPO, ...opts })
}

function out(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

function hasUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const bundledPython = root =>
  IS_WIN ? path.join(root, 'python.exe') : path.join(root, 'bin', `python${PY_VERSION}`)

// Source-tree copy. Manual walk instead of fs.cpSync: the destination lives
// INSIDE the repo (apps/desktop/build/fan-src) and cpSync refuses "copy dir
// into its own subdirectory" outright; our walk prunes `apps` at the top so
// the destination is structurally unreachable.
function copySource(src, dest, isTop, relativeDirectory = '') {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const name = entry.name
    const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name
    if (isTop && EXCLUDE_TOP.has(name)) continue
    if (isTop && EXCLUDE_TOP_FILES.has(name)) continue
    if (EXCLUDE_RELATIVE_FILES.has(relative)) continue
    if (isExcludedSourceFileName(name) || name === '__pycache__') continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) copySource(from, to, false, relative)
    else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

// Interpreter copy: RESOLVE symlinks into real files (bin/python3 → python3.11
// etc.) so nothing in the bundle can point outside it. Hand-rolled stat-through
// walk — cpSync's dereference has quirks with nested relative symlinks (bin/2to3
// survived it). statSync follows links; broken links are skipped; the exec bit
// must be restored explicitly (copyFileSync does not carry the source mode).
function copyInterpreter(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true })
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const from = path.join(s, entry.name)
      const to = path.join(d, entry.name)
      let stat
      try {
        stat = fs.statSync(from) // follows symlinks; throws on broken links
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(from, to)
      } else if (stat.isFile()) {
        fs.copyFileSync(from, to)
        fs.chmodSync(to, stat.mode)
      }
    }
  }
  walk(src, dest)
}

// Self-containment gate: no symlinks at all (dereferenced above), and the
// interpreter must report its prefix INSIDE the bundle.
function assertSelfContained(root, py) {
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isSymbolicLink()) {
        console.error(`✖ symlink survived dereference: ${p}`)
        process.exit(1)
      }
      if (entry.isDirectory()) walk(p)
    }
  }
  walk(root)

  const prefix = out(py, ['-c', 'import sys; print(sys.prefix)'])
  if (path.resolve(prefix) !== path.resolve(root)) {
    console.error(`✖ interpreter prefix escapes the bundle: ${prefix}`)
    process.exit(1)
  }
}

function dirSizeMb(dir) {
  let total = 0
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) total += fs.statSync(p).size
    }
  }
  try {
    walk(dir)
  } catch {
    /* missing */
  }
  return Math.round(total / 1024 / 1024)
}

function pruneBundledPackageTests(root) {
  let removedDirectories = 0
  let removedFiles = 0

  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const relative = path.relative(root, target).split(path.sep).join('/')

      if (
        entry.isDirectory() &&
        BUNDLED_PACKAGE_TEST_DIR_SUFFIXES.some(suffix => relative.endsWith(suffix))
      ) {
        fs.rmSync(target, { recursive: true, force: true })
        removedDirectories += 1
        continue
      }
      if (entry.isDirectory()) {
        walk(target)
        continue
      }
      if (!entry.isFile()) continue

      const basename = entry.name
      const isFireTest =
        relative.includes('site-packages/fire/') &&
        (basename.endsWith('_test.py') || /^test_components.*\.py$/.test(basename))
      const isKnownTestHelper =
        relative.endsWith('site-packages/annotated_types/test_cases.py') ||
        relative.endsWith('site-packages/markdown/test_tools.py')
      if (isFireTest || isKnownTestHelper) {
        fs.rmSync(target, { force: true })
        removedFiles += 1
      }
    }
  }

  walk(root)
  return { removedDirectories, removedFiles }
}

function pruneRedundantPythonAliases(root) {
  if (IS_WIN) return []

  const removed = []
  for (const name of ['python', 'python3']) {
    const target = path.join(root, 'bin', name)
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { force: true })
    removed.push(name)
  }
  return removed
}

function main() {
  if (!hasUv()) {
    console.error('\n✖ uv is required. Install: https://docs.astral.sh/uv/\n')
    process.exit(1)
  }

  fs.mkdirSync(BUILD, { recursive: true })

  console.log('\n[1/5] Ensuring managed python-build-standalone…')
  run('uv', ['python', 'install', PY_VERSION])
  const managedPy = out('uv', ['python', 'find', '--managed-python', PY_VERSION])
  // mac/linux: <root>/bin/python3.11 → root is two levels up; win: <root>/python.exe.
  const managedRoot = IS_WIN ? path.dirname(managedPy) : path.resolve(path.dirname(managedPy), '..')
  console.log(`  managed install: ${managedRoot}`)

  console.log('\n[2/5] Copying interpreter into the bundle (symlinks materialized)…')
  copyInterpreter(managedRoot, PY_OUT)
  const py = bundledPython(PY_OUT)
  if (!fs.existsSync(py)) {
    console.error(`✖ bundled interpreter missing at ${py}`)
    process.exit(1)
  }

  console.log('\n[3/5] Exporting locked dependencies (uv.lock) and installing into the bundle…')
  const packagedExtraArgs = PACKAGED_REQUIRED_EXTRAS.flatMap(extra => ['--extra', extra])
  run('uv', [
    'export',
    '--frozen',
    '--no-emit-project',
    '--no-hashes',
    ...packagedExtraArgs,
    '-o',
    REQ_FILE
  ])
  // Not a venv → uv needs the explicit go-ahead to target the interpreter's
  // own site-packages. That is exactly what we want: deps live inside the bundle.
  run('uv', ['pip', 'install', '--python', py, '--break-system-packages', '-r', REQ_FILE])
  const prunedTests = pruneBundledPackageTests(PY_OUT)
  const removedPythonAliases = pruneRedundantPythonAliases(PY_OUT)
  console.log(
    `  pruned ${prunedTests.removedDirectories} third-party test directories and ` +
      `${prunedTests.removedFiles} test files from the runtime`
  )
  if (removedPythonAliases.length > 0) {
    console.log(`  removed redundant Python executable copies: ${removedPythonAliases.join(', ')}`)
  }

  console.log('\n[4/5] Copying pruned source → build/fan-src…')
  fs.rmSync(SRC_OUT, { recursive: true, force: true })
  copySource(REPO, SRC_OUT, true)
  if (!fs.existsSync(path.join(SRC_OUT, 'fan_cli', 'main.py'))) {
    console.error('✖ fan-src missing fan_cli/main.py — copy filter too aggressive')
    process.exit(1)
  }
  assertNoForbiddenSourceRoots(SRC_OUT)
  assertRequiredLegalFiles(SRC_OUT)

  console.log('\n[5/5] Self-containment + import probe…')
  assertSelfContained(PY_OUT, py)
  // Same probe main.cjs::canStartFanBackend runs before trusting a backend.
  execFileSync(py, ['-c', 'import PIL, certifi, fastapi, fan_cli.main'], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: SRC_OUT }
  })
  assertNoPythonBytecode(SRC_OUT)

  console.log(
    `\n✔ Bundled backend ready for ${process.platform}/${os.arch()}` +
      ` (python ${dirSizeMb(PY_OUT)}MB + src ${dirSizeMb(SRC_OUT)}MB)\n  ${PY_OUT}\n  ${SRC_OUT}\n`
  )
}

main()
