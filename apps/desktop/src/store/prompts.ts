import { atom, computed, type ReadableAtom } from 'nanostores'

import { $activeSessionId } from './session'

// Blocking interactive prompts the gateway raises mid-turn. Each maps to a
// `*.request` event the Python side emits while it blocks the agent thread
// waiting for a `*.respond` RPC. Without a renderer for these, the agent
// silently stalls until its timeout (default 5 min) and the tool is BLOCKED.
//
// Every prompt is parked under the runtime session id that raised
// it (not one shared slot), so a *background* session running concurrently can
// raise an approval/sudo/secret prompt and have it wait — surfaced via the
// sidebar "needs input" badge — until the user switches to that chat. The
// exported $*Request view is scoped to the active session, so a background
// prompt never hijacks the foreground.

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

interface KeyedPrompt {
  sessionId: string | null
}

interface PromptStore<T extends KeyedPrompt> {
  $active: ReadableAtom<null | T>
  clear: (sessionId?: string | null, requestId?: string) => void
  has: (sessionId?: string | null) => boolean
  reset: () => void
  set: (request: T) => void
}

// Every prompt kind is queued per session. A stale response removes only its
// matching request, so a later prompt cannot be overwritten or dismissed.
function queuedPromptStore<T extends KeyedPrompt & { requestId: string }>(): PromptStore<T> {
  const $all = atom<Record<string, T[]>>({})

  return {
    $active: computed([$all, $activeSessionId], (all, activeId) => all[keyFor(activeId)]?.[0] ?? null),
    has: sessionId => ($all.get()[keyFor(sessionId)]?.length ?? 0) > 0,
    reset: () => $all.set({}),
    set(request) {
      const key = keyFor(request.sessionId)
      const queue = $all.get()[key] ?? []

      if (queue.some(item => item.requestId === request.requestId)) {
        return
      }

      $all.set({ ...$all.get(), [key]: [...queue, request] })
    },
    clear(sessionId, requestId) {
      const all = $all.get()

      if (sessionId !== undefined) {
        const key = keyFor(sessionId)
        const queue = all[key] ?? []
        const remaining = requestId ? queue.filter(item => item.requestId !== requestId) : []
        const next = { ...all }

        if (remaining.length) {
          next[key] = remaining
        } else {
          delete next[key]
        }

        $all.set(next)

        return
      }

      if (!requestId) {
        $all.set({})

        return
      }

      const next = Object.fromEntries(
        Object.entries(all)
          .map(([key, queue]) => [key, queue.filter(item => item.requestId !== requestId)] as const)
          .filter(([, queue]) => queue.length)
      )

      $all.set(next)
    }
  }
}

export interface ApprovalRequest extends KeyedPrompt {
  // Only an explicit false hides "Always allow" — set when the backend will not
  // honor a permanent allow (a tirith content-security warning is present), so
  // the bar doesn't offer a choice that silently degrades to session scope.
  allowPermanent?: boolean
  command: string
  description: string
  requestId: string
}

interface SudoRequest extends KeyedPrompt {
  requestId: string
}

interface SecretRequest extends KeyedPrompt {
  envVar: string
  prompt: string
  requestId: string
}

// Browser human-in-the-loop, both _block()-style (request/respond by request_id):
//   verification — a captcha / human-verification challenge on the page
//   control      — the user took manual control of the shared browser
// Both pause the agent thread. Control waits for the user to hand the browser
// back explicitly; verification resumes only when the runtime sees the captcha
// clear. Either request may also be stopped by interrupting the task.
interface VerificationRequest extends KeyedPrompt {
  captchaType?: string
  challengeId?: string
  documentRevision?: number
  message: string
  requestId: string
  url?: string
}

interface ControlRequest extends KeyedPrompt {
  message: string
  requestId: string
  url?: string
  // Runtime user-input detection arrives before the Python tool can finish
  // settling its accepted native action and publish control.request.
  // `provisional` renders the immediate non-actionable "pausing" state;
  // `settling` keeps Continue disabled until control.state becomes inactive.
  provisional?: boolean
  settling?: boolean
  // 'tab' when the takeover was a tab-strip op (switch/new) rather than a page
  // click; drives the "切回工作标签" button label. anchor/user tab ids are carried
  // for diagnostics — the actual switch-back happens in the runtime on 继续.
  tabKind?: string
  anchorTabId?: string
  userTabId?: string
  inputKind?: string
  interventionId?: string
  interventionTimestamp?: number
}

const approval = queuedPromptStore<ApprovalRequest>()
const sudo = queuedPromptStore<SudoRequest>()
const secret = queuedPromptStore<SecretRequest>()
const verification = queuedPromptStore<VerificationRequest>()
const control = queuedPromptStore<ControlRequest>()
const $approvalInlineAnchorCount = atom(0)

export const $approvalRequest = approval.$active
export const setApprovalRequest = approval.set
export const clearApprovalRequest = approval.clear
export const $approvalInlineVisible = computed($approvalInlineAnchorCount, count => count > 0)

export function registerApprovalInlineAnchor(): () => void {
  $approvalInlineAnchorCount.set($approvalInlineAnchorCount.get() + 1)

  return () => {
    $approvalInlineAnchorCount.set(Math.max(0, $approvalInlineAnchorCount.get() - 1))
  }
}

export const $sudoRequest = sudo.$active
export const setSudoRequest = sudo.set
export const clearSudoRequest = sudo.clear

export const $secretRequest = secret.$active
export const setSecretRequest = secret.set
export const clearSecretRequest = secret.clear

export const $verificationRequest = verification.$active
export const setVerificationRequest = verification.set
export const clearVerificationRequest = verification.clear

export const $controlRequest = control.$active
export const setControlRequest = control.set
export const clearControlRequest = control.clear

// Drop in-flight prompts for `sessionId` (a turn ended) across every kind — or
// every parked prompt when no session is given (global reset / tests).
export function clearAllPrompts(sessionId?: string | null): void {
  if (sessionId === undefined) {
    approval.reset()
    sudo.reset()
    secret.reset()
    verification.reset()
    control.reset()
    $approvalInlineAnchorCount.set(0)

    return
  }

  approval.clear(sessionId)
  sudo.clear(sessionId)
  secret.clear(sessionId)
  verification.clear(sessionId)
  control.clear(sessionId)
}

export function hasAnyPrompt(sessionId: string | null | undefined): boolean {
  return (
    approval.has(sessionId) ||
    sudo.has(sessionId) ||
    secret.has(sessionId) ||
    verification.has(sessionId) ||
    control.has(sessionId)
  )
}
