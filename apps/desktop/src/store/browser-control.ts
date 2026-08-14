import { atom, computed, type ReadableAtom } from 'nanostores'

import type { FanBrowserControlState } from '@/global'
import { $followTab, type FollowTabState } from '@/store/browser-tabs'
import { $activeBrowserWorkbenchId } from '@/store/session'

export interface BrowserControlIdentity {
  favicon?: string
  faviconPending?: boolean
  loadFailed?: boolean
  provisional: boolean
  title: string
  url: string
}

export interface ActiveBrowserControl {
  activeTabId: string | null
  controlId: string
  id: string
  identity: BrowserControlIdentity
  initialUrl: string
  revision: number
  startedAt: number | null
  targetUrl: string
  toolCallId: string
  toolName: string
  updatedAt: number | null
  workbenchId: string
}

interface BrowserControlRecord {
  active: boolean
  activeTabId: string | null
  controlId: string | null
  id: string
  initialUrl: string
  revision: number
  startedAt: number | null
  targetUrl: string
  toolCallId: string
  toolName: string
  updatedAt: number | null
  workbenchId: string
}

interface BrowserOperatingRecord {
  active: boolean
  id: string
  revision: number
}

const $browserControls = atom<Record<string, BrowserControlRecord>>({})
const $browserOperatingStates = atom<Record<string, BrowserOperatingRecord>>({})

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeControl(value: unknown): BrowserControlRecord | null {
  const state = objectValue(value)

  if (!state) {
    return null
  }

  const id = typeof state.id === 'string' ? state.id : ''
  const workbenchId = typeof state.workbenchId === 'string' ? state.workbenchId : ''
  const active = state.active === true
  const controlId = typeof state.controlId === 'string' && state.controlId ? state.controlId : null
  const revision = finiteNumber(state.revision)

  if (
    !id ||
    !workbenchId ||
    id !== workbenchId ||
    (active && !controlId) ||
    revision === null ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (state.activeTabId != null && typeof state.activeTabId !== 'string') ||
    (state.initialUrl != null && typeof state.initialUrl !== 'string') ||
    (state.startedAt != null && finiteNumber(state.startedAt) === null) ||
    (state.targetUrl != null && typeof state.targetUrl !== 'string') ||
    (state.toolCallId != null && typeof state.toolCallId !== 'string') ||
    (state.toolName != null && typeof state.toolName !== 'string') ||
    (state.updatedAt != null && finiteNumber(state.updatedAt) === null)
  ) {
    return null
  }

  return {
    active,
    activeTabId: typeof state.activeTabId === 'string' && state.activeTabId ? state.activeTabId : null,
    controlId,
    id,
    initialUrl: typeof state.initialUrl === 'string' ? state.initialUrl : '',
    revision,
    startedAt: finiteNumber(state.startedAt),
    targetUrl: typeof state.targetUrl === 'string' ? state.targetUrl : '',
    toolCallId: typeof state.toolCallId === 'string' ? state.toolCallId : '',
    toolName: typeof state.toolName === 'string' ? state.toolName : '',
    updatedAt: finiteNumber(state.updatedAt),
    workbenchId
  }
}

function setControlRecord(next: BrowserControlRecord): boolean {
  const records = $browserControls.get()
  const previous = records[next.id]

  if (previous && next.revision <= previous.revision) {
    return false
  }

  $browserControls.set({ ...records, [next.id]: next })

  return true
}

function setOperatingRecord(next: BrowserOperatingRecord): boolean {
  const records = $browserOperatingStates.get()
  const previous = records[next.id]

  if (previous && next.revision <= previous.revision) {
    return false
  }

  $browserOperatingStates.set({ ...records, [next.id]: next })

  return true
}

function normalizeOperating(value: unknown): BrowserOperatingRecord | null {
  const state = objectValue(value)

  if (!state) {
    return null
  }

  const id = typeof state.id === 'string' ? state.id : ''
  const workbenchId = typeof state.workbenchId === 'string' ? state.workbenchId : ''
  const revision = finiteNumber(state.revision)

  if (
    !id ||
    !workbenchId ||
    id !== workbenchId ||
    typeof state.active !== 'boolean' ||
    revision === null ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return null
  }

  return { active: state.active, id, revision }
}

function hostnameFor(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function identityFor(control: BrowserControlRecord, followTab: FollowTabState | null): BrowserControlIdentity {
  // A tab id is identity. URLs are page data and may legitimately change during
  // redirects, login hand-offs and script navigation.
  if (
    followTab &&
    followTab.workbenchId === control.workbenchId &&
    (!control.activeTabId || followTab.tabId === control.activeTabId)
  ) {
    return {
      favicon: followTab.favicon,
      faviconPending: followTab.faviconPending,
      loadFailed: followTab.loadFailed,
      provisional: false,
      title: followTab.title.trim() || hostnameFor(followTab.url) || followTab.url || '新标签页',
      url: followTab.url
    }
  }

  if (control.targetUrl) {
    return {
      provisional: true,
      title: hostnameFor(control.targetUrl) || control.targetUrl,
      url: control.targetUrl
    }
  }

  return { provisional: false, title: '浏览器', url: '' }
}

export function applyBrowserControlEvent(type: string, payload: unknown): boolean {
  if (type !== 'control.state') {
    return false
  }

  const normalized = normalizeControl(payload)

  return normalized ? setControlRecord(normalized) : false
}

export function applyBrowserOperatingEvent(type: string, payload: unknown): boolean {
  if (type !== 'operating.state') {
    return false
  }

  const normalized = normalizeOperating(payload)

  return normalized ? setOperatingRecord(normalized) : false
}

export function markBrowserOperatingStateKnownIdle(workbenchId: null | string | undefined): void {
  const id = workbenchId?.trim()

  if (!id || $browserOperatingStates.get()[id]) {
    return
  }

  setOperatingRecord({ active: false, id, revision: 0 })
}

export function restoreBrowserControlState(state: FanBrowserControlState): boolean {
  const normalized = normalizeControl(state)

  if (!normalized) {
    return false
  }

  const controlAccepted = setControlRecord(normalized)
  const operatingRevision = finiteNumber(state.operatingRevision)

  const operatingAccepted = setOperatingRecord({
    active: typeof state.operating === 'boolean' ? state.operating : normalized.active,
    id: normalized.id,
    revision:
      operatingRevision !== null && Number.isSafeInteger(operatingRevision) && operatingRevision >= 0
        ? operatingRevision
        : normalized.revision
  })

  return controlAccepted || operatingAccepted
}

export const $activeBrowserOperating: ReadableAtom<boolean> = computed(
  [$browserOperatingStates, $activeBrowserWorkbenchId],
  (states, activeId) => Boolean(activeId && states[activeId]?.active)
)

export const $activeBrowserOperatingKnown: ReadableAtom<boolean> = computed(
  [$browserOperatingStates, $activeBrowserWorkbenchId],
  (states, activeId) => !activeId || Object.prototype.hasOwnProperty.call(states, activeId)
)

export const $activeBrowserControl: ReadableAtom<ActiveBrowserControl | null> = computed(
  [$browserControls, $activeBrowserWorkbenchId, $followTab],
  (controls, activeId, followTab) => {
    if (!activeId) {
      return null
    }

    const control = controls[activeId]

    if (!control?.active || !control.controlId) {
      return null
    }

    return {
      activeTabId: control.activeTabId,
      controlId: control.controlId,
      id: control.id,
      identity: identityFor(control, followTab),
      initialUrl: control.initialUrl,
      revision: control.revision,
      startedAt: control.startedAt,
      targetUrl: control.targetUrl,
      toolCallId: control.toolCallId,
      toolName: control.toolName,
      updatedAt: control.updatedAt,
      workbenchId: control.workbenchId
    }
  }
)
