import { useStore } from '@nanostores/react'
import { useQueryClient } from '@tanstack/react-query'
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore
} from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'

import { BootFailureOverlay } from '@/components/boot-failure-overlay'
import { BrowserOnlyNotice } from '@/components/browser-only-notice'
import { DesktopInstallOverlay } from '@/components/desktop-install-overlay'
import { GatewayConnectingOverlay } from '@/components/gateway-connecting-overlay'
import { ModelProviderSetupOverlay } from '@/components/model-provider-setup'
import { Pane, PaneMain } from '@/components/pane-shell'

import { formatRefValue } from '../components/assistant-ui/directive-text'
import { getGlobalModelInfo, getSessionMessages, listSessions } from '../fan'
import { dismissAssistantMessageError, preserveLocalAssistantErrors, toChatMessages } from '../lib/chat-messages'
import { markBrowserOperatingStateKnownIdle, restoreBrowserControlState } from '../store/browser-control'
import { $commandPaletteOpen, toggleCommandPalette } from '../store/command-palette'
import {
  $pinnedSessionIds,
  $sessionsLimit,
  FILE_BROWSER_DEFAULT_WIDTH,
  FILE_BROWSER_MAX_WIDTH,
  FILE_BROWSER_MIN_WIDTH,
  SESSION_VIEW_SPLIT_MIN_WIDTH
} from '../store/layout'
import {
  $modelProviderSetup,
  invalidateModelProviderSetup,
  refreshModelProviders
} from '../store/model-provider-setup'
import { $fullWindowModalOpen, $nativeViewOccluded } from '../store/native-overlay'
import { $paneWidthOverride, setPaneWidthOverride } from '../store/panes'
import { $filePreviewTarget, $previewTarget, closeActiveRightRailTab } from '../store/preview'
import {
  $activeBrowserWorkbenchId,
  $activeSessionId,
  $currentCwd,
  $gatewayState,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $selectedStoredSessionId,
  $sessions,
  $sessionsLoading,
  $workingSessionIds,
  ensureDefaultWorkspaceCwd,
  getRecentlySettledSessionIds,
  mergeSessionPage,
  setAwaitingResponse,
  setBusy,
  setCurrentModel,
  setCurrentProvider,
  setMessages,
  setSessions,
  setSessionsLoading,
  setSessionsTotal,
  setViewingSessionId
} from '../store/session'
import { $effectiveSessionLayoutMode } from '../store/session-layout'
import { openUpdatesWindow, startUpdatePoller, stopUpdatePoller } from '../store/updates'

import { useBrowserStatePersistence } from './browser-state-persistence'
import { NewSessionEmpty } from './canvas/new-session-empty'
import { ChatView } from './chat'
import { useComposerActions } from './chat/hooks/use-composer-actions'
import {
  ChatPreviewRail,
  PREVIEW_RAIL_MAX_WIDTH,
  PREVIEW_RAIL_MIN_WIDTH,
  PREVIEW_RAIL_MIN_WIDTH_PX,
  PREVIEW_RAIL_PANE_WIDTH
} from './chat/right-rail'
import { SessionView } from './chat/session-view'
import { CommandPalette } from './command-palette'
import { useGatewayBoot } from './gateway/hooks/use-gateway-boot'
import { useGatewayRequest } from './gateway/hooks/use-gateway-request'
import { OverlayFallback } from './overlays/overlay-fallback'
import { RightSidebarPane } from './right-sidebar'
import { $terminalTakeover } from './right-sidebar/store'
import { PersistentTerminal, TerminalSlot } from './right-sidebar/terminal/persistent'
import {
  CANVAS_ROUTE,
  NEW_CHAT_ROUTE,
  routeSessionId,
  sessionRoute,
  SETTINGS_ROUTE
} from './routes'
import { useContextSuggestions } from './session/hooks/use-context-suggestions'
import { useCwdActions } from './session/hooks/use-cwd-actions'
import { useFanConfig } from './session/hooks/use-fan-config'
import { useMessageStream } from './session/hooks/use-message-stream'
import { usePreviewRouting } from './session/hooks/use-preview-routing'
import { usePromptActions } from './session/hooks/use-prompt-actions'
import { useRouteResume } from './session/hooks/use-route-resume'
import { useSessionActions } from './session/hooks/use-session-actions'
import { useSessionStateCache } from './session/hooks/use-session-state-cache'
import { AppShell } from './shell/app-shell'
import { navigateWithOverlayState, useOverlayRouting } from './shell/hooks/use-overlay-routing'
import type { TitlebarTool } from './shell/titlebar-controls'
import { useGroupRegistry } from './shell/use-group-registry'
import { UpdatesOverlay } from './updates-overlay'

const AgentsView = lazy(async () => ({ default: (await import('./agents')).AgentsView }))
const ArtifactsView = lazy(async () => ({ default: (await import('./artifacts')).ArtifactsView }))
const CanvasView = lazy(async () => ({ default: (await import('./canvas')).CanvasView }))
const CronView = lazy(async () => ({ default: (await import('./cron')).CronView }))
const SettingsView = lazy(async () => ({ default: (await import('./settings')).SettingsView }))
const SkillsView = lazy(async () => ({ default: (await import('./skills')).SkillsView }))

function subscribeViewportWidth(callback: () => void) {
  window.addEventListener('resize', callback)

  return () => window.removeEventListener('resize', callback)
}

const viewportWidthSnapshot = () => window.innerWidth

// Rows a session refresh must preserve even if the server omits them: in-flight
// first turns (message_count 0), pinned rows aged off the page, and the
// actively-viewed chat (its "working" flag clears a beat before the server sees
// the persisted row).
function sessionsToKeep(): Set<string> {
  // Include recently-settled sessions (turn ended within the grace window) so a
  // brand-new chat finished while viewing another isn't evicted by
  // mergeSessionPage before the listSessions aggregator catches up.
  const keep = new Set<string>([
    ...$workingSessionIds.get(),
    ...$pinnedSessionIds.get(),
    ...getRecentlySettledSessionIds()
  ])

  const active = $selectedStoredSessionId.get()

  if (active) {
    keep.add(active)
  }

  return keep
}

export function DesktopController() {
  const browserOnly = typeof window !== 'undefined' && !window.fanDesktop

  if (browserOnly) {
    return <BrowserOnlyNotice />
  }

  return <DesktopWorkspace />
}

function DesktopWorkspace() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()

  const busyRef = useRef(false)
  const creatingSessionRef = useRef(false)
  const refreshSessionsRequestRef = useRef(0)

  const gatewayState = useStore($gatewayState)
  const modelProviderSetup = useStore($modelProviderSetup)
  const activeBrowserWorkbenchId = useStore($activeBrowserWorkbenchId)
  const activeSessionId = useStore($activeSessionId)
  const currentCwd = useStore($currentCwd)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const filePreviewTarget = useStore($filePreviewTarget)
  const previewTarget = useStore($previewTarget)
  const fullWindowModalOpen = useStore($fullWindowModalOpen)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const sessionList = useStore($sessions)
  const sessionsLoading = useStore($sessionsLoading)
  const terminalTakeover = useStore($terminalTakeover)
  const modelProviderConfigured = Boolean(
    modelProviderSetup.phase === 'ready' && modelProviderSetup.response?.configured_provider
  )

  const routedSessionId = routeSessionId(location.pathname)
  const routeToken = `${location.pathname}:${location.search}:${location.hash}`
  const routeTokenRef = useRef(routeToken)
  routeTokenRef.current = routeToken
  const getRouteToken = useCallback(() => routeTokenRef.current, [])
  // The app-menu Settings listener mounts in an effect ABOVE the
  // useSessionActions destructure — route through a ref to avoid a TDZ read.
  const openSettingsRef = useRef<() => void>(() => undefined)
  // Native menu listeners subscribe once, but their destinations must retain
  // the current conversation as the overlay background. Refs avoid capturing
  // the location from the first render.
  const openAboutRef = useRef<() => void>(() => undefined)

  const {
    agentsOpen,
    backgroundLocation,
    chatOpen,
    chatSurfaceOpen,
    closeOverlayToPreviousRoute,
    cronOpen,
    currentView,
    openAgents,
    overlayOpen,
    settingsOpen
  } = useOverlayRouting()

  const terminalTakeoverActive = chatSurfaceOpen && terminalTakeover
  const sessionLayoutMode = useStore($effectiveSessionLayoutMode)
  const viewportWidth = useSyncExternalStore(subscribeViewportWidth, viewportWidthSnapshot, () => 1280)
  const previewRailWidthOverride = useStore($paneWidthOverride('preview'))
  const splitPreviewMaxWidth = Math.max(PREVIEW_RAIL_MIN_WIDTH_PX, viewportWidth - SESSION_VIEW_SPLIT_MIN_WIDTH)

  const previewSuppressedForSessionLayout =
    sessionLayoutMode === 'split' && viewportWidth < SESSION_VIEW_SPLIT_MIN_WIDTH + PREVIEW_RAIL_MIN_WIDTH_PX

  const previewPaneMaxWidth = sessionLayoutMode === 'split' ? splitPreviewMaxWidth : PREVIEW_RAIL_MAX_WIDTH

  const previewPaneWidth =
    sessionLayoutMode === 'split'
      ? `min(${PREVIEW_RAIL_PANE_WIDTH}, ${splitPreviewMaxWidth}px)`
      : PREVIEW_RAIL_PANE_WIDTH

  useEffect(() => {
    if (
      sessionLayoutMode === 'split' &&
      !previewSuppressedForSessionLayout &&
      previewRailWidthOverride !== undefined &&
      previewRailWidthOverride > splitPreviewMaxWidth
    ) {
      setPaneWidthOverride('preview', splitPreviewMaxWidth)
    }
  }, [
    previewRailWidthOverride,
    previewSuppressedForSessionLayout,
    sessionLayoutMode,
    splitPreviewMaxWidth
  ])

  const sessionLayoutAvailable = Boolean(
    chatOpen && !terminalTakeoverActive && (activeSessionId || selectedStoredSessionId || routedSessionId)
  )

  // Publish which chat transcript is on screen (null in overview/settings) so the
  // unread-badge trigger doesn't badge the session you're actively reading, and
  // clears a session's badge the moment you open it. Route id = stored id.
  useEffect(() => {
    const onChat = (chatSurfaceOpen ? 'chat' : currentView) === 'chat'
    setViewingSessionId(onChat ? selectedStoredSessionId || routedSessionId : null)
  }, [chatSurfaceOpen, currentView, selectedStoredSessionId, routedSessionId])

  // Event subscriptions cannot replay state lost during a renderer reload.
  // Runtime returns a complete revisioned snapshot; a delayed response cannot
  // overwrite a newer pushed revision in the store.
  useEffect(() => {
    if (!activeBrowserWorkbenchId) {
      return
    }

    const api = window.fanDesktop?.browser

    if (!api?.controlState) {
      return
    }

    const workbenchId = activeBrowserWorkbenchId
    let cancelled = false

    void api
      .controlState(workbenchId)
      .then(state => {
        if (cancelled) {
          return
        }

        if (state) {
          restoreBrowserControlState(state)
        } else {
          markBrowserOperatingStateKnownIdle(workbenchId)
        }
      })
      .catch(() => {
        if (!cancelled) {
          markBrowserOperatingStateKnownIdle(workbenchId)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeBrowserWorkbenchId])

  const titlebarToolGroups = useGroupRegistry<TitlebarTool>()
  const setTitlebarToolGroup = titlebarToolGroups.set

  const {
    activeSessionIdRef,
    ensureSessionState,
    releaseSessionState,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    syncSessionStateToView,
    updateSessionState
  } = useSessionStateCache({
    activeSessionId,
    busyRef,
    selectedStoredSessionId,
    setAwaitingResponse,
    setBusy,
    setMessages
  })

  const { connectionRef, gatewayRef, requestGateway } = useGatewayRequest()
  useBrowserStatePersistence(requestGateway, activeBrowserWorkbenchId ?? activeSessionId)

  useLayoutEffect(() => {
    // Main owns the native macOS Cmd+W accelerator. While a renderer modal is
    // open, route it back here even without a preview so the occlusion guard
    // below can consume it instead of closing the whole application window.
    window.fanDesktop?.setPreviewShortcutActive?.(
      Boolean(fullWindowModalOpen || (chatOpen && (filePreviewTarget || previewTarget)))
    )
  }, [chatOpen, filePreviewTarget, fullWindowModalOpen, previewTarget])

  useLayoutEffect(
    () => () => {
      // Do not leave Main believing the renderer owns Cmd+W after HMR or
      // workspace teardown.
      window.fanDesktop?.setPreviewShortcutActive?.(false)
    },
    []
  )

  useEffect(() => {
    // Seed the new-chat workspace from the configured default project dir
    // (Settings → Sessions), sanitized through the main process (rejects
    // install-dir / missing paths), so it wins over the sticky-localStorage
    // cwd.
    void ensureDefaultWorkspaceCwd()
    startUpdatePoller()

    // macOS app-menu Settings… (⌘,) — same destination as the titlebar gear.
    const runWithoutModal = (action: () => void) => {
      if (!$fullWindowModalOpen.get()) {
        action()
      }
    }

    const unsubscribeSettings = window.fanDesktop?.onOpenSettingsRequested?.(() =>
      runWithoutModal(openSettingsRef.current)
    )

    const unsubscribeAbout = window.fanDesktop?.onOpenAboutRequested?.(() =>
      runWithoutModal(openAboutRef.current)
    )

    const unsubscribeUpdates = window.fanDesktop?.onOpenUpdatesRequested?.(() =>
      runWithoutModal(openUpdatesWindow)
    )

    return () => {
      unsubscribeSettings?.()
      unsubscribeAbout?.()
      unsubscribeUpdates?.()
      stopUpdatePoller()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The preview rail stays mounted beneath full-window overlays — Cmd+W
      // there must not close a rail tab the user cannot currently see.
      if ($nativeViewOccluded.get()) {
        return
      }

      if (!$filePreviewTarget.get() && !$previewTarget.get()) {
        return
      }

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        event.stopPropagation()
        closeActiveRightRailTab()
      }
    }

    const unsubscribe = window.fanDesktop?.onClosePreviewRequested?.(() => {
      if (!$nativeViewOccluded.get()) {
        closeActiveRightRailTab()
      }
    })

    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      unsubscribe?.()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  // Global chrome shortcuts (plain Cmd/Ctrl, no alt/shift): Cmd+K / Cmd+P →
  // command palette (the composer's "drain next queued" moved to Cmd+Shift+K).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return
      }

      const key = event.key.toLowerCase()

      if (key === 'k' || key === 'p') {
        event.preventDefault()

        if ($nativeViewOccluded.get() && !$commandPaletteOpen.get()) {
          return
        }

        toggleCommandPalette()
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Warm the overlay-route chunks at idle so the first open never shows a
  // loading gap (dev: vite transforms the module graph on demand; prod:
  // fetches the chunk). Imports are cached, so this is one-time work.
  useEffect(() => {
    const idle = window.requestIdleCallback?.(() => {
      void import('./settings')
      void import('./agents')
      void import('./cron')
    })

    return () => {
      if (idle !== undefined) {
        window.cancelIdleCallback?.(idle)
      }
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    const requestId = refreshSessionsRequestRef.current + 1
    refreshSessionsRequestRef.current = requestId
    setSessionsLoading(true)

    try {
      const limit = $sessionsLimit.get()
      // Include EMPTY (zero-message) sessions in the overview. Since there is no
      // draft concept — clicking New creates a real, persisted session — an
      // empty session is a legitimate first-class entry the user chose to keep
      // (product decision 2026-07-05). min_messages=1 was the old draft-era
      // filter and made those sessions vanish on refresh.
      const result = await listSessions(limit, 0)

      if (refreshSessionsRequestRef.current === requestId) {
        setSessions(prev => mergeSessionPage(prev, result.sessions, sessionsToKeep()))
        setSessionsTotal(typeof result.total === 'number' ? result.total : result.sessions.length)
      }
    } finally {
      if (refreshSessionsRequestRef.current === requestId) {
        setSessionsLoading(false)
      }
    }
  }, [])

  const dismissError = useCallback(
    (messageId: string) => {
      const runtimeSessionId = activeSessionIdRef.current

      if (!runtimeSessionId) {
        return
      }

      // Clear the live view first. preserveLocalAssistantErrors uses it as the
      // baseline during refresh, so cache-only removal would be resurrected by
      // the next session.info or hydration response.
      setMessages(messages => dismissAssistantMessageError(messages, messageId))
      updateSessionState(runtimeSessionId, state => ({
        ...state,
        messages: dismissAssistantMessageError(state.messages, messageId)
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const updateActiveSessionRuntimeInfo = useCallback(
    (info: { branch?: string; cwd?: string }) => {
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => ({
        ...state,
        branch: info.branch ?? state.branch,
        cwd: info.cwd ?? state.cwd
      }))
    },
    [activeSessionIdRef, updateSessionState]
  )

  const { changeSessionCwd, refreshProjectBranch } = useCwdActions({
    activeSessionId,
    activeSessionIdRef,
    onSessionRuntimeInfo: updateActiveSessionRuntimeInfo,
    requestGateway
  })

  const { refreshFanConfig } = useFanConfig({
    activeSessionIdRef,
    refreshProjectBranch
  })

  // Read-only reflection of the locally configured runtime model. There is no
  // in-composer provider switcher, so this mirrors what the local gateway reports.
  const refreshCurrentModel = useCallback(async () => {
    try {
      const result = await getGlobalModelInfo()

      if (typeof result.model === 'string') {
        setCurrentModel(result.model)
      }

      if (typeof result.provider === 'string') {
        setCurrentProvider(result.provider)
      }
    } catch {
      // The delayed session.info event still updates this once the agent is ready.
    }
  }, [])

  useContextSuggestions({
    activeSessionId,
    activeSessionIdRef,
    currentCwd,
    gatewayState: modelProviderConfigured ? gatewayState : undefined,
    requestGateway
  })

  const hydrateFromStoredSession = useCallback(
    async (
      attempts = 1,
      storedSessionId = selectedStoredSessionIdRef.current,
      runtimeSessionId = activeSessionIdRef.current
    ) => {
      if (!storedSessionId || !runtimeSessionId) {
        return
      }

      for (let index = 0; index < Math.max(1, attempts); index += 1) {
        try {
          const latest = await getSessionMessages(storedSessionId)
          updateSessionState(
            runtimeSessionId,
            state => ({
              ...state,
              messages: preserveLocalAssistantErrors(toChatMessages(latest.messages), state.messages)
            }),
            storedSessionId
          )

          return
        } catch {
          // Best-effort fallback when live stream payloads are empty.
        }

        if (index < attempts - 1) {
          await new Promise(resolve => window.setTimeout(resolve, 250))
        }
      }
    },
    [activeSessionIdRef, selectedStoredSessionIdRef, updateSessionState]
  )

  const { handleGatewayEvent } = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession,
    queryClient,
    refreshFanConfig,
    refreshSessions,
    updateSessionState
  })

  const { handleDesktopGatewayEvent, restartPreviewServer } = usePreviewRouting({
    activeSessionIdRef,
    baseHandleGatewayEvent: handleGatewayEvent,
    currentCwd,
    // Background-aware: while an overlay route floats over a chat session the
    // preview target must survive (the rail stays mounted beneath the card) —
    // the real currentView ('settings') would clear it and collapse the rail.
    currentView: chatSurfaceOpen ? 'chat' : currentView,
    requestGateway,
    routedSessionId,
    selectedStoredSessionId
  })

  const {
    archiveSession,
    branchCurrentSession,
    createBackendSessionForSend,
    openSettings,
    removeSession,
    resumeSession,
    startNewSession
  } = useSessionActions({
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
  })

  openSettingsRef.current = openSettings
  openAboutRef.current = () =>
    navigateWithOverlayState(navigate, location, `${SETTINGS_ROUTE}?tab=about`)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      const editing =
        target?.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement

      if (event.defaultPrevented || event.repeat || event.altKey || event.code !== 'KeyN') {
        return
      }

      // Two accelerators for "new session":
      //   - Cmd/Ctrl+N (browser-like, works while typing in any input)
      //   - Shift+N    (single-key, only when no input is focused)
      const accelerator = event.metaKey || event.ctrlKey
      const singleKey = !accelerator && !editing && event.shiftKey

      if (!accelerator && !singleKey) {
        return
      }

      event.preventDefault()

      if ($nativeViewOccluded.get()) {
        return
      }

      startNewSession()
      // Briefly light up the sidebar's ⌘N hint so the shortcut is discoverable.
      window.dispatchEvent(new CustomEvent('fan:new-session-shortcut'))
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startNewSession])

  const composer = useComposerActions({
    activeSessionId,
    currentCwd,
    requestGateway
  })

  const branchInNewChat = useCallback(
    async (messageId?: string) => {
      const branched = await branchCurrentSession(messageId)

      if (branched) {
        await refreshSessions().catch(() => undefined)
      }

      return branched
    },
    [branchCurrentSession, refreshSessions]
  )

  const { cancelRun, editMessage, handleThreadMessagesChange, reloadFromMessage, submitText } = usePromptActions({
    activeSessionId,
    activeSessionIdRef,
    branchCurrentSession: branchInNewChat,
    busyRef,
    createBackendSessionForSend,
    getRouteToken,
    refreshSessions,
    requestGateway,
    selectedStoredSessionIdRef,
    startNewSession,
    updateSessionState
  })

  useGatewayBoot({
    handleGatewayEvent: handleDesktopGatewayEvent,
    onConnectionReady: c => {
      connectionRef.current = c
    },
    onGatewayReady: g => {
      gatewayRef.current = g
    },
    refreshFanConfig,
    refreshSessions
  })

  useEffect(() => {
    if (gatewayState !== 'open') {
      invalidateModelProviderSetup()

      return
    }

    void refreshModelProviders().catch(() => undefined)
    void refreshSessions().catch(() => undefined)
  }, [gatewayState, refreshSessions])

  useEffect(() => {
    if (gatewayState === 'open' && modelProviderConfigured) {
      void refreshCurrentModel()
    }
  }, [gatewayState, modelProviderConfigured, refreshCurrentModel])

  useRouteResume({
    activeSessionIdRef,
    creatingSessionRef,
    currentView,
    gatewayState: modelProviderConfigured ? gatewayState : undefined,
    locationPathname: location.pathname,
    resumeSession,
    resumeExhaustedSessionId,
    resumeFailedSessionId,
    routedSessionId,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef
  })

  const overlays = (
    <>
      <DesktopInstallOverlay />
      {/* One PTY-backed terminal mounted forever; <TerminalSlot /> placeholders
          decide where it shows. Toggling fullscreen never rebuilds the shell. */}
      <PersistentTerminal cwd={currentCwd} onAddSelectionToChat={composer.addTerminalSelectionAttachment} />
      <UpdatesOverlay />
      <GatewayConnectingOverlay />
      <BootFailureOverlay />
      <ModelProviderSetupOverlay
        onConfigured={() => {
          void refreshFanConfig()
          void refreshCurrentModel()
        }}
        visible={gatewayState === 'open'}
      />
      <CommandPalette />

      {settingsOpen && (
        <Suspense fallback={<OverlayFallback />}>
          <SettingsView
            gateway={gatewayRef.current}
            onClose={closeOverlayToPreviousRoute}
            onConfigSaved={() => {
              void refreshFanConfig()
              void refreshCurrentModel()
            }}
          />
        </Suspense>
      )}

      {agentsOpen && (
        <Suspense fallback={<OverlayFallback />}>
          <AgentsView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}

      {cronOpen && (
        <Suspense fallback={<OverlayFallback />}>
          <CronView onClose={closeOverlayToPreviousRoute} />
        </Suspense>
      )}

    </>
  )

  const chatView = (
    <ChatView
      gateway={gatewayRef.current}
      onAddContextRef={composer.addContextRefAttachment}
      onAddUrl={url => composer.addContextRefAttachment(`@url:${formatRefValue(url)}`, url)}
      onAttachDroppedItems={composer.attachDroppedItems}
      onAttachImageBlob={composer.attachImageBlob}
      onBranchInNewChat={branchInNewChat}
      onCancel={cancelRun}
      onDismissError={dismissError}
      onEdit={editMessage}
      onPasteClipboardImage={opts => composer.pasteClipboardImage(opts)}
      onPickFiles={() => void composer.pickContextPaths('file')}
      onPickFolders={() => void composer.pickContextPaths('folder')}
      onPickImages={() => void composer.pickImages()}
      onReload={reloadFromMessage}
      onRemoveAttachment={id => void composer.removeAttachment(id)}
      onRetryResume={sessionId => void resumeSession(sessionId, true, true)}
      onSubmit={submitText}
      onThreadMessagesChange={handleThreadMessagesChange}
    />
  )

  const takeoverTerminalView = (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      <TerminalSlot />
    </div>
  )

  const railSide = 'right' as const

  // The session view owns both the active browser and conversation. Users can
  // show either one full-width or keep the split layout; both remain mounted so
  // switching modes preserves the live page and transcript. They still leave
  // the shell together when the route no longer carries a chat surface.
  const sessionView = <SessionView requestGateway={requestGateway}>{chatView}</SessionView>

  // Empty first-entry state (spec §7): on the index route with no session
  // active, the main surface is a single centered "New Session Tile". Clicking
  // it creates a REAL session immediately (no draft concept) and navigates to
  // its route.
  // Index-route surface. The centered "+" empty tile is shown ONLY when there
  // are genuinely zero sessions. If the user has existing sessions, entering the
  // index (fresh launch / after closing all) goes straight to the Canvas
  // overview so they see all their sessions — the "+" is not a substitute for a
  // populated workbench. While the session list is still loading we render
  // nothing to avoid flashing the empty tile before sessions arrive.
  const isIndexEmpty = !activeSessionId && !selectedStoredSessionId
  let indexView: ReactNode

  if (!isIndexEmpty) {
    indexView = sessionView
  } else if (sessionsLoading) {
    indexView = null
  } else if (sessionList.length > 0) {
    indexView = <Navigate replace to={CANVAS_ROUTE} />
  } else {
    indexView = <NewSessionEmpty onNewSession={() => startNewSession()} />
  }

  const previewPane = (
    <Pane
      disabled={!chatSurfaceOpen || previewSuppressedForSessionLayout || (!previewTarget && !filePreviewTarget)}
      id="preview"
      key="preview"
      maxWidth={previewPaneMaxWidth}
      minWidth={PREVIEW_RAIL_MIN_WIDTH}
      resizable
      side={railSide}
      width={previewPaneWidth}
    >
      {chatSurfaceOpen && !previewSuppressedForSessionLayout ? (
        <ChatPreviewRail onRestartServer={restartPreviewServer} setTitlebarToolGroup={setTitlebarToolGroup} />
      ) : null}
    </Pane>
  )

  const fileBrowserPane = (
    <Pane
      defaultOpen={false}
      disabled={!chatSurfaceOpen}
      id="file-browser"
      key="file-browser"
      maxWidth={FILE_BROWSER_MAX_WIDTH}
      minWidth={FILE_BROWSER_MIN_WIDTH}
      resizable
      side={railSide}
      width={FILE_BROWSER_DEFAULT_WIDTH}
    >
      <RightSidebarPane
        onActivateFile={composer.attachContextFilePath}
        onActivateFolder={composer.attachContextFolderPath}
        onChangeCwd={changeSessionCwd}
      />
    </Pane>
  )

  return (
    <AppShell
      backgroundInert={overlayOpen}
      leftTitlebarTools={titlebarToolGroups.flat.left}
      onNewSession={startNewSession}
      onOpenSettings={openSettings}
      overlays={overlays}
      sessionLayoutAvailable={sessionLayoutAvailable}
      titlebarTools={titlebarToolGroups.flat.right}
    >
      <PaneMain>
        {/* While an overlay route (settings/…) is open, keep rendering the
            surface the user came from — classic background-location pattern.
            Unmounting it (the old `element={null}` behavior) flashed an empty
            shell and tore down the chat + native browser on every settings
            open. Hard-refreshing straight to /settings has no background and
            falls back to the real location (empty shell beneath, as before). */}
        <Routes location={backgroundLocation ?? location}>
          <Route element={terminalTakeoverActive ? takeoverTerminalView : indexView} index />
          <Route element={terminalTakeoverActive ? takeoverTerminalView : sessionView} path=":sessionId" />
          <Route
            element={
              <Suspense fallback={null}>
                <SkillsView />
              </Suspense>
            }
            path="skills"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <ArtifactsView />
              </Suspense>
            }
            path="artifacts"
          />
          <Route
            element={
              <Suspense fallback={null}>
                <CanvasView onArchiveSession={archiveSession} />
              </Suspense>
            }
            path="canvas"
          />
          <Route element={null} path="cron" />
          <Route element={null} path="settings" />
          <Route element={null} path="agents" />
          <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="new" />
          <Route element={<LegacySessionRedirect />} path="sessions/:sessionId" />
          <Route element={<Navigate replace to={NEW_CHAT_ROUTE} />} path="*" />
        </Routes>
      </PaneMain>
      {/* Order within a side maps to column order: main | preview | file-browser. */}
      {previewPane}
      {fileBrowserPane}
    </AppShell>
  )
}

function LegacySessionRedirect() {
  const { sessionId } = useParams()

  return <Navigate replace to={sessionId ? sessionRoute(sessionId) : NEW_CHAT_ROUTE} />
}
