import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const setupOnly = process.argv.includes('--setup-only')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const lockPath = join(root, 'package-lock.json')
const nodeModules = join(root, 'node_modules')
const lockMarker = join(nodeModules, '.fan-package-lock.sha256')

function run(command, args, label) {
  console.log(`\n[fan] ${label}`)
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(`[fan] Missing required command: ${command}`)
    } else {
      console.error(`[fan] ${result.error.message}`)
    }
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function packageLockHash() {
  return createHash('sha256').update(readFileSync(lockPath)).digest('hex')
}

function nodeDependenciesReady(expectedHash) {
  const requiredFiles = [
    join(nodeModules, '.bin', process.platform === 'win32' ? 'concurrently.cmd' : 'concurrently'),
    join(nodeModules, 'vite', 'package.json'),
    join(root, 'apps', 'desktop', 'node_modules', 'electron', 'package.json'),
    join(root, 'apps', 'desktop', 'node_modules', 'electron', 'path.txt')
  ]

  if (!requiredFiles.every(existsSync) || !existsSync(lockMarker)) return false
  return readFileSync(lockMarker, 'utf8').trim() === expectedHash
}

if (!existsSync(lockPath)) {
  console.error('[fan] package-lock.json is required for a reproducible setup.')
  process.exit(1)
}

run('uv', ['sync', '--locked', '--extra', 'dev'], 'Syncing locked Python dependencies')

const expectedHash = packageLockHash()
if (nodeDependenciesReady(expectedHash)) {
  console.log('[fan] Locked Node.js dependencies are already installed.')
} else {
  run(npmCommand, ['ci'], 'Installing locked Node.js dependencies')
  writeFileSync(lockMarker, `${expectedHash}\n`)
}

if (setupOnly) {
  console.log('\n[fan] Development environment is ready.')
  process.exit(0)
}

run(
  npmCommand,
  ['--prefix', 'apps/desktop', 'run', 'dev:app'],
  'Starting Fan desktop'
)
