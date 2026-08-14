import { useStore } from '@nanostores/react'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'

import type { ChatMessage } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import { setMutableRef } from '@/lib/mutable-ref'
import {
  $busy,
  noteSessionActivity,
  setSessionAttention,
  setSessionWorking
} from '@/store/session'

import type { ClientSessionState } from '../../types'

interface SessionStateCacheOptions {
  activeSessionId: string | null
  busyRef: MutableRefObject<boolean>
  selectedStoredSessionId: string | null
  setAwaitingResponse: (awaiting: boolean) => void
  setBusy: (busy: boolean) => void
  setMessages: (messages: ChatMessage[]) => void
}

// Keep instant switching for the current working set without retaining every
// transcript/tool result for the lifetime of the renderer. Busy/attention
// sessions are exempt and the durable runtime mapping remains available for a
// fast gateway resume when an idle state has been evicted.
const MAX_RETAINED_IDLE_SESSION_STATES = 2

export function useSessionStateCache({
  activeSessionId,
  busyRef,
  selectedStoredSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages
}: SessionStateCacheOptions) {
  const busy = useStore($busy)
  const activeSessionIdRef = useRef<string | null>(null)
  const selectedStoredSessionIdRef = useRef<string | null>(null)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const runtimeIdByStoredSessionIdRef = useRef(new Map<string, string>())
  const sessionStateTouchedAtRef = useRef(new Map<string, number>())
  const pendingViewStateRef = useRef<{ sessionId: string; state: ClientSessionState } | null>(null)
  const viewSyncRafRef = useRef<number | null>(null)

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId
  }, [activeSessionId])

  useEffect(() => {
    setMutableRef(busyRef, busy)
  }, [busy, busyRef])

  useEffect(() => {
    selectedStoredSessionIdRef.current = selectedStoredSessionId
  }, [selectedStoredSessionId])

  const ensureSessionState = useCallback((sessionId: string, storedSessionId?: string | null) => {
    const existing = sessionStateByRuntimeIdRef.current.get(sessionId)
    sessionStateTouchedAtRef.current.set(sessionId, Date.now())

    if (existing) {
      if (storedSessionId !== undefined) {
        const previousStoredSessionId = existing.storedSessionId
        existing.storedSessionId = storedSessionId

        if (storedSessionId) {
          runtimeIdByStoredSessionIdRef.current.set(storedSessionId, sessionId)

          if (existing.busy) {
            setSessionWorking(storedSessionId, true)
          }

          if (existing.needsInput) {
            setSessionAttention(storedSessionId, true)
          }
        }

        if (previousStoredSessionId && previousStoredSessionId !== storedSessionId) {
          setSessionWorking(previousStoredSessionId, false)
          setSessionAttention(previousStoredSessionId, false)
        }
      }

      return existing
    }

    const created = createClientSessionState(storedSessionId ?? null)
    sessionStateByRuntimeIdRef.current.set(sessionId, created)

    if (storedSessionId) {
      runtimeIdByStoredSessionIdRef.current.set(storedSessionId, sessionId)
    }

    return created
  }, [])

  const trimIdleSessionStates = useCallback((protectedSessionId?: string | null) => {
    const idle = [...sessionStateByRuntimeIdRef.current.entries()]
      .filter(
        ([sessionId, state]) =>
          sessionId !== protectedSessionId && !state.busy && !state.awaitingResponse && !state.needsInput
      )
      .sort(
        ([leftId], [rightId]) =>
          (sessionStateTouchedAtRef.current.get(leftId) || 0) -
          (sessionStateTouchedAtRef.current.get(rightId) || 0)
      )

    const evictCount = Math.max(0, idle.length - MAX_RETAINED_IDLE_SESSION_STATES)

    for (const [sessionId] of idle.slice(0, evictCount)) {
      sessionStateByRuntimeIdRef.current.delete(sessionId)
      sessionStateTouchedAtRef.current.delete(sessionId)
    }
  }, [])

  useEffect(() => {
    if (activeSessionId) {
      sessionStateTouchedAtRef.current.set(activeSessionId, Date.now())
    }

    trimIdleSessionStates(activeSessionId)
  }, [activeSessionId, trimIdleSessionStates])

  const flushPendingViewState = useCallback(() => {
    const pending = pendingViewStateRef.current
    pendingViewStateRef.current = null

    if (!pending || pending.sessionId !== activeSessionIdRef.current) {
      return
    }

    // Paint the target session's OWN cache directly. Local error bubbles are
    // written cache-first (failAssistantMessage→updateSessionState), so the cache
    // is authoritative; the old preserve-from-$messages pulled the OUTGOING
    // session's error bubbles into this one on a cross-session switch (串台).
    setMessages(pending.state.messages)
    setBusy(pending.state.busy)
    setMutableRef(busyRef, pending.state.busy)
    setAwaitingResponse(pending.state.awaitingResponse)
  }, [busyRef, setAwaitingResponse, setBusy, setMessages])

  const syncSessionStateToView = useCallback(
    (sessionId: string, state: ClientSessionState) => {
      // Only the currently-viewed session may stage into the shared `$messages`
      // view. A background session (e.g. one still busy and emitting stream /
      // error updates after the user toggled away) must update its own cache
      // entry but never the view — otherwise its messages clobber the
      // foreground transcript and appear to "bleed" into every other session.
      // The flush below also re-checks the active id, but staging here is what
      // prevents a background write from overwriting an already-pending
      // foreground write within the same animation frame (only one RAF is
      // scheduled, so the last `pendingViewStateRef` writer would otherwise win).
      if (sessionId !== activeSessionIdRef.current) {
        return
      }

      pendingViewStateRef.current = { sessionId, state }

      if (viewSyncRafRef.current !== null) {
        return
      }

      if (typeof window === 'undefined') {
        flushPendingViewState()

        return
      }

      viewSyncRafRef.current = window.requestAnimationFrame(() => {
        viewSyncRafRef.current = null
        flushPendingViewState()
      })
    },
    [flushPendingViewState]
  )

  useEffect(
    () => () => {
      if (viewSyncRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(viewSyncRafRef.current)
        viewSyncRafRef.current = null
      }
    },
    []
  )

  const updateSessionState = useCallback(
    (
      sessionId: string,
      updater: (state: ClientSessionState) => ClientSessionState,
      storedSessionId?: string | null
    ) => {
      const previous = ensureSessionState(sessionId, storedSessionId)
      const next = updater({ ...previous, messages: previous.messages })
      sessionStateByRuntimeIdRef.current.set(sessionId, next)
      sessionStateTouchedAtRef.current.set(sessionId, Date.now())

      if (previous.storedSessionId !== next.storedSessionId || !next.busy) {
        setSessionWorking(previous.storedSessionId, false)
      }

      if (previous.storedSessionId !== next.storedSessionId || !next.needsInput) {
        setSessionAttention(previous.storedSessionId, false)
      }

      setSessionWorking(next.storedSessionId, next.busy)
      setSessionAttention(next.storedSessionId, next.needsInput)

      // Every state update is effectively a "still alive" heartbeat for
      // streaming events. The session-store watchdog uses this to keep the
      // working flag alive during long-running turns and to clear it once
      // the stream goes silent.
      if (next.busy) {
        noteSessionActivity(next.storedSessionId)
      }

      syncSessionStateToView(sessionId, next)
      trimIdleSessionStates(activeSessionIdRef.current)

      return next
    },
    [ensureSessionState, syncSessionStateToView, trimIdleSessionStates]
  )

  const releaseSessionState = useCallback((sessionId?: string | null, storedSessionId?: string | null) => {
    const resolvedSessionId = sessionId || (storedSessionId ? runtimeIdByStoredSessionIdRef.current.get(storedSessionId) : null)
    const state = resolvedSessionId ? sessionStateByRuntimeIdRef.current.get(resolvedSessionId) : null
    const resolvedStoredSessionId = storedSessionId || state?.storedSessionId || null
    const storedAliases = resolvedSessionId
      ? [...runtimeIdByStoredSessionIdRef.current.entries()]
          .filter(([, runtimeId]) => runtimeId === resolvedSessionId)
          .map(([storedId]) => storedId)
      : []

    if (pendingViewStateRef.current?.sessionId === resolvedSessionId) {
      pendingViewStateRef.current = null
    }

    if (resolvedSessionId) {
      sessionStateByRuntimeIdRef.current.delete(resolvedSessionId)
      sessionStateTouchedAtRef.current.delete(resolvedSessionId)
    }

    if (
      resolvedStoredSessionId &&
      (!resolvedSessionId || runtimeIdByStoredSessionIdRef.current.get(resolvedStoredSessionId) === resolvedSessionId)
    ) {
      runtimeIdByStoredSessionIdRef.current.delete(resolvedStoredSessionId)
    }

    for (const alias of storedAliases) {
      runtimeIdByStoredSessionIdRef.current.delete(alias)
    }

    for (const id of new Set([resolvedStoredSessionId, state?.storedSessionId, ...storedAliases].filter(Boolean))) {
      setSessionWorking(id, false)
      setSessionAttention(id, false)
    }
  }, [])

  return {
    activeSessionIdRef,
    ensureSessionState,
    releaseSessionState,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  }
}
