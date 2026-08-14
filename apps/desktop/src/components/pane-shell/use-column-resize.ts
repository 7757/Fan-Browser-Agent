import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback } from 'react'

export type ColumnResizeSide = 'left' | 'right'

interface ColumnResizeOptions {
  /** Whether dragging is currently allowed. */
  enabled?: boolean
  /** Fired once when the drag ends (e.g. to re-show a native overlay). */
  onEnd?: () => void
  /** Apply the new, UNCLAMPED width (px). The caller clamps + persists. */
  onResize: (widthPx: number) => void
  /** Fired once when the drag begins (e.g. to hide a native overlay). */
  onStart?: () => void
  /** Which side of the divider the resized column is on — sets drag direction. */
  side: ColumnResizeSide
  /** The resized column's width (px) at the instant the gesture starts. */
  startWidth: () => number
}

// The one column-resize gesture behind every draggable divider — pane edges and
// the in-session browser/chat split alike. It owns pointer capture, the
// col-resize cursor, the window listeners, and the side-aware delta math, so
// every handle drags identically. The caller decides what the width means
// (clamping + persistence) via onResize.
export function useColumnResize({ enabled = true, onEnd, onResize, onStart, side, startWidth }: ColumnResizeOptions) {
  return useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const base = startWidth()

      if (!enabled || !Number.isFinite(base) || base <= 0) {
        return
      }

      event.preventDefault()

      const handle = event.currentTarget
      const { clientX: startX, pointerId } = event
      const direction = side === 'left' ? 1 : -1
      const restoreCursor = document.body.style.cursor
      const restoreSelect = document.body.style.userSelect

      handle.setPointerCapture?.(pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      onStart?.()

      const onMove = (move: PointerEvent) => {
        onResize(base + (move.clientX - startX) * direction)
      }

      const cleanup = () => {
        document.body.style.cursor = restoreCursor
        document.body.style.userSelect = restoreSelect
        handle.releasePointerCapture?.(pointerId)
        onEnd?.()
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', cleanup, true)
        window.removeEventListener('pointercancel', cleanup, true)
        window.removeEventListener('blur', cleanup)
      }

      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', cleanup, true)
      window.addEventListener('pointercancel', cleanup, true)
      window.addEventListener('blur', cleanup)
    },
    [enabled, onEnd, onResize, onStart, side, startWidth]
  )
}
