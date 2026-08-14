import { atom } from 'nanostores'

import { getModelProviders } from '@/fan'
import type { ModelProviderInfo, ModelProviderSaveResponse, ModelProvidersResponse } from '@/types/fan'

export type ModelProviderSetupPhase = 'error' | 'idle' | 'loading' | 'ready'

export interface ModelProviderSetupState {
  error: string | null
  phase: ModelProviderSetupPhase
  response: ModelProvidersResponse | null
}

export const $modelProviderSetup = atom<ModelProviderSetupState>({
  error: null,
  phase: 'idle',
  response: null
})

let activeRefresh: Promise<ModelProvidersResponse> | null = null
let refreshVersion = 0

export function modelProviderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const payload = raw.replace(/^\d{3}:\s*/, '').trim()

  try {
    const parsed = JSON.parse(payload) as { detail?: unknown }

    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim()
    }
  } catch {
    // The desktop bridge also emits plain connection/timeout messages.
  }

  return payload || '无法读取本机模型提供商配置。'
}

export function invalidateModelProviderSetup() {
  refreshVersion += 1
  activeRefresh = null
  $modelProviderSetup.set({ error: null, phase: 'idle', response: null })
}

export function setModelProvidersResponse(response: ModelProvidersResponse) {
  $modelProviderSetup.set({ error: null, phase: 'ready', response })
}

export function applySavedModelProvider(result: ModelProviderSaveResponse) {
  const previous = $modelProviderSetup.get().response
  const providers: ModelProviderInfo[] = previous
    ? previous.providers.some(provider => provider.id === result.provider.id)
      ? previous.providers.map(provider => (provider.id === result.provider.id ? result.provider : provider))
      : [...previous.providers, result.provider]
    : [result.provider]

  setModelProvidersResponse({
    configured_model: result.configured_model,
    configured_provider: result.configured_provider,
    providers
  })
}

export function refreshModelProviders(): Promise<ModelProvidersResponse> {
  if (activeRefresh) {
    return activeRefresh
  }

  // A fresh gateway connection must re-establish provider readiness before any
  // renderer-side session resume can initialize an agent. Do not let a status
  // cached from the previous backend process keep the gate open.
  $modelProviderSetup.set({ error: null, phase: 'loading', response: null })
  const version = ++refreshVersion

  const request = getModelProviders()
    .then(response => {
      if (version === refreshVersion) {
        setModelProvidersResponse(response)
      }

      return response
    })
    .catch(error => {
      if (version === refreshVersion) {
        $modelProviderSetup.set({
          error: modelProviderErrorMessage(error),
          phase: 'error',
          response: null
        })
      }

      throw error
    })
    .finally(() => {
      if (activeRefresh === request) {
        activeRefresh = null
      }
    })

  activeRefresh = request

  return request
}
