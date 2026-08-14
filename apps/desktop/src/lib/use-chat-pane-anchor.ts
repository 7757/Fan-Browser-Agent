import { useEffect, useState } from 'react'

export interface ChatPaneAnchor {
  centerX: number
  width: number
}

// Measures the chat column ([data-overlay-anchor]) so window-fixed overlay
// surfaces (toasts, dialogs, the command palette) can center over it instead
// of the whole window — the embedded browser's native view paints above all
// DOM, so anything straddling the browser pane gets visually swallowed by it.
// Tracks pane-divider drags (ResizeObserver) and window resizes. Returns null
// when no anchor exists (settings/overlay routes) — callers fall back to
// window-centered, which is correct there because no browser view is mounted.
// Pass `active=false` while the surface is closed to skip measuring.
export function useChatPaneAnchor(active: boolean): ChatPaneAnchor | null {
  const [anchor, setAnchor] = useState<ChatPaneAnchor | null>(null)

  useEffect(() => {
    if (!active) {
      return
    }

    const el = document.querySelector<HTMLElement>('[data-overlay-anchor]')

    if (!el) {
      setAnchor(null)

      return
    }

    const update = () => {
      const rect = el.getBoundingClientRect()
      setAnchor({ centerX: rect.left + rect.width / 2, width: rect.width })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      setAnchor(null)
    }
  }, [active])

  return anchor
}
