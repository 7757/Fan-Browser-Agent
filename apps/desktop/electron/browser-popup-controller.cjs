'use strict'

class BrowserPopupController {
  constructor({
    cleanupFailedTabCreation,
    createTabView,
    createView,
    ensureRuntime,
    getView,
    getViewCount,
    isSessionOperating,
    log,
    maxTabsPerSession,
    maxTotalViews,
    onDenied,
    partitionNameFor,
    resourceGovernor,
    sessions,
    setActiveTab,
    syncTopology,
    windowMs = 2000,
    windowOpenLimit = 24
  } = {}) {
    this._cleanupFailedTabCreation = cleanupFailedTabCreation
    this._createTabView = createTabView
    this._createView = createView
    this._ensureRuntime = ensureRuntime
    this._getView = getView
    this._getViewCount = getViewCount
    this._isSessionOperating = isSessionOperating
    this._log = typeof log === 'function' ? log : () => undefined
    this._maxTabsPerSession = maxTabsPerSession
    this._maxTotalViews = maxTotalViews
    this._onDenied = typeof onDenied === 'function' ? onDenied : () => undefined
    this._partitionNameFor = typeof partitionNameFor === 'function'
      ? partitionNameFor
      : sessionId => `persist:fan-browser-${sessionId}`
    this._resourceGovernor = resourceGovernor
    this._sessions = sessions
    this._setActiveTab = setActiveTab
    this._syncTopology = syncTopology
    this._windowMs = windowMs
    this._windowOpenLimit = windowOpenLimit
    this._openTimes = new Map()
    this._warnedAt = new Map()
  }

  clearSession(sessionId) {
    const key = String(sessionId || '')
    this._openTimes.delete(key)
    this._warnedAt.delete(key)
  }

  _isFlooding(sessionId) {
    const key = String(sessionId || '')
    const now = Date.now()
    const times = (this._openTimes.get(key) || []).filter(time => now - time < this._windowMs)
    times.push(now)
    this._openTimes.set(key, times)
    if (times.length <= this._windowOpenLimit) return false

    const warnedAt = this._warnedAt.get(key) || 0
    if (now - warnedAt > 3000) {
      this._log(`window.open flood from session ${key}: ${times.length} in ${this._windowMs}ms - throttling`)
      this._warnedAt.set(key, now)
    }
    return true
  }

  _reportDenied(sessionId, sourceTabId, reason, details = {}) {
    try {
      this._onDenied({
        reason,
        sessionId: String(sessionId || ''),
        sourceTabId: String(sourceTabId || ''),
        ...details
      })
    } catch (error) {
      this._log(`popup denial feedback failed: ${error?.message || error}`)
    }
  }

  create({ details, openerWebContents, sessionId, sourceTabId } = {}) {
    const key = String(sessionId || '')
    const openerId = String(sourceTabId || '')
    const openerView = this._getView(openerId)
    const group = this._sessions.runtimeSnapshot(key)
    if (
      !key ||
      !openerId ||
      !group ||
      !openerView ||
      openerView.webContents !== openerWebContents ||
      openerWebContents?.isDestroyed?.()
    ) {
      this._reportDenied(key, openerId, 'invalid-opener')
      return { action: 'deny' }
    }
    if (this._isFlooding(key)) {
      this._reportDenied(key, openerId, 'popup-flood')
      return { action: 'deny' }
    }
    if (group.tabs.length >= this._maxTabsPerSession) {
      this._reportDenied(key, openerId, 'tab-limit', { limit: this._maxTabsPerSession })
      return { action: 'deny' }
    }

    return {
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          partition: this._partitionNameFor(key),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: !this._isSessionOperating(key)
        }
      },
      createWindow: windowOptions => this._adoptPopup({
        details,
        key,
        openerId,
        openerWebContents,
        windowOptions
      })
    }
  }

  _adoptPopup({ details, key, openerId, openerWebContents, windowOptions }) {
    const currentOpener = this._getView(openerId)
    if (
      currentOpener?.webContents !== openerWebContents ||
      openerWebContents?.isDestroyed?.() ||
      !this._sessions.hasSession(key)
    ) {
      this._reportDenied(key, openerId, 'opener-unavailable')
      throw new Error('Popup opener is no longer available')
    }

    this._resourceGovernor.touch(openerId, 'popup-opened')
    this._resourceGovernor.evictToAdmit()
    if (this._getView(openerId)?.webContents !== openerWebContents || openerWebContents?.isDestroyed?.()) {
      this._log('popup denied: opener was released during admission')
      this._reportDenied(key, openerId, 'opener-released')
      return null
    }
    if (this._getViewCount() >= this._maxTotalViews) {
      this._log(`popup denied: browser view limit reached (${this._maxTotalViews})`)
      this._reportDenied(key, openerId, 'view-limit', { limit: this._maxTotalViews })
      return null
    }

    const transition = this._sessions.appendTab(key, {
      activate: false,
      url: String(details?.url || 'about:blank')
    })
    if (!transition.ok || !transition.tabId) {
      this._log('popup denied: unable to reserve popup tab')
      this._reportDenied(key, openerId, 'tab-reservation-failed')
      return null
    }

    const tabId = transition.tabId
    const sessionInstanceId = this._sessions.sessionInstanceId(key)
    let view = null
    try {
      const suppliedGuest = windowOptions?.webContents
      if (suppliedGuest?.isDestroyed?.()) throw new Error('Popup guest WebContents is unavailable')

      view = this._createView(suppliedGuest, windowOptions?.webPreferences || {})
      const popupWebContents = view.webContents
      this._createTabView(tabId, key, details?.url || 'about:blank', {
        admitted: true,
        allowBlankReady: String(details?.url || '') === 'about:blank',
        loadInitial: false,
        pageOpened: true,
        view
      })
      this._ensureRuntime().registerWorkbench(tabId)
      if (details?.disposition === 'background-tab') {
        this._syncTopology(key, { source: 'page' })
      } else if (!this._setActiveTab(key, tabId, 'page')) {
        throw new Error('Unable to activate popup tab')
      }

      if (!suppliedGuest) this._loadDeferredPopup(popupWebContents, details)
      return popupWebContents
    } catch (error) {
      this._cleanupFailedTabCreation(key, tabId, view, sessionInstanceId)
      this._log(`popup denied: ${error?.message || error}`)
      this._reportDenied(key, openerId, 'creation-failed')
      return null
    }
  }

  _loadDeferredPopup(webContents, details) {
    const postBody = details?.postBody
    const loadOptions = {}
    if (details?.referrer) loadOptions.httpReferrer = details.referrer
    if (Array.isArray(postBody?.data)) {
      loadOptions.postData = postBody.data
      if (postBody.contentType) {
        const boundary = postBody.boundary && !/boundary=/i.test(postBody.contentType)
          ? `; boundary=${postBody.boundary}`
          : ''
        loadOptions.extraHeaders = `Content-Type: ${postBody.contentType}${boundary}`
      }
    }
    void webContents
      .loadURL(String(details?.url || 'about:blank'), loadOptions)
      .catch(error => this._log(`deferred popup load failed: ${error?.message || error}`))
  }
}

module.exports = { BrowserPopupController }
