'use strict'

class BrowserSessionProjector {
  constructor({
    emit,
    getFavicon,
    getFaviconPending,
    getLoadFailed,
    getRuntime,
    getView,
    log,
    sessions,
    syncThrottling
  } = {}) {
    this._emit = emit
    this._getFavicon = getFavicon
    this._getFaviconPending = typeof getFaviconPending === 'function' ? getFaviconPending : () => false
    this._getLoadFailed = typeof getLoadFailed === 'function' ? getLoadFailed : () => false
    this._getRuntime = getRuntime
    this._getView = getView
    this._log = typeof log === 'function' ? log : () => undefined
    this._sessions = sessions
    this._syncThrottling = syncThrottling
  }

  tabsState(sessionId) {
    const group = this._sessions.runtimeSnapshot(String(sessionId || ''))
    if (!group) return { active: 0, tabs: [] }
    const tabs = group.tabs.map(tabId => {
      const webContents = this._getView(tabId)?.webContents
      const meta = group.tabMeta[tabId]
      const faviconPending = this._getFaviconPending(String(sessionId || ''), tabId) === true
      const loadFailed = this._getLoadFailed(String(sessionId || ''), tabId) === true
      return {
        tabId,
        title: webContents?.getTitle?.() || meta?.title || '',
        url: webContents?.getURL?.() || meta?.url || '',
        favicon: this._getFavicon(tabId) || meta?.favicon || '',
        ...(faviconPending ? { faviconPending: true } : {}),
        ...(loadFailed ? { loadFailed: true } : {})
      }
    })
    return { active: group.active, tabs }
  }

  emit(sessionId, extra = {}) {
    const key = String(sessionId || '')
    if (!this._sessions.hasSession(key)) return
    this._emit('tabs.state', { id: key, ...this.tabsState(key), ...extra })
  }

  sync(sessionId, extra = {}) {
    const key = String(sessionId || '')
    const snapshot = this._sessions.runtimeSnapshot(key)
    try {
      this._getRuntime()?.syncSessionTabs(key, snapshot)
    } catch (error) {
      this._log(`runtime topology projection failed for ${key}: ${error?.message || error}`)
    }

    // Tab topology is product state and must never wait for a page-injected
    // visual effect. Runtime updates the logical control lease synchronously;
    // the operating frame reconciles independently in the background.
    try {
      if (snapshot) this.emit(key, extra)
    } catch (error) {
      this._log(`renderer topology projection failed for ${key}: ${error?.message || error}`)
    }
    try {
      this._syncThrottling(key)
    } catch (error) {
      this._log(`throttling projection failed for ${key}: ${error?.message || error}`)
    }
    return snapshot
  }
}

module.exports = { BrowserSessionProjector }
