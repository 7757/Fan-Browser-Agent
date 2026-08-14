import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { $desktopBoot } from '@/store/boot'
import { $gatewayState } from '@/store/session'
import { $desktopVersion, refreshDesktopVersion } from '@/store/updates'

// 1:1 reproduction of the Pencil splash "FAN — 启动页 Splash · Redesigned"
// (badwork.pen node nC1A2), shown while the renderer connects to the backend
// gateway: bloom background + centered FAN logo / slogan / progress bar with a
// status row, and a version footer.

const SLOGAN = '让 AI 在浏览器里工作'

// FAN logo mark — exact path from the design (viewBox 0 0 200 200, evenodd).
const FAN_MARK_PATH =
  'M100 0c55.23 0 100 44.77 100 100 0 55.23-44.77 100-100 100-55.23 0-100-44.77-100-100 0-55.23 44.77-100 100-100z m19 70c17 5.5 29 16 29 30 0 28.7-19.3 52-48 52-29.3 0-53-23.3-53-52 0-29.3 23.7-53 53-53 10.5 0 20.5 2 29 6.5-8.5 2.5-12 9.5-10 16.5z m-19 6.5c12.98 0 23.5 10.52 23.5 23.5 0 12.98-10.52 23.5-23.5 23.5-12.98 0-23.5-10.52-23.5-23.5 0-12.98 10.52-23.5 23.5-23.5z'

// Exit choreography (ms): content completes + fades, then the overlay fades.
const TEXT_OUT_MS = 360
const POST_TEXT_HOLD_MS = 300
const OVERLAY_OUT_MS = 520
// Preview-only: how long to "connect" for, and the pause before replaying.
const PREVIEW_CONNECT_MS = 2600
const PREVIEW_REPLAY_MS = 1100

type Phase = 'gone' | 'live' | 'overlay-out' | 'text-out'

// Dev affordance: a warm Cmd+R reconnects almost instantly, so the overlay
// only flashes. Load with `?connecting=1` to force a looping preview
// (e.g. open http://127.0.0.1:5174/?connecting=1 in a browser).
function forcedPreview(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') {
    return false
  }

  try {
    return new URLSearchParams(window.location.search).get('connecting') === '1'
  } catch {
    return false
  }
}

export function GatewayConnectingOverlay() {
  const gatewayState = useStore($gatewayState)
  const boot = useStore($desktopBoot)
  const version = useStore($desktopVersion)
  const [previewing] = useState(forcedPreview)
  const [phase, setPhase] = useState<Phase>('live')
  const [progress, setProgress] = useState(8)

  // The full-screen connecting overlay is for initial boot only. After a
  // healthy boot, flaky networks / sleep-wake can drop the socket and flip the
  // gateway state back to closed/error while the app reconnects — do NOT cover
  // the chat then, or the just-ported "editable composer during reconnect" is
  // defeated by the modal. Users should keep typing drafts / reaching settings.
  const initialBootActive = boot.visible || boot.running || boot.progress < 100
  const connecting = gatewayState !== 'open' && !boot.error && initialBootActive
  // Latches once we've actually shown the overlay, so the brief frame where
  // gatewayState flips to "open" (connecting -> false) before the exit phase
  // kicks in doesn't unmount us and cause a flash.
  const shownRef = useRef(false)

  if (previewing || connecting) {
    shownRef.current = true
  }

  // Pull the real running-build version for the footer (idempotent — also kicked
  // off at app boot; a no-op in a plain browser where the IPC bridge is absent).
  useEffect(() => {
    void refreshDesktopVersion()
  }, [])

  // Kick off the exit when connected: real connect, or a faked timer in preview.
  useEffect(() => {
    if (phase !== 'live') {
      return
    }

    if (previewing) {
      const id = window.setTimeout(() => setPhase('text-out'), PREVIEW_CONNECT_MS)

      return () => window.clearTimeout(id)
    }

    if (gatewayState === 'open' && shownRef.current) {
      setPhase('text-out')
    }
  }, [phase, previewing, gatewayState])

  // Indeterminate progress: we don't get a real percentage, so ease toward ~92%
  // while connecting (so it reads as actively working, not frozen) and snap to
  // 100% on exit.
  useEffect(() => {
    if (phase !== 'live') {
      setProgress(100)

      return
    }

    setProgress(8)

    const id = window.setInterval(() => {
      setProgress(p => Math.min(92, p + Math.max(0.5, (94 - p) * 0.045)))
    }, 80)

    return () => window.clearInterval(id)
  }, [phase])

  // Advance the exit choreography: text-out -> overlay-out -> gone.
  useEffect(() => {
    if (phase === 'text-out') {
      const id = window.setTimeout(() => setPhase('overlay-out'), TEXT_OUT_MS + POST_TEXT_HOLD_MS)

      return () => window.clearTimeout(id)
    }

    if (phase === 'overlay-out') {
      const id = window.setTimeout(() => setPhase('gone'), OVERLAY_OUT_MS)

      return () => window.clearTimeout(id)
    }

    // Preview replays so we can keep watching the transition.
    if (phase === 'gone' && previewing) {
      const id = window.setTimeout(() => setPhase('live'), PREVIEW_REPLAY_MS)

      return () => window.clearTimeout(id)
    }
  }, [phase, previewing])

  // Boot failed — BootFailureOverlay owns the screen; don't linger behind it.
  if (boot.error && !previewing) {
    return null
  }

  // Real connect: once the fade finishes, get out of the way for good.
  if (phase === 'gone' && !previewing) {
    return null
  }

  // Never showed (e.g. gateway already up on a warm reload) — stay out.
  if (!previewing && !connecting && !shownRef.current) {
    return null
  }

  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out' || phase === 'gone'

  return (
    <div
      className={cn(
        'app-bloom-bg fixed inset-0 z-[1200] transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
    >
      {/* Center stack: brand block + loader, vertically centred on the bloom. */}
      <div
        className={cn(
          'absolute inset-0 grid place-items-center transition duration-300 ease-out',
          leaving ? 'translate-y-1 opacity-0' : 'translate-y-0 opacity-100'
        )}
      >
        <div className="flex flex-col items-center" style={{ gap: 46 }}>
          <div className="flex flex-col items-center" style={{ gap: 20 }}>
            {/* Logo lockup — mark + Poppins wordmark (Poppins isn't bundled, so
                it falls back to the app sans). */}
            <div className="flex flex-col items-center text-foreground" style={{ gap: 15 }}>
              <svg aria-hidden="true" height={64} viewBox="0 0 200 200" width={64}>
                <path d={FAN_MARK_PATH} fill="currentColor" fillRule="evenodd" />
              </svg>
              <span
                style={{ fontFamily: "'Poppins', var(--dt-font-sans)", fontSize: 30, fontWeight: 800, letterSpacing: '2.5px' }}
              >
                FAN
              </span>
            </div>
            <span
              className="font-sans text-secondary-foreground"
              style={{ fontSize: 19, fontWeight: 500, letterSpacing: '0.5px' }}
            >
              {SLOGAN}
            </span>
          </div>

          <div className="flex flex-col" style={{ gap: 14, width: 260 }}>
            <div className="flex h-1.5 w-full rounded-full border border-border bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ boxShadow: '0 1px 8px #2D6BF03D', width: `${progress}%` }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-secondary-foreground" style={{ fontSize: 12, fontWeight: 500 }}>
                正在载入..
              </span>
              <span
                className="font-mono tabular-nums text-muted-foreground"
                style={{ fontSize: 11, letterSpacing: '0.2px' }}
              >
                {Math.round(progress)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Version footer */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-10 flex justify-center transition-opacity duration-300 ease-out',
          leaving ? 'opacity-0' : 'opacity-100'
        )}
      >
        <span className="font-mono text-muted-foreground" style={{ fontSize: 11.5, letterSpacing: '0.5px' }}>
          Version {version?.appVersion ?? '…'}
        </span>
      </div>
    </div>
  )
}
