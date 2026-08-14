import { atom, computed, type ReadableAtom } from 'nanostores'

import {
  arraysEqual,
  insertUniqueId,
  persistNumber,
  persistStringArray,
  storedNumber,
  storedStringArray
} from '@/lib/storage'

import { $paneStates, ensurePaneRegistered } from './panes'

export const FILE_BROWSER_DEFAULT_WIDTH = '17rem'
export const FILE_BROWSER_MIN_WIDTH = '14rem'
export const FILE_BROWSER_MAX_WIDTH = '20rem'

// Split mode shows the embedded Chromium WebContentsView beside a resizable
// conversation panel (see app/chat/session-view). Either surface can also own
// the full session area; this width is retained for the next return to split.
// The browser is not a registered Pane — it is composed inside the session
// route and needs no pane bookkeeping.
const SESSION_CHAT_PANEL_DEFAULT_WIDTH = 360
// Min = default: the composer controls row (attach + auto-review pill + model
// chip + send) is laid out for the default width — anything narrower collides.
const SESSION_CHAT_PANEL_MIN_WIDTH = SESSION_CHAT_PANEL_DEFAULT_WIDTH
const SESSION_CHAT_PANEL_MAX_WIDTH = 720
export const SESSION_BROWSER_PANEL_MIN_WIDTH = 420
export const SESSION_VIEW_SPLIT_GAP = 6
export const SESSION_VIEW_HORIZONTAL_PADDING = 16
export const SESSION_VIEW_SPLIT_MIN_WIDTH =
  SESSION_CHAT_PANEL_MIN_WIDTH +
  SESSION_BROWSER_PANEL_MIN_WIDTH +
  SESSION_VIEW_SPLIT_GAP +
  SESSION_VIEW_HORIZONTAL_PADDING

const SIDEBAR_SESSIONS_PAGE_SIZE = 50

const SIDEBAR_PINNED_STORAGE_KEY = 'fan.desktop.pinnedSessions'
const SESSION_CHAT_WIDTH_STORAGE_KEY = 'fan.desktop.sessionChatWidth'

export const FILE_BROWSER_PANE_ID = 'file-browser'
export const RIGHT_RAIL_PREVIEW_TAB_ID = 'preview'

export type RightRailTabId = typeof RIGHT_RAIL_PREVIEW_TAB_ID | `file:${string}`

ensurePaneRegistered(FILE_BROWSER_PANE_ID, { open: false })

export const $fileBrowserOpen: ReadableAtom<boolean> = computed(
  $paneStates,
  states => states[FILE_BROWSER_PANE_ID]?.open ?? false
)

export const $rightRailActiveTabId = atom<RightRailTabId>(RIGHT_RAIL_PREVIEW_TAB_ID)

export const $pinnedSessionIds = atom(storedStringArray(SIDEBAR_PINNED_STORAGE_KEY))
export const $sessionsLimit = atom(SIDEBAR_SESSIONS_PAGE_SIZE)

// Width of the in-session conversation panel (the browser fills the rest).
export function clampSessionChatWidth(width: number, availableWidth = Number.POSITIVE_INFINITY) {
  const safeWidth = Number.isFinite(width) ? width : SESSION_CHAT_PANEL_DEFAULT_WIDTH

  const availableMax = Number.isFinite(availableWidth)
    ? Math.max(SESSION_CHAT_PANEL_MIN_WIDTH, Math.round(availableWidth))
    : SESSION_CHAT_PANEL_MAX_WIDTH

  const effectiveMax = Math.min(SESSION_CHAT_PANEL_MAX_WIDTH, availableMax)

  return Math.min(effectiveMax, Math.max(SESSION_CHAT_PANEL_MIN_WIDTH, Math.round(safeWidth)))
}

export function clampSessionChatWidthForContainer(width: number, containerWidth: number) {
  const availableChatWidth =
    containerWidth - SESSION_VIEW_HORIZONTAL_PADDING - SESSION_VIEW_SPLIT_GAP - SESSION_BROWSER_PANEL_MIN_WIDTH

  return clampSessionChatWidth(width, availableChatWidth)
}

export const $sessionChatWidth = atom(
  clampSessionChatWidth(storedNumber(SESSION_CHAT_WIDTH_STORAGE_KEY, SESSION_CHAT_PANEL_DEFAULT_WIDTH))
)

$pinnedSessionIds.subscribe(ids => persistStringArray(SIDEBAR_PINNED_STORAGE_KEY, [...ids]))
$sessionChatWidth.subscribe(width => persistNumber(SESSION_CHAT_WIDTH_STORAGE_KEY, width))

export function setSessionChatWidth(width: number) {
  $sessionChatWidth.set(clampSessionChatWidth(width))
}

export function selectRightRailTab(id: RightRailTabId) {
  $rightRailActiveTabId.set(id)
}

export function pinSession(sessionId: string, index?: number) {
  const prev = $pinnedSessionIds.get()
  const next = insertUniqueId(prev, sessionId, index ?? prev.filter(id => id !== sessionId).length)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}

export function unpinSession(sessionId: string) {
  const prev = $pinnedSessionIds.get()
  const next = prev.filter(id => id !== sessionId)

  if (!arraysEqual(prev, next)) {
    $pinnedSessionIds.set(next)
  }
}
