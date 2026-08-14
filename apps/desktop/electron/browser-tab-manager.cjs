'use strict'

class BrowserTabManager {
  constructor({
    anchorBySession,
    browserViewInitialLoads,
    browserViews,
    createTabView,
    deletedBrowserSessionIds,
    documentRevisionByView,
    destroyOverviewCatcher,
    destroySessionForRestore,
    emit,
    ensureRuntime,
    evictView,
    faviconByView,
    flagSessionIntervention,
    getForegroundSession,
    getNavState,
    getRuntime,
    isSessionOperating,
    lastHostRect,
    lastUrlByView,
    log,
    maxTabsPerSession,
    maxTotalViews,
    overviewTileIds,
    overviewTileRects,
    popupController,
    presentation,
    reapPartition,
    reconcilePresentation,
    recoveringSessions,
    refreshOverviewTile,
    resourceGovernor,
    sessions,
    setForegroundSession,
    syncTopology,
    viewCrashTimes,
    viewEpochById,
    viewLifecycle,
    waitForPartitionReap
  } = {}) {
    if (!sessions) throw new TypeError('sessions is required')
    if (!presentation) throw new TypeError('presentation is required')
    if (!resourceGovernor) throw new TypeError('resourceGovernor is required')
    if (!viewLifecycle) throw new TypeError('viewLifecycle is required')

    this._anchorBySession = anchorBySession
    this._browserViewInitialLoads = browserViewInitialLoads
    this._browserViews = browserViews
    this._createTabView = createTabView
    this._deletedBrowserSessionIds = deletedBrowserSessionIds
    this._documentRevisionByView = documentRevisionByView
    this._destroyOverviewCatcher = destroyOverviewCatcher
    this._destroySessionForRestore =
      typeof destroySessionForRestore === 'function'
        ? destroySessionForRestore
        : sessionId => this.destroyBrowserView(sessionId, false)
    this._emit = emit
    this._ensureRuntime = ensureRuntime
    this._evictView = evictView
    this._faviconByView = faviconByView
    this._flagSessionIntervention = flagSessionIntervention
    this._getForegroundSession = getForegroundSession
    this._getNavState = typeof getNavState === 'function' ? getNavState : () => null
    this._getRuntime = getRuntime
    this._isSessionOperating = isSessionOperating
    this._lastHostRect = lastHostRect
    this._lastUrlByView = lastUrlByView
    this._log = typeof log === 'function' ? log : () => undefined
    this._maxTabsPerSession = maxTabsPerSession
    this._maxTotalViews = maxTotalViews
    this._overviewTileIds = overviewTileIds
    this._overviewTileRects = overviewTileRects
    this._popupController = popupController
    this._presentation = presentation
    this._reapPartition = reapPartition
    this._reconcilePresentation = reconcilePresentation
    this._recoveringSessions = recoveringSessions
    this._resumeLoads = new WeakMap()
    this._refreshOverviewTile = refreshOverviewTile
    this._resourceGovernor = resourceGovernor
    this._sessions = sessions
    this._setForegroundSession = setForegroundSession
    this._syncTopology = syncTopology
    this._viewCrashTimes = viewCrashTimes
    this._viewEpochById = viewEpochById
    this._viewLifecycle = viewLifecycle
    this._waitForPartitionReap = waitForPartitionReap
  }

  _sessionSnapshot(sessionId) {
    return this._sessions.runtimeSnapshot(String(sessionId || ''))
  }

  _liveUrl(view) {
    const webContents = view?.webContents
    if (!webContents || webContents.isDestroyed?.()) return ''
    try {
      return String(webContents.getURL?.() || '').trim()
    } catch {
      return ''
    }
  }

  _isRestorablePageUrl(value) {
    const url = String(value || '').trim()
    return Boolean(url && url !== 'about:blank' && !url.startsWith('chrome-error://'))
  }

  _isPageLoading(webContents) {
    if (!webContents || webContents.isDestroyed?.()) return false
    try {
      return Boolean(webContents.isLoadingMainFrame?.() || webContents.isLoading?.())
    } catch {
      return false
    }
  }

  _resumeRememberedPage(sessionId, tabId, view, preferredUrl = '') {
    const key = String(sessionId)
    const targetId = String(tabId)
    const webContents = view?.webContents
    const requestedUrl = String(preferredUrl || '').trim()
    const hasPreferredPage = this._isRestorablePageUrl(requestedUrl)
    const rememberedUrl =
      hasPreferredPage
        ? requestedUrl
        : String(this._sessions.tabMeta(key, targetId)?.url || '').trim()
    const liveUrl = this._liveUrl(view)
    const ownedResume = this._resumeLoads.get(view)
    const pageLoading = this._isPageLoading(webContents)
    if (
      !webContents ||
      webContents.isDestroyed?.() ||
      !this._isRestorablePageUrl(rememberedUrl) ||
      (hasPreferredPage ? liveUrl === rememberedUrl : this._isRestorablePageUrl(liveUrl)) ||
      (pageLoading && !ownedResume)
    ) {
      return false
    }

    const pendingLoad = ownedResume?.promise || this._browserViewInitialLoads.get(view)
    let resumedLoad
    resumedLoad = Promise.resolve(pendingLoad)
      .catch(() => false)
      .then(() => {
        if (this._browserViews.get(targetId) !== view || webContents.isDestroyed?.()) {
          return false
        }
        const currentUrl = this._liveUrl(view)
        if (
          (hasPreferredPage ? currentUrl === rememberedUrl : this._isRestorablePageUrl(currentUrl)) ||
          this._isPageLoading(webContents)
        ) {
          return false
        }
        if (typeof webContents.loadURL !== 'function') {
          throw new TypeError(`Browser tab ${targetId} cannot restore its remembered URL`)
        }
        return Promise.resolve(webContents.loadURL(rememberedUrl)).then(() => true)
      })
      .catch(error => {
        this._log(`remembered page restore failed for ${targetId}: ${error?.message || error}`)
        return false
      })
      .finally(() => {
        if (this._resumeLoads.get(view)?.promise === resumedLoad) {
          this._resumeLoads.delete(view)
        }
      })
    this._resumeLoads.set(view, { promise: resumedLoad, url: rememberedUrl })
    this._browserViewInitialLoads.set(view, resumedLoad)
    return true
  }

  registerView(tabId, view) {
    const targetId = String(tabId || '')
    if (!targetId || !view) throw new TypeError('tabId and view are required')
    this._browserViews.set(targetId, view)
    return view
  }

  unregisterView(tabId, expectedView = null) {
    const targetId = String(tabId || '')
    if (!targetId) return false
    if (expectedView && this._browserViews.get(targetId) !== expectedView) return false
    return this._browserViews.delete(targetId)
  }

  _clearViewBookkeeping(tabId, { clearDisplayState = true } = {}) {
    const targetId = String(tabId)
    if (clearDisplayState) {
      this._faviconByView.delete(targetId)
    }
    this._resourceGovernor.forget(targetId)
    this._documentRevisionByView?.delete(targetId)
    this._viewEpochById.delete(targetId)
    this._lastUrlByView.delete(targetId)
    this._viewCrashTimes.delete(targetId)
  }

  // A crash-loop tab must never immediately reload the URL that crashed it.
  _recoverCrashLoopTab(sessionId, crashedTabId) {
    const key = String(sessionId)
    const failedId = String(crashedTabId)
    const group = this._sessionSnapshot(key)
    if (!group || !Array.isArray(group.tabs) || !group.tabs.length) return false

    const previousMeta = group.tabMeta?.[failedId]
    this._sessions.patchTabMeta(key, failedId, {
      ...(previousMeta || {}),
      url: 'about:blank',
      title: '',
      favicon: ''
    })
    this._lastUrlByView.delete(failedId)
    this._faviconByView.delete(failedId)

    if (this._sessions.activeTabId(key) !== failedId) {
      this._presentation.suspendTab({ workbenchId: key, tabId: failedId })
      this._syncTopology(key, { source: 'system' })
      this._log(`_recoverCrashLoopTab(${key}): kept inactive failed tab ${failedId} as a lazy placeholder`)
      return true
    }

    const isLive = tabId => {
      const webContents = this._browserViews.get(String(tabId))?.webContents
      return Boolean(webContents && !webContents.isDestroyed?.())
    }
    const currentId = String(group.tabs[group.active] ?? '')
    let survivor = currentId && currentId !== failedId && isLive(currentId) ? currentId : null
    if (!survivor) {
      for (let index = group.tabs.length - 1; index >= 0; index -= 1) {
        const tabId = String(group.tabs[index])
        if (tabId !== failedId && isLive(tabId)) {
          survivor = tabId
          break
        }
      }
    }

    if (survivor) {
      this._log(`_recoverCrashLoopTab(${key}): focusing surviving tab ${survivor}`)
      return this.setActiveTab(key, survivor, 'system')
    }

    this._presentation.suspendTab({ workbenchId: key, tabId: failedId })
    this._syncTopology(key, { source: 'system' })
    this._reconcilePresentation(key)
    this._log(`_recoverCrashLoopTab(${key}): left ${failedId} as a lazy placeholder`)
    return true
  }

  // Recover an active tab after an unexpected, non-crash-loop rebuild failure.
  _recoverActiveTab(sessionId, failedTabId = null) {
    const key = String(sessionId)
    if (this._recoveringSessions.has(key)) return
    this._recoveringSessions.add(key)
    try {
      const group = this._sessionSnapshot(key)
      if (!group || !Array.isArray(group.tabs) || !group.tabs.length) return
      const canonicalActiveId = this._sessions.activeTabId(key)
      if (failedTabId && canonicalActiveId !== String(failedTabId)) return false

      let survivor = null
      for (const tabId of group.tabs) {
        if (String(tabId) === canonicalActiveId) continue
        const view = this._browserViews.get(String(tabId))
        const webContents = view && view.webContents
        if (webContents && typeof webContents.isDestroyed === 'function' && !webContents.isDestroyed()) {
          survivor = String(tabId)
        }
      }
      if (survivor) {
        this._log(`_recoverActiveTab(${key}): focusing surviving tab ${survivor}`)
        this.setActiveTab(key, survivor, 'system')
        return
      }

      const failedId = String(canonicalActiveId || group.tabs[0])
      const rememberedUrl = this._lastUrlByView.get(failedId) || group.tabMeta?.[failedId]?.url || 'about:blank'
      this._log(`_recoverActiveTab(${key}): no survivor, rebuilding ${failedId} at ${rememberedUrl}`)
      const runtime = this._getRuntime()
      if (runtime) runtime.unregisterWorkbench(failedId).catch(() => undefined)
      const failedView = this._browserViews.get(failedId)
      this.unregisterView(failedId, failedView)
      this._viewLifecycle.dispose(failedView)
      const sessionInstanceId = this._sessions.sessionInstanceId(key)
      let rebuiltView = null
      try {
        rebuiltView = this._createTabView(failedId, key, rememberedUrl)
        this._ensureRuntime().registerWorkbench(failedId)
      } catch (error) {
        if (rebuiltView) this.cleanupFailedTabMaterialization(key, failedId, rebuiltView, sessionInstanceId)
        throw error
      }
      this.setActiveTab(key, failedId, 'system')
    } catch (error) {
      this._log(`_recoverActiveTab(${key}) failed: ${error && error.message}`)
    } finally {
      this._recoveringSessions.delete(key)
    }
  }

  ensureTabMaterialized(sessionId, tabId) {
    const key = String(sessionId)
    const targetId = String(tabId)
    const existing = this._browserViews.get(targetId)
    if (existing?.webContents && !existing.webContents.isDestroyed()) {
      this._resumeRememberedPage(key, targetId, existing)
      return true
    }

    const meta = this._sessions.tabMeta(key, targetId)
    if (!meta) return false
    const sessionInstanceId = this._sessions.sessionInstanceId(key)
    let createdView = null
    try {
      createdView = this._createTabView(targetId, key, meta.url || 'about:blank')
      this._ensureRuntime().registerWorkbench(targetId)
      return true
    } catch (error) {
      if (createdView) this.cleanupFailedTabMaterialization(key, targetId, createdView, sessionInstanceId)
      this._log(`materialize failed for ${targetId}: ${error?.message || error}`)
      return false
    }
  }

  cleanupFailedTabMaterialization(sessionId, tabId, suppliedView = null, expectedInstanceId = null) {
    const key = String(sessionId)
    const targetId = String(tabId)
    const registeredView = this._browserViews.get(targetId)
    const view = suppliedView || registeredView

    if (
      (expectedInstanceId != null && this._sessions.sessionInstanceId(key) !== expectedInstanceId) ||
      (suppliedView && registeredView && registeredView !== suppliedView)
    ) {
      this._viewLifecycle.dispose(suppliedView)
      return false
    }

    if (registeredView) this.unregisterView(targetId, view)
    const runtime = this._getRuntime()
    if (runtime) void runtime.unregisterWorkbench(targetId).catch(() => undefined)
    this._faviconByView.delete(targetId)
    this._presentation.unregisterTab({ workbenchId: key, tabId: targetId })
    this._clearViewBookkeeping(targetId, { clearDisplayState: false })
    this._viewLifecycle.dispose(view)
    return true
  }

  cleanupFailedTabCreation(sessionId, tabId, suppliedView = null, expectedInstanceId = null) {
    const key = String(sessionId)
    const targetId = String(tabId)
    const registeredView = this._browserViews.get(targetId)
    const view = suppliedView || registeredView

    if (
      (expectedInstanceId != null && this._sessions.sessionInstanceId(key) !== expectedInstanceId) ||
      (suppliedView && registeredView && registeredView !== suppliedView)
    ) {
      this._viewLifecycle.dispose(suppliedView)
      return false
    }

    // Remove logical ownership before disposal; native destruction callbacks
    // must observe that the failed tab no longer belongs to the session.
    const removed = this._sessions.removeTab(key, targetId)
    if (!removed.ok && removed.reason === 'last-tab') {
      this._sessions.deleteSession(key)
      this._presentation.destroyWorkbench(key)
    }
    this.cleanupFailedTabMaterialization(key, targetId, view, expectedInstanceId)
    this._syncTopology(key, { source: 'system' })
    return true
  }

  setActiveTab(sessionId, tabId, source = 'system') {
    const key = String(sessionId)
    const group = this._sessionSnapshot(key)
    if (!group) return false
    const targetId = String(tabId)
    if (!group.tabs.includes(targetId)) return false
    const outgoingId = String(group.tabs[group.active] ?? '')
    if (!this.ensureTabMaterialized(key, targetId)) return false
    const transition = this._sessions.activateTab(key, targetId)
    if (!transition.ok) return false
    const activeId = transition.activeTabId
    if (outgoingId && outgoingId !== activeId && this._browserViews.has(outgoingId)) {
      this._resourceGovernor.touch(outgoingId, 'tab-deactivated')
    }
    if (this._browserViews.has(activeId)) this._resourceGovernor.touch(activeId, 'tab-activated')

    let userIntervened = false
    if (this._isSessionOperating(key)) {
      if (source === 'agent') {
        this._anchorBySession.set(key, activeId)
      } else if (source === 'user' && transition.changed && this._getRuntime()) {
        userIntervened = this._flagSessionIntervention(key, {
          kind: 'tab',
          anchorTabId: this._anchorBySession.get(key) || outgoingId || null,
          userTabId: activeId
        })
      }
    }

    const isForeground = key === this._getForegroundSession()
    const activeView = this._browserViews.get(activeId)
    this._presentation.refreshActiveTab({ workbenchId: key, tabId: activeId })
    if (isForeground) {
      this._presentation.setPrimarySurface({
        workbenchId: key,
        rect: this._lastHostRect.get(key),
        visible: true
      })
    } else if (this._overviewTileIds.has(key)) {
      this._refreshOverviewTile(key)
    } else if (activeView) {
      this._viewLifecycle.detach(activeView)
    }
    this._syncTopology(key, { source, interventionPending: userIntervened })
    const navState = this._getNavState(key)
    if (navState) this._emit('nav.state', { id: key, ...navState })
    return true
  }

  async addTab(sessionId, url, source = 'system') {
    const key = String(sessionId)
    const group = this._sessionSnapshot(key)
    if (!group) {
      const created = await this.createBrowserView(key, url)
      return created ? String(this._sessions.activeTabId(key) || key) : null
    }
    if (source === 'page' && group.tabs.length >= this._maxTabsPerSession) {
      this._log(`addTab: session ${key} page-initiated window.open rejected at cap (${this._maxTabsPerSession})`)
      return null
    }
    this._resourceGovernor.evictToAdmit()
    if (this._browserViews.size >= this._maxTotalViews) {
      this._log(
        `addTab: refused new tab for ${key} — total live view cap ${this._maxTotalViews} reached (size=${this._browserViews.size})`
      )
      return null
    }
    const transition = this._sessions.appendTab(key, { activate: false, url: String(url || '') })
    if (!transition.ok || !transition.tabId) return null
    const tabId = transition.tabId
    const sessionInstanceId = this._sessions.sessionInstanceId(key)
    let createdView = null
    try {
      createdView = this._createTabView(tabId, key, url, { admitted: true })
      this._ensureRuntime().registerWorkbench(tabId)
      if (!this.setActiveTab(key, tabId, source)) throw new Error(`Unable to activate browser tab ${tabId}`)
      return tabId
    } catch (error) {
      this.cleanupFailedTabCreation(key, tabId, createdView, sessionInstanceId)
      throw error
    }
  }

  async removeTab(sessionId, tabId, options = {}) {
    const key = String(sessionId)
    const group = this._sessionSnapshot(key)
    if (!group) {
      this._log(`[tabdiag] removeTab NO-GROUP key=${key} tabId=${tabId}`)
      return false
    }
    const targetId = String(tabId)
    const index = group.tabs.indexOf(targetId)
    this._log(
      `[tabdiag] removeTab enter key=${key} tabId=${tabId} idx=${index} tabs=[${group.tabs.join(',')}] active=${group.active} len=${group.tabs.length}`
    )
    if (index < 0 || group.tabs.length <= 1) {
      this._log(
        `[tabdiag] removeTab REFUSE tabId=${tabId} idx=${index} len=${group.tabs.length} (idx<0=notInGroup, len<=1=lastTab)`
      )
      return false
    }
    const previousActiveId = String(group.tabs[group.active] || '')
    const remaining = group.tabs.filter(id => id !== targetId)
    const nextActiveId =
      previousActiveId === targetId
        ? String(remaining[Math.min(index, remaining.length - 1)] || '')
        : previousActiveId
    const sourceAlreadyDestroyed = options.sourceAlreadyDestroyed === true
    if (!nextActiveId || (!sourceAlreadyDestroyed && !this.ensureTabMaterialized(key, nextActiveId))) return false
    const transition = this._sessions.removeTab(key, targetId)
    if (!transition.ok) return false

    this._log(`[tabdiag] removeTab removed tabId=${tabId}; active=${transition.activeTabId}; calling setActiveTab`)
    const activated = this.setActiveTab(key, transition.activeTabId)
    const view = this._browserViews.get(targetId)
    const runtime = this._getRuntime()
    const unregisterPromise = runtime
      ? runtime.unregisterWorkbench(targetId).catch(() => undefined)
      : Promise.resolve(false)
    this.unregisterView(targetId, view)
    this._faviconByView.delete(targetId)
    this._presentation.unregisterTab({ workbenchId: key, tabId })
    this._clearViewBookkeeping(targetId, { clearDisplayState: false })
    try {
      this._viewLifecycle.dispose(view)
      await unregisterPromise
    } catch (error) {
      this._log(`removeTab failed: ${error?.message || error}`)
    }
    if (!activated) this._syncTopology(key, { source: 'system' })
    const finalGroup = this._sessionSnapshot(key)
    this._log(
      `[tabdiag] removeTab DONE tabId=${tabId} finalTabs=[${finalGroup?.tabs?.join(',') || ''}] active=${finalGroup?.active ?? 0}`
    )
    return true
  }

  reorderTab(sessionId, tabId, toIndex) {
    const key = String(sessionId)
    const group = this._sessionSnapshot(key)
    if (!group) return false
    const from = group.tabs.indexOf(String(tabId))
    if (from < 0) return false
    const transition = this._sessions.reorderTab(key, String(tabId), toIndex)
    if (!transition.ok) return false
    if (transition.changed) {
      const interventionPending = this._isSessionOperating(key)
        ? this._flagSessionIntervention(key, {
            kind: 'tab',
            anchorTabId: this._anchorBySession.get(key) || this._sessions.activeTabId(key),
            userTabId: this._sessions.activeTabId(key)
          })
        : false
      this._syncTopology(key, { source: 'user', interventionPending })
    }
    return transition.ok
  }

  async restoreTabs(sessionId, state) {
    const key = String(sessionId)
    await this._waitForPartitionReap(key)
    if (this._deletedBrowserSessionIds.has(key)) return false

    let tabs = (state && Array.isArray(state.tabs) ? state.tabs : []).filter(tab => tab && tab.url)
    if (!tabs.length) return false
    const seenUrls = new Set()
    tabs = tabs.filter(tab => {
      if (seenUrls.has(tab.url)) return false
      seenUrls.add(tab.url)
      return true
    })
    if (tabs.length > this._maxTabsPerSession) {
      this._log(
        `restoreTabs: session ${key} had ${tabs.length} persisted tabs — capping to ${this._maxTabsPerSession}`
      )
      tabs = tabs.slice(0, this._maxTabsPerSession)
    }

    const existing = this._sessionSnapshot(key)
    if (existing && existing.tabs && existing.tabs.length > 0) {
      const existingTabIds = existing.tabs.map(String)
      let hasLivePage = false
      let hasLiveNavigation = false
      for (const tabId of existingTabIds) {
        const view = this._browserViews.get(tabId)
        if (this._isPageLoading(view?.webContents)) hasLiveNavigation = true
        const liveUrl = this._liveUrl(view)
        if (!this._isRestorablePageUrl(liveUrl)) continue
        hasLivePage = true
        this._sessions.patchTabMeta(key, tabId, { url: liveUrl })
      }
      const refreshed = this._sessionSnapshot(key)
      const hasRestorableLogicalPage = existingTabIds.some(tabId => {
        return this._isRestorablePageUrl(refreshed?.tabMeta?.[tabId]?.url)
      })
      const hasPersistedPage = tabs.some(tab => {
        return this._isRestorablePageUrl(tab.url)
      })

      // Main deliberately keeps logical tabs while a desktop window is hidden.
      // Prefer that newer in-memory topology whenever it still identifies a
      // real page. Only the all-blank rebuild artifact may be replaced by the
      // durable session snapshot.
      if (hasLivePage || hasLiveNavigation || hasRestorableLogicalPage || !hasPersistedPage) {
        return this.setActiveTab(key, String(existing.tabs[existing.active] ?? existing.tabs[0]))
      }

      // This is a logical/session repair, not user deletion: keep the browser
      // partition (cookies and login state), but remove the blank native and
      // controller state before rebuilding from the durable URLs.
      const oldViews = existingTabIds
        .map(tabId => this._browserViews.get(tabId))
        .filter(Boolean)
      await this._destroySessionForRestore(key)

      let teardownComplete = true
      if (typeof this._viewLifecycle.waitForDisposed === 'function') {
        const disposed = await Promise.all(
          oldViews.map(view => this._viewLifecycle.waitForDisposed(view))
        )
        teardownComplete = disposed.every(Boolean)
      }

      const concurrentSession = this._sessionSnapshot(key)
      if (concurrentSession?.tabs?.length) {
        this._log(`restoreTabs: preserved concurrently recreated session ${key}`)
        return this.setActiveTab(
          key,
          String(concurrentSession.tabs[concurrentSession.active] ?? concurrentSession.tabs[0])
        )
      }
      if (!teardownComplete) {
        this._log(`restoreTabs: blank session teardown did not finish for ${key}`)
        return false
      }
      this._log(`restoreTabs: repaired blank session ${key} from durable state`)
    }

    const activeIndex = Math.min(Math.max(0, Number(state.active) || 0), tabs.length - 1)
    const ids = tabs.map((_tab, index) => (index === 0 ? key : `${key}#t${index}`))
    const restoredTabs = ids.map((id, index) => ({
      id,
      url: tabs[index].url,
      title: tabs[index].title || '',
      favicon: tabs[index].favicon || ''
    }))
    const transition = this._sessions.restoreSession(key, { tabs: restoredTabs, active: activeIndex })
    if (!transition.ok) return false
    const activated = this.setActiveTab(key, ids[activeIndex])
    if (!activated) await this.destroyBrowserView(key, false)
    return activated
  }

  async createBrowserView(id, url) {
    const key = String(id || 'main')
    const requestedUrl = String(url || 'about:blank')
    await this._waitForPartitionReap(key)
    if (this._deletedBrowserSessionIds.has(key)) return null

    const createdSession = !this._sessions.hasSession(key)
    if (createdSession) {
      this._sessions.ensureSession(key, { tabId: key, url: requestedUrl })
    }
    const targetTabId = String(this._sessions.activeTabId(key) || key)
    let view = this._browserViews.get(targetTabId)

    if (!view) {
      this._resourceGovernor.evictToAdmit()
      if (this._browserViews.size >= this._maxTotalViews) {
        this._log(`createBrowserView: refused ${key} — total live view cap ${this._maxTotalViews} reached`)
        return null
      }
    } else if (createdSession && !this._presentation.tabSnapshot(key, targetTabId)) {
      this._presentation.registerTab({ workbenchId: key, tabId: targetTabId, url: requestedUrl })
    }
    const sessionInstanceId = this._sessions.sessionInstanceId(key)

    if (!view) {
      const rememberedUrl = String(this._sessions.tabMeta(key, targetTabId)?.url || '').trim()
      const explicitlyRequestedPage = requestedUrl && requestedUrl !== 'about:blank'
      const materializationUrl =
        !createdSession && !explicitlyRequestedPage && rememberedUrl ? rememberedUrl : requestedUrl
      try {
        view = this._createTabView(targetTabId, key, materializationUrl, { admitted: true })
      } catch (error) {
        if (createdSession) this.cleanupFailedTabCreation(key, targetTabId, null, sessionInstanceId)
        this._log(`createBrowserView(${key}) failed: ${error?.message || error}`)
        return null
      }
    }

    this._resumeRememberedPage(key, targetTabId, view, requestedUrl)
    if (requestedUrl === 'about:blank' && view) {
      const initialLoad = this._browserViewInitialLoads.get(view)
      if (initialLoad) await initialLoad
    }
    if (
      this._sessions.sessionInstanceId(key) !== sessionInstanceId ||
      this._browserViews.get(targetTabId) !== view
    ) {
      return null
    }
    try {
      const runtime = this._ensureRuntime()
      if (this._browserViews.has(targetTabId)) runtime.registerWorkbench(targetTabId)
      this._syncTopology(key, { source: 'system' })
    } catch (error) {
      this._log(`runtime register failed for ${key}: ${error?.message || error}`)
      if (createdSession) this.cleanupFailedTabCreation(key, targetTabId, view, sessionInstanceId)
      else this.cleanupFailedTabMaterialization(key, targetTabId, view, sessionInstanceId)
      return null
    }
    return key
  }

  clearBrowserSessionBookkeeping(sessionId) {
    const key = String(sessionId)
    this._sessions.deleteSession(key)
    this._lastHostRect.delete(key)
    this._popupController.clearSession(key)
    this._anchorBySession.delete(key)
    this._recoveringSessions.delete(key)
    this._overviewTileIds.delete(key)
    this._overviewTileRects.delete(key)
    if (this._getForegroundSession() === key) this._setForegroundSession(null)
    this._destroyOverviewCatcher(key)
    this._presentation.destroyWorkbench(key)
    this._syncTopology(key, { source: 'system' })
    try {
      this._emit('tabs.state', { id: key, active: 0, tabs: [], destroyed: true })
    } catch (error) {
      this._log(`renderer session tombstone failed for ${key}: ${error?.message || error}`)
    }
  }

  async destroyBrowserView(id, reapPartition = false) {
    const key = String(id || 'main')
    if (reapPartition) this._deletedBrowserSessionIds.add(key)
    const group = this._sessionSnapshot(key)
    const tabIds = group ? [...group.tabs] : this._browserViews.has(key) ? [key] : []
    if (!tabIds.length) {
      this.clearBrowserSessionBookkeeping(key)
      if (reapPartition) await this._reapPartition(key)
      return false
    }

    const resources = tabIds.map(tabId => ({
      tabId: String(tabId),
      view: this._browserViews.get(String(tabId))
    }))
    this.clearBrowserSessionBookkeeping(key)
    const unregisterPromises = []
    const runtime = this._getRuntime()
    for (const { tabId, view } of resources) {
      const unregisterPromise = runtime
        ? runtime
            .unregisterWorkbench(tabId)
            .catch(error => this._log(`runtime unregister failed for ${tabId}: ${error?.message || error}`))
        : Promise.resolve(false)
      unregisterPromises.push(unregisterPromise)
      this.unregisterView(tabId, view)
      this._clearViewBookkeeping(tabId)
      try {
        this._viewLifecycle.dispose(view)
      } catch (error) {
        this._log(`destroy failed: ${error?.message || error}`)
      }
    }
    const unregisterAll = Promise.all(unregisterPromises)
    const reapPromise = reapPartition ? this._reapPartition(key, unregisterAll) : null
    await unregisterAll
    if (reapPromise) await reapPromise
    return true
  }

  hibernateBrowserSession(id) {
    const key = String(id || '')
    if (!key) return { count: 0, ok: false }
    if (this._isSessionOperating(key)) {
      return { blocked: 'operating', count: 0, ok: false }
    }

    const group = this._sessionSnapshot(key)
    const tabIds = group ? [...group.tabs] : this._browserViews.has(key) ? [key] : []
    let count = 0
    for (const tabId of tabIds) {
      if (this._evictView(tabId, 'hibernate')) count += 1
    }

    if (this._getForegroundSession() === key) this._setForegroundSession(null)
    this._overviewTileIds.delete(key)
    this._overviewTileRects.delete(key)
    this._destroyOverviewCatcher(key)
    return { count, ok: true }
  }
}

module.exports = { BrowserTabManager }
