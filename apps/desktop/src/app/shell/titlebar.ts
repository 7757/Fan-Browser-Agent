import type { FanConnection } from '@/global'

export const TITLEBAR_HEIGHT = 34
export const TITLEBAR_CONTROL_OFFSET_X = 74
const TITLEBAR_CONTROL_HEIGHT = 22
// Design (Pencil IGhc1/aJ0PD): the header is ONE 34px-tall row at y 14..48 —
// traffic lights, FAN lockup, left tools and the right frosted cluster all
// sit on the same baseline (the mock's extra 14px window-inset ring is
// decorative framing, not in-window spacing). Controls center on that row.
const TITLEBAR_ROW_TOP = 14
const TITLEBAR_CONTROLS_TOP = TITLEBAR_ROW_TOP + (TITLEBAR_HEIGHT - TITLEBAR_CONTROL_HEIGHT) / 2
export const TITLEBAR_FALLBACK_WINDOW_BUTTON_X = 24
// Edge inset used when no left-side native controls take up that space —
// Windows/Linux (native overlay is on the right) and macOS fullscreen
// (traffic lights are hidden). Matches the right-cluster's 0.75rem padding.
export const TITLEBAR_EDGE_INSET = 14

// Titlebar palette only. All sizing/radius/cursor/centering come from the
// shared <Button size="icon-titlebar"> (used polymorphically via asChild) —
// Button is the single source of button styling.
export const titlebarButtonClass =
  'text-muted-foreground/85 hover:bg-(--ui-control-hover-background) hover:text-foreground'

// 34px round frosted control for the design's right-cluster buttons (New /
// Canvas / Settings — spec §2, Pencil aJ0PD node JOOZn). Translucent white fill
// (#FFFFFF7A = white/48), 1px #FFFFFFE6 (white/90) hairline, and 18px backdrop
// blur. 16px lucide icon in #3E4650.
export const frostedTitlebarButtonClass =
  'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-white/90 bg-white/48 text-[#3E4650] backdrop-blur-[18px] transition-[color,background-color,transform] duration-150 ease-out hover:scale-[1.08] hover:bg-white/70 active:scale-[0.94] motion-reduce:transition-none motion-reduce:hover:scale-100 [&_svg]:size-4 dark:border-white/12 dark:bg-white/10 dark:text-[#C7CDD6] dark:hover:bg-white/16'
export function titlebarControlsPosition(
  windowButtonPosition: FanConnection['windowButtonPosition'] | undefined,
  isFullscreen = false
) {
  const top = Math.max(0, TITLEBAR_CONTROLS_TOP)

  // No left-side native controls to dodge:
  //   - Windows/Linux: native min/max/close render on the right via titleBarOverlay.
  //   - macOS fullscreen: traffic lights are hidden.
  // In both cases, pin the cluster to the edge with a small inset.
  if (windowButtonPosition === null || isFullscreen) {
    return { left: TITLEBAR_EDGE_INSET, top }
  }

  return {
    left: (windowButtonPosition?.x ?? TITLEBAR_FALLBACK_WINDOW_BUTTON_X) + TITLEBAR_CONTROL_OFFSET_X,
    top
  }
}
