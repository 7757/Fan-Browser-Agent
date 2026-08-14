const fs = require('node:fs')
const path = require('node:path')

function writeFlags() {
  return fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0)
}

function boundedChunk(chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8')
  return buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer
}

function assertRegularOrMissingSync(filePath) {
  try {
    const stats = fs.lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Log target is not a regular file')
    return stats
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function assertRegularOrMissing(filePath) {
  try {
    const stats = await fs.promises.lstat(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Log target is not a regular file')
    return stats
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function rotateSync(filePath, backups) {
  if (backups <= 0) {
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return
  }
  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`
    const target = `${filePath}.${index}`
    try {
      fs.unlinkSync(target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      fs.renameSync(source, target)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

async function rotate(filePath, backups) {
  if (backups <= 0) {
    await fs.promises.unlink(filePath).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
    return
  }
  for (let index = backups; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`
    const target = `${filePath}.${index}`
    await fs.promises.unlink(target).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
    await fs.promises.rename(source, target).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

function appendRotatingFileSync(filePath, chunk, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || 5 * 1024 * 1024)
  const backups = Math.max(0, Number(options.backups) || 0)
  const data = boundedChunk(chunk, maxBytes)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const existing = assertRegularOrMissingSync(filePath)
  if (existing && existing.size + data.length > maxBytes) rotateSync(filePath, backups)
  const descriptor = fs.openSync(filePath, writeFlags(), 0o600)
  try {
    const stats = fs.fstatSync(descriptor)
    if (!stats.isFile()) throw new Error('Log target is not a regular file')
    fs.writeFileSync(descriptor, data)
    try {
      fs.fchmodSync(descriptor, 0o600)
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

async function appendRotatingFile(filePath, chunk, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || 5 * 1024 * 1024)
  const backups = Math.max(0, Number(options.backups) || 0)
  const data = boundedChunk(chunk, maxBytes)
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const existing = await assertRegularOrMissing(filePath)
  if (existing && existing.size + data.length > maxBytes) await rotate(filePath, backups)
  const handle = await fs.promises.open(filePath, writeFlags(), 0o600)
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('Log target is not a regular file')
    await handle.writeFile(data)
    try {
      await handle.chmod(0o600)
    } catch {
      // Best effort on filesystems that do not expose POSIX modes.
    }
  } finally {
    await handle.close()
  }
}

module.exports = { appendRotatingFile, appendRotatingFileSync }
