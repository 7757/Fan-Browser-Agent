import { useStore } from '@nanostores/react'
import { type CSSProperties, useEffect, useState } from 'react'

import type { FanGateway } from '@/fan'
import { triggerHaptic } from '@/lib/haptics'
import { Loader2, Pause, Play, ScanLine } from '@/lib/icons'
import {
  $activeBrowserControl,
  $activeBrowserOperating,
  $activeBrowserOperatingKnown
} from '@/store/browser-control'
import { notifyError } from '@/store/notifications'
import { $controlRequest, $verificationRequest, clearControlRequest, clearVerificationRequest } from '@/store/prompts'

interface BrowserPausePromptProps {
  gateway?: FanGateway | null
  onCancel?: () => Promise<boolean | void> | boolean | void
}

// A captcha / human-verification challenge, or the user taking manual control of
// the shared browser, pauses the agent — it is blocked in tui_gateway waiting on
// verification.respond / control.respond (same _block() mechanism as approval).
// It is intentionally rendered INSIDE the composer surface as a compact status
// row, rather than as a floating alert above the input. A solved captcha
// auto-resolves from the runtime's captcha.cleared signal (see session-browser);
// only an explicit browser takeover needs a manual hand-back action.
export function BrowserPausePrompt({ gateway, onCancel }: BrowserPausePromptProps) {
  const verification = useStore($verificationRequest)
  const control = useStore($controlRequest)
  const activeBrowserControl = useStore($activeBrowserControl)
  const activeBrowserOperating = useStore($activeBrowserOperating)
  const activeBrowserOperatingKnown = useStore($activeBrowserOperatingKnown)
  // Verification is the more specific, harder block, so it wins if both are up.
  const active = verification ?? control
  const isVerification = Boolean(verification)
  // A tab-strip takeover resumes by switching the agent back to its working tab.
  const isTabControl = !isVerification && (active as { tabKind?: string } | null)?.tabKind === 'tab'
  const waitingForSafePause = Boolean(
    !isVerification &&
    control &&
    (
      control.provisional === true ||
      (
        control.settling === true &&
        (!activeBrowserOperatingKnown || activeBrowserOperating || Boolean(activeBrowserControl))
      )
    )
  )
  // Keep one liquid-glass structure for both prompts, with color and icon as the
  // only state cues: verification = blue scan, control = yellow pause.
  const accent = isVerification ? 'var(--lg-accent)' : 'var(--ui-yellow)'
  const KindIcon = isVerification ? ScanLine : Pause
  const [pendingAction, setPendingAction] = useState<'resume' | 'stop' | null>(null)

  useEffect(() => {
    setPendingAction(null)
  }, [active?.requestId])

  if (!active) {
    return null
  }

  const resume = async () => {
    // Verification resumes from captcha.cleared. Never let a manual button skip
    // a challenge that the runtime has not observed as completed.
    if (isVerification) {
      return
    }

    if (waitingForSafePause) {
      return
    }

    if (!gateway) {
      notifyError(new Error('Fan 网关未连接'), '暂时无法继续')

      return
    }

    if (pendingAction) {
      return
    }

    setPendingAction('resume')

    try {
      await gateway.request('control.respond', {
        answer: 'continue',
        request_id: active.requestId,
        session_id: active.sessionId ?? ''
      })
      triggerHaptic('submit')
      clearControlRequest(active.sessionId, active.requestId)
    } catch (error) {
      setPendingAction(null)
      notifyError(error, '继续失败')
    }
  }

  // A control response is acknowledgement only: it deliberately resumes the
  // agent regardless of answer text. Stopping must use the existing session
  // interrupt path, which also clears this session's pending interactions.
  const stop = async () => {
    if (!onCancel || pendingAction) {
      return
    }

    setPendingAction('stop')

    try {
      const stopped = await onCancel()

      if (stopped === false) {
        setPendingAction(null)

        return
      }

      triggerHaptic('cancel')

      if (isVerification) {
        clearVerificationRequest(active.sessionId, active.requestId)
      } else {
        clearControlRequest(active.sessionId, active.requestId)
      }
    } catch (error) {
      setPendingAction(null)
      notifyError(error, '停止任务失败')
    }
  }

  const message = isVerification
    ? '请完成网页验证，Fan 会自动继续'
    : waitingForSafePause
      ? '识别到你的浏览器操作，Fan 正在安全暂停'
    : isTabControl
      ? '你切换了浏览器标签，Fan 已暂停当前操作'
      : '你正在操作浏览器，Fan 已暂停当前操作'

  return (
    <div
      aria-live="polite"
      className="relative z-2 w-full min-w-0 py-0.5"
      style={{ '--accent': accent } as CSSProperties}
    >
      <div
        className="lg-card relative flex w-full min-w-0 items-center gap-2.5 overflow-hidden px-3 py-2.5"
        style={{ borderColor: 'color-mix(in srgb, var(--accent) 24%, var(--lg-stroke))' }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{
            background:
              'radial-gradient(80% 110% at 0% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 72%)'
          }}
        />
        <span
          className="relative z-1 flex size-7 shrink-0 items-center justify-center rounded-full border shadow-[inset_0_1px_0_rgb(255_255_255_/_72%),0_0.3rem_0.8rem_-0.35rem_rgb(34_50_92_/_22%)] backdrop-blur-md"
          style={{
            background: 'color-mix(in srgb, var(--accent) 9%, var(--lg-inset-fill-strong))',
            borderColor: 'color-mix(in srgb, var(--accent) 25%, var(--lg-inset-stroke))',
            color: accent
          }}
        >
          <KindIcon aria-hidden className="size-[13px]" />
        </span>
        <p className="relative z-1 min-w-0 flex-1 text-[12.5px] font-medium leading-[18px] text-(--bwa-text)">
          {message}
        </p>
        <div className="relative z-1 flex shrink-0 items-center gap-1.5">
          {onCancel ? (
            <button
              className={`${isVerification ? 'lg-btn-primary' : 'lg-btn'} shrink-0 px-2.5 py-1 text-[11.5px] font-medium disabled:cursor-wait disabled:opacity-60`}
              disabled={Boolean(pendingAction)}
              onClick={() => void stop()}
              style={
                isVerification ? ({ '--lg-btn-color': 'var(--ui-red)' } as CSSProperties) : undefined
              }
              type="button"
            >
              {pendingAction === 'stop' ? <Loader2 aria-hidden className="size-3 animate-spin" /> : '停止任务'}
            </button>
          ) : null}
          {!isVerification ? (
            <button
              className="lg-btn-primary shrink-0 px-2.5 py-1 text-[11.5px] font-semibold disabled:cursor-wait disabled:opacity-60"
              disabled={Boolean(pendingAction) || waitingForSafePause}
              onClick={() => void resume()}
              type="button"
            >
              {pendingAction === 'resume' || waitingForSafePause ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : (
                <Play aria-hidden className="size-[10px]" />
              )}
              {waitingForSafePause
                ? '正在暂停'
                : isTabControl
                  ? '继续并切回工作标签'
                  : '继续执行'}
            </button>
          ) : null}
        </div>
      </div>
      <span className="sr-only">
        {isVerification ? '等待网页验证完成，完成后自动继续' : '浏览器操作已暂停，等待你的决定'}
      </span>
    </div>
  )
}
