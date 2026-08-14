import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef } from 'react'

import type { FanGateway } from '@/fan'
import { resolveGatewayWsUrl } from '@/lib/gateway-ws-url'
import { $gateway } from '@/store/gateway'
import { $gatewayState, setConnection } from '@/store/session'

export function useGatewayRequest() {
  const gatewayState = useStore($gatewayState)
  const gatewayRef = useRef<FanGateway | null>(null)

  const connectionRef = useRef<Awaited<ReturnType<NonNullable<typeof window.fanDesktop>['getConnection']>> | null>(
    null
  )

  const gatewayStateRef = useRef(gatewayState)
  const reconnectingRef = useRef<Promise<FanGateway | null> | null>(null)

  useEffect(() => {
    gatewayStateRef.current = gatewayState
  }, [gatewayState])

  // Track the live gateway so outbound requests and overlay props always target
  // the current socket.
  useEffect(
    () =>
      $gateway.subscribe(gateway => {
        gatewayRef.current = gateway as FanGateway | null
      }),
    []
  )

  const ensureGatewayOpen = useCallback(async () => {
    const existing = gatewayRef.current

    if (!existing) {
      return null
    }

    if (gatewayStateRef.current === 'open') {
      return existing
    }

    if (reconnectingRef.current) {
      return reconnectingRef.current
    }

    reconnectingRef.current = (async () => {
      const desktop = window.fanDesktop

      if (!desktop) {
        return null
      }

      try {
        // Reconnect to the single (window) backend so a sleep/wake reconnect
        // brings the live socket back.
        const conn = await desktop.getConnection()
        connectionRef.current = conn
        setConnection(conn)
        // Re-mint the WS URL before reconnecting. The local URL carries a
        // long-lived token, so this is a cheap parity step; the cached
        // conn.wsUrl is a safe fallback when the mint is unavailable.
        const wsUrl = await resolveGatewayWsUrl(desktop, conn)
        await existing.connect(wsUrl)

        return existing
      } catch {
        connectionRef.current = null
        setConnection(null)

        return null
      } finally {
        reconnectingRef.current = null
      }
    })()

    return reconnectingRef.current
  }, [])

  const requestGateway = useCallback(
    async <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => {
      const gateway = gatewayRef.current

      if (!gateway) {
        throw new Error('Fan gateway unavailable')
      }

      try {
        return await gateway.request<T>(method, params, timeoutMs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (!/not connected|connection closed/i.test(message)) {
          throw error
        }

        // Re-mint the single backend's local WS URL and reconnect.
        const recovered = await ensureGatewayOpen()

        if (!recovered) {
          throw error
        }

        return recovered.request<T>(method, params, timeoutMs)
      }
    },
    [ensureGatewayOpen]
  )

  return { connectionRef, gatewayRef, requestGateway }
}
