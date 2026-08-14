import { useStore } from '@nanostores/react'
import {
  Children,
  type CSSProperties,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef
} from 'react'

import { cn } from '@/lib/utils'
import { $paneStates, ensurePaneRegistered, setPaneWidthOverride } from '@/store/panes'

import { PaneShellContext, type PaneShellContextValue, type PaneSlot } from './context'
import { ResizeHandle } from './resize-handle'
import { useColumnResize } from './use-column-resize'

type PaneSide = 'left' | 'right'
type WidthValue = string | number

interface PaneRoleMarker {
  __paneShellRole?: 'pane' | 'main'
}

export interface PaneProps {
  children?: ReactNode
  className?: string
  defaultOpen?: boolean
  /** Forces the pane closed (track→0, aria-hidden) without writing to the store — for transient route gates. */
  disabled?: boolean
  id: string
  maxWidth?: WidthValue
  minWidth?: WidthValue
  resizable?: boolean
  /** Override the resize handle's vertical extent (e.g. to match an inset glass panel). */
  resizeHandleClassName?: string
  side: PaneSide
  width?: WidthValue
}

export interface PaneMainProps {
  children?: ReactNode
  className?: string
}

export interface PaneShellProps {
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

interface CollectedPane {
  defaultOpen: boolean
  disabled: boolean
  id: string
  resizable: boolean
  side: PaneSide
  width: string
}

const DEFAULT_WIDTH = '16rem'
const DEFAULT_RESIZE_MIN_WIDTH = 160

const widthToCss = (value: WidthValue | undefined, fallback: string) =>
  value === undefined ? fallback : typeof value === 'number' ? `${value}px` : value

const remPx = () =>
  typeof window === 'undefined'
    ? 16
    : Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16

// Resolves PaneProps.minWidth/maxWidth (number | "Npx" | "Nrem") to pixels for drag clamping.
function widthToPx(value: WidthValue | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  const match = value?.trim().match(/^(-?\d*\.?\d+)(px|rem)?$/)

  if (!match) {
    return undefined
  }

  return Number.parseFloat(match[1]) * (match[2] === 'rem' ? remPx() : 1)
}

function isRole(child: unknown, role: 'pane' | 'main'): child is ReactElement {
  return isValidElement(child) && (child.type as PaneRoleMarker)?.__paneShellRole === role
}

function collectPanes(children: ReactNode) {
  const left: CollectedPane[] = []
  const right: CollectedPane[] = []
  let mainCount = 0

  Children.forEach(children, child => {
    if (isRole(child, 'main')) {
      mainCount++

      return
    }

    if (!isRole(child, 'pane')) {
      return
    }

    const props = child.props as PaneProps

    const entry: CollectedPane = {
      defaultOpen: props.defaultOpen ?? true,
      disabled: props.disabled ?? false,
      id: props.id,
      resizable: props.resizable ?? false,
      side: props.side,
      width: widthToCss(props.width, DEFAULT_WIDTH)
    }

    ;(props.side === 'left' ? left : right).push(entry)
  })

  return { left, mainCount, right }
}

function trackForPane(pane: CollectedPane, states: Record<string, { open: boolean; widthOverride?: number }>) {
  const stateOpen = states[pane.id]?.open ?? pane.defaultOpen
  const open = !pane.disabled && stateOpen

  if (!open) {
    return { open: false, track: '0px' }
  }

  const override = pane.resizable ? states[pane.id]?.widthOverride : undefined

  return { open: true, track: override !== undefined ? `${override}px` : pane.width }
}

export function PaneShell({ children, className, style }: PaneShellProps) {
  const paneStates = useStore($paneStates)
  const { left, mainCount, right } = useMemo(() => collectPanes(children), [children])

  if (import.meta.env.DEV && mainCount > 1) {
    console.warn('[PaneShell] expected at most one <PaneMain>, got', mainCount)
  }

  const ctxValue = useMemo(() => {
    const paneById = new Map<string, PaneSlot>()
    const tracks: string[] = []
    const cssVars: Record<string, string> = {}
    let column = 1

    // A resizable, open pane's track reads through a per-pane drag variable
    // (`--pane-<id>-drag`) that the divider sets IMPERATIVELY during a drag and
    // clears on release — so dragging never goes through setState/re-render
    // (which dropped frames and made the native browser view lag the pointer).
    // The committed store width is the var's fallback, so React stays the
    // source of truth between drags.
    const trackCss = (pane: CollectedPane, open: boolean, track: string) =>
      pane.resizable && open ? `var(--pane-${pane.id}-drag,${track})` : track

    for (const pane of left) {
      const { open, track } = trackForPane(pane, paneStates)
      tracks.push(trackCss(pane, open, track))
      paneById.set(pane.id, { column, open, side: 'left' })
      cssVars[`--pane-${pane.id}-width`] = track
      column++
    }

    tracks.push('minmax(0,1fr)')
    const mainColumn = column++

    for (const pane of right) {
      const { open, track } = trackForPane(pane, paneStates)
      tracks.push(trackCss(pane, open, track))
      paneById.set(pane.id, { column, open, side: 'right' })
      cssVars[`--pane-${pane.id}-width`] = track
      column++
    }

    return { cssVars, gridTemplate: tracks.join(' '), mainColumn, paneById } satisfies PaneShellContextValue & {
      cssVars: Record<string, string>
      gridTemplate: string
    }
  }, [left, paneStates, right])

  const composedStyle = useMemo<CSSProperties>(
    () => ({ ...ctxValue.cssVars, ...style, gridTemplateColumns: ctxValue.gridTemplate }),
    [ctxValue.cssVars, ctxValue.gridTemplate, style]
  )

  return (
    <PaneShellContext.Provider value={{ mainColumn: ctxValue.mainColumn, paneById: ctxValue.paneById }}>
      {/* Explicit single row pinned to the container height. Without this the
          implicit row is `auto` (content-sized): a pane that doesn't clip its
          own overflow (e.g. the long sidebar list) would grow the row and
          stretch every column past the viewport — which over-sized the
          embedded browser's native view. A definite row keeps all panes at
          viewport height regardless of content or per-pane overflow. */}
      {/* pane-grid-anim: grid-template-columns transitions so a pane
          collapse/expand (sidebar rail ↔ full) glides instead of snapping.
          Disabled during a divider drag (html[data-pane-resizing]) — there the
          width is written imperatively every frame and a transition would lag
          the pointer. See styles.css. */}
      <div
        className={cn('pane-grid-anim relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)]', className)}
        style={composedStyle}
      >
        {children}
      </div>
    </PaneShellContext.Provider>
  )
}

export function Pane({
  children,
  className,
  defaultOpen = true,
  disabled = false,
  id,
  maxWidth,
  minWidth,
  resizable = false,
  resizeHandleClassName
}: PaneProps) {
  const ctx = useContext(PaneShellContext)
  const registered = useRef(false)
  const paneRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (registered.current) {
      return
    }

    registered.current = true
    ensurePaneRegistered(id, { open: defaultOpen })
  }, [defaultOpen, id])

  const slot = ctx?.paneById.get(id)
  const open = Boolean(slot?.open && !disabled)
  const canResize = open && resizable
  const lo = widthToPx(minWidth) ?? DEFAULT_RESIZE_MIN_WIDTH
  const hi = widthToPx(maxWidth) ?? Number.POSITIVE_INFINITY
  const side = slot?.side ?? 'left'
  const liveWidthRef = useRef(0)
  const dragVar = `--pane-${id}-drag`

  const startResize = useColumnResize({
    enabled: canResize,
    // Write the width straight to the grid's drag variable (no setState), so
    // the column resizes every frame without re-rendering the pane subtree.
    onResize: next => {
      const width = Math.round(Math.min(hi, Math.max(lo, next)))
      liveWidthRef.current = width
      document.documentElement.style.setProperty(dragVar, `${width}px`)
    },
    // Suppress the grid transition for the duration of the drag (the width is
    // written imperatively every frame; a transition would lag the pointer).
    onStart: () => document.documentElement.setAttribute('data-pane-resizing', ''),
    // Commit to the store, then drop the drag var on the next frame (after the
    // re-render bakes the same width into the track) so there's no jump.
    onEnd: () => {
      setPaneWidthOverride(id, liveWidthRef.current)
      document.documentElement.removeAttribute('data-pane-resizing')
      requestAnimationFrame(() => document.documentElement.style.removeProperty(dragVar))
    },
    side,
    startWidth: () => paneRef.current?.getBoundingClientRect().width ?? 0
  })

  if (!ctx) {
    if (import.meta.env.DEV) {
      console.warn(`[Pane:${id}] must be rendered inside <PaneShell>`)
    }

    return null
  }

  if (!slot) {
    return null
  }

  return (
    <div
      aria-hidden={!open}
      // No overflow-hidden here: it would clip the ResizeHandle that overhangs
      // into the inter-panel gap. Pane CONTENT clips itself (the sidebar glass
      // carries its own overflow-hidden), so dropping it here is safe.
      className={cn('relative row-start-1 min-w-0', !open && 'pointer-events-none', className)}
      data-pane-id={id}
      data-pane-open={open ? 'true' : 'false'}
      data-pane-side={slot.side}
      ref={paneRef}
      style={{ gridColumn: `${slot.column} / ${slot.column + 1}` }}
    >
      {canResize && (
        <ResizeHandle
          className={resizeHandleClassName}
          label={`调整 ${id} 大小`}
          onPointerDown={startResize}
          side={side}
        />
      )}
      {children}
    </div>
  )
}

;(Pane as unknown as PaneRoleMarker).__paneShellRole = 'pane'

export function PaneMain({ children, className }: PaneMainProps) {
  const ctx = useContext(PaneShellContext)

  if (!ctx) {
    if (import.meta.env.DEV) {
      console.warn('[PaneMain] must be rendered inside <PaneShell>')
    }

    return null
  }

  return (
    <div
      className={cn('row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden', className)}
      data-pane-main="true"
      style={{ gridColumn: `${ctx.mainColumn} / ${ctx.mainColumn + 1}` }}
    >
      {children}
    </div>
  )
}

;(PaneMain as unknown as PaneRoleMarker).__paneShellRole = 'main'
