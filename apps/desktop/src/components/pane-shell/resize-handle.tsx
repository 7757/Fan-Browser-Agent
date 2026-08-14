import type { PointerEventHandler } from 'react'

import { cn } from '@/lib/utils'

import type { ColumnResizeSide } from './use-column-resize'

interface ResizeHandleProps {
  /** Accessible label, e.g. "调整侧边栏大小". */
  label: string
  onPointerDown: PointerEventHandler<HTMLDivElement>
  /** Which side the resized column is on — places the handle on that edge. */
  side: ColumnResizeSide
  /** Override the default full-height extent (e.g. to match an inset glass panel). */
  className?: string
}

// The single canonical resize handle for every draggable divider: an invisible
// grab strip straddling a column edge that reveals a thin sash highlight on
// hover/focus. Its parent must be `relative`. Pairs with useColumnResize.
export function ResizeHandle({ label, onPointerDown, side, className }: ResizeHandleProps) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className={cn(
        // Keep a 10px grab strip even though the inter-panel gap is only 6px:
        // the strip is centered on the gap midline (translate = 100% - 2px), so
        // it overhangs 2px into each neighboring panel. That needs the
        // immediate parent to NOT clip (panels keep their own rounded
        // overflow-hidden on an inner wrapper) — otherwise the overhang gets
        // clipped and the handle becomes ungrabbable.
        'group absolute bottom-0 top-0 z-20 w-2.5 cursor-col-resize [-webkit-app-region:no-drag]',
        side === 'left'
          ? 'right-0 translate-x-[calc(100%-0.125rem)]'
          : 'left-0 translate-x-[calc(-100%+0.125rem)]',
        className
      )}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <span className="absolute inset-y-1 left-1/2 w-[0.1875rem] -translate-x-1/2 rounded-full bg-(--ui-sash-hover-border) opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  )
}
