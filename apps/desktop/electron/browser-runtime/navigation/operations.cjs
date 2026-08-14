'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')

const TOP_LEVEL_CDP_NAVIGATION_METHODS = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry'
])

const CHROMIUM_ERROR_PAGE_PREFIX = 'chrome-error://'

function isAbortedNavigationFailure(failure) {
  if (!failure) return false
  const networkErrorCode = Number(
    failure.networkErrorCode ?? failure.errorCode ?? failure.errno
  )
  const description = String(
    failure.errorDescription || failure.code || failure.message || ''
  )
  return networkErrorCode === -3 || /(?:^|\b)ERR_ABORTED(?:\b|$)/i.test(description)
}

function isChromiumErrorPage(url) {
  return String(url || '').trim().toLowerCase().startsWith(CHROMIUM_ERROR_PAGE_PREFIX)
}

function isRetryableNavigationFailure(networkErrorCode, errorDescription) {
  if (Number(networkErrorCode) === -3) return false
  return /(?:TIMED_OUT|CONNECTION|NETWORK|PROXY|TUNNEL|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE)/i
    .test(String(errorDescription || ''))
}

function navigationFailureError(failure = {}, {
  code = 'NAVIGATION_FAILED',
  requestedUrl = '',
  validatedUrl = '',
  retryable = false,
  userRetryable = undefined
} = {}) {
  const rawNetworkErrorCode = Number(
    failure.networkErrorCode ?? failure.errorCode ?? failure.errno
  )
  const networkErrorCode = Number.isFinite(rawNetworkErrorCode)
    ? rawNetworkErrorCode
    : undefined
  const errorDescription = String(
    failure.errorDescription ||
    (typeof failure.code === 'string' && failure.code !== code ? failure.code : '') ||
    failure.message ||
    (code === 'NAVIGATION_TIMEOUT' ? 'Navigation timed out' : 'Navigation failed')
  )
  const finalValidatedUrl = String(
    failure.validatedUrl || failure.validatedURL || failure.url || validatedUrl || requestedUrl || ''
  )
  const numericSuffix = networkErrorCode == null ? '' : ` (${networkErrorCode})`
  const urlSuffix = finalValidatedUrl ? ` while loading ${finalValidatedUrl}` : ''
  const error = new Error(`${errorDescription}${numericSuffix}${urlSuffix}`)
  error.code = code
  if (networkErrorCode != null) {
    error.networkErrorCode = networkErrorCode
    error.errorCode = networkErrorCode
  }
  error.errorDescription = errorDescription
  error.requestedUrl = String(requestedUrl || '')
  error.validatedUrl = finalValidatedUrl
  // `retryable` controls autonomous agent retries. A network/proxy failure
  // should stop this turn instead of cycling through observe/wait/reload. The
  // separate userRetryable flag records that a user may fix connectivity and
  // deliberately try again later.
  error.retryable = Boolean(retryable)
  error.userRetryable = typeof userRetryable === 'boolean'
    ? userRetryable
    : isRetryableNavigationFailure(networkErrorCode, errorDescription)
  error.details = {
    ...(networkErrorCode == null ? {} : { networkErrorCode }),
    errorDescription,
    requestedUrl: error.requestedUrl,
    validatedUrl: finalValidatedUrl,
    retryable: error.retryable,
    userRetryable: error.userRetryable,
    replanRequired: false
  }
  if (failure instanceof Error) error.cause = failure
  return error
}

function clearMainFrameNavigationFailure(entry) {
  if (!entry) return
  entry.mainFrameNavigationFailure = null
}

function mainFrameNavigationFailure(entry) {
  const failure = entry?.mainFrameNavigationFailure
  return failure && !isAbortedNavigationFailure(failure) ? failure : null
}

function navigationFailureEventPayload(error, requestedUrl) {
  const details = error?.details || {}
  return {
    code: error?.code || 'NAVIGATION_FAILED',
    error: error?.message || String(error),
    ...(Number.isFinite(Number(details.networkErrorCode))
      ? { errorCode: Number(details.networkErrorCode) }
      : {}),
    errorDescription: details.errorDescription || error?.errorDescription || error?.message || String(error),
    requestedUrl: details.requestedUrl || String(requestedUrl || ''),
    validatedUrl: details.validatedUrl || error?.validatedUrl || String(requestedUrl || ''),
    retryable: Boolean(details.retryable),
    userRetryable: Boolean(details.userRetryable),
    replanRequired: false
  }
}

function unpackNavigationCommandResult(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.transaction &&
    typeof value.transaction === 'object'
  ) {
    return {
      transaction: value.transaction,
      result: value.result
    }
  }
  return { transaction: null, result: value }
}

function _isTopLevelCdpNavigationMethod(method) {
  return TOP_LEVEL_CDP_NAVIGATION_METHODS.has(String(method || '').trim())
}

function _assertNavigationTransactionCurrent(transaction) {
  if (!transaction || typeof this.assertNavigationCurrent !== 'function') return
  return this.assertNavigationCurrent(transaction)
}

function _releaseNavigationTransaction(transaction) {
  if (!transaction || typeof this.releaseNavigation !== 'function') return false
  try {
    return this.releaseNavigation(transaction)
  } catch (error) {
    this.log?.(`navigation transaction release failed: ${error?.message || error}`)
    return false
  }
}

async function _runNavigationCommand(command, { requireCoordinator = false } = {}) {
  let commandResult
  if (this.runNavigationCommand) {
    commandResult = await this.runNavigationCommand(command)
  } else {
    if (requireCoordinator) {
      const error = new Error(`Top-level raw CDP ${command.method} requires the managed navigation command`)
      error.code = 'NAVIGATION_COORDINATOR_UNAVAILABLE'
      throw error
    }
    commandResult = await command.execute()
  }

  const navigation = unpackNavigationCommandResult(commandResult)
  try {
    await this._assertNavigationTransactionCurrent(navigation.transaction)
    return navigation
  } catch (error) {
    this._releaseNavigationTransaction(navigation.transaction)
    throw error
  }
}

function _visibleUrl(entry, fallback = '') {
  try {
    const url = typeof entry?.webContents?.getURL === 'function'
      ? String(entry.webContents.getURL() || '')
      : ''
    return url || String(fallback || '')
  } catch {
    return String(fallback || '')
  }
}

async function _runTopLevelCdpNavigation(entry, method, params = {}, sessionId = undefined) {
  const cdpMethod = String(method || '').trim()
  if (!this.runNavigationCommand) {
    const error = new Error(`Top-level raw CDP ${cdpMethod} requires the managed navigation command`)
    error.code = 'NAVIGATION_COORDINATOR_UNAVAILABLE'
    throw error
  }
  const runtimeSessionId = this._sessionIdForEntry(entry)
  let url = this._visibleUrl(entry, 'about:blank')

  if (cdpMethod === 'Page.navigate') {
    url = String(params?.url || '').trim()
  } else if (cdpMethod === 'Page.navigateToHistoryEntry') {
    const history = await entry.client.send('Page.getNavigationHistory')
    const target = Array.isArray(history?.entries)
      ? history.entries.find(item => Number(item?.id) === Number(params?.entryId))
      : null
    if (!target?.url) {
      const error = new Error(`Navigation history entry was not found: ${params?.entryId}`)
      error.code = 'HISTORY_ENTRY_NOT_FOUND'
      throw error
    }
    url = String(target.url)
  }

  const execute = () => {
    this._assertNoSessionIntervention(runtimeSessionId, 'cdp')
    return entry.client.send(cdpMethod, params, sessionId)
  }
  let transaction = null
  try {
    const navigation = await this._runNavigationCommand({
      method: cdpMethod,
      sessionId: runtimeSessionId,
      tabId: String(entry.id),
      webContents: entry.webContents,
      url,
      source: 'agent',
      execute
    }, { requireCoordinator: true })
    transaction = navigation.transaction
    this._assertNavigationTransactionCurrent(transaction)
    return navigation.result
  } finally {
    this._releaseNavigationTransaction(transaction)
  }
}

async function navigate(id, url, params = {}) {
  const targetUrl = String(url || '').trim()
  if (!targetUrl) throw new Error('url is required')
  const entry = this.getWorkbench(id)
  await this._prepare(entry)
  const sessionId = this._sessionIdForEntry(entry)
  this._assertNoSessionIntervention(sessionId, 'navigate')
  if (params._fanDecisionToken) {
    this._assertDecisionToken(sessionId, params, 'navigate')
  }
  this._assertUrlAllowed(entry, targetUrl, 'navigate')
  this.eventBus.emit(EVENT_TYPES.NAVIGATION_STARTED, {
    id: entry.id,
    url: targetUrl,
    requestedUrl: targetUrl
  })
  const previousUrl = this._visibleUrl(entry)
  const initialDocumentRevision = this._documentStateSnapshot(entry).revision
  let nativeLoadError = null
  const useNativeNavigation = typeof entry.webContents?.loadURL === 'function'
  const execute = () => {
    this._assertNoSessionIntervention(sessionId, 'navigate')
    // A main-frame failure belongs to one navigation intent. Clear the previous
    // terminal state only when the replacement command is actually dispatched;
    // the watchdog does the same for human-initiated main-frame navigations.
    clearMainFrameNavigationFailure(entry)
    if (!useNativeNavigation) {
      // Lightweight runtimes and tests without Electron's WebContents API keep
      // the managed CDP fallback. Production navigation uses loadURL below.
      return entry.client.send('Page.navigate', { url: targetUrl, transitionType: 'address_bar' })
    }

    // Use the exact same Chromium navigation path as the omnibox. loadURL starts
    // the navigation synchronously but its Promise settles at the end of the
    // document load, so it must not sit on the command-ack critical path. A slow
    // server can otherwise make Page.navigate's CDP response time out even though
    // Chromium accepted the request and continues loading it in the background.
    // The document-revision gate below remains the authoritative completion
    // boundary and prevents a second navigation from being issued on that false
    // timeout.
    try {
      const pendingLoad = entry.webContents.loadURL(targetUrl)
      void Promise.resolve(pendingLoad).catch(error => {
        // ERR_ABORTED is normal when redirects or a newer explicit navigation
        // replace this load. A real failure is surfaced by the wait loop if no
        // document from this intent commits.
        if (!isAbortedNavigationFailure(error)) {
          nativeLoadError = error
        }
      })
    } catch (error) {
      nativeLoadError = error
      throw error
    }
    return { dispatched: true, loaderId: null, transport: 'webContents.loadURL' }
  }

  let transaction = null
  try {
    const navigation = await this._runNavigationCommand({
      method: 'Page.navigate',
      sessionId,
      tabId: String(entry.id),
      webContents: entry.webContents,
      url: targetUrl,
      source: 'agent',
      execute
    })
    const { result } = navigation
    transaction = navigation.transaction
    this._assertNavigationTransactionCurrent(transaction)
    if (result?.errorText) {
      throw navigationFailureError({ errorDescription: result.errorText }, {
        requestedUrl: targetUrl,
        validatedUrl: targetUrl
      })
    }
    this._assertNoSessionIntervention(sessionId, 'navigate')
    this._clearSelectorMap(entry, 'navigation', { url: targetUrl })
    const load = await this._waitForLoad(entry, params, {
      defaultTimeoutMs: 30000,
      dispatchError: () => nativeLoadError,
      expectDocumentCommit: useNativeNavigation,
      initialDocumentRevision,
      loaderId: result?.loaderId || null,
      previousUrl,
      requestedUrl: targetUrl,
      transaction
    })
    this._assertNoSessionIntervention(sessionId, 'navigate')
    this._assertNavigationTransactionCurrent(transaction)
    const finalUrl = this._visibleUrl(entry, targetUrl)
    this._assertNavigationTransactionCurrent(transaction)
    const output = {
      navigated: finalUrl,
      requestedUrl: targetUrl,
      finalUrl,
      loaderId: result?.loaderId || null,
      errorText: null,
      ...load
    }
    this._assertNavigationTransactionCurrent(transaction)
    this.eventBus.emit(EVENT_TYPES.NAVIGATION_COMPLETED, {
      id: entry.id,
      url: finalUrl,
      requestedUrl: targetUrl,
      finalUrl,
      loaderId: result?.loaderId,
      ...load
    })
    return output
  } catch (error) {
    this.eventBus.emit(EVENT_TYPES.NAVIGATION_FAILED, {
      id: entry.id,
      url: targetUrl,
      ...navigationFailureEventPayload(error, targetUrl)
    })
    throw error
  } finally {
    this._releaseNavigationTransaction(transaction)
  }
}

// Wait until the authoritative document revision is quiet. Redirects and
// script-driven cross-document navigations are ordinary commits: each one bumps
// revision in the watchdog and restarts the quiet window. URL, readyState and
// network activity are completion evidence only, never transaction identity.
async function _waitForLoad(entry, params = {}, navigation = {}) {
  const transaction = navigation.transaction || null
  await this._assertNavigationTransactionCurrent(transaction)
  const waitUntil = String(params.waitUntil || params.wait_until || 'settle').trim().toLowerCase()
  const timeoutMs = this._coerceTimeout(
    params.waitTimeoutMs || params.wait_timeout_ms || process.env.ELECTRON_BROWSER_NAVIGATE_WAIT_MS,
    Number(navigation.defaultTimeoutMs) > 0 ? Number(navigation.defaultTimeoutMs) : 15000
  )
  const stableWindowMs = Math.max(
    100,
    Math.min(
      5000,
      Number(
        params.documentStableMs ??
        params.document_stable_ms ??
        process.env.ELECTRON_BROWSER_DOCUMENT_STABLE_MS
      ) || 600
    )
  )
  const networkIdleMs = Math.max(
    50,
    Math.min(5000, Number(params.networkIdleMs ?? params.network_idle_ms) || 300)
  )
  const requestedNetworkIdleTimeoutMs = Number(
    params.networkIdleTimeoutMs ??
    params.network_idle_timeout_ms ??
    process.env.ELECTRON_BROWSER_NETWORK_IDLE_WAIT_MS
  )
  // The overall timeout remains the hard safety budget for document commit and
  // readiness. Once the document is usable, network-idle is only an enhancement:
  // a streaming/background request must not consume the rest of a 30s navigate.
  const networkIdleTimeoutMs = Math.max(
    networkIdleMs,
    Math.min(
      timeoutMs,
      Number.isFinite(requestedNetworkIdleTimeoutMs) && requestedNetworkIdleTimeoutMs >= 0
        ? requestedNetworkIdleTimeoutMs
        : 3000
    )
  )
  const startedAt = Date.now()
  const initialState = this._documentStateSnapshot(entry)
  const suppliedRevision = Number(navigation.initialDocumentRevision)
  const initialDocumentRevision = Number.isFinite(suppliedRevision)
    ? Math.max(0, suppliedRevision)
    : initialState.revision
  let mainFrameLoading = false
  try {
    if (typeof entry.webContents.isLoadingMainFrame === 'function') {
      mainFrameLoading = Boolean(entry.webContents.isLoadingMainFrame())
    } else if (typeof entry.webContents.isLoading === 'function') {
      mainFrameLoading = Boolean(entry.webContents.isLoading())
    }
  } catch {
    mainFrameLoading = false
  }
  const expectsDocumentCommit = Boolean(
    navigation.loaderId ||
    navigation.expectDocumentCommit ||
    initialState.revision > initialDocumentRevision ||
    mainFrameLoading
  )
  let state = initialState
  let lastRevision = state.revision
  let sawDocumentCommit = state.revision > initialDocumentRevision
  let stableSince = sawDocumentCommit && state.committedAt ? state.committedAt : startedAt
  let networkIdleSince = null
  let documentStable = false
  let pageUsable = false
  let pageUsableSince = null
  let pageUsableElapsedMs = null
  let networkIdle = false
  let networkIdleTimedOut = false
  let readyState = ''
  let pendingRequests = 0
  const requestedUrl = String(navigation.requestedUrl || '')

  const documentResult = () => ({
    finalUrl: this._visibleUrl(entry, state.url || navigation.previousUrl || ''),
    documentRevision: state.revision,
    loaderId: state.loaderId || navigation.loaderId || null
  })

  const throwIfNavigationFailed = () => {
    const latchedFailure = mainFrameNavigationFailure(entry)
    const dispatchedFailure = typeof navigation.dispatchError === 'function'
      ? navigation.dispatchError()
      : null
    const failure = latchedFailure || (
      dispatchedFailure && !isAbortedNavigationFailure(dispatchedFailure)
        ? dispatchedFailure
        : null
    )
    if (failure) {
      throw navigationFailureError(failure, {
        requestedUrl,
        validatedUrl: failure.validatedUrl || failure.validatedURL || state.url || requestedUrl
      })
    }

    // Chromium commits its internal network-error document as a normal main
    // frame. It can be ready, stable and idle, but is never a usable result for
    // the requested navigation. Only inspect it after this intent has committed
    // so a previous error document cannot poison a new in-flight navigation.
    const committedUrl = String(state.url || '')
    const visibleUrl = this._visibleUrl(entry, committedUrl)
    const errorPageUrl = [committedUrl, visibleUrl].find(isChromiumErrorPage)
    if ((sawDocumentCommit || !expectsDocumentCommit) && errorPageUrl) {
      throw navigationFailureError({
        errorDescription: 'CHROME_ERROR_PAGE',
        validatedUrl: errorPageUrl
      }, {
        requestedUrl,
        validatedUrl: errorPageUrl,
        retryable: false,
        userRetryable: true
      })
    }
  }

  if (waitUntil === 'none') {
    await this._assertNavigationTransactionCurrent(transaction)
    throwIfNavigationFailed()
    return {
      waitUntil,
      loadCompleted: null,
      navigationStarted: null,
      documentStable: null,
      pageUsable: null,
      networkIdle: null,
      networkIdleTimedOut: null,
      stableWindowMs,
      networkIdleMs,
      networkIdleTimeoutMs,
      ...documentResult()
    }
  }

  while (Date.now() - startedAt < timeoutMs) {
    await this._assertNavigationTransactionCurrent(transaction)
    state = this._documentStateSnapshot(entry)
    if (state.revision !== lastRevision) {
      lastRevision = state.revision
      if (state.revision > initialDocumentRevision) sawDocumentCommit = true
      stableSince = state.committedAt || Date.now()
      networkIdleSince = null
      documentStable = false
      pageUsable = false
      pageUsableSince = null
      pageUsableElapsedMs = null
      networkIdle = false
    }
    throwIfNavigationFailed()
    const commitSatisfied = sawDocumentCommit || !expectsDocumentCommit
    if (commitSatisfied) {
      // The outer wait budget must also bound each CDP read. DebuggerClient's
      // normal command timeout is deliberately much larger (60s), so relying
      // on it here would let one silent Runtime.evaluate outlive this loop.
      const readinessTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
      const ready = await entry.client
        .send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true
        }, undefined, readinessTimeoutMs)
        .then(result => String(result?.result?.value || ''))
        .catch(() => '')
      await this._assertNavigationTransactionCurrent(transaction)

      // A document commit may race the evaluate request. Discard readiness from
      // the old document and restart all completion windows when that happens.
      const afterReady = this._documentStateSnapshot(entry)
      if (afterReady.revision !== state.revision) {
        state = afterReady
        lastRevision = afterReady.revision
        if (afterReady.revision > initialDocumentRevision) sawDocumentCommit = true
        stableSince = afterReady.committedAt || Date.now()
        networkIdleSince = null
        documentStable = false
        pageUsable = false
        pageUsableSince = null
        pageUsableElapsedMs = null
        networkIdle = false
        continue
      }

      state = afterReady
      throwIfNavigationFailed()

      readyState = ready
      pendingRequests = typeof entry.watchdog?.pendingSettleCount === 'function'
        ? entry.watchdog.pendingSettleCount()
        : (entry.watchdog?.pendingRequests?.size || 0)
      const readyEnough = readyState === 'interactive' || readyState === 'complete'
      const needsNetworkIdle = waitUntil === 'settle'

      if (readyEnough && pendingRequests === 0) {
        if (networkIdleSince == null) networkIdleSince = Date.now()
      } else {
        networkIdleSince = null
      }

      const documentQuiet = Date.now() - stableSince >= stableWindowMs
      documentStable = Boolean(documentQuiet && readyEnough)
      pageUsable = documentStable
      networkIdle = Boolean(
        networkIdleSince != null && Date.now() - networkIdleSince >= networkIdleMs
      )
      if (pageUsable) {
        if (pageUsableSince == null) {
          pageUsableSince = Date.now()
          pageUsableElapsedMs = pageUsableSince - startedAt
        }
        if (!needsNetworkIdle || networkIdle) {
          throwIfNavigationFailed()
          break
        }
        if (Date.now() - pageUsableSince >= networkIdleTimeoutMs) {
          networkIdleTimedOut = true
          throwIfNavigationFailed()
          break
        }
      } else {
        pageUsableSince = null
        pageUsableElapsedMs = null
      }
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    if (remainingMs <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remainingMs)))
    await this._assertNavigationTransactionCurrent(transaction)
  }

  await this._assertNavigationTransactionCurrent(transaction)
  state = this._documentStateSnapshot(entry)
  if (state.revision !== lastRevision) {
    lastRevision = state.revision
    if (state.revision > initialDocumentRevision) sawDocumentCommit = true
    documentStable = false
    pageUsable = false
    pageUsableSince = null
    pageUsableElapsedMs = null
    networkIdle = false
    networkIdleTimedOut = false
  } else if (state.revision > initialDocumentRevision) {
    sawDocumentCommit = true
  }
  throwIfNavigationFailed()
  if (!pageUsable) {
    const elapsedMs = Date.now() - startedAt
    const validatedUrl = sawDocumentCommit
      ? String(state.url || this._visibleUrl(entry, requestedUrl) || requestedUrl)
      : requestedUrl
    const phase = expectsDocumentCommit && !sawDocumentCommit
      ? 'before the requested document committed'
      : 'before the page became usable'
    const error = navigationFailureError({
      errorDescription: `Navigation timed out ${phase}`,
      validatedUrl
    }, {
      code: 'NAVIGATION_TIMEOUT',
      requestedUrl,
      validatedUrl,
      retryable: false,
      userRetryable: true
    })
    error.loadElapsedMs = elapsedMs
    throw error
  }
  if (waitUntil === 'settle' && pageUsable && !networkIdle) networkIdleTimedOut = true
  const out = {
    waitUntil,
    loadCompleted: pageUsable,
    loadElapsedMs: Date.now() - startedAt,
    navigationStarted: sawDocumentCommit || !expectsDocumentCommit,
    documentStable,
    pageUsable,
    pageUsableElapsedMs,
    networkIdle,
    networkIdleTimedOut,
    stableWindowMs,
    networkIdleMs,
    networkIdleTimeoutMs,
    readyState,
    pendingRequests,
    pendingRequestsTotal: entry.watchdog?.pendingRequests?.size || 0,
    ...documentResult()
  }
  if (waitUntil === 'settle') out.settled = pageUsable && networkIdle

  // Navigation replaces page DOM. Reconcile the control frame before publishing
  // completion so the visible page and the control chrome cannot diverge. The
  // on-new-document script normally makes this a cheap idempotent confirmation.
  if (this._isControlActive(this._sessionIdForEntry(entry))) {
    this._assertNavigationTransactionCurrent(transaction)
    await this._queueOperatingReconcile(this._sessionIdForEntry(entry)).catch(error => {
      this.log?.(`navigation visual reconcile failed for ${entry.id}: ${error?.message || error}`)
    })
  }
  this._assertNavigationTransactionCurrent(transaction)
  return out
}

async function back(id, params = {}) {
  const entry = this.getWorkbench(id)
  await this._prepare(entry)
  const sessionId = this._sessionIdForEntry(entry)
  this._assertNoSessionIntervention(sessionId, 'back')
  this._assertEntryDecisionToken(entry, params, 'back')
  this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'back' })
  let transaction = null
  try {
    const history = await entry.client.send('Page.getNavigationHistory')
    const currentIndex = Number(history?.currentIndex)
    const entries = history?.entries || []
    if (currentIndex <= 0 || !entries[currentIndex - 1]) {
      const output = { back: false }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'back', result: output })
      return output
    }
    const target = entries[currentIndex - 1]
    const previousUrl = this._visibleUrl(entry)
    const initialDocumentRevision = this._documentStateSnapshot(entry).revision
    const requestedUrl = String(target.url || previousUrl || 'about:blank')
    const execute = () => {
      this._assertNoSessionIntervention(sessionId, 'back')
      clearMainFrameNavigationFailure(entry)
      return entry.client.send('Page.navigateToHistoryEntry', { entryId: target.id })
    }
    const navigation = await this._runNavigationCommand({
      method: 'Page.navigateToHistoryEntry',
      sessionId,
      tabId: String(entry.id),
      webContents: entry.webContents,
      url: requestedUrl,
      source: 'agent',
      execute
    })
    transaction = navigation.transaction
    this._assertNavigationTransactionCurrent(transaction)
    this._clearSelectorMap(entry, 'back')
    const load = await this._waitForLoad(entry, params, {
      initialDocumentRevision,
      previousUrl,
      requestedUrl,
      transaction
    })
    this._assertNavigationTransactionCurrent(transaction)
    const finalUrl = this._visibleUrl(entry, requestedUrl)
    this._assertNavigationTransactionCurrent(transaction)
    const output = { back: true, requestedUrl, finalUrl, ...load }
    this._assertNavigationTransactionCurrent(transaction)
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'back', result: output })
    return output
  } catch (error) {
    this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
      id: entry.id,
      action: 'back',
      ...navigationFailureEventPayload(error, error?.requestedUrl)
    })
    throw error
  } finally {
    this._releaseNavigationTransaction(transaction)
  }
}

async function forward(id, params = {}) {
  const entry = this.getWorkbench(id)
  await this._prepare(entry)
  const sessionId = this._sessionIdForEntry(entry)
  this._assertNoSessionIntervention(sessionId, 'forward')
  this._assertEntryDecisionToken(entry, params, 'forward')
  this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'forward' })
  let transaction = null
  try {
    const history = await entry.client.send('Page.getNavigationHistory')
    const currentIndex = Number(history?.currentIndex)
    const entries = history?.entries || []
    if (currentIndex < 0 || currentIndex >= entries.length - 1 || !entries[currentIndex + 1]) {
      const output = { forward: false }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'forward', result: output })
      return output
    }
    const target = entries[currentIndex + 1]
    const previousUrl = this._visibleUrl(entry)
    const initialDocumentRevision = this._documentStateSnapshot(entry).revision
    const requestedUrl = String(target.url || previousUrl || 'about:blank')
    const execute = () => {
      this._assertNoSessionIntervention(sessionId, 'forward')
      clearMainFrameNavigationFailure(entry)
      return entry.client.send('Page.navigateToHistoryEntry', { entryId: target.id })
    }
    const navigation = await this._runNavigationCommand({
      method: 'Page.navigateToHistoryEntry',
      sessionId,
      tabId: String(entry.id),
      webContents: entry.webContents,
      url: requestedUrl,
      source: 'agent',
      execute
    })
    transaction = navigation.transaction
    this._assertNavigationTransactionCurrent(transaction)
    this._clearSelectorMap(entry, 'forward')
    const load = await this._waitForLoad(entry, params, {
      initialDocumentRevision,
      previousUrl,
      requestedUrl,
      transaction
    })
    this._assertNavigationTransactionCurrent(transaction)
    const finalUrl = this._visibleUrl(entry, requestedUrl)
    this._assertNavigationTransactionCurrent(transaction)
    const output = { forward: true, requestedUrl, finalUrl, ...load }
    this._assertNavigationTransactionCurrent(transaction)
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'forward', result: output })
    return output
  } catch (error) {
    this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
      id: entry.id,
      action: 'forward',
      ...navigationFailureEventPayload(error, error?.requestedUrl)
    })
    throw error
  } finally {
    this._releaseNavigationTransaction(transaction)
  }
}

async function reload(id, params = {}) {
  const entry = this.getWorkbench(id)
  await this._prepare(entry)
  const sessionId = this._sessionIdForEntry(entry)
  this._assertNoSessionIntervention(sessionId, 'reload')
  this._assertEntryDecisionToken(entry, params, 'reload')
  this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'reload' })
  let transaction = null
  try {
    const requestedUrl = this._visibleUrl(entry, 'about:blank')
    const initialDocumentRevision = this._documentStateSnapshot(entry).revision
    const execute = () => {
      this._assertNoSessionIntervention(sessionId, 'reload')
      clearMainFrameNavigationFailure(entry)
      return entry.client.send('Page.reload', { ignoreCache: Boolean(params.ignoreCache || params.ignore_cache) })
    }
    const navigation = await this._runNavigationCommand({
      method: 'Page.reload',
      sessionId,
      tabId: String(entry.id),
      webContents: entry.webContents,
      url: requestedUrl,
      source: 'agent',
      execute
    })
    transaction = navigation.transaction
    this._assertNavigationTransactionCurrent(transaction)
    this._clearSelectorMap(entry, 'reload')
    const load = await this._waitForLoad(entry, params, {
      initialDocumentRevision,
      previousUrl: requestedUrl,
      expectDocumentCommit: true,
      requestedUrl,
      transaction
    })
    this._assertNavigationTransactionCurrent(transaction)
    const finalUrl = this._visibleUrl(entry, requestedUrl)
    this._assertNavigationTransactionCurrent(transaction)
    const output = { reloaded: true, requestedUrl, finalUrl, ...load }
    this._assertNavigationTransactionCurrent(transaction)
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'reload', result: output })
    return output
  } catch (error) {
    this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
      id: entry.id,
      action: 'reload',
      ...navigationFailureEventPayload(error, error?.requestedUrl)
    })
    throw error
  } finally {
    this._releaseNavigationTransaction(transaction)
  }
}

const navigationOperations = {
  _assertNavigationTransactionCurrent,
  _isTopLevelCdpNavigationMethod,
  _releaseNavigationTransaction,
  _runNavigationCommand,
  _runTopLevelCdpNavigation,
  _visibleUrl,
  navigate,
  _waitForLoad,
  back,
  forward,
  reload
}

function installNavigationOperations(Runtime) {
  for (const [name, operation] of Object.entries(navigationOperations)) {
    Object.defineProperty(Runtime.prototype, name, {
      configurable: true,
      writable: true,
      value: operation
    })
  }
}

module.exports = { installNavigationOperations }
