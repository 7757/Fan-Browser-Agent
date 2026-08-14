import { type MutableRefObject, useEffect, useRef } from 'react'

import { setResumeExhaustedSessionId } from '@/store/session'

interface RouteResumeOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  creatingSessionRef: MutableRefObject<boolean>
  currentView: string
  gatewayState: string | undefined
  locationPathname: string
  resumeSession: (sessionId: string, focus: boolean, force?: boolean) => Promise<unknown>
  resumeFailedSessionId: string | null
  resumeExhaustedSessionId: string | null
  routedSessionId: string | null
  runtimeIdByStoredSessionIdRef: MutableRefObject<Map<string, string>>
  selectedStoredSessionIdRef: MutableRefObject<string | null>
}

export const MAX_RESUME_RETRIES = 4
const RESUME_RETRY_BASE_MS = 1_000
const RESUME_RETRY_MAX_MS = 8_000

export function resumeRetryDelayMs(attempt: number): number {
  return Math.min(RESUME_RETRY_MAX_MS, RESUME_RETRY_BASE_MS * 2 ** attempt)
}

export function useRouteResume({
  activeSessionIdRef,
  creatingSessionRef,
  currentView,
  gatewayState,
  locationPathname,
  resumeSession,
  resumeFailedSessionId,
  resumeExhaustedSessionId,
  routedSessionId,
  runtimeIdByStoredSessionIdRef,
  selectedStoredSessionIdRef
}: RouteResumeOptions) {
  const lastPathnameRef = useRef<string | null>(null)
  const seenGatewayStateRef = useRef(false)
  const wasGatewayOpenRef = useRef(false)
  const retrySessionIdRef = useRef<string | null>(null)
  const retryAttemptRef = useRef(0)
  const previousExhaustedRef = useRef<string | null>(null)

  useEffect(() => {
    const gatewayOpen = gatewayState === 'open'
    const pathnameChanged = lastPathnameRef.current !== locationPathname
    // Fire only on a genuine closed->open transition (a reconnect).
    // seenGatewayStateRef stays false until the first effect run, so a session
    // that mounts with the gateway already open is not mistaken for "became
    // open" and does not double-resume with the pathname-driven initial resume
    // below.
    const gatewayBecameOpen = seenGatewayStateRef.current && !wasGatewayOpenRef.current && gatewayOpen
    lastPathnameRef.current = locationPathname
    seenGatewayStateRef.current = true
    wasGatewayOpenRef.current = gatewayOpen

    if (currentView !== 'chat' || !gatewayOpen) {
      return
    }

    if (routedSessionId) {
      const cachedRuntime = runtimeIdByStoredSessionIdRef.current.get(routedSessionId)

      const alreadyActive =
        routedSessionId === selectedStoredSessionIdRef.current &&
        Boolean(cachedRuntime) &&
        cachedRuntime === activeSessionIdRef.current

      // Resume only when the route meaningfully changed (or gateway just opened).
      // This avoids a transient /:sid re-resume during "new chat" state clears
      // before the pathname updates from /:sid -> /.
      const shouldResume = pathnameChanged || gatewayBecameOpen

      // On a reconnect (gatewayBecameOpen) re-resume even when the route looks
      // `alreadyActive`: the cached runtime id can be stale once the gateway
      // rebinds/reaps the session on its side, and trusting it strands Desktop
      // on a dead id ("session not found").
      if ((gatewayBecameOpen || !alreadyActive) && shouldResume && !creatingSessionRef.current) {
        // On a reconnect, force past resumeSession's cache fast path so it
        // actually re-issues session.resume and re-registers a fresh runtime id
        // (the cached one may be a reaped/dead id). Plain route switches keep
        // the cache fast path (anti-flash unchanged).
        void resumeSession(routedSessionId, true, gatewayBecameOpen)
      }

      return
    }

  }, [
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    gatewayState,
    locationPathname,
    resumeSession,
    routedSessionId,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef
  ])

  // A failed resume has already synchronized selectedStoredSessionIdRef to the
  // route, so pathname/reconnect detection above cannot fire again. Retry that
  // exact stranded state with bounded exponential backoff, then expose a
  // terminal state for manual recovery instead of spinning forever.
  useEffect(() => {
    const previousExhausted = previousExhaustedRef.current
    previousExhaustedRef.current = resumeExhaustedSessionId

    // Manual retry/reconnect clears the exhausted latch. Give the same session
    // a fresh retry budget rather than immediately exhausting again.
    if (
      previousExhausted &&
      previousExhausted === routedSessionId &&
      resumeExhaustedSessionId !== previousExhausted
    ) {
      retrySessionIdRef.current = routedSessionId
      retryAttemptRef.current = 0
    }

    if (currentView !== 'chat' || gatewayState !== 'open') {
      return
    }

    const stranded =
      Boolean(routedSessionId) &&
      resumeFailedSessionId === routedSessionId &&
      !creatingSessionRef.current

    if (!stranded) {
      // A genuinely recovered runtime resets the budget. Do not reset during
      // the brief failed-id clear at the start of each automatic retry, where
      // activeSessionId is intentionally still null.
      if (activeSessionIdRef.current || retrySessionIdRef.current !== routedSessionId) {
        retrySessionIdRef.current = null
        retryAttemptRef.current = 0
      }

      setResumeExhaustedSessionId(current =>
        current && current !== routedSessionId ? null : current
      )

      return
    }

    if (retrySessionIdRef.current !== routedSessionId) {
      retrySessionIdRef.current = routedSessionId
      retryAttemptRef.current = 0
    }

    if (retryAttemptRef.current >= MAX_RESUME_RETRIES) {
      setResumeExhaustedSessionId(routedSessionId)

      return
    }

    const attempt = retryAttemptRef.current
    const sessionId = routedSessionId as string

    const timer = window.setTimeout(() => {
      // Re-check route/runtime identity at fire time. A successful resume or a
      // user route change while waiting must cancel this stale retry.
      if (
        creatingSessionRef.current ||
        selectedStoredSessionIdRef.current !== sessionId ||
        activeSessionIdRef.current !== null
      ) {
        return
      }

      retryAttemptRef.current += 1
      // Fan can retain a cached runtime id across gateway restarts. Force the
      // retry through session.resume instead of accepting that stale cache.
      void resumeSession(sessionId, true, true)
    }, resumeRetryDelayMs(attempt))

    return () => window.clearTimeout(timer)
  }, [
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    gatewayState,
    resumeSession,
    resumeExhaustedSessionId,
    resumeFailedSessionId,
    routedSessionId,
    selectedStoredSessionIdRef
  ])
}
