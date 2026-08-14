#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux' || process.arch !== 'arm64') {
  throw new Error(`This helper requires linux/arm64, received ${process.platform}/${process.arch}`)
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptDir, '../../..')
const nodeModules = path.join(repositoryRoot, 'node_modules')

// npm lockfiles created on macOS can omit Linux-only optional packages. Keep
// their versions tied to the packages that load them, and unpack them without
// mutating package.json or package-lock.json.
const nativePackages = [
  ['rolldown', '@rolldown/binding-linux-arm64-gnu'],
  ['lightningcss', 'lightningcss-linux-arm64-gnu'],
  ['@tailwindcss/oxide', '@tailwindcss/oxide-linux-arm64-gnu'],
  ['rollup', '@rollup/rollup-linux-arm64-gnu'],
  ['esbuild', '@esbuild/linux-arm64'],
]

const packageDirectory = name => path.join(nodeModules, ...name.split('/'))
const packageVersion = name => {
  const packageJson = path.join(packageDirectory(name), 'package.json')
  return JSON.parse(fs.readFileSync(packageJson, 'utf8')).version
}

for (const [sourceName, nativeName] of nativePackages) {
  const version = packageVersion(sourceName)
  const targetDirectory = packageDirectory(nativeName)
  const installedPackageJson = path.join(targetDirectory, 'package.json')

  if (fs.existsSync(installedPackageJson) && packageVersion(nativeName) === version) {
    console.log(`✓ ${nativeName}@${version}`)
    continue
  }

  const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fan-native-'))
  try {
    const archive = execFileSync('npm', ['pack', `${nativeName}@${version}`, '--silent'], {
      cwd: packDirectory,
      encoding: 'utf8',
    }).trim().split(/\s+/).at(-1)

    if (!archive) throw new Error(`npm pack returned no archive for ${nativeName}@${version}`)
    fs.rmSync(targetDirectory, { recursive: true, force: true })
    fs.mkdirSync(targetDirectory, { recursive: true })
    execFileSync('tar', [
      '-xzf',
      path.join(packDirectory, archive),
      '-C',
      targetDirectory,
      '--strip-components=1',
    ])
    console.log(`✓ ${nativeName}@${version}`)
  } finally {
    fs.rmSync(packDirectory, { recursive: true, force: true })
  }
}
