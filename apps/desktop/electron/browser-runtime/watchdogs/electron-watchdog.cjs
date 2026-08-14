const { EVENT_TYPES } = require('../events/event-types.cjs')
const fs = require('node:fs/promises')
const path = require('node:path')
const {
  browserPermissionAllowedByDefault,
  browserPermissionRequiresUserDecision,
  normalizeBrowserPermission
} = require('../../browser-permission-policy.cjs')

// Hard ceiling on retained screencast frames when a caller passes maxFrames<=0
// (which previously meant "unlimited"), so captureFrames can't accrete base64
// PNG frames into an unbounded native-heap leak.
const SCREENCAST_FRAME_HARD_CAP = Math.max(
  1,
  Number(process.env.ELECTRON_BROWSER_SCREENCAST_FRAME_CAP) || 120
)

let downloadIdSequence = 0

function nextDownloadId() {
  downloadIdSequence += 1
  return `download-${Date.now().toString(36)}-${downloadIdSequence.toString(36)}`
}

function normalizeDownloadState(state, phase = '') {
  const value = String(state || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['progressing', 'inprogress', 'in_progress', 'started', 'starting'].includes(value)) {
    return 'in_progress'
  }
  if (['complete', 'completed', 'done'].includes(value)) return 'completed'
  if (['cancel', 'canceled', 'cancelled'].includes(value)) return 'cancelled'
  if (['interrupt', 'interrupted'].includes(value)) return 'interrupted'
  if (['fail', 'failed', 'error'].includes(value)) return 'failed'
  if (phase === 'started' || phase === 'updated') return 'in_progress'
  if (phase === 'done') return 'failed'
  return value || 'in_progress'
}

function setBoundedMap(map, key, value, maxEntries) {
  map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function popupEventDetails(details) {
  if (!details || typeof details !== 'object') return {}
  const safeDetails = { ...details }
  delete safeDetails.postBody
  return safeDetails
}

function permissionEventDetails(details) {
  if (!details || typeof details !== 'object') return {}
  const safe = {}
  for (const key of [
    'requestingUrl',
    'securityOrigin',
    'isMainFrame',
    'externalURL',
    'mediaType',
    'mediaTypes'
  ]) {
    const value = details[key]
    if (value == null) continue
    safe[key] = Array.isArray(value) ? value.map(String) : value
  }
  return safe
}

function normalizePagePopupResponse(result) {
  if (typeof result === 'function') {
    return { action: 'allow', createWindow: result }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  if (result.action === 'deny') return result
  if (result.action === 'allow' && typeof result.createWindow === 'function') return result
  return null
}

const sessionRoutes = new WeakMap()
const windowOpenHandlerOwners = new WeakMap()
const denyWindowOpen = () => ({ action: 'deny' })
const IN_APP_POPUP_PROTOCOLS = new Set(['about:', 'blob:', 'data:', 'file:', 'http:', 'https:'])
const BLOCKED_POPUP_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'javascript:',
  'view-source:'
])

function isExternalApplicationUrl(value) {
  try {
    const protocol = String(new URL(String(value || '')).protocol || '').toLowerCase()
    return Boolean(
      protocol &&
      !IN_APP_POPUP_PROTOCOLS.has(protocol) &&
      !BLOCKED_POPUP_PROTOCOLS.has(protocol)
    )
  } catch {
    return false
  }
}

function sessionRouteTarget(route, webContents) {
  const watchdogs = [...route.watchdogs].filter(watchdog => watchdog.started)
  if (!watchdogs.length) return null

  if (webContents) {
    const runtimes = new Set(watchdogs.map(watchdog => watchdog.runtime).filter(Boolean))
    for (const runtime of runtimes) {
      const workbenches = runtime.workbenches
      if (!workbenches || typeof workbenches.values !== 'function') continue
      for (const entry of workbenches.values()) {
        if (entry?.webContents !== webContents) continue
        const watchdog = watchdogs.find(candidate => candidate === entry.watchdog || candidate.entry === entry)
        if (watchdog) return { entry, watchdog }
      }
    }

    const watchdog = watchdogs.find(candidate => candidate.entry?.webContents === webContents)
    if (watchdog) return { entry: watchdog.entry, watchdog }
    return null
  }

  const watchdog = watchdogs[0]
  return { entry: watchdog.entry, watchdog }
}

function ensureSessionRoute(watchdog, session) {
  let route = sessionRoutes.get(session)
  if (!route) {
    route = {
      downloadInstalled: false,
      onDownload: null,
      permissionInstalled: false,
      session,
      watchdogs: new Set()
    }
    sessionRoutes.set(session, route)
  }

  route.watchdogs.add(watchdog)

  if (!route.downloadInstalled && typeof session.on === 'function') {
    route.onDownload = (_event, item, webContents) => {
      const target = sessionRouteTarget(route, webContents)
      target?.watchdog._handleNativeDownload(item)
    }
    session.on('will-download', route.onDownload)
    route.downloadInstalled = true
  }

  if (!route.permissionInstalled && typeof session.setPermissionRequestHandler === 'function') {
    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const target = sessionRouteTarget(route, webContents)
      if (!target) {
        callback(false)
        return
      }
      target.watchdog._handlePermissionRequest(permission, callback, details)
    })
    if (typeof session.setPermissionCheckHandler === 'function') {
      session.setPermissionCheckHandler((webContents, permission) => {
        const target = sessionRouteTarget(route, webContents)
        return target ? target.watchdog._isPermissionGranted(permission, target.entry) : false
      })
    }
    route.permissionInstalled = true
  }

  watchdog.sessionRoute = route
}

function releaseSessionRoute(watchdog) {
  const route = watchdog.sessionRoute
  watchdog.sessionRoute = null
  if (!route) return
  route.watchdogs.delete(watchdog)
  if (route.watchdogs.size) return

  if (route.downloadInstalled) {
    route.session.removeListener?.('will-download', route.onDownload)
    route.onDownload = null
    route.downloadInstalled = false
  }
  if (route.permissionInstalled) {
    route.session.setPermissionRequestHandler?.(null)
    route.session.setPermissionCheckHandler?.(null)
    route.permissionInstalled = false
  }
}

class ElectronWatchdog {
  constructor({ entry, eventBus, runtime }) {
    this.entry = entry
    this.eventBus = eventBus
    this.runtime = runtime || null
    this.disposers = []
    this.pendingRequests = new Map()
    this.harEntries = new Map()
    this.harPages = new Map()
    this.activeHarEntryKeys = new Map()
    this.harEntryRedirectCounts = new Map()
    this.downloads = []
    this.detectedDownloadUrls = new Set()
    this.downloadedUrlPaths = new Map()
    this.pdfViewerCache = new Map()
    // Keep HAR useful for API/page debugging without making every browser tab
    // a response-body cache. Metadata remains intact; large bodies are marked
    // truncated before CDP transfers them into the main process.
    this.maxHarBodyBytes = Math.max(0, Number(process.env.ELECTRON_BROWSER_HAR_BODY_LIMIT_BYTES) || 262144)
    // Hard cap on retained HAR entries per tab. Each entry holds request meta +
    // up to maxHarBodyBytes of response body, and NOTHING clears this map during
    // a live tab's lifetime (stop() historically omitted it, and views are only
    // hidden, never destroyed) — so an uncapped map is a native-heap leak: a page
    // looping window.open + subresources can accrete tens/hundreds of GB. Evict
    // oldest (FIFO) past the cap; HAR is a debug convenience, not full history.
    this.maxHarEntries = Math.max(1, Number(process.env.ELECTRON_BROWSER_HAR_MAX_ENTRIES) || 100)
    this.maxHarPages = Math.max(1, Number(process.env.ELECTRON_BROWSER_HAR_MAX_PAGES) || 100)
    this.maxDownloadCacheEntries = Math.max(
      1,
      Number(process.env.ELECTRON_BROWSER_DOWNLOAD_CACHE_ENTRIES) || 100
    )
    this.sessionRoute = null
    this.lifecycle = null
    this.downloadItemDisposers = new Set()
    this.pendingPermissionRequests = new Set()
    this.dialogSequence = 0
    this.started = false
  }

  start() {
    if (this.started) return
    this.started = true
    const { id, webContents } = this.entry
    const wc = webContents
    const lifecycle = { entry: this.entry, webContents: wc }
    this.lifecycle = lifecycle
    this.disposers.push(
      this.eventBus.on(EVENT_TYPES.CDP_MESSAGE, event => {
        const payload = event.payload || {}
        if (payload.id !== id) return
        if (payload.method === 'Page.javascriptDialogOpening') {
          const type = payload.params?.type || ''
          const dialog = {
            dialogId: `${id}:dialog:${++this.dialogSequence}`,
            type,
            message: payload.params?.message || '',
            defaultPrompt: payload.params?.defaultPrompt || '',
            url: payload.params?.url || ''
          }
          this.entry.pendingDialog = dialog
          // DLG-3(对齐 _closed_popup_messages):累积最近对话框消息,供 observe 回灌给 agent
          if (!Array.isArray(this.entry.recentDialogs)) this.entry.recentDialogs = []
          this.entry.recentDialogs.push({ type, message: dialog.message })
          if (this.entry.recentDialogs.length > 10) this.entry.recentDialogs.shift()
          const routing = this.runtime?._routeBrowserDialog?.(this.entry, dialog) || {}
          this._emit(EVENT_TYPES.DIALOG_OPENED, {
            dialog,
            agentControlled: routing.agentControlled === true,
            hostRequested: routing.hostRequested === true
          })
        } else if (payload.method === 'Page.javascriptDialogClosed') {
          const dialog = this.entry.pendingDialog || null
          this.entry.pendingDialog = null
          this._emit(EVENT_TYPES.DIALOG_CLOSED, { dialog, result: payload.params || {} })
        } else if (payload.method === 'DOM.documentUpdated') {
          if (this.runtime && typeof this.runtime._clearSelectorMap === 'function') {
            this.runtime._clearSelectorMap(this.entry, 'dom.documentUpdated', { source: 'cdp', method: payload.method })
          } else {
            this.entry.selectorMap?.clear('dom.documentUpdated')
            this._emit(EVENT_TYPES.SELECTOR_INVALIDATED, {
              sessionId: this.entry.sessionId || String(id).split('#')[0],
              tabId: id,
              reason: 'dom.documentUpdated',
              pageChanged: true,
              source: 'cdp',
              method: payload.method
            })
          }
        } else if (payload.method === 'Network.requestWillBeSent') {
          const requestId = payload.params?.requestId
          const request = payload.params?.request || {}
          if (requestId) {
            if (payload.params?.redirectResponse) {
              this._finalizeRedirectHarEntry(requestId, payload.params.redirectResponse, request, payload.params || {})
            }
            const requestInfo = {
              requestId,
              url: request.url || '',
              method: request.method || '',
              headers: request.headers || {},
              postData: request.postData || '',
              frameId: payload.params?.frameId || '',
              loaderId: payload.params?.loaderId || '',
              documentURL: payload.params?.documentURL || '',
              resourceType: payload.params?.type || '',
              timestamp: payload.params?.timestamp || null,
              wallTime: payload.params?.wallTime || null,
              receivedAt: Date.now()
            }
            this._trackHarPageNavigation(payload.params || {}, requestInfo)
            const harEntryKey = this._nextHarEntryKey(requestId)
            this.pendingRequests.set(requestId, requestInfo)
            this.activeHarEntryKeys.set(requestId, harEntryKey)
            // FIFO-bound the pending set: WebSocket/EventSource requests never
            // emit loadingFinished/Failed, so without a cap they (and their
            // companion-map entries) linger for the view's whole life.
            while (this.pendingRequests.size > 2000) {
              const oldestId = this.pendingRequests.keys().next().value
              if (oldestId === undefined) break
              this.pendingRequests.delete(oldestId)
              this.activeHarEntryKeys.delete(oldestId)
              this.harEntryRedirectCounts.delete(oldestId)
            }
            this.harEntries.set(harEntryKey, {
              entryKey: harEntryKey,
              requestId,
              request: requestInfo,
              response: null,
              failed: false,
              finished: false,
              encodedDataLength: 0,
              startedAt: Date.now()
            })
            while (this.harEntries.size > this.maxHarEntries) {
              const oldestKey = this.harEntries.keys().next().value
              if (oldestKey === undefined) break
              this.harEntries.delete(oldestKey)
            }
          }
          this._emit(EVENT_TYPES.NETWORK_REQUEST_STARTED, {
            requestId,
            url: request.url || '',
            method: request.method || '',
            resourceType: payload.params?.type || ''
          })
        } else if (payload.method === 'Network.responseReceived') {
          const requestId = payload.params?.requestId
          const response = payload.params?.response || {}
          const harEntry = requestId ? this._activeHarEntry(requestId) : null
          if (harEntry) {
            harEntry.response = this._harResponseFromCdp(response, payload.params || {}, harEntry)
          }
          this._handleDownloadableResponse(payload.params || {}, payload.sessionId).catch(error => {
            this._emitDownloadFailure({
              url: response.url || '',
              error: error?.message || String(error)
            })
          })
        } else if (payload.method === 'Network.dataReceived') {
          this._appendHarData(payload.params || {})
        } else if (payload.method === 'Network.loadingFinished') {
          const requestId = payload.params?.requestId
          const request = requestId ? this.pendingRequests.get(requestId) : null
          const harEntry = requestId ? this._activeHarEntry(requestId) : null
          if (requestId) {
            this.pendingRequests.delete(requestId)
            // Companion maps are per-request bookkeeping; a finished request
            // never redirects again, and body capture below gets entryKey
            // directly. Without these deletes both maps grew for the view's
            // whole life (~4MB/hour on a busy SPA).
            this.activeHarEntryKeys.delete(requestId)
            this.harEntryRedirectCounts.delete(requestId)
          }
          if (harEntry) {
            harEntry.finished = true
            harEntry.encodedDataLength = payload.params?.encodedDataLength || 0
            harEntry.finishedAt = Date.now()
            harEntry.timestampFinished = payload.params?.timestamp || null
            this._captureHarBody(requestId, payload.sessionId, harEntry.entryKey)
          }
          this._emit(EVENT_TYPES.NETWORK_REQUEST_FINISHED, {
            requestId,
            request,
            encodedDataLength: payload.params?.encodedDataLength || 0
          })
        } else if (payload.method === 'Network.loadingFailed') {
          const requestId = payload.params?.requestId
          const request = requestId ? this.pendingRequests.get(requestId) : null
          const harEntry = requestId ? this._activeHarEntry(requestId) : null
          if (requestId) {
            this.pendingRequests.delete(requestId)
            this.activeHarEntryKeys.delete(requestId)
            this.harEntryRedirectCounts.delete(requestId)
          }
          if (harEntry) {
            harEntry.failed = true
            harEntry.errorText = payload.params?.errorText || ''
            harEntry.blockedReason = payload.params?.blockedReason || ''
            harEntry.canceled = Boolean(payload.params?.canceled)
            harEntry.finishedAt = Date.now()
            harEntry.timestampFinished = payload.params?.timestamp || null
          }
          this._emit(EVENT_TYPES.NETWORK_REQUEST_FAILED, {
            requestId,
            request,
            errorText: payload.params?.errorText || '',
            blockedReason: payload.params?.blockedReason || '',
            canceled: Boolean(payload.params?.canceled)
          })
        } else if (payload.method === 'Security.securityStateChanged') {
          this._emit(EVENT_TYPES.SECURITY_STATE_CHANGED, {
            securityState: payload.params?.securityState || '',
            explanations: payload.params?.explanations || [],
            schemeIsCryptographic: Boolean(payload.params?.schemeIsCryptographic)
          })
        } else if (payload.method === 'Page.lifecycleEvent') {
          this._updateHarPageLifecycle(payload.params || {})
        } else if (payload.method === 'Page.frameNavigated') {
          const frame = payload.params?.frame || {}
          // An OOPIF's root frame also has no parentId, but its events arrive on
          // an attached CDP session. Only the root debugger session can commit
          // the workbench's authoritative top-level document identity.
          if (!payload.sessionId && !frame.parentId) {
            this.runtime?._commitDocumentState?.(this.entry, frame)
            this._resetDocumentPermissions('document-committed')
          }
          this._updateHarPageTitle(frame)
          this._emitAboutBlank(frame.url, {
            id,
            frameId: frame.id || '',
            isMainFrame: !frame.parentId,
            source: 'cdp'
          })
          if (!frame.parentId) {
            this._enforceUrlPolicy(frame.url, { source: 'cdp-frame-navigated', sessionId: payload.sessionId })
            this._handlePdfViewerNavigation(frame.url, payload.sessionId).catch(error => {
              this._emitDownloadFailure({
                url: frame.url || '',
                error: error?.message || String(error)
              })
            })
          }
        } else if (payload.method === 'Page.screencastFrame') {
          this._handleScreencastFrame(payload.params || {}, payload.sessionId)
        }
      })
    )

    this._on(wc, 'did-start-navigation', (_event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) {
        this.entry.selectorMap?.clear('navigation.started')
        // A main-frame failure is terminal for exactly one cross-document
        // navigation. A new intent clears it; readiness events from Chromium's
        // internal error page must not do so.
        if (!isInPlace && !String(url || '').toLowerCase().startsWith('chrome-error://')) {
          this.entry.mainFrameNavigationFailure = null
          this._resetDocumentPermissions('navigation')
        }
      }
      this._emit(EVENT_TYPES.NAVIGATION_STARTED, {
        url,
        isInPlace,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        source: 'electron'
      })
      this._emitAboutBlank(url, { id, isMainFrame, frameProcessId, frameRoutingId, source: 'electron' })
    })
    this._on(wc, 'did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
      this.entry.selectorMap?.clear('navigation.completed')
      const statusCode = Number(httpResponseCode)
      const serverFailure = Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599
      if (serverFailure) {
        const statusText = String(httpStatusText || '').trim()
        const errorDescription = `HTTP ERROR ${statusCode}${statusText ? `: ${statusText}` : ''}`
        this.entry.mainFrameNavigationFailure = Object.freeze({
          httpStatusCode: statusCode,
          errorDescription,
          validatedUrl: String(url || ''),
          failedAt: Date.now()
        })
        this._emit(EVENT_TYPES.NAVIGATION_FAILED, {
          httpResponseCode: statusCode,
          httpStatusText: statusText,
          errorDescription,
          url,
          isMainFrame: true,
          source: 'electron-http'
        })
        this._emitAboutBlank(url, { id, isMainFrame: true, httpResponseCode: statusCode, httpStatusText, source: 'electron' })
        this._enforceUrlPolicy(url, { source: 'electron-did-navigate' })
        return
      }
      this._emit(EVENT_TYPES.NAVIGATION_COMPLETED, {
        url,
        httpResponseCode,
        httpStatusText,
        source: 'electron'
      })
      this._emitAboutBlank(url, { id, isMainFrame: true, httpResponseCode, httpStatusText, source: 'electron' })
      this._enforceUrlPolicy(url, { source: 'electron-did-navigate' })
      this._handlePdfViewerNavigation(url).catch(error => {
        this._emitDownloadFailure({ url: url || '', error: error?.message || String(error) })
      })
    })
    this._on(wc, 'did-navigate-in-page', (_event, url, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) this.entry.selectorMap?.clear('navigation.in-page')
      this._emit(EVENT_TYPES.NAVIGATION_COMPLETED, {
        url,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        inPage: true,
        source: 'electron'
      })
      this._emitAboutBlank(url, { id, isMainFrame, frameProcessId, frameRoutingId, inPage: true, source: 'electron' })
      if (isMainFrame) {
        this._enforceUrlPolicy(url, { source: 'electron-did-navigate-in-page' })
        this._handlePdfViewerNavigation(url).catch(error => {
          this._emitDownloadFailure({ url: url || '', error: error?.message || String(error) })
        })
      }
    })
    this._on(wc, 'did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const numericErrorCode = Number(errorCode)
      const description = String(errorDescription || '')
      const aborted = numericErrorCode === -3 || /(?:^|\b)ERR_ABORTED(?:\b|$)/i.test(description)
      if (isMainFrame && !aborted) {
        this.entry.mainFrameNavigationFailure = Object.freeze({
          ...(Number.isFinite(numericErrorCode) ? { networkErrorCode: numericErrorCode } : {}),
          errorDescription: description || 'Navigation failed',
          validatedUrl: String(validatedURL || ''),
          failedAt: Date.now()
        })
      }
      this._emit(EVENT_TYPES.NAVIGATION_FAILED, {
        errorCode,
        errorDescription,
        url: validatedURL,
        isMainFrame,
        source: 'electron'
      })
    })
    this._on(wc, 'render-process-gone', (_event, details) => {
      this._emit(EVENT_TYPES.RENDER_PROCESS_GONE, { details: details || {} })
    })
    this._on(wc, 'unresponsive', () => {
      this._emit(EVENT_TYPES.RENDER_PROCESS_UNRESPONSIVE)
    })
    this._on(wc, 'responsive', () => {
      this._emit(EVENT_TYPES.RENDER_PROCESS_RESPONSIVE)
    })

    this._on(wc, 'did-create-window', (window, details) => {
      this._emit(EVENT_TYPES.POPUP_REQUESTED, {
        details: popupEventDetails(details),
        windowId: window?.id || null
      })
    })

    if (typeof wc.setWindowOpenHandler === 'function') {
      const windowOpenHandler = details => {
        if (!this._isLifecycleActive(lifecycle)) return denyWindowOpen()
        // TAB-07:兜底默认 'new-tab'(对齐 runtime.cjs 注册默认 + BU 的"后台真新标签"行为);
        // 原 'same-workbench' 与注册默认不一致,window.open/target=_blank 在未显式设 policy 时会被
        // 错误地导到当前标签而非开新标签。三态(allow/new-tab/same-workbench)保留。
        const policy = this.entry.popupPolicy || 'new-tab'
        this._emit(EVENT_TYPES.POPUP_REQUESTED, {
          details: popupEventDetails(details),
          policy,
          source: 'window-open-handler'
        })
        // External application protocols (mailto:, tel:, wxwork:, custom app
        // links, …) have no web host and therefore fail the normal URL-domain
        // policy before Main can ask the user. Let the host broker see them;
        // it always denies the popup itself and opens the app only after an
        // explicit Browser Shell response. Unsafe/internal schemes still pass
        // through the normal policy and remain blocked.
        const externalApplication = isExternalApplicationUrl(details?.url)
        const decision =
          details?.url && !externalApplication
            ? this.runtime?.urlPolicyDecision?.(this.entry, details.url)
            : null
        if (decision && !decision.allowed) {
          this._emit(EVENT_TYPES.NAVIGATION_FAILED, {
            url: details?.url || '',
            errorDescription: `Popup URL blocked by URL policy: ${decision.reason}`,
            reason: decision.reason,
            source: 'popup-policy'
          })
          this._emit(EVENT_TYPES.POPUP_HANDLED, {
            url: details?.url || '',
            action: 'blocked-by-url-policy'
          })
          return { action: 'deny' }
        }
        if (policy === 'allow') return { action: 'allow' }
        if (policy === 'new-tab') {
          let response = null
          let fallbackReason = 'popup-callback-unavailable'
          if (typeof this.runtime?.createPagePopup === 'function') {
            try {
              response = normalizePagePopupResponse(this.runtime.createPagePopup({
                details,
                openerWebContents: wc,
                sessionId: this.entry.sessionId || String(id).split('#')[0],
                sourceTabId: id
              }))
              fallbackReason = response ? '' : 'popup-callback-invalid'
            } catch {
              fallbackReason = 'popup-callback-failed'
            }
          }
          if (response) {
            this._emit(EVENT_TYPES.POPUP_HANDLED, {
              url: details?.url || '',
              action: response.action === 'allow' ? 'open-new-tab' : 'deny'
            })
            return response
          }
          this._emit(EVENT_TYPES.POPUP_HANDLED, {
            url: details?.url || '',
            action: 'deny',
            reason: fallbackReason
          })
          return { action: 'deny' }
        }
        if (policy === 'same-workbench' && details?.url) {
          Promise.resolve(this.runtime.navigate(id, details.url)).catch(error => {
            this._emit(EVENT_TYPES.NAVIGATION_FAILED, {
              url: details.url,
              errorDescription: error?.message || String(error),
              source: 'popup-policy'
            })
          })
          this._emit(EVENT_TYPES.POPUP_HANDLED, {
            url: details.url,
            action: 'navigate-current-workbench'
          })
        } else {
          this._emit(EVENT_TYPES.POPUP_HANDLED, {
            url: details?.url || '',
            action: 'deny'
          })
        }
        return { action: 'deny' }
      }
      const owner = { entry: lifecycle.entry, handler: windowOpenHandler, watchdog: this }
      wc.setWindowOpenHandler(windowOpenHandler)
      windowOpenHandlerOwners.set(wc, owner)
      this.disposers.push(() => {
        if (windowOpenHandlerOwners.get(wc) !== owner) return
        windowOpenHandlerOwners.delete(wc)
        try {
          // Electron has no removeWindowOpenHandler API. Replace the closure
          // with a shared deny handler so the stopped entry can be collected.
          wc.setWindowOpenHandler(denyWindowOpen)
        } catch {
          // best effort cleanup
        }
      })
    }

    const sess = wc.session
    if (sess) ensureSessionRoute(this, sess)
  }

  stop() {
    this.started = false
    this.lifecycle = null
    releaseSessionRoute(this)
    for (const dispose of [...this.downloadItemDisposers]) {
      try {
        dispose()
      } catch {
        // best effort cleanup
      }
    }
    this.downloadItemDisposers.clear()
    for (const deny of [...this.pendingPermissionRequests]) deny('watchdog-stopped')
    this.pendingPermissionRequests.clear()
    this.pendingRequests.clear()
    this.harEntries.clear()
    this.activeHarEntryKeys.clear()
    this.harEntryRedirectCounts.clear()
    this.harPages.clear()
    this.detectedDownloadUrls.clear()
    this.downloadedUrlPaths.clear()
    this.pdfViewerCache.clear()
    this.downloads.length = 0
    if (this.entry.screencast) {
      this.entry.screencast.active = false
      this.entry.screencast.frames = []
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // best effort cleanup
      }
    }
  }

  _on(emitter, event, handler) {
    emitter.on(event, handler)
    this.disposers.push(() => emitter.removeListener(event, handler))
  }

  _emit(type, payload = {}) {
    const tabId = String(this.entry?.id || payload.id || '')
    const sessionId = String(this.entry?.sessionId || tabId.split('#')[0] || tabId)
    return this.eventBus.emit(type, {
      ...payload,
      id: String(payload.id || tabId),
      sessionId,
      workbenchId: sessionId,
      tabId
    })
  }

  _isLifecycleActive(lifecycle) {
    if (!this.started || !lifecycle || this.lifecycle !== lifecycle) return false
    const { entry, webContents } = lifecycle
    if (this.entry !== entry || entry?.webContents !== webContents) return false
    const current = this.runtime?.workbenches?.get?.(entry.id)
    return !current || (current === entry && current.webContents === webContents)
  }

  _enforceUrlPolicy(url, context = {}) {
    const decision = this.runtime?.urlPolicyDecision?.(this.entry, url)
    if (!decision || decision.allowed) return false
    this._emit(EVENT_TYPES.NAVIGATION_FAILED, {
      url: url || '',
      errorDescription: `Navigation blocked by URL policy: ${decision.reason}`,
      reason: decision.reason,
      source: context.source || 'url-policy'
    })
    this.entry.client
      ?.send?.('Page.navigate', { url: 'about:blank' }, context.sessionId)
      .catch(() => undefined)
    return true
  }

  _isNoisyPendingRequest(request, loadingDurationMs) {
    const url = String(request.url || '')
    const resourceType = String(request.resourceType || '').toLowerCase()
    const adDomains = [
      'doubleclick.net',
      'googlesyndication.com',
      'googletagmanager.com',
      'facebook.net',
      'analytics',
      'ads',
      'tracking',
      'pixel',
      'hotjar.com',
      'clarity.ms',
      'mixpanel.com',
      'segment.com',
      'demdex.net',
      'omtrdc.net',
      'adobedtm.com',
      'ensighten.com',
      'newrelic.com',
      'nr-data.net',
      'google-analytics.com',
      'connect.facebook.net',
      'platform.twitter.com',
      'platform.linkedin.com',
      '.cloudfront.net/image/',
      '.akamaized.net/image/',
      '/tracker/',
      '/collector/',
      '/beacon/',
      '/telemetry/',
      '/log/',
      '/events/',
      '/eventBatch',
      '/track.',
      '/metrics/'
    ]
    if (adDomains.some(domain => url.includes(domain))) return true
    if (url.startsWith('data:') || url.length > 500) return true
    if (loadingDurationMs > 10000) return true
    if (['img', 'image', 'icon', 'font'].includes(resourceType) && loadingDurationMs > 3000) return true
    if (/\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i.test(url) && loadingDurationMs > 3000) return true
    return false
  }

  pendingNetworkRequests(limit = 20) {
    const limitValue = Number(limit)
    const max = Math.max(0, Math.min(100, Number.isFinite(limitValue) ? limitValue : 20))
    const now = Date.now()
    return Array.from(this.pendingRequests.values())
      .map(request => {
        const loadingDurationMs = Math.round(Math.max(0, now - Number(request.receivedAt || now)))
        return {
          url: request.url || '',
          method: request.method || 'GET',
          loadingDurationMs,
          loading_duration_ms: loadingDurationMs,
          resourceType: request.resourceType || null,
          resource_type: request.resourceType || null,
          requestId: request.requestId || '',
          frameId: request.frameId || ''
        }
      })
      .filter(request => !this._isNoisyPendingRequest(request, request.loadingDurationMs))
      .slice(0, max)
  }

  harSnapshot(options = {}) {
    const mode = String(options.mode || 'full').toLowerCase()
    const entries = Array.from(this.harEntries.values()).filter(entry => this._includeHarEntry(entry, mode)).map(entry => {
      const request = entry.request || {}
      const response = entry.response || {}
      const started = this._harStartedDateTime(entry)
      const requestHeaders = this._headersList(request.headers)
      const responseHeaders = this._headersList(response.headers)
      const httpVersion = this._harHttpVersion(response.protocol)
      const contentSize = entry.responseBodySize || entry.encodedDataLength || -1
      const content = {
        size: contentSize,
        mimeType: response.mimeType || '',
        ...(entry.responseBodyText != null ? { text: entry.responseBodyText } : {}),
        ...(entry.responseBodyBase64 ? { encoding: 'base64' } : {}),
        ...(entry.responseBodyTruncated ? { _truncated: true } : {})
      }
      const compression = this._harCompression(response.headers, entry.encodedDataLength)
      if (compression != null && contentSize > 0) content.compression = compression
      const harEntry = {
        startedDateTime: started,
        time: this._harTotalTime(entry),
        request: {
          method: request.method || 'GET',
          url: request.url || response.url || '',
          httpVersion,
          headers: requestHeaders,
          queryString: [],
          cookies: [],
          headersSize: this._harHeadersSize(request.method || 'GET', request.url || response.url || '', requestHeaders),
          bodySize: this._harRequestBodySize(request),
          postData: request.postData
            ? { mimeType: this._harHeaderValue(request.headers, 'content-type') || '', text: String(request.postData) }
            : null
        },
        response: {
          status: response.status || (entry.failed ? 0 : 200),
          statusText: response.statusText || (entry.failed ? entry.errorText || 'Failed' : ''),
          httpVersion,
          headers: responseHeaders,
          cookies: [],
          content,
          redirectURL: entry.redirectURL || '',
          headersSize: this._harHeadersSize(null, null, responseHeaders),
          bodySize: entry.encodedDataLength || -1,
          ...(entry.encodedDataLength ? { _transferSize: entry.encodedDataLength } : {})
        },
        cache: {},
        timings: this._harTimings(entry),
        pageref: request.frameId ? `page@${request.frameId}` : undefined,
        _failed: Boolean(entry.failed),
        ...(entry.errorText ? { _errorText: entry.errorText } : {}),
        ...(entry.blockedReason ? { _blockedReason: entry.blockedReason } : {}),
        ...(entry.canceled != null ? { _canceled: Boolean(entry.canceled) } : {}),
        ...(entry.redirected ? { _redirected: true } : {}),
        _resourceType: response.resourceType || request.resourceType || ''
      }
      if (response.remoteIPAddress) harEntry.serverIPAddress = response.remoteIPAddress
      if (response.remotePort != null) harEntry._serverPort = response.remotePort
      const securityDetails = this._harSecurityDetails(response.securityDetails)
      if (securityDetails) harEntry._securityDetails = securityDetails
      return {
        ...harEntry
      }
    })
    return {
      log: {
        version: '1.2',
        creator: { name: 'electron-browser-runtime', version: '0.1' },
        pages: this._harPagesSnapshot(),
        entries
      }
    }
  }

  _includeHarEntry(entry = {}, mode = 'full') {
    const request = entry.request || {}
    const response = entry.response || {}
    const url = String(request.url || response.url || '')
    if (!/^https:\/\//i.test(url)) return false
    if (url.toLowerCase().includes('/favicon.ico')) return false
    if (mode !== 'minimal') return true
    const frameId = String(request.frameId || '')
    const page = frameId ? this.harPages.get(frameId) : null
    if (!page?.url) return false
    return this._harOrigin(url) === this._harOrigin(page.url)
  }

  _harOrigin(url = '') {
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}`
    } catch {
      return ''
    }
  }

  _trackHarPageNavigation(params = {}, request = {}) {
    if (String(request.resourceType || params.type || '') !== 'Document') return
    if (params.isSameDocument === true) return
    const frameId = String(request.frameId || params.frameId || '')
    const url = String(request.url || params.request?.url || '')
    if (!frameId || !url) return
    const existing = this.harPages.get(frameId)
    if (!existing) {
      setBoundedMap(this.harPages, frameId, {
        frameId,
        url,
        title: url,
        startedDateTime: request.wallTime || null,
        monotonicStart: request.timestamp || null,
        onContentLoad: null,
        onLoad: null
      }, this.maxHarPages)
      return
    }
    const wallTime = Number(request.wallTime)
    const existingWallTime = Number(existing.startedDateTime)
    if (Number.isFinite(wallTime) && (!Number.isFinite(existingWallTime) || wallTime < existingWallTime)) {
      existing.startedDateTime = request.wallTime
      existing.monotonicStart = request.timestamp || existing.monotonicStart || null
    }
  }

  _updateHarPageLifecycle(params = {}) {
    const frameId = String(params.frameId || '')
    const page = frameId ? this.harPages.get(frameId) : null
    if (!page) return
    const timestamp = Number(params.timestamp)
    const monotonicStart = Number(page.monotonicStart)
    if (!Number.isFinite(timestamp) || !Number.isFinite(monotonicStart) || timestamp < monotonicStart) return
    const elapsedMs = Math.max(0, Math.round((timestamp - monotonicStart) * 1000))
    if (params.name === 'DOMContentLoaded') page.onContentLoad = elapsedMs
    if (params.name === 'load') page.onLoad = elapsedMs
  }

  _updateHarPageTitle(frame = {}) {
    const frameId = String(frame.id || '')
    const page = frameId ? this.harPages.get(frameId) : null
    if (!page) return
    const title = frame.name || frame.url || page.url
    if (title) page.title = String(title)
  }

  _harPagesSnapshot() {
    return Array.from(this.harPages.entries()).map(([frameId, page]) => {
      const timings = {}
      if (page.onContentLoad != null) timings.onContentLoad = page.onContentLoad
      if (page.onLoad != null) timings.onLoad = page.onLoad
      return {
        id: `page@${frameId}`,
        title: page.title || page.url || '',
        startedDateTime: this._harPageStartedDateTime(page),
        pageTimings: timings
      }
    })
  }

  _harPageStartedDateTime(page = {}) {
    const wallTime = Number(page.startedDateTime)
    if (!Number.isFinite(wallTime) || wallTime <= 0) return ''
    return new Date(wallTime * 1000).toISOString()
  }

  _emitAboutBlank(url, payload = {}) {
    if (String(url || '').trim().toLowerCase() !== 'about:blank') return
    this._emit(EVENT_TYPES.ABOUT_BLANK_DETECTED, {
      ...payload,
      url: 'about:blank'
    })
  }

  _headersList(headers = {}) {
    if (!headers || typeof headers !== 'object') return []
    return Object.entries(headers).map(([name, value]) => ({
      name,
      value: Array.isArray(value) ? value.join(', ') : String(value)
    }))
  }

  _harHeaderValue(headers = {}, name = '') {
    if (!headers || typeof headers !== 'object') return ''
    const target = String(name || '').toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === target) {
        return Array.isArray(value) ? value.join(', ') : String(value)
      }
    }
    return ''
  }

  _nextHarEntryKey(requestId) {
    const count = this.harEntryRedirectCounts.get(requestId) || 0
    this.harEntryRedirectCounts.set(requestId, count + 1)
    return count === 0 ? requestId : `${requestId}:redirect-${count}`
  }

  _activeHarEntry(requestId) {
    const key = this.activeHarEntryKeys.get(requestId) || requestId
    return this.harEntries.get(key) || null
  }

  _harResponseFromCdp(response = {}, params = {}, harEntry = {}) {
    return {
      url: response.url || harEntry.request?.url || '',
      status: response.status || 0,
      statusText: response.statusText || '',
      headers: response.headers || {},
      mimeType: response.mimeType || '',
      protocol: response.protocol || '',
      remoteIPAddress: response.remoteIPAddress || '',
      remotePort: response.remotePort || null,
      securityDetails: response.securityDetails || null,
      timestamp: params.timestamp || null,
      resourceType: params.type || harEntry.request?.resourceType || ''
    }
  }

  _appendHarData(params = {}) {
    const requestId = params.requestId
    const harEntry = requestId ? this._activeHarEntry(requestId) : null
    if (!harEntry) return
    const encodedLength = Number(params.encodedDataLength)
    if (Number.isFinite(encodedLength) && encodedLength > 0) {
      harEntry.encodedDataLength = Number(harEntry.encodedDataLength || 0) + encodedLength
    }
    const data = params.data
    if (typeof data !== 'string' || data.length === 0) return
    const previous = harEntry.responseBodyText || ''
    const next = previous + data
    const byteLength = Buffer.byteLength(next, 'latin1')
    if (this.maxHarBodyBytes && byteLength > this.maxHarBodyBytes) {
      harEntry.responseBodyTruncated = true
      return
    }
    harEntry.responseBodyText = next
    harEntry.responseBodyBase64 = false
    harEntry.responseBodySize = byteLength
    harEntry.partialResponseBody = true
  }

  _finalizeRedirectHarEntry(requestId, redirectResponse = {}, nextRequest = {}, params = {}) {
    const harEntry = this._activeHarEntry(requestId)
    if (!harEntry) return
    harEntry.response = this._harResponseFromCdp(redirectResponse, params, harEntry)
    harEntry.redirectURL = nextRequest.url || redirectResponse.headers?.location || redirectResponse.headers?.Location || ''
    harEntry.redirected = true
    harEntry.finished = true
    harEntry.finishedAt = Date.now()
    harEntry.timestampFinished = params.timestamp || harEntry.response?.timestamp || null
    const encodedDataLength = Number(redirectResponse.encodedDataLength)
    if (Number.isFinite(encodedDataLength)) harEntry.encodedDataLength = encodedDataLength
  }

  _harStartedDateTime(entry) {
    const wallTime = Number(entry.request?.wallTime)
    if (Number.isFinite(wallTime) && wallTime > 0) return new Date(wallTime * 1000).toISOString()
    return entry.startedAt ? new Date(entry.startedAt).toISOString() : new Date().toISOString()
  }

  _harHttpVersion(protocol) {
    const value = String(protocol || '').toLowerCase()
    if (value === 'h2' || value.startsWith('http/2')) return 'HTTP/2.0'
    if (value.startsWith('http/1.0')) return 'HTTP/1.0'
    if (value.startsWith('http/1.1')) return 'HTTP/1.1'
    return protocol ? String(protocol).toUpperCase() : 'HTTP/1.1'
  }

  _harTotalTime(entry) {
    const requestTs = Number(entry.request?.timestamp)
    const finishedTs = Number(entry.timestampFinished)
    if (Number.isFinite(requestTs) && Number.isFinite(finishedTs) && finishedTs >= requestTs) {
      return Math.round((finishedTs - requestTs) * 1000)
    }
    return Math.max(0, Number(entry.finishedAt || Date.now()) - Number(entry.startedAt || Date.now()))
  }

  _harTimings(entry) {
    const requestTs = Number(entry.request?.timestamp)
    const responseTs = Number(entry.response?.timestamp)
    const finishedTs = Number(entry.timestampFinished)
    return {
      send: 0,
      wait: Number.isFinite(requestTs) && Number.isFinite(responseTs) && responseTs >= requestTs ? Math.round((responseTs - requestTs) * 1000) : -1,
      receive: Number.isFinite(responseTs) && Number.isFinite(finishedTs) && finishedTs >= responseTs ? Math.round((finishedTs - responseTs) * 1000) : -1
    }
  }

  _harHeadersSize(method, url, headers = []) {
    try {
      let size = 0
      if (method && url) size += Buffer.byteLength(`${method} ${url} HTTP/1.1\r\n`, 'latin1')
      for (const header of headers) {
        size += Buffer.byteLength(`${header.name || ''}: ${header.value || ''}\r\n`, 'latin1')
      }
      return size + 2
    } catch {
      return -1
    }
  }

  _harRequestBodySize(request = {}) {
    const contentLength = request.headers?.['content-length'] ?? request.headers?.['Content-Length']
    const numeric = Number(contentLength)
    if (Number.isFinite(numeric)) return numeric
    if (request.postData) return Buffer.byteLength(String(request.postData), 'utf8')
    if (String(request.method || '').toUpperCase() === 'GET' || String(request.method || '').toUpperCase() === 'HEAD') return 0
    return -1
  }

  _harCompression(headers = {}, encodedDataLength) {
    const contentLength = Number(headers?.['content-length'] ?? headers?.['Content-Length'])
    const encoded = Number(encodedDataLength)
    if (!Number.isFinite(contentLength) || !Number.isFinite(encoded)) return null
    return Math.max(0, contentLength - encoded)
  }

  _harSecurityDetails(details = null) {
    if (!details || typeof details !== 'object') return null
    const keys = ['protocol', 'subjectName', 'issuer', 'validFrom', 'validTo']
    const output = {}
    for (const key of keys) {
      if (details[key] != null) output[key] = details[key]
    }
    return Object.keys(output).length ? output : null
  }

  _captureHarBody(requestId, sessionId, entryKey = null) {
    if (!requestId || !this.maxHarBodyBytes || !this.entry.client?.send) return
    const harEntry = entryKey ? this.harEntries.get(entryKey) : this._activeHarEntry(requestId)
    if (!harEntry) return
    const contentLength = Number(
      harEntry.response?.headers?.['content-length'] ?? harEntry.response?.headers?.['Content-Length']
    )
    const transferLength = Number(harEntry.encodedDataLength)
    if (
      (Number.isFinite(contentLength) && contentLength > this.maxHarBodyBytes) ||
      (Number.isFinite(transferLength) && transferLength > this.maxHarBodyBytes)
    ) {
      harEntry.responseBodyTruncated = true
      return
    }
    this.entry.client
      .send('Network.getResponseBody', { requestId }, sessionId)
      .then(body => {
        const harEntry = entryKey ? this.harEntries.get(entryKey) : this._activeHarEntry(requestId)
        if (!harEntry || !body || body.body == null) return
        const raw = String(body.body)
        const base64Encoded = Boolean(body.base64Encoded)
        const byteLength = base64Encoded ? Buffer.byteLength(raw, 'base64') : Buffer.byteLength(raw, 'utf8')
        if (byteLength > this.maxHarBodyBytes) {
          harEntry.responseBodyTruncated = true
          return
        }
        harEntry.responseBodyText = raw
        harEntry.responseBodyBase64 = base64Encoded
        harEntry.responseBodySize = byteLength
      })
      .catch(error => {
        const harEntry = entryKey ? this.harEntries.get(entryKey) : this._activeHarEntry(requestId)
        if (harEntry) harEntry.responseBodyError = error?.message || String(error)
      })
  }

  _handleScreencastFrame(params = {}, sessionId) {
    const screencast = this.entry.screencast
    if (!screencast?.active) return
    const frame = {
      sessionId,
      frameSessionId: params.sessionId,
      metadata: params.metadata || {},
      receivedAt: Date.now()
    }
    if (screencast.captureFrames) frame.data = params.data || ''
    // maxFrames<=0 used to mean "unlimited" — fall back to a hard ceiling so the
    // frame buffer (base64 PNGs when captureFrames is on) can't grow without bound.
    const requestedCap = screencast.maxFrames > 0 ? screencast.maxFrames : SCREENCAST_FRAME_HARD_CAP
    const frameCap = Math.min(requestedCap, SCREENCAST_FRAME_HARD_CAP)
    if (screencast.frames.length < frameCap) {
      screencast.frames.push(frame)
    }
    this.eventBus.emit(EVENT_TYPES.SCREENCAST_FRAME, {
      id: this.entry.id,
      sessionId,
      frameSessionId: params.sessionId,
      metadata: params.metadata || {},
      frameCount: screencast.frames.length
    })
    if (params.sessionId != null && this.entry.client?.send) {
      this.entry.client
        .send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId)
        .catch(() => undefined)
    }
  }

  _handlePermissionRequest(permission, callback, details = {}) {
    const normalizedPermission = normalizeBrowserPermission(permission)
    const safeDetails = permissionEventDetails(details)
    const preauthorized = this._isPermissionGranted(normalizedPermission)
    this._emit(EVENT_TYPES.PERMISSION_REQUESTED, {
      permission: normalizedPermission,
      details: safeDetails,
      allowed: preauthorized,
      pending: !preauthorized
    })

    let settled = false
    let timer = null
    let denyPending = null
    const finish = (decision, source = 'host') => {
      if (settled) return false
      settled = true
      if (timer) clearTimeout(timer)
      if (denyPending) this.pendingPermissionRequests.delete(denyPending)
      const allowed = decision === true || (
        decision &&
        typeof decision === 'object' &&
        (
          decision.allow === true ||
          decision.allowed === true ||
          String(decision.action || '').toLowerCase() === 'allow'
        )
      )
      if (allowed) {
        if (!this.entry.permissionPolicy) this.entry.permissionPolicy = { granted: new Set() }
        if (!(this.entry.permissionPolicy.granted instanceof Set)) {
          this.entry.permissionPolicy.granted = new Set()
        }
        this.entry.permissionPolicy.granted.add(normalizedPermission)
      }
      try {
        callback(allowed)
      } catch {
        // Electron owns the callback; a consumer exception must not reopen this
        // exact-once permission decision or strand other shared-session routes.
      }
      this._emit(EVENT_TYPES.PERMISSION_RESOLVED, {
        permission: normalizedPermission,
        allowed,
        source
      })
      return true
    }

    if (preauthorized) {
      finish(true, 'preauthorized')
      return
    }

    denyPending = source => finish(false, source)
    this.pendingPermissionRequests.add(denyPending)
    const timeoutMs = Math.max(1000, Number(this.runtime?.permissionRequestTimeoutMs) || 30000)
    timer = setTimeout(() => finish(false, 'timeout'), timeoutMs)
    timer.unref?.()
    let routed = false
    try {
      routed = this.runtime?._routePermissionRequest?.(this.entry, {
        permission: normalizedPermission,
        details: safeDetails,
        respond: decision => finish(decision, 'host')
      }) === true
    } catch {
      routed = false
    }
    if (!routed) finish(false, 'default-deny')
  }

  _resetDocumentPermissions(source = 'navigation') {
    for (const deny of [...this.pendingPermissionRequests]) deny(source)
    this.pendingPermissionRequests.clear()
    if (!this.entry.permissionPolicy) this.entry.permissionPolicy = {}
    this.entry.permissionPolicy.granted = new Set(['clipboard-sanitized-write'])
  }

  _isPermissionGranted(permission, entry = this.entry) {
    const normalizedPermission = normalizeBrowserPermission(permission)
    if (!normalizedPermission) return false
    if (browserPermissionAllowedByDefault(normalizedPermission)) return true
    if (!browserPermissionRequiresUserDecision(normalizedPermission)) return false
    const granted = entry?.permissionPolicy?.granted
    if (!granted || typeof granted.has !== 'function') return false
    // Sensitive permissions must be granted explicitly for this document. A
    // wildcard or an Agent policy update must never bypass the user prompt.
    return granted.has(normalizedPermission)
  }

  _emitDownloadFailure(download = {}) {
    const downloadId = String(download.downloadId || nextDownloadId())
    const failedDownload = { ...download, downloadId, state: 'failed' }
    this._recordDownload('done', failedDownload, 'failed')
    this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
      downloadId,
      state: 'failed',
      done: true,
      download: failedDownload
    })
  }

  _handleNativeDownload(item) {
    const lifecycle = this.lifecycle
    if (!this._isLifecycleActive(lifecycle)) return
    // Save synchronously so Electron never opens a native Save As dialog.
    try {
      const fsSync = require('fs')
      const dir = this._downloadsPath()
      fsSync.mkdirSync(dir, { recursive: true })
      const parsed = path.parse(item.getFilename() || 'download')
      let candidate = path.join(dir, parsed.base)
      let counter = 1
      while (fsSync.existsSync(candidate)) candidate = path.join(dir, `${parsed.name} (${counter++})${parsed.ext}`)
      item.setSavePath(candidate)
    } catch {
      // Best effort; failure falls back to Electron's default behavior.
    }
    const downloadId = nextDownloadId()
    const startedState = normalizeDownloadState('', 'started')
    const download = this._downloadInfo(item, { downloadId, state: startedState })
    const record = this._recordDownload('started', download, startedState)
    this._emit(EVENT_TYPES.DOWNLOAD_STARTED, { downloadId, state: startedState, download })
    const onUpdated = (_event, nativeState) => {
      if (!this._isLifecycleActive(lifecycle)) {
        dispose()
        return
      }
      const state = normalizeDownloadState(nativeState, 'updated')
      const updated = this._downloadInfo(item, { downloadId, state })
      this._recordDownload('updated', updated, state, record.key, nativeState)
      this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, { downloadId, state, nativeState, download: updated })
    }
    const onDone = (_event, nativeState) => {
      dispose()
      if (!this._isLifecycleActive(lifecycle)) return
      const state = normalizeDownloadState(nativeState, 'done')
      const done = this._downloadInfo(item, { downloadId, state })
      this._recordDownload('done', done, state, record.key, nativeState)
      this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
        downloadId,
        state,
        nativeState,
        download: done,
        done: true
      })
    }
    const dispose = () => {
      item.removeListener('updated', onUpdated)
      item.removeListener('done', onDone)
      this.downloadItemDisposers.delete(dispose)
    }
    item.on('updated', onUpdated)
    item.on('done', onDone)
    this.downloadItemDisposers.add(dispose)
  }

  // settle/networkIdle only considers requests which can still make the current
  // document materially less ready. The main frame id survives cross-document
  // navigation, so its loader id is the discriminator that prevents a stream
  // left by the previous document from pinning the new page's idle gate. Child
  // frames keep their own loader ids and remain eligible because they may belong
  // to the current page. Requests without enough identity remain eligible (fail
  // safe) and age/noise filtering below eventually prevents an indefinite wait.
  _pendingRequestBelongsToCurrentDocument(request = {}) {
    const current = this.entry?.documentState || {}
    const currentFrameId = String(current.frameId || '')
    const currentLoaderId = String(current.loaderId || '')
    const requestFrameId = String(request.frameId || '')
    const requestLoaderId = String(request.loaderId || '')
    if (!currentFrameId || !currentLoaderId || !requestFrameId || !requestLoaderId) return true
    if (requestFrameId !== currentFrameId) return true
    return requestLoaderId === currentLoaderId
  }

  // The full pendingRequests map remains intact for HAR/network diagnostics;
  // only the readiness projection filters persistent, stale and noisy work.
  pendingSettleCount() {
    const persistent = new Set(['websocket', 'eventsource'])
    const now = Date.now()
    let count = 0
    for (const info of this.pendingRequests.values()) {
      if (persistent.has(String(info && info.resourceType || '').toLowerCase())) continue
      if (!this._pendingRequestBelongsToCurrentDocument(info)) continue
      const loadingDurationMs = Math.max(0, now - Number(info?.receivedAt || now))
      if (this._isNoisyPendingRequest(info || {}, loadingDurationMs)) continue
      count++
    }
    return count
  }

  _downloadsPath() {
    return path.resolve(String(this.entry.downloadsPath || process.env.ELECTRON_BROWSER_DOWNLOADS_PATH || path.join(process.cwd(), 'downloads')))
  }

  _autoDownloadEnabled() {
    return this.entry.autoDownloadPdfs !== false && process.env.ELECTRON_BROWSER_AUTO_DOWNLOAD_PDFS !== '0'
  }

  _normalizedHeaders(headers = {}) {
    const normalized = {}
    if (!headers || typeof headers !== 'object') return normalized
    for (const [name, value] of Object.entries(headers)) {
      normalized[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
    }
    return normalized
  }

  _isUnwantedDownloadType(contentType, url) {
    const unwantedTypes = [
      'image/',
      'video/',
      'audio/',
      'text/css',
      'text/javascript',
      'application/javascript',
      'application/x-javascript',
      'text/html',
      'application/json',
      'font/',
      'application/font',
      'application/x-font'
    ]
    if (unwantedTypes.some(prefix => contentType.startsWith(prefix))) return true
    const lowerUrl = String(url || '').toLowerCase().split('?')[0]
    return [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.webp',
      '.svg',
      '.ico',
      '.css',
      '.js',
      '.woff',
      '.woff2',
      '.ttf',
      '.eot',
      '.mp4',
      '.webm',
      '.mp3',
      '.wav',
      '.ogg'
    ].some(ext => lowerUrl.endsWith(ext))
  }

  // DL-3:URL 的 path 是否带"真文件扩展名"(对齐 _NETWORK_DOWNLOAD_FILE_EXTENSIONS)。
  _hasFileExtension(value) {
    let p = String(value || '')
    if (p.includes('://')) { try { p = new URL(p).pathname } catch { /* 保留原值 */ } }
    const ext = path.extname(p).replace(/^\./, '').toLowerCase()
    const KNOWN = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv', 'txt', 'json', 'xml', 'zip', 'gz', 'tar', 'jpg', 'jpeg', 'png', 'gif', 'webp'])
    return ext !== '' && KNOWN.has(ext)
  }

  // DL-3:识别"通用文本附件"——jsonp/接口响应误带 Content-Disposition: attachment 但其实只是
  // text/json 数据、文件名是 f/download/response/data/callback 这类通用名,不该当点击下载。
  // 对齐 _should_auto_download_network_response 的 generic-text-attachment 分支。
  _isGenericTextAttachment(url, contentType, suggestedFilename) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
    const TEXT_MIMES = new Set(['text/plain', 'application/json', 'text/javascript', 'application/javascript'])
    if (!TEXT_MIMES.has(mime)) return false
    if (this._hasFileExtension(url)) return false
    if (!suggestedFilename) return false
    const GENERIC_NAMES = new Set(['f', 'download', 'response', 'data', 'callback'])
    const base = path.basename(String(suggestedFilename)).toLowerCase()
    const ext = path.extname(base).replace(/^\./, '')
    const stem = ext ? base.slice(0, -(ext.length + 1)) : base
    return GENERIC_NAMES.has(stem) && ['', 'txt', 'json'].includes(ext)
  }

  _filenameFromContentDisposition(contentDisposition) {
    const match = String(contentDisposition || '').match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i)
    if (!match) return ''
    return match[1].replace(/^['"]|['"]$/g, '')
  }

  _sanitizeDownloadFilename(value, fallback = 'download') {
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
      .slice(0, 120)
    return normalized && !['.', '..'].includes(normalized) ? normalized : fallback
  }

  _filenameFromUrl(url, contentType = '') {
    try {
      const parsed = new URL(url)
      const base = path.basename(decodeURIComponent(parsed.pathname || ''))
      if (base && base.includes('.')) return this._sanitizeDownloadFilename(base, 'download')
    } catch {
      // Fall back below.
    }
    return contentType.includes('pdf') ? 'document.pdf' : 'download'
  }

  _checkUrlForPdf(url) {
    const lowerUrl = String(url || '').toLowerCase()
    if (!lowerUrl) return false
    if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf')) return true
    return [
      'content-type=application/pdf',
      'content-type=application%2fpdf',
      'mimetype=application/pdf',
      'type=application/pdf'
    ].some(marker => lowerUrl.includes(marker))
  }

  _isChromePdfViewerUrl(url) {
    const lowerUrl = String(url || '').toLowerCase()
    if (!lowerUrl) return false
    return (lowerUrl.includes('chrome-extension://') && lowerUrl.includes('pdf')) || (lowerUrl.startsWith('chrome://') && lowerUrl.includes('pdf'))
  }

  _pdfViewerUrlFromLocation(url) {
    try {
      const parsed = new URL(url)
      for (const key of ['src', 'file', 'url']) {
        const value = parsed.searchParams.get(key)
        if (value) return value
      }
    } catch {
      // Fall back to page evaluation below.
    }
    return ''
  }

  async _resolveChromePdfViewerSourceUrl(url, sessionId) {
    const fromLocation = this._pdfViewerUrlFromLocation(url)
    if (fromLocation) return fromLocation
    if (!this.entry.client?.send || !sessionId) return ''
    try {
      const result = await this.entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const embed = document.querySelector('embed[type="application/x-google-chrome-pdf"], embed[type="application/pdf"]');
          const src = embed ? (embed.src || embed.getAttribute('src') || '') : '';
          const pageUrl = window.location && window.location.href ? window.location.href : '';
          try {
            const parsed = new URL(pageUrl);
            for (const key of ['src', 'file', 'url']) {
              const value = parsed.searchParams.get(key);
              if (value) return { url: value };
            }
          } catch (error) {}
          return { url: src && src !== 'about:blank' ? src : pageUrl };
        })()`,
        returnByValue: true
      }, sessionId)
      return String(result?.result?.value?.url || result?.value?.url || '')
    } catch {
      return ''
    }
  }

  async _pdfViewerCandidate(url, sessionId) {
    if (!this._autoDownloadEnabled()) return null
    const isDirectPdf = this._checkUrlForPdf(url)
    const isChromeViewer = this._isChromePdfViewerUrl(url)
    if (!isDirectPdf && !isChromeViewer) return null
    if (this.pdfViewerCache.get(url) === false) return null
    setBoundedMap(this.pdfViewerCache, url, true, this.maxDownloadCacheEntries)
    const resolvedUrl = isChromeViewer ? await this._resolveChromePdfViewerSourceUrl(url, sessionId) : url
    if (!/^https?:\/\//i.test(resolvedUrl || '')) {
      setBoundedMap(this.pdfViewerCache, url, false, this.maxDownloadCacheEntries)
      return null
    }
    const fileName = this._filenameFromUrl(resolvedUrl, 'application/pdf')
    return {
      url: resolvedUrl,
      viewerUrl: isChromeViewer ? url : '',
      contentType: 'application/pdf',
      fileName: /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`,
      resourceType: 'Document',
      autoDownload: true,
      source: 'pdf-viewer-navigation'
    }
  }

  _downloadCandidate(params = {}) {
    if (!this._autoDownloadEnabled()) return null
    const response = params.response || {}
    const url = String(response.url || '')
    if (!/^https?:\/\//i.test(url)) return null
    if (['Fetch', 'XHR'].includes(String(params.type || ''))) return null

    const headers = this._normalizedHeaders(response.headers || {})
    const contentType = String(response.mimeType || headers['content-type'] || '').toLowerCase()
    const contentDisposition = String(headers['content-disposition'] || '').toLowerCase()
    const isPdf = contentType.includes('application/pdf')
    const isAttachment = contentDisposition.includes('attachment')
    if (!(isPdf || isAttachment)) return null
    if (this._isUnwantedDownloadType(contentType, url)) return null

    const fromHeader = this._filenameFromContentDisposition(headers['content-disposition'])
    // DL-3:非 PDF 且是 generic-text-attachment(jsonp/接口响应误带 attachment)→ 不算下载
    if (!isPdf && this._isGenericTextAttachment(url, contentType, fromHeader)) return null
    const fallback = this._filenameFromUrl(url, contentType)
    return {
      url,
      contentType,
      fileName: this._sanitizeDownloadFilename(fromHeader || fallback, fallback),
      requestId: params.requestId || '',
      resourceType: params.type || '',
      autoDownload: true
    }
  }

  async _pathExists(filePath) {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async _uniqueDownloadPath(fileName) {
    const downloadsPath = this._downloadsPath()
    await fs.mkdir(downloadsPath, { recursive: true })
    const parsed = path.parse(this._sanitizeDownloadFilename(fileName, 'download'))
    let candidate = path.resolve(downloadsPath, `${parsed.name}${parsed.ext}`)
    let relative = path.relative(downloadsPath, candidate)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Refusing to write download outside downloads directory')
    }
    for (let counter = 1; await this._pathExists(candidate); counter += 1) {
      candidate = path.resolve(downloadsPath, `${parsed.name} (${counter})${parsed.ext}`)
      relative = path.relative(downloadsPath, candidate)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Refusing to write download outside downloads directory')
      }
    }
    return candidate
  }

  async _downloadFileFromUrl(candidate, sessionId) {
    if (!this.entry.client?.send) return null
    const result = await this.entry.client.send('Runtime.evaluate', {
      expression: `(() => (async () => {
        const response = await fetch(${JSON.stringify(candidate.url)}, { cache: 'force-cache' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        return { data: bytes, responseSize: bytes.length };
      })())()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId, 15000)  // DL-3:抓取上界 15s(对齐 BU downloads_watchdog timeout=15.0),用 send 第4参超时覆盖
    const value = result?.result?.value || result?.value || {}
    const data = Array.isArray(value.data) ? value.data : []
    if (!data.length) return null
    const finalPath = await this._uniqueDownloadPath(candidate.fileName)
    await fs.writeFile(finalPath, Buffer.from(data))
    return finalPath
  }

  async _saveAutoDownloadCandidate(candidate, sessionId) {
    if (!candidate?.url) return
    const previousPath = this.downloadedUrlPaths.get(candidate.url)
    if (previousPath && await this._pathExists(previousPath)) return
    if (this.detectedDownloadUrls.has(candidate.url)) return
    this.detectedDownloadUrls.add(candidate.url)
    const downloadId = nextDownloadId()
    const startedState = normalizeDownloadState('', 'started')
    const startedDownload = {
      downloadId,
      state: startedState,
      url: candidate.url,
      filename: candidate.fileName,
      mimeType: candidate.contentType,
      autoDownload: true
    }
    const record = this._recordDownload('started', startedDownload, startedState)
    this._emit(EVENT_TYPES.DOWNLOAD_STARTED, {
      downloadId,
      state: startedState,
      download: startedDownload
    })
    try {
      const finalPath = await this._downloadFileFromUrl(candidate, sessionId)
      if (!finalPath) {
        const failedDownload = { ...startedDownload, state: 'failed' }
        this._recordDownload('done', failedDownload, 'failed', record.key)
        this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
          downloadId,
          state: 'failed',
          done: true,
          download: failedDownload
        })
        return
      }
      const stat = await fs.stat(finalPath)
      const ext = path.extname(finalPath).toLowerCase().replace(/^\./, '')
      const download = {
        downloadId,
        state: 'completed',
        url: candidate.url,
        filename: path.basename(finalPath),
        savePath: finalPath,
        receivedBytes: stat.size,
        totalBytes: stat.size,
        fileSize: stat.size,
        fileType: ext || null,
        mimeType: candidate.contentType,
        autoDownload: true
      }
      setBoundedMap(
        this.downloadedUrlPaths,
        candidate.url,
        finalPath,
        this.maxDownloadCacheEntries
      )
      this._recordDownload('done', download, 'completed', record.key)
      this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
        downloadId,
        state: 'completed',
        done: true,
        download
      })
    } catch (error) {
      const failedDownload = {
        ...startedDownload,
        state: 'failed',
        error: error?.message || String(error)
      }
      this._recordDownload('done', failedDownload, 'failed', record.key)
      this._emit(EVENT_TYPES.DOWNLOAD_UPDATED, {
        downloadId,
        state: 'failed',
        done: true,
        download: failedDownload
      })
    } finally {
      this.detectedDownloadUrls.delete(candidate.url)
    }
  }

  async _handleDownloadableResponse(params = {}, sessionId) {
    const candidate = this._downloadCandidate(params)
    await this._saveAutoDownloadCandidate(candidate, sessionId)
  }

  async _handlePdfViewerNavigation(url, sessionId) {
    const candidate = await this._pdfViewerCandidate(url, sessionId)
    await this._saveAutoDownloadCandidate(candidate, sessionId)
  }

  _downloadInfo(item, extra = {}) {
    return {
      url: typeof item.getURL === 'function' ? item.getURL() : '',
      filename: typeof item.getFilename === 'function' ? item.getFilename() : '',
      savePath: typeof item.getSavePath === 'function' ? item.getSavePath() : '',
      receivedBytes: typeof item.getReceivedBytes === 'function' ? item.getReceivedBytes() : 0,
      totalBytes: typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0,
      ...extra
    }
  }

  _downloadKey(download = {}) {
    if (download.downloadId) return String(download.downloadId)
    return [download.url || '', download.filename || '', download.savePath || ''].join('|')
  }

  _recordDownload(phase, download, state = '', preferredKey = '', nativeState = '') {
    const now = Date.now()
    const key = preferredKey || this._downloadKey(download)
    let record = this.downloads.find(item => item.key === key)
    if (!record) {
      record = { key, startedAt: now, updatedAt: now, states: [] }
      this.downloads.push(record)
    }
    record.updatedAt = now
    record.phase = phase
    record.state = state || record.state || ''
    record.download = { ...(record.download || {}), ...(download || {}) }
    record.states.push({
      phase,
      state: state || '',
      ...(nativeState ? { nativeState: String(nativeState) } : {}),
      at: now,
      download: record.download
    })
    if (phase === 'done') record.doneAt = now
    if (this.downloads.length > 100) this.downloads.splice(0, this.downloads.length - 100)
    return record
  }

  downloadsSince(timestamp) {
    const since = Number(timestamp) || 0
    return this.downloads
      .filter(download => Number(download.startedAt || download.updatedAt || 0) >= since || Number(download.updatedAt || 0) >= since)
      .map(download => ({
        startedAt: download.startedAt,
        updatedAt: download.updatedAt,
        doneAt: download.doneAt || null,
        phase: download.phase || '',
        state: download.state || '',
        download: download.download || {},
        states: download.states || []
      }))
  }
}

module.exports = { ElectronWatchdog }
