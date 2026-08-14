'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function electronDistDir(resolvePackage = require.resolve) {
  try {
    return path.join(path.dirname(resolvePackage('electron/package.json')), 'dist')
  } catch {
    return null
  }
}

function electronBinary(dist, platform = process.platform) {
  if (platform === 'darwin') {
    return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  if (platform === 'win32') return path.join(dist, 'electron.exe')
  return path.join(dist, 'electron')
}

function hasUsableElectronDist(dist, platform = process.platform) {
  return Boolean(dist && fs.existsSync(electronBinary(dist, platform)))
}

function hasEnabledFlag(cliArgs, names) {
  return cliArgs.some(arg =>
    names.some(name => arg === name || (arg.startsWith(`${name}=`) && arg.slice(name.length + 1) !== 'false'))
  )
}

function hasPlatformFlag(cliArgs, names) {
  // Platform options are yargs arrays, so even --mac=false is a supplied
  // target value rather than a reliable boolean disable. Treat every value as
  // a platform request and let electron-builder validate the target itself.
  return cliArgs.some(arg => names.some(name => arg === name || arg.startsWith(`${name}=`)))
}

function requestedPlatforms(cliArgs, env = process.env) {
  const requested = new Set()

  if (hasPlatformFlag(cliArgs, ['--mac', '--macos', '-m', '-o'])) requested.add('darwin')
  if (hasPlatformFlag(cliArgs, ['--win', '--windows', '-w'])) requested.add('win32')
  if (hasPlatformFlag(cliArgs, ['--linux', '-l'])) requested.add('linux')

  // electron-builder/yargs supports clustered platform aliases such as -mw
  // and -mwl. Restrict this to the exact platform-letter alphabet so config
  // overrides such as -c.mac.identity are never interpreted as target flags.
  for (const arg of cliArgs) {
    const match = /^-([mowl]+)(?:=.*)?$/.exec(arg)

    if (!match) continue
    const flags = match[1]

    if (flags.includes('m') || flags.includes('o')) requested.add('darwin')
    if (flags.includes('w')) requested.add('win32')
    if (flags.includes('l')) requested.add('linux')
  }

  if (requested.size === 0 && env.npm_config_platform) requested.add(env.npm_config_platform)
  return requested
}

function requestedArchitectures(cliArgs, env = process.env) {
  const requested = new Set()

  for (const arch of ['x64', 'arm64', 'ia32', 'armv7l', 'universal']) {
    if (hasEnabledFlag(cliArgs, [`--${arch}`])) requested.add(arch)
  }

  if (requested.size === 0 && env.npm_config_arch) requested.add(env.npm_config_arch)
  return requested
}

function canReuseLocalElectronDist(
  cliArgs,
  hostPlatform = process.platform,
  hostArch = process.arch,
  env = process.env
) {
  const platforms = requestedPlatforms(cliArgs, env)

  if (platforms.size > 1 || (platforms.size === 1 && !platforms.has(hostPlatform))) return false

  const architectures = requestedArchitectures(cliArgs, env)

  if (architectures.has('universal') || architectures.size > 1) return false
  if (architectures.size === 1 && !architectures.has(hostArch)) return false
  return true
}

function builderArgs(
  cliArgs,
  dist = electronDistDir(),
  platform = process.platform,
  arch = process.arch,
  env = process.env
) {
  const args = []

  // npm may hoist Electron to the workspace root or keep it under this app.
  // Reuse the installed runtime only when its stock executable is intact;
  // otherwise let electron-builder fetch a verified copy itself. The latter is
  // also important after the dev-only branding script renames the macOS binary
  // and for cross-platform/cross-architecture builds: electronDist is already
  // unpacked for the host and electron-builder cannot convert it to the target.
  if (
    hasUsableElectronDist(dist, platform) &&
    canReuseLocalElectronDist(cliArgs, platform, arch, env)
  ) {
    args.push(`-c.electronDist=${dist}`)
  }
  args.push(...cliArgs)
  return args
}

function electronBuilderCli(resolvePackage = require.resolve, loadPackage = require) {
  const packageJson = resolvePackage('electron-builder/package.json')
  const bin = loadPackage(packageJson).bin
  const relative = typeof bin === 'string' ? bin : bin['electron-builder']

  if (!relative) throw new Error('electron-builder package does not declare its CLI')
  return path.join(path.dirname(packageJson), relative)
}

function run(cliArgs = process.argv.slice(2)) {
  const dist = electronDistDir()
  const reusable = canReuseLocalElectronDist(cliArgs)

  if (!hasUsableElectronDist(dist) || !reusable) {
    console.warn(
      '[run-electron-builder] no compatible intact stock Electron dist; ' +
        'electron-builder will fetch the pinned runtime.'
    )
  }

  const result = spawnSync(
    process.execPath,
    [electronBuilderCli(), ...builderArgs(cliArgs, dist)],
    { stdio: 'inherit' }
  )

  if (result.error) {
    console.error(`[run-electron-builder] spawn failed: ${result.error.message}`)
    return 1
  }
  return result.status == null ? 1 : result.status
}

if (require.main === module) process.exit(run())

module.exports = {
  builderArgs,
  canReuseLocalElectronDist,
  electronBinary,
  electronBuilderCli,
  electronDistDir,
  hasEnabledFlag,
  hasPlatformFlag,
  hasUsableElectronDist,
  requestedArchitectures,
  requestedPlatforms,
  run
}
