'use client'

import { useStore } from '@nanostores/react'
import { type CSSProperties, type FormEvent, useCallback, useEffect, useLayoutEffect, useState } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { triggerHaptic } from '@/lib/haptics'
import { KeyRound, Loader2, Lock } from '@/lib/icons'
import { $pendingBrowserShellPrompt } from '@/store/browser-shell'
import { closeCommandPalette } from '@/store/command-palette'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'
import { $secretRequest, $sudoRequest, clearSecretRequest, clearSudoRequest } from '@/store/prompts'

// Renders the modal mid-turn prompts the gateway raises and waits on: sudo
// password and skill secret capture. (Dangerous-command / execute_code approval
// is rendered INLINE on the pending tool row instead — see
// components/assistant-ui/tool-approval.tsx — so it reads like an inline "Run"
// affordance rather than a blocking modal.) Each Python-side caller blocks the
// agent thread until the matching `*.respond` RPC lands; without a renderer the
// agent stalls until its timeout and the tool is BLOCKED (the bug this fixes —
// These prompts all share the request-scoped blocking protocol. Any close path (Esc, backdrop
// click) funnels through Radix's single `onOpenChange(false)` and maps to a
// refusal, so silence is never mistaken for consent, matching the TUI. We
// deliberately do NOT add onEscapeKeyDown / onInteractOutside handlers — they'd
// fire a second `*.respond` alongside onOpenChange (double-send) or block the
// backdrop-dismiss path.

function isMissingPendingPromptRequest(error: unknown, key: string): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return message.toLowerCase().includes(`no pending ${key.toLowerCase()} request`)
}

function SudoDialog() {
  const request = useStore($sudoRequest)
  const gateway = useStore($gateway)
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setPassword('')
    setSubmitting(false)
  }, [request?.requestId])

  const send = useCallback(
    async (value: string) => {
      if (!request) {
        return
      }

      if (!gateway) {
        notifyError(new Error('Fan 网关未连接'), '无法发送 sudo 密码')

        return
      }

      setSubmitting(true)

      try {
        await gateway.request<{ status?: string }>('sudo.respond', {
          password: value,
          request_id: request.requestId,
          session_id: request.sessionId ?? ''
        })
        triggerHaptic('submit')
        clearSudoRequest(request.sessionId, request.requestId)
      } catch (error) {
        if (isMissingPendingPromptRequest(error, 'password')) {
          clearSudoRequest(request.sessionId, request.requestId)

          return
        }

        notifyError(error, '无法发送 sudo 密码')
        setSubmitting(false)
      }
    },
    [gateway, request]
  )

  // Cancel → empty password. The backend treats an empty sudo response as a
  // failed sudo (no command runs), so closing the dialog is a safe refusal.
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !submitting && request) {
        void send('')
      }
    },
    [request, send, submitting]
  )

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void send(password)
    },
    [password, send]
  )

  if (!request) {
    return null
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      {/* Liquid Glass sudo modal — Pencil b8iff Zvc2a, 1:1: glass card r20
          p14 gap12, 26px red icon chip, 12px body, glass input, pill buttons
          (red primary with tinted glow) and the safe-refusal footer note. */}
      <DialogContent
        className="lg-card z-[310] max-w-[480px] gap-3 p-3.5"
        overlayClassName="z-[300]"
        showCloseButton={false}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="flex items-center gap-2 text-[13px] font-bold text-(--bwa-text)">
            <span className="lg-chip" style={{ '--lg-chip-color': 'var(--ui-red)' } as CSSProperties}>
              <Lock className="size-[13px]" />
            </span>
            管理员密码
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-[1.55] text-(--bwa-text-secondary)">
            Fan 需要您的 sudo 密码来运行特权命令。密码仅发送给您的本地智能体。
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={onSubmit}>
          <Input
            autoFocus
            className="lg-input h-auto px-3 py-[7px] text-[12px] placeholder:text-(--bwa-text-muted)"
            disabled={submitting}
            onChange={event => setPassword(event.target.value)}
            placeholder="sudo 密码"
            type="password"
            value={password}
          />
          <div className="flex items-center justify-end gap-2">
            <button className="lg-btn disabled:opacity-70" disabled={submitting} onClick={() => void send('')} type="button">
              <span className="text-[11.5px] font-medium text-(--bwa-text-secondary)">取消</span>
            </button>
            <button
              className="lg-btn-primary disabled:opacity-70"
              disabled={submitting}
              style={{ '--lg-btn-color': 'var(--ui-red)' } as CSSProperties}
              type="submit"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <span className="text-[11.5px] font-semibold">发送</span>
              )}
            </button>
          </div>
          <p className="text-[10.5px] text-(--bwa-text-muted)">关闭等于发送空密码，安全拒绝</p>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SecretDialog() {
  const request = useStore($secretRequest)
  const gateway = useStore($gateway)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setValue('')
    setSubmitting(false)
  }, [request?.requestId])

  const send = useCallback(
    async (secret: string) => {
      if (!request) {
        return
      }

      if (!gateway) {
        notifyError(new Error('Fan 网关未连接'), '无法发送密钥')

        return
      }

      setSubmitting(true)

      try {
        await gateway.request<{ status?: string }>('secret.respond', {
          request_id: request.requestId,
          session_id: request.sessionId ?? '',
          value: secret
        })
        triggerHaptic('submit')
        clearSecretRequest(request.sessionId, request.requestId)
      } catch (error) {
        if (isMissingPendingPromptRequest(error, 'value')) {
          clearSecretRequest(request.sessionId, request.requestId)

          return
        }

        notifyError(error, '无法发送密钥')
        setSubmitting(false)
      }
    },
    [gateway, request]
  )

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !submitting && request) {
        void send('')
      }
    },
    [request, send, submitting]
  )

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      void send(value)
    },
    [send, value]
  )

  if (!request) {
    return null
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      {/* Liquid Glass secret modal — Pencil b8iff MIVSV, 1:1: blue key chip,
          mono env-var title, glass input with mono placeholder, pill buttons. */}
      <DialogContent
        className="lg-card z-[310] max-w-[480px] gap-3 p-3.5"
        overlayClassName="z-[300]"
        showCloseButton={false}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="flex items-center gap-2 font-mono text-[12.5px] font-bold text-(--bwa-text)">
            <span className="lg-chip">
              <KeyRound className="size-[13px]" />
            </span>
            {request.envVar || '需要密钥'}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-[1.55] text-(--bwa-text-secondary)">
            {request.prompt || 'Fan 需要凭据才能继续。'}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={onSubmit}>
          <Input
            autoFocus
            className="lg-input h-auto px-3 py-[7px] font-mono text-[12px] placeholder:text-(--bwa-text-muted)"
            disabled={submitting}
            onChange={event => setValue(event.target.value)}
            placeholder={request.envVar ? 'sk-••••••••••••' : '密钥值'}
            type="password"
            value={value}
          />
          <div className="flex items-center justify-end gap-2">
            <button className="lg-btn disabled:opacity-70" disabled={submitting} onClick={() => void send('')} type="button">
              <span className="text-[11.5px] font-medium text-(--bwa-text-secondary)">取消</span>
            </button>
            <button className="lg-btn-primary disabled:opacity-70" disabled={submitting || !value} type="submit">
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <span className="text-[11.5px] font-semibold">发送</span>
              )}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PromptOverlays() {
  const browserPrompt = useStore($pendingBrowserShellPrompt)
  const sudoRequest = useStore($sudoRequest)
  const secretRequest = useStore($secretRequest)

  useLayoutEffect(() => {
    if (sudoRequest || secretRequest) {
      closeCommandPalette()
    }
  }, [secretRequest, sudoRequest])

  return !browserPrompt && (sudoRequest ? <SudoDialog /> : <SecretDialog />)
}
