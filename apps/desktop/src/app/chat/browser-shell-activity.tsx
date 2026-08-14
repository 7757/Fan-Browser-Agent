'use client'

import { useStore } from '@nanostores/react'
import { type Ref, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import type { FanBrowserShellDownload, FanBrowserShellHealth, FanBrowserShellNotice } from '@/global'
import { AlertTriangle, Download, Loader2 } from '@/lib/icons'
import {
  $browserShell,
  browserShellDownloadsFor,
  browserShellHealthFor,
  browserShellNoticeFor
} from '@/store/browser-shell'

interface BrowserShellActivityScope {
  tabId?: null | string
  workbenchId?: null | string
}

interface BrowserShellActivityControlProps extends BrowserShellActivityScope {
  buttonRef?: Ref<HTMLButtonElement>
  dismissed?: boolean
  onOpenChange: (open: boolean) => void
  open: boolean
}

function activeDownload(download: FanBrowserShellDownload): boolean {
  return !download.done && (download.state === 'progressing' || download.state === 'started')
}

function healthCopy(health: FanBrowserShellHealth): string {
  const codeCopy: Record<string, string> = {
    'page-crashed': '网页已崩溃',
    'renderer-crash-loop': '网页反复崩溃，已停止自动恢复',
    'renderer-recovering': '网页异常，正在尝试恢复',
    'renderer-recovery-failed': '网页恢复失败',
    'renderer-unresponsive': '网页暂时没有响应'
  }

  if (codeCopy[health.code]) {
    return codeCopy[health.code]
  }

  const statusCopy: Record<FanBrowserShellHealth['status'], string> = {
    crashed: '网页已崩溃',
    degraded: '网页运行状态异常',
    ok: '网页运行正常',
    unresponsive: '网页暂时没有响应'
  }

  return statusCopy[health.status]
}

function noticeCopy(notice: FanBrowserShellNotice): string {
  const codeCopy: Record<string, string> = {
    'external-application-blocked': '网页请求的外部应用无法安全打开',
    'invalid-link-url': '网页链接无效，浏览器未打开',
    'invalid-popup-url': '网页尝试打开无效地址，浏览器已阻止',
    'popup-blocked': '网页尝试打开新页面，但浏览器已阻止',
    'popup-flood': '网页短时间打开了过多页面，浏览器已阻止',
    'renderer-crash-loop': '网页反复崩溃，已停止自动恢复',
    'renderer-recovery-failed': '网页恢复失败，请刷新或换一个页面',
    'tab-limit': '浏览器标签页已达到上限',
    'unsafe-protocol-blocked': '网页尝试打开不安全的链接，浏览器已阻止',
    'unsupported-permission-blocked': '网页请求了不支持的权限，浏览器已拒绝',
    'view-limit': '浏览器页面数量已达到上限'
  }

  return codeCopy[notice.code] || '浏览器刚刚阻止了一项页面操作'
}

export function BrowserShellActivityControl({
  buttonRef,
  dismissed = false,
  onOpenChange,
  open,
  tabId,
  workbenchId
}: BrowserShellActivityControlProps) {
  const shell = useStore($browserShell)
  const downloads = browserShellDownloadsFor(shell, workbenchId)
  const health = browserShellHealthFor(shell, workbenchId, tabId)
  const notice = browserShellNoticeFor(shell, workbenchId, tabId)
  const activeCount = downloads.filter(activeDownload).length

  useEffect(() => {
    if (shell.hydrated && downloads.length === 0 && open) {
      onOpenChange(false)
    }
  }, [downloads.length, onOpenChange, open, shell.hydrated])

  const downloadLabel = activeCount
    ? `下载：${activeCount} 个文件正在下载`
    : `下载：查看最近 ${downloads.length} 个文件`

  const showDownloadActivity = downloads.length > 0 && !dismissed

  return (
    <div className="flex shrink-0 items-center gap-1">
      {health && health.status !== 'ok' && (
        <Tip label={healthCopy(health)} side="top">
          <span
            aria-label={healthCopy(health)}
            className="flex h-7 items-center gap-1 rounded-lg bg-(--ui-red)/10 px-2 text-[10.5px] font-medium text-(--ui-red)"
            role="status"
          >
            <AlertTriangle aria-hidden className="size-3.5" />
            <span className="hidden max-w-32 truncate xl:inline">{healthCopy(health)}</span>
          </span>
        </Tip>
      )}

      {notice && (
        <Tip label={noticeCopy(notice)} side="top">
          <span
            aria-label={noticeCopy(notice)}
            className={
              notice.level === 'error'
                ? 'flex h-7 items-center gap-1 rounded-lg bg-(--ui-red)/10 px-2 text-[10.5px] font-medium text-(--ui-red)'
                : 'flex h-7 items-center gap-1 rounded-lg bg-(--ui-yellow)/12 px-2 text-[10.5px] font-medium text-(--ui-yellow)'
            }
            role="status"
          >
            <AlertTriangle aria-hidden className="size-3.5" />
            <span className="hidden max-w-36 truncate xl:inline">{noticeCopy(notice)}</span>
          </span>
        </Tip>
      )}

      {showDownloadActivity && (
        <Tip label={downloadLabel} side="top">
          <Button
            aria-expanded={open}
            aria-label={downloadLabel}
            className="relative size-7 rounded-lg p-0 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
            onClick={() => onOpenChange(!open)}
            ref={buttonRef}
            size="sm"
            variant={open ? 'secondary' : 'ghost'}
          >
            {activeCount ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : (
              <Download aria-hidden className="size-3.5" />
            )}
            {!open && (
              <span
                aria-hidden
                className="absolute -right-1 -top-1 grid min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[8px] font-bold leading-3.5 text-primary-foreground"
                data-download-count
              >
                {Math.min(downloads.length, 9)}
              </span>
            )}
          </Button>
        </Tip>
      )}
    </div>
  )
}
