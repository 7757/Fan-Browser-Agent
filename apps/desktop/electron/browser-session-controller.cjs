'use strict'

const TAB_META_FIELDS = ['url', 'title', 'favicon']

function requiredId(value, label) {
  const id = value == null ? '' : String(value)
  if (!id) throw new TypeError(`${label} must be a non-empty string`)
  return id
}

function metaValue(value) {
  return value == null ? '' : String(value)
}

function makeMeta(value = {}) {
  return {
    url: metaValue(value.url),
    title: metaValue(value.title),
    favicon: metaValue(value.favicon)
  }
}

function copyMeta(meta) {
  return {
    url: meta.url,
    title: meta.title,
    favicon: meta.favicon
  }
}

function restoredActiveIndex(tabIds, active) {
  if (typeof active === 'string') {
    const byId = tabIds.indexOf(active)
    if (byId >= 0) return byId
  }

  const numeric = Number(active)
  const index = Number.isFinite(numeric) ? Math.trunc(numeric) : 0
  return Math.max(0, Math.min(tabIds.length - 1, index))
}

class BrowserSessionController {
  constructor() {
    this._sessions = new Map()
    this._nextSessionInstance = 1
  }

  _state(sessionId) {
    return this._sessions.get(String(sessionId ?? '')) || null
  }

  _newState(sessionId, tabs, activeIndex) {
    const state = {
      activeTabId: tabs[activeIndex].id,
      instanceId: this._nextSessionInstance++,
      nextTabNumber: 1,
      sessionId,
      tabIds: tabs.map(tab => tab.id),
      tabMeta: new Map(tabs.map(tab => [tab.id, makeMeta(tab)]))
    }

    for (const tabId of state.tabIds) this._observeTabId(state, tabId)
    return state
  }

  _observeTabId(state, tabId) {
    const prefix = `${state.sessionId}#t`
    if (!tabId.startsWith(prefix)) return

    const suffix = tabId.slice(prefix.length)
    if (!/^(0|[1-9]\d*)$/.test(suffix)) return

    const sequence = Number(suffix)
    if (Number.isSafeInteger(sequence) && sequence >= state.nextTabNumber) {
      state.nextTabNumber = sequence + 1
    }
  }

  _nextTabId(state) {
    let sequence = state.nextTabNumber
    while (Number.isSafeInteger(sequence)) {
      const tabId = `${state.sessionId}#t${sequence}`
      sequence += 1
      if (!state.tabMeta.has(tabId)) {
        state.nextTabNumber = sequence
        return tabId
      }
    }
    throw new RangeError(`No stable tab id remains for session ${state.sessionId}`)
  }

  _transition(operation, sessionId, details = {}) {
    const snapshot = this.snapshot(sessionId)
    return {
      operation,
      sessionId,
      ok: details.ok !== false,
      changed: Boolean(details.changed),
      ...details,
      activeTabId: snapshot?.activeTabId ?? null,
      snapshot
    }
  }

  hasSession(sessionId) {
    return this._sessions.has(String(sessionId ?? ''))
  }

  sessionCount() {
    return this._sessions.size
  }

  sessionIds() {
    return [...this._sessions.keys()]
  }

  sessionInstanceId(sessionId) {
    return this._state(sessionId)?.instanceId ?? null
  }

  snapshot(sessionId) {
    const state = this._state(sessionId)
    if (!state) return null

    return {
      sessionId: state.sessionId,
      active: state.tabIds.indexOf(state.activeTabId),
      activeTabId: state.activeTabId,
      tabs: state.tabIds.map(id => ({ id, ...copyMeta(state.tabMeta.get(id)) }))
    }
  }

  runtimeSnapshot(sessionId) {
    const state = this._state(sessionId)
    if (!state) return null

    return {
      active: state.tabIds.indexOf(state.activeTabId),
      tabs: [...state.tabIds],
      tabMeta: Object.fromEntries(state.tabIds.map(id => [id, copyMeta(state.tabMeta.get(id))]))
    }
  }

  activeTabId(sessionId) {
    return this._state(sessionId)?.activeTabId ?? null
  }

  tabIds(sessionId) {
    const state = this._state(sessionId)
    return state ? [...state.tabIds] : []
  }

  sessionIdForTab(tabId) {
    const key = String(tabId ?? '')
    if (!key) return null
    for (const state of this._sessions.values()) {
      if (state.tabMeta.has(key)) return state.sessionId
    }
    return null
  }

  tabMeta(sessionId, tabId) {
    const state = this._state(sessionId)
    if (!state) return tabId === undefined ? {} : null

    if (tabId !== undefined) {
      const meta = state.tabMeta.get(String(tabId))
      return meta ? copyMeta(meta) : null
    }

    return Object.fromEntries(state.tabIds.map(id => [id, copyMeta(state.tabMeta.get(id))]))
  }

  resolveTabRef(sessionId, reference) {
    const state = this._state(sessionId)
    if (!state) return null
    const value = String(reference ?? '').trim()
    if (!value) return null

    if (/^\d+$/.test(value)) {
      const index = Number(value)
      if (index >= 0 && index < state.tabIds.length) return state.tabIds[index]
    }
    if (state.tabMeta.has(value)) return value

    const stable = value.match(/t(\d+)/i)
    if (stable) {
      const sequence = Number(stable[1])
      if (sequence === 0 && state.tabMeta.has(state.sessionId)) return state.sessionId
      const stableId = `${state.sessionId}#t${sequence}`
      if (state.tabMeta.has(stableId)) return stableId
    }

    const leading = value.match(/^\[?\s*(?:tab\s+)?(\d+)\b/i)
    if (leading) {
      const index = Number(leading[1])
      if (index >= 0 && index < state.tabIds.length) return state.tabIds[index]
    }
    return state.tabIds.find(tabId => tabId.endsWith(value)) || null
  }

  ensureSession(sessionId, { tabId, url } = {}) {
    const id = requiredId(sessionId, 'sessionId')
    const existing = this._sessions.get(id)
    if (existing) {
      return this._transition('ensure-session', id, {
        changed: false,
        created: false,
        tabId: existing.tabIds[0]
      })
    }

    const firstTabId = tabId == null ? id : requiredId(tabId, 'tabId')
    const state = this._newState(id, [{ id: firstTabId, url }], 0)
    this._sessions.set(id, state)
    return this._transition('ensure-session', id, {
      changed: true,
      created: true,
      tabId: firstTabId
    })
  }

  restoreSession(sessionId, { tabs, active = 0 } = {}) {
    const id = requiredId(sessionId, 'sessionId')
    if (this._sessions.has(id)) {
      return this._transition('restore-session', id, {
        changed: false,
        restored: false
      })
    }

    if (!Array.isArray(tabs) || tabs.length === 0) {
      return this._transition('restore-session', id, {
        changed: false,
        ok: false,
        reason: 'empty-tabs',
        restored: false
      })
    }

    const normalizedTabs = tabs.map(tab => {
      if (!tab || typeof tab !== 'object') {
        throw new TypeError('restore tabs must be objects')
      }
      return { id: requiredId(tab.id, 'tab.id'), ...makeMeta(tab) }
    })
    const uniqueIds = new Set(normalizedTabs.map(tab => tab.id))
    if (uniqueIds.size !== normalizedTabs.length) {
      throw new TypeError('restore tabs must have unique ids')
    }

    const activeIndex = restoredActiveIndex(
      normalizedTabs.map(tab => tab.id),
      active
    )
    this._sessions.set(id, this._newState(id, normalizedTabs, activeIndex))
    return this._transition('restore-session', id, {
      changed: true,
      restored: true
    })
  }

  appendTab(sessionId, { url, title, favicon, tabId, activate = true } = {}) {
    const id = requiredId(sessionId, 'sessionId')
    const state = this._sessions.get(id)
    if (!state) {
      return this._transition('append-tab', id, {
        changed: false,
        ok: false,
        reason: 'missing-session',
        tabId: null
      })
    }

    const nextTabId = tabId == null ? this._nextTabId(state) : requiredId(tabId, 'tabId')
    if (state.tabMeta.has(nextTabId)) {
      return this._transition('append-tab', id, {
        changed: false,
        ok: false,
        reason: 'duplicate-tab',
        tabId: nextTabId
      })
    }

    const previousActiveTabId = state.activeTabId
    state.tabIds.push(nextTabId)
    state.tabMeta.set(nextTabId, makeMeta({ url, title, favicon }))
    if (activate) state.activeTabId = nextTabId
    this._observeTabId(state, nextTabId)
    return this._transition('append-tab', id, {
      changed: true,
      previousActiveTabId,
      tabId: nextTabId
    })
  }

  activateTab(sessionId, tabId) {
    const id = requiredId(sessionId, 'sessionId')
    const state = this._sessions.get(id)
    const nextTabId = tabId == null ? '' : String(tabId)
    if (!state) {
      return this._transition('activate-tab', id, {
        changed: false,
        ok: false,
        reason: 'missing-session',
        tabId: nextTabId || null
      })
    }
    if (!state.tabMeta.has(nextTabId)) {
      return this._transition('activate-tab', id, {
        changed: false,
        ok: false,
        reason: 'unknown-tab',
        tabId: nextTabId || null
      })
    }

    const previousActiveTabId = state.activeTabId
    state.activeTabId = nextTabId
    return this._transition('activate-tab', id, {
      changed: previousActiveTabId !== nextTabId,
      previousActiveTabId,
      tabId: nextTabId
    })
  }

  removeTab(sessionId, tabId) {
    const id = requiredId(sessionId, 'sessionId')
    const state = this._sessions.get(id)
    const removedTabId = tabId == null ? '' : String(tabId)
    if (!state) {
      return this._transition('remove-tab', id, {
        changed: false,
        ok: false,
        reason: 'missing-session',
        removed: false,
        removedTabId: removedTabId || null
      })
    }

    const removedIndex = state.tabIds.indexOf(removedTabId)
    if (removedIndex < 0) {
      return this._transition('remove-tab', id, {
        changed: false,
        ok: false,
        reason: 'unknown-tab',
        removed: false,
        removedTabId: removedTabId || null
      })
    }
    if (state.tabIds.length === 1) {
      return this._transition('remove-tab', id, {
        changed: false,
        ok: false,
        reason: 'last-tab',
        removed: false,
        removedTabId
      })
    }

    const previousActiveTabId = state.activeTabId
    state.tabIds.splice(removedIndex, 1)
    state.tabMeta.delete(removedTabId)
    if (previousActiveTabId === removedTabId) {
      state.activeTabId = state.tabIds[Math.min(removedIndex, state.tabIds.length - 1)]
    }

    return this._transition('remove-tab', id, {
      changed: true,
      previousActiveTabId,
      removed: true,
      removedTabId
    })
  }

  reorderTab(sessionId, tabId, toIndex) {
    const id = requiredId(sessionId, 'sessionId')
    const state = this._sessions.get(id)
    const movedTabId = tabId == null ? '' : String(tabId)
    if (!state) {
      return this._transition('reorder-tab', id, {
        changed: false,
        ok: false,
        reason: 'missing-session',
        tabId: movedTabId || null
      })
    }

    const fromIndex = state.tabIds.indexOf(movedTabId)
    if (fromIndex < 0) {
      return this._transition('reorder-tab', id, {
        changed: false,
        ok: false,
        reason: 'unknown-tab',
        tabId: movedTabId || null
      })
    }

    const numericIndex = Number(toIndex)
    if (!Number.isFinite(numericIndex)) {
      return this._transition('reorder-tab', id, {
        changed: false,
        fromIndex,
        ok: false,
        reason: 'invalid-index',
        tabId: movedTabId
      })
    }

    const nextIndex = Math.max(0, Math.min(state.tabIds.length - 1, Math.trunc(numericIndex)))
    if (fromIndex !== nextIndex) {
      const [moved] = state.tabIds.splice(fromIndex, 1)
      state.tabIds.splice(nextIndex, 0, moved)
    }

    return this._transition('reorder-tab', id, {
      changed: fromIndex !== nextIndex,
      fromIndex,
      tabId: movedTabId,
      toIndex: nextIndex
    })
  }

  patchTabMeta(sessionId, tabId, patch = {}) {
    const id = requiredId(sessionId, 'sessionId')
    const state = this._sessions.get(id)
    const patchedTabId = tabId == null ? '' : String(tabId)
    if (!state) {
      return this._transition('patch-tab-meta', id, {
        changed: false,
        ok: false,
        reason: 'missing-session',
        tabId: patchedTabId || null
      })
    }

    const current = state.tabMeta.get(patchedTabId)
    if (!current) {
      return this._transition('patch-tab-meta', id, {
        changed: false,
        ok: false,
        reason: 'unknown-tab',
        tabId: patchedTabId || null
      })
    }

    let changed = false
    if (patch && typeof patch === 'object') {
      for (const field of TAB_META_FIELDS) {
        if (!Object.hasOwn(patch, field) || patch[field] === undefined) continue
        const nextValue = metaValue(patch[field])
        if (current[field] !== nextValue) {
          current[field] = nextValue
          changed = true
        }
      }
    }

    return this._transition('patch-tab-meta', id, {
      changed,
      tabId: patchedTabId
    })
  }

  deleteSession(sessionId) {
    const id = requiredId(sessionId, 'sessionId')
    const previousSnapshot = this.snapshot(id)
    if (!previousSnapshot) {
      return this._transition('delete-session', id, {
        changed: false,
        deleted: false,
        ok: false,
        reason: 'missing-session'
      })
    }

    const deletedTabIds = previousSnapshot.tabs.map(tab => tab.id)
    const previousActiveTabId = previousSnapshot.activeTabId
    this._sessions.delete(id)
    return this._transition('delete-session', id, {
      changed: true,
      deleted: true,
      deletedTabIds,
      previousActiveTabId,
      previousSnapshot
    })
  }
}

module.exports = { BrowserSessionController }
