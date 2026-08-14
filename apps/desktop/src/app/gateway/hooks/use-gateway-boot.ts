import { useEffect, useRef } from 'react'

import { FanGateway } from '@/fan'
import type { FanConnection } from '@/global'
import { resolveGatewayWsUrl } from '@/lib/gateway-ws-url'
import {
  $desktopBoot,
  applyDesktopBootProgress,
  completeDesktopBoot,
  failDesktopBoot,
  setDesktopBootStep
} from '@/store/boot'
import { reportPrimaryGatewayState, setPrimaryGateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $connection, setConnection, setSessionsLoading } from '@/store/session'
import type { RpcEvent } from '@/types/fan'

interface GatewayBootOptions {
  handleGatewayEvent: (event: RpcEvent) => void
  onConnectionReady: (
    connection: Awaited<ReturnType<NonNullable<typeof window.fanDesktop>['getConnection']>> | null
  ) => void
  onGatewayReady: (gateway: FanGateway | null) => void
  refreshFanConfig: () => Promise<void>
  refreshSessions: () => Promise<void>
}

export function useGatewayBoot({
  handleGatewayEvent,
  onConnectionReady,
  onGatewayReady,
  refreshFanConfig,
  refreshSessions
}: GatewayBootOptions) {
  const callbacksRef = useRef({
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshFanConfig,
    refreshSessions
  })

  callbacksRef.current = {
    handleGatewayEvent,
    onConnectionReady,
    onGatewayReady,
    refreshFanConfig,
    refreshSessions
  }

  useEffect(() => {
    let cancelled = false
    const desktop = window.fanDesktop

    const publish = (next: FanConnection | null) => {
      callbacksRef.current.onConnectionReady(next)
      setConnection(next)
    }

    if (!desktop) {
      failDesktopBoot('桌面 IPC 通信桥不可用。')
      setSessionsLoading(false)

      return () => void (cancelled = true)
    }

    // --- Reconnect-after-sleep machinery -------------------------------------
    // macOS sleep silently drops the renderer's WebSocket. The backend Python
    // process keeps running, but nothing re-opened the socket on wake, so the
    // composer stayed disabled forever on "Starting Fan...". Once the
    // initial boot succeeds we treat any non-open state as recoverable and
    // reconnect with backoff, and we nudge a reconnect on the OS/browser
    // signals that fire around wake (power resume, network online, the window
    // becoming visible).
    let bootCompleted = false
    let reconnecting = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0

    // Wrap the live getter in a call so TS control-flow analysis doesn't narrow
    // `connectionState` to a constant across the early-return guards (the state
    // genuinely changes between reads).
    const gatewayOpen = () => gateway.connectionState === 'open'

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const attemptReconnect = async () => {
      if (cancelled || reconnecting || gatewayOpen()) {
        return
      }

      reconnecting = true

      try {
        const conn = await desktop.getConnection()

        if (cancelled) {
          return
        }

        publish(conn)
        // Re-mint the WS URL before reconnecting. The local URL carries a
        // long-lived token, so the re-mint is a cheap no-op that keeps parity
        // with the initial boot; the cached conn.wsUrl is a safe fallback.
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled) {
          return
        }

        reconnectAttempt = 0
        // Resync state that may have moved on the backend while we were asleep.
        await callbacksRef.current.refreshFanConfig().catch(() => undefined)
        await callbacksRef.current.refreshSessions().catch(() => undefined)
      } catch {
        // Transport failure mid-reconnect: fall through to the backoff in the
        // finally block below and try again.
      } finally {
        reconnecting = false

        if (!cancelled && !gatewayOpen()) {
          scheduleReconnect()
        }
      }
    }

    function scheduleReconnect() {
      if (cancelled || reconnecting || reconnectTimer !== null || gatewayOpen()) {
        return
      }

      // 1s, 2s, 4s … capped at 15s.
      const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4))
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void attemptReconnect()
      }, delay)
    }

    const reconnectNow = () => {
      if (cancelled || !bootCompleted) {
        return
      }

      clearReconnectTimer()
      reconnectAttempt = 0

      if (!gatewayOpen()) {
        void attemptReconnect()
      }
    }

    const offBootProgress = desktop.onBootProgress(payload => applyDesktopBootProgress(payload))
    void desktop
      .getBootProgress()
      .then(snapshot => applyDesktopBootProgress(snapshot))
      .catch(() => undefined)

    setDesktopBootStep({
      phase: 'renderer.boot',
      message: '正在启动桌面连接',
      progress: 6
    })

    const gateway = new FanGateway()
    callbacksRef.current.onGatewayReady(gateway)
    setPrimaryGateway(gateway)

    const offState = gateway.onState(st => {
      reportPrimaryGatewayState(st)

      if (st === 'open') {
        reconnectAttempt = 0
        clearReconnectTimer()
      } else if (bootCompleted && (st === 'closed' || st === 'error')) {
        // The socket dropped after a healthy boot (typically sleep/wake). Try
        // to bring it back instead of leaving the composer stuck disabled.
        scheduleReconnect()
      }
    })

    const offEvent = gateway.onEvent(event => callbacksRef.current.handleGatewayEvent(event))

    // Wake signals: power resume (macOS/Windows), network coming back, and the
    // window regaining focus/visibility. Each nudges an immediate reconnect.
    const offPowerResume = desktop.onPowerResume?.(() => reconnectNow())

    const onOnline = () => reconnectNow()

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reconnectNow()
      }
    }

    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)

    const offWindowState = desktop.onWindowStateChanged?.(payload => {
      const current = $connection.get()

      if (current) {
        publish({ ...current, ...payload })
      }
    })

    const offExit = desktop.onBackendExit(() => {
      if ($desktopBoot.get().running || $desktopBoot.get().visible) {
        failDesktopBoot('Fan 后台进程在启动过程中退出。')
      }

      notify({
        kind: 'error',
        title: '后端已停止',
        message: 'Fan 后台进程已退出。',
        durationMs: 0
      })
    })

    async function boot() {
      try {
        const conn = await desktop.getConnection()

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.gateway.connect',
          message: '正在连接桌面网关',
          progress: 95
        })
        publish(conn)
        // Mint a fresh WS URL right before connecting. The local URL carries a
        // long-lived token, so this is a cheap parity step over the cached
        // conn.wsUrl (which is a safe fallback when the mint is unavailable).
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await gateway.connect(wsUrl)

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.config',
          message: '正在加载 Fan 设置',
          progress: 97
        })
        await callbacksRef.current.refreshFanConfig()

        if (cancelled) {
          return
        }

        setDesktopBootStep({
          phase: 'renderer.sessions',
          message: '正在加载最近会话',
          progress: 99
        })
        await callbacksRef.current.refreshSessions()
        completeDesktopBoot()
        bootCompleted = true
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err)
          failDesktopBoot(message)
          notifyError(err, '桌面启动失败')
          setSessionsLoading(false)
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
      clearReconnectTimer()
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      offPowerResume?.()
      offState()
      offEvent()
      offExit()
      offWindowState?.()
      offBootProgress()
      gateway.close()
      publish(null)
      callbacksRef.current.onGatewayReady(null)
      setPrimaryGateway(null)
    }
  }, [])
}
