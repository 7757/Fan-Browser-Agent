import { atom, computed, type ReadableAtom } from 'nanostores'

// Coordination for the embedded browser's native WebContentsView. That view is
// an OS-level surface: it paints ABOVE all DOM and ignores CSS z-index, so a
// modal's DOM backdrop can never cover it.
//
// Window-centred DOM surfaces (dialogs, command palette, settings)
// temporarily hide the native view, then restore the same live page. Lightweight
// surfaces that intentionally remain beside the browser may instead acquire a
// native SCRIM over its rect. Both paths are reference counted.

interface ScrimEntry {
  onDismiss?: () => void
}

const $entries = atom<readonly ScrimEntry[]>([])
const $fullWindowOverlayEntries = atom<readonly object[]>([])

// A full-window overlay ROUTE is separate from transient modal leases because
// background route/hotkey logic needs to know specifically which kind is open.
export const $overlayRouteOpen = atom(false)

export const $nativeOverlaySuppressed: ReadableAtom<boolean> = computed($entries, entries => entries.length > 0)
export const $fullWindowModalOpen: ReadableAtom<boolean> = computed(
  $fullWindowOverlayEntries,
  overlays => overlays.length > 0
)
export const $nativeViewOccluded: ReadableAtom<boolean> = computed(
  [$overlayRouteOpen, $fullWindowModalOpen],
  (routeOpen, modalOpen) => routeOpen || modalOpen
)

/**
 * Acquire the native scrim for the lifetime of a modal surface. Returns the
 * release function — call it (once) on close/unmount.
 */
export function acquireNativeScrim(onDismiss?: () => void): () => void {
  const entry: ScrimEntry = { onDismiss }
  $entries.set([...$entries.get(), entry])

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    $entries.set($entries.get().filter(item => item !== entry))
  }
}

/**
 * Reserve the whole renderer window for a DOM overlay. The embedded browser is
 * an OS-level view above the renderer, so window-centred dialogs must hide it
 * just like the settings overlay route does. Entries are reference
 * counted so closing one of several stacked dialogs cannot reveal the page
 * through another.
 */
export function acquireFullWindowOverlay(): () => void {
  const entry = {}
  $fullWindowOverlayEntries.set([...$fullWindowOverlayEntries.get(), entry])

  if (typeof window !== 'undefined') {
    try {
      void window.fanDesktop?.browser?.hideAll?.('overlay')
    } catch {
      // Native-surface owners observe $nativeViewOccluded and repeat the hide.
    }
  }

  let released = false

  return () => {
    if (released) {
      return
    }

    released = true
    $fullWindowOverlayEntries.set($fullWindowOverlayEntries.get().filter(item => item !== entry))
  }
}

/** Click/Esc on the native scrim — dismiss the top-most modal that opted in. */
export function dismissTopNativeScrim(): void {
  const entries = $entries.get()

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const handler = entries[i].onDismiss

    if (handler) {
      handler()

      return
    }
  }
}

export function setOverlayRouteOpen(open: boolean): void {
  if ($overlayRouteOpen.get() !== open) {
    $overlayRouteOpen.set(open)
  }
}
