import type { QueryClient } from '@tanstack/react-query'
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react'

import {
  appendReasoningPart,
  applyStreamSegments,
  assistantTextPart,
  type ChatMessage,
  type ChatMessagePart,
  chatMessageText,
  finalizeAssistantTextParts,
  type GatewayEventPayload,
  pushStreamSegment,
  type QueuedStreamSegment,
  reasoningPart,
  renderMediaTags,
  type StreamDeltaKind,
  textPart,
  upsertToolPart
} from '@/lib/chat-messages'
import { coerceGatewayText, coerceThinkingText, normalizePersonalityValue } from '@/lib/chat-runtime'
import { gatewayEventRequiresSessionId } from '@/lib/gateway-events'
import { triggerHaptic } from '@/lib/haptics'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { userFacingErrorMessage } from '@/lib/user-facing-error'
import { parseCollectContent, setCollectRequest } from '@/store/collect'
import { notify } from '@/store/notifications'
import {
  acceptPendingInteractionRequest,
  clearPendingInteractions,
  hasPendingInteraction,
  resolvePendingInteraction
} from '@/store/pending-interactions'
import {
  clearControlRequest,
  clearSecretRequest,
  clearSudoRequest,
  setApprovalRequest,
  setControlRequest,
  setSecretRequest,
  setSudoRequest,
  setVerificationRequest
} from '@/store/prompts'
import {
  $activeBrowserWorkbenchId,
  setActiveBrowserWorkbenchId,
  setCurrentBranch,
  setCurrentCwd,
  setCurrentFastMode,
  setCurrentModel,
  setCurrentPersonality,
  setCurrentProvider,
  setCurrentServiceTier,
  setCurrentUsage,
  setYoloActive
} from '@/store/session'
import { clearSessionSubagents, pruneDelegateFallbackSubagents, upsertSubagent } from '@/store/subagents'
import { recordToolDiff } from '@/store/tool-diffs'
import type { RpcEvent } from '@/types/fan'

import type { ClientSessionState } from '../../types'

interface MessageStreamOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  hydrateFromStoredSession: (
    attempts?: number,
    storedSessionId?: string | null,
    runtimeSessionId?: string | null
  ) => Promise<void>
  queryClient: QueryClient
  refreshFanConfig: () => Promise<void>
  refreshSessions: () => Promise<void>
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

// Minimum gap between two assistant-text flushes during a stream. Was 16ms
// (rAF only), which at typical LLM token rates of ~30-80 tok/sec meant every
// token got its own React commit + Streamdown markdown re-parse, scaling
// linearly with the growing last-block length. Bumping to 33ms lets ~2 tokens
// batch into one commit at 60 tok/sec without introducing visible lag on the
// streaming text (still 30 fps of visible text growth). Big perceived
// smoothness win on long messages with big trailing paragraphs.
const STREAM_DELTA_FLUSH_MS = 33

// Gateway/provider failures sometimes arrive as message.complete text instead
// of an explicit error event. Treat matches as inline assistant errors so they
// persist like real error events and don't get erased by hydrate fallback.
const COMPLETION_ERROR_PATTERNS = [
  /^API call failed after \d+ retries:/i,
  /^HTTP\s+\d{3}\b/i,
  /^(Provider|Gateway)\s+error:/i
]

function completionErrorText(finalText: string): string | null {
  const text = finalText.trim()

  return text && COMPLETION_ERROR_PATTERNS.some(re => re.test(text)) ? text : null
}

const SUBAGENT_EVENT_TYPES = new Set([
  'subagent.spawn_requested',
  'subagent.start',
  'subagent.thinking',
  'subagent.tool',
  'subagent.progress',
  'subagent.complete'
])

// Anonymous progress events that carry todos but no name still belong to the
// todo stream; named todo events are obviously routed there too.
function toTodoPayload(payload: GatewayEventPayload | undefined): GatewayEventPayload | undefined {
  if (!payload) {
    return undefined
  }

  const isTodo = payload.name === 'todo' || (!payload.name && Object.hasOwn(payload, 'todos'))

  return isTodo ? { ...payload, name: 'todo', tool_id: payload.tool_id || 'todo-live' } : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function parseMaybeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return {}
    }
  }

  return asRecord(value)
}

const firstString = (...candidates: unknown[]): string => {
  for (const v of candidates) {
    if (typeof v === 'string' && v) {
      return v
    }
  }

  return ''
}

function stableToolCallId(payload: GatewayEventPayload | undefined): string {
  return payload?.tool_id || payload?.tool_call_id || payload?.id || ''
}

function delegateTaskPayloads(
  payload: GatewayEventPayload | undefined,
  phase: 'running' | 'complete',
  sourceEventType?: string
): Record<string, unknown>[] {
  if (payload?.name !== 'delegate_task') {
    return []
  }

  const args = parseMaybeRecord(payload.args ?? payload.input)
  const result = parseMaybeRecord(payload.result)
  const rawTasks = Array.isArray(args.tasks) ? args.tasks : []
  const tasks = rawTasks.length ? rawTasks.map(parseMaybeRecord) : [args]
  const status = phase === 'complete' ? (payload.error ? 'failed' : 'completed') : 'running'
  const toolId = payload.tool_id || payload.tool_call_id || payload.id || 'delegate_task'
  const progressText = firstString(payload.preview, payload.message, payload.context)

  const eventType =
    phase === 'complete'
      ? 'subagent.complete'
      : sourceEventType === 'tool.start'
        ? 'subagent.start'
        : 'subagent.progress'

  return tasks.map((task, index) => {
    const goal = firstString(task.goal, args.goal, payload.context) || 'Delegated task'
    const summary = firstString(result.summary, payload.summary, payload.message)

    return {
      depth: 0,
      duration_seconds: payload.duration_s,
      goal,
      status,
      subagent_id: `delegate-tool:${toolId}:${index}`,
      summary: summary || undefined,
      task_count: tasks.length,
      task_index: index,
      text: eventType === 'subagent.progress' ? progressText || goal : undefined,
      tool_name: eventType === 'subagent.start' ? 'delegate_task' : undefined,
      tool_preview: eventType === 'subagent.start' ? progressText : undefined,
      toolsets: Array.isArray(task.toolsets) ? task.toolsets : Array.isArray(args.toolsets) ? args.toolsets : [],
      event_type: eventType,
      output_tail:
        phase === 'complete' && summary
          ? [{ is_error: Boolean(payload.error), preview: summary, tool: 'delegate_task' }]
          : undefined
    }
  })
}

export function useMessageStream({
  activeSessionIdRef,
  hydrateFromStoredSession,
  queryClient,
  refreshFanConfig,
  refreshSessions,
  updateSessionState
}: MessageStreamOptions) {
  // Patch the in-flight assistant message (or seed it). Centralises the
  // streamId/groupId bookkeeping every event callback would otherwise repeat.
  const mutateStream = useCallback(
    (
      sessionId: string,
      transform: (parts: ChatMessagePart[], message: ChatMessage) => ChatMessagePart[],
      seed: () => ChatMessagePart[],
      opts: {
        pending?: (message: ChatMessage) => boolean
      } = {}
    ) => {
      const apply = () => {
        updateSessionState(sessionId, state => {
          // After a stop, drop any late deltas / tool events for the
          // cancelled turn so they don't keep growing the (now finalized)
          // assistant bubble or, worse, seed a brand-new bubble that
          // appears to belong to the next user message.
          if (state.interrupted) {
            return state
          }

          const streamId = state.streamId ?? `assistant-stream-${Date.now()}`
          const groupId = state.pendingBranchGroup ?? undefined
          const prev = state.messages
          let nextMessages: ChatMessage[]

          if (!prev.some(m => m.id === streamId)) {
            nextMessages = [
              ...prev,
              {
                id: streamId,
                role: 'assistant',
                parts: seed(),
                pending: true,
                branchGroupId: groupId
              }
            ]
          } else {
            nextMessages = prev.map(m =>
              m.id === streamId
                ? {
                    ...m,
                    parts: transform(m.parts, m),
                    pending: opts.pending ? opts.pending(m) : true
                  }
                : m
            )
          }

          return {
            ...state,
            messages: nextMessages,
            streamId,
            sawAssistantPayload: true,
            awaitingResponse: false
          }
        })
      }

      apply()
    },
    [updateSessionState]
  )

  const queuedDeltasRef = useRef<Map<string, QueuedStreamSegment[]>>(new Map())
  const flushHandleRef = useRef<number | null>(null)
  const lastFlushAtRef = useRef<number>(0)
  const nativeSubagentSessionsRef = useRef<Set<string>>(new Set())

  const flushQueuedDeltas = useCallback(
    (sessionId?: string) => {
      const queue = queuedDeltasRef.current
      const ids = sessionId ? [sessionId] : [...queue.keys()]

      for (const id of ids) {
        const segments = queue.get(id)

        if (!segments?.length) {
          continue
        }

        queue.delete(id)

        // Replay buffered reasoning/text segments in arrival order (one state
        // update for the whole window). applyStreamSegments coalesces a leading
        // reasoning segment into the existing trailing reasoning part, so a
        // continuous thought stays a single reasoning part across flushes.
        mutateStream(
          id,
          parts => applyStreamSegments(parts, segments),
          () => applyStreamSegments([], segments)
        )
      }
    },
    [mutateStream]
  )

  const scheduleDeltaFlush = useCallback(() => {
    if (flushHandleRef.current !== null) {
      return
    }

    if (typeof window === 'undefined') {
      flushQueuedDeltas()

      return
    }

    // Enforce a floor on the gap between two flushes. Without it, an LLM
    // emitting tokens slower than the rAF cadence (~30-80 tok/sec is typical)
    // forces one React commit + Streamdown re-parse per token, and the
    // last-block markdown re-parse cost is roughly linear in current block
    // length. With this floor, slower streams still coalesce ~2 tokens per
    // commit and the synthetic harness shows longtask counts drop from ~5/5s
    // to ~1/5s on big sessions.
    const sinceLast = performance.now() - lastFlushAtRef.current

    const runFlush = () => {
      flushHandleRef.current = null
      lastFlushAtRef.current = performance.now()
      flushQueuedDeltas()
    }

    if (sinceLast >= STREAM_DELTA_FLUSH_MS && typeof window.requestAnimationFrame === 'function') {
      flushHandleRef.current = window.requestAnimationFrame(runFlush)

      return
    }

    flushHandleRef.current = window.setTimeout(runFlush, Math.max(0, STREAM_DELTA_FLUSH_MS - sinceLast))
  }, [flushQueuedDeltas])

  const queueDelta = useCallback(
    (sessionId: string, kind: StreamDeltaKind, delta: string) => {
      if (!delta) {
        return
      }

      const segments = queuedDeltasRef.current.get(sessionId) ?? []
      pushStreamSegment(segments, kind, delta)
      queuedDeltasRef.current.set(sessionId, segments)
      scheduleDeltaFlush()
    },
    [scheduleDeltaFlush]
  )

  useEffect(
    () => () => {
      if (flushHandleRef.current !== null && typeof window !== 'undefined') {
        if (typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(flushHandleRef.current)
        } else {
          window.clearTimeout(flushHandleRef.current)
        }
      }

      flushHandleRef.current = null
      flushQueuedDeltas()
    },
    [flushQueuedDeltas]
  )

  const appendAssistantDelta = useCallback(
    (sessionId: string, delta: string) => {
      if (!delta) {
        return
      }

      queueDelta(sessionId, 'assistant', delta)
    },
    [queueDelta]
  )

  const appendReasoningDelta = useCallback(
    (sessionId: string, delta: string, replace = false) => {
      if (!delta) {
        return
      }

      if (!replace) {
        queueDelta(sessionId, 'reasoning', delta)

        return
      }

      flushQueuedDeltas(sessionId)

      mutateStream(
        sessionId,
        (parts, message) => {
          if (replace && chatMessageText(message).trim()) {
            return parts
          }

          if (replace) {
            return [...parts.filter(part => part.type !== 'reasoning'), reasoningPart(delta)]
          }

          return appendReasoningPart(parts, delta)
        },
        () => [reasoningPart(delta)]
      )
    },
    [flushQueuedDeltas, mutateStream, queueDelta]
  )

  const upsertToolCall = useCallback(
    (
      sessionId: string,
      payload: GatewayEventPayload | undefined,
      phase: 'running' | 'complete',
      sourceEventType?: string
    ) => {
      if (!nativeSubagentSessionsRef.current.has(sessionId)) {
        for (const subagentPayload of delegateTaskPayloads(payload, phase, sourceEventType)) {
          upsertSubagent(
            sessionId,
            subagentPayload,
            true,
            phase === 'complete' ? 'delegate.complete' : 'delegate.running'
          )
        }
      }

      updateSessionState(sessionId, state => {
        if (state.interrupted) {
          return state
        }

        const stableId = stableToolCallId(payload)

        const stableMessage = stableId
          ? (() => {
              let turnStart = -1

              for (let index = state.messages.length - 1; index >= 0; index -= 1) {
                if (state.messages[index].role === 'user') {
                  turnStart = index

                  break
                }
              }

              return state.messages
                .slice(turnStart + 1)
                .find(message =>
                  message.parts.some(
                    part => part.type === 'tool-call' && part.toolCallId === stableId
                  )
                )
            })()
          : undefined

        const targetId = stableMessage?.id ?? state.streamId ?? `assistant-stream-${Date.now()}`
        const existingTarget = state.messages.some(message => message.id === targetId)
        const branchGroupId = state.pendingBranchGroup ?? undefined

        const messages = existingTarget
          ? state.messages.map(message =>
              message.id === targetId
                ? {
                    ...message,
                    parts: upsertToolPart(message.parts, payload, phase),
                    pending: phase !== 'complete' || (message.pending ?? false)
                  }
                : message
            )
          : [
              ...state.messages,
              {
                id: targetId,
                role: 'assistant' as const,
                parts: upsertToolPart([], payload, phase),
                pending: true,
                branchGroupId
              }
            ]

        return {
          ...state,
          messages,
          // A hot reload can restore a pending tool call without restoring its
          // streamId. Continue that exact tool's assistant turn instead of
          // creating a second card for the same stable tool-call ID.
          streamId: state.streamId ?? targetId,
          sawAssistantPayload: true,
          awaitingResponse: false
        }
      })
    },
    [updateSessionState]
  )

  const completeAssistantMessage = useCallback(
    (sessionId: string, text: string) => {
      let shouldHydrate = false

      const completedState = updateSessionState(sessionId, state => {
        // Late completion from an already-cancelled turn: cancelRun has
        // already finalized the bubble and added the [interrupted] marker;
        // re-running the dedupe below would erase that marker and replace
        // the partial with the (just-cancelled) full text.
        if (state.interrupted) {
          return state
        }

        const streamId = state.streamId
        const finalText = renderMediaTags(text).trim()
        const completionError = completionErrorText(finalText)

        const completeMessage = (message: ChatMessage): ChatMessage =>
          completionError
            ? {
                ...message,
                error: completionError,
                parts: message.parts.filter(part => part.type !== 'text'),
                pending: false
              }
            : {
                ...message,
                parts: finalizeAssistantTextParts(message.parts, finalText),
                pending: false
              }

        const newAssistantFromCompletion = (): ChatMessage => ({
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          parts: completionError ? [] : [assistantTextPart(finalText)],
          branchGroupId: state.pendingBranchGroup ?? undefined,
          ...(completionError && { error: completionError })
        })

        const prev = state.messages
        let nextMessages = prev

        if (streamId && prev.some(m => m.id === streamId)) {
          nextMessages = prev.map(m => (m.id === streamId ? completeMessage(m) : m))
        } else {
          const fallbackIndex = [...prev]
            .reverse()
            .findIndex(message => message.role === 'assistant' && !message.hidden)

          if (fallbackIndex >= 0) {
            const index = prev.length - 1 - fallbackIndex
            const existing = prev[index]
            const existingText = chatMessageText(existing).trim()

            if (existing.pending || (finalText && existingText === finalText)) {
              nextMessages = prev.map((message, messageIndex) =>
                messageIndex === index ? completeMessage(message) : message
              )
            } else if (finalText) {
              nextMessages = [...prev, newAssistantFromCompletion()]
            }
          } else if (finalText) {
            nextMessages = [...prev, newAssistantFromCompletion()]
          }
        }

        const hasInlineError = nextMessages.some(m => m.role === 'assistant' && m.error && !m.hidden)
        const lastVisible = [...nextMessages].reverse().find(m => !m.hidden)
        const unresolvedUserTail = lastVisible?.role === 'user'
        shouldHydrate =
          !completionError && !hasInlineError && !unresolvedUserTail && (!state.sawAssistantPayload || !finalText)

        return {
          ...state,
          messages: nextMessages,
          streamId: null,
          pendingBranchGroup: null,
          awaitingResponse: false,
          busy: false,
          needsInput: false
        }
      })

      void refreshSessions().catch(() => undefined)

      if (shouldHydrate) {
        void hydrateFromStoredSession(3, completedState.storedSessionId, sessionId)
      }

      if (document.hidden && sessionId === activeSessionIdRef.current) {
        void window.fanDesktop?.notify({
          title: 'Fan 已完成',
          body: text.slice(0, 140) || '响应已就绪。'
        })
      }
    },
    [activeSessionIdRef, hydrateFromStoredSession, refreshSessions, updateSessionState]
  )

  const failAssistantMessage = useCallback(
    (sessionId: string, errorMessage: string) => {
      updateSessionState(sessionId, state => {
        const streamId = state.streamId ?? `assistant-error-${Date.now()}`
        const groupId = state.pendingBranchGroup ?? undefined
        const prev = state.messages
        const error = errorMessage.trim() || 'Fan 报告了一个错误'

        const nextMessages = prev.some(m => m.id === streamId)
          ? prev.map(message =>
              message.id === streamId
                ? {
                    ...message,
                    error,
                    pending: false
                  }
                : message
            )
          : [
              ...prev,
              {
                id: streamId,
                role: 'assistant' as const,
                parts: [],
                error,
                pending: false,
                branchGroupId: groupId
              }
            ]

        return {
          ...state,
          messages: nextMessages,
          streamId: null,
          pendingBranchGroup: null,
          sawAssistantPayload: true,
          awaitingResponse: false,
          busy: false,
          needsInput: false
        }
      })
    },
    [updateSessionState]
  )

  const handleGatewayEvent = useCallback(
    (event: RpcEvent) => {
      const payload = event.payload as GatewayEventPayload | undefined
      const explicitSid = event.session_id || ''

      // An unscoped subagent.* event is background/async work that must never
      // attach to whichever chat is focused — drop it. Other unscoped events
      // (message/reasoning/tool/status) are the active turn's own output and
      // fall back to the active session below.
      if (!explicitSid && gatewayEventRequiresSessionId(event.type)) {
        return
      }

      const sessionId = explicitSid || activeSessionIdRef.current
      const isActiveEvent = !!sessionId && sessionId === activeSessionIdRef.current

      if (
        sessionId &&
        event.type.endsWith('.request') &&
        !acceptPendingInteractionRequest(
          sessionId,
          payload?.interaction_epoch,
          payload?.interaction_revision
        )
      ) {
        return
      }

      if (event.type === 'gateway.ready') {
        return
      } else if (event.type === 'session.info') {
        // Apply session-scoped fields when the event targets the active
        // session, OR when it's a global broadcast and we have no session.
        const apply = explicitSid ? isActiveEvent : !activeSessionIdRef.current
        const modelChanged = typeof payload?.model === 'string'
        const providerChanged = typeof payload?.provider === 'string'
        const runningChanged = typeof payload?.running === 'boolean'

        if (apply) {
          const runtimeInfo: { branch?: string; browserWorkbenchId?: string | null; cwd?: string } = {}

          if (modelChanged) {
            setCurrentModel(payload!.model || '')
          }

          if (providerChanged) {
            setCurrentProvider(payload!.provider || '')
          }

          if (typeof payload?.cwd === 'string') {
            setCurrentCwd(payload.cwd)
            runtimeInfo.cwd = payload.cwd
          }

          if (typeof payload?.branch === 'string') {
            setCurrentBranch(payload.branch)
            runtimeInfo.branch = payload.branch
          }

          if (typeof payload?.browser_workbench_id === 'string') {
            const browserWorkbenchId = payload.browser_workbench_id.trim() || null
            // The renderer owns the workbench binding — it creates the views
            // and registers its choice via session.bindBrowser. A session.info
            // echo can carry the gateway's DEFAULT id (the stored key) from a
            // snapshot taken before our bind landed; replacing a live id with
            // it hides the on-screen view and rebuilds it from scratch (the
            // send-time "正在恢复浏览器" flash). Only adopt when we have none.
            const current = $activeBrowserWorkbenchId.get()

            if (!current || current === browserWorkbenchId) {
              runtimeInfo.browserWorkbenchId = browserWorkbenchId
              setActiveBrowserWorkbenchId(browserWorkbenchId)
            }
          }

          if (
            sessionId &&
            (runtimeInfo.cwd !== undefined ||
              runtimeInfo.branch !== undefined ||
              runtimeInfo.browserWorkbenchId !== undefined)
          ) {
            updateSessionState(sessionId, state => ({
              ...state,
              branch: runtimeInfo.branch ?? state.branch,
              browserWorkbenchId:
                runtimeInfo.browserWorkbenchId === undefined
                  ? state.browserWorkbenchId
                  : runtimeInfo.browserWorkbenchId,
              cwd: runtimeInfo.cwd ?? state.cwd
            }))
          }

          if (typeof payload?.personality === 'string') {
            setCurrentPersonality(normalizePersonalityValue(payload.personality))
          }

          if (typeof payload?.service_tier === 'string') {
            setCurrentServiceTier(payload.service_tier)
          }

          if (typeof payload?.fast === 'boolean') {
            setCurrentFastMode(payload.fast)
          }

          if (typeof payload?.yolo === 'boolean') {
            setYoloActive(payload.yolo)
          }
        }

        // Session-scoped running updates write to THAT session's own cache
        // entry unconditionally — like message.complete/deltas already do for
        // background sessions. This must NOT sit behind the foreground `apply`
        // gate: the turn-end session.info for a background session (or one
        // being resumed, when activeSessionIdRef is still null) was silently
        // dropped, leaving its cached busy stuck true. Only the global atoms
        // (model/cwd/usage/...) above are foreground-scoped. explicitSid only:
        // an unscoped broadcast never applied running before (the apply-gated
        // path always resolved a null sessionId for it) and must not start
        // attaching to whichever session happens to be foreground.
        if (runningChanged && explicitSid) {
          updateSessionState(explicitSid, state => {
            const busy = Boolean(payload!.running)

            if (state.busy === busy && (busy || !state.awaitingResponse)) {
              return state
            }

            if (busy) {
              return {
                ...state,
                busy
              }
            }

            if (state.awaitingResponse && !state.sawAssistantPayload) {
              return state
            }

            return {
              ...state,
              awaitingResponse: false,
              busy,
              pendingBranchGroup: null,
              streamId: null
            }
          })
        }

        if (payload?.usage && (!explicitSid || isActiveEvent)) {
          setCurrentUsage(current => ({ ...current, ...payload.usage }))
        }

        if (typeof payload?.credential_warning === 'string' && payload.credential_warning) {
          notify({
            id: 'model-credential-warning',
            kind: 'warning',
            title: '模型凭据未配置',
            message: payload.credential_warning
          })
        }

        void refreshFanConfig()

        if (modelChanged || providerChanged) {
          void queryClient.invalidateQueries({
            queryKey: explicitSid && sessionId ? ['model-options', sessionId] : ['model-options']
          })
        }
      } else if (event.type === 'message.start') {
        if (!sessionId) {
          return
        }

        flushQueuedDeltas(sessionId)
        clearSessionSubagents(sessionId)
        nativeSubagentSessionsRef.current.delete(sessionId)

        if (isActiveEvent) {
          triggerHaptic('streamStart')
        }

        updateSessionState(sessionId, state => ({
          ...state,
          busy: true,
          awaitingResponse: true,
          sawAssistantPayload: false,
          interrupted: false
        }))
      } else if (event.type === 'message.delta') {
        if (sessionId) {
          appendAssistantDelta(sessionId, coerceGatewayText(payload?.text))
        }
      } else if (event.type === 'thinking.delta') {
        // thinking.delta carries the kawaii spinner status (face + verb from
        // KawaiiSpinner), not real reasoning. The bottom-of-thread loading
        // indicator already covers that UX, so we ignore these events to
        // avoid a duplicative "Thinking" disclosure showing spinner text.
      } else if (event.type === 'reasoning.delta') {
        if (sessionId) {
          appendReasoningDelta(sessionId, coerceThinkingText(payload?.text))
        }
      } else if (event.type === 'reasoning.available') {
        if (sessionId) {
          appendReasoningDelta(sessionId, coerceThinkingText(payload?.text), true)
        }
      } else if (event.type === 'message.complete') {
        if (!sessionId) {
          return
        }

        // Turn ended — drop any blocking prompt still open for THIS session
        // (e.g. interrupted, or the approval already resolved). Scoped to the
        // session so a background turn finishing can't wipe the active chat's
        // prompt, and vice versa.
        clearPendingInteractions(sessionId)

        flushQueuedDeltas(sessionId)

        if (isActiveEvent) {
          triggerHaptic('streamDone')
        }

        const finalText = coerceGatewayText(payload?.text) || coerceGatewayText(payload?.rendered)
        completeAssistantMessage(sessionId, finalText)

        if (payload?.usage) {
          setCurrentUsage(current => ({ ...current, ...payload.usage }))
        }
      } else if (event.type === 'background.complete') {
        if (!sessionId) {
          return
        }

        const taskId = typeof payload?.task_id === 'string' ? payload.task_id.trim() : ''
        const text = renderMediaTags(coerceGatewayText(payload?.text)).trim()
        const body = [taskId ? `后台任务完成 · ${taskId}` : '后台任务完成', text].filter(Boolean).join('\n\n')

        if (!body) {
          return
        }

        flushQueuedDeltas(sessionId)
        updateSessionState(sessionId, state => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `background-${taskId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: 'system',
              parts: [textPart(body)]
            }
          ]
        }))
      } else if (event.type === 'review.summary') {
        // Background self-review is asynchronous and can finish after the user
        // has switched chats. It must therefore use the event's explicit
        // session id (gatewayEventRequiresSessionId drops unscoped copies), not
        // whichever conversation happens to be focused.
        if (!sessionId) {
          return
        }

        const text = coerceGatewayText(payload?.text).trim()

        if (!text) {
          return
        }

        // Preserve arrival order: any buffered assistant/reasoning delta that
        // preceded this event must be committed before the system notice.
        flushQueuedDeltas(sessionId)
        updateSessionState(sessionId, state => {
          const latestVisibleMessage = [...state.messages].reverse().find(message => !message.hidden)

          const duplicate =
            latestVisibleMessage?.role === 'system' && chatMessageText(latestVisibleMessage).trim() === text

          if (duplicate) {
            return state
          }

          return {
            ...state,
            messages: [
              ...state.messages,
              {
                id: `review-summary-${Date.now()}`,
                role: 'system',
                parts: [textPart(text)],
                timestamp: Math.floor(Date.now() / 1000)
              }
            ]
          }
        })
      } else if (event.type === 'tool.start' || event.type === 'tool.progress' || event.type === 'tool.generating') {
        if (!sessionId) {
          return
        }

        flushQueuedDeltas(sessionId)
        upsertToolCall(sessionId, toTodoPayload(payload) ?? payload, 'running', event.type)
      } else if (event.type === 'tool.complete') {
        if (sessionId) {
          flushQueuedDeltas(sessionId)
          upsertToolCall(sessionId, toTodoPayload(payload) ?? payload, 'complete', event.type)
          // A session can have more than one queued interaction. Reflect the
          // remaining queue instead of clearing the badge for the first tool
          // completion that happens to arrive.
          const needsInput = hasPendingInteraction(sessionId)
          updateSessionState(sessionId, state =>
            state.needsInput === needsInput ? state : { ...state, needsInput }
          )
        }

        if (typeof payload?.inline_diff === 'string' && payload.inline_diff.trim()) {
          recordToolDiff(payload.tool_id || payload.name || '', payload.inline_diff)
        }
      } else if (SUBAGENT_EVENT_TYPES.has(event.type)) {
        if (sessionId && payload) {
          if (!nativeSubagentSessionsRef.current.has(sessionId)) {
            pruneDelegateFallbackSubagents(sessionId)
          }

          nativeSubagentSessionsRef.current.add(sessionId)
          upsertSubagent(
            sessionId,
            payload as Record<string, unknown>,
            event.type === 'subagent.spawn_requested' || event.type === 'subagent.start',
            event.type
          )
        }
      } else if (event.type === 'collect.request') {
        // The Python side blocks on `collect.respond`; park the complete form
        // definition per session so background turns and renderer reconnects
        // can resume the same questionnaire.
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''
        const content = parseCollectContent(payload)

        if (requestId && content.question) {
          setCollectRequest({
            requestId,
            toolCallId: typeof payload?.tool_call_id === 'string' ? payload.tool_call_id : null,
            ...content,
            sessionId: sessionId ?? null
          })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'approval.request') {
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          setApprovalRequest({
            requestId,
            // Only an explicit false (tirith content-security warning) drops the
            // permanent-allow option; the backend omits the field otherwise.
            allowPermanent: payload?.allow_permanent !== false,
            command: typeof payload?.command === 'string' ? payload.command : '',
            description: typeof payload?.description === 'string' ? payload.description : 'dangerous command',
            sessionId: sessionId ?? null
          })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'sudo.request') {
        // Sudo password capture (tools/terminal_tool.py). Blocked on
        // sudo.respond {request_id, password}.
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          setSudoRequest({ requestId, sessionId: sessionId ?? null })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'sudo.expire') {
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          clearSudoRequest(sessionId ?? null, requestId)
        }
      } else if (event.type === 'secret.request') {
        // Skill credential capture (tools/skills_tool.py). Blocked on
        // secret.respond {request_id, value}.
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          setSecretRequest({
            requestId,
            envVar: typeof payload?.env_var === 'string' ? payload.env_var : '',
            prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
            sessionId: sessionId ?? null
          })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'secret.expire') {
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          clearSecretRequest(sessionId ?? null, requestId)
        }
      } else if (event.type === 'verification.request') {
        // Captcha / human-verification on the shared browser. The Python side is
        // blocked on verification.respond {request_id, answer}; the browser_* tool that
        // hit it cannot continue until the user solves it (or the runtime sees the
        // captcha clear and auto-resolves). Parked per-session like sudo/secret.
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          setVerificationRequest({
            captchaType: typeof payload?.captcha_type === 'string' ? payload.captcha_type : '',
            challengeId: typeof payload?.challenge_id === 'string' ? payload.challenge_id : undefined,
            documentRevision:
              typeof payload?.document_revision === 'number' ? payload.document_revision : undefined,
            message:
              typeof payload?.message === 'string'
                ? payload.message
                : '需要人工验证 — 请在浏览器中完成验证，Agent 会在你完成后继续',
            requestId,
            sessionId: sessionId ?? null,
            url: typeof payload?.url === 'string' ? payload.url : ''
          })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'control.request') {
        // The user took manual control of the shared browser. Blocked on
        // control.respond {request_id, answer}; the agent stays paused until the
        // user clicks 继续 (hands control back). Parked per-session like sudo.
        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          // Replace the renderer's immediate runtime-authored "pausing"
          // projection (synthetic request id) with this authoritative Gateway
          // request. A session can own only one browser-control boundary.
          clearControlRequest(sessionId)
          setControlRequest({
            message: typeof payload?.message === 'string' ? payload.message : '识别到你操作了页面，已暂停工作',
            requestId,
            sessionId: sessionId ?? null,
            url: typeof payload?.url === 'string' ? payload.url : '',
            provisional: false,
            settling: payload?.settling === true,
            tabKind: typeof payload?.tabKind === 'string' ? payload.tabKind : undefined,
            anchorTabId: typeof payload?.anchorTabId === 'string' ? payload.anchorTabId : undefined,
            userTabId: typeof payload?.userTabId === 'string' ? payload.userTabId : undefined,
            inputKind: typeof payload?.inputKind === 'string' ? payload.inputKind : undefined,
            interventionId:
              typeof payload?.interventionId === 'string' ? payload.interventionId : undefined,
            interventionTimestamp:
              typeof payload?.interventionTimestamp === 'number'
                ? payload.interventionTimestamp
                : undefined
          })

          if (sessionId) {
            updateSessionState(sessionId, state => ({ ...state, needsInput: true }))
          }
        }
      } else if (event.type === 'interaction.resolved') {
        if (!sessionId) {
          return
        }

        const requestId = typeof payload?.request_id === 'string' ? payload.request_id : ''

        if (requestId) {
          if (payload?.kind === 'collect') {
            const status = typeof payload?.status === 'string' ? payload.status : 'cancelled'

            // The interaction lifecycle is authoritative for the card's UI.
            // Resolve it immediately instead of waiting for the blocked Python
            // tool call to unwind and emit a later tool.complete event.
            upsertToolCall(
              sessionId,
              {
                name: 'collect',
                result: { status },
                tool_call_id: typeof payload?.tool_call_id === 'string' ? payload.tool_call_id : undefined
              },
              'complete',
              event.type
            )
          }

          const needsInput = resolvePendingInteraction(
            sessionId,
            requestId,
            payload?.interaction_epoch,
            payload?.interaction_revision
          )

          updateSessionState(sessionId, state =>
            state.needsInput === needsInput ? state : { ...state, needsInput }
          )
        }
      } else if (event.type === 'error') {
        const errorMessage = payload?.message || 'Fan 报告了一个错误'
        const userMessage = userFacingErrorMessage(errorMessage, 'Fan 暂时无法完成请求，请重试。')
        const looksLikeProviderSetup = isProviderSetupErrorMessage(errorMessage)

        // A turn that errors out has also ended — drop any open blocking prompt
        // for this session so an approval/sudo/secret overlay can't linger past
        // the failed turn (same intent as the message.complete clear).
        if (sessionId) {
          clearPendingInteractions(sessionId)
        }

        if (isActiveEvent) {
          notify({
            kind: looksLikeProviderSetup ? 'warning' : 'error',
            title: looksLikeProviderSetup ? '模型凭据未配置' : 'Fan 错误',
            message: userMessage
          })
        }

        if (sessionId) {
          flushQueuedDeltas(sessionId)
          failAssistantMessage(sessionId, userMessage)
        }
      }
    },
    [
      appendAssistantDelta,
      appendReasoningDelta,
      activeSessionIdRef,
      completeAssistantMessage,
      failAssistantMessage,
      flushQueuedDeltas,
      queryClient,
      refreshFanConfig,
      updateSessionState,
      upsertToolCall
    ]
  )

  return {
    appendAssistantDelta,
    appendReasoningDelta,
    completeAssistantMessage,
    handleGatewayEvent,
    upsertToolCall
  }
}
