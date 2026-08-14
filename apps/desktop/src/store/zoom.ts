import { atom } from 'nanostores'

// The Electron main process owns the real window zoom. The renderer mirrors
// only the readable percentage so Settings stays synchronized with keyboard
// shortcuts and the View menu.
export const $zoomPercent = atom<number>(100)

export function setZoomPercent(percent: number): void {
  window.fanDesktop?.zoom?.setPercent(percent)
}

if (typeof window !== 'undefined' && window.fanDesktop?.zoom) {
  void window.fanDesktop.zoom.get().then(({ percent }) => $zoomPercent.set(percent))
  window.fanDesktop.zoom.onChanged(({ percent }) => $zoomPercent.set(percent))
}
