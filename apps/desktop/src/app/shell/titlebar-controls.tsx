import { useStore } from '@nanostores/react'
import { Columns2, Globe, LayoutGrid, MessageSquare, PanelRight, Plus, Settings } from 'lucide-react'
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { FAN_LOGO_MARK } from '@/lib/brand'
import { cn } from '@/lib/utils'
import { $fileBrowserOpen, FILE_BROWSER_PANE_ID } from '@/store/layout'
import { togglePane } from '@/store/panes'
import {
  $activeBrowserWorkbenchId,
  $connection,
  $selectedStoredSessionId,
  $sessions,
  $workingSessionIds
} from '@/store/session'
import {
  $effectiveSessionLayoutMode,
  $sessionLayoutConstraints,
  selectSessionLayoutMode,
  type SessionLayoutMode,
  sessionLayoutModeAllowed
} from '@/store/session-layout'
import { captureActiveThumbnail } from '@/store/session-thumbnails'

import {
  appViewForPath,
  CANVAS_ROUTE,
  isNewChatRoute,
  isOverlayView,
  NEW_CHAT_ROUTE,
  sessionRoute
} from '../routes'

import { frostedTitlebarButtonClass, titlebarButtonClass } from './titlebar'

export interface TitlebarTool {
  id: string
  label: string
  active?: boolean
  className?: string
  disabled?: boolean
  hidden?: boolean
  href?: string
  icon: ReactNode
  onSelect?: () => void
  title?: string
  to?: string
}

type TitlebarToolSide = 'left' | 'right'
export type SetTitlebarToolGroup = (id: string, tools: readonly TitlebarTool[], side?: TitlebarToolSide) => void

interface TitlebarControlsProps extends ComponentProps<'div'> {
  leftTools?: readonly TitlebarTool[]
  tools?: readonly TitlebarTool[]
  onNewSession: () => void
  onOpenSettings: () => void
  sessionLayoutAvailable?: boolean
}

const WINDOW_CONTROL_BUTTON_CLASS =
  'flex h-7 w-9 items-center justify-center rounded-md bg-transparent text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground'

// Self-drawn min/max/close for Windows/Linux — the OS-painted overlay's hover
// highlight is a hard unstylable rectangle, so we draw our own soft buttons
// and drive the window over IPC. macOS keeps its native traffic lights
// (windowButtonPosition non-null there), so this renders nothing on mac.
function WindowControls() {
  const { t } = useI18n()
  const connection = useStore($connection)
  const controls = window.fanDesktop?.windowControls
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!controls) {
      return
    }

    let alive = true

    void controls.isMaximized().then(value => {
      if (alive) {
        setMaximized(value)
      }
    })

    const unsubscribe = controls.onMaximizedChange(setMaximized)

    return () => {
      alive = false
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- preload bridge is static
  }, [])

  if (!controls || connection?.windowButtonPosition !== null) {
    return null
  }

  return (
    <div
      aria-label={t('窗口控制')}
      className="fixed right-2 top-[14px] z-70 flex h-[34px] flex-row items-center gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]"
    >
      <button
        aria-label={t('最小化')}
        className={WINDOW_CONTROL_BUTTON_CLASS}
        onClick={() => void controls.minimize()}
        type="button"
      >
        <Codicon name="chrome-minimize" size="0.875rem" />
      </button>
      <button
        aria-label={t(maximized ? '还原' : '最大化')}
        className={WINDOW_CONTROL_BUTTON_CLASS}
        onClick={() => void controls.toggleMaximize()}
        type="button"
      >
        <Codicon name={maximized ? 'chrome-restore' : 'chrome-maximize'} size="0.875rem" />
      </button>
      <button
        aria-label={t('关闭')}
        className={cn(WINDOW_CONTROL_BUTTON_CLASS, 'hover:bg-(--ui-red)/15 hover:text-(--ui-red)')}
        onClick={() => void controls.close()}
        type="button"
      >
        <Codicon name="chrome-close" size="0.875rem" />
      </button>
    </div>
  )
}

const SESSION_LAYOUT_OPTIONS = [
  { icon: MessageSquare, label: '仅对话', mode: 'chat' },
  { icon: Columns2, label: '分屏', mode: 'split' },
  { icon: Globe, label: '仅浏览器', mode: 'browser' }
] as const satisfies readonly { label: string; mode: SessionLayoutMode; icon: typeof MessageSquare }[]

function unavailableLayoutLabel(mode: SessionLayoutMode) {
  if (mode === 'chat') {
    return 'Fan 正在操作浏览器，暂时不能隐藏浏览器'
  }

  if (mode === 'browser') {
    return '请先处理当前对话请求'
  }

  return undefined
}

function SessionLayoutControl() {
  const { t } = useI18n()
  const effectiveMode = useStore($effectiveSessionLayoutMode)
  const constraints = useStore($sessionLayoutConstraints)
  const groupRef = useRef<HTMLDivElement | null>(null)

  const focusMode = (mode: SessionLayoutMode) => {
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-session-layout-option="${mode}"]`)?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, mode: SessionLayoutMode) => {
    const currentIndex = SESSION_LAYOUT_OPTIONS.findIndex(option => option.mode === mode)
    let direction = 0
    let targetIndex = currentIndex

    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      direction = -1
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      direction = 1
    } else if (event.key === 'Home') {
      targetIndex = 0
    } else if (event.key === 'End') {
      targetIndex = SESSION_LAYOUT_OPTIONS.length - 1
    } else {
      return
    }

    event.preventDefault()

    if (direction !== 0) {
      for (let offset = 1; offset <= SESSION_LAYOUT_OPTIONS.length; offset += 1) {
        const candidateIndex =
          (currentIndex + direction * offset + SESSION_LAYOUT_OPTIONS.length) % SESSION_LAYOUT_OPTIONS.length

        const candidate = SESSION_LAYOUT_OPTIONS[candidateIndex]

        if (sessionLayoutModeAllowed(candidate.mode, constraints)) {
          targetIndex = candidateIndex

          break
        }
      }
    } else {
      const allowedIndexes = SESSION_LAYOUT_OPTIONS.map((option, index) => ({ index, option }))
        .filter(({ option }) => sessionLayoutModeAllowed(option.mode, constraints))
        .map(({ index }) => index)

      targetIndex =
        (event.key === 'Home' ? allowedIndexes[0] : allowedIndexes[allowedIndexes.length - 1]) ?? currentIndex
    }

    const targetMode = SESSION_LAYOUT_OPTIONS[targetIndex].mode
    focusMode(targetMode)
    selectSessionLayoutMode(targetMode)
  }

  return (
    <div
      aria-label={t('会话布局')}
      className="grid h-[34px] w-[90px] shrink-0 grid-cols-3 items-center rounded-full border border-white/90 bg-white/48 p-[3px] shadow-[0_6px_14px_-2px_#22325C26,0_1.2px_1px_0_#FFFFFFF2] backdrop-blur-[18px] dark:border-white/12 dark:bg-white/10"
      ref={groupRef}
      role="radiogroup"
    >
      {SESSION_LAYOUT_OPTIONS.map(option => {
        const allowed = sessionLayoutModeAllowed(option.mode, constraints)
        const active = effectiveMode === option.mode
        const Icon = option.icon
        const unavailableLabel = allowed ? undefined : unavailableLayoutLabel(option.mode)

        return (
          <Tip key={option.mode} label={t(unavailableLabel ?? option.label)} side="bottom">
            <button
              aria-checked={active}
              aria-description={unavailableLabel ? t(unavailableLabel) : undefined}
              aria-disabled={!allowed || undefined}
              aria-label={t(option.label)}
              className={cn(
                'flex size-7 items-center justify-center rounded-full text-[#58616D] transition-[color,background-color,box-shadow,transform] duration-150 ease-out [-webkit-app-region:no-drag] [&_svg]:size-[15px]',
                'hover:bg-white/55 hover:text-[#252A31] active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 dark:text-[#B8C0CB] dark:hover:bg-white/12 dark:hover:text-white',
                active &&
                  'bg-[#1A1D21]/88 text-white shadow-[0_3px_8px_-1px_#22325C55,0_1px_1px_0_#FFFFFF3D] hover:bg-[#1A1D21]/92 hover:text-white dark:bg-white/90 dark:text-[#1A1D21] dark:hover:bg-white dark:hover:text-[#1A1D21]',
                !allowed && 'cursor-not-allowed opacity-45 hover:bg-transparent hover:text-inherit active:scale-100'
              )}
              data-session-layout-option={option.mode}
              onClick={() => {
                if (allowed) {
                  selectSessionLayoutMode(option.mode)
                }
              }}
              onKeyDown={event => handleKeyDown(event, option.mode)}
              onPointerDown={event => event.stopPropagation()}
              role="radio"
              tabIndex={active ? 0 : -1}
              type="button"
            >
              <Icon />
            </button>
          </Tip>
        )
      })}
    </div>
  )
}

export function TitlebarControls({
  leftTools = [],
  onNewSession,
  onOpenSettings,
  sessionLayoutAvailable = false,
  tools = []
}: TitlebarControlsProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const activeBrowserWorkbenchId = useStore($activeBrowserWorkbenchId)
  const fileBrowserOpen = useStore($fileBrowserOpen)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const sessions = useStore($sessions)
  const workingSessionIds = useStore($workingSessionIds)
  const canvasTransitionPendingRef = useRef(false)
  const [sessionActionsHoverOpen, setSessionActionsHoverOpen] = useState(false)
  const onCanvas = location.pathname === CANVAS_ROUTE

  useEffect(() => {
    if (onCanvas) {
      canvasTransitionPendingRef.current = false
    }
  }, [onCanvas])

  // In the true first-entry empty state keep only Settings; session
  // actions are irrelevant until the user creates the first session.
  const emptyState = isNewChatRoute(location.pathname) && sessions.length === 0
  // A live session already has its layout switcher in the titlebar. Keep that
  // control visible as the hover target and tuck the secondary system actions
  // away until the user needs them. Canvas and the empty state keep their
  // normal always-visible controls.
  const sessionActionsCollapsible = sessionLayoutAvailable && !emptyState && !onCanvas
  const sessionActionsExpanded = !sessionActionsCollapsible || sessionActionsHoverOpen

  useEffect(() => {
    if (!sessionActionsCollapsible) {
      setSessionActionsHoverOpen(false)
    }
  }, [sessionActionsCollapsible])

  // The sessions sidebar never fully hides (collapsed = the 66px icon rail with
  // its own expand button), so the titlebar carries no sidebar toggle at all.
  const leftToolbarTools: TitlebarTool[] = [...leftTools]

  // While a full-screen overlay (settings, command center, …) is open it should
  // visually own the window. These control clusters are `fixed` at a higher
  // z-index than the overlay card, so they'd otherwise bleed over it — hide them
  // and let the overlay's own chrome (close button, drag region) take over.
  // The self-drawn window buttons stay regardless: the window must remain
  // minimizable/closable with an overlay open (the native overlay always was).
  if (isOverlayView(appViewForPath(location.pathname))) {
    return <WindowControls />
  }

  const visiblePaneTools = tools.filter(tool => !tool.hidden)

  const applicationMenuAvailable = Boolean(window.fanDesktop?.applicationMenu?.showInTitlebar)

  // Canvas button toggles the overview: into it from anywhere, or back out to
  // a valid session. Archiving the selected session clears its id; routing to
  // the new-chat index while sessions still exist immediately redirects back
  // to Canvas and looks like a dead button, so fall back to the first session.
  const toggleCanvas = () => {
    if (onCanvas) {
      const returnSessionId = sessions.some(session => session.id === selectedStoredSessionId)
        ? selectedStoredSessionId
        : sessions[0]?.id

      navigate(returnSessionId ? sessionRoute(returnSessionId) : NEW_CHAT_ROUTE)
    } else {
      if (canvasTransitionPendingRef.current) {
        return
      }

      canvasTransitionPendingRef.current = true

      const selectedSessionWorking = Boolean(
        selectedStoredSessionId && workingSessionIds.includes(selectedStoredSessionId)
      )

      // The operating frame and Agent cursor are rendered inside the page.
      // Canvas floats the real live view while this session is working, so a
      // departure snapshot is both unnecessary and unsafe: it would persist
      // those transient controls as if they were page content.
      if (selectedSessionWorking) {
        navigate(CANVAS_ROUTE)

        return
      }
      // Safari-style overview: grab a static still of the session we're leaving
      // so its Canvas tile shows the real page, not a skeleton. Wait before
      // changing routes: hiding the live BrowserView first can make capture
      // return null. Snapshotting is best-effort, so Canvas still opens if it
      // fails. Ignore repeat clicks while this transition is in flight.
      void (async () => {
        try {
          await captureActiveThumbnail(selectedStoredSessionId, activeBrowserWorkbenchId ?? selectedStoredSessionId)
        } catch {
          // The capture store normally absorbs bridge failures, but preserve
          // navigation even if an injected/custom implementation rejects.
        } finally {
          navigate(CANVAS_ROUTE)
        }
      })()
    }
  }

  return (
    <>
      <WindowControls />
      {/* On macOS the system menu bar owns the application menu, so this stays
          a static brand lockup. Frameless Windows/Linux windows have no native
          menu bar; there the same lockup opens Main's shared Chinese menu. */}
      <button
        aria-label={applicationMenuAvailable ? t('打开应用菜单') : undefined}
        className={cn(
          'fixed left-(--titlebar-controls-left) top-[14px] z-70 flex h-[34px] items-center gap-[7px] select-none',
          applicationMenuAvailable
            ? 'pointer-events-auto -ml-1 rounded-md px-1 [-webkit-app-region:no-drag] hover:bg-(--chrome-action-hover)'
            : 'pointer-events-none'
        )}
        disabled={!applicationMenuAvailable}
        onClick={() => void window.fanDesktop?.applicationMenu?.popup()}
        type="button"
      >
        <img alt="Fan" className="h-5 w-5" draggable={false} src={FAN_LOGO_MARK} />
        <span
          className="leading-none text-[#0A0A0B] dark:text-[#F2F3F5]"
          style={{
            fontFamily: "'Poppins', var(--dt-font-sans)",
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: '1.5px'
          }}
        >
          FAN
        </span>
      </button>
      <div
        aria-label={t('窗口控件')}
        className="fixed left-(--titlebar-controls-left) top-(--titlebar-controls-top) z-70 flex translate-y-0.5 flex-row items-center gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]"
      >
        {leftToolbarTools
          .filter(tool => !tool.hidden)
          .map(tool => (
            <TitlebarToolButton key={tool.id} navigate={navigate} tool={tool} />
          ))}
      </div>

      {/*
        Pane-scoped tools (preview's monitor / devtools / refresh / X) render
        as their own fixed cluster. AppShell sets --shell-preview-toolbar-gap
        to either the static cluster's width (file-browser closed → cluster
        sits flush against system tools) or the file-browser pane's width
        (file-browser open → cluster sits flush against the file-browser pane,
        i.e. at the preview pane's right edge). No margin hacks needed.
      */}
      {visiblePaneTools.length > 0 && (
        <div
          aria-label={t('面板控件')}
          className="fixed top-(--titlebar-controls-top) right-[calc(var(--titlebar-tools-right)+var(--shell-preview-toolbar-gap,0))] z-70 flex flex-row items-center gap-x-1 pointer-events-auto select-none [-webkit-app-region:no-drag]"
        >
          {visiblePaneTools.map(tool => (
            <TitlebarToolButton key={tool.id} navigate={navigate} tool={tool} />
          ))}
        </div>
      )}

      {/* Right cluster: session layout / New / Canvas / Support / Settings.
          Empty state keeps Support + Settings so help remains reachable before
          first setup. */}
      <div
        aria-label={t('应用控件')}
        className="fixed right-(--titlebar-tools-right) top-[14px] z-70 flex h-[34px] flex-row items-center justify-end gap-x-2.5 pointer-events-auto select-none [-webkit-app-region:no-drag]"
        data-session-actions-state={sessionActionsCollapsible ? (sessionActionsExpanded ? 'expanded' : 'collapsed') : undefined}
        onBlur={event => {
          if (
            sessionActionsCollapsible &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setSessionActionsHoverOpen(false)
          }
        }}
        onFocusCapture={() => {
          if (sessionActionsCollapsible) {
            setSessionActionsHoverOpen(true)
          }
        }}
        onPointerEnter={() => {
          if (sessionActionsCollapsible) {
            setSessionActionsHoverOpen(true)
          }
        }}
        onPointerLeave={() => {
          if (sessionActionsCollapsible) {
            setSessionActionsHoverOpen(false)
          }
        }}
      >
        {!emptyState && (
          <>
            {sessionLayoutAvailable && <SessionLayoutControl />}
            <div
              aria-hidden={sessionActionsCollapsible && !sessionActionsExpanded ? true : undefined}
              className={cn(
                // Keep the width reveal clipped while allowing the 1.08 hover
                // scale (1.36px per side) to paint without flattening the
                // first/last button against the reveal boundary.
                'flex h-[58px] shrink-0 items-center justify-end overflow-clip [overflow-clip-margin:2px] transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none',
                sessionActionsExpanded ? 'w-[166px] opacity-100' : 'pointer-events-none w-0 opacity-0'
              )}
              inert={sessionActionsCollapsible && !sessionActionsExpanded}
            >
              <div className="flex shrink-0 items-center gap-x-2.5">
                <FrostedTitlebarButton icon={<Plus />} label={t('新建会话')} onSelect={onNewSession} />
                <FrostedTitlebarButton
                  active={onCanvas}
                  icon={<LayoutGrid />}
                  label={t('全部对话')}
                  onSelect={toggleCanvas}
                />
                <FrostedTitlebarButton
                  active={fileBrowserOpen}
                  icon={<PanelRight />}
                  label={t(fileBrowserOpen ? '关闭文件与终端面板' : '打开文件与终端面板')}
                  onSelect={() => togglePane(FILE_BROWSER_PANE_ID)}
                />
                <FrostedTitlebarButton icon={<Settings />} label={t('设置')} onSelect={onOpenSettings} />
              </div>
            </div>
          </>
        )}
        {emptyState && (
          <>
            <FrostedTitlebarButton icon={<Settings />} label={t('设置')} onSelect={onOpenSettings} />
          </>
        )}
      </div>
    </>
  )
}

// A single 34px frosted round titlebar button (spec §2). Local <button> with
// no-drag + pointer-down stop so the drag region beneath never swallows clicks.
function FrostedTitlebarButton({
  active,
  icon,
  label,
  onSelect
}: {
  active?: boolean
  icon: ReactNode
  label: string
  onSelect: () => void
}) {
  return (
    // App Tip instead of native `title`: the native tooltip needs a long,
    // uninterrupted hover and fights the titlebar's drag region — which made it
    // fire only sometimes. Tip is instant, consistent, and matches the browser
    // toolbar's tips.
    <Tip label={label} side="bottom">
      <button
        aria-label={label}
        aria-pressed={active ?? undefined}
        className={cn(
          frostedTitlebarButtonClass,
          '[-webkit-app-region:no-drag]',
          // Active toggle = the design's solid near-black pill (Pencil aJ0PD node
          // pTn3Z): #1A1D21D9 fill, white/25 hairline, and white icon. Dark mode
          // flips to a near-white pill with a dark icon.
          active &&
            'border-white/25 bg-[#1A1D21]/85 text-white hover:bg-[#1A1D21]/90 dark:border-white/20 dark:bg-white/90 dark:text-[#1A1D21] dark:hover:bg-white'
        )}
        onClick={onSelect}
        onPointerDown={event => event.stopPropagation()}
        type="button"
      >
        {icon}
      </button>
    </Tip>
  )
}

function TitlebarToolButton({ navigate, tool }: { navigate: ReturnType<typeof useNavigate>; tool: TitlebarTool }) {
  // Titlebar actions never show an active background — state reads from the
  // icon itself (e.g. the mute/unmute glyph). aria-pressed still carries it
  // for a11y.
  const className = cn(titlebarButtonClass, 'bg-transparent select-none', tool.className)

  if (tool.href) {
    return (
      <Button asChild className={className} size="icon-titlebar" variant="ghost">
        <a
          aria-label={tool.label}
          href={tool.href}
          onPointerDown={event => event.stopPropagation()}
          rel="noreferrer"
          target="_blank"
        >
          {tool.icon}
        </a>
      </Button>
    )
  }

  return (
    <Button
      aria-label={tool.label}
      aria-pressed={tool.active ?? undefined}
      className={className}
      disabled={tool.disabled}
      onClick={() => {
        if (tool.to) {
          navigate(tool.to)
        }

        tool.onSelect?.()
      }}
      onPointerDown={event => event.stopPropagation()}
      size="icon-titlebar"
      type="button"
      variant="ghost"
    >
      {tool.icon}
    </Button>
  )
}
