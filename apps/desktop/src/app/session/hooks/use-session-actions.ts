import type { MutableRefObject } from 'react'
import { useCallback, useRef } from 'react'
import { type NavigateFunction, useLocation } from 'react-router-dom'

import { deleteSession, getSessionMessages, setSessionArchived } from '@/fan'
import { type ChatMessage, chatMessageText, preserveLocalAssistantErrors, toChatMessages } from '@/lib/chat-messages'
import { normalizePersonalityValue } from '@/lib/chat-runtime'
import { embeddedImageUrls, textWithoutEmbeddedImages } from '@/lib/embedded-images'
import { setSessionModel } from '@/lib/model-session'
import { playDeleteSound } from '@/lib/sound'
import { setSessionYolo } from '@/lib/yolo-session'
import { clearComposerAttachments, clearComposerDraft } from '@/store/composer'
import { $pinnedSessionIds } from '@/store/layout'
import { clearNotifications, notify, notifyError } from '@/store/notifications'
import { hydratePendingInteractions } from '@/store/pending-interactions'
import {
  $currentCwd,
  $messages,
  $pendingModel,
  $sessions,
  $yoloActive,
  clearSessionUnread,
  getRememberedWorkspaceCwd,
  sessionPinId,
  setActiveBrowserWorkbenchId,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setCurrentBranch,
  setCurrentCwd,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentPersonality,
  setCurrentProvider,
  setCurrentReasoningEffort,
  setCurrentServiceTier,
  setCurrentUsage,
  setIntroSeed,
  setMessages,
  setPendingModel,
  setResumeExhaustedSessionId,
  setResumeFailedSessionId,
  setSelectedStoredSessionId,
  setSessions,
  setSessionsTotal,
  setYoloActive
} from '@/store/session'
import { reportBackendContract } from '@/store/updates'
import type { SessionCreateResponse, SessionInfo, SessionResumeResponse, UsageStats } from '@/types/fan'

import { NEW_CHAT_ROUTE, sessionRoute, SETTINGS_ROUTE } from '../../routes'
import { navigateWithOverlayState } from '../../shell/hooks/use-overlay-routing'
import type { ClientSessionState } from '../../types'

interface SessionActionsOptions {
  activeSessionId: string | null
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  creatingSessionRef: MutableRefObject<boolean>
  ensureSessionState: (sessionId: string, storedSessionId?: string | null) => ClientSessionState
  getRouteToken: () => string
  navigate: NavigateFunction
  releaseSessionState: (sessionId?: string | null, storedSessionId?: string | null) => void
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
  runtimeIdByStoredSessionIdRef: MutableRefObject<Map<string, string>>
  selectedStoredSessionId: string | null
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  sessionStateByRuntimeIdRef: MutableRefObject<Map<string, ClientSessionState>>
  syncSessionStateToView: (sessionId: string, state: ClientSessionState) => void
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

async function ensureBrowserWorkbenchForSession(
  sessionId: string,
  workbenchId: string,
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
) {
  const api = window.fanDesktop?.browser

  if (!api || !sessionId || !workbenchId) {
    return
  }

  // A fresh session opens a blank new-tab page (api.create with no url →
  // about:blank). The user drives the first navigation via the omnibox, or the
  // agent navigates on its first turn — nothing auto-loads a search engine.
  const result = await api.create(workbenchId)
  const boundWorkbenchId = result?.browserWorkbenchId ?? null

  if (boundWorkbenchId) {
    await requestGateway('session.bindBrowser', {
      session_id: sessionId,
      browser_workbench_id: boundWorkbenchId
    })
  }
}

function withAppendedText(message: ChatMessage, suffix: string): ChatMessage {
  let appended = false

  const parts = message.parts.map(part => {
    if (part.type !== 'text' || appended) {
      return part
    }

    appended = true

    return { ...part, text: `${part.text}${suffix}` }
  })

  return appended ? { ...message, parts } : message
}

function preserveReasoningParts(message: ChatMessage, previous: ChatMessage): ChatMessage {
  if (message.parts.some(part => part.type === 'reasoning')) {
    return message
  }

  const reasoningParts = previous.parts.filter(part => part.type === 'reasoning')

  return reasoningParts.length ? { ...message, parts: [...reasoningParts, ...message.parts] } : message
}

function chatMessagesEquivalent(a: ChatMessage, b: ChatMessage): boolean {
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.pending !== b.pending ||
    a.error !== b.error ||
    a.hidden !== b.hidden ||
    a.branchGroupId !== b.branchGroupId
  ) {
    return false
  }

  if (a.parts.length !== b.parts.length) {
    return false
  }

  return a.parts.every((part, index) => JSON.stringify(part) === JSON.stringify(b.parts[index]))
}

function chatMessageArraysEquivalent(a: ChatMessage[], b: ChatMessage[]): boolean {
  return a.length === b.length && a.every((message, index) => chatMessagesEquivalent(message, b[index]))
}

function reconcileResumeMessages(nextMessages: ChatMessage[], previousMessages: ChatMessage[]): ChatMessage[] {
  if (!previousMessages.length) {
    return nextMessages
  }

  const previousByRoleOrdinal = new Map<string, ChatMessage>()
  const previousRoleCounts = new Map<string, number>()

  for (const message of previousMessages) {
    const ordinal = previousRoleCounts.get(message.role) ?? 0
    previousRoleCounts.set(message.role, ordinal + 1)
    previousByRoleOrdinal.set(`${message.role}:${ordinal}`, message)
  }

  const nextRoleCounts = new Map<string, number>()

  return nextMessages.map(message => {
    const ordinal = nextRoleCounts.get(message.role) ?? 0
    nextRoleCounts.set(message.role, ordinal + 1)

    const previous = previousByRoleOrdinal.get(`${message.role}:${ordinal}`)

    if (!previous) {
      return message
    }

    const nextText = chatMessageText(message).trim()
    const previousText = chatMessageText(previous)
    const previousVisibleText = textWithoutEmbeddedImages(previousText)
    let preserved = message

    if (nextText === previousVisibleText || nextText === previousText.trim()) {
      preserved = preserveReasoningParts(preserved, previous)
    }

    const previousImages = embeddedImageUrls(previousText)

    if (!previousImages.length || embeddedImageUrls(chatMessageText(preserved)).length) {
      return preserved
    }

    if (nextText !== previousVisibleText) {
      return preserved
    }

    return withAppendedText(preserved, previousImages.map(url => `\n${url}`).join(''))
  })
}

function upsertOptimisticSession(
  created: SessionCreateResponse,
  id: string,
  title: string | null = null,
  preview: string | null = null
) {
  const now = Date.now() / 1000

  const session: SessionInfo = {
    browser_workbench_id: created.browser_workbench_id ?? created.info?.browser_workbench_id,
    cwd: created.info?.cwd ?? null,
    ended_at: null,
    id,
    input_tokens: 0,
    is_active: true,
    last_active: now,
    message_count: created.message_count ?? created.messages?.length ?? 0,
    model: created.info?.model ?? null,
    output_tokens: 0,
    preview,
    source: 'tui',
    started_at: now,
    title,
    tool_call_count: 0
  }

  setSessions(prev => [session, ...prev.filter(s => s.id !== id)])
}

function patchSessionWorkspace(sessionId: string, cwd: string | undefined) {
  if (!cwd) {
    return
  }

  setSessions(prev => prev.map(session => (session.id === sessionId ? { ...session, cwd } : session)))
}

function applyRuntimeInfo(
  info: SessionCreateResponse['info'] | undefined
): Partial<Pick<ClientSessionState, 'branch' | 'browserWorkbenchId' | 'cwd'>> | null {
  if (!info) {
    return null
  }

  const sessionState: Partial<Pick<ClientSessionState, 'branch' | 'browserWorkbenchId' | 'cwd'>> = {}

  reportBackendContract(info.desktop_contract)

  if (info.credential_warning) {
    notify({
      id: 'model-credential-warning',
      kind: 'warning',
      title: '模型凭据未配置',
      message: info.credential_warning
    })
  }

  // A draft model pick is replayed by the create flow below; don't let the
  // server's default model clobber the optimistic choice in the meantime.
  if (info.model && !$pendingModel.get()) {
    setCurrentModel(info.model)
  }

  if (info.provider) {
    setCurrentProvider(info.provider)
  }

  if (info.cwd) {
    setCurrentCwd(info.cwd)
    sessionState.cwd = info.cwd
  }

  if (info.branch !== undefined) {
    setCurrentBranch(info.branch || '')
    sessionState.branch = info.branch || ''
  }

  if (typeof info.browser_workbench_id === 'string') {
    const browserWorkbenchId = info.browser_workbench_id.trim()
    sessionState.browserWorkbenchId = browserWorkbenchId || null
    setActiveBrowserWorkbenchId(browserWorkbenchId || null)
  }

  if (typeof info.personality === 'string') {
    setCurrentPersonality(normalizePersonalityValue(info.personality))
  }

  if (typeof info.reasoning_effort === 'string') {
    setCurrentReasoningEffort(info.reasoning_effort)
  }

  if (typeof info.service_tier === 'string') {
    setCurrentServiceTier(info.service_tier)
  }

  if (typeof info.fast === 'boolean') {
    setCurrentFastMode(info.fast)
  }

  if (typeof info.yolo === 'boolean') {
    setYoloActive(info.yolo)
  }

  if (info.usage) {
    setCurrentUsage(current => ({ ...current, ...info.usage }))
  }

  return sessionState
}

export function useSessionActions({
  activeSessionId,
  activeSessionIdRef,
  busyRef,
  creatingSessionRef,
  ensureSessionState,
  getRouteToken,
  navigate,
  releaseSessionState,
  requestGateway,
  runtimeIdByStoredSessionIdRef,
  selectedStoredSessionId,
  selectedStoredSessionIdRef,
  sessionStateByRuntimeIdRef,
  syncSessionStateToView,
  updateSessionState
}: SessionActionsOptions) {
  const resumeRequestRef = useRef(0)
  // Read through a ref so navigation callbacks see the CURRENT location
  // (needed for the overlay background-location state) without re-creating
  // on every route change.
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location

  // Clear every piece of per-session surface state and land on the index
  // route (which resolves to the "+" empty state or the overview). Used after
  // deleting the current session. There is NO draft concept: this never mints
  // a workbench — a session exists only when the backend created one.
  const resetSessionSurface = useCallback(
    (replaceRoute = false) => {
      busyRef.current = false
      setBusy(false)
      setAwaitingResponse(false)
      clearNotifications()
      setIntroSeed(seed => seed + 1)
      navigate(NEW_CHAT_ROUTE, { replace: replaceRoute })
      setActiveSessionId(null)
      setActiveBrowserWorkbenchId(null)
      activeSessionIdRef.current = null
      setSelectedStoredSessionId(null)
      selectedStoredSessionIdRef.current = null
      setMessages([])
      setCurrentUsage({
        calls: 0,
        input: 0,
        output: 0,
        total: 0
      })
      // New chats inherit the current workspace.
      setCurrentCwd(getRememberedWorkspaceCwd())
      setCurrentBranch('')
      clearComposerDraft()
      clearComposerAttachments()
    },
    [activeSessionIdRef, busyRef, navigate, selectedStoredSessionIdRef]
  )

  const createBackendSessionForSend = useCallback(
    async (
      preview: string | null = null,
      // Runs after the session state exists but BEFORE navigating to the new
      // route. Callers seed optimistic messages here so the thread remount
      // triggered by the navigation already finds them — seeding after the
      // navigate made the just-sent user message blink out of the view.
      onSessionReady?: (runtimeSessionId: string, storedSessionId: null | string) => void,
      supersedeSessionId?: string | null
    ): Promise<string | null> => {
      const startingActiveSessionId = activeSessionIdRef.current
      const startingStoredSessionId = selectedStoredSessionIdRef.current
      const startingRouteToken = getRouteToken()

      creatingSessionRef.current = true

      try {
        const cwd = $currentCwd.get().trim() || getRememberedWorkspaceCwd()
        // persist: a desktop session is REAL from the moment it exists (no
        // draft concept) — the DB row is written at create time so it appears
        // in the overview and survives restarts even with zero messages.
        const created = await requestGateway<SessionCreateResponse>('session.create', {
          cols: 96,
          persist: true,
          ...(cwd && { cwd }),
          ...(supersedeSessionId && { supersede_session_id: supersedeSessionId })
        })
        const stored = created.stored_session_id ?? null

        // A NEW session always gets ITS OWN workbench (the backend's key).
        // The old draft-era preference for $activeBrowserWorkbenchId reused the
        // on-screen draft view — with no draft concept, that atom holds the
        // PREVIOUS session's workbench, and preferring it bound the new session
        // to the old session's live browser (cross-session takeover bug).
        const browserWorkbenchId =
          created.browser_workbench_id ||
          created.info?.browser_workbench_id ||
          stored ||
          created.session_id

        if (
          activeSessionIdRef.current !== startingActiveSessionId ||
          selectedStoredSessionIdRef.current !== startingStoredSessionId ||
          getRouteToken() !== startingRouteToken
        ) {
          await requestGateway('session.close', { session_id: created.session_id }).catch(() => undefined)

          return null
        }

        activeSessionIdRef.current = created.session_id
        selectedStoredSessionIdRef.current = stored
        ensureSessionState(created.session_id, stored)
        onSessionReady?.(created.session_id, stored)

        if (stored) {
          // Seed the sidebar preview with the user's first message so the row
          // reads meaningfully while the turn is in flight, instead of flashing
          // "Untitled session" until the turn persists and auto-title runs. The
          // server later returns its own preview/title and supersedes this.
          upsertOptimisticSession(created, stored, null, preview?.trim() || null)
          navigate(sessionRoute(stored), { replace: true })
        }

        setActiveSessionId(created.session_id)
        setSelectedStoredSessionId(stored)
        const yoloArmed = $yoloActive.get()
        const runtimeInfo = applyRuntimeInfo(created.info)

        // AFTER applyRuntimeInfo, and runtimeInfo spread first, so the
        // gateway's suggestion can't clobber the id we just committed to.
        setActiveBrowserWorkbenchId(browserWorkbenchId)

        if (runtimeInfo) {
          updateSessionState(
            created.session_id,
            state => ({ ...state, ...runtimeInfo, browserWorkbenchId }),
            stored
          )
        } else {
          updateSessionState(created.session_id, state => ({ ...state, browserWorkbenchId }), stored)
        }

        try {
          await ensureBrowserWorkbenchForSession(created.session_id, browserWorkbenchId, requestGateway)
        } catch (err) {
          console.warn('Failed to bind browser workbench before first prompt', err)
        }

        // User may have armed YOLO on the new-chat draft before the runtime
        // session existed — apply it to the freshly created session.
        if (yoloArmed) {
          await setSessionYolo(requestGateway, created.session_id, true).catch(() => undefined)
        }

        // Same for a brain model picked on the draft before the session existed:
        // replay it now (config.set needs the session id). Clear first so a later
        // applyRuntimeInfo isn't gated by a stale pending value.
        const pendingModel = $pendingModel.get()
        setPendingModel('')

        if (pendingModel && pendingModel !== created.info?.model) {
          await setSessionModel(requestGateway, created.session_id, pendingModel).catch(() => undefined)
        }

        return created.session_id
      } finally {
        window.setTimeout(() => {
          creatingSessionRef.current = false
        }, 0)
      }
    },
    [
      activeSessionIdRef,
      creatingSessionRef,
      ensureSessionState,
      getRouteToken,
      navigate,
      requestGateway,
      selectedStoredSessionIdRef,
      updateSessionState
    ]
  )

  // "New session" (titlebar +, ⌘N, the empty-state tile): a REAL backend
  // session is created immediately — there is no draft state. The user may
  // browse without ever typing; that activity belongs to this session like in
  // any real browser. createBackendSessionForSend persists the row, seeds the
  // overview optimistically, navigates to the new route and binds the browser.
  const startNewSession = useCallback(() => {
    if (creatingSessionRef.current) {
      return
    }
    const supersedeSessionId = activeSessionIdRef.current
    busyRef.current = false
    setBusy(false)
    setAwaitingResponse(false)
    clearNotifications()
    setIntroSeed(seed => seed + 1)
    setMessages([])
    setCurrentUsage({ calls: 0, input: 0, output: 0, total: 0 })
    setCurrentCwd(getRememberedWorkspaceCwd())
    setCurrentBranch('')
    clearComposerDraft()
    clearComposerAttachments()
    void createBackendSessionForSend(null, undefined, supersedeSessionId).catch(err => {
      console.warn('New session create failed', err)
    })
  }, [activeSessionIdRef, busyRef, createBackendSessionForSend, creatingSessionRef])

  const openSettings = useCallback(() => {
    navigateWithOverlayState(navigate, locationRef.current, SETTINGS_ROUTE)
  }, [navigate])

  const closeSettings = useCallback(() => {
    if (selectedStoredSessionId) {
      navigate(sessionRoute(selectedStoredSessionId))

      return
    }

    navigate(NEW_CHAT_ROUTE)
  }, [navigate, selectedStoredSessionId])

  const resumeSession = useCallback(
    async (storedSessionId: string, replaceRoute = false, force = false) => {
      const requestId = resumeRequestRef.current + 1
      resumeRequestRef.current = requestId
      // A draft model pick that was never sent must not gate this resume's
      // applyRuntimeInfo (it would suppress the resumed session's real model).
      setPendingModel('')
      // Every explicit/automatic attempt starts clean. A terminal double
      // failure below re-arms the failed latch; manual retry also clears the
      // exhausted latch so the same session receives a fresh backoff budget.
      setResumeFailedSessionId(current => (current === storedSessionId ? null : current))
      setResumeExhaustedSessionId(current => (current === storedSessionId ? null : current))

      const isCurrentResume = () =>
        resumeRequestRef.current === requestId && selectedStoredSessionIdRef.current === storedSessionId

      const takeWarmCache = (): { runtimeId: string; state: ClientSessionState } | null => {
        const runtimeId = runtimeIdByStoredSessionIdRef.current.get(storedSessionId)
        const state = runtimeId ? sessionStateByRuntimeIdRef.current.get(runtimeId) : undefined

        if (!runtimeId || !state) {
          return null
        }

        // A reaped/reused runtime id can still be live, but belong to another
        // stored session. Never paint that cached transcript under this route.
        if (state.storedSessionId !== storedSessionId) {
          runtimeIdByStoredSessionIdRef.current.delete(storedSessionId)
          sessionStateByRuntimeIdRef.current.delete(runtimeId)
          return null
        }

        return { runtimeId, state }
      }

      const warmHit = force ? null : takeWarmCache()

      // `force` (set by route-resume on a reconnect) bypasses the cache fast
      // path: after the gateway reaps/rebinds a session the cached runtime id
      // can be stale, and the fast path would just re-sync that dead id to the
      // view — making the reconnect re-resume a no-op that strands Desktop on a
      // "session not found" id. Forcing falls through to the real session.resume
      //.
      if (warmHit) {
        const cachedRuntimeId = warmHit.runtimeId
        const cachedState = warmHit.state
        clearNotifications()
        setSelectedStoredSessionId(storedSessionId)
        selectedStoredSessionIdRef.current = storedSessionId
        setActiveSessionId(cachedRuntimeId)
        setActiveBrowserWorkbenchId(cachedState.browserWorkbenchId || storedSessionId)
        activeSessionIdRef.current = cachedRuntimeId
        syncSessionStateToView(cachedRuntimeId, cachedState)
        setCurrentCwd(cachedState.cwd)
        setCurrentBranch(cachedState.branch)
        clearComposerDraft()
        clearComposerAttachments()

        void requestGateway<UsageStats>('session.usage', { session_id: cachedRuntimeId })
          .then(usage => {
            if (isCurrentResume() && usage) {
              setCurrentUsage(current => ({ ...current, ...usage }))
            }
          })
          .catch(() => undefined)

        return
      }

      setActiveSessionId(null)
      setActiveBrowserWorkbenchId(null)
      activeSessionIdRef.current = null
      busyRef.current = true
      setBusy(true)
      setAwaitingResponse(false)
      clearNotifications()
      // Capture the OUTGOING session before we overwrite the selection, so we can
      // tell a cross-session switch from a same-session force reconnect below.
      const switchingSession = selectedStoredSessionIdRef.current !== storedSessionId
      setSelectedStoredSessionId(storedSessionId)
      selectedStoredSessionIdRef.current = storedSessionId
      // Cross-session resume ONLY: drop the OUTGOING session's transcript so the
      // preserve-from-view merges below (617/658/698) can't pull its local error
      // bubbles into this fresh session (跨会话串台). A same-session force reconnect
      // must KEEP this session's own client-only error bubbles, so skip the clear.
      // busy=true above already shows a loading state → an empty view reads as
      // "loading", not stale. (The cached fast path doesn't reach here.)
      if (switchingSession) {
        setMessages([])
      }
      const stored = $sessions.get().find(session => session.id === storedSessionId)

      if (stored) {
        setCurrentUsage(current => ({
          ...current,
          input: stored.input_tokens || 0,
          output: stored.output_tokens || 0,
          total: (stored.input_tokens || 0) + (stored.output_tokens || 0)
        }))
      }

      try {
        // The REST transcript prefetch and the gateway resume RPC are
        // independent — fire them concurrently so a big session's wall time is
        // max(prefetch, resume) instead of their sum. The prefetch paints the
        // snapshot first (below); the resume projection is only used as a
        // fallback when the prefetch did NOT hydrate one, so the old ctrl+R
        // flash chain stays fixed — see the preferredMessages guard below.
        //
        // localSnapshot MUST start empty (not $messages.get()): on an A->B
        // session switch this path never clears $messages, so it still holds
        // session A's transcript. If the REST prefetch fails but the resume RPC
        // succeeds, a non-empty seed would make preferredMessages keep A's
        // messages and paint+cache them onto B (cross-session bleed). Starting
        // empty means a failed prefetch falls through to B's resume projection;
        // a successful prefetch repopulates it (anti-flash intact).
        let localSnapshot: ChatMessage[] = []

        const prefetchPromise = getSessionMessages(storedSessionId)
        const resumePromise = requestGateway<SessionResumeResponse>('session.resume', {
          session_id: storedSessionId,
          cols: 96
        })
        // The rejection is consumed by the `await resumePromise` below; this
        // guard only keeps it from surfacing as unhandled while the prefetch
        // settles first.
        resumePromise.catch(() => undefined)

        try {
          const storedMessages = await prefetchPromise

          if (isCurrentResume()) {
            localSnapshot = preserveLocalAssistantErrors(toChatMessages(storedMessages.messages), $messages.get())

            if (!chatMessageArraysEquivalent($messages.get(), localSnapshot)) {
              setMessages(localSnapshot)
            }
          }
        } catch {
          // Non-fatal: gateway resume below can still hydrate the session.
        }

        const resumed = await resumePromise

        if (!isCurrentResume()) {
          return
        }

        const currentMessages = $messages.get()

        // Avoid a second visible transcript rebuild on resume/switch.
        // `getSessionMessages()` is the stable stored transcript snapshot and
        // paints first; `session.resume` can return a slightly different
        // runtime-shaped projection (e.g. tool/system coalescing), which was
        // causing a second full message-list replacement a second later.
        // Keep the already-painted local snapshot for the view/cache when it
        // exists; use gateway messages only as a fallback when no local
        // snapshot was available. When the prefetch already hydrated the
        // transcript we skip converting/reconciling the resume payload
        // entirely — on a 1000+-message session that second conversion plus
        // the deep equivalence compare costs over a second of main-thread time.
        const preferredMessages =
          localSnapshot.length > 0
            ? localSnapshot
            : (() => {
                const resumedMessages = preserveLocalAssistantErrors(
                  reconcileResumeMessages(toChatMessages(resumed.messages), currentMessages),
                  currentMessages
                )

                return chatMessageArraysEquivalent(currentMessages, resumedMessages) ? currentMessages : resumedMessages
              })()

        // A successful prefetch can already have selected the live message
        // array. Reuse that reference instead of rebuilding an identical
        // transcript and error-merge map on every large-session switch.
        const messagesForView =
          preferredMessages === currentMessages
            ? currentMessages
            : preserveLocalAssistantErrors(preferredMessages, currentMessages)

        setActiveSessionId(resumed.session_id)
        activeSessionIdRef.current = resumed.session_id

        const browserWorkbenchId =
          resumed.browser_workbench_id || resumed.info?.browser_workbench_id || storedSessionId || resumed.session_id

        const runtimeInfo = applyRuntimeInfo(resumed.info)
        setActiveBrowserWorkbenchId(browserWorkbenchId)

        patchSessionWorkspace(storedSessionId, runtimeInfo?.cwd)
        const needsInput = hydratePendingInteractions(
          resumed.session_id,
          resumed.pending_interactions,
          resumed.pending_interactions_epoch,
          resumed.pending_interactions_revision
        )

        updateSessionState(
          resumed.session_id,
          state => ({
            ...state,
            browserWorkbenchId,
            ...(runtimeInfo ?? {}),
            messages: messagesForView,
            // Adopt the gateway's truth, not an assumed idle: a renderer
            // reload/crash mid-turn resumes a session whose turn is still
            // running (resume re-binds the event transport, so stream events
            // keep flowing and will evolve this state). Hardcoding false here
            // painted a running session as idle — the composer unlocked and
            // every send bounced off the gateway's 4009 "session busy".
            busy: Boolean(resumed.running),
            awaitingResponse: false,
            needsInput
          }),
          storedSessionId
        )

        if (resumed.running) {
          // The running snapshot was taken when the resume RPC executed — the
          // transcript prefetch we also awaited can put SECONDS between that
          // and now. If the turn ended inside that window, its session.info
          // fired before this resume adopted busy:true and nothing else will
          // clear it. One authoritative re-check converges: `idle`/gone here
          // downgrades; a turn ending after this point reaches us as a live
          // session.info/message.complete on the re-bound transport. The
          // updater guards keep it from stomping a newly-submitted turn.
          void requestGateway<{ sessions?: Array<{ id: string; status?: string }> }>('session.active_list', {})
            .then(res => {
              if (!isCurrentResume()) {
                return
              }

              const row = res?.sessions?.find(s => s.id === resumed.session_id)

              if (!row || row.status === 'idle') {
                updateSessionState(
                  resumed.session_id,
                  state => (!state.busy || state.awaitingResponse ? state : { ...state, busy: false, awaitingResponse: false }),
                  storedSessionId
                )
              }
            })
            .catch(() => undefined)
        }

        clearComposerDraft()
        clearComposerAttachments()
      } catch (err) {
        if (!isCurrentResume()) {
          return
        }

        // Best-effort repaint with the stored transcript. If the backend is
        // fully unreachable this also throws — swallow it so the error toast
        // below always fires instead of escaping the catch (which would drop
        // the failure silently and leave an unhandled rejection).
        try {
          const fallback = await getSessionMessages(storedSessionId)

          if (isCurrentResume()) {
            setMessages(preserveLocalAssistantErrors(toChatMessages(fallback.messages), $messages.get()))
          }
        } catch {
          // ignore — fallback repaint is best-effort
        }

        if (isCurrentResume() && $messages.get().length === 0) {
          // RPC and transcript fallback both left this route without a runtime
          // or readable history. Arm the bounded route-resume recovery layer.
          setResumeFailedSessionId(storedSessionId)
        }

        notifyError(err, '继续失败')
      } finally {
        if (isCurrentResume()) {
          // Release the resume loading state to the session cache's authoritative
          // value, not a hardcoded idle: a successful resume of a still-running
          // turn just wrote busy=true into the cache (updateSessionState above),
          // and blanket-clearing here would overwrite it. On failure the active
          // runtime id was never set, so this resolves to idle as before.
          const runtimeId = activeSessionIdRef.current
          const settled = runtimeId ? sessionStateByRuntimeIdRef.current.get(runtimeId) : null
          const stillBusy = Boolean(settled?.busy)
          busyRef.current = stillBusy
          setBusy(stillBusy)
          setAwaitingResponse(Boolean(settled?.awaitingResponse))
        }
      }
    },
    [
      activeSessionIdRef,
      busyRef,
      requestGateway,
      runtimeIdByStoredSessionIdRef,
      selectedStoredSessionIdRef,
      sessionStateByRuntimeIdRef,
      syncSessionStateToView,
      updateSessionState
    ]
  )

  const branchCurrentSession = useCallback(
    async (messageId?: string): Promise<boolean> => {
      const sourceSessionId = activeSessionIdRef.current

      if (!sourceSessionId) {
        notify({
          kind: 'warning',
          title: '没有可分支的内容',
          message: '请先开始或继续一个会话，再进行分支操作。'
        })

        return false
      }

      if (busyRef.current) {
        notify({
          kind: 'warning',
          title: '会话繁忙',
          message: '请先停止当前轮次，再对此会话进行分支操作。'
        })

        return false
      }

      creatingSessionRef.current = true

      try {
        const currentMessages = $messages.get()

        const targetIndex = messageId
          ? currentMessages.findIndex(message => message.id === messageId)
          : currentMessages.findLastIndex(message => message.role === 'assistant' || message.role === 'user')

        const branchStart = targetIndex >= 0 ? targetIndex : Math.max(currentMessages.length - 1, 0)
        const branchEnd = targetIndex >= 0 ? targetIndex + 1 : currentMessages.length

        const branchMessages = currentMessages
          .slice(branchStart, branchEnd)
          .map(message => ({
            content: chatMessageText(message),
            source: message,
            role: message.role
          }))
          .filter(message => message.content.trim() && ['assistant', 'user'].includes(message.role))

        if (!branchMessages.length) {
          notify({
            kind: 'warning',
            title: '没有可分支的内容',
            message: '此消息没有可用于分支的文本。'
          })

          return false
        }

        clearNotifications()

        const cwd = $currentCwd.get().trim()

        const branched = await requestGateway<SessionCreateResponse>('session.create', {
          cols: 96,
          ...(cwd && { cwd }),
          messages: branchMessages.map(({ content, role }) => ({ content, role })),
          title: '分支'
        })

        const routedSessionId = branched.stored_session_id ?? branched.session_id

        const browserWorkbenchId =
          branched.browser_workbench_id || branched.info?.browser_workbench_id || routedSessionId || branched.session_id

        const preview = branchMessages.map(({ content }) => content).find(Boolean) ?? null

        upsertOptimisticSession(branched, routedSessionId, '分支', preview)
        ensureSessionState(branched.session_id, routedSessionId)
        setActiveSessionId(branched.session_id)
        setActiveBrowserWorkbenchId(browserWorkbenchId)
        activeSessionIdRef.current = branched.session_id
        updateSessionState(
          branched.session_id,
          state => ({
            ...state,
            browserWorkbenchId,
            messages: branchMessages.map(({ source }) => source),
            busy: false,
            awaitingResponse: false
          }),
          routedSessionId
        )
        setSelectedStoredSessionId(routedSessionId)
        selectedStoredSessionIdRef.current = routedSessionId
        navigate(sessionRoute(routedSessionId))

        clearComposerDraft()
        clearComposerAttachments()
        // Don't let an unsent draft model pick gate the branch's real model.
        setPendingModel('')
        const runtimeInfo = applyRuntimeInfo(branched.info)

        patchSessionWorkspace(routedSessionId, runtimeInfo?.cwd)

        if (runtimeInfo) {
          updateSessionState(branched.session_id, state => ({ ...state, ...runtimeInfo }), routedSessionId)
        }

        return true
      } catch (err) {
        notifyError(err, '分支失败')

        return false
      } finally {
        window.setTimeout(() => {
          creatingSessionRef.current = false
        }, 0)
      }
    },
    [
      activeSessionIdRef,
      busyRef,
      creatingSessionRef,
      ensureSessionState,
      navigate,
      requestGateway,
      selectedStoredSessionIdRef,
      updateSessionState
    ]
  )

  const removeSession = useCallback(
    async (storedSessionId: string) => {
      clearNotifications()

      const removed = $sessions.get().find(s => s.id === storedSessionId)
      const wasSelected = selectedStoredSessionId === storedSessionId
      const closingRuntimeId = wasSelected ? activeSessionId : null
      const runtimeIdForSession = closingRuntimeId ?? runtimeIdByStoredSessionIdRef.current.get(storedSessionId) ?? null

      const browserWorkbenchId = runtimeIdForSession
        ? (sessionStateByRuntimeIdRef.current.get(runtimeIdForSession)?.browserWorkbenchId ?? storedSessionId)
        : null

      const previousMessages = $messages.get()
      const previousPinned = $pinnedSessionIds.get()
      // Pins are keyed on the durable lineage-root id; the stored id may be the
      // live tip after compression. Drop both so the pin can't linger.
      const removedPinId = removed ? sessionPinId(removed) : storedSessionId

      setSessions(prev => prev.filter(s => s.id !== storedSessionId))
      // Keep $sessionsTotal in sync so the sidebar's "Load N more" footer
      // doesn't keep claiming the removed row is still on the server.
      setSessionsTotal(prev => Math.max(0, prev - 1))
      $pinnedSessionIds.set(previousPinned.filter(id => id !== storedSessionId && id !== removedPinId))

      // Tear down before awaiting so the route effect can't resume the
      // doomed session via the stale /<sid> URL.
      if (wasSelected) {
        resetSessionSurface(true)
      }

      try {
        // Confirm the durable delete before tearing down any live resource. A
        // failed REST delete must leave the Agent, worker, browser and cache
        // intact so the optimistic UI rollback is real rather than a dead shell.
        await deleteSession(storedSessionId)

        if (runtimeIdForSession) {
          // closeBrowser must precede session.close so the backend can still
          // resolve session_id -> session_key. This applies to background
          // sessions too; previously only the selected runtime was closed.
          await requestGateway('session.closeBrowser', { session_id: runtimeIdForSession }).catch(() => undefined)
          await requestGateway('session.close', { session_id: runtimeIdForSession }).catch(() => undefined)
        }

        // Delete confirmed — only now destroy the native browser view, and reap
        // its on-disk partition (cookies/cache) with it. Real delete ONLY —
        // the archive path never destroys/reaps, so archived sessions keep
        // their logins for resume. Falls back to the stored id: after a
        // restart there may be NO live workbench, but the partition (keyed by
        // the session key) still holds the user's cookies and must go.
        void window.fanDesktop?.browser?.destroy(browserWorkbenchId || storedSessionId, {
          reapPartition: true
        })

        releaseSessionState(runtimeIdForSession, storedSessionId)

      } catch (err) {
        if (removed) {
          setSessions(prev => [removed, ...prev])
          setSessionsTotal(prev => prev + 1)
        }

        $pinnedSessionIds.set(previousPinned)

        if (wasSelected) {
          setSelectedStoredSessionId(storedSessionId)
          selectedStoredSessionIdRef.current = storedSessionId
          const stored = $sessions.get().find(session => session.id === storedSessionId)

          if (stored) {
            setCurrentUsage(current => ({
              ...current,
              input: stored.input_tokens || 0,
              output: stored.output_tokens || 0,
              total: (stored.input_tokens || 0) + (stored.output_tokens || 0)
            }))
          }

          setMessages(previousMessages)
          navigate(sessionRoute(storedSessionId), { replace: true })

          if (closingRuntimeId) {
            setActiveSessionId(closingRuntimeId)
            setActiveBrowserWorkbenchId(browserWorkbenchId)
            activeSessionIdRef.current = closingRuntimeId
          }
        }

        notifyError(err, '删除失败')
      }
    },
    [
      activeSessionId,
      activeSessionIdRef,
      navigate,
      releaseSessionState,
      requestGateway,
      runtimeIdByStoredSessionIdRef,
      selectedStoredSessionId,
      selectedStoredSessionIdRef,
      sessionStateByRuntimeIdRef,
      resetSessionSurface
    ]
  )

  const archiveSession = useCallback(
    async (storedSessionId: string) => {
      clearNotifications()

      const archived = $sessions.get().find(s => s.id === storedSessionId)
      const wasSelected = selectedStoredSessionId === storedSessionId
      const runtimeIdForSession =
        (wasSelected ? activeSessionId : null) ?? runtimeIdByStoredSessionIdRef.current.get(storedSessionId) ?? null
      const cachedState = runtimeIdForSession ? sessionStateByRuntimeIdRef.current.get(runtimeIdForSession) : null
      const browserWorkbenchId = cachedState?.browserWorkbenchId || storedSessionId
      const canSuspendRuntime = Boolean(
        runtimeIdForSession &&
          cachedState &&
          !cachedState.busy &&
          !cachedState.awaitingResponse &&
          !cachedState.needsInput
      )
      const previousPinned = $pinnedSessionIds.get()
      // Pins are keyed on the durable lineage-root id; the stored id may be the
      // live tip after compression. Drop both so the pin can't linger.
      const archivedPinId = archived ? sessionPinId(archived) : storedSessionId

      // Soft-hide: drop from the sidebar immediately, keep the data.
      setSessions(prev => prev.filter(s => s.id !== storedSessionId))
      playDeleteSound()
      // Drop any unread badge so it can't linger in localStorage for a session
      // that's no longer in the overview.
      clearSessionUnread(storedSessionId)
      // Archived sessions are hidden by the listSessions(min_messages=1) query
      // on the next refresh, so they count as "removed" for the load-more
      // footer math.
      setSessionsTotal(prev => Math.max(0, prev - 1))
      $pinnedSessionIds.set(previousPinned.filter(id => id !== storedSessionId && id !== archivedPinId))

      if (wasSelected) {
        resetSessionSurface(true)
      }

      try {
        await setSessionArchived(storedSessionId, true)

        if (canSuspendRuntime && runtimeIdForSession) {
          await requestGateway('session.closeBrowser', { session_id: runtimeIdForSession }).catch(() => undefined)
          const closeResult = await requestGateway<{ closed: boolean }>('session.close', {
            session_id: runtimeIdForSession
          }).catch(() => null)

          // A transport failure leaves the live runtime/cache intact so a
          // reconnect can still finish teardown. Any actual gateway response
          // (including closed:false = already absent) makes local release safe.
          if (closeResult) {
            await window.fanDesktop?.browser?.hibernate(browserWorkbenchId || storedSessionId).catch(() => undefined)
            releaseSessionState(runtimeIdForSession, storedSessionId)
          }
        }
      } catch (err) {
        if (archived) {
          setSessions(prev => [archived, ...prev.filter(s => s.id !== storedSessionId)])
          setSessionsTotal(prev => prev + 1)
        }

        $pinnedSessionIds.set(previousPinned)
        notifyError(err, '归档失败')
      }
    },
    [
      activeSessionId,
      releaseSessionState,
      requestGateway,
      runtimeIdByStoredSessionIdRef,
      selectedStoredSessionId,
      sessionStateByRuntimeIdRef,
      resetSessionSurface
    ]
  )

  return {
    archiveSession,
    branchCurrentSession,
    closeSettings,
    createBackendSessionForSend,
    openSettings,
    removeSession,
    resumeSession,
    startNewSession
  }
}
