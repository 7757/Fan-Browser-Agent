import { useStore } from '@nanostores/react'
import type { CSSProperties, ReactNode } from 'react'
import { useSyncExternalStore } from 'react'

import { BrowserShellPromptOverlay } from '@/components/browser-shell-prompt-overlay'
import { NotificationStack } from '@/components/notifications'
import { PaneShell } from '@/components/pane-shell'
import { PromptOverlays } from '@/components/prompt-overlays'
import { $fileBrowserOpen, FILE_BROWSER_DEFAULT_WIDTH, FILE_BROWSER_PANE_ID } from '@/store/layout'
import { $paneWidthOverride } from '@/store/panes'
import { $connection } from '@/store/session'

import { TITLEBAR_HEIGHT, titlebarControlsPosition } from './titlebar'
import { TitlebarControls, type TitlebarTool } from './titlebar-controls'

interface AppShellProps {
  /** A full-window overlay route is open: the shell content beneath it stays
      mounted but must be inert (no focus, no clicks) until it closes. */
  backgroundInert?: boolean
  children: ReactNode
  leftTitlebarTools?: readonly TitlebarTool[]
  onNewSession: () => void
  onOpenSettings: () => void
  overlays?: ReactNode
  sessionLayoutAvailable?: boolean
  titlebarTools?: readonly TitlebarTool[]
}

// Renderer-side fallback so layout snaps even when the main-process fullscreen event
// hasn't landed yet (e.g. dev reloads, before the IPC bridge is wired).
function subscribeWindowSize(cb: () => void) {
  window.addEventListener('resize', cb)
  window.addEventListener('fullscreenchange', cb)

  return () => {
    window.removeEventListener('resize', cb)
    window.removeEventListener('fullscreenchange', cb)
  }
}

const viewportIsFullscreen = () =>
  window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height

export function AppShell({
  backgroundInert,
  children,
  leftTitlebarTools,
  onNewSession,
  onOpenSettings,
  overlays,
  sessionLayoutAvailable = false,
  titlebarTools
}: AppShellProps) {
  const fileBrowserOpen = useStore($fileBrowserOpen)
  const fileBrowserWidthOverride = useStore($paneWidthOverride(FILE_BROWSER_PANE_ID))
  const connection = useStore($connection)
  const viewportFullscreen = useSyncExternalStore(subscribeWindowSize, viewportIsFullscreen, () => false)
  const isFullscreen = Boolean(connection?.isFullscreen) || viewportFullscreen
  const titlebarControls = titlebarControlsPosition(connection?.windowButtonPosition, isFullscreen)
  // Width Windows/Linux reserve for the OS-painted min/max/close overlay (zero
  // on macOS, where window controls sit on the left and are reported via
  // windowButtonPosition instead). The right tool cluster has to clear them.
  const nativeOverlayWidth = connection?.nativeOverlayWidth ?? 0
  // Design (aJ0PD Top Bar): window inset 14 + bar right padding 18 = 32px.
  const titlebarToolsRight = nativeOverlayWidth > 0 ? `${nativeOverlayWidth}px` : '2rem'

  // The sessions sidebar never fully hides (collapsed = the 66px icon rail), so
  // something always covers the window's left edge and no content inset is
  // needed for the top-left titlebar buttons.
  const titlebarContentInset = 0

  // The static system cluster (New / Canvas / Support / Settings — four
  // 34px frosted round buttons) is hardcoded in TitlebarControls. Pane-supplied
  // tools (preview's group) render in a separate cluster anchored further left.
  //
  // Width math tracks the frosted cluster's `gap-x-2.5` (0.625rem = 10px) rows:
  // N buttons + (N - 1) inner gaps, plus one extra 10px of breathing room
  // between the pane-tool cluster and the system cluster so they don't sit
  // flush against each other. Modeled as N gaps (N - 1 inner + 1 trailing)
  // to keep the formula generic for any pane-tool count.
  const SYSTEM_TOOL_COUNT = 4
  const paneToolCount = titlebarTools?.filter(tool => !tool.hidden).length ?? 0
  // The 3-way session layout pill is 5.625rem wide and participates in the
  // right cluster's existing 0.625rem gap. Reserve both so the drag strip and
  // preview-tool anchor never sit underneath an interactive control.
  const sessionLayoutToolsWidth = sessionLayoutAvailable ? '6.25rem' : '0rem'
  const systemToolsWidth = `calc(${SYSTEM_TOOL_COUNT} * (var(--titlebar-frosted-size) + 0.625rem) + ${sessionLayoutToolsWidth})`

  const fileBrowserWidth =
    fileBrowserWidthOverride !== undefined ? `${fileBrowserWidthOverride}px` : FILE_BROWSER_DEFAULT_WIDTH

  // Where the pane-tool cluster's right edge sits, measured from the inner
  // titlebar padding (--titlebar-tools-right). Two anchors:
  //   - file-browser closed → flush against static cluster's left edge
  //   - file-browser open   → flush against the file-browser pane's left edge
  //                           (= preview pane's right edge)
  const previewToolbarGap = fileBrowserOpen ? fileBrowserWidth : systemToolsWidth

  // Used by the drag region to know where the rightmost interactive element
  // ends. When pane tools are present, that's `gap + paneCount * controlSize
  // + paneCount * 0.25rem` (the leftmost button is at `tools-right + gap +
  // paneCount * (size + gap-x-1)`). Otherwise the static cluster's footprint
  // is enough.
  const titlebarToolsWidth =
    paneToolCount > 0
      ? `calc(${previewToolbarGap} + ${paneToolCount} * (var(--titlebar-control-size) + 0.25rem))`
      : systemToolsWidth

  return (
    <div
      // No DOM corner radius: macOS rounds the WINDOW itself (~10px). A DOM
      // radius larger than the native one cut away content and exposed the
      // window's white background as bare slivers in all four corners.
      className="app-bloom-bg flex w-full h-screen min-h-0 flex-col overflow-hidden"
      style={
        {
          '--titlebar-height': `${TITLEBAR_HEIGHT}px`,
          '--titlebar-content-inset': `${titlebarContentInset}px`,
          '--titlebar-controls-left': `${titlebarControls.left}px`,
          '--titlebar-controls-top': `${titlebarControls.top}px`,
          '--titlebar-tools-right': titlebarToolsRight,
          '--titlebar-tools-width': titlebarToolsWidth,
          // Anchor for the pane-tool cluster's right edge in TitlebarControls.
          // Sourced from the layout store rather than the PaneShell-emitted
          // --pane-*-width vars because the titlebar is a sibling of PaneShell
          // and CSS variables resolve at the consumer's scope.
          '--shell-preview-toolbar-gap': previewToolbarGap
        } as CSSProperties
      }
    >
      <TitlebarControls
        leftTools={leftTitlebarTools}
        onNewSession={onNewSession}
        onOpenSettings={onOpenSettings}
        sessionLayoutAvailable={sessionLayoutAvailable}
        tools={titlebarTools}
      />

      <main
        className="relative z-3 flex min-h-0 w-full flex-1 flex-col overflow-hidden transition-none"
        // Keyboard focus / Tab order must not reach the covered surface; its
        // window-level hotkeys guard themselves via $overlayRouteOpen.
        inert={backgroundInert}
      >
        <PaneShell className="min-h-0 flex-1">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 z-1 h-(--titlebar-height) w-(--titlebar-controls-left) [-webkit-app-region:drag]"
          />
          {/* 2nd drag strip starts past the FAN lockup (~64px: 20px mark +
              7px gap + Poppins wordmark) so it never covers the brand. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-1 h-(--titlebar-height) left-[calc(var(--titlebar-controls-left)+72px)] right-[calc(var(--titlebar-tools-right)+var(--titlebar-tools-width)+0.75rem)] [-webkit-app-region:drag]"
          />

          {children}
        </PaneShell>
      </main>

      {overlays}

      {/* Gateway prompts can arrive while Canvas/settings is foreground. Keep
          their blocking dialog global; BrowserShellPromptOverlay below takes
          priority when Chromium itself is waiting for a response. */}
      <PromptOverlays />

      {/* Browser-native prompts block Chromium until the user responds. Keep
          this renderer globally mounted so tab/session changes cannot silently
          strand a JavaScript dialog, permission request or external-app handoff. */}
      <BrowserShellPromptOverlay />

      {/* Mounted at the shell root so success/error toasts surface across every
          route. Blocking browser prompts intentionally remain above them. */}
      <NotificationStack />
    </div>
  )
}
