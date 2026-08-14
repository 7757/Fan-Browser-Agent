import { atom } from 'nanostores'

export interface FollowTabState {
  tabId: string
  workbenchId: string
  title: string
  url: string
  favicon?: string
  faviconPending?: boolean
  loadFailed?: boolean
  tabCount: number
}

// The embedded-browser tab the chat console currently "follows" — the foreground
// session's active tab. `null` when no browser is open. Published by the single
// SessionBrowser instance from tabs.state events (it already owns the authoritative
// tab list); read by the composer Follow chip, which lives outside SessionBrowser
// and so cannot reach its local state directly.
export const $followTab = atom<FollowTabState | null>(null)

export function setFollowTab(state: FollowTabState | null): void {
  $followTab.set(state)
}
