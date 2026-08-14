import { useLayoutEffect, useRef } from 'react'

// 1:1 reproduction of the Pencil "Reminder Card" (badwork.pen node Z8gL8),
// shown when the renderer is opened in a plain browser (no Electron bridge).
//
// The design is the WHOLE page — a fixed 960×540 composition (left = FAN logo +
// headline + subtext; right = a soft brand-colour glow wash). We scale it to
// COVER the viewport so it fills edge-to-edge with no surrounding background.
// `zoom` re-rasterises crisply in Chromium (this gate is browser-only), unlike
// `transform: scale` which would blur the text.

const DESIGN_W = 960
const DESIGN_H = 540

// FAN logo mark — exact path from the design (viewBox 0 0 200 200, evenodd).
const FAN_MARK_PATH =
  'M100 0c55.23 0 100 44.77 100 100 0 55.23-44.77 100-100 100-55.23 0-100-44.77-100-100 0-55.23 44.77-100 100-100z m19 70c17 5.5 29 16 29 30 0 28.7-19.3 52-48 52-29.3 0-53-23.3-53-52 0-29.3 23.7-53 53-53 10.5 0 20.5 2 29 6.5-8.5 2.5-12 9.5-10 16.5z m-19 6.5c12.98 0 23.5 10.52 23.5 23.5 0 12.98-10.52 23.5-23.5 23.5-12.98 0-23.5-10.52-23.5-23.5 0-12.98 10.52-23.5 23.5-23.5z'

// Glow ellipses flattened into the 508px-wide right column (Pencil layout
// snapshot: Scene + Window-Stage offsets composed). Blurred, low-opacity
// brand-colour ellipses that overflow and clip into a soft wash.
const GLOWS = [
  { color: '#2D6BF0', w: 380, h: 360, blur: 100, opacity: 0.22, x: 64, y: -164 },
  { color: '#7C5CF0', w: 250, h: 250, blur: 90, opacity: 0.12, x: 202, y: -30 },
  { color: '#3FC8C0', w: 220, h: 220, blur: 90, opacity: 0.1, x: 56, y: -12 },
  { color: '#2D6BF0', w: 360, h: 310, blur: 90, opacity: 0.2, x: 74, y: 374 },
  { color: '#7458F0', w: 206, h: 192, blur: 78, opacity: 0.12, x: 252, y: 306 }
]

export function BrowserOnlyNotice() {
  const stageRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const node = stageRef.current

    if (!node) {
      return
    }

    // Set `zoom` straight on the DOM node (React would append "px" to a numeric
    // style value, which `zoom` rejects). max() = cover; pre-paint so no flash.
    const fit = () => {
      node.style.zoom = String(Math.max(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H))
    }

    fit()
    window.addEventListener('resize', fit)

    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div className="fixed inset-0 z-[1400] grid place-items-center overflow-hidden bg-[#F7F8FA]">
      <div
        className="relative flex shrink-0 overflow-hidden"
        ref={stageRef}
        style={{ width: DESIGN_W, height: DESIGN_H, background: '#FFFFFF' }}
      >
        {/* Left — content column (452px) */}
        <div
          className="flex h-full shrink-0 flex-col justify-center"
          style={{ width: 452, padding: '56px 40px 56px 52px', gap: 22 }}
        >
          <div className="flex items-center" style={{ gap: 11 }}>
            <svg aria-hidden="true" height={30} viewBox="0 0 200 200" width={30}>
              <path d={FAN_MARK_PATH} fill="#0A0A0A" fillRule="evenodd" />
            </svg>
            <span
              style={{
                fontFamily: "'Poppins', var(--dt-font-sans)",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: '1.5px',
                color: '#0A0A0A'
              }}
            >
              FAN
            </span>
          </div>

          <div className="flex flex-col" style={{ gap: 13 }}>
            <h1
              className="font-sans"
              style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.3px', lineHeight: 1.2, color: '#1A1D21' }}
            >
              请在桌面端打开 FAN
            </h1>
            <p className="font-sans" style={{ fontSize: 15, lineHeight: 1.6, color: '#5C636E' }}>
              FAN 是一款桌面应用，暂不支持在浏览器中运行。打开桌面客户端，即可继续你的工作。
            </p>
          </div>
        </div>

        {/* Right — illustration column (508px): soft glow wash, clipped */}
        <div className="relative h-full flex-1 overflow-hidden">
          {GLOWS.map((g, i) => (
            <span
              aria-hidden="true"
              className="absolute block rounded-full"
              key={`${g.color}-${i}`}
              style={{
                left: g.x,
                top: g.y,
                width: g.w,
                height: g.h,
                background: g.color,
                opacity: g.opacity,
                filter: `blur(${g.blur}px)`
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
