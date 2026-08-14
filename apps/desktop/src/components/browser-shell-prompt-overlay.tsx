'use client'

import { useStore } from '@nanostores/react'
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useState } from 'react'

import {
  Dialog,
  DialogAction,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { FanBrowserShellPrompt } from '@/global'
import { AlertTriangle, ExternalLink, Globe, Loader2, Lock } from '@/lib/icons'
import {
  $pendingBrowserShellPrompt,
  attachBrowserShell,
  respondToBrowserShellPrompt
} from '@/store/browser-shell'
import { closeCommandPalette } from '@/store/command-palette'
import { notifyError } from '@/store/notifications'

interface PromptCopy {
  acceptLabel: string
  cancelLabel: string
  description: string
  dismissAccepted: boolean
  input: boolean
  title: string
}

const PERMISSION_LABELS: Record<string, string> = {
  audiocapture: '麦克风',
  camera: '摄像头',
  clipboard: '剪贴板',
  'clipboard-read': '剪贴板',
  'display-capture': '屏幕共享',
  fullscreen: '全屏显示',
  geolocation: '位置',
  media: '摄像头和麦克风',
  microphone: '麦克风',
  midi: 'MIDI 设备',
  notifications: '通知',
  'pointer-lock': '鼠标控制',
  pointerlock: '鼠标控制',
  videocapture: '摄像头'
}

function hostLabel(prompt: FanBrowserShellPrompt): string {
  return prompt.host || '当前页面'
}

function copyForPrompt(prompt: FanBrowserShellPrompt): PromptCopy {
  if (prompt.kind === 'external-application') {
    const app = prompt.scheme ? `${prompt.scheme} 应用` : '其他应用'

    return {
      acceptLabel: '打开应用',
      cancelLabel: '取消',
      description: `${hostLabel(prompt)} 想要打开 ${app}。只有在你认识并信任该操作时才继续。`,
      dismissAccepted: false,
      input: false,
      title: '是否打开外部应用？'
    }
  }

  if (prompt.kind === 'permission') {
    const permission = PERMISSION_LABELS[prompt.permission] || prompt.permission || '此项权限'

    return {
      acceptLabel: '允许',
      cancelLabel: '拒绝',
      description: `${hostLabel(prompt)} 请求使用${permission}。允许后仅对当前页面有效。`,
      dismissAccepted: false,
      input: false,
      title: `允许使用${permission}？`
    }
  }

  if (prompt.dialogType === 'alert') {
    return {
      acceptLabel: '知道了',
      cancelLabel: '',
      description: prompt.message || `${hostLabel(prompt)} 显示了一条提示。`,
      dismissAccepted: true,
      input: false,
      title: '网站提示'
    }
  }

  if (prompt.dialogType === 'prompt') {
    return {
      acceptLabel: '提交',
      cancelLabel: '取消',
      description: prompt.message || `${hostLabel(prompt)} 需要你输入内容后才能继续。`,
      dismissAccepted: false,
      input: true,
      title: '网站需要输入'
    }
  }

  if (prompt.dialogType === 'beforeunload' || prompt.code === 'beforeunload') {
    return {
      acceptLabel: '离开页面',
      cancelLabel: '留在此页',
      description: prompt.message || '当前页面可能有尚未保存的更改。离开后这些更改可能丢失。',
      dismissAccepted: false,
      input: false,
      title: '是否离开当前页面？'
    }
  }

  if (prompt.dialogType === 'confirm') {
    return {
      acceptLabel: '确定',
      cancelLabel: '取消',
      description: prompt.message || `${hostLabel(prompt)} 正在等待你的确认。`,
      dismissAccepted: false,
      input: false,
      title: '网站请求确认'
    }
  }

  return {
    acceptLabel: '继续',
    cancelLabel: '取消',
    description: prompt.message || `${hostLabel(prompt)} 需要你的确认后才能继续。`,
    dismissAccepted: false,
    input: false,
    title: '浏览器需要你的确认'
  }
}

function PromptIcon({ prompt }: { prompt: FanBrowserShellPrompt }) {
  if (prompt.kind === 'external-application') {
    return <ExternalLink aria-hidden className="size-4" />
  }

  if (prompt.kind === 'permission') {
    return <Lock aria-hidden className="size-4" />
  }

  if (prompt.dialogType === 'beforeunload') {
    return <AlertTriangle aria-hidden className="size-4" />
  }

  return <Globe aria-hidden className="size-4" />
}

export function BrowserShellPromptOverlay() {
  const prompt = useStore($pendingBrowserShellPrompt)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const copy = prompt ? copyForPrompt(prompt) : null

  useEffect(() => attachBrowserShell(), [])

  useLayoutEffect(() => {
    setValue(prompt?.defaultValue ?? '')
    setSubmitting(false)
    setError('')

    // A browser-owned prompt blocks Chromium. It takes the single blocking
    // dialog lane immediately instead of appearing underneath the higher-z
    // command palette.
    if (prompt?.eventId) {
      closeCommandPalette()
    }
  }, [prompt?.defaultValue, prompt?.eventId])

  const send = useCallback(
    async (accepted: boolean, answer?: string) => {
      if (!prompt || submitting) {
        return
      }

      setSubmitting(true)
      setError('')

      try {
        await respondToBrowserShellPrompt(prompt.eventId, {
          accepted,
          ...(answer === undefined ? {} : { value: answer })
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setSubmitting(false)
        notifyError(cause, '浏览器操作未完成')
      }
    },
    [prompt, submitting]
  )

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open && prompt && copy && !submitting) {
        void send(copy.dismissAccepted)
      }
    },
    [copy, prompt, send, submitting]
  )

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (copy?.input) {
        void send(true, value)
      } else {
        void send(true)
      }
    },
    [copy?.input, send, value]
  )

  if (!prompt || !copy) {
    return null
  }

  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent
        className="z-[310] max-w-[480px] gap-4"
        overlayClassName="z-[300]"
        showCloseButton={false}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
              <PromptIcon prompt={prompt} />
            </span>
            {copy.title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={onSubmit}>
          {copy.input && (
            <Input
              aria-label="网站请求的输入"
              autoFocus
              disabled={submitting}
              onChange={event => setValue(event.target.value)}
              value={value}
            />
          )}

          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <p className="text-[11px] text-(--ui-text-tertiary)">
            此操作由网页触发，Fan 正在等待你的选择，选择后浏览器会继续。
          </p>

          <DialogFooter>
            {copy.cancelLabel && (
              <DialogAction disabled={submitting} onClick={() => void send(false)} tone="ghost" type="button">
                {copy.cancelLabel}
              </DialogAction>
            )}
            <DialogAction disabled={submitting} type="submit">
              {submitting && <Loader2 aria-hidden className="size-3.5 animate-spin" />}
              {copy.acceptLabel}
            </DialogAction>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
