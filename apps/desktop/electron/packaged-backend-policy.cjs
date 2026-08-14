'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Keep the official desktop bundle self-contained without reviving upstream's
// broad optional surface. Pillow is the only lazy dependency reached by the
// retained desktop runtime: it protects image-understanding sessions from
// oversized attachments that need a local resize before model submission.
const PACKAGED_REQUIRED_EXTRAS = Object.freeze(['vision'])
const PACKAGED_REQUIRED_LEGAL_FILES = Object.freeze(['LICENSE'])
// Repository-only development roots must never become importable from a
// customer installation. Tests stay in the source checkout and CI only.
const PACKAGED_FORBIDDEN_SOURCE_ROOTS = Object.freeze(['tests'])

function createPackagedBackendEnv(srcRoot, inheritedPythonPath = '', delimiter = path.delimiter) {
  if (!srcRoot || typeof srcRoot !== 'string') {
    throw new TypeError('srcRoot is required for the packaged backend')
  }

  return {
    PYTHONPATH: [srcRoot, inheritedPythonPath].filter(Boolean).join(delimiter),
    FAN_INSTALL_METHOD: 'packaged',
    // A packaged release is immutable application code. Runtime imports must not
    // write bytecode into Resources, and optional features must never pip/uv
    // install into the bundled interpreter on a user's machine.
    PYTHONDONTWRITEBYTECODE: '1',
    FAN_DISABLE_LAZY_INSTALLS: '1'
  }
}

function findPythonBytecode(root, fsImpl = fs) {
  const found = []

  function walk(directory) {
    for (const entry of fsImpl.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        walk(target)
      } else if (entry.isFile() && (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo'))) {
        found.push(target)
      }
    }
  }

  walk(root)

  return found
}

function assertNoPythonBytecode(root, fsImpl = fs) {
  const found = findPythonBytecode(root, fsImpl)

  if (found.length > 0) {
    const sample = found
      .slice(0, 5)
      .map(file => path.relative(root, file))
      .join(', ')

    throw new Error(`bundled source contains generated Python bytecode: ${sample}`)
  }
}

function assertNoForbiddenSourceRoots(root, fsImpl = fs) {
  const found = PACKAGED_FORBIDDEN_SOURCE_ROOTS.filter(name => fsImpl.existsSync(path.join(root, name)))

  if (found.length > 0) {
    throw new Error(`bundled source contains repository-only roots: ${found.join(', ')}`)
  }
}

function assertRequiredLegalFiles(root, fsImpl = fs) {
  const missing = PACKAGED_REQUIRED_LEGAL_FILES.filter(
    name => !fsImpl.existsSync(path.join(root, name))
  )

  if (missing.length > 0) {
    throw new Error(`bundled source is missing required legal files: ${missing.join(', ')}`)
  }
}

module.exports = {
  PACKAGED_FORBIDDEN_SOURCE_ROOTS,
  PACKAGED_REQUIRED_EXTRAS,
  PACKAGED_REQUIRED_LEGAL_FILES,
  assertNoForbiddenSourceRoots,
  assertNoPythonBytecode,
  assertRequiredLegalFiles,
  createPackagedBackendEnv,
  findPythonBytecode
}
