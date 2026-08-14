'use strict'

function navigationError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// Agent navigation cancellation boundary.
//
// Normal browser navigation never goes through this controller. Chromium owns
// omnibox loads, link clicks, history, redirects and script navigation. This
// controller only prevents an Agent command from publishing a result after a
// newer Agent command, a user intervention, or a View replacement.
class BrowserNavigationController {
  constructor({ getView, getViewEpoch, sessions } = {}) {
    if (typeof getView !== 'function') throw new TypeError('getView is required')
    if (typeof getViewEpoch !== 'function') throw new TypeError('getViewEpoch is required')
    if (!sessions) throw new TypeError('sessions is required')

    this._getView = getView
    this._getViewEpoch = getViewEpoch
    this._sessions = sessions
    this._intentSequence = 0
    this._currentByTab = new Map()
  }

  _validate({ expectedTabId, sessionId, source, tabId, url, webContents }) {
    if (source !== 'agent') {
      throw navigationError('invalid-navigation-source', 'Only Agent commands use the navigation coordinator')
    }
    if (!url) throw navigationError('empty-url', 'Navigation URL is empty')
    if (!this._sessions.tabIds(sessionId).includes(tabId)) {
      throw navigationError('unknown-tab', `Navigation tab is no longer part of session: ${tabId}`)
    }
    if (expectedTabId && String(expectedTabId) !== tabId) {
      throw navigationError('tab-changed', 'The active tab changed before navigation was accepted')
    }
    if (this._sessions.activeTabId(sessionId) !== tabId) {
      throw navigationError('tab-changed', 'The user changed tabs before Agent navigation started')
    }

    const view = this._getView(tabId)
    const currentWebContents = view?.webContents
    if (
      !currentWebContents ||
      currentWebContents.isDestroyed?.() ||
      (webContents && webContents !== currentWebContents)
    ) {
      throw navigationError('view-unavailable', `Navigation view is unavailable: ${tabId}`)
    }
    return { view, webContents: currentWebContents }
  }

  isCurrent(transaction) {
    if (!transaction) return true
    const sessionId = String(transaction.sessionId || '')
    const tabId = String(transaction.tabId || '')
    if (!sessionId || !tabId) return false
    if (this._sessions.sessionInstanceId(sessionId) !== transaction.sessionInstanceId) return false
    if (!this._sessions.tabIds(sessionId).includes(tabId)) return false

    const current = this._currentByTab.get(tabId)
    const view = this._getView(tabId)
    return Boolean(
      current &&
        current.intentId === transaction.intentId &&
        this._sessions.activeTabId(sessionId) === tabId &&
        current.view === view &&
        view?.webContents &&
        !view.webContents.isDestroyed?.() &&
        this._getViewEpoch(tabId) === transaction.viewEpoch
    )
  }

  assertCurrent(transaction) {
    if (this.isCurrent(transaction)) return transaction
    throw navigationError('NAVIGATION_SUPERSEDED', 'Navigation was superseded by a newer command')
  }

  cancelTab(tabId) {
    return this._currentByTab.delete(String(tabId || ''))
  }

  cancelSession(sessionId) {
    const key = String(sessionId || '')
    let cancelled = 0
    for (const [tabId, current] of this._currentByTab) {
      if (current.sessionId === key && this._currentByTab.delete(tabId)) cancelled += 1
    }
    return cancelled
  }

  release(transaction) {
    const tabId = String(transaction?.tabId || '')
    if (!tabId) return false
    const current = this._currentByTab.get(tabId)
    if (!current || current.intentId !== transaction.intentId) return false
    return this._currentByTab.delete(tabId)
  }

  run({
    sessionId,
    tabId,
    webContents,
    url,
    source = 'agent',
    clientRequestId = null,
    expectedTabId = null,
    execute,
    waitForResult = false
  } = {}) {
    const normalized = {
      clientRequestId,
      expectedTabId,
      sessionId: String(sessionId || ''),
      source,
      tabId: String(tabId || ''),
      url: String(url || ''),
      webContents
    }
    if (typeof execute !== 'function') {
      throw navigationError('missing-executor', 'Navigation executor is missing')
    }

    const { view } = this._validate(normalized)
    const intentId = ++this._intentSequence
    const transaction = Object.freeze({
      acceptedAt: Date.now(),
      clientRequestId: clientRequestId == null ? null : clientRequestId,
      intentId,
      requestedUrl: normalized.url,
      sessionId: normalized.sessionId,
      sessionInstanceId: this._sessions.sessionInstanceId(normalized.sessionId),
      source: 'agent',
      tabId: normalized.tabId,
      viewEpoch: this._getViewEpoch(normalized.tabId)
    })
    this._currentByTab.set(normalized.tabId, {
      intentId,
      sessionId: normalized.sessionId,
      view
    })

    let execution
    try {
      execution = execute()
    } catch (error) {
      if (this._currentByTab.get(normalized.tabId)?.intentId === intentId) {
        this._currentByTab.delete(normalized.tabId)
      }
      throw error
    }

    const completion = Promise.resolve(execution).catch(error => {
      if (this._currentByTab.get(normalized.tabId)?.intentId === intentId) {
        this._currentByTab.delete(normalized.tabId)
      }
      throw error
    })
    if (waitForResult) return completion.then(result => ({ result, transaction }))

    void completion.catch(() => undefined)
    return { ...transaction, ok: true }
  }
}

module.exports = { BrowserNavigationController }
