import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { ActionStatus } from '@/components/ui/action-status'
import {
  Dialog,
  DialogAction,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { AlertTriangle } from '@/lib/icons'
import { userFacingErrorMessage } from '@/lib/user-facing-error'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  // Does the work. Throw to surface an inline error and keep the dialog open.
  onConfirm: () => Promise<void> | void
  title: ReactNode
  description?: ReactNode
  confirmLabel?: string
  busyLabel?: string
  doneLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

// Shared confirmation dialog: Enter confirms (from anywhere in the dialog),
// Esc/Cancel/backdrop dismiss. Owns the pending → done → close beat and inline
// error, so callers pass only an async onConfirm that does the work.
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '确认',
  busyLabel = '处理中…',
  doneLabel = '完成',
  cancelLabel = '取消',
  destructive = false
}: ConfirmDialogProps) {
  const [status, setStatus] = useState<'done' | 'idle' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)
  const busy = status === 'saving' || status === 'done'

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }
  }, [open])

  async function run() {
    if (busy) {
      return
    }

    setStatus('saving')
    setError(null)

    try {
      await onConfirm()
      setStatus('done')
      window.setTimeout(onClose, 600)
    } catch (err) {
      console.error('[confirm-dialog] Confirm action failed', err)
      setStatus('idle')
      setError(userFacingErrorMessage(err, '操作失败，请重试。'))
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !busy && onClose()} open={open}>
      <DialogContent
        className="max-w-md"
        onKeyDown={event => {
          // Enter/Space confirm regardless of which button holds focus
          // (preventDefault stops a focused Cancel from swallowing it).
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault()
            void run()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <DialogAction disabled={busy} onClick={onClose} tone="ghost" type="button">
            {cancelLabel}
          </DialogAction>
          <DialogAction
            disabled={busy}
            onClick={() => void run()}
            tone={destructive ? 'destructive' : 'primary'}
          >
            <ActionStatus busy={busyLabel} done={doneLabel} idle={confirmLabel} state={status} />
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
