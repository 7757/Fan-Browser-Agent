import type { ChatMessage } from '@/lib/chat-messages'

export interface ContextSuggestion {
  text: string
  display: string
  meta?: string
}

export interface ImageAttachResponse {
  attached?: boolean
  path?: string
  text?: string
  message?: string
}

export interface ImageDetachResponse {
  detached?: boolean
  count?: number
}

export interface SlashExecResponse {
  output?: string
  warning?: string
}

export interface BackgroundStartResponse {
  task_id?: string
}

export interface SessionTitleResponse {
  title?: string
  // Recovery-only: true when persistence is temporarily unavailable and the
  // title was queued for the next completed turn.
  pending?: boolean
  session_key?: string
}

interface ExecCommandDispatchResponse {
  type: 'exec' | 'plugin'
  output?: string
}

interface AliasCommandDispatchResponse {
  type: 'alias'
  target: string
}

interface SkillCommandDispatchResponse {
  type: 'skill'
  name: string
  message?: string
}

interface SendCommandDispatchResponse {
  type: 'send'
  message: string
  notice?: string
}

interface PrefillCommandDispatchResponse {
  type: 'prefill'
  message: string
  notice?: string
}

export type CommandDispatchResponse =
  | ExecCommandDispatchResponse
  | AliasCommandDispatchResponse
  | SkillCommandDispatchResponse
  | SendCommandDispatchResponse
  | PrefillCommandDispatchResponse

export interface ClientSessionState {
  storedSessionId: string | null
  browserWorkbenchId: string | null
  messages: ChatMessage[]
  branch: string
  cwd: string
  busy: boolean
  awaitingResponse: boolean
  streamId: string | null
  sawAssistantPayload: boolean
  pendingBranchGroup: string | null
  interrupted: boolean
  /** A blocking interaction is waiting on the user for this session. Drives
   *  the sidebar "needs input" indicator; cleared when the turn resumes/ends. */
  needsInput: boolean
}
