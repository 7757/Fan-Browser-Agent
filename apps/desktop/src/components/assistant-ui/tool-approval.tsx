'use client'

import { useStore } from '@nanostores/react'
import { type CSSProperties, type FC, useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { triggerHaptic } from '@/lib/haptics'
import { AlertCircle, ChevronDown, Loader2, Terminal } from '@/lib/icons'
import { $gateway } from '@/store/gateway'
import { $nativeViewOccluded } from '@/store/native-overlay'
import { notifyError } from '@/store/notifications'
import {
  $approvalInlineVisible,
  $approvalRequest,
  type ApprovalRequest,
  clearApprovalRequest,
  registerApprovalInlineAnchor
} from '@/store/prompts'

import type { ToolPart } from './tool-fallback-model'

// Inline approval control. Rendered as a compact button strip
// under the pending tool row that raised the approval (the row already shows
// the command, so the strip deliberately doesn't repeat it) instead of as a
// modal overlay.
//
// Binding is POSITIONAL, not command-matched: the desktop `tool.start` payload
// carries no structured args (only tool_id/name/context — see
// tui_gateway/server.py::_on_tool_start), so we cannot join the approval to the
// row by command string. But `approval.request` only ever fires from the
// `terminal` / `execute_code` guards and the agent thread blocks on exactly one
// approval at a time, so the single pending row of those tools IS the row that
// raised it. The command/description text comes from `$approvalRequest` (the
// event payload), which is the only place that data reliably exists.
export const APPROVAL_TOOLS = new Set(['terminal', 'execute_code'])

// Canonical gateway choices emitted by tui_gateway/server.py.
type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

export const PendingToolApproval: FC<{ part: ToolPart }> = ({ part }) => {
  const request = useStore($approvalRequest)

  if (!request || !APPROVAL_TOOLS.has(part.toolName)) {
    return null
  }

  return <InlineApprovalBar request={request} />
}

const InlineApprovalBar: FC<{ request: ApprovalRequest }> = ({ request }) => {
  useEffect(() => registerApprovalInlineAnchor(), [])

  return <ApprovalBar request={request} surface="inline" />
}

export const PendingApprovalFallback: FC = () => {
  const request = useStore($approvalRequest)
  const inlineVisible = useStore($approvalInlineVisible)

  if (!request || inlineVisible) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-30 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2"
      data-slot="tool-approval-fallback"
      style={{ bottom: 'calc(var(--composer-measured-height) + var(--status-stack-measured-height) + 0.875rem)' }}
    >
      <div className="pointer-events-auto lg-card px-3 py-2 shadow-lg backdrop-blur-xl">
        <div className="flex items-center gap-2 px-1 pb-1 text-[12px] font-medium text-(--ui-red)">
          <AlertCircle className="size-4 shrink-0" />
          <span>需要确认后才能继续</span>
        </div>
        <ApprovalBar request={request} surface="floating" />
      </div>
    </div>
  )
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)

export const ApprovalBar: FC<{ request: ApprovalRequest; surface?: 'floating' | 'inline' }> = ({
  request,
  surface = 'inline'
}) => {
  const gateway = useStore($gateway)
  const [submitting, setSubmitting] = useState<ApprovalChoice | null>(null)
  // "Always allow" persists the pattern to ~/.fan/config.yaml permanently, so
  // it goes through a confirm step rather than firing straight from the menu.
  const [confirmAlways, setConfirmAlways] = useState(false)
  // Reveal the full command inline ("expand, Run") instead of only via the
  // Always-allow modal — the pending row shows just one truncated line.
  const [showCommand, setShowCommand] = useState(false)
  const busy = submitting !== null
  const hasCommand = request.command.trim().length > 0
  // The backend drops the permanent-allow path when a tirith content-security
  // warning is present (it would silently degrade "always" → session scope), so
  // don't offer the option. Only an explicit false hides it.
  const allowPermanent = request.allowPermanent !== false

  const respond = useCallback(
    async (choice: ApprovalChoice) => {
      // Another bar (or the keyboard path) may have already resolved this
      // approval; the atom is the single source of truth, so bail if it's gone.
      if (busy || !$approvalRequest.get()) {
        return
      }

      if (!gateway) {
        notifyError(new Error('Fan 网关未连接'), '无法发送审批响应')

        return
      }

      setSubmitting(choice)

      try {
        await gateway.request<{ resolved?: boolean }>('approval.respond', {
          choice,
          request_id: request.requestId,
          session_id: request.sessionId ?? undefined
        })
        triggerHaptic(choice === 'deny' ? 'cancel' : 'submit')
        clearApprovalRequest(request.sessionId, request.requestId)
      } catch (error) {
        notifyError(error, '无法发送审批响应')
        setSubmitting(null)
      }
    },
    [busy, gateway, request.requestId, request.sessionId]
  )

  // ⌘/Ctrl+Enter → Run, Esc → Reject.
  // While the confirm dialog is open it owns the keyboard (Esc closes it), so
  // the strip-level shortcuts stand down to avoid denying the whole approval.
  useEffect(() => {
    if (confirmAlways) {
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // A full-window route or modal is open above this prompt: its Esc must
      // close that surface, never silently deny the tool call underneath.
      if ($nativeViewOccluded.get()) {
        return
      }

      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void respond('once')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void respond('deny')
      }
    }

    window.addEventListener('keydown', onKeyDown, true)

    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [confirmAlways, respond])

  return (
    <div
      className={surface === 'inline' ? 'mt-1 ps-5' : 'mt-1'}
      data-slot={surface === 'inline' ? 'tool-approval-inline' : 'tool-approval-actions'}
    >
      {/* Liquid Glass approval card — Pencil b8iff qcaY1 (审批条), 1:1: glass
          gradient r20 + 4-layer shadow (.lg-card), red pill split Run button
          (+ session/always menu), glass pill Reject and a 查看命令 link. */}
      <div className="lg-card w-fit max-w-full overflow-hidden">
        {/* Command row */}
        <div className="flex items-center gap-2 px-[13px] pt-[9px] pb-2">
          <Terminal aria-hidden className="size-[13px] shrink-0 text-(--ui-red)" />
          <span className="shrink-0 text-[11px] font-semibold text-(--bwa-text-secondary)">Shell command</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-(--bwa-text)">
            {hasCommand ? request.command.trim() : request.description}
          </span>
        </div>
        <div className="lg-divider" />
        {/* Action row */}
        <div className="flex items-center justify-between gap-3 px-[13px] pt-2 pb-[10px]">
          <div className="flex items-center gap-[7px]">
            {/* Run split button (red pill) */}
            <div className="lg-split" style={{ '--lg-btn-color': 'var(--ui-red)' } as CSSProperties}>
              <button
                className="flex items-center gap-1.5 bg-(--ui-red) px-3 py-[5px] transition hover:brightness-105 disabled:opacity-70"
                disabled={busy}
                onClick={() => void respond('once')}
                type="button"
              >
                {submitting === 'once' ? (
                  <Loader2 className="size-3.5 animate-spin text-white" />
                ) : (
                  <>
                    <span className="text-[11.5px] font-semibold text-white">运行一次</span>
                    <span className="font-mono text-[9.5px] text-white/90">{isMac ? '⌘⏎' : 'Ctrl⏎'}</span>
                  </>
                )}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label="更多审批选项"
                    className="flex items-center self-stretch border-l border-white/25 bg-(--ui-red) px-1.5 transition hover:brightness-105 disabled:opacity-70"
                    disabled={busy}
                    type="button"
                  >
                    <ChevronDown className="size-[11px] text-white" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="lg-menu min-w-[134px] p-1">
                  <DropdownMenuItem className="lg-menu-item text-[12px] text-(--bwa-text)" onSelect={() => void respond('session')}>
                    本次会话允许
                  </DropdownMenuItem>
                  {allowPermanent && (
                    <DropdownMenuItem
                      className="lg-menu-item text-[12px] text-(--bwa-text)"
                      onSelect={() => {
                        // Defer one tick so the menu fully unmounts before the
                        // dialog mounts — otherwise Radix's focus-return races the
                        // dialog and dismisses it via onInteractOutside.
                        setTimeout(() => setConfirmAlways(true), 0)
                      }}
                    >
                      总是允许
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {/* Reject (glass pill) */}
            <button className="lg-btn disabled:opacity-70" disabled={busy} onClick={() => void respond('deny')} type="button">
              {submitting === 'deny' ? (
                <Loader2 className="size-3.5 animate-spin text-(--bwa-text-secondary)" />
              ) : (
                <>
                  <span className="text-[11.5px] font-semibold text-(--bwa-text-secondary)">拒绝</span>
                  <span className="font-mono text-[9.5px] text-(--bwa-text-muted)">Esc</span>
                </>
              )}
            </button>
          </div>
          {hasCommand && (
            <button
              aria-expanded={showCommand}
              className="shrink-0 text-[12px] font-medium text-(--bwa-text-secondary) transition-colors hover:text-(--bwa-text)"
              onClick={() => setShowCommand(value => !value)}
              type="button"
            >
              查看命令
            </button>
          )}
        </div>
      </div>

      {showCommand && hasCommand && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-2.5 py-1.5 font-mono text-xs leading-snug text-foreground">
          {request.command.trim()}
        </pre>
      )}

      <Dialog onOpenChange={setConfirmAlways} open={confirmAlways}>
        <DialogContent className="lg-card max-w-md gap-3 p-4">
          <DialogHeader>
            <DialogTitle>始终允许此命令？</DialogTitle>
            <DialogDescription>
              这将把”{request.description}”模式添加到您的永久允许列表（
              <code className="font-mono text-xs">~/.fan/config.yaml</code>）。对于类似的命令，Fan 将不再询问——无论是本次会话还是以后的会话。
            </DialogDescription>
          </DialogHeader>

          {request.command.trim() && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background) px-2.5 py-1.5 font-mono text-xs leading-snug text-foreground">
              {request.command.trim()}
            </pre>
          )}

          <DialogFooter>
            <Button onClick={() => setConfirmAlways(false)} size="sm" variant="ghost">
              取消
            </Button>
            <Button
              onClick={() => {
                setConfirmAlways(false)
                void respond('always')
              }}
              size="sm"
              variant="destructive"
            >
              始终允许
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
