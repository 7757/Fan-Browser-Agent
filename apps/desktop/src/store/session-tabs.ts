import { atom } from 'nanostores'

// Live per-session browser tab state for the overview cards' tab strip (ego-style
// chrome: how many tabs + which is active). Keyed by the browser workbench id
// (== stored session id for uncompressed sessions), which is the id main.cjs
// emits on the `tabs.state` event and the id the overview tile pushes.
export interface SessionTabInfo {
  tabId: string
  title: string
  url: string
  favicon?: string
  faviconPending?: boolean
  loadFailed?: boolean
}

export interface SessionTabsState {
  active: number
  tabs: SessionTabInfo[]
}

export const $sessionTabs = atom<Record<string, SessionTabsState>>({})

export function setSessionTabs(id: string, state: SessionTabsState) {
  const key = String(id || '')

  if (!key) {
    return
  }

  const current = $sessionTabs.get()
  const prev = current[key]

  // Skip the write when nothing changed so nanostores doesn't re-render every
  // card on a no-op tabs.state re-assert.
  if (
    prev &&
    prev.active === state.active &&
    prev.tabs.length === state.tabs.length &&
    prev.tabs.every(
      (t, i) =>
        t.tabId === state.tabs[i]?.tabId &&
        t.url === state.tabs[i]?.url &&
        t.title === state.tabs[i]?.title &&
        t.favicon === state.tabs[i]?.favicon &&
        t.faviconPending === state.tabs[i]?.faviconPending &&
        t.loadFailed === state.tabs[i]?.loadFailed
    )
  ) {
    return
  }

  $sessionTabs.set({ ...current, [key]: state })
}
