'use strict'
// DOM 观测流水线日志(code-review / 排障用)。把 observe() 这条责任链上每个阶段的【入参→出参】摘要
// 写进 $FAN_HOME/dom-pipeline.log,让你看清原始 CDP 快照如何一步步变成最终发给 LLM 的 DOM 文本。
//
// - 开发阶段默认开(FAN_DESKTOP_DEV_SERVER / 源码树在场),打包生产默认关。
//   FAN_INSTALL_METHOD=packaged 是正式包的权威身份；只有 FAN_DOM_PIPELINE_LOG
//   的明确真值可以覆盖默认值，拼错或未知值一律关闭。
// - 默认只写日志文件；只有 FAN_DOM_PIPELINE_STDOUT 的明确真值才会复制到 stdout。
// - 日志最多保留当前文件和一个轮转文件，并以用户私有权限创建。
// - 只写【摘要】(数量/字符数/少量样本),不 dump 几兆的原始快照——那对 review 无用还撑爆文件。
// - 永不抛错:任何异常都吞掉,绝不影响 observe 主流程。
const fs = require('fs')
const path = require('path')
const os = require('os')

const MAX_BYTES = 8 * 1024 * 1024
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

let _enabled = null
let _path = null

function _explicitFlag(name) {
  const raw = process.env[name]
  if (raw == null || !String(raw).trim()) return null
  const value = String(raw).trim().toLowerCase()
  if (TRUE_VALUES.has(value)) return true
  if (FALSE_VALUES.has(value)) return false
  return false
}

function _isDev() {
  const installMethod = String(process.env.FAN_INSTALL_METHOD || '').trim().toLowerCase()
  if (installMethod === 'packaged') return false
  if (installMethod === 'dev') return true
  if (process.env.FAN_DESKTOP_DEV_SERVER) return true
  // 直接运行源码、尚未经过 Electron 启动器时，用源码树作为开发信号。
  return fs.existsSync(path.join(__dirname, '..', '..', '..', '..', '.git')) ||
    fs.existsSync(path.join(__dirname, '..', '..', '..', '..', '..', '.git'))
}

function enabled() {
  if (_enabled !== null) return _enabled
  try {
    const explicit = _explicitFlag('FAN_DOM_PIPELINE_LOG')
    _enabled = explicit === null ? _isDev() : explicit
  } catch {
    _enabled = false
  }
  return _enabled
}

function logPath() {
  if (_path === false) return null
  if (_path) return _path
  let base
  try {
    // FAN_HOME 未设时按平台兜底:Windows → %LOCALAPPDATA%\fan;macOS/Linux → ~/.fan。
    // (旧代码无平台判断,在 Mac 上会凭空造出 ~/AppData/Local/fan 这个假 Windows 目录。)
    base = process.env.FAN_HOME || (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fan')
      : path.join(os.homedir(), '.fan'))
    fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  } catch {
    // DOM diagnostics can contain page URLs and text samples. If the private
    // profile directory is unavailable, disable file logging instead of
    // falling back to a predictable file in the shared system temp folder.
    _path = false
    return null
  }
  _path = path.join(base, 'dom-pipeline.log')
  return _path
}

function _boundedBuffer(text) {
  const encoded = Buffer.from(String(text), 'utf8')
  if (encoded.length <= MAX_BYTES) return encoded
  const marker = Buffer.from('\n[dom-pipeline record truncated to bounded log size]\n', 'utf8')
  let end = MAX_BYTES - marker.length
  // `encoded` came from a valid JS string. If the byte limit lands inside a
  // multibyte code point, back up to its leading byte instead of writing an
  // invalid UTF-8 suffix.
  while (end > 0 && (encoded[end] & 0xC0) === 0x80) end -= 1
  return Buffer.concat([encoded.subarray(0, end), marker])
}

function _lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function _tightenPrivateRegularFile(filePath) {
  const current = _lstatOrNull(filePath)
  if (!current || current.isSymbolicLink() || !current.isFile()) return false
  let flags = fs.constants.O_RDONLY
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW
  const fd = fs.openSync(filePath, flags)
  try {
    if (!fs.fstatSync(fd).isFile()) return false
    try { fs.fchmodSync(fd, 0o600) } catch (error) { void error }
    return true
  } finally {
    fs.closeSync(fd)
  }
}

function _rotateIfNeeded(filePath, incomingBytes) {
  const current = _lstatOrNull(filePath)
  if (!current) return
  if (current.isSymbolicLink()) {
    throw new Error('refusing to write dom-pipeline.log through a symlink')
  }
  if (!current.isFile()) {
    throw new Error('dom-pipeline.log target is not a regular file')
  }
  if (current.size + incomingBytes <= MAX_BYTES) return

  const backupPath = `${filePath}.1`
  const backup = _lstatOrNull(backupPath)
  if (backup) {
    if (backup.isDirectory()) throw new Error('refusing to replace dom-pipeline.log.1 directory')
    fs.unlinkSync(backupPath)
  }
  fs.renameSync(filePath, backupPath)
  _tightenPrivateRegularFile(backupPath)
}

function _appendPrivate(filePath, buffer) {
  _tightenPrivateRegularFile(`${filePath}.1`)
  _rotateIfNeeded(filePath, buffer.length)
  let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
  if (typeof fs.constants.O_NOFOLLOW === 'number') flags |= fs.constants.O_NOFOLLOW

  const fd = fs.openSync(filePath, flags, 0o600)
  try {
    const stats = fs.fstatSync(fd)
    if (!stats.isFile()) throw new Error('dom-pipeline.log target is not a regular file')
    try { fs.fchmodSync(fd, 0o600) } catch (error) { void error }
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset)
      if (written <= 0) break
      offset += written
    }
  } finally {
    fs.closeSync(fd)
  }
}

function _write(text) {
  const buffer = _boundedBuffer(text)
  const filePath = logPath()
  if (filePath) {
    try { _appendPrivate(filePath, buffer) } catch (error) { void error }
  }
  if (_explicitFlag('FAN_DOM_PIPELINE_STDOUT') === true) {
    try { process.stdout.write(buffer) } catch (error) { void error }
  }
}

// 紧凑摘要:对象/数组只取关键计数与样本,字符串截断,绝不铺全量。
function _brief(v, sample = 0) {
  try {
    if (v == null) return String(v)
    if (typeof v === 'string') {
      const oneLine = v.replace(/\n/g, '\\n')
      return v.length > 200 ? `"${oneLine.slice(0, 200)}…"(${v.length} 字符)` : `"${oneLine}"`
    }
    if (typeof v !== 'object') return String(v)
    if (Array.isArray(v)) {
      let s = `数组[${v.length}]`
      if (sample > 0 && v.length) s += ` 样本: ${v.slice(0, sample).map(x => _brief(x)).join(' | ')}`
      return s
    }
    // 普通对象:逐字段展开(数字/布尔直接给值;字符串截断;嵌套对象再展开一层数字字段)。
    const parts = []
    for (const k of Object.keys(v).slice(0, 14)) {
      const val = v[k]
      if (val == null) { parts.push(`${k}=${val}`); continue }
      const t = typeof val
      if (t === 'number' || t === 'boolean') parts.push(`${k}=${val}`)
      else if (t === 'string') parts.push(`${k}=${val.length > 60 ? '"' + val.slice(0, 60).replace(/\n/g, '\\n') + '…"' : '"' + val.replace(/\n/g, '\\n') + '"'}`)
      else if (Array.isArray(val)) parts.push(`${k}[${val.length}]`)
      else if (t === 'object') {
        const sub = Object.keys(val).filter(kk => typeof val[kk] === 'number' || typeof val[kk] === 'boolean').map(kk => `${kk}=${val[kk]}`)
        parts.push(sub.length ? `${k}{${sub.slice(0, 8).join(' ')}}` : `${k}{…}`)
      }
    }
    return `{${parts.join(', ')}}`
  } catch {
    return '<brief失败>'
  }
}

function begin(observeId, url) {
  if (!enabled()) return
  _write(`\n${'▼'.repeat(60)}\nDOM 流水线 · observe(${observeId})  ${url || ''}\n${'▼'.repeat(60)}\n`)
}

// 记录一个阶段:序号、名称、入参摘要、出参摘要。inObj/outObj 传对象即可,内部转摘要。
function stage(n, name, inObj, outObj) {
  if (!enabled()) return
  const inS = inObj === undefined ? '—' : _brief(inObj, 1)
  const outS = outObj === undefined ? '—' : _brief(outObj, 1)
  _write(`[${n}] ${name}\n     入: ${inS}\n     出: ${outS}\n`)
}

// 最终发给 LLM 的 DOM 文本:给字符数 + 前若干行样本(它就是 tool 结果里的 dom 字段)。
function final(text, sampleLines = 12) {
  if (!enabled()) return
  const s = String(text || '')
  const lines = s.split('\n')
  const head = lines.slice(0, sampleLines).join('\n')
  const more = lines.length > sampleLines ? `\n… (共 ${lines.length} 行 / ${s.length} 字符,完整内容见 llm-io.log 的工具结果)` : ''
  _write(`${'▲'.repeat(60)}\n最终回传 Python 的 dom(= 发给 LLM 的那串)· ${lines.length} 行 / ${s.length} 字符:\n${head}${more}\n${'▲'.repeat(60)}\n`)
}

// 具体样本:逐字段铺一个真实对象(元素/节点),字符串截断、真实换行。让你看到"一个元素长什么样",
// 不只是数量。item 传单个对象即可;传字符串则按文本样本(前若干字符)展示。
function sample(label, item, maxStr = 160) {
  if (!enabled()) return
  try {
    let body
    if (item == null) {
      body = String(item)
    } else if (typeof item === 'string') {
      body = item.length > maxStr ? item.slice(0, maxStr).replace(/\n/g, '\\n') + `…(共 ${item.length} 字符)` : item
    } else if (typeof item === 'object') {
      const lines = []
      for (const [k, v] of Object.entries(item)) {
        if (v === undefined) continue
        let vs
        if (v === null) vs = 'null'
        else if (typeof v === 'string') vs = v.length > maxStr ? '"' + v.slice(0, maxStr).replace(/\n/g, '\\n') + '…"' : '"' + v.replace(/\n/g, '\\n') + '"'
        else if (typeof v === 'object') { vs = JSON.stringify(v); if (vs.length > 220) vs = vs.slice(0, 220) + '…' }
        else vs = String(v)
        lines.push(`         ${k}: ${vs}`)
      }
      body = lines.join('\n')
    } else {
      body = String(item)
    }
    _write(`     ◦ ${label}:\n${body}\n`)
  } catch (e) { void e }
}

module.exports = { enabled, begin, stage, final, sample }
