import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPackage } from '@electron/asar'

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(DESKTOP_ROOT, 'package.json'), 'utf8'))
const MODE = process.argv[2] || 'help'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const RELEASE_ROOT = path.join(DESKTOP_ROOT, 'release')
const PLATFORM = process.platform

// Platform-specific packaged-app layout. Each installer ships the Electron
// shell, its native dependencies, and a self-contained Fan Agent backend
// (Python runtime plus fan-src) for first-launch availability.
const APP = (() => {
  if (PLATFORM === 'darwin') {
    const appPath = path.join(RELEASE_ROOT, `mac-${ARCH}`, 'Fan.app')
    return {
      appPath,
      binary: path.join(appPath, 'Contents', 'MacOS', 'Fan'),
      resourcesPath: path.join(appPath, 'Contents', 'Resources'),
      asarPath: path.join(appPath, 'Contents', 'Resources', 'app.asar'),
      unpackedDistIndex: path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'dist', 'index.html')
    }
  }
  if (PLATFORM === 'win32') {
    const unpacked = path.join(RELEASE_ROOT, 'win-unpacked')
    return {
      appPath: unpacked,
      binary: path.join(unpacked, 'Fan.exe'),
      resourcesPath: path.join(unpacked, 'resources'),
      asarPath: path.join(unpacked, 'resources', 'app.asar'),
      unpackedDistIndex: path.join(unpacked, 'resources', 'app.asar.unpacked', 'dist', 'index.html')
    }
  }
  // linux unpacked layout matches windows but with different binary name
  const unpacked = path.join(RELEASE_ROOT, 'linux-unpacked')
  return {
    appPath: unpacked,
    binary: path.join(unpacked, 'fan'),
    resourcesPath: path.join(unpacked, 'resources'),
    asarPath: path.join(unpacked, 'resources', 'app.asar'),
    unpackedDistIndex: path.join(unpacked, 'resources', 'app.asar.unpacked', 'dist', 'index.html')
  }
})()

// Default FAN_HOME for non-sandboxed runs -- matches main.cjs's
// resolveFanHome(). On Windows it's %LOCALAPPDATA%\fan; elsewhere
// it's ~/.fan. The fresh-install sandbox launchFresh() sets its own
// FAN_HOME and never touches this.
const DEFAULT_FAN_HOME = (() => {
  if (PLATFORM === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'fan')
  }
  return path.join(os.homedir(), '.fan')
})()
const VENV_ROOT = path.join(DEFAULT_FAN_HOME, 'fan-agent', 'venv')
const FRESH_SANDBOX_ROOT = path.join(os.tmpdir(), 'fan-desktop-fresh-install')

function die(message) {
  console.error(`\n${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || DESKTOP_ROOT,
    env: options.env || process.env,
    shell: Boolean(options.shell) || PLATFORM === 'win32',
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    die(`${command} ${args.join(' ')} failed`)
  }
}

function exists(target) {
  return fs.existsSync(target)
}

// Match nodepty native binding location to what main.cjs's resolver fallback
// expects (apps/desktop/electron/main.cjs, packaged-build branch).  Upstream
// node-pty 1.x is N-API based and ships per-arch prebuilts under
// prebuilds/<platform>-<arch>/ instead of build/Release/.  We check the
// per-arch dir since that's what stage-native-deps actually copies.
function expectedNativeDepPaths() {
  const root = path.join(APP.resourcesPath, 'native-deps', 'node-pty')
  const prebuildsDir = path.join(root, 'prebuilds', `${PLATFORM}-${ARCH}`)
  return {
    packageJson: path.join(root, 'package.json'),
    prebuildsDir,
    libIndex: path.join(root, 'lib', 'index.js')
  }
}

function ensurePlatformBuilds() {
  if (PLATFORM === 'darwin') return
  if (PLATFORM === 'win32') return
  die(
    `Desktop bundle validation is only wired for darwin / win32 today; platform=${PLATFORM} ` +
      `is not yet supported. The thin-installer story for Linux ships in Phase 2 alongside ` +
      `install.sh's stage protocol.`
  )
}

function ensurePackagedApp() {
  if (process.env.FAN_DESKTOP_SKIP_BUILD === '1' && exists(APP.binary)) {
    return
  }

  run('npm', ['run', 'pack'])
}

function resolveDmgPath() {
  if (!exists(RELEASE_ROOT)) {
    return path.join(RELEASE_ROOT, `Fan-${PACKAGE_JSON.version}-${ARCH}.dmg`)
  }

  const prefix = `Fan-${PACKAGE_JSON.version}`
  const candidates = fs
    .readdirSync(RELEASE_ROOT)
    .filter(name => name.endsWith('.dmg'))
    .filter(name => name.startsWith(prefix))
    .filter(name => name.includes(ARCH))
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(RELEASE_ROOT, a)).mtimeMs
      const bMtime = fs.statSync(path.join(RELEASE_ROOT, b)).mtimeMs
      return bMtime - aMtime
    })

  return candidates.length > 0
    ? path.join(RELEASE_ROOT, candidates[0])
    : path.join(RELEASE_ROOT, `Fan-${PACKAGE_JSON.version}-${ARCH}.dmg`)
}

function resolveNsisPath() {
  // electron-builder NSIS artifactName template is 'Fan-${version}-${os}-${arch}.${ext}'
  if (!exists(RELEASE_ROOT)) return null
  const candidates = fs
    .readdirSync(RELEASE_ROOT)
    .filter(name => /\.exe$/i.test(name) && /win/i.test(name))
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(RELEASE_ROOT, a)).mtimeMs
      const bMtime = fs.statSync(path.join(RELEASE_ROOT, b)).mtimeMs
      return bMtime - aMtime
    })
  return candidates.length > 0 ? path.join(RELEASE_ROOT, candidates[0]) : null
}

function ensureDmg() {
  if (PLATFORM !== 'darwin') {
    die('DMG mode is macOS-only; on Windows use the `nsis` mode instead.')
  }
  if (process.env.FAN_DESKTOP_SKIP_BUILD === '1' && exists(resolveDmgPath())) {
    return
  }
  run('npm', ['run', 'dist:mac:dmg'])
}

function ensureNsis() {
  if (PLATFORM !== 'win32') {
    die('NSIS mode is win32-only; on macOS use the `dmg` mode instead.')
  }
  if (process.env.FAN_DESKTOP_SKIP_BUILD === '1' && resolveNsisPath()) {
    return
  }
  run('npm', ['run', 'dist:win:nsis'])
}

function openApp() {
  if (!exists(APP.binary)) {
    die(`Missing packaged app: ${APP.binary}`)
  }

  if (PLATFORM === 'darwin') {
    run('open', ['-n', APP.appPath])
  } else if (PLATFORM === 'win32') {
    // Spawn detached so the test script exits while the app keeps running.
    spawn(APP.binary, [], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn(APP.binary, [], { detached: true, stdio: 'ignore' }).unref()
  }
}

function openDmg() {
  if (PLATFORM !== 'darwin') {
    die('DMG mode is macOS-only.')
  }
  const dmgPath = resolveDmgPath()
  if (!exists(dmgPath)) {
    die(`Missing DMG: ${dmgPath}`)
  }
  run('open', [dmgPath])
}

const CREDENTIAL_ENV_SUFFIXES = [
  '_API_KEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_CREDENTIALS',
  '_ACCESS_KEY',
  '_PRIVATE_KEY',
  '_OAUTH_TOKEN'
]

const CREDENTIAL_ENV_NAMES = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CUSTOM_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'GROQ_BASE_URL',
  'XAI_BASE_URL'
])

function isCredentialEnvVar(name) {
  if (CREDENTIAL_ENV_NAMES.has(name)) return true
  return CREDENTIAL_ENV_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function launchFresh() {
  if (!exists(APP.binary)) {
    die(`Missing app executable: ${APP.binary}`)
  }

  const sandbox = fs.mkdtempSync(`${FRESH_SANDBOX_ROOT}-`)
  const userDataDir = path.join(sandbox, 'electron-user-data')
  const fanHome = path.join(sandbox, 'fan-home')
  const cwd = path.join(sandbox, 'workspace')

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.mkdirSync(fanHome, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })

  // Strip every credential-shaped env var so the sandbox is actually fresh.
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (isCredentialEnvVar(key)) continue
    env[key] = value
  }

  env.FAN_DESKTOP_CWD = cwd
  env.FAN_DESKTOP_IGNORE_EXISTING = '1'
  env.FAN_DESKTOP_TEST_MODE = 'fresh-install'
  env.FAN_DESKTOP_USER_DATA_DIR = userDataDir
  env.FAN_HOME = fanHome
  delete env.FAN_DESKTOP_FAN
  delete env.FAN_DESKTOP_FAN_ROOT

  const child = spawn(APP.binary, [], {
    cwd: os.homedir(),
    detached: true,
    env,
    stdio: 'ignore'
  })
  child.unref()

  console.log('\nFresh install sandbox:')
  console.log(`  root: ${sandbox}`)
  console.log(`  electron userData: ${userDataDir}`)
  console.log(`  FAN_HOME: ${fanHome}`)
  console.log(`  cwd: ${cwd}`)

  return { runtimeRoot: path.join(fanHome, 'fan-agent', 'venv') }
}

// Validate the packaged bundle is self-contained:
//   - The Fan Agent Python runtime and source payload are shipped.
//   - install-stamp.json IS shipped in resources/ with a valid commit + branch.
//   - native-deps/@homebridge/node-pty-prebuilt-multiarch/ IS shipped with
//     the package.json + lib/ + at least one .node binary (the renderer's
//     integrated terminal needs this; see Phase 1F.6).
//   - The renderer's dist/index.html is reachable (either unpacked or
//     inside app.asar).
function validateBundle() {
  if (!exists(APP.binary)) {
    die(`Missing packaged app binary: ${APP.binary}`)
  }

  let pythonBinary
  if (PLATFORM === 'win32') {
    pythonBinary = path.join(APP.resourcesPath, 'python', 'python.exe')
  } else {
    const binDir = path.join(APP.resourcesPath, 'python', 'bin')
    const versionedCandidates = exists(binDir)
      ? fs
          .readdirSync(binDir)
          .filter(name => /^python3\.\d+$/.test(name))
          .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      : []
    pythonBinary = versionedCandidates.length > 0
      ? path.join(binDir, versionedCandidates[0])
      : path.join(binDir, 'python3')
  }
  const backendEntry = path.join(APP.resourcesPath, 'fan-src', 'fan_cli', 'main.py')
  if (!exists(pythonBinary)) {
    die(`Missing bundled Python runtime: ${pythonBinary}`)
  }
  if (!exists(backendEntry)) {
    die(`Missing bundled Fan backend entry point: ${backendEntry}`)
  }

  // Positive assertion: install-stamp.json carries a sane commit + branch
  const stampPath = path.join(APP.resourcesPath, 'install-stamp.json')
  if (!exists(stampPath)) {
    die(`Missing install-stamp.json (required for first-launch bootstrap pinning): ${stampPath}`)
  }
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
  } catch (err) {
    die(`install-stamp.json is not valid JSON: ${err.message}`)
  }
  if (!stamp.commit || typeof stamp.commit !== 'string' || stamp.commit.length < 7) {
    die(`install-stamp.json is missing a usable commit field: ${JSON.stringify(stamp)}`)
  }
  if (!stamp.branch || typeof stamp.branch !== 'string') {
    die(`install-stamp.json is missing the branch field: ${JSON.stringify(stamp)}`)
  }

  // Positive assertion: node-pty native deps shipped
  const native = expectedNativeDepPaths()
  if (!exists(native.packageJson)) {
    die(`Missing node-pty package.json in resources/native-deps: ${native.packageJson}`)
  }
  if (!exists(native.libIndex)) {
    die(`Missing node-pty lib/index.js in resources/native-deps: ${native.libIndex}`)
  }
  if (!exists(native.prebuildsDir)) {
    die(`Missing node-pty prebuilds dir for ${PLATFORM}-${ARCH}: ${native.prebuildsDir}`)
  }
  const nodeBinaries = fs.readdirSync(native.prebuildsDir).filter(name => name.endsWith('.node'))
  if (nodeBinaries.length === 0) {
    die(`No .node native binaries found in: ${native.prebuildsDir}`)
  }
  // Darwin requires a runtime-execed spawn-helper alongside pty.node; missing
  // it manifests as "ENOENT: spawn-helper" on first pty.spawn() call.
  if (PLATFORM === 'darwin') {
    const spawnHelper = path.join(native.prebuildsDir, 'spawn-helper')
    if (!exists(spawnHelper)) {
      die(`Missing node-pty spawn-helper (required on darwin): ${spawnHelper}`)
    }
  }

  // Renderer payload check (either unpacked or in the asar)
  if (exists(APP.unpackedDistIndex)) {
    return { stamp, nodeBinaries }
  }
  if (!exists(APP.asarPath)) {
    die(`Missing renderer payload: neither ${APP.unpackedDistIndex} nor ${APP.asarPath} exists`)
  }
  const files = listPackage(APP.asarPath)
  // Normalize separators because @electron/asar's listPackage returns
  // backslash-prefixed entries on Windows ('\\dist\\index.html') and
  // forward-slash on Unix.
  const normalized = files.map(f => f.replace(/\\/g, '/').replace(/^\/+/, ''))
  if (!normalized.includes('dist/index.html')) {
    die(`Missing renderer payload file in app.asar: ${APP.asarPath} (expected dist/index.html)`)
  }
  return { stamp, nodeBinaries }
}

function printArtifacts(options = {}) {
  const runtimeRoot = options.runtimeRoot || VENV_ROOT
  const stamp = options.stamp

  console.log('\nDesktop artifacts:')
  console.log(`  app: ${APP.appPath}`)
  if (PLATFORM === 'darwin') {
    console.log(`  dmg: ${resolveDmgPath()}`)
  } else if (PLATFORM === 'win32') {
    const exe = resolveNsisPath()
    if (exe) console.log(`  installer: ${exe}`)
  }
  console.log(`  runtime: ${runtimeRoot}`)
  if (stamp) {
    console.log(`  install-stamp: ${stamp.commit.slice(0, 12)} on ${stamp.branch}`)
  }
  if (options.nodeBinaries && options.nodeBinaries.length > 0) {
    console.log(`  node-pty binaries: ${options.nodeBinaries.join(', ')}`)
  }
}

function help() {
  console.log(`Usage:
  npm run test:desktop:existing  # build packaged app, launch with normal PATH/existing Fan
  npm run test:desktop:fresh     # build packaged app, launch with temp userData + FAN_HOME
  npm run test:desktop:dmg       # (macOS only) build DMG and open it
  npm run test:desktop:nsis      # (win32 only) build NSIS installer
  npm run test:desktop:all       # build installer, validate app payload, print paths

Fast rerun (skip rebuild if the packaged app already exists):
  FAN_DESKTOP_SKIP_BUILD=1 npm run test:desktop:fresh
`)
}

ensurePlatformBuilds()

if (MODE === 'existing') {
  ensurePackagedApp()
  const result = validateBundle()
  openApp()
  printArtifacts(result)
} else if (MODE === 'fresh') {
  ensurePackagedApp()
  const result = validateBundle()
  printArtifacts({ ...launchFresh(), ...result })
} else if (MODE === 'dmg') {
  ensureDmg()
  openDmg()
  printArtifacts()
} else if (MODE === 'nsis') {
  ensureNsis()
  printArtifacts(validateBundle())
} else if (MODE === 'all') {
  if (PLATFORM === 'darwin') {
    ensureDmg()
  } else if (PLATFORM === 'win32') {
    ensureNsis()
  } else {
    ensurePackagedApp()
  }
  printArtifacts(validateBundle())
} else {
  help()
}
