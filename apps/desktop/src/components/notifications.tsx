import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { FAN_LOGO_MARK } from '@/lib/brand'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import {
  $notifications,
  type AppNotification,
  dismissNotification
} from '@/store/notifications'

export function NotificationStack() {
  const notifications = useStore($notifications)
  const lastNotificationIdRef = useRef<string | null>(null)
  const visible = notifications.length > 0

  useEffect(() => {
    const latest = notifications[0]

    if (!latest || latest.id === lastNotificationIdRef.current) {
      return
    }

    lastNotificationIdRef.current = latest.id

    if (latest.kind === 'success') {
      triggerHaptic('success')
    } else if (latest.kind === 'error') {
      triggerHaptic('error')
    } else if (latest.kind === 'warning') {
      triggerHaptic('warning')
    }
  }, [notifications])

  if (!visible) {
    return null
  }

  const latest = notifications[0]

  // Portaled to <body> above ordinary Radix dialogs (overlay z-[120], content
  // z-[130]); urgent browser prompts intentionally use a higher blocking lane.
  // Without the portal the stack lives inside the React root
  // subtree, which any body-level dialog/overlay portal paints over — so a
  // success toast fired while a dialog is open (or over an OverlayView page)
  // was invisible. The titlebar-height var only exists inside the app shell
  // scope, so fall back to its constant (34px) when mounted on <body>.
  return createPortal(
    <div
      aria-label="通知"
      className="pointer-events-none fixed left-1/2 top-[calc(var(--titlebar-height,34px)+0.75rem)] z-[200] flex w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 flex-col gap-2"
      role="region"
    >
      <NotificationItem notification={latest} />
    </div>,
    document.body
  )
}

function NotificationItem({ notification }: { notification: AppNotification }) {
  const hasDetail = Boolean(notification.detail && notification.detail !== notification.message)

  return (
    <div
      aria-live={notification.kind === 'error' ? 'assertive' : 'polite'}
      className="lg-card pointer-events-auto relative flex flex-col gap-2 rounded-[1rem] px-[0.9375rem] py-[0.8125rem]"
      role={notification.kind === 'error' ? 'alert' : 'status'}
    >
      <button
        aria-label="关闭通知"
        className="absolute right-2 top-2 grid size-6 place-items-center rounded-md text-[#A8AEB8] transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => dismissNotification(notification.id)}
        type="button"
      >
        <Codicon name="close" size="0.875rem" />
      </button>

      {/* 单行两栏:左品牌 chip(logo+FAN)· 右内容(标题+说明);删掉了原来占一
          整行的红色状态 icon 与独立时间行,logo 与内容合并到同一行区块。 */}
      <div className="flex items-center gap-3 pr-6">
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#0A0A0A]">
            <img alt="" className="size-4 invert" draggable={false} src={FAN_LOGO_MARK} />
          </span>
          <span className="text-xs font-semibold text-foreground">FAN</span>
        </div>
        <div className="min-w-0 flex-1">
          {notification.title && (
            <p className="m-0 text-[0.90625rem] font-bold tracking-[-0.2px] text-foreground">{notification.title}</p>
          )}
          <p
            className={cn(
              'm-0 text-[0.78125rem] leading-[1.55] text-(--ui-text-secondary)',
              notification.title && 'mt-0.5'
            )}
          >
            {notification.message}
          </p>
          {hasDetail && <NotificationDetail detail={notification.detail || ''} />}
        </div>
      </div>

      {notification.action && (
        <div className="flex justify-end">
          <button
            className="lg-btn text-[0.78125rem] font-semibold text-foreground"
            onClick={() => {
              notification.action?.onClick()
              dismissNotification(notification.id)
            }}
            type="button"
          >
            {notification.action.label}
          </button>
        </div>
      )}
    </div>
  )
}

function NotificationDetail({ detail }: { detail: string }) {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="select-none font-medium text-muted-foreground hover:text-foreground">详情</summary>
      <div
        className="mt-1 rounded-md border border-border/70 bg-background/65 p-2"
        data-selectable-text="true"
      >
        <pre className="max-h-32 whitespace-pre-wrap wrap-break-word font-mono text-[0.6875rem] leading-relaxed">
          {detail}
        </pre>
        <CopyButton
          appearance="inline"
          className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-accent hover:text-foreground"
          errorMessage="无法复制通知详情"
          iconClassName="size-3"
          label="复制详情"
          text={detail}
        >
          复制详情
        </CopyButton>
      </div>
    </details>
  )
}
