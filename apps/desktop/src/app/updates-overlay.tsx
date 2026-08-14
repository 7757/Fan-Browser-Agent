import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import type { DesktopUpdateStage, DesktopUpdateStatus } from '@/global'
import { AlertCircle, Check, CheckCircle2, Copy, Loader2, Sparkles, Terminal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $pendingBrowserShellPrompt } from '@/store/browser-shell'
import { closeCommandPalette } from '@/store/command-palette'
import { $secretRequest, $sudoRequest } from '@/store/prompts'
import {
  $updateApply,
  $updateChecking,
  $updateOverlayOpen,
  $updateStatus,
  applyUpdates,
  checkUpdates,
  resetUpdateApplyState,
  setUpdateOverlayOpen,
  type UpdateApplyState
} from '@/store/updates'

const STAGE_LABELS: Record<DesktopUpdateStage, string> = {
  idle: '准备中…',
  prepare: '准备中…',
  fetch: '下载中…',
  pull: '即将完成…',
  pydeps: '收尾中…',
  restart: '正在重启 Fan…',
  manual: '手动完成安装',
  error: '更新已暂停'
}

export function UpdatesOverlay() {
  const open = useStore($updateOverlayOpen)
  const status = useStore($updateStatus)
  const checking = useStore($updateChecking)
  const apply = useStore($updateApply)
  const browserPrompt = useStore($pendingBrowserShellPrompt)
  const sudoRequest = useStore($sudoRequest)
  const secretRequest = useStore($secretRequest)
  const visible = open && !browserPrompt && !sudoRequest && !secretRequest

  useEffect(() => {
    if (open && !status && !checking) {
      void checkUpdates()
    }
  }, [checking, open, status])

  useLayoutEffect(() => {
    if (open) {
      closeCommandPalette()
    }
  }, [open])

  const behind = status?.behind ?? 0

  const phase: 'idle' | 'applying' | 'manual' | 'error' =
    apply.stage === 'manual'
      ? 'manual'
      : apply.applying || apply.stage === 'restart'
        ? 'applying'
        : apply.stage === 'error'
          ? 'error'
          : 'idle'

  const handleClose = (next: boolean) => {
    if (phase === 'applying') {
      return
    }

    setUpdateOverlayOpen(next)

    if (!next && (apply.stage === 'error' || apply.stage === 'restart' || apply.stage === 'manual')) {
      resetUpdateApplyState()
    }
  }

  const handleInstall = () => {
    void applyUpdates()
  }

  return (
    <Dialog onOpenChange={handleClose} open={visible}>
      <DialogContent
        className="update-dialog-surface z-[310] max-w-sm overflow-hidden border-border/70 p-0 gap-0"
        overlayClassName="z-[300]"
        showCloseButton={phase !== 'applying'}
      >
        {phase === 'applying' && <ApplyingView apply={apply} />}

        {phase === 'manual' && (
          <ManualView
            command={apply.command ?? '请从 Fan 官网下载并安装最新版本。'}
            onDone={() => handleClose(false)}
          />
        )}

        {phase === 'error' && (
          <ErrorView message={apply.message} onDismiss={() => handleClose(false)} onRetry={handleInstall} />
        )}

        {phase === 'idle' && (
          <IdleView
            behind={behind}
            checking={checking}
            onInstall={handleInstall}
            onLater={() => handleClose(false)}
            onRetryCheck={() => void checkUpdates()}
            status={status}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function IdleView({
  behind,
  checking,
  onInstall,
  onLater,
  onRetryCheck,
  status
}: {
  behind: number
  checking: boolean
  onInstall: () => void
  onLater: () => void
  onRetryCheck: () => void
  status: DesktopUpdateStatus | null
}) {
  if (!status && checking) {
    return <CenteredStatus icon={<Loader2 className="size-6 animate-spin text-primary" />} title="正在检查更新…" />
  }

  if (!status) {
    return (
      <CenteredStatus
        action={
          <Button onClick={onRetryCheck} size="sm">
            重试
          </Button>
        }
        icon={<AlertCircle className="size-6 text-muted-foreground" />}
        title="无法检查更新"
      />
    )
  }

  if (!status.supported) {
    return (
      <CenteredStatus
        body={status.message ?? '此版本的 Fan 不支持在应用内自动更新。'}
        icon={<AlertCircle className="size-6 text-muted-foreground" />}
        title="暂无可用更新"
      />
    )
  }

  if (status.error) {
    return (
      <CenteredStatus
        action={
          <Button disabled={checking} onClick={onRetryCheck} size="sm">
            重试
          </Button>
        }
        body="请检查网络连接后重试。"
        icon={<AlertCircle className="size-6 text-muted-foreground" />}
        title="无法检查更新"
      />
    )
  }

  if (behind === 0) {
    return (
      <CenteredStatus
        body="您已运行最新版本。"
        icon={<CheckCircle2 className="size-7 text-(--ui-green)" />}
        title="已是最新"
      />
    )
  }

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="size-7" />
        </span>

        <DialogTitle className="text-center text-xl">
          {status.targetVersion ? `新版本 v${status.targetVersion}` : '有可用更新'}
        </DialogTitle>
        <DialogDescription className="text-center text-sm">
          {status.currentVersion ? `当前版本 v${status.currentVersion}，` : ''}新版本已准备好安装。
        </DialogDescription>
      </div>

      {status.releaseNotes && (
        <div className="lg-input max-h-44 overflow-y-auto whitespace-pre-wrap px-4 py-3 text-xs leading-relaxed text-foreground">
          {status.releaseNotes}
        </div>
      )}

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={onInstall} size="lg">
          立即更新
        </Button>
        <button
          className="text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={onLater}
          type="button"
        >
          稍后再说
        </button>
      </div>
    </div>
  )
}

function ManualView({ command, onDone }: { command: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  // macOS (unsigned build): main opened the versioned DMG link in the browser
  // and hands us that URL; dev builds hand a plain instruction line instead.
  const isUrl = /^https?:\/\//i.test(command)

  const handleCopy = () => {
    void writeClipboardText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {isUrl ? <Sparkles className="size-7" /> : <Terminal className="size-7" />}
        </span>

        <DialogTitle className="text-center text-xl">{isUrl ? '在浏览器中完成安装' : '手动更新'}</DialogTitle>
        <DialogDescription className="text-center text-sm">
          {isUrl
            ? '新版本安装包已在浏览器中打开。下载完成后，打开 DMG 并将 Fan 拖入“应用程序”即可完成更新。'
            : '请按以下指引完成更新：'}
        </DialogDescription>
      </div>

      <button
        className="lg-input group flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-[background-color,border-color] hover:bg-(--lg-inset-fill-strong)"
        onClick={handleCopy}
        type="button"
      >
        <code className="select-all break-all font-mono text-xs text-foreground">
          {!isUrl && <span className="text-muted-foreground">$ </span>}
          {command}
        </code>
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
          {copied ? (
            <>
              <Check className="size-3.5 text-(--ui-green)" />
              已复制
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              复制
            </>
          )}
        </span>
      </button>

      <Button className="font-semibold" onClick={onDone} size="lg" variant="outline">
        完成
      </Button>
    </div>
  )
}

function ApplyingView({ apply }: { apply: UpdateApplyState }) {
  const label = STAGE_LABELS[apply.stage] ?? '正在更新 Fan…'

  const percent =
    typeof apply.percent === 'number' && Number.isFinite(apply.percent)
      ? Math.max(2, Math.min(100, Math.round(apply.percent)))
      : null

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="relative flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Loader2 className="size-7 animate-spin" />
        </span>

        <DialogTitle className="text-center text-xl">{label}</DialogTitle>
        <DialogDescription className="text-center text-sm">
          Fan 更新程序将在独立窗口中接管，完成后自动重新打开 Fan。
        </DialogDescription>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-(--lg-inset-fill)">
        <div
          className={cn(
            'h-full rounded-full bg-primary transition-[width] duration-300 ease-out',
            percent === null && 'w-1/3 animate-pulse'
          )}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>

      <p className="text-center text-xs text-muted-foreground">Fan 将关闭以应用更新。</p>
    </div>
  )
}

function ErrorView({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry: () => void }) {
  return (
    <ErrorState
      className="px-6 pb-6 pt-7 pr-8"
      description={
        <DialogDescription className="max-w-prose text-center text-sm leading-5 text-muted-foreground">
          {message || '别担心——没有任何内容丢失。您可以立即重试。'}
        </DialogDescription>
      }
      title={<DialogTitle className="text-center text-xl font-semibold tracking-tight">更新未完成</DialogTitle>}
    >
      <Button className="font-semibold" onClick={onRetry} size="lg">
        重试
      </Button>
      <Button onClick={onDismiss} variant="text">
        暂不更新
      </Button>
    </ErrorState>
  )
}

function CenteredStatus({
  action,
  body,
  icon,
  title
}: {
  action?: React.ReactNode
  body?: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="grid gap-4 px-6 pb-6 pt-8 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="lg-chip flex size-14 items-center justify-center">{icon}</span>

        <DialogTitle className="text-center text-lg">{title}</DialogTitle>
        {body && <DialogDescription className="text-center text-sm">{body}</DialogDescription>}
      </div>

      {action && <div className="flex justify-center">{action}</div>}
    </div>
  )
}
