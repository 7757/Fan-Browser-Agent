import type { ConnectionState } from '@fan/shared'
import { atom } from 'nanostores'

import type { FanGateway } from '@/fan'
import { setGatewayState } from '@/store/session'

// ── Single (window) gateway ────────────────────────────────────────────────
// The desktop always uses the one default backend, reached over the local
// ws://127.0.0.1 connection minted by the Electron main process. There is a
// single live gateway socket, owned by use-gateway-boot (with all its
// boot-progress / sleep-wake machinery). This store exposes that socket to
// inline components and mirrors its connection state into the composer.

// The live gateway instance, exposed for inline message-stream components
// (e.g. inline CollectTool, model overlays) that call gateway methods without
// the instance threaded down through props.
export const $gateway = atom<FanGateway | null>(null)

// Record the live (window) gateway and reflect its state into the composer.
export function setPrimaryGateway(gateway: FanGateway | null): void {
  $gateway.set(gateway)
  setGatewayState(gateway?.connectionState ?? 'closed')
}

// Mirror the primary backend's connection state into the global composer state.
export function reportPrimaryGatewayState(state: ConnectionState): void {
  setGatewayState(state)
}
