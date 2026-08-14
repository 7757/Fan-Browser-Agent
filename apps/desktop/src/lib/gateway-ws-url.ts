import type { FanConnection } from '@/global'

/**
 * The desktop main process exposes `getGatewayWsUrl()` to re-mint a WebSocket
 * URL immediately before every `gateway.connect()`. The local gateway URL
 * carries a long-lived loopback token and never expires, so re-minting is a
 * cheap parity step: when the preload exposes the method we use the fresh URL,
 * otherwise (or on a transient mint failure) the cached `conn.wsUrl` is a safe
 * fallback.
 */
export interface ResolveGatewayWsUrlDeps {
  /** `window.fanDesktop.getGatewayWsUrl`, if the preload exposes it. */
  getGatewayWsUrl?: () => Promise<string>
}

export async function resolveGatewayWsUrl(
  desktop: ResolveGatewayWsUrlDeps,
  conn: Pick<FanConnection, 'wsUrl'>
): Promise<string> {
  const mint = desktop.getGatewayWsUrl

  // The local URL carries a long-lived token. Re-mint when available (cheap,
  // keeps parity), but the cached URL is a safe fallback.
  if (mint) {
    const fresh = await mint().catch(() => null)

    if (fresh) {
      return fresh
    }
  }

  return conn.wsUrl
}
