export interface ConfigFieldSchema {
  category?: string
  description?: string
  options?: unknown[]
  type?: 'boolean' | 'list' | 'number' | 'select' | 'string' | 'text'
}

export interface ConfigSchemaResponse {
  category_order?: string[]
  fields: Record<string, ConfigFieldSchema>
}

interface ElevenLabsVoice {
  label: string
  name: string
  voice_id: string
}

export interface ElevenLabsVoicesResponse {
  available: boolean
  voices: ElevenLabsVoice[]
}

export interface EnvVarInfo {
  advanced: boolean
  category: string
  description: string
  is_password: boolean
  is_set: boolean
  redacted_value: null | string
  tools: string[]
  url: null | string
}

export interface FanConfig {
  agent?: {
    reasoning_effort?: string
    personalities?: Record<string, unknown>
    service_tier?: string
  }
  display?: {
    language?: 'en' | 'zh'
    personality?: string
    skin?: string
  }
  terminal?: {
    cwd?: string
  }
  stt?: {
    enabled?: boolean
  }
  voice?: {
    max_recording_seconds?: number
  }
}

export type FanConfigRecord = Record<string, unknown>

export interface ModelProviderModel {
  id: string
  label: string
}

export interface ModelProviderInfo {
  auth_type: 'api_key' | 'custom' | 'none'
  base_url: string
  configured: boolean
  default_model: string
  description: string
  env_var: string | null
  id: string
  masked_key: string
  models: ModelProviderModel[]
  name: string
  recommended: boolean
  requires_base_url: boolean
}

export interface ModelProvidersResponse {
  configured_model: string | null
  configured_provider: string | null
  providers: ModelProviderInfo[]
}

export interface ModelProviderSavePayload {
  api_key?: string
  base_url?: string
  model?: string
  provider: string
}

export interface ModelProviderSaveResponse {
  configured_model: string
  configured_provider: string
  ok: true
  provider: ModelProviderInfo
  verified: boolean
}

export interface ModelInfoResponse {
  auto_context_length?: number
  capabilities?: Record<string, unknown>
  config_context_length?: number
  effective_context_length?: number
  model: string
  provider: string
}

export interface PaginatedSessions {
  limit: number
  offset: number
  sessions: SessionInfo[]
  total: number
}

export interface RpcEvent<T = unknown> {
  payload?: T
  session_id?: string
  type: string
}

export interface PendingInteraction {
  created_at: number
  event: string
  interaction_epoch?: string
  interaction_revision?: number
  kind: string
  request_id: string
  session_id: string
  status: string
  [key: string]: unknown
}

export interface SessionCreateResponse {
  browser_workbench_id?: string
  info?: SessionRuntimeInfo
  message_count?: number
  messages?: SessionMessage[]
  session_id: string
  stored_session_id?: string
}

export interface SessionInfo {
  archived?: boolean
  browser_workbench_id?: string
  cwd?: null | string
  ended_at: null | number
  id: string
  /** Original root id of a compression chain, when this entry is a projected
   *  continuation tip. Stable across compressions — used as the durable id for
   *  pins so a pinned conversation survives auto-compression. */
  _lineage_root_id?: null | string
  input_tokens: number
  is_active: boolean
  last_active: number
  message_count: number
  model: null | string
  output_tokens: number
  preview: null | string
  source: null | string
  started_at: number
  title: null | string
  tool_call_count: number
}

export interface SessionMessage {
  codex_reasoning_items?: unknown
  content: unknown
  context?: unknown
  finish_reason?: null | string
  name?: string
  reasoning?: null | string
  reasoning_content?: null | string
  reasoning_details?: unknown
  role: 'assistant' | 'system' | 'tool' | 'user'
  text?: unknown
  timestamp?: number
  tool_call_id?: null | string
  tool_calls?: unknown
  tool_name?: string
}

export interface SessionMessagesResponse {
  messages: SessionMessage[]
  session_id: string
}

export interface SessionResumeResponse {
  browser_workbench_id?: string
  info?: SessionRuntimeInfo
  message_count: number
  messages: SessionMessage[]
  pending_interactions?: PendingInteraction[]
  pending_interactions_epoch?: string
  pending_interactions_revision?: number
  resumed: string
  // Gateway truth: the resumed live session still has a turn in flight
  // (server.py _live_session_payload). The view MUST adopt this instead of
  // assuming idle — a renderer reload mid-turn otherwise paints a running
  // session as idle and every send gets rejected with "session busy".
  running?: boolean
  session_id: string
}

export interface SessionRuntimeInfo {
  browser_workbench_id?: string
  branch?: string
  config_warning?: string
  credential_warning?: string
  cwd?: string
  desktop_contract?: number
  fast?: boolean
  model?: string
  personality?: string
  provider?: string
  reasoning_effort?: string
  running?: boolean
  service_tier?: string
  skills?: Record<string, string[]> | string[]
  tools?: Record<string, string[]>
  usage?: Partial<UsageStats>
  version?: string
  yolo?: boolean
}

export interface UsageStats {
  calls: number
  context_max?: number
  context_percent?: number
  context_used?: number
  cost_usd?: number
  input: number
  output: number
  total: number
}

export interface CronJob {
  enabled: boolean
  id: string
  last_error?: null | string
  last_run_at?: null | string
  name?: null | string
  next_run_at?: null | string
  no_agent?: boolean
  prompt?: null | string
  schedule?: CronJobSchedule
  schedule_display?: null | string
  script?: null | string
  state?: null | string
}

export interface CronJobCreatePayload {
  name?: string
  prompt: string
  schedule: string
}

interface CronJobSchedule {
  display?: string
  expr?: string
  kind?: string
}

export interface CronJobUpdates {
  enabled?: boolean
  name?: string
  prompt?: string
  schedule?: string
}

export interface SkillInfo {
  category: string
  created_at?: string | null
  created_by?: string | null
  description: string
  enabled: boolean
  identifier?: string | null
  name: string
  origin?: 'agent' | 'bundled' | 'local'
}

export interface ToolsetInfo {
  configured: boolean
  description: string
  enabled: boolean
  label: string
  name: string
  tools: string[]
}

export interface ToolEnvVar {
  key: string
  prompt: string
  url: string | null
  default: string | null
  is_set: boolean
}

export interface ToolProvider {
  name: string
  badge: string
  tag: string
  env_vars: ToolEnvVar[]
  post_setup: string | null
  /** True when this is the provider currently written to config (mirrors the
   *  CLI `fan tools` active-provider detection). */
  is_active: boolean
}

export interface ToolsetConfig {
  name: string
  has_category: boolean
  providers: ToolProvider[]
  /** Name of the currently active provider, or null if none is configured. */
  active_provider: string | null
}

export interface SessionSearchResult {
  /** Lineage root of the matched conversation. Stable across compression and
   *  used as the durable pin id; falls back to session_id when absent. */
  lineage_root?: string | null
  model: string | null
  role: string | null
  /** Live compression tip of the matched conversation — resume by this id. */
  session_id: string
  session_started: number | null
  snippet: string
  source: string | null
}

export interface SessionSearchResponse {
  results: SessionSearchResult[]
}
