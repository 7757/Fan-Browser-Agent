import { atom, computed, type ReadableAtom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

import {
  $activeBrowserControl,
  $activeBrowserOperating
} from './browser-control'
import { $collectRequest } from './collect'
import { $nativeOverlaySuppressed } from './native-overlay'
import { $approvalRequest, $controlRequest, $secretRequest, $sudoRequest, $verificationRequest } from './prompts'
import { $activeBrowserWorkbenchId } from './session'

export type SessionLayoutMode = 'browser' | 'chat' | 'split'

export interface SessionLayoutConstraints {
  browserRequired: boolean
  chatRequired: boolean
}

interface ResolveSessionLayoutOptions extends SessionLayoutConstraints {
  browserAutoRevealed?: boolean
}

const SESSION_LAYOUT_MODE_STORAGE_KEY = 'fan.desktop.sessionLayoutMode'
const DEFAULT_SESSION_LAYOUT_MODE: SessionLayoutMode = 'split'

function isSessionLayoutMode(value: unknown): value is SessionLayoutMode {
  return value === 'browser' || value === 'chat' || value === 'split'
}

export function normalizeSessionLayoutMode(value: unknown): SessionLayoutMode {
  return isSessionLayoutMode(value) ? value : DEFAULT_SESSION_LAYOUT_MODE
}

export function sessionLayoutModeAllowed(mode: SessionLayoutMode, constraints: SessionLayoutConstraints): boolean {
  if (mode === 'chat') {
    return !constraints.browserRequired
  }

  if (mode === 'browser') {
    return !constraints.chatRequired
  }

  return true
}

export function resolveSessionLayoutMode(
  preferredMode: SessionLayoutMode,
  options: ResolveSessionLayoutOptions
): SessionLayoutMode {
  const baseMode = options.browserAutoRevealed && preferredMode === 'chat' ? 'split' : preferredMode
  const browserVisible = baseMode !== 'chat' || options.browserRequired
  const chatVisible = baseMode !== 'browser' || options.chatRequired

  if (browserVisible && chatVisible) {
    return 'split'
  }

  return browserVisible ? 'browser' : 'chat'
}

export const $sessionLayoutPreference = atom<SessionLayoutMode>(
  normalizeSessionLayoutMode(storedString(SESSION_LAYOUT_MODE_STORAGE_KEY))
)

// Agent-triggered reveals are intentionally session-scoped and in-memory. They
// keep the resulting page visible after control ends without overwriting the
// user's explicit default; a restart returns to that preference.
export const $sessionBrowserAutoRevealIds = atom<string[]>([])

export const $sessionLayoutConstraints: ReadableAtom<SessionLayoutConstraints> = computed(
  [
    $activeBrowserControl,
    $activeBrowserOperating,
    $nativeOverlaySuppressed,
    $collectRequest,
    $approvalRequest,
    $controlRequest,
    $secretRequest,
    $sudoRequest,
    $verificationRequest
  ],
  (
    browserControl,
    browserOperating,
    nativeOverlaySuppressed,
    collect,
    approval,
    control,
    secret,
    sudo,
    verification
  ) => ({
    // Only an authoritative active operation/control may override chat-only.
    // Treating an unhydrated workbench as active made a plain first message
    // (which creates/binds the workbench) unexpectedly switch to split view.
    browserRequired: browserOperating || browserControl !== null,
    chatRequired: Boolean(
      nativeOverlaySuppressed ||
        collect ||
        approval ||
        control ||
        secret ||
        sudo ||
        verification
    )
  })
)

export const $effectiveSessionLayoutMode: ReadableAtom<SessionLayoutMode> = computed(
  [$sessionLayoutPreference, $sessionBrowserAutoRevealIds, $activeBrowserWorkbenchId, $sessionLayoutConstraints],
  (preferredMode, autoRevealIds, workbenchId, constraints) =>
    resolveSessionLayoutMode(preferredMode, {
      ...constraints,
      browserAutoRevealed: Boolean(workbenchId && autoRevealIds.includes(workbenchId))
    })
)

$sessionLayoutPreference.subscribe(mode => persistString(SESSION_LAYOUT_MODE_STORAGE_KEY, mode))

export function markSessionBrowserAutoRevealed(workbenchId: null | string | undefined): void {
  const id = workbenchId?.trim()

  if (!id) {
    return
  }

  const current = $sessionBrowserAutoRevealIds.get()

  if (!current.includes(id)) {
    $sessionBrowserAutoRevealIds.set([...current, id])
  }
}

/**
 * The sole user-intent entry point. The effective-mode resolver is still a
 * backstop, but rejecting invalid intent here prevents a forbidden choice from
 * being silently queued and applied when the Agent releases control.
 */
export function selectSessionLayoutMode(mode: SessionLayoutMode): boolean {
  const normalized = normalizeSessionLayoutMode(mode)

  if (!sessionLayoutModeAllowed(normalized, $sessionLayoutConstraints.get())) {
    return false
  }

  // The saved preference is global, so a new explicit choice supersedes every
  // session-scoped automatic reveal and bounds the in-memory override set.
  $sessionBrowserAutoRevealIds.set([])
  $sessionLayoutPreference.set(normalized)

  return true
}
