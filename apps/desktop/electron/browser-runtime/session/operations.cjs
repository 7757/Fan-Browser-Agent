'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')

// Selector-map clear reasons that mean THE PAGE ITSELF changed (navigation,
// document swap, target switch) — element indices minted before such a clear
// belong to a different page, so index-based actions must NOT silently
// re-observe and act on whatever now happens to hold that index. Action-class
// clears (click/type/scroll mutated the same page) keep the legacy
// auto-re-observe behavior, matching tolerance.
const PAGE_CHANGED_CLEAR_REASONS = new Set([
  'navigation',
  'navigation.started',
  'navigation.completed',
  'navigation.in-page',
  'dom.documentUpdated',
  'back',
  'forward',
  'reload',
  'switch-target',
  'close-target'
])

function _normalizeSessionTabsGroup(group) {
  if (!group || !Array.isArray(group.tabs) || !group.tabs.length) return null
  const tabs = group.tabs.map(String).filter(Boolean)
  if (!tabs.length) return null
  const rawActive = Number(group.active)
  const active = Math.min(Math.max(Number.isFinite(rawActive) ? rawActive : 0, 0), tabs.length - 1)
  // Carry the host's per-tab {url,title} meta through: listTabs falls back to
  // it for lazily-restored tabs with no live workbench yet, so the agent still
  // sees which tab is which.
  return { tabs, active, tabMeta: group.tabMeta && typeof group.tabMeta === 'object' ? group.tabMeta : undefined }
}

function _tabEventPayload(sessionId, tabId, extra = {}) {
  const id = String(tabId || '')
  const entry = this.workbenches.get(id)
  const webContents = entry && !entry.webContents?.isDestroyed?.() ? entry.webContents : null
  const activeTabId = this._activeTabId(sessionId)
  return {
    sessionId: String(sessionId || 'main'),
    tabId: id,
    activeTabId,
    current: id === activeTabId,
    url: webContents?.getURL?.() || '',
    title: webContents?.getTitle?.() || '',
    ...extra
  }
}

function _contextForSession(sessionId) {
  const key = String(sessionId || 'main')
  let context = this.sessionContexts.get(key)
  if (!context) {
    context = {
      sessionId: key,
      previousActiveTabId: null,
      needsObserve: false,
      observeReason: null,
      observeTabId: null,
      observeEventId: null,
      observeRequirements: {},
      pendingTabOpen: null,
      lastObservedTabId: null,
      lastObservedAt: null,
      lastSelectorGeneration: null,
      version: 0,
      updatedAt: Date.now()
    }
    this.sessionContexts.set(key, context)
  }
  return context
}

function _contextSnapshot(sessionId) {
  const context = this._contextForSession(sessionId)
  const group = this.sessionTabs.get(context.sessionId)
  const tabs = group?.tabs ? group.tabs.map(String) : []
  const activeTabId = tabs.length ? this._activeTabId(context.sessionId) : null
  const requirements =
    context.observeRequirements && typeof context.observeRequirements === 'object'
      ? context.observeRequirements
      : {}
  const pendingObserveTabs = Object.values(requirements)
    .filter(Boolean)
    .map(requirement => ({ ...requirement }))
  const activeRequirement = activeTabId ? requirements[String(activeTabId)] : null
  const hasRequirements = pendingObserveTabs.length > 0
  return {
    sessionId: context.sessionId,
    tabs,
    activeTabId,
    previousActiveTabId: context.previousActiveTabId || null,
    needsObserve: Boolean(activeRequirement || (!hasRequirements && context.needsObserve)),
    observeReason: activeRequirement?.reason || (!hasRequirements ? context.observeReason : null) || null,
    observeTabId: activeRequirement?.tabId || (!hasRequirements ? context.observeTabId : null) || null,
    observeEventId: activeRequirement?.eventId || (!hasRequirements ? context.observeEventId : null) || null,
    pendingObserveTabs,
    pendingTabOpen: context.pendingTabOpen ? { ...context.pendingTabOpen } : null,
    lastObservedTabId: context.lastObservedTabId || null,
    lastObservedAt: context.lastObservedAt || null,
    lastSelectorGeneration: context.lastSelectorGeneration ?? null,
    version: context.version,
    updatedAt: context.updatedAt
  }
}

function _updateBrowserContext(sessionId, patch = {}, reason = 'updated') {
  const context = this._contextForSession(sessionId)
  Object.assign(context, patch)
  context.version = Number(context.version || 0) + 1
  context.updatedAt = Date.now()
  const snapshot = this._contextSnapshot(sessionId)
  this.eventBus.emit(EVENT_TYPES.BROWSER_CONTEXT_UPDATED, { ...snapshot, reason })
  return snapshot
}

function _observeRequirementAggregatePatch(sessionId, requirements = null) {
  const key = String(sessionId || 'main')
  const context = this._contextForSession(key)
  const normalized = requirements && typeof requirements === 'object'
    ? requirements
    : context.observeRequirements || {}
  const activeTabId = this._activeTabId(key)
  const activeRequirement = activeTabId ? normalized[String(activeTabId)] : null
  return {
    observeRequirements: normalized,
    needsObserve: Boolean(activeRequirement),
    observeReason: activeRequirement?.reason || null,
    observeTabId: activeRequirement?.tabId || null,
    observeEventId: activeRequirement?.eventId || null
  }
}

function _markObserveRequired(sessionId, tabId, reason, details = {}) {
  const key = String(sessionId || 'main')
  const targetTabId = String(tabId || this._activeTabId(key) || key)
  const event = this.eventBus.emit(EVENT_TYPES.OBSERVE_REQUIRED, {
    sessionId: key,
    tabId: targetTabId,
    activeTabId: this._activeTabId(key),
    reason,
    ...details
  })
  const context = this._contextForSession(key)
  const requirements = {
    ...(context.observeRequirements || {}),
    [targetTabId]: {
      tabId: targetTabId,
      reason,
      eventId: event.id,
      requiredAt: event.timestamp,
      sourceEventId: details.sourceEventId || null,
      previousTabId: details.previousTabId || null
    }
  }
  this._updateBrowserContext(
    key,
    this._observeRequirementAggregatePatch(key, requirements),
    'observe.required'
  )
  return event
}

function _clearObserveRequirement(sessionId, tabId, reason, details = {}) {
  const key = String(sessionId || 'main')
  const context = this._contextForSession(key)
  const observedTabId = String(tabId || this._activeTabId(key) || key)
  const requirements = { ...(context.observeRequirements || {}) }
  delete requirements[observedTabId]
  return this._updateBrowserContext(
    key,
    {
      ...this._observeRequirementAggregatePatch(key, requirements),
      lastObservedTabId: observedTabId,
      lastObservedAt: Date.now(),
      lastSelectorGeneration: details.selectorGeneration ?? context.lastSelectorGeneration ?? null
    },
    reason || 'dom.observed'
  )
}

function _clearSelectorMap(entry, reason, details = {}) {
  if (!entry?.selectorMap || typeof entry.selectorMap.clear !== 'function') return null
  entry.selectorMap.clear(reason)
  const sessionId = this._sessionIdForEntry(entry)
  const payload = {
    id: entry.id,
    sessionId,
    tabId: entry.id,
    reason,
    pageChanged: PAGE_CHANGED_CLEAR_REASONS.has(reason),
    generation: entry.selectorMap.generation,
    ...details
  }
  const event = this.eventBus.emit(EVENT_TYPES.SELECTOR_INVALIDATED, payload)
  if (payload.pageChanged) {
    // pageGeneration 的递增已统一在 SelectorMap.clear 内完成(覆盖 watchdog 直接 clear 的导航),
    // 这里只负责"需要重新观察"的标记,不再重复维护代次。
    this._markObserveRequired(sessionId, entry.id, reason, {
      sourceEventId: event.id,
      previousTabId: details.previousTabId || null
    })
  }
  return event
}

// main.cjs (the single owner of view lifecycle) pushes tab-group changes here;
// the runtime treats sessionTabs as a read-only list/metadata projection.
function syncSessionTabs(sessionId, group) {
  const key = String(sessionId || 'main')
  try { this.log(`[tabdiag] syncSessionTabs recv key=${key} tabs=[${(group && group.tabs || []).join(',')}] active=${group && group.active}`) } catch (e) { void e }
  const prev = this.sessionTabs.get(key)
  const previousContext = this.sessionContexts.get(key)
  const prevActive = prev?.tabs?.length
    ? String(prev.tabs[prev.active] ?? prev.tabs[0])
    : null
  const nextGroup = this._normalizeSessionTabsGroup(group)
  if (nextGroup) {
    this.sessionTabs.set(key, nextGroup)
  } else {
    this.sessionTabs.delete(key)
  }
  const next = this.sessionTabs.get(key)
  const newActive = next && next.tabs.length ? this._activeTabId(key) : null
  const context = previousContext || this._contextForSession(key)
  const requirements = {}
  const existingRequirements = context.observeRequirements || {}
  for (const tabId of next?.tabs || []) {
    if (existingRequirements[tabId]) requirements[tabId] = existingRequirements[tabId]
  }
  let pendingTabOpen = context.pendingTabOpen || null
  if (!newActive || (pendingTabOpen?.sourceTabId && newActive !== pendingTabOpen.sourceTabId)) {
    pendingTabOpen = null
  }
  this._updateBrowserContext(
    key,
    {
      previousActiveTabId: prevActive || null,
      pendingTabOpen,
      ...this._observeRequirementAggregatePatch(key, requirements)
    },
    'tabs.synced'
  )
  const prevTabs = prev?.tabs ? prev.tabs.map(String) : []
  const nextTabs = next?.tabs ? next.tabs.map(String) : []
  const prevSet = new Set(prevTabs)
  const nextSet = new Set(nextTabs)
  const tabOrderChanged =
    prevTabs.length === nextTabs.length && prevTabs.some((tabId, index) => tabId !== nextTabs[index])
  let tabSetChanged = false
  for (const tabId of nextTabs) {
    if (!prevSet.has(tabId)) {
      tabSetChanged = true
      this.eventBus.emit(EVENT_TYPES.TAB_CREATED, this._tabEventPayload(key, tabId, { reason: 'tabs.synced' }))
    }
  }
  for (const tabId of prevTabs) {
    if (!nextSet.has(tabId)) {
      tabSetChanged = true
      this.eventBus.emit(EVENT_TYPES.TAB_CLOSED, {
        sessionId: key,
        tabId,
        activeTabId: newActive || null,
        previousActiveTabId: prevActive || null,
        reason: 'tabs.synced'
      })
    }
  }
  // Bump the session-level tab-list generation on any real add/remove, so a
  // background-tab close (invisible to the active-id / active-generation
  // detectors) still registers as a change downstream.
  if (tabSetChanged || tabOrderChanged) {
    this._tabListGeneration.set(key, (this._tabListGeneration.get(key) || 0) + 1)
  }
  // When the ACTIVE tab changes, the agent's element indices were minted
  // against the OLD active tab's DOM. Indices are per-tab and not globally
  // unique, so a stale index could otherwise resolve to a DIFFERENT element on
  // the now-active tab with no error. Clear the newly-active tab's selector map
  // so a pre-switch index hits the stale-index guard (reason 'switch-target' is
  // a PAGE_CHANGED reason) and forces the agent to re-observe the real tab.
  // Only a real SWITCH (prevActive existed and changed), not initial register.
  if (newActive && prevActive && newActive !== prevActive) {
    this.eventBus.emit(
      EVENT_TYPES.TAB_ACTIVATED,
      this._tabEventPayload(key, newActive, { previousTabId: prevActive, reason: 'tabs.synced' })
    )
    const entry = this.workbenches.get(String(newActive))
    if (entry) this._clearSelectorMap(entry, 'switch-target', { previousTabId: prevActive })
  }
  // Carry the logical control lease to the canonical active tab synchronously.
  // The page-injected operating frame reconciles independently and never delays
  // topology publication or memory-governor protection.
  const control = this._controlStates.get(key)
  let controlSnapshot = null
  if (newActive && control?.active && String(control.activeTabId || '') !== String(newActive)) {
    controlSnapshot = this._refreshControlActiveTab(key, 'active-tab-changed')
  }
  // A destroyed session group (main.cjs pushes group=null on destroy) must
  // also drop its routing context — otherwise sessionContexts kept one entry
  // per session-ever for the whole process life. (_contextForSession above
  // recreates an empty one mid-method, so delete LAST.)
  if (!next) {
    this.sessionContexts.delete(key)
    this._tabListGeneration.delete(key)
    this._deleteControlState(key, 'session-deleted')
    this._activeActionCounts.delete(key)
    this._interventions.delete(key)
  }
  return controlSnapshot
}

// ── Tab-group operations (P1). main.cjs owns the views; the runtime asks it
// via tabController and returns the resulting tab list to the agent. ──
function listTabs(sessionId) {
  const sid = String(sessionId)
  const group = this.sessionTabs.get(sid)
  if (!group) return { active: 0, tabs: [] }
  const active = this._activeTabIndex(sid, group)
  const tabs = group.tabs.map((tid, i) => {
    const e = this.workbenches.get(String(tid))
    const wc = e && !e.webContents.isDestroyed() ? e.webContents : null
    // Lazily-restored tabs have no live workbench until first activation —
    // fall back to the host-provided meta so the agent sees real url/title.
    const meta = group.tabMeta ? group.tabMeta[String(tid)] : null
    const tab = {
      tabId: String(i),
      targetId: String(tid),
      stableId: this._stableTabId(tid, sessionId),
      url: wc?.getURL?.() || meta?.url || '',
      title: wc?.getTitle?.() || meta?.title || '',
      current: i === active,
      loading: wc && typeof wc.isLoading === 'function' ? wc.isLoading() : false,
      crashed: wc && typeof wc.isCrashed === 'function' ? wc.isCrashed() : false
    }
    return tab
  })
  return { active, tabs }
}

// Observation uses the same canonical projection as listTabs. Keep the
// single-tab response quiet, but never rebuild tab metadata independently.
function _tabsSummary(entry) {
  try {
    const sessionId = String(entry?.id || '').split('#')[0] || 'main'
    const tabs = this.listTabs(sessionId).tabs
    return tabs.length < 2 ? [] : tabs
  } catch {
    return []
  }
}

// 只读、ms 级、不 attach CDP 的活动态快照(全部读内存态 / 同步 webContents API)。
// 消费方据此判定:活动页代次、各标签加载/崩溃态、未应答的原生对话框、最近一条完成下载、
// 最近一次用户介入时间戳。
function liveState(sessionId) {
  const sid = String(sessionId || 'main')
  const listed = this.listTabs(sid)
  const activeTid = this._activeTabId(sid)
  const activeEntry = this.workbenches.get(String(activeTid))
  const decisionToken = this._browserDecisionToken(sid)
  const activeGeneration = decisionToken?.pageGeneration || 0

  let pendingDialog = null
  const dlg = activeEntry?.pendingDialog
  if (dlg) pendingDialog = { type: dlg.type || '', message: dlg.message || '' }

  // 同会话多标签共享 wc.session 的 will-download,每个 watchdog 都登记 → 活动页 watchdog 的
  // downloads 已含全会话下载;取最近一条已完成(phase==='done' 或有 doneAt)。
  let recentDownload = null
  const wd = activeEntry?.watchdog
  if (Array.isArray(wd?.downloads)) {
    for (let i = wd.downloads.length - 1; i >= 0; i--) {
      const rec = wd.downloads[i]
      if (!rec || (rec.phase !== 'done' && !rec.doneAt)) continue
      const d = rec.download || {}
      const filename = d.filename || d.fileName || ''
      const filePath = d.savePath || d.path || ''
      if (filename || filePath) {
        recentDownload = { filename, path: filePath }
        break
      }
    }
  }

  // 从 eventBus 历史里找本会话最近一条 USER_INTERVENED 的 timestamp(payload.id 是标签视图 id,
  // 取其 '#' 前的会话段比对;无 id 的也算本会话)。
  let lastUserInterventionTs = null
  const history = Array.isArray(this.eventBus?.history) ? this.eventBus.history : []
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i]
    if (!ev || ev.type !== EVENT_TYPES.USER_INTERVENED) continue
    const pid = String(ev.payload?.id || '')
    if (!pid || pid.split('#')[0] === sid) {
      lastUserInterventionTs = Number(ev.timestamp) || null
      break
    }
  }

  return {
    sessionId: sid,
    active: listed.active,
    activeTabId: activeTid || null,
    activeGeneration,
    viewEpoch: decisionToken?.viewEpoch ?? null,
    documentRevision: decisionToken?.documentRevision ?? null,
    pageGeneration: decisionToken?.pageGeneration ?? null,
    selectorGeneration: decisionToken?.selectorGeneration ?? null,
    tabListGeneration: this._tabListGeneration.get(sid) || 0,
    tabs: listed.tabs,
    pendingDialog,
    recentDownload,
    lastUserInterventionTs
  }
}

async function newTab(sessionId, params = {}) {
  if (!this.tabController?.openTab) throw new Error('multi-tab not supported in this host')
  const url = String(params.url || 'about:blank')
  // 创建前预检 URL 策略(SEC-2,。BU 对非法 URL 的标签是【关闭】;
  // 我们更进一步——直接拒绝创建,连那个被中和到 about:blank 的僵尸空白标签都不留。
  const decision = this.urlPolicyDecision({ urlPolicy: this._defaultUrlPolicy }, url)
  if (!decision.allowed) {
    const error = new Error(`New tab to ${url} blocked by URL policy: ${decision.reason}`)
    error.code = 'URL_POLICY_BLOCKED'
    error.decision = decision
    this.eventBus.emit(EVENT_TYPES.NAVIGATION_FAILED, { id: String(sessionId), url, errorDescription: error.message, reason: decision.reason, source: 'newTab' })
    throw error
  }
  const tabId = await this.tabController.openTab(String(sessionId), url)
  // TAB-08:openTab 返回 null = 宿主拒绝(到上限/失败)→ 报真实错误,绝不 opened:true 谎报成功
  if (!tabId) {
    const error = new Error(`Failed to open new tab to ${url}: host rejected (tab limit reached?)`)
    error.code = 'TAB_OPEN_REJECTED'
    throw error
  }
  return { opened: true, tabId, tabs: this.listTabs(sessionId).tabs }
}

async function switchTab(sessionId, params = {}) {
  if (!this.tabController?.switchTab) throw new Error('multi-tab not supported in this host')
  const tabId = this._resolveTabId(sessionId, params.tabId ?? params.tab_id ?? params.index)
  if (!tabId) throw this._tabNotFoundError(params.tabId ?? params.tab_id ?? params.index, 'switchTab')
  const ok = await this.tabController.switchTab(String(sessionId), tabId)
  return { switched: Boolean(ok), tabId, tabs: this.listTabs(sessionId).tabs }
}

async function closeTab(sessionId, params = {}) {
  if (!this.tabController?.closeTab) throw new Error('multi-tab not supported in this host')
  const tabId = this._resolveTabId(sessionId, params.tabId ?? params.tab_id ?? params.index)
  if (!tabId) throw this._tabNotFoundError(params.tabId ?? params.tab_id ?? params.index, 'closeTab')
  const ok = await this.tabController.closeTab(String(sessionId), tabId)
  return { closed: Boolean(ok), tabId, tabs: this.listTabs(sessionId).tabs }
}

function _tabNotFoundError(reference, action) {
  const error = new Error(`tab not found: ${reference}`)
  error.code = 'TAB_NOT_FOUND'
  error.details = {
    retryable: true,
    replanRequired: true,
    action: String(action || ''),
    reason: 'tab-reference-not-found'
  }
  return error
}

// Main owns tab identity and reference parsing. Runtime never resolves against
// its delayed read projection.
function _resolveTabId(sessionId, ref) {
  if (typeof this.tabController?.resolveTab === 'function') {
    return this.tabController.resolveTab(String(sessionId), ref)
  }
  return null
}


const sessionOperations = {
  _normalizeSessionTabsGroup,
  _tabEventPayload,
  _contextForSession,
  _contextSnapshot,
  _updateBrowserContext,
  _observeRequirementAggregatePatch,
  _markObserveRequired,
  _clearObserveRequirement,
  _clearSelectorMap,
  syncSessionTabs,
  listTabs,
  _tabsSummary,
  liveState,
  newTab,
  switchTab,
  closeTab,
  _tabNotFoundError,
  _resolveTabId
}

function installSessionOperations(Runtime) {
  for (const [name, operation] of Object.entries(sessionOperations)) {
    Object.defineProperty(Runtime.prototype, name, {
      configurable: true,
      writable: true,
      value: operation
    })
  }
}

module.exports = { PAGE_CHANGED_CLEAR_REASONS, installSessionOperations }
