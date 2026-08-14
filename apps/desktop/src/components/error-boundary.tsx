import { FileText, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { FAN_LOGO_MARK } from '@/lib/brand'
import { userFacingErrorMessage } from '@/lib/user-facing-error'

interface ErrorBoundaryFallbackProps {
  error: Error
  reset: () => void
}

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: (props: ErrorBoundaryFallbackProps) => ReactNode
  label?: string
  onError?: (error: Error, info: ErrorInfo) => void
}

interface ErrorBoundaryState {
  error: Error | null
}

// Session switching and teardown can briefly render stale message state. These
// errors normally disappear on the next render, so do not strand the entire
// desktop on a root fallback; bound recovery to avoid masking a persistent
// application failure.
const RECOVERABLE_ROOT_ERROR_PATTERNS = [
  /tapClientLookup: Index \d+\s+out of bounds \(length:\s*\d+\)/i,
  /Cannot read properties of undefined \(reading 'type'\)/i,
  /Tried to unmount a fiber that is already unmounted/i
]
const MAX_ROOT_RECOVERIES = 3
const ROOT_RECOVERY_WINDOW_MS = 5_000

function isRecoverableRootError(error: Error): boolean {
  return RECOVERABLE_ROOT_ERROR_PATTERNS.some(pattern => pattern.test(error.message))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }
  private recoverTimer: number | null = null
  private recoverCount = 0
  private recoverWindowStart = 0

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const tag = this.props.label ? `[error-boundary:${this.props.label}]` : '[error-boundary]'
    console.error(tag, error, info.componentStack)
    this.props.onError?.(error, info)

    if (this.props.label === 'root' && isRecoverableRootError(error) && this.canAutoRecover()) {
      console.warn(`${tag} auto-recovering transient render error`, error.message)
      this.scheduleAutoRecover()
    }

  }

  componentWillUnmount() {
    this.clearRecoverTimer()
  }

  reset = () => {
    this.clearRecoverTimer()
    this.recoverCount = 0
    this.recoverWindowStart = 0
    this.setState({ error: null })
  }

  private canAutoRecover(): boolean {
    const now = Date.now()
    if (now - this.recoverWindowStart > ROOT_RECOVERY_WINDOW_MS) {
      this.recoverWindowStart = now
      this.recoverCount = 0
    }
    this.recoverCount += 1
    return this.recoverCount <= MAX_ROOT_RECOVERIES
  }

  private clearRecoverTimer() {
    if (this.recoverTimer !== null) {
      window.clearTimeout(this.recoverTimer)
      this.recoverTimer = null
    }
  }

  private scheduleAutoRecover() {
    this.clearRecoverTimer()
    this.recoverTimer = window.setTimeout(() => {
      this.recoverTimer = null
      this.setState({ error: null })
    }, 0)
  }

  render() {
    const { error } = this.state

    if (!error) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback({
        error,
        reset: this.reset
      })
    }

    return (
      <RootErrorFallback
        error={error}
        reset={this.reset}
      />
    )
  }
}

// This renders above the ThemeProvider, so it relies only on the global liquid
// glass tokens defined in styles.css rather than provider-owned theme state.
function RootErrorFallback({ error, reset }: ErrorBoundaryFallbackProps) {
  return (
    <div className="lg-scrim fixed inset-0 z-[1500] flex flex-col items-center justify-center overflow-hidden p-6 font-sans text-(--bwa-text)">
      <div className="lg-card flex w-[32.5rem] max-w-full flex-col items-center px-7 py-8">
        {/* Illustration: brand mark (84) + alert badge (34) at x66/y64 */}
        <div className="relative size-[6.5rem]">
          <img alt="" aria-hidden className="absolute left-2 top-2 size-[5.25rem]" src={FAN_LOGO_MARK} />
          <span
            className="absolute flex size-[2.125rem] items-center justify-center rounded-full border-[3px] border-white bg-[#E0474C] text-[1.0625rem] font-extrabold leading-none text-white shadow-[0_0.375rem_0.875rem_#E0474C40]"
            style={{ left: '4.125rem', top: '4rem' }}
          >
            !
          </span>
        </div>

        <h1 className="mt-[1.625rem] text-[1.375rem] font-bold tracking-[-0.3px]">界面开了个小差</h1>
        <p className="mt-3 w-[27.5rem] max-w-full text-center text-[0.84375rem] leading-[1.7] text-(--bwa-text-secondary)">
          这个窗口遇到了一个意外问题，不用担心——你的数据与正在运行的任务都完好。可以先重试，若仍无响应再重新加载窗口。
        </p>

        {/* Keep raw exception data in diagnostics; the recovery UI only shows a user-safe reason. */}
        <div className="lg-input mt-6 w-full px-[1.125rem] pb-4 pt-[0.875rem]">
          <div className="flex items-center gap-2">
            <span className="size-[0.4375rem] shrink-0 rounded-full bg-[#E0474C]" />
            <span className="truncate font-mono text-[0.65625rem] uppercase tracking-[1.5px] text-(--bwa-text-muted)">
              页面异常
            </span>
          </div>
          <p
            className="mt-2.5 max-h-32 overflow-auto break-words font-mono text-xs leading-[1.65] text-(--bwa-text-secondary)"
            data-selectable-text="true"
          >
            {userFacingErrorMessage(error, '页面暂时无法显示，请重试。')}
          </p>
        </div>

        {/* Buttons: 再次尝试 (reset) · 打开日志 (reveal logs) */}
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <button
            className="lg-btn-primary text-sm font-semibold"
            onClick={reset}
            type="button"
          >
            <RotateCcw className="size-[0.9375rem]" />
            再次尝试
          </button>
          <button
            className="lg-btn text-sm font-semibold text-(--bwa-text)"
            onClick={() => void window.fanDesktop?.revealLogs()?.catch(() => undefined)}
            type="button"
          >
            <FileText className="size-[0.8125rem] text-[#8A919E]" />
            打开日志
          </button>
        </div>
        <div className="mt-6 flex items-center gap-2">
          <img alt="" aria-hidden className="size-3.5 opacity-30" src={FAN_LOGO_MARK} />
          <span className="font-mono text-[0.65625rem] tracking-[1px] text-(--bwa-text-muted)">
            FAN · ERROR BOUNDARY
          </span>
        </div>
      </div>
    </div>
  )
}
