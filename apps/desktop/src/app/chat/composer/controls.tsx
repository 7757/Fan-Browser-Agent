import { useStore } from '@nanostores/react'
import { ArrowUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Check, ChevronDown, ScanLine } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { setSessionYolo } from '@/lib/yolo-session'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { $activeSessionId, $gatewayState, $yoloActive, setYoloActive } from '@/store/session'

import { ModelChip } from './model-chip'
import type { ChatBarState } from './types'

// 自动审查 pill (design VDAxc) — the per-session YOLO approval bypass that used
// to live in the (removed) statusbar. ON = dangerous commands auto-approved
// ("自动审查"), OFF = every dangerous command asks first. On a new-chat draft we
// arm locally; the session-create path applies it once the session exists.
export function AutoReviewPill() {
  const { t } = useI18n()
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  const sessionId = useStore($activeSessionId)
  const yoloActive = useStore($yoloActive)

  if (gatewayState !== 'open' || !sessionId) {
    return null
  }

  const setYolo = async (next: boolean) => {
    if (next === $yoloActive.get()) {
      return
    }

    setYoloActive(next)

    const sid = $activeSessionId.get()

    if (!sid || !gateway) {
      return
    }

    try {
      await setSessionYolo((method, params) => gateway.request(method, params), sid, next)
    } catch (error) {
      setYoloActive(!next)
      notifyError(error, t('切换自动审查失败'))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={t('命令访问模式')}
          className="composer-glass-pill flex shrink-0 items-center gap-[0.375rem] rounded-full px-2.5 py-[0.375rem] transition hover:bg-white/55 data-[state=open]:bg-white/60"
          type="button"
        >
          <ScanLine
            aria-hidden
            className={cn('size-3.5 shrink-0', yoloActive ? 'text-[#E0474C]' : 'text-(--ui-text-tertiary)')}
          />
          <span className={cn('text-[0.71875rem] font-semibold', yoloActive ? 'text-[#E0474C]' : 'text-[#1A1D21]')}>
            {t(yoloActive ? '完全访问' : '自动审查')}
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-(--ui-text-tertiary)" />
        </button>
      </DropdownMenuTrigger>
      {/* Styled to match the model switcher (model-chip): frosted glass panel,
          blue-8% selected row + blue check, shared row-hover token. */}
      {/* 85% to match the model switcher. `zoom` (not transform) shrinks the real
          layout box so Radix keeps the bottom-left anchor fixed and the open/close
          zoom-95 animation isn't disturbed. */}
      <DropdownMenuContent
        align="start"
        className="glass-panel w-64 overflow-hidden p-1.5"
        side="top"
        sideOffset={8}
        style={{ zoom: 0.85 }}
      >
        {/* 自动审查 = review each dangerous command (yolo OFF, the safe mode) */}
        <DropdownMenuItem
          className={cn(
            'items-start gap-2.5 rounded-[0.625rem] px-2.5 py-2 focus:bg-(--ui-row-hover-background)',
            !yoloActive &&
              'bg-[color-mix(in_srgb,var(--theme-primary)_8%,transparent)] focus:bg-[color-mix(in_srgb,var(--theme-primary)_8%,transparent)]'
          )}
          onSelect={() => void setYolo(false)}
        >
          <span className="min-w-0 flex-1">
            <span className={cn('block text-[0.8125rem] font-semibold', !yoloActive ? 'text-primary' : 'text-foreground')}>
              {t('自动审查')}
            </span>
            <span className="mt-px block text-xs text-(--ui-text-tertiary)">{t('每条危险命令执行前都询问')}</span>
          </span>
          {!yoloActive && <Check aria-hidden className="mt-0.5 size-[0.9375rem] shrink-0 text-(--theme-primary)" />}
        </DropdownMenuItem>
        {/* 完全访问 = auto-approve everything (yolo ON, the permissive mode) — RED */}
        <DropdownMenuItem
          className={cn(
            'items-start gap-2.5 rounded-[0.625rem] px-2.5 py-2 focus:bg-(--ui-row-hover-background)',
            yoloActive && 'bg-[#E0474C]/8 focus:bg-[#E0474C]/8'
          )}
          onSelect={() => void setYolo(true)}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[0.75rem] font-semibold text-[#E0474C]">{t('完全访问')}</span>
            <span className="mt-px block text-xs text-(--ui-text-tertiary)">{t('危险命令自动批准，不再逐条询问')}</span>
          </span>
          {yoloActive && <Check aria-hidden className="mt-0.5 size-[0.9375rem] shrink-0 text-[#E0474C]" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ICON_BTN = 'size-(--composer-control-size) shrink-0 rounded-full'
export const GHOST_ICON_BTN = cn(
  ICON_BTN,
  'composer-glass-control text-[#8A919E] transition hover:bg-white/55 hover:text-[#1A1D21]'
)
// Send primary per design h6hSoG: a primary-blue CIRCLE with a soft blue glow
// and a white arrow; brightens on hover, darkens on press.
const PRIMARY_ICON_BTN = cn(
  'size-(--composer-control-primary-size,var(--composer-control-size)) shrink-0 rounded-full p-0',
  'composer-glass-send text-primary-foreground',
  'transition hover:brightness-105 active:brightness-95',
  'disabled:bg-primary/35 disabled:text-primary-foreground disabled:opacity-100 disabled:shadow-none'
)

export function ComposerControls({
  busy,
  busyAction,
  canSubmit,
  disabled
}: {
  busy: boolean
  busyAction: 'steer' | 'stop'
  canSubmit: boolean
  disabled: boolean
  hasComposerPayload: boolean
  state: ChatBarState
}) {
  const { t } = useI18n()
  const actionLabel = busy ? (busyAction === 'steer' ? t('补充当前运行') : t('停止')) : t('发送')

  return (
    <div className="ml-auto flex min-w-0 shrink items-center gap-(--composer-control-gap)">
      <ModelChip />
      <Tip label={actionLabel}>
        <Button
          aria-label={actionLabel}
          className={PRIMARY_ICON_BTN}
          disabled={disabled || !canSubmit}
          type="submit"
        >
          {busy ? (
            busyAction === 'steer' ? (
              <ArrowUp className="size-4" strokeWidth={2.25} />
            ) : (
              <span className="block size-3 rounded-xs bg-current" />
            )
          ) : (
            <ArrowUp className="size-4" strokeWidth={2.25} />
          )}
        </Button>
      </Tip>
    </div>
  )
}
