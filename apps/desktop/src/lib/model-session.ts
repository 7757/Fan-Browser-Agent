import {
  $availableModels,
  $currentModel,
  type ModelOption,
  setAvailableModels,
  setCurrentModel
} from '@/store/session'

import type { GatewayRequester } from './yolo-session'

interface FetchAvailableModelsOptions {
  refresh?: boolean
}

interface ModelsListResponse {
  models?: ModelOption[]
  default?: string
  current?: string
}

// An explicit refresh is user-driven and may be triggered twice before React
// has painted the button's disabled state. Keep one shared request in flight so
// every caller observes the same model snapshot.
let refreshModelsInFlight: Promise<ModelOption[]> | null = null

/**
 * Resolve the model shown by the composer picker. Before a runtime session
 * exists, a locally pending choice is authoritative: gateway reconnects and
 * config refreshes may report the profile default, but must not make the draft
 * selection appear to have been lost. Once a session exists its live model is
 * authoritative and the pending draft value is ignored.
 */
export function resolveComposerModel(
  sessionId: string | null | undefined,
  pendingModel: string,
  currentModel: string,
  models: ModelOption[]
): string {
  return (!sessionId && pendingModel) || currentModel || models[0]?.id || ''
}

/**
 * Fetch selectable brain LLMs and their locally resolved capabilities from the
 * gateway `models.list` RPC. Vision-capable models may be selected directly;
 * text brains use the configured vision model as an auxiliary path.
 */
export async function fetchAvailableModels(
  requestGateway: GatewayRequester,
  sessionId?: string | null,
  options: FetchAvailableModelsOptions = {}
): Promise<ModelOption[]> {
  const refresh = options.refresh === true

  if (!refresh && $availableModels.get().length > 0) {
    return $availableModels.get()
  }

  if (refresh && refreshModelsInFlight) {
    return refreshModelsInFlight
  }

  const load = async (): Promise<ModelOption[]> => {
    const params: Record<string, unknown> = sessionId ? { session_id: sessionId } : {}
    if (refresh) {
      params.refresh = true
    }

    const result = await requestGateway<ModelsListResponse>('models.list', params)

    const models = Array.isArray(result?.models)
      ? result.models.filter((m): m is ModelOption => Boolean(m && m.id))
      : []

    if (refresh && models.length === 0) {
      throw new Error('模型列表刷新失败，请稍后重试')
    }

    if (models.length > 0) {
      // Replace the complete validated snapshot in one store update.  Nothing
      // is cleared before the RPC, so a rejected refresh leaves the old list and
      // active/default selection untouched.
      setAvailableModels(models)
    }

    // On a fresh chat the global config model is '' (use-default), so
    // /api/model/info reports no model and $currentModel stays empty — which used
    // to hide the switcher chip until the first turn populated it. Seed the
    // gateway's reported model so the chip shows (and is pickable) before the
    // first message; a real session model later overwrites this. Prefer `current`
    // (the handler's resolved session/global model) over `default` so the seed
    // matches what a turn would actually use.
    const seed = result?.current || result?.default
    if (seed && !$currentModel.get()) {
      setCurrentModel(seed)
    }

    return models
  }

  if (!refresh) {
    return load()
  }

  const flight = load()
  refreshModelsInFlight = flight
  void flight.then(
    () => {
      if (refreshModelsInFlight === flight) {
        refreshModelsInFlight = null
      }
    },
    () => {
      if (refreshModelsInFlight === flight) {
        refreshModelsInFlight = null
      }
    }
  )

  return flight
}

/**
 * Switch the brain (reasoning) LLM for a session via gateway `config.set` — the
 * same per-session, in-memory scope as the YOLO flag. Reflects the gateway's applied value into
 * `$currentModel` so the chip updates immediately.
 */
export async function setSessionModel(
  requestGateway: GatewayRequester,
  sessionId: string,
  modelId: string
): Promise<string> {
  const result = await requestGateway<{ value?: string }>('config.set', {
    key: 'model',
    session_id: sessionId,
    value: modelId
  })

  const applied = result?.value || modelId

  setCurrentModel(applied)

  return applied
}
