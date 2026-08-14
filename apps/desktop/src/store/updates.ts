/**
 * Desktop self-update store. Tracks distance from the configured branch,
 * surfaces it as an ambient pill, and orchestrates the apply flow.
 */

import { atom } from 'nanostores'

import type {
  DesktopUpdateApplyOptions,
  DesktopUpdateApplyResult,
  DesktopUpdateProgress,
  DesktopUpdateStage,
  DesktopUpdateStatus,
  DesktopVersionInfo
} from '@/global'
import { persistString, storedString } from '@/lib/storage'
import { userFacingErrorMessage } from '@/lib/user-facing-error'
import { dismissNotification, notify } from '@/store/notifications'

export interface UpdateApplyState {
  applying: boolean
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  /** When the stage is 'manual': the exact command the user should run
   *  (CLI install with no staged updater). */
  command: string | null
  log: readonly { stage: DesktopUpdateStage; message: string; at: number }[]
}

const IDLE: UpdateApplyState = {
  applying: false,
  stage: 'idle',
  message: '',
  percent: null,
  error: null,
  command: null,
  log: []
}

export const $desktopVersion = atom<DesktopVersionInfo | null>(null)
export const $updateApply = atom<UpdateApplyState>(IDLE)
export const $updateChecking = atom<boolean>(false)
export const $updateOverlayOpen = atom<boolean>(false)
export const $updateStatus = atom<DesktopUpdateStatus | null>(null)

export const setUpdateOverlayOpen = (open: boolean) => $updateOverlayOpen.set(open)
export const resetUpdateApplyState = () => $updateApply.set(IDLE)

const UPDATE_TOAST_ID = 'desktop-update-available'
// Time-based snooze instead of per-sha dismissal: this repo lands ~100 commits
// a day, so a "don't show this exact sha again" guard re-popped the toast on
// every new commit. We instead suppress the toast for a cooldown window that
// (re)starts whenever the user closes it.
const UPDATE_TOAST_SNOOZE_KEY = 'fan:update-toast-snooze-until'
const UPDATE_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeUpdateToast(): void {
  persistString(UPDATE_TOAST_SNOOZE_KEY, String(Date.now() + UPDATE_TOAST_COOLDOWN_MS))
}

function isUpdateToastSnoozed(): boolean {
  const until = Number(storedString(UPDATE_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

// Must match tui_gateway's DESKTOP_BACKEND_CONTRACT that this build was written
// against. The backend reports its own value in session runtime info; a lower
// value (or none — a pre-GUI checkout) means GUI<->backend skew.
const REQUIRED_BACKEND_CONTRACT = 1
const SKEW_TOAST_ID = 'backend-contract-skew'
const SKEW_TOAST_SNOOZE_KEY = 'fan:backend-skew-toast-snooze-until'
const SKEW_TOAST_COOLDOWN_MS = 24 * 60 * 60 * 1000

function snoozeSkewToast(): void {
  persistString(SKEW_TOAST_SNOOZE_KEY, String(Date.now() + SKEW_TOAST_COOLDOWN_MS))
}

function isSkewToastSnoozed(): boolean {
  const until = Number(storedString(SKEW_TOAST_SNOOZE_KEY) || 0)

  return Number.isFinite(until) && Date.now() < until
}

/**
 * Guard against a desktop GUI talking to a backend that predates its contract
 * (e.g. a bb/gui-built app pointed at a `main` checkout). Rather than failing
 * cryptically downstream, surface a warning with a one-click align that runs
 * the normal update flow. This check runs whenever session runtime information
 * arrives, so dismissing the warning snoozes it instead of nagging on every
 * thread switch.
 */
export function reportBackendContract(contract: number | undefined): void {
  if ((contract ?? 0) >= REQUIRED_BACKEND_CONTRACT) {
    dismissNotification(SKEW_TOAST_ID)
    persistString(SKEW_TOAST_SNOOZE_KEY, null)

    return
  }

  if (isSkewToastSnoozed()) {
    return
  }

  notify({
    action: {
      label: '更新 Fan',
      onClick: () => {
        snoozeSkewToast()
        void applyUpdates()
      }
    },
    durationMs: 0,
    id: SKEW_TOAST_ID,
    kind: 'warning',
    message: '您的 Fan 后端版本低于当前桌面构建版本，可能无法正常工作，请更新以保持一致。',
    onDismiss: () => snoozeSkewToast(),
    title: '后端版本过旧'
  })
}

/**
 * Fire a toast when an update is available, at most once per cooldown window.
 * Closing the toast — dismissing it or opening the updates window from it —
 * (re)starts the cooldown, so a busy upstream branch doesn't re-spam the user
 * on every new commit. The snooze is persisted, so it survives relaunches too.
 */
export function maybeNotifyUpdateAvailable(status: DesktopUpdateStatus | null) {
  if (!status || status.supported === false || status.error || !status.targetSha) {
    return
  }

  if ((status.behind ?? 0) <= 0) {
    return
  }

  if (isUpdateToastSnoozed()) {
    return
  }

  if ($updateApply.get().applying) {
    return
  }

  notify({
    action: {
      label: '查看更新内容',
      onClick: () => {
        snoozeUpdateToast()
        openUpdatesWindow()
      }
    },
    durationMs: 0,
    id: UPDATE_TOAST_ID,
    kind: 'info',
    message: status.targetVersion ? `新版本 v${status.targetVersion} 已发布。` : '新版本已发布。',
    onDismiss: () => snoozeUpdateToast(),
    title: '有可用更新'
  })
}

/**
 * Opens the updates dialog and kicks off a fresh check so the user always
 * sees current state, even if a stale status is cached from earlier.
 */
export function openUpdatesWindow(): void {
  $updateOverlayOpen.set(true)
  void checkUpdates()
}

/** Re-read the running app's version from the Electron main process and
 *  publish it on `$desktopVersion`. Called when the About panel mounts, the
 *  update flow finishes, and the window regains focus, so the About text
 *  stays in sync with the just-installed binary instead of frozen at the
 *  value captured at first-load. */
export async function refreshDesktopVersion(): Promise<DesktopVersionInfo | null> {
  if (typeof window === 'undefined') {
    return null
  }

  // Best-effort UI sync: callers (checkUpdates, startUpdatePoller, window
  // focus handler) all kick this off with `void refreshDesktopVersion()`,
  // so any rejection from the IPC bridge (e.g. main process shutting down
  // mid-reload, or the bridge not yet ready on first paint) would surface
  // as an unhandled promise rejection in the renderer. Swallow it.
  try {
    const next = await window.fanDesktop?.getVersion?.()

    if (next) {
      $desktopVersion.set(next)
    }

    return next ?? null
  } catch {
    return null
  }
}

export async function checkUpdates(): Promise<DesktopUpdateStatus | null> {
  const bridge = window.fanDesktop?.updates

  if (!bridge || $updateChecking.get()) {
    return $updateStatus.get()
  }

  $updateChecking.set(true)

  try {
    const status = await bridge.check()

    $updateStatus.set(status)
    maybeNotifyUpdateAvailable(status)
    // The update check pulls the latest fan_cli + bundled package metadata
    // into place. Re-read the running version so About reflects the now-fresh
    // checkout rather than the one captured at process start.
    void refreshDesktopVersion()

    return status
  } catch (error) {
    console.error('[updates] Update check failed', error)
    const previous = $updateStatus.get()

    const fallback: DesktopUpdateStatus = {
      supported: previous?.supported ?? true,
      error: 'check-failed',
      message: userFacingErrorMessage(error, '无法连接到更新服务器，请稍后重试。'),
      fetchedAt: Date.now()
    }

    $updateStatus.set(fallback)

    return fallback
  } finally {
    $updateChecking.set(false)
  }
}

export async function applyUpdates(opts: DesktopUpdateApplyOptions = {}): Promise<DesktopUpdateApplyResult> {
  const bridge = window.fanDesktop?.updates

  if (!bridge) {
    return { ok: false, error: 'unavailable', message: '桌面桥接不可用。' }
  }

  dismissNotification(UPDATE_TOAST_ID)
  $updateApply.set({ ...IDLE, applying: true, stage: 'prepare', message: '正在启动更新…' })

  try {
    const result = await bridge.apply(opts)

    // A platform without in-place installation is not an error. Land on a
    // dedicated manual state so the overlay shows the URL/instruction instead
    // of a dead retry loop.
    if (result?.manual) {
      const instruction = result.command ?? '请从 Fan 官网下载并安装最新版本。'
      $updateApply.set({
        ...IDLE,
        applying: false,
        stage: 'manual',
        message: instruction,
        command: instruction
      })
    }

    return result
  } catch (error) {
    console.error('[updates] Update apply failed', error)
    const message = userFacingErrorMessage(error, '更新失败，请稍后重试。')
    $updateApply.set({ ...$updateApply.get(), applying: false, stage: 'error', error: 'apply-failed', message })

    return { ok: false, error: 'apply-failed', message }
  }
}

function ingestProgress(payload: DesktopUpdateProgress): void {
  const current = $updateApply.get()
  const log = [...current.log, { stage: payload.stage, message: payload.message, at: payload.at }].slice(-50)
  const terminal = payload.stage === 'error' || payload.stage === 'restart' || payload.stage === 'manual'

  const message =
    payload.stage === 'error'
      ? userFacingErrorMessage(payload.message, '更新失败，请稍后重试。')
      : payload.message

  $updateApply.set({
    applying: !terminal,
    stage: payload.stage,
    message,
    percent: payload.percent,
    error: payload.error,
    // 'manual' carries the command to run in its message field.
    command: payload.stage === 'manual' ? payload.message : current.command,
    log
  })
}

let pollerStarted = false
let backgroundTimer: ReturnType<typeof setInterval> | null = null
let progressUnsubscribe: (() => void) | null = null
let lastFocusAt = 0

/** Wire up background polling + progress streaming. Idempotent. */
export function startUpdatePoller(): void {
  if (pollerStarted || typeof window === 'undefined') {
    return
  }

  const bridge = window.fanDesktop?.updates

  if (!bridge) {
    return
  }

  pollerStarted = true
  void checkUpdates()
  void refreshDesktopVersion()
  progressUnsubscribe = bridge.onProgress(ingestProgress)

  window.addEventListener('focus', onFocus)
  backgroundTimer = setInterval(() => void checkUpdates(), 30 * 60 * 1000)
}

export function stopUpdatePoller(): void {
  progressUnsubscribe?.()
  progressUnsubscribe = null

  if (backgroundTimer !== null) {
    clearInterval(backgroundTimer)
    backgroundTimer = null
  }

  window.removeEventListener('focus', onFocus)
  pollerStarted = false
}

function onFocus() {
  const now = Date.now()

  if (now - lastFocusAt < 5 * 60 * 1000) {
    return
  }

  lastFocusAt = now
  void checkUpdates()
  // Cheap and safe to re-read on every (throttled) focus: the user may have
  // updated Fan from another window/CLI between focuses, and About should
  // catch up without forcing a restart.
  void refreshDesktopVersion()
}
