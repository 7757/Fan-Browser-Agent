const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')

const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const DATA_URL_READ_MAX_BYTES = 16 * 1024 * 1024
const TEXT_PREVIEW_SOURCE_MAX_BYTES = 64 * 1024 * 1024

const SAFE_ENV_SUFFIXES = new Set(['dist', 'example', 'sample', 'template'])
const SENSITIVE_EXTENSIONS = new Set(['.kdbx', '.p12', '.pem', '.pfx'])

function resolveTimeoutMs(timeoutMs, fallbackMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const fallback =
    Number.isFinite(fallbackMs) && Number(fallbackMs) > 0 ? Math.round(Number(fallbackMs)) : DEFAULT_FETCH_TIMEOUT_MS
  const parsed = Number(timeoutMs)

  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed)
  }

  return fallback
}

function sensitiveFileBlockReason(filePath) {
  const normalized = String(filePath || '')
    .replace(/\\/g, '/')
    .toLowerCase()
  const basename = path.basename(normalized)
  const ext = path.extname(basename)

  if (!basename) {
    return null
  }

  if (normalized.includes('/.ssh/')) {
    return 'SSH key/config files are blocked.'
  }

  if (normalized.includes('/.gnupg/')) {
    return 'GPG key material is blocked.'
  }

  if (normalized.endsWith('/.aws/credentials')) {
    return 'AWS credential files are blocked.'
  }

  if (basename === '.env') {
    return '.env files are blocked because they commonly contain secrets.'
  }

  if (basename.startsWith('.env.')) {
    const suffix = basename.slice('.env.'.length)
    if (!SAFE_ENV_SUFFIXES.has(suffix)) {
      return `${basename} is blocked because it appears to contain environment secrets.`
    }
  }

  if (/^id_(rsa|dsa|ecdsa|ed25519)(?:\..+)?$/.test(basename) && !basename.endsWith('.pub')) {
    return 'SSH private key files are blocked.'
  }

  if (SENSITIVE_EXTENSIONS.has(ext)) {
    return `${ext} key/certificate files are blocked.`
  }

  if (basename === '.npmrc' || basename === '.netrc' || basename === '.pypirc') {
    return `${basename} is blocked because it may include auth credentials.`
  }

  return null
}

function ipcPathError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// Reject Windows device paths (\\?\, \\.\, \GlobalRoot\Device\...) and null
// bytes before any file read/open.
function rejectUnsafePathSyntax(filePath, purpose = 'File read') {
  if (typeof filePath !== 'string') {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is required.`)
  }

  const raw = filePath.trim()

  if (!raw) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is required.`)
  }

  if (raw.includes('\0')) {
    throw ipcPathError('invalid-path', `${purpose} failed: file path is invalid.`)
  }

  const normalized = raw.replace(/\\/g, '/').toLowerCase()
  if (
    normalized.startsWith('//?/') ||
    normalized.startsWith('//./') ||
    normalized.startsWith('globalroot/device/') ||
    normalized.includes('/globalroot/device/')
  ) {
    throw ipcPathError('device-path', `${purpose} blocked: Windows device paths are not allowed.`)
  }

  return raw
}

// Resolve a requested path (file:// URL or plain path) to an absolute path with
// device-path/null-byte rejection. Used by openExternalUrl / resourceBufferFromUrl
// which previously passed file:// straight through fileURLToPath unhardened.
function resolveRequestedPathForIpc(filePath, options = {}) {
  const purpose = String(options.purpose || 'File read')
  const raw = rejectUnsafePathSyntax(filePath, purpose)

  if (/^file:/i.test(raw)) {
    let resolvedPath
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'file:') {
        throw new Error('not a file URL')
      }
      resolvedPath = fileURLToPath(parsed)
    } catch {
      throw ipcPathError('invalid-path', `${purpose} failed: file URL is invalid.`)
    }

    rejectUnsafePathSyntax(resolvedPath, purpose)
    return path.resolve(resolvedPath)
  }

  const baseInput = typeof options.baseDir === 'string' && options.baseDir.trim() ? options.baseDir : process.cwd()
  const safeBaseInput = rejectUnsafePathSyntax(baseInput, purpose)
  const resolvedBase = path.resolve(safeBaseInput)
  rejectUnsafePathSyntax(resolvedBase, purpose)
  const resolvedPath = path.resolve(resolvedBase, raw)
  rejectUnsafePathSyntax(resolvedPath, purpose)

  return resolvedPath
}

// stat with structured error codes + a typeLabel for the message.
async function statForIpc(fsImpl, resolvedPath, purpose, typeLabel) {
  try {
    return await fsImpl.promises.stat(resolvedPath)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw ipcPathError(code || 'ENOENT', `${purpose} failed: ${typeLabel} does not exist.`)
    }
    throw ipcPathError(code || 'read-error', `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Resolve symlinks then re-validate the real target's syntax — catches a
// symlink that points at a Windows device path.
async function realpathForIpc(fsImpl, resolvedPath, purpose) {
  if (typeof fsImpl.promises.realpath !== 'function') {
    return resolvedPath
  }

  try {
    const realPath = await fsImpl.promises.realpath(resolvedPath)
    rejectUnsafePathSyntax(realPath, purpose)
    return realPath
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : ''
    throw ipcPathError(code || 'read-error', `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function rejectSensitiveFilePath(filePath, purpose) {
  const blockReason = sensitiveFileBlockReason(filePath)
  if (blockReason) {
    throw ipcPathError('sensitive-file', `${purpose} blocked for sensitive file: ${blockReason}`)
  }
}

async function resolveReadableFileForIpc(filePath, options = {}) {
  const purpose = String(options.purpose || 'File read')
  const fsImpl = options.fs || fs
  const resolvedPath = resolveRequestedPathForIpc(filePath, { baseDir: options.baseDir, purpose })

  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(resolvedPath, purpose)
  }

  const stat = await statForIpc(fsImpl, resolvedPath, purpose, 'file')

  if (stat.isDirectory()) {
    throw ipcPathError('EISDIR', `${purpose} failed: path points to a directory.`)
  }

  if (!stat.isFile()) {
    throw ipcPathError('EINVAL', `${purpose} failed: only regular files can be read.`)
  }

  // Re-check the symlink-resolved target so a symlink can't smuggle a sensitive
  // or device path past the pre-stat check above.
  const realPath = await realpathForIpc(fsImpl, resolvedPath, purpose)
  if (options.blockSensitive !== false) {
    rejectSensitiveFilePath(realPath, purpose)
  }

  const maxBytes = Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0 ? Number(options.maxBytes) : null
  if (maxBytes && stat.size > maxBytes) {
    throw ipcPathError('EFBIG', `${purpose} failed: file is too large (${stat.size} bytes; limit ${maxBytes} bytes).`)
  }

  try {
    await fsImpl.promises.access(resolvedPath, fs.constants.R_OK)
  } catch {
    throw ipcPathError('EACCES', `${purpose} failed: file is not readable.`)
  }

  // `realPath` is additive — existing callers destructure { resolvedPath, stat }.
  return { realPath, resolvedPath, stat }
}

module.exports = {
  DATA_URL_READ_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  TEXT_PREVIEW_SOURCE_MAX_BYTES,
  resolveReadableFileForIpc,
  resolveRequestedPathForIpc,
  resolveTimeoutMs,
  sensitiveFileBlockReason
}
