import { atom } from 'nanostores'

import { userFacingErrorMessage } from '@/lib/user-facing-error'

export type NotificationKind = 'error' | 'warning' | 'info' | 'success'

interface NotificationAction {
  label: string
  onClick: () => void
}

export interface AppNotification {
  id: string
  kind: NotificationKind
  title?: string
  message: string
  detail?: string
  action?: NotificationAction
  onDismiss?: () => void
  createdAt: number
}

interface NotificationInput {
  id?: string
  kind?: NotificationKind
  title?: string
  message: string
  detail?: string
  action?: NotificationAction
  onDismiss?: () => void
  durationMs?: number
}

let notificationCounter = 0
const MAX_NOTIFICATIONS = 4
const durations = new Map<string, number>()
const timers = new Map<string, number>()

export const $notifications = atom<AppNotification[]>([])

function defaultDuration(kind: NotificationKind) {
  if (kind === 'error' || kind === 'warning') {
    return 0
  }

  return 5_000
}

function clearNotificationTimer(id: string): void {
  window.clearTimeout(timers.get(id))
  timers.delete(id)
}

// Only the notification currently visible to the user owns a timer. Queued
// items start their full display duration when they reach the front.
function armActiveNotification(): void {
  const active = $notifications.get()[0]

  if (!active || timers.has(active.id)) {
    return
  }

  const duration = durations.get(active.id) ?? defaultDuration(active.kind)

  if (duration > 0) {
    timers.set(
      active.id,
      window.setTimeout(() => dismissNotification(active.id), duration)
    )
  }
}

const ERROR_SUMMARIES: { test: (msg: string) => boolean; summarize: (msg: string) => string }[] = [
  {
    test: msg => /incorrect api key provided/i.test(msg) || /['"]code['"]\s*:\s*['"]invalid_api_key['"]/i.test(msg),
    summarize: msg => {
      const status = msg.match(/(?:error code|status(?:Code)?)[^\d]*(\d{3})/i)?.[1]

      return `OpenAI API key 无效${status ? `（${status} invalid_api_key）` : ''}。`
    }
  },
  {
    test: msg => /neither voice_tools_openai_key nor openai_api_key is set/i.test(msg),
    summarize: () => 'OpenAI TTS 需要设置 VOICE_TOOLS_OPENAI_KEY 或 OPENAI_API_KEY。'
  },
  {
    test: msg => /ELEVENLABS_API_KEY not set/i.test(msg) || /ElevenLabs STT API error \(HTTP 401\)/i.test(msg),
    summarize: msg =>
      /ELEVENLABS_API_KEY not set/i.test(msg)
        ? 'ElevenLabs STT 需要设置 ELEVENLABS_API_KEY。'
        : 'ElevenLabs API key 无效（401）。'
  },
  {
    test: msg => /method not allowed/i.test(msg),
    summarize: () =>
      '桌面后端拒绝了该请求（405 Method Not Allowed），请尝试重启 Fan Desktop。'
  },
  {
    test: msg => /microphone permission/i.test(msg),
    summarize: () => '麦克风权限被拒绝。'
  }
]

function summarizeErrorMessage(message: string, fallback: string) {
  const rule = ERROR_SUMMARIES.find(r => r.test(message))

  if (rule) {
    return rule.summarize(message)
  }

  return message.length > 180 ? fallback : message || fallback
}

export function notify(input: NotificationInput): string {
  const kind = input.kind ?? 'info'
  const id = input.id ?? `${Date.now()}-${notificationCounter++}`

  const notification: AppNotification = {
    id,
    kind,
    title: input.title,
    message: input.message,
    detail: input.detail,
    action: input.action,
    onDismiss: input.onDismiss,
    createdAt: Date.now()
  }

  const duration = input.durationMs ?? defaultDuration(kind)
  const current = $notifications.get()
  const existingIndex = current.findIndex(item => item.id === id)
  const next = [...current]

  durations.set(id, duration)

  if (existingIndex >= 0) {
    next[existingIndex] = notification
    clearNotificationTimer(id)
  } else {
    next.push(notification)
  }

  const evicted = next.length > MAX_NOTIFICATIONS
    ? next.splice(1, next.length - MAX_NOTIFICATIONS)
    : []

  $notifications.set(next)

  for (const item of evicted) {
    clearNotificationTimer(item.id)
    durations.delete(item.id)
    item.onDismiss?.()
  }

  armActiveNotification()

  return id
}

export function notifyError(error: unknown, fallback: string): string {
  const message = summarizeErrorMessage(userFacingErrorMessage(error, fallback), fallback)

  return notify({
    kind: 'error',
    title: fallback,
    message
  })
}

export function dismissNotification(id: string) {
  clearNotificationTimer(id)
  durations.delete(id)
  const dismissed = $notifications.get().find(item => item.id === id)
  $notifications.set($notifications.get().filter(item => item.id !== id))
  dismissed?.onDismiss?.()
  armActiveNotification()
}

export function clearNotifications() {
  for (const timer of timers.values()) {
    window.clearTimeout(timer)
  }

  timers.clear()
  durations.clear()
  const all = $notifications.get()
  $notifications.set([])

  for (const item of all) {
    item.onDismiss?.()
  }
}
