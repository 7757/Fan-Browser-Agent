/** electron-builder afterPack checks. */

const fs = require('node:fs')
const path = require('node:path')
const { listPackage } = require('@electron/asar')

const { assertRequiredLegalFiles } = require('../electron/packaged-backend-policy.cjs')

const PACKAGED_TEST_TOOL_FILES = new Set([
  'run_tests.sh',
  'run_tests_parallel.py',
  'test_durations.json'
])
const PACKAGED_RAW_DEBUG_FILES = new Set([
  'dom-llm-log.jsonl',
  'dom-pipeline-log.jsonl',
  'find-visual-log.jsonl',
  'grounding_debug.jsonl'
])

function resourcesDirForContext(context) {
  const platformName = context.electronPlatformName
  const productFilename = context.packager?.appInfo?.productFilename || 'Fan'

  return platformName === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
}

function normalizeRelative(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function isPackagedTestPath(file) {
  const normalized = normalizeRelative(file)

  return (
    /(^|\/)(test|tests|__tests__)(\/|$)/i.test(normalized) ||
    /\.(test|spec)\.(js|cjs|mjs|ts|tsx|jsx)$/i.test(normalized)
  )
}

function isPackagedLogPath(file) {
  const normalized = normalizeRelative(file)
  const basename = path.basename(normalized).toLowerCase()
  const unrotatedBasename = basename.replace(/\.\d+$/, '')
  return (
    /\.log(?:\.\d+)?$/i.test(normalized) ||
    PACKAGED_RAW_DEBUG_FILES.has(unrotatedBasename)
  )
}

function isPackagedPythonTestPath(file) {
  const normalized = normalizeRelative(file)

  return (
    /(^|\/)(test|tests|_tests)(\/|$)/i.test(normalized) ||
    /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(normalized)
  )
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return []
  const files = []
  const stack = [root]

  while (stack.length > 0) {
    const current = stack.pop()

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)

      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) files.push(normalizeRelative(path.relative(root, target)))
    }
  }
  return files
}

function assertNoDevelopmentArtifacts(context) {
  const resourcesDir = resourcesDirForContext(context)
  const violations = []
  const asarPath = path.join(resourcesDir, 'app.asar')
  const bundledSource = path.join(resourcesDir, 'fan-src')

  if (!fs.existsSync(asarPath)) {
    violations.push('app.asar:missing')
  } else {
    for (const file of listPackage(asarPath).map(normalizeRelative)) {
      if (isPackagedTestPath(file) || isPackagedLogPath(file)) {
        violations.push(`app.asar:${file}`)
      }
    }
  }

  assertRequiredLegalFiles(bundledSource)

  for (const area of ['native-deps', 'fan-src']) {
    for (const file of walkFiles(path.join(resourcesDir, area))) {
      const basename = path.basename(file)
      const generatedPython =
        area === 'fan-src' &&
        (/(^|\/)__pycache__(\/|$)/.test(file) || /\.(pyc|pyo)$/i.test(file))
      if (
        isPackagedTestPath(file) ||
        isPackagedLogPath(file) ||
        generatedPython ||
        (area === 'fan-src' && PACKAGED_TEST_TOOL_FILES.has(basename))
      ) {
        violations.push(`${area}:${file}`)
      }
    }
  }

  for (const file of walkFiles(path.join(resourcesDir, 'python'))) {
    const normalized = normalizeRelative(file)
    if (
      isPackagedLogPath(normalized) ||
      isPackagedPythonTestPath(normalized) ||
      (context.electronPlatformName !== 'win32' &&
        (normalized === 'bin/python' || normalized === 'bin/python3'))
    ) {
      violations.push(`python:${normalized}`)
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Packaged app contains development-only artifacts (${violations.length}): ` +
        violations.slice(0, 12).join(', ')
    )
  }
}

exports.default = async function afterPack(context) {
  assertNoDevelopmentArtifacts(context)
}

exports.assertNoDevelopmentArtifacts = assertNoDevelopmentArtifacts
exports.isPackagedLogPath = isPackagedLogPath
exports.isPackagedPythonTestPath = isPackagedPythonTestPath
exports.isPackagedTestPath = isPackagedTestPath
