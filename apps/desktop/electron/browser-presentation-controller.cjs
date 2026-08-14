'use strict'

function isBlankUrl(url) {
  return !url || String(url) === 'about:blank'
}

function normalizeLoadFailure(error) {
  if (error && typeof error === 'object') {
    const numericCode = Number(error.code)
    return {
      code: error.code !== null && error.code !== undefined && Number.isFinite(numericCode) ? numericCode : null,
      description: String(error.description || 'ERR_FAILED'),
      url: String(error.url || '')
    }
  }
  return {
    code: null,
    description: String(error || 'ERR_FAILED'),
    url: ''
  }
}

// Owns only the native surface reveal boundary. Navigation correctness belongs
// to Chromium; Agent command cancellation belongs to BrowserNavigationController.
// A load can therefore never hide a document that has already painted.
class BrowserPresentationController {
  constructor({ getActiveTabId, onChange } = {}) {
    this._sessions = new Map()
    this._getActiveTabId = typeof getActiveTabId === 'function' ? getActiveTabId : () => null
    this._onChange = typeof onChange === 'function' ? onChange : () => undefined
  }

  _session(workbenchId) {
    const id = String(workbenchId || '')
    if (!id) return null
    let session = this._sessions.get(id)
    if (!session) {
      session = { primaryVisible: false, rect: null, tabs: new Map(), workbenchId: id }
      this._sessions.set(id, session)
    }
    return session
  }

  _tab(session, tabId, { allowBlankReady = false, documentRevision = 0, epoch = 0, url = '' } = {}) {
    const id = String(tabId || '')
    if (!id) return null
    let tab = session.tabs.get(id)
    if (!tab) {
      tab = {
        allowBlankReady: Boolean(allowBlankReady),
        documentRevision: Math.max(0, Number(documentRevision) || 0),
        epoch: Number(epoch) || 0,
        failedNavigationEpoch: null,
        failure: null,
        hasUsableDocument: false,
        loading: !isBlankUrl(url),
        navigationEpoch: 0,
        suspended: false,
        url: String(url || '')
      }
      session.tabs.set(id, tab)
    }
    return tab
  }

  _active(session) {
    if (!session) return null
    const tabId = String(this._getActiveTabId(session.workbenchId) || '')
    const tab = session.tabs.get(tabId)
    return tab ? { tab, tabId } : null
  }

  _phase(tab) {
    if (!tab) return 'blank'
    if (tab.suspended) return 'suspended'
    // A main-frame navigation failure is the current tab state even when an
    // older document had painted before it. Leaving that native surface visible
    // hides the raw Chromium error behind the previous page (or a white internal
    // error document). The next real navigation clears the failure latch and
    // may reveal the prior document again while Chromium loads the retry.
    if (tab.failure) return 'failed'
    if (tab.loading) return tab.hasUsableDocument ? 'loading' : 'preparing'
    if (tab.hasUsableDocument) return 'ready'
    return 'blank'
  }

  _snapshot(workbenchId) {
    const id = String(workbenchId || '')
    const session = this._sessions.get(id)
    const active = this._active(session)
    if (!session || !active) {
      return {
        activeTabId: null,
        committedUrl: '',
        documentRevision: 0,
        error: null,
        id,
        navigationEpoch: 0,
        nativeVisible: false,
        phase: session ? 'blank' : 'blank',
        viewEpoch: 0,
        workbenchId: id
      }
    }

    const { tab, tabId } = active
    return {
      activeTabId: tabId,
      committedUrl: tab.url,
      documentRevision: tab.documentRevision,
      error: tab.failure,
      id: session.workbenchId,
      navigationEpoch: tab.navigationEpoch,
      // Loading is deliberately absent from this condition. Once Chromium has
      // painted a document, later navigations keep that page visible while the
      // top progress bar reports activity.
      nativeVisible: Boolean(
        session.primaryVisible &&
        tab.hasUsableDocument &&
        !tab.suspended &&
        !tab.failure
      ),
      phase: this._phase(tab),
      viewEpoch: tab.epoch,
      workbenchId: session.workbenchId
    }
  }

  _publish(workbenchId) {
    this._onChange(this._snapshot(workbenchId))
  }

  _mutate({ workbenchId, tabId, epoch }, mutate) {
    const session = this._sessions.get(String(workbenchId || ''))
    const tab = session?.tabs.get(String(tabId || ''))
    if (!session || !tab || (epoch != null && tab.epoch !== Number(epoch))) return null
    if (mutate(tab) === false) return null
    this._publish(session.workbenchId)
    return this._snapshot(session.workbenchId)
  }

  registerTab({ workbenchId, tabId, allowBlankReady = false, documentRevision = 0, epoch = 0, url = '' }) {
    const session = this._session(workbenchId)
    if (!session) return null
    this._tab(session, tabId, { allowBlankReady, documentRevision, epoch, url })
    this._publish(session.workbenchId)
    return this._snapshot(session.workbenchId)
  }

  replaceTabView({ workbenchId, tabId, allowBlankReady = false, documentRevision = 0, epoch, url = '' }) {
    const session = this._session(workbenchId)
    if (!session) return null
    const tab = this._tab(session, tabId)
    Object.assign(tab, {
      allowBlankReady: Boolean(allowBlankReady),
      documentRevision: Math.max(0, Number(documentRevision) || 0),
      epoch: Number(epoch) || tab.epoch + 1,
      failedNavigationEpoch: null,
      failure: null,
      hasUsableDocument: false,
      loading: !isBlankUrl(url),
      navigationEpoch: 0,
      suspended: false,
      url: String(url || '')
    })
    this._publish(session.workbenchId)
    return this._snapshot(session.workbenchId)
  }

  unregisterTab({ workbenchId, tabId }) {
    const session = this._sessions.get(String(workbenchId || ''))
    if (!session) return
    session.tabs.delete(String(tabId || ''))
    this._publish(session.workbenchId)
  }

  destroyWorkbench(workbenchId) {
    const id = String(workbenchId || '')
    if (!this._sessions.delete(id)) return
    this._onChange({
      activeTabId: null,
      committedUrl: '',
      documentRevision: 0,
      error: null,
      id,
      navigationEpoch: 0,
      nativeVisible: false,
      phase: 'destroyed',
      viewEpoch: 0,
      workbenchId: id
    })
  }

  hideAllPrimarySurfaces() {
    for (const session of this._sessions.values()) {
      if (!session.primaryVisible) continue
      session.primaryVisible = false
      this._publish(session.workbenchId)
    }
  }

  setPrimarySurface({ workbenchId, rect, visible }) {
    const session = this._session(workbenchId)
    if (!session) return null
    if (visible !== undefined) session.primaryVisible = Boolean(visible)
    if (rect !== undefined) session.rect = rect || null
    this._publish(session.workbenchId)
    return this._snapshot(session.workbenchId)
  }

  refreshActiveTab({ workbenchId, tabId }) {
    const session = this._sessions.get(String(workbenchId || ''))
    if (!session || !session.tabs.has(String(tabId || ''))) return null
    this._publish(session.workbenchId)
    return this._snapshot(session.workbenchId)
  }

  markLoading(payload) {
    return this._mutate(payload, tab => {
      const suppliedEpoch = Number(payload.navigationEpoch)
      const hasSuppliedEpoch = Number.isFinite(suppliedEpoch)
      const nextNavigationEpoch = hasSuppliedEpoch ? suppliedEpoch : tab.navigationEpoch + 1
      if (nextNavigationEpoch < tab.navigationEpoch) return false
      if (nextNavigationEpoch > tab.navigationEpoch) {
        tab.navigationEpoch = nextNavigationEpoch
        tab.failedNavigationEpoch = null
        tab.failure = null
      }
      tab.loading = true
      tab.suspended = false
    })
  }

  beginNavigation({ navigationEpoch, ...payload }) {
    return this._mutate(payload, tab => {
      const suppliedEpoch = Number(navigationEpoch)
      const nextNavigationEpoch = Number.isFinite(suppliedEpoch) ? suppliedEpoch : tab.navigationEpoch + 1
      if (nextNavigationEpoch <= tab.navigationEpoch) return false
      tab.navigationEpoch = nextNavigationEpoch
      tab.failedNavigationEpoch = null
      tab.failure = null
      tab.loading = true
      tab.suspended = false
    })
  }

  markCommitted({ url = '', documentRevision, ...payload }) {
    return this._mutate(payload, tab => {
      if (
        Number.isFinite(Number(payload.navigationEpoch)) &&
        Number(payload.navigationEpoch) !== tab.navigationEpoch
      ) {
        return false
      }
      if (tab.failure && tab.failedNavigationEpoch === tab.navigationEpoch) return false
      tab.url = String(url || tab.url || '')
      if (Number.isFinite(Number(documentRevision))) tab.documentRevision = Number(documentRevision)
      tab.failure = null
      tab.failedNavigationEpoch = null
      // A cross-document commit destroys the previously painted compositor
      // frame. Keep the old page visible until this boundary, then revoke the
      // new document's presentation eligibility until Main's compositor fence
      // confirms a frame. Treating the old document as permanently usable here
      // exposes Chromium's empty replacement surface as a long white pane.
      tab.hasUsableDocument = false
      tab.suspended = false
    })
  }

  markInPage({ url = '', ...payload }) {
    return this._mutate(payload, tab => {
      if (tab.failure && tab.failedNavigationEpoch === tab.navigationEpoch) return false
      tab.url = String(url || tab.url || '')
      tab.failure = null
      tab.failedNavigationEpoch = null
      tab.hasUsableDocument = tab.hasUsableDocument || !isBlankUrl(tab.url) || tab.allowBlankReady
      tab.suspended = false
    })
  }

  markReady({ url = '', documentRevision, ...payload }) {
    return this._mutate(payload, tab => {
      if (
        Number.isFinite(Number(payload.navigationEpoch)) &&
        Number(payload.navigationEpoch) !== tab.navigationEpoch
      ) {
        return false
      }
      if (
        Number.isFinite(Number(documentRevision)) &&
        Number(documentRevision) < tab.documentRevision
      ) {
        return false
      }
      // Chromium creates an internal error document after did-fail-load. That
      // document still emits dom-ready/did-finish-load, but it is not a usable
      // replacement page. Keep the exact load failure latched until a later
      // top-level navigation advances the navigation epoch.
      if (tab.failure && tab.failedNavigationEpoch === tab.navigationEpoch) return false
      tab.url = String(url || tab.url || '')
      if (Number.isFinite(Number(documentRevision))) tab.documentRevision = Number(documentRevision)
      tab.failure = null
      tab.failedNavigationEpoch = null
      tab.hasUsableDocument = !isBlankUrl(tab.url) || tab.allowBlankReady
      tab.loading = false
      tab.suspended = false
    })
  }

  markStopped(payload) {
    return this._mutate(payload, tab => {
      tab.loading = false
    })
  }

  markFailed({ error = 'ERR_FAILED', ...payload }) {
    return this._mutate(payload, tab => {
      const suppliedEpoch = Number(payload.navigationEpoch)
      if (Number.isFinite(suppliedEpoch) && suppliedEpoch !== tab.navigationEpoch) return false
      // loadURL() rejects after did-fail-load. Preserve the first, event-level
      // failure because it carries Electron's unmodified description/code/url.
      if (!(tab.failure && tab.failedNavigationEpoch === tab.navigationEpoch)) {
        tab.failure = normalizeLoadFailure(error)
        tab.failedNavigationEpoch = tab.navigationEpoch
      }
      tab.loading = false
    })
  }

  adoptReadyDocument({ workbenchId, tabId, url = '', epoch, documentRevision = 1 }) {
    return this.markReady({ workbenchId, tabId, url, epoch, documentRevision })
  }

  suspendTab({ workbenchId, tabId }) {
    return this._mutate({ workbenchId, tabId }, tab => {
      tab.failure = null
      tab.failedNavigationEpoch = null
      tab.hasUsableDocument = false
      tab.loading = false
      tab.suspended = true
    })
  }

  snapshot(workbenchId) {
    return this._snapshot(workbenchId)
  }

  surfaceRect(workbenchId) {
    return this._sessions.get(String(workbenchId || ''))?.rect || null
  }

  tabSnapshot(workbenchId, tabId) {
    const session = this._sessions.get(String(workbenchId || ''))
    const tab = session?.tabs.get(String(tabId || ''))
    if (!session || !tab) return null
    return {
      committedUrl: tab.url,
      documentRevision: tab.documentRevision,
      epoch: tab.epoch,
      error: tab.failure,
      hasUsableDocument: tab.hasUsableDocument,
      loading: tab.loading,
      navigationEpoch: tab.navigationEpoch,
      phase: this._phase(tab),
      workbenchId: session.workbenchId
    }
  }
}

module.exports = { BrowserPresentationController }
