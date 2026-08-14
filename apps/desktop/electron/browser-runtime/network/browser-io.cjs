const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')

const { EVENT_TYPES } = require('../events/event-types.cjs')
const {
  browserPermissionRequiresHostDecision,
  normalizeBrowserPermission
} = require('../../browser-permission-policy.cjs')

function normalizeHTTPHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  const normalized = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = String(name || '').trim()
    if (!key || value == null) continue
    normalized[key] = String(value)
  }
  return normalized
}

function networkSessionIds(entry) {
  const sessionIds = new Set([undefined])
  const attachedTargets =
    typeof entry.targetManager?.attachedTargets === 'function' ? entry.targetManager.attachedTargets() : []
  for (const target of attachedTargets) {
    if (target?.sessionId) sessionIds.add(target.sessionId)
  }
  return Array.from(sessionIds)
}

async function applyNetworkConfig(runtime, entry) {
  const config = entry.networkConfig || {}
  const shouldSetUserAgent = Boolean(config.userAgentSet)
  const shouldSetHeaders = Boolean(config.extraHTTPHeadersSet)
  if (!shouldSetUserAgent && !shouldSetHeaders) return
  const userAgent = config.userAgent || config.defaultUserAgent || ''
  if (shouldSetUserAgent && userAgent && typeof entry.webContents?.setUserAgent === 'function') {
    entry.webContents.setUserAgent(userAgent)
  }
  const sessionIds = runtime._networkSessionIds(entry)
  await Promise.all(
    sessionIds.map(async sessionId => {
      await entry.client.send('Network.enable', {}, sessionId).catch(() => undefined)
      if (shouldSetUserAgent && userAgent) {
        await entry.client
          .send('Network.setUserAgentOverride', { userAgent }, sessionId)
          .catch(() => undefined)
      }
      if (shouldSetHeaders) {
        await entry.client
          .send('Network.setExtraHTTPHeaders', { headers: config.extraHTTPHeaders || {} }, sessionId)
          .catch(() => undefined)
      }
    })
  )
}

function networkConfig(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  runtime._assertEntryDecisionToken(entry, params, 'networkConfig')
  const config = entry.networkConfig || {}
  return {
    userAgent: config.userAgent || config.defaultUserAgent || '',
    customUserAgent: config.userAgent || '',
    userAgentSet: Boolean(config.userAgentSet),
    extraHTTPHeaders: { ...(config.extraHTTPHeaders || {}) },
    extraHTTPHeadersSet: Boolean(config.extraHTTPHeadersSet)
  }
}

async function setNetworkConfig(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  await runtime._prepare(entry)
  runtime._assertEntryDecisionToken(entry, params, 'setNetworkConfig')
  const config = entry.networkConfig || {
    defaultUserAgent: typeof entry.webContents?.getUserAgent === 'function' ? entry.webContents.getUserAgent() : '',
    userAgent: '',
    userAgentSet: false,
    extraHTTPHeaders: {},
    extraHTTPHeadersSet: false
  }
  if (params.clear === true) {
    config.userAgent = ''
    config.userAgentSet = true
    config.extraHTTPHeaders = {}
    config.extraHTTPHeadersSet = true
  }
  if (params.userAgent != null || params.user_agent != null) {
    config.userAgent = String(params.userAgent ?? params.user_agent ?? '').trim()
    config.userAgentSet = true
  }
  if (params.headers != null || params.extraHTTPHeaders != null || params.extra_http_headers != null) {
    config.extraHTTPHeaders = runtime._normalizeHTTPHeaders(
      params.headers ?? params.extraHTTPHeaders ?? params.extra_http_headers ?? {}
    )
    config.extraHTTPHeadersSet = true
  }
  if (params.clearHeaders === true || params.clear_headers === true) {
    config.extraHTTPHeaders = {}
    config.extraHTTPHeadersSet = true
  }
  entry.networkConfig = config
  await runtime._applyNetworkConfig(entry)
  return runtime.networkConfig(id)
}

async function grantPermissions(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  runtime._assertEntryDecisionToken(entry, params, 'grantPermissions')
  const permissions = Array.isArray(params.permissions)
    ? params.permissions
    : String(params.permissions || '')
        .split(/\s*,\s*|\s+/)
        .filter(Boolean)
  const normalized = permissions.map(normalizeBrowserPermission).filter(Boolean)
  const userDecisionRequired = normalized.filter(browserPermissionRequiresHostDecision)
  entry.permissionPolicy.granted = new Set(
    normalized.filter(permission => !browserPermissionRequiresHostDecision(permission))
  )
  return {
    permissions: Array.from(entry.permissionPolicy.granted),
    userDecisionRequired
  }
}

async function har(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  runtime._assertEntryDecisionToken(entry, params, 'har')
  const snapshot = entry.watchdog?.harSnapshot
    ? entry.watchdog.harSnapshot({ mode: params.mode || params.recordHarMode || params.record_har_mode || 'full' })
    : { log: { version: '1.2', entries: [] } }
  if (params.clear === true && entry.watchdog?.harEntries) entry.watchdog.harEntries.clear()
  return runtime._harWithContentMode(snapshot, params.contentMode || params.content_mode || 'embed')
}

async function saveHar(runtime, id, params = {}) {
  const filePath = String(params.path || '').trim()
  if (!filePath) throw new Error('path is required')
  const entry = runtime.getWorkbench(id)
  runtime._assertEntryDecisionToken(entry, params, 'saveHar')
  const rawSnapshot = entry.watchdog?.harSnapshot
    ? entry.watchdog.harSnapshot({ mode: params.mode || params.recordHarMode || params.record_har_mode || 'full' })
    : { log: { version: '1.2', entries: [] } }
  const snapshot = await runtime._prepareHarForSave(
    rawSnapshot,
    filePath,
    params.contentMode || params.content_mode || 'embed'
  )
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  const entryCount = snapshot?.log?.entries?.length || 0
  runtime.eventBus.emit(EVENT_TYPES.HAR_SAVED, {
    id: String(id || 'main'),
    path: filePath,
    entryCount
  })
  return { path: filePath, entryCount }
}

function harWithContentMode(snapshot, contentMode) {
  const clone = JSON.parse(JSON.stringify(snapshot || { log: { version: '1.2', entries: [] } }))
  if (String(contentMode || '').toLowerCase() !== 'omit') return clone
  for (const entry of clone.log?.entries || []) {
    const content = entry.response?.content
    if (content) {
      delete content.text
      delete content.encoding
      delete content._file
    }
    if (entry.request) entry.request.postData = null
  }
  return clone
}

async function prepareHarForSave(runtime, snapshot, filePath, contentMode) {
  const mode = String(contentMode || 'embed').toLowerCase()
  const clone = runtime._harWithContentMode(snapshot, mode)
  if (mode !== 'attach') return clone
  const parsed = path.parse(filePath)
  const sidecarName = `${parsed.name}_har_parts`
  const sidecarDir = path.join(parsed.dir, sidecarName)
  await fs.mkdir(sidecarDir, { recursive: true })
  for (const entry of clone.log?.entries || []) {
    const content = entry.response?.content
    if (content?.text) {
      const bytes = content.encoding === 'base64'
        ? Buffer.from(content.text, 'base64')
        : Buffer.from(String(content.text), 'utf8')
      const filename = runtime._harSidecarFilename(bytes, content.mimeType)
      await fs.writeFile(path.join(sidecarDir, filename), bytes)
      delete content.text
      delete content.encoding
      content._file = filename
    }
    const postData = entry.request?.postData
    if (postData?.text != null) {
      const mimeType = postData.mimeType || runtime._harHeaderValue(entry.request?.headers || {}, 'content-type') || 'text/plain'
      const bytes = Buffer.from(String(postData.text), 'utf8')
      const filename = runtime._harSidecarFilename(bytes, mimeType)
      await fs.writeFile(path.join(sidecarDir, filename), bytes)
      entry.request.postData = {
        mimeType,
        _file: filename
      }
    }
  }
  return clone
}

function harSidecarFilename(runtime, bytes, mimeType = '') {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')
  const hash = crypto.createHash('sha1').update(buffer).digest('hex')
  return `${hash}.${runtime._extensionForMime(mimeType)}`
}

function harHeaderValue(headers = {}, name = '') {
  if (!headers || typeof headers !== 'object') return ''
  const target = String(name || '').toLowerCase()
  const list = Array.isArray(headers)
    ? headers
    : Object.entries(headers).map(([key, value]) => ({ name: key, value }))
  for (const header of list) {
    if (String(header?.name || '').toLowerCase() === target) {
      const value = header?.value
      return Array.isArray(value) ? value.join(', ') : String(value ?? '')
    }
  }
  return ''
}

function extensionForMime(mimeType = '') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
  const map = {
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
    'application/x-javascript': 'js',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'text/plain': 'txt',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'application/font-woff': 'woff',
    'application/font-woff2': 'woff2',
    'application/x-font-woff': 'woff',
    'application/x-font-woff2': 'woff2',
    'font/ttf': 'ttf',
    'application/x-font-ttf': 'ttf',
    'font/otf': 'otf',
    'application/x-font-opentype': 'otf',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/x-zip-compressed': 'zip',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg'
  }
  return map[normalized] || 'bin'
}

async function startScreencast(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  await runtime._prepare(entry)
  runtime._assertEntryDecisionToken(entry, params, 'startScreencast')
  const maxFrames = Math.max(0, Math.min(2000, Number(params.maxFrames ?? params.max_frames) || 0))
  entry.screencast = {
    active: true,
    frames: [],
    maxFrames,
    captureFrames: params.captureFrames === true || params.capture_frames === true
  }
  await entry.client.send('Page.startScreencast', {
    format: params.format || 'png',
    quality: Math.max(1, Math.min(100, Number(params.quality) || 80)),
    maxWidth: Number(params.maxWidth || params.max_width) || undefined,
    maxHeight: Number(params.maxHeight || params.max_height) || undefined,
    everyNthFrame: Math.max(1, Math.min(60, Number(params.everyNthFrame || params.every_nth_frame) || 1))
  })
  runtime.eventBus.emit(EVENT_TYPES.SCREENCAST_STARTED, {
    id: entry.id,
    maxFrames,
    captureFrames: entry.screencast.captureFrames
  })
  return { started: true, maxFrames, captureFrames: entry.screencast.captureFrames }
}

async function stopScreencast(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  await runtime._prepare(entry)
  runtime._assertEntryDecisionToken(entry, params, 'stopScreencast')
  await entry.client.send('Page.stopScreencast').catch(() => undefined)
  const frames = entry.screencast?.frames || []
  entry.screencast = { active: false, frames: [], maxFrames: 0, captureFrames: false }
  runtime.eventBus.emit(EVENT_TYPES.SCREENCAST_STOPPED, { id: entry.id, frameCount: frames.length })
  return {
    stopped: true,
    frameCount: frames.length,
    frames: params.includeFrames === true || params.include_frames === true ? frames : undefined
  }
}

function createDownloadWatcher(runtime, entry, params = {}) {
  if (params.waitForDownload === false || params.wait_for_download === false) {
    return { finish: async () => null, dispose: () => undefined }
  }
  const startTimeoutMs = runtime._coerceTimeout(
    params.downloadStartTimeoutMs ?? params.download_start_timeout_ms,
    600
  )
  const completeTimeoutMs = runtime._coerceTimeout(
    params.downloadCompleteTimeoutMs ?? params.download_complete_timeout_ms,
    30000
  )
  const events = []
  let started = false
  let done = false
  let doneEvent = null
  let lastEvent = null
  let resolveDone = null
  const workbenchId = entry.id || 'main'
  const donePromise = new Promise(resolve => {
    resolveDone = resolve
  })
  const capture = event => {
    if (event.payload?.id !== workbenchId) return
    if (event.payload?.download?.autoDownload === true) return
    events.push(event)
    lastEvent = event
    if (event.type === EVENT_TYPES.DOWNLOAD_STARTED) started = true
    if (event.type === EVENT_TYPES.DOWNLOAD_UPDATED && event.payload?.download) started = true
    if (event.type === EVENT_TYPES.DOWNLOAD_UPDATED && event.payload?.done) {
      done = true
      doneEvent = event
      resolveDone(event)
    }
  }
  const offStarted = runtime.eventBus.on(EVENT_TYPES.DOWNLOAD_STARTED, capture)
  const offUpdated = runtime.eventBus.on(EVENT_TYPES.DOWNLOAD_UPDATED, capture)
  const dispose = () => {
    offStarted()
    offUpdated()
  }
  return {
    async finish() {
      await new Promise(resolve => setTimeout(resolve, startTimeoutMs))
      if (!started) {
        dispose()
        return null
      }
      if (!done) {
        await Promise.race([donePromise, new Promise(resolve => setTimeout(resolve, completeTimeoutMs))])
      }
      dispose()
      const finalEvent = doneEvent || lastEvent
      const download = finalEvent?.payload?.download || {}
      const base = {
        url: download.url || '',
        fileName: download.filename || '',
        path: download.savePath || '',
        receivedBytes: Number(download.receivedBytes || 0),
        totalBytes: Number(download.totalBytes || 0),
        state: finalEvent?.payload?.state || '',
        events: events.length
      }
      if (done) return { download: { ...base, completed: base.state !== 'cancelled' && base.state !== 'interrupted' } }
      const lastUpdateMs = finalEvent?.timestamp || null
      const ageMs = lastUpdateMs ? Date.now() - lastUpdateMs : Number.POSITIVE_INFINITY
      const activeStates = new Set(['progressing', 'inprogress', 'in_progress'])
      const stillActive = activeStates.has(String(base.state || '').toLowerCase()) && ageMs < 5000
      if (stillActive) {
        return {
          downloadInProgress: {
            ...base,
            lastUpdateMs,
            completed: false,
            timedOut: true,
            stalled: false,
            progressPercent: base.totalBytes > 0 ? (base.receivedBytes / base.totalBytes) * 100 : null
          }
        }
      }
      return {
        downloadTimeout: {
          ...base,
          lastUpdateMs,
          completed: false,
          timedOut: true,
          stalled: true,
          message: base.receivedBytes > 0
            ? 'Download timed out after receiving partial data; check the downloads folder or wait and retry.'
            : 'Download timed out without progress data; it may have stalled or failed to start.'
        }
      }
    },
    dispose
  }
}

async function applyClickDownloadMetadata(result, watcher) {
  const metadata = watcher ? await watcher.finish() : null
  if (!metadata) return result
  if (metadata.download) result.download = metadata.download
  if (metadata.downloadInProgress) result.downloadInProgress = metadata.downloadInProgress
  if (metadata.downloadTimeout) result.downloadTimeout = metadata.downloadTimeout
  return result
}

function isPrintRelatedElement(element = {}) {
  const attributes = element.attributes || {}
  const onclick = String(attributes.onclick || attributes.onClick || element.onclick || '').toLowerCase()
  return onclick.includes('print')
}

function safeDownloadFilename(value, extension = 'bin', fallback = 'file') {
  const suffix = String(extension || 'bin').replace(/^\./, '').toLowerCase()
  const normalized = String(value || '')
    .normalize('NFKC')
    .split('')
    .filter(char => {
      const code = char.charCodeAt(0)
      return code >= 32 && !'<>:"/\\|?*'.includes(char)
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50)
  const base = normalized && !['.', '..'].includes(normalized) ? normalized : fallback
  return base.toLowerCase().endsWith(`.${suffix}`) ? base : `${base}.${suffix}`
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function uniqueDownloadFilePath(runtime, fileName, extension = 'pdf', fallback = 'file') {
  await fs.mkdir(runtime.downloadsPath, { recursive: true })
  const ext = String(extension || 'bin').replace(/^\./, '').toLowerCase()
  const parsed = path.parse(runtime._safeDownloadFilename(fileName, ext, fallback))
  let candidate = path.resolve(runtime.downloadsPath, `${parsed.name}${parsed.ext || `.${ext}`}`)
  let relative = path.relative(runtime.downloadsPath, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to write file outside downloads directory')
  }
  for (let counter = 1; await runtime._pathExists(candidate); counter += 1) {
    candidate = path.resolve(runtime.downloadsPath, `${parsed.name} (${counter})${parsed.ext || `.${ext}`}`)
    relative = path.relative(runtime.downloadsPath, candidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to write file outside downloads directory')
    }
  }
  return candidate
}

async function handlePrintButtonClick(runtime, entry, element = {}, sessionId = undefined) {
  if (!runtime._isPrintRelatedElement(element)) return null
  try {
    const printResult = await entry.client.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true
    }, sessionId)
    const pdfData = printResult?.data
    if (!pdfData) return null

    const title = typeof entry.webContents?.getTitle === 'function' ? entry.webContents.getTitle() : ''
    const url = typeof entry.webContents?.getURL === 'function' ? entry.webContents.getURL() : ''
    const finalPath = await runtime._uniqueDownloadPath(runtime._safePdfFilename(title || 'print'))
    const bytes = Buffer.from(String(pdfData), 'base64')
    await fs.writeFile(finalPath, bytes)
    const stat = await fs.stat(finalPath)
    const download = {
      url,
      fileName: path.basename(finalPath),
      path: finalPath,
      fileSize: stat.size,
      fileType: 'pdf',
      mimeType: 'application/pdf',
      autoDownload: false,
      completed: true
    }
    const watchdogDownload = {
      url,
      filename: download.fileName,
      savePath: download.path,
      receivedBytes: stat.size,
      totalBytes: stat.size,
      fileSize: stat.size,
      fileType: 'pdf',
      mimeType: 'application/pdf',
      autoDownload: false
    }
    entry.watchdog?._recordDownload?.('done', watchdogDownload, 'completed')
    runtime.eventBus.emit(EVENT_TYPES.DOWNLOAD_STARTED, { id: entry.id, download: watchdogDownload })
    runtime.eventBus.emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
      id: entry.id,
      state: 'completed',
      done: true,
      download: watchdogDownload
    })
    return {
      pdfGenerated: true,
      pdf_generated: true,
      path: finalPath,
      download
    }
  } catch (error) {
    runtime.log(`[browser-runtime] print-to-pdf fallback: ${error.message || error}`)
    return null
  }
}

module.exports = {
  applyClickDownloadMetadata,
  applyNetworkConfig,
  createDownloadWatcher,
  extensionForMime,
  grantPermissions,
  handlePrintButtonClick,
  har,
  harHeaderValue,
  harSidecarFilename,
  harWithContentMode,
  isPrintRelatedElement,
  networkConfig,
  networkSessionIds,
  normalizeHTTPHeaders,
  pathExists,
  prepareHarForSave,
  safeDownloadFilename,
  saveHar,
  setNetworkConfig,
  startScreencast,
  stopScreencast,
  uniqueDownloadFilePath
}
