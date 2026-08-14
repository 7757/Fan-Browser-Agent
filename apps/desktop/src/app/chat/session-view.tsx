import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'

import { ResizeHandle, useColumnResize } from '@/components/pane-shell'
import { cn } from '@/lib/utils'
import { $activeBrowserControl, $activeBrowserOperating } from '@/store/browser-control'
import {
  $sessionChatWidth,
  clampSessionChatWidth,
  clampSessionChatWidthForContainer,
  setSessionChatWidth
} from '@/store/layout'
import { $activeBrowserWorkbenchId } from '@/store/session'
import {
  $effectiveSessionLayoutMode,
  $sessionLayoutPreference,
  markSessionBrowserAutoRevealed
} from '@/store/session-layout'

import { SessionBrowser } from './session-browser'

interface SessionViewProps {
  children: ReactNode
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
}

const CHAT_WIDTH_VAR = '--session-chat-width'

// The browser/chat divider resizes the native WebContentsView LIVE — no hiding,
// no frozen snapshot (those caused white flashes). The handle holds pointer
// capture, and each width change flows straight through the host's
// ResizeObserver into a native setBounds, so the page follows the divider.
export function SessionView({ children, requestGateway }: SessionViewProps) {
  const chatWidth = clampSessionChatWidth(useStore($sessionChatWidth))
  const effectiveMode = useStore($effectiveSessionLayoutMode)
  const preferredMode = useStore($sessionLayoutPreference)
  const activeBrowserControl = useStore($activeBrowserControl)
  const activeBrowserOperating = useStore($activeBrowserOperating)
  const activeBrowserWorkbenchId = useStore($activeBrowserWorkbenchId)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const liveWidthRef = useRef(chatWidth)
  const browserPanelRef = useRef<HTMLDivElement | null>(null)
  const chatPanelRef = useRef<HTMLElement | null>(null)
  const browserVisible = effectiveMode !== 'chat'
  const chatVisible = effectiveMode !== 'browser'
  const split = effectiveMode === 'split'

  // Opening the browser because the Agent needs it is a current-session
  // override, not a silent rewrite of the user's preferred layout. Retain that
  // reveal after control ends so the resulting page does not disappear at the
  // exact moment the response completes.
  useEffect(() => {
    if ((activeBrowserOperating || activeBrowserControl) && preferredMode === 'chat') {
      markSessionBrowserAutoRevealed(activeBrowserControl?.workbenchId ?? activeBrowserWorkbenchId)
    }
  }, [activeBrowserControl, activeBrowserOperating, activeBrowserWorkbenchId, preferredMode])

  // Drive the chat width through a CSS variable set IMPERATIVELY — never via a
  // React-managed inline style. A drag writes the var straight to the DOM and
  // only commits to the store on release. Two bugs this avoids:
  //  - going through setState every pointermove re-rendered the whole session
  //    subtree each frame, so the native browser view lagged the pointer;
  //  - a React-controlled width would be reset to the (stale, pre-drag) store
  //    value on ANY re-render mid-drag (e.g. the parent passing new children on
  //    a new/busy session), snapping the layout and tearing the native view —
  //    exactly the "drag left then right → crack" on fresh sessions.
  // The var lives on the root element, so re-renders never clobber it.
  useLayoutEffect(() => {
    const root = rootRef.current

    if (!root) {
      return
    }

    const syncWidth = () => {
      const clamped = root.clientWidth ? clampSessionChatWidthForContainer(chatWidth, root.clientWidth) : chatWidth

      liveWidthRef.current = clamped
      root.style.setProperty(CHAT_WIDTH_VAR, `${clamped}px`)
    }

    syncWidth()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(syncWidth)
    observer.observe(root)

    return () => observer.disconnect()
  }, [chatWidth])

  useLayoutEffect(() => {
    const activeElement = document.activeElement
    const hiddenPanel = !browserVisible ? browserPanelRef.current : !chatVisible ? chatPanelRef.current : null

    if (activeElement instanceof HTMLElement && hiddenPanel?.contains(activeElement)) {
      activeElement.blur()
    }
  }, [browserVisible, chatVisible])

  const startResize = useColumnResize({
    onEnd: () => setSessionChatWidth(liveWidthRef.current),
    onResize: width => {
      const rootWidth = rootRef.current?.clientWidth ?? 0
      const clamped = rootWidth ? clampSessionChatWidthForContainer(width, rootWidth) : clampSessionChatWidth(width)
      liveWidthRef.current = clamped
      rootRef.current?.style.setProperty(CHAT_WIDTH_VAR, `${clamped}px`)
    },
    side: 'right',
    startWidth: () => liveWidthRef.current
  })

  const browserColumn =
    effectiveMode === 'chat'
      ? '0px'
      : effectiveMode === 'browser'
        ? '100%'
        : `calc(100% - var(${CHAT_WIDTH_VAR}, ${chatWidth}px) - 0.375rem)`

  const chatColumn =
    effectiveMode === 'browser' ? '0px' : effectiveMode === 'chat' ? '100%' : `var(${CHAT_WIDTH_VAR}, ${chatWidth}px)`

  const gridTemplateColumns = `minmax(0, ${browserColumn}) minmax(0, ${chatColumn})`

  return (
    <div
      className={cn(
        'grid h-full min-h-0 w-full max-w-full min-w-0 overflow-hidden pb-4 pl-1.5 pr-2.5 pt-[58px]',
        'transition-[grid-template-columns,column-gap] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none'
      )}
      data-session-layout={effectiveMode}
      ref={rootRef}
      style={{ columnGap: split ? '0.375rem' : '0px', gridTemplateColumns }}
    >
      <div
        aria-hidden={!browserVisible}
        className={cn(
          'glass-panel relative min-h-0 min-w-0 overflow-hidden transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          browserVisible ? 'translate-x-0 opacity-100' : 'invisible -translate-x-2 pointer-events-none border-0 opacity-0'
        )}
        data-session-surface="browser"
        inert={!browserVisible}
        ref={browserPanelRef}
      >
        <SessionBrowser requestGateway={requestGateway} surfaceVisible={browserVisible} />
      </div>
      <aside
        aria-hidden={!chatVisible}
        className={cn(
          'glass-panel relative flex h-full min-h-0 min-w-0 flex-col',
          !chatVisible && 'invisible pointer-events-none border-0'
        )}
        data-overlay-anchor={chatVisible ? '' : undefined}
        data-session-surface="chat"
        inert={!chatVisible}
        ref={chatPanelRef}
      >
        {/* Handle is a direct child of the (non-clipping) aside so its gap-side
            overhang isn't clipped; content clips itself in the inner wrapper.
            lg-backdrop: the Liquid Glass ambient layer (tinted gradient +
            color blobs) the chat column's glass cards refract — without color
            underneath, blur+saturate has nothing to work with. */}
        {split && <ResizeHandle label="Resize chat panel" onPointerDown={startResize} side="right" />}
        <div className="lg-backdrop flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
          {children}
        </div>
      </aside>
    </div>
  )
}
