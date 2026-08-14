import { useStore } from '@nanostores/react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { FAN_LOGO_MARK } from '@/lib/brand'
import { Info, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updateStatus,
  applyUpdates,
  checkUpdates,
  openUpdatesWindow,
  refreshDesktopVersion,
  type UpdateApplyState
} from '@/store/updates'

function applyingLabel(apply: UpdateApplyState, t: (source: string) => string): string {
  if (apply.stage === 'restart') {
    return t('即将重启…')
  }

  if (apply.percent != null) {
    return `${t('更新中…').replace('…', '')} ${Math.round(apply.percent)}%`
  }

  return apply.message || t('更新中…')
}

export function AboutSettings() {
  const { t } = useI18n()
  const version = useStore($desktopVersion)
  const status = useStore($updateStatus)
  const apply = useStore($updateApply)
  const checking = useStore($updateChecking)

  // Entering About kicks off a fresh check so the button reflects the real
  // state right away (最新 / 去更新), not a stale cached one. refreshDesktopVersion
  // shows the running version immediately while the check runs.
  useEffect(() => {
    void refreshDesktopVersion()
    void checkUpdates()
  }, [])

  const behind = status?.behind ?? 0
  const supported = status?.supported !== false
  const applying = apply.applying || apply.stage === 'restart'
  const checked = Boolean(status) && !status?.error

  // Secondary note (info card): only for the dev-build case and errors — in the
  // normal flow the button itself carries the state, so no card is shown.
  let note: { text: string; tone: 'idle' | 'error' } | null = null

  if (!supported) {
    note = { text: status?.message ?? t('开发构建不使用应用内更新，直接更新源码检出即可。'), tone: 'idle' }
  } else if (apply.stage === 'error') {
    note = { text: apply.message || t('更新失败，请重试。'), tone: 'error' }
  } else if (status?.error) {
    note = { text: t('无法连接到更新服务器，请稍后重试。'), tone: 'error' }
  } else if (behind > 0 && !applying) {
    note = {
      text: status?.targetVersion ? `${t('发现新版本')} v${status.targetVersion}` : t('发现新版本'),
      tone: 'idle'
    }
  }

  // Primary button: label + action driven by the current state.
  let btn: { busy?: boolean; disabled?: boolean; hidden?: boolean; label: string; onClick?: () => void }

  if (!supported) {
    // Dev build — no in-app update; the note explains it, hide the button.
    btn = { hidden: true, label: '' }
  } else if (apply.stage === 'manual') {
    btn = { label: t('打开更新'), onClick: () => openUpdatesWindow() }
  } else if (applying) {
    btn = { busy: apply.stage !== 'restart', disabled: true, label: applyingLabel(apply, t) }
  } else if (checking) {
    btn = { busy: true, disabled: true, label: t('检查中…') }
  } else if (apply.stage === 'error') {
    btn = { label: t('重试更新'), onClick: () => void applyUpdates() }
  } else if (status?.error) {
    btn = { label: t('重试检查'), onClick: () => void checkUpdates() }
  } else if (behind > 0) {
    btn = { label: t('更新并安装'), onClick: () => void applyUpdates() }
  } else if (checked) {
    btn = { disabled: true, label: t('当前已是最新版本') }
  } else {
    btn = { label: t('检查更新'), onClick: () => void checkUpdates() }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-5">
      <div className="flex min-h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center">
          <div className="flex w-[440px] max-w-full flex-col items-center gap-[30px]">
            <img
              alt="Fan"
              className="size-[72px] dark:invert"
              draggable={false}
              src={FAN_LOGO_MARK}
            />

            <div className="flex flex-col items-center gap-3">
              <h2 className="text-2xl font-bold tracking-[-0.4px] text-foreground">Fan Desktop</h2>
              <span className="inline-flex items-center rounded-full border border-white/60 bg-white/40 px-[11px] py-1 font-mono text-xs font-semibold text-muted-foreground shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)] dark:border-white/10 dark:bg-white/[0.06]">
                {version?.appVersion ? `v${version.appVersion}` : t('版本信息不可用')}
              </span>
            </div>

            {note && (
              <div className="flex w-full items-center gap-[9px] rounded-xl border border-white/55 bg-white/30 px-4 py-3 shadow-[inset_0_1px_1px_rgba(255,255,255,0.7)] dark:border-white/10 dark:bg-white/[0.04]">
                <Info
                  className={cn(
                    'size-3.5 shrink-0',
                    note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
                  )}
                />
                <p
                  className={cn(
                    'flex-1 text-left text-[12.5px] leading-[19px]',
                    note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {note.text}
                </p>
              </div>
            )}

            {!btn.hidden && (
              <Button
                className="gap-2 rounded-full bg-[#2D6BF0] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_7px_16px_-2px_rgba(45,107,240,0.28)] hover:bg-[#2860DB]"
                disabled={btn.disabled}
                onClick={btn.onClick}
              >
                {btn.busy ? (
                  <Loader2 className="size-[15px] animate-spin" />
                ) : btn.onClick ? (
                  <RefreshCw className="size-[15px]" />
                ) : null}
                {btn.label}
              </Button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-[10px] pb-2 pt-8">
          <p className="text-[11.5px] text-[#8A919E]">© 2026 FAN · {t('你的 AI 浏览器 agent')}</p>
        </div>
      </div>
    </div>
  )
}
