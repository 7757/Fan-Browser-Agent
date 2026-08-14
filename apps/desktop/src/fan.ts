import { JsonRpcGatewayClient } from '@fan/shared'

import type {
  ConfigSchemaResponse,
  CronJob,
  CronJobCreatePayload,
  CronJobUpdates,
  ElevenLabsVoicesResponse,
  FanConfig,
  FanConfigRecord,
  ModelInfoResponse,
  ModelProviderSavePayload,
  ModelProviderSaveResponse,
  ModelProvidersResponse,
  PaginatedSessions,
  SessionMessagesResponse,
  SkillInfo,
  ToolsetConfig,
  ToolsetInfo
} from '@/types/fan'

const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000
// prompt.submit acknowledges only after the backend accepts a turn. Deep
// reasoning and long tool chains can legitimately exceed ordinary RPC timing.
export const PROMPT_SUBMIT_REQUEST_TIMEOUT_MS = 1_800_000

export type {
  ConfigSchemaResponse,
  CronJob,
  CronJobCreatePayload,
  CronJobUpdates,
  ElevenLabsVoicesResponse,
  FanConfig,
  FanConfigRecord,
  ModelInfoResponse,
  ModelProviderInfo,
  ModelProviderModel,
  ModelProviderSavePayload,
  ModelProviderSaveResponse,
  ModelProvidersResponse,
  PaginatedSessions,
  SessionInfo,
  SessionMessagesResponse,
  SkillInfo,
  ToolsetConfig,
  ToolsetInfo
} from '@/types/fan'

export class FanGateway extends JsonRpcGatewayClient {
  constructor() {
    super({
      closedErrorMessage: 'Fan gateway connection closed',
      connectErrorMessage: 'Could not connect to Fan gateway',
      createRequestId: nextId => nextId,
      notConnectedErrorMessage: 'Fan gateway is not connected',
      requestTimeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS
    })
  }
}

export async function listSessions(
  limit = 40,
  minMessages = 0,
  archived: 'exclude' | 'include' | 'only' = 'exclude',
  order: 'created' | 'recent' = 'recent'
): Promise<PaginatedSessions> {
  const result = await window.fanDesktop.api<PaginatedSessions>({
    path: `/api/sessions?limit=${limit}&offset=0&min_messages=${Math.max(0, minMessages)}&archived=${archived}&order=${order}`
  })

  return {
    ...result,
    sessions: result.sessions.slice(0, limit),
    offset: 0
  }
}

export function setSessionArchived(id: string, archived: boolean): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: `/api/sessions/${encodeURIComponent(id)}`,
    method: 'PATCH',
    body: { archived }
  })
}
export function getSessionMessages(id: string): Promise<SessionMessagesResponse> {
  return window.fanDesktop.api<SessionMessagesResponse>({
    path: `/api/sessions/${encodeURIComponent(id)}/messages`
  })
}

export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: `/api/sessions/${encodeURIComponent(id)}`,
    method: 'DELETE'
  })
}
export function getGlobalModelInfo(): Promise<ModelInfoResponse> {
  return window.fanDesktop.api<ModelInfoResponse>({
    path: '/api/model/info'
  })
}

export function getModelProviders(): Promise<ModelProvidersResponse> {
  return window.fanDesktop.api<ModelProvidersResponse>({
    path: '/api/model/providers'
  })
}

export function saveModelProvider(payload: ModelProviderSavePayload): Promise<ModelProviderSaveResponse> {
  return window.fanDesktop.api<ModelProviderSaveResponse>({
    path: '/api/model/provider',
    method: 'POST',
    body: payload,
    timeoutMs: 60_000
  })
}

export function getFanConfig(): Promise<FanConfig> {
  return window.fanDesktop.api<FanConfig>({
    path: '/api/config'
  })
}

export function getFanConfigRecord(): Promise<FanConfigRecord> {
  return window.fanDesktop.api<FanConfigRecord>({
    path: '/api/config'
  })
}

export function getFanConfigDefaults(): Promise<FanConfigRecord> {
  return window.fanDesktop.api<FanConfigRecord>({
    path: '/api/config/defaults'
  })
}

export function getFanConfigSchema(): Promise<ConfigSchemaResponse> {
  return window.fanDesktop.api<ConfigSchemaResponse>({
    path: '/api/config/schema'
  })
}

export function saveFanConfig(config: FanConfigRecord): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: '/api/config',
    method: 'PUT',
    body: { config }
  })
}
export function setEnvVar(key: string, value: string): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: '/api/env',
    method: 'PUT',
    body: { key, value }
  })
}

export function deleteEnvVar(key: string): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: '/api/env',
    method: 'DELETE',
    body: { key }
  })
}

export function revealEnvVar(key: string): Promise<{ key: string; value: string }> {
  return window.fanDesktop.api<{ key: string; value: string }>({
    path: '/api/env/reveal',
    method: 'POST',
    body: { key }
  })
}

export function getSkills(): Promise<SkillInfo[]> {
  return window.fanDesktop.api<SkillInfo[]>({
    path: '/api/skills'
  })
}

export function toggleSkill(name: string, enabled: boolean): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return window.fanDesktop.api<{ ok: boolean; name: string; enabled: boolean }>({
    path: '/api/skills/toggle',
    method: 'PUT',
    body: { name, enabled }
  })
}

export function getToolsets(): Promise<ToolsetInfo[]> {
  return window.fanDesktop.api<ToolsetInfo[]>({
    path: '/api/tools/toolsets'
  })
}

export function toggleToolset(
  name: string,
  enabled: boolean
): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return window.fanDesktop.api<{ ok: boolean; name: string; enabled: boolean }>({
    path: `/api/tools/toolsets/${encodeURIComponent(name)}`,
    method: 'PUT',
    body: { enabled }
  })
}

export function getToolsetConfig(name: string): Promise<ToolsetConfig> {
  return window.fanDesktop.api<ToolsetConfig>({
    path: `/api/tools/toolsets/${encodeURIComponent(name)}/config`
  })
}

export function selectToolsetProvider(
  name: string,
  provider: string
): Promise<{ ok: boolean; name: string; provider: string }> {
  return window.fanDesktop.api<{ ok: boolean; name: string; provider: string }>({
    path: `/api/tools/toolsets/${encodeURIComponent(name)}/provider`,
    method: 'PUT',
    body: { provider }
  })
}

export function getCronJobs(): Promise<CronJob[]> {
  return window.fanDesktop.api<CronJob[]>({
    path: '/api/cron/jobs'
  })
}
export function createCronJob(body: CronJobCreatePayload): Promise<CronJob> {
  return window.fanDesktop.api<CronJob>({
    path: '/api/cron/jobs',
    method: 'POST',
    body
  })
}

export function updateCronJob(jobId: string, updates: CronJobUpdates): Promise<CronJob> {
  return window.fanDesktop.api<CronJob>({
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}`,
    method: 'PUT',
    body: { updates }
  })
}

export function pauseCronJob(jobId: string): Promise<CronJob> {
  return window.fanDesktop.api<CronJob>({
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/pause`,
    method: 'POST'
  })
}

export function resumeCronJob(jobId: string): Promise<CronJob> {
  return window.fanDesktop.api<CronJob>({
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/resume`,
    method: 'POST'
  })
}

export function triggerCronJob(jobId: string): Promise<CronJob> {
  return window.fanDesktop.api<CronJob>({
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}/trigger`,
    method: 'POST'
  })
}

export function deleteCronJob(jobId: string): Promise<{ ok: boolean }> {
  return window.fanDesktop.api<{ ok: boolean }>({
    path: `/api/cron/jobs/${encodeURIComponent(jobId)}`,
    method: 'DELETE'
  })
}

export function getElevenLabsVoices(): Promise<ElevenLabsVoicesResponse> {
  return window.fanDesktop.api<ElevenLabsVoicesResponse>({
    path: '/api/audio/elevenlabs/voices'
  })
}
