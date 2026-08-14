import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { type Location, type NavigateFunction, useLocation, useNavigate } from 'react-router-dom'

import { AGENTS_ROUTE, appViewForPath, isOverlayView, NEW_CHAT_ROUTE } from '@/app/routes'
import { setOverlayRouteOpen } from '@/store/native-overlay'

// Overlay routes (settings / agents / cron) render as a
// full-window card ABOVE the surface the user came from, classic react-router
// background-location pattern: the opener stashes its location in history
// state, <Routes location={background}> keeps that surface mounted beneath,
// and closing simply navigates back. Without this the settings click swapped
// the whole session tree out (route element null) — chat + native browser
// unmounted, lazy chunk gap, visible flash.
interface OverlayLocationState {
  backgroundLocation?: string
}

function pathnameOf(to: string): string {
  return to.split(/[?#]/, 1)[0]
}

function backgroundLocationFrom(location: Pick<Location, 'state'>): string | undefined {
  const state = location.state as OverlayLocationState | null | undefined
  const background = state?.backgroundLocation

  return typeof background === 'string' && background ? background : undefined
}

/**
 * Navigate to any app path, attaching the background-location state when the
 * target is an overlay route. Opening an overlay FROM an overlay keeps the
 * original background (settings → agents still floats over the same
 * session). The native browser view (an OS surface above all DOM) is hidden
 * in the SAME frame as the navigate — fire-and-forget, not awaited: awaiting
 * leaves a bright empty pane for a frame before the overlay paints, while
 * same-frame hide+cover lands within one vsync.
 */
export function navigateWithOverlayState(navigate: NavigateFunction, location: Location, to: string): void {
  if (!isOverlayView(appViewForPath(pathnameOf(to)))) {
    navigate(to)

    return
  }

  const background = isOverlayView(appViewForPath(location.pathname))
    ? backgroundLocationFrom(location)
    : `${location.pathname}${location.search}${location.hash}`

  // Transfer ownership synchronously before a transient modal (for example the
  // command palette) can release its lease. The route effect below remains the
  // authoritative history/popstate reconciliation, but waiting for that effect
  // leaves one renderer commit in which native views can flash back on top.
  setOverlayRouteOpen(true)

  try {
    void window.fanDesktop?.browser?.hideAll?.('overlay')
  } catch {
    // The overlay-visibility effect in SessionBrowser re-hides regardless.
  }

  navigate(to, { state: { backgroundLocation: background } satisfies OverlayLocationState })
}

export function useOverlayRouting() {
  const location = useLocation()
  const navigate = useNavigate()

  const currentView = appViewForPath(location.pathname)
  const settingsOpen = currentView === 'settings'
  const agentsOpen = currentView === 'agents'
  const cronOpen = currentView === 'cron'
  const chatOpen = currentView === 'chat'
  const overlayOpen = isOverlayView(currentView)

  // The location the surface BENEATH an open overlay renders from (undefined
  // when no overlay is open, or on a hard refresh straight to /settings).
  const backgroundLocation = overlayOpen ? backgroundLocationFrom(location) : undefined

  // "A chat surface is mounted" — true also while an overlay floats above a
  // session, so the preview rail / terminal takeover beneath don't unmount and
  // shift layout under the card. Distinct from `chatOpen` (= chat is the
  // foreground view), which gates foreground-only behaviors like hotkeys.
  const chatSurfaceOpen = appViewForPath(pathnameOf(backgroundLocation ?? location.pathname)) === 'chat'

  // Background hotkey handlers (tool-approval Esc, Cmd+W, …) read this store
  // synchronously to stay quiet while a full-window overlay covers them.
  useLayoutEffect(() => {
    setOverlayRouteOpen(overlayOpen)
  }, [overlayOpen])

  // Overlay routes stash the underlying path so closing them returns there
  // instead of bouncing to /.
  const returnPathRef = useRef(NEW_CHAT_ROUTE)

  useEffect(() => {
    if (!overlayOpen) {
      returnPathRef.current = `${location.pathname}${location.search}${location.hash}`
    }
  }, [location.hash, location.pathname, location.search, overlayOpen])

  const closeOverlayToPreviousRoute = useCallback(
    () => navigate(returnPathRef.current || NEW_CHAT_ROUTE, { replace: true }),
    [navigate]
  )

  const openAgents = useCallback(() => navigateWithOverlayState(navigate, location, AGENTS_ROUTE), [location, navigate])

  return {
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
  }
}
