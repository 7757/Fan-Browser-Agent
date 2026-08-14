import type { AppendMessage, ThreadMessage } from '@assistant-ui/react'
import { type MutableRefObject, useCallback } from 'react'

import { requestComposerInsert } from '@/app/chat/composer/focus'
import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/fan'
import { branchGroupForUser, type ChatMessage, chatMessageText, textPart } from '@/lib/chat-messages'
import {
  appendInterruptedMarker,
  attachmentDisplayText,
  parseCommandDispatch,
  parseSlashCommand,
  pathLabel,
  SLASH_COMMAND_RE
} from '@/lib/chat-runtime'
import {
  type CommandsCatalogLike,
  desktopSlashUnavailableMessage,
  filterDesktopCommandsCatalog,
  isDesktopSlashCommand
} from '@/lib/desktop-slash-commands'
import { triggerHaptic } from '@/lib/haptics'
import { setMutableRef } from '@/lib/mutable-ref'
import { isProviderSetupErrorMessage } from '@/lib/provider-setup-errors'
import { userFacingErrorMessage } from '@/lib/user-facing-error'
import { clearCollectRequest } from '@/store/collect'
import {
  $composerAttachments,
  addComposerAttachment,
  clearComposerAttachments,
  type ComposerAttachment,
  terminalContextBlocksFromDraft
} from '@/store/composer'
import { clearNotifications, notify, notifyError } from '@/store/notifications'
import { clearAllPrompts } from '@/store/prompts'
import {
  $busy,
  $messages,
  promoteSessionActivity,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSessions
} from '@/store/session'

import type {
  BackgroundStartResponse,
  ClientSessionState,
  ImageAttachResponse,
  SessionTitleResponse,
  SlashExecResponse
} from '../../types'

function isProviderSetupError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)

  return isProviderSetupErrorMessage(message)
}

function inlineErrorMessage(error: unknown, fallback: string): string {
  return userFacingErrorMessage(error, fallback)
}

function isSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return /session not found/i.test(message)
}

interface PromptActionsOptions {
  activeSessionId: string | null
  activeSessionIdRef: MutableRefObject<string | null>
  busyRef: MutableRefObject<boolean>
  branchCurrentSession: () => Promise<boolean>
  createBackendSessionForSend: (
    preview?: string | null,
    onSessionReady?: (runtimeSessionId: string, storedSessionId: null | string) => void
  ) => Promise<string | null>
  getRouteToken: () => string
  refreshSessions: () => Promise<void>
  requestGateway: <T>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>
  selectedStoredSessionIdRef: MutableRefObject<string | null>
  startNewSession: () => void
  updateSessionState: (
    sessionId: string,
    updater: (state: ClientSessionState) => ClientSessionState,
    storedSessionId?: string | null
  ) => ClientSessionState
}

interface SubmitTextOptions {
  attachments?: ComposerAttachment[]
  fromSteer?: boolean
}

function renderCommandsCatalog(catalog: CommandsCatalogLike): string {
  const desktopCatalog = filterDesktopCommandsCatalog(catalog)

  const sections = desktopCatalog.categories?.length
    ? desktopCatalog.categories
    : [{ name: '桌面命令', pairs: desktopCatalog.pairs ?? [] }]

  const body = sections
    .filter(section => section.pairs.length > 0)
    .map(section => {
      const rows = section.pairs.map(([cmd, desc]) => `${cmd.padEnd(18)} ${desc}`)

      return [`${section.name}:`, ...rows].join('\n')
    })
    .join('\n\n')

  const tail = [desktopCatalog.warning ? `warning: ${desktopCatalog.warning}` : '']
    .filter(Boolean)
    .join('\n')

  return [body || '暂无桌面命令可用。', tail].filter(Boolean).join('\n\n')
}

function slashStatusText(command: string, output: string): string {
  return [`slash:${command}`, output.trim()].filter(Boolean).join('\n')
}

function isBackgroundSlashCommand(name: string): boolean {
  return name === 'background' || name === 'bg' || name === 'btw'
}

function appendText(message: AppendMessage): string {
  return message.content
    .map(part => ('text' in part ? part.text : ''))
    .join('')
    .trim()
}

function visibleUserOrdinal(messages: readonly ChatMessage[], end: number): number {
  return messages.slice(0, end).filter(m => m.role === 'user' && !m.hidden).length
}

export function usePromptActions({
  activeSessionId,
  activeSessionIdRef,
  busyRef,
  branchCurrentSession,
  createBackendSessionForSend,
  getRouteToken,
  refreshSessions,
  requestGateway,
  selectedStoredSessionIdRef,
  startNewSession,
  updateSessionState
}: PromptActionsOptions) {
  const appendSessionTextMessage = useCallback(
    (sessionId: string, role: ChatMessage['role'], text: string) => {
      const body = text.trim()

      if (!body) {
        return
      }

      updateSessionState(
        sessionId,
        state => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role,
              parts: [textPart(body)]
            }
          ]
        }),
        selectedStoredSessionIdRef.current
      )
    },
    [selectedStoredSessionIdRef, updateSessionState]
  )

  const syncImageAttachmentsForSubmit = useCallback(
    async (
      sessionId: string,
      attachments: ComposerAttachment[],
      options: { updateComposerAttachments?: boolean } = {}
    ) => {
      const updateComposerAttachments = options.updateComposerAttachments ?? true
      const images = attachments.filter(attachment => attachment.kind === 'image' && attachment.path)

      for (const attachment of images) {
        if (attachment.attachedSessionId === sessionId) {
          continue
        }

        const result = await requestGateway<ImageAttachResponse>('image.attach', {
          session_id: sessionId,
          path: attachment.path
        })

        if (!result.attached) {
          const label = attachment.label || (attachment.path ? pathLabel(attachment.path) : 'image')
          throw new Error(result.message || `Could not attach ${label}`)
        }

        const attachedPath = result.path || attachment.path

        if (updateComposerAttachments) {
          addComposerAttachment({
            ...attachment,
            id: attachment.id,
            label: attachedPath ? pathLabel(attachedPath) : attachment.label,
            path: attachedPath,
            attachedSessionId: sessionId
          })
        }
      }
    },
    [requestGateway]
  )

  const submitPromptText = useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = rawText.trim()
      const usingComposerAttachments = !options?.attachments
      const attachments = options?.attachments ?? $composerAttachments.get()

      const contextRefs = attachments
        .map(a => a.refText)
        .filter(Boolean)
        .join('\n')

      const terminalContextBlocks = terminalContextBlocksFromDraft(rawText).join('\n\n')
      const hasImage = attachments.some(a => a.kind === 'image')
      const attachmentRefs = attachments.map(attachmentDisplayText).filter((r): r is string => Boolean(r))

      const text =
        [contextRefs, terminalContextBlocks, visibleText].filter(Boolean).join('\n\n') ||
        (hasImage ? 'What is in this image?' : '')

      if (options?.fromSteer) {
        const sessionId = activeSessionId || activeSessionIdRef.current
        const storedSessionId = selectedStoredSessionIdRef.current

        if (!text || !sessionId) {
          return false
        }

        const appendSteerStatus = (message: string) => {
          const body = message.trim()

          if (!body) {
            return
          }

          updateSessionState(
            sessionId,
            state => ({
              ...state,
              messages: [
                ...state.messages,
                {
                  id: `system-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  role: 'system',
                  parts: [textPart(body)]
                }
              ]
            }),
            storedSessionId
          )
        }

        // Image attachments are consumed by prompt.submit's multimodal path;
        // session.steer deliberately carries text only. Keep the draft intact
        // instead of accepting an image and silently stripping its content.
        if (hasImage) {
          appendSteerStatus('暂时无法在当前运行中补充图片。请等待本轮结束后再发送。')

          return false
        }

        try {
          const result = await requestGateway<{ status?: string }>(
            'session.steer',
            { session_id: sessionId, text },
            PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
          )

          if (result?.status === 'rejected') {
            throw new Error('当前运行无法接收补充')
          }

          const messageId = `user-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

          const userMessage: ChatMessage = {
            id: messageId,
            role: 'user',
            parts: [textPart(visibleText || (attachmentRefs.length ? '' : attachments.map(a => a.label).join(', ')))],
            attachmentRefs
          }

          updateSessionState(
            sessionId,
            state => {
              // Close the assistant segment that preceded this intervention.
              // Subsequent deltas seed a fresh assistant bubble below the new
              // user message instead of continuing visually above it.
              const messagesBeforeSteer = state.streamId
                ? state.messages.flatMap(message => {
                    if (message.id !== state.streamId) {
                      return [message]
                    }

                    return message.parts.length || message.error ? [{ ...message, pending: false }] : []
                  })
                : state.messages

              return {
                ...state,
                messages: [...messagesBeforeSteer, userMessage],
                streamId: null
              }
            },
            storedSessionId
          )
          promoteSessionActivity(storedSessionId)

          return true
        } catch (err) {
          appendSteerStatus(inlineErrorMessage(err, '补充当前运行失败'))

          return false
        }
      }

      if (!text || busyRef.current) {
        return false
      }

      // Keep this submit bound to the chat from which it started.  A session
      // switch while an attachment sync or sleep/wake resume is in flight must
      // never cause the text to be delivered into the newly selected chat.
      let pinnedStoredSessionId = selectedStoredSessionIdRef.current
      let pinnedRouteToken = getRouteToken()

      const sessionContextDrifted = () =>
        selectedStoredSessionIdRef.current !== pinnedStoredSessionId || getRouteToken() !== pinnedRouteToken

      const optimisticId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const userMessage: ChatMessage = {
        id: optimisticId,
        role: 'user',
        parts: [textPart(visibleText || (attachmentRefs.length ? '' : attachments.map(a => a.label).join(', ')))],
        attachmentRefs
      }

      const releaseBusy = () => {
        setMutableRef(busyRef, false)
        setBusy(false)
        setAwaitingResponse(false)
      }

      // Idempotent optimistic insert — re-running with the resolved sessionId
      // after createBackendSessionForSend just overwrites with the same id.
      const seedOptimistic = (sid: string) =>
        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.some(m => m.id === optimisticId)
              ? state.messages
              : [...state.messages, userMessage],
            busy: true,
            awaitingResponse: true,
            pendingBranchGroup: null,
            sawAssistantPayload: false,
            interrupted: state.interrupted
          }),
          pinnedStoredSessionId
        )

      const dropOptimistic = (sid: null | string) => {
        if (!sid) {
          setMessages(current => current.filter(m => m.id !== optimisticId))

          return
        }

        updateSessionState(
          sid,
          state => ({
            ...state,
            messages: state.messages.filter(m => m.id !== optimisticId),
            busy: false,
            awaitingResponse: false,
            pendingBranchGroup: null
          }),
          pinnedStoredSessionId
        )
      }

      const abortForSessionSwitch = (optimisticSessionId: null | string): false => {
        dropOptimistic(optimisticSessionId)
        releaseBusy()

        return false
      }

      setMutableRef(busyRef, true)
      setBusy(true)
      setAwaitingResponse(true)
      clearNotifications()

      let sessionId: null | string = activeSessionId

      if (sessionId) {
        seedOptimistic(sessionId)
      } else {
        setMessages(current => [...current, userMessage])
      }

      if (!sessionId) {
        try {
          // Seed via onSessionReady (pre-navigation) so the optimistic user
          // message is already in the new session's state when the thread
          // remounts on the route change — no blink while create is slow.
          sessionId = await createBackendSessionForSend(visibleText, runtimeId => seedOptimistic(runtimeId))
        } catch (err) {
          dropOptimistic(null)
          releaseBusy()

          notifyError(err, '会话不可用')

          return false
        }

        if (!sessionId) {
          dropOptimistic(null)
          releaseBusy()
          notify({ kind: 'error', title: '会话不可用', message: '无法创建新会话' })

          return false
        }

        seedOptimistic(sessionId)

        // A new-session send intentionally navigates to its new chat.  The
        // creation helper already rejects an external session switch while it
        // is pending; pin the newly established context for the remaining
        // asynchronous submit work.
        pinnedStoredSessionId = selectedStoredSessionIdRef.current
        pinnedRouteToken = getRouteToken()
      }

      try {
        await syncImageAttachmentsForSubmit(sessionId, attachments, {
          updateComposerAttachments: usingComposerAttachments
        })

        if (sessionContextDrifted()) {
          return abortForSessionSwitch(sessionId)
        }

        // On sleep/wake the gateway's in-memory session may have been cleared
        // while the desktop app still holds the old session ID. Detect this,
        // resume the stored session to re-register it, and retry once.
        let submitErr: unknown = null

        try {
          await requestGateway(
            'prompt.submit',
            { session_id: sessionId, text },
            PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
          )
        } catch (firstErr) {
          if (isSessionNotFoundError(firstErr) && pinnedStoredSessionId) {
            const resumed = await requestGateway<{ session_id: string }>('session.resume', {
              session_id: pinnedStoredSessionId
            })

            if (sessionContextDrifted()) {
              return abortForSessionSwitch(sessionId)
            }

            const recoveredId = resumed?.session_id

            if (recoveredId) {
              activeSessionIdRef.current = recoveredId

              if (recoveredId !== sessionId) {
                // Resume rebuilt the runtime session under a NEW id. Carry this
                // turn's identity onto it so the optimistic user message and any
                // error don't strand in the abandoned old bucket: sync the
                // active-session store, re-seed the optimistic message into the
                // new bucket (idempotent; also rebinds stored-id -> runtime-id),
                // and rebind the closure `sessionId` so the catch block writes
                // to the new bucket.
                setActiveSessionId(recoveredId)
                seedOptimistic(recoveredId)
                // Clear the now-orphaned OLD bucket: its optimistic message is
                // re-seeded above into recoveredId and nothing maps to the old
                // runtime id anymore, so otherwise it lingers with stale
                // busy:true / awaitingResponse state (invisible, but dead).
                dropOptimistic(sessionId)
                sessionId = recoveredId
              }

              await requestGateway(
                'prompt.submit',
                { session_id: recoveredId, text },
                PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
              )
            } else {
              submitErr = firstErr
            }
          } else {
            submitErr = firstErr
          }
        }

        if (submitErr !== null) {
          throw submitErr
        }

        // The recent-sessions endpoint is message-timestamp based and may lag
        // behind this accepted turn until Agent persistence begins. Promote the
        // stable stored conversation now so Canvas responds before first output.
        promoteSessionActivity(pinnedStoredSessionId)

        if (usingComposerAttachments) {
          clearComposerAttachments()
        }

        return true
      } catch (err) {
        const message = inlineErrorMessage(err, 'Prompt failed')

        releaseBusy()
        updateSessionState(sessionId, state => ({
          ...state,
          messages: [
            ...state.messages,
            {
              id: `assistant-error-${Date.now()}`,
              role: 'assistant',
              parts: [],
              error: message || '提交失败',
              branchGroupId: state.pendingBranchGroup ?? undefined
            }
          ],
          busy: false,
          awaitingResponse: false,
          pendingBranchGroup: null,
          sawAssistantPayload: true
        }))

        if (isProviderSetupError(err)) {
          notify({
            kind: 'warning',
            title: '模型凭据未配置',
            message: '请先在本地配置模型提供商凭据，再发送消息。'
          })

          return false
        }

        notifyError(err, '提交失败')

        return false
      }
    },
    [
      activeSessionId,
      activeSessionIdRef,
      busyRef,
      createBackendSessionForSend,
      getRouteToken,
      requestGateway,
      selectedStoredSessionIdRef,
      syncImageAttachmentsForSubmit,
      updateSessionState
    ]
  )

  const executeSlashCommand = useCallback(
    async (rawCommand: string, options?: { sessionId?: string; recordInput?: boolean }) => {
      const runSlash = async (commandText: string, sessionHint?: string, recordInput = true): Promise<void> => {
        const command = commandText.trim()
        const { name, arg } = parseSlashCommand(command)
        const normalizedName = name.toLowerCase()

        if (!name) {
          const sessionId = sessionHint || activeSessionIdRef.current || (await createBackendSessionForSend())

          if (sessionId) {
            appendSessionTextMessage(sessionId, 'system', '斜杠命令为空')
          }

          return
        }

        // Fail closed before any local command side effect or implicit session
        // creation. The server-delivered allowlist gates suggestions, /help,
        // and typed execution alike, so commands cannot be invoked by bypassing
        // the completion UI.
        if (!isDesktopSlashCommand(name)) {
          const message = desktopSlashUnavailableMessage(name) || `/${name} 在桌面应用中不可用。`
          const sessionId = sessionHint || activeSessionIdRef.current

          if (sessionId) {
            appendSessionTextMessage(sessionId, 'system', recordInput ? slashStatusText(command, message) : message)
          } else {
            notify({ kind: 'error', title: '命令不可用', message })
          }

          return
        }

        if (normalizedName === 'new' || normalizedName === 'reset') {
          startNewSession()

          return
        }

        if (normalizedName === 'branch' || normalizedName === 'fork') {
          await branchCurrentSession()

          return
        }

        const sessionId = sessionHint || activeSessionIdRef.current || (await createBackendSessionForSend())

        if (!sessionId) {
          notify({
            kind: 'error',
            title: '会话不可用',
            message: '无法创建新会话'
          })

          return
        }

        const renderSlashOutput = (text: string) =>
          appendSessionTextMessage(sessionId, 'system', recordInput ? slashStatusText(command, text) : text)

        // /title <name> renames the session. Route through the gateway's
        // `session.title` RPC — the same path the TUI uses — NOT the REST
        // renameSession endpoint and NOT the slash worker.
        //
        // Why not the slash worker: it's a separate FanSession subprocess whose
        // SQLite write to the shared state.db can silently fail (notably on
        // Windows), and it never refreshes the sidebar.
        //
        // Why not REST renameSession: `sessionId` here is the *runtime* session
        // id returned by session.create — it is NOT the stored DB `sessions.id`.
        // Desktop creates that stored row eagerly, but the REST PATCH endpoint
        // still cannot resolve the runtime id and would 404. See #38508 / #38576.
        //
        // session.title maps the runtime id to the in-memory session, writes
        // through the gateway's own DB connection, and retries row creation if
        // the eager write failed transiently. `pending: true` is only the final
        // recovery path. refreshSessions() then pulls the authoritative title
        // back into the sidebar. A bare `/title` (no arg) still falls through
        // to the worker to display the current title.
        if (normalizedName === 'title' && arg) {
          try {
            const result = await requestGateway<SessionTitleResponse>('session.title', {
              session_id: sessionId,
              title: arg
            })

            const finalTitle = (result?.title || arg).trim()
            const queued = result?.pending === true

            setSessions(prev => prev.map(s => (s.id === sessionId ? { ...s, title: finalTitle || null } : s)))
            await refreshSessions().catch(() => undefined)
            renderSlashOutput(
              finalTitle
                ? `会话标题已设置：${finalTitle}${queued ? '（会话初始化时排队）' : ''}`
                : '会话标题已清除。'
            )
          } catch (err) {
            console.error('[commands] Session title update failed', err)
            renderSlashOutput(userFacingErrorMessage(err, '设置会话标题失败，请重试。'))
          }

          return
        }

        if (name === 'help' || name === 'commands') {
          try {
            const catalog = await requestGateway<CommandsCatalogLike>('commands.catalog', { session_id: sessionId })

            renderSlashOutput(renderCommandsCatalog(catalog))
          } catch (err) {
            console.error('[commands] Command catalog load failed', err)
            renderSlashOutput(userFacingErrorMessage(err, '命令列表加载失败，请重试。'))
          }

          return
        }

        if (isBackgroundSlashCommand(normalizedName)) {
          if (!arg) {
            renderSlashOutput('/background <prompt>')

            return
          }

          try {
            const result = await requestGateway<BackgroundStartResponse>('prompt.background', {
              session_id: sessionId,
              text: arg
            })

            const taskId = result?.task_id?.trim()

            renderSlashOutput(taskId ? `后台任务已启动：${taskId}\n完成后结果会显示在当前会话。` : '后台任务已启动。')
          } catch (err) {
            console.error('[commands] Background task start failed', err)
            renderSlashOutput(userFacingErrorMessage(err, '后台任务启动失败，请重试。'))
          }

          return
        }

        const handleDispatch = async (dispatch: NonNullable<ReturnType<typeof parseCommandDispatch>>) => {
          if (dispatch.type === 'exec' || dispatch.type === 'plugin') {
            renderSlashOutput(dispatch.output ?? '（无输出）')

            return
          }

          if (dispatch.type === 'alias') {
            await runSlash(`/${dispatch.target}${arg ? ` ${arg}` : ''}`, sessionId, false)

            return
          }

          if ((dispatch.type === 'send' || dispatch.type === 'prefill') && dispatch.notice?.trim()) {
            renderSlashOutput(dispatch.notice.trim())
          }

          const message = ('message' in dispatch ? dispatch.message : '')?.trim() ?? ''

          if (dispatch.type === 'prefill') {
            if (message) {
              requestComposerInsert(message, { mode: 'replace', target: 'main' })
            }

            return
          }

          if (!message) {
            renderSlashOutput(
              `/${name}: ${dispatch.type === 'skill' ? '技能载荷缺少消息内容' : '消息为空'}`
            )

            return
          }

          if (dispatch.type === 'skill') {
            renderSlashOutput(`⚡ 正在加载技能：${dispatch.name}`)
          }

          if (busyRef.current) {
            renderSlashOutput('会话繁忙——请先用 /interrupt 中断当前轮次，再发送此命令')

            return
          }

          await submitPromptText(message)
        }

        try {
          const result = await requestGateway<unknown>('slash.exec', {
            session_id: sessionId,
            command: command.replace(/^\/+/, '')
          })

          const dispatch = parseCommandDispatch(result)

          if (dispatch) {
            await handleDispatch(dispatch)

            return
          }

          const output = result && typeof result === 'object' ? (result as SlashExecResponse) : null
          const body = output?.output || `/${name}: 无输出`
          renderSlashOutput(output?.warning ? `警告：${output.warning}\n${body}` : body)

          return
        } catch {
          // Older gateways return 4018 for directives; retain the rolling-
          // version fallback and feed both paths through the same handler.
        }

        try {
          const dispatch = parseCommandDispatch(
            await requestGateway<unknown>('command.dispatch', {
              session_id: sessionId,
              name,
              arg
            })
          )

          if (!dispatch) {
            renderSlashOutput('错误：command.dispatch 返回了无效响应')

            return
          }

          await handleDispatch(dispatch)
        } catch (err) {
          console.error('[commands] Command dispatch failed', err)
          renderSlashOutput(userFacingErrorMessage(err, '命令执行失败，请重试。'))
        }
      }

      await runSlash(rawCommand, options?.sessionId, options?.recordInput ?? true)
    },
    [
      activeSessionIdRef,
      appendSessionTextMessage,
      branchCurrentSession,
      busyRef,
      createBackendSessionForSend,
      refreshSessions,
      requestGateway,
      startNewSession,
      submitPromptText
    ]
  )

  const submitText = useCallback(
    async (rawText: string, options?: SubmitTextOptions) => {
      const visibleText = rawText.trim()
      const attachments = options?.attachments ?? $composerAttachments.get()

      if (!attachments.length && SLASH_COMMAND_RE.test(visibleText)) {
        triggerHaptic('selection')
        await executeSlashCommand(visibleText)

        return true
      }

      return await submitPromptText(rawText, options)
    },
    [executeSlashCommand, submitPromptText]
  )

  const cancelRun = useCallback(async () => {
    const sessionId = activeSessionId || activeSessionIdRef.current

    const finalizeMessages = (messages: ChatMessage[], preferredId?: string | null) => {
      let targetIndex = preferredId
        ? messages.findIndex(message => message.id === preferredId)
        : -1

      if (targetIndex < 0) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]

          const unresolvedCollect = message.parts.some(
            part => part.type === 'tool-call' && part.toolName === 'collect' && part.result === undefined
          )

          if (message.pending || unresolvedCollect) {
            targetIndex = index

            break
          }
        }
      }

      if (targetIndex < 0) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'assistant') {
            targetIndex = index

            break
          }
        }
      }

      if (targetIndex < 0) {
        return messages
      }

      return messages.map((message, index) =>
        index === targetIndex
          ? {
              ...message,
              parts: appendInterruptedMarker(message.parts),
              pending: false
            }
          : message
      )
    }

    const finalizeStoppedSession = (targetSessionId: string, storedSessionId?: string | null) => {
      clearCollectRequest(undefined, targetSessionId)
      clearAllPrompts(targetSessionId)

      return updateSessionState(
        targetSessionId,
        state => {
          const streamId = state.streamId
          const messages = finalizeMessages(state.messages, streamId)

          return {
            ...state,
            messages,
            busy: false,
            awaitingResponse: false,
            needsInput: false,
            streamId: null,
            pendingBranchGroup: null,
            interrupted: true
          }
        },
        storedSessionId
      )
    }

    if (!sessionId) {
      setMutableRef(busyRef, false)
      setBusy(false)
      setAwaitingResponse(false)
      setMessages(finalizeMessages($messages.get()))

      return true
    }

    try {
      await requestGateway('session.interrupt', { session_id: sessionId })
    } catch (err) {
      // Same sleep/wake recovery as submit: a stale session ID interrupt fails
      // with "session not found" — resume the stored session, retry once.
      let stopError = err

      if (isSessionNotFoundError(err) && selectedStoredSessionIdRef.current) {
        try {
          const resumed = await requestGateway<{ session_id: string }>('session.resume', {
            session_id: selectedStoredSessionIdRef.current
          })

          const recoveredId = resumed?.session_id

          if (recoveredId) {
            activeSessionIdRef.current = recoveredId
            await requestGateway('session.interrupt', { session_id: recoveredId })

            const stoppedState = finalizeStoppedSession(sessionId)

            if (recoveredId !== sessionId) {
              // Resume replaced the stale runtime id. Move the already
              // finalized view state onto the replacement instead of
              // independently finalizing two buckets (which can create an
              // empty active transcript and duplicate the marker).
              updateSessionState(
                recoveredId,
                () => ({
                  ...stoppedState,
                  storedSessionId: selectedStoredSessionIdRef.current
                }),
                selectedStoredSessionIdRef.current
              )
              setActiveSessionId(recoveredId)
            }

            setMutableRef(busyRef, false)
            setBusy(false)
            setAwaitingResponse(false)

            return true
          }
        } catch (resumeErr) {
          stopError = resumeErr
        }
      }

      notifyError(stopError, '停止失败')

      return false
    }

    // Only publish the local terminal state after the gateway confirms that
    // the interrupt was accepted. Until then the backend may still be running,
    // so keeping busy/prompts visible is the truthful and safer UI.
    finalizeStoppedSession(sessionId)
    setMutableRef(busyRef, false)
    setBusy(false)
    setAwaitingResponse(false)

    return true
  }, [activeSessionId, activeSessionIdRef, busyRef, requestGateway, selectedStoredSessionIdRef, updateSessionState])

  const reloadFromMessage = useCallback(
    async (parentId: string | null) => {
      if (!activeSessionId || $busy.get()) {
        return
      }

      const messages = $messages.get()
      const parentIndex = parentId ? messages.findIndex(message => message.id === parentId) : messages.length - 1

      const userIndex =
        parentIndex >= 0
          ? [...messages.slice(0, parentIndex + 1)].reverse().findIndex(message => message.role === 'user')
          : -1

      if (userIndex < 0) {
        return
      }

      const absoluteUserIndex = parentIndex - userIndex
      const userMessage = messages[absoluteUserIndex]
      const userText = userMessage ? chatMessageText(userMessage).trim() : ''

      if (!userText) {
        return
      }

      const targetAssistant =
        parentId && messages[parentIndex]?.role === 'assistant'
          ? messages[parentIndex]
          : messages.slice(absoluteUserIndex + 1).find(message => message.role === 'assistant')

      const branchGroupId = targetAssistant?.branchGroupId ?? branchGroupForUser(userMessage)
      const truncateBeforeUserOrdinal = visibleUserOrdinal(messages, absoluteUserIndex)

      clearNotifications()
      updateSessionState(activeSessionId, state => {
        const nextUserIndex = state.messages.findIndex(
          (message, index) => index > absoluteUserIndex && message.role === 'user'
        )

        const end = nextUserIndex < 0 ? state.messages.length : nextUserIndex

        return {
          ...state,
          busy: true,
          awaitingResponse: true,
          pendingBranchGroup: branchGroupId,
          sawAssistantPayload: false,
          interrupted: false,
          messages: [
            ...state.messages.slice(0, absoluteUserIndex + 1),
            ...state.messages
              .slice(absoluteUserIndex + 1, end)
              .map(message => (message.role === 'assistant' ? { ...message, branchGroupId, hidden: true } : message))
          ]
        }
      })

      try {
        await requestGateway(
          'prompt.submit',
          {
            session_id: activeSessionId,
            text: userText,
            truncate_before_user_ordinal: truncateBeforeUserOrdinal
          },
          PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
        )
      } catch (err) {
        updateSessionState(activeSessionId, state => ({
          ...state,
          busy: false,
          awaitingResponse: false
        }))
        notifyError(err, '重新生成失败')
      }
    },
    [activeSessionId, requestGateway, updateSessionState]
  )

  const editMessage = useCallback(
    async (edited: AppendMessage) => {
      const sessionId = activeSessionId || activeSessionIdRef.current
      const sourceId = edited.sourceId || edited.parentId
      const text = appendText(edited)

      if (!sessionId || !sourceId || !text || edited.role !== 'user' || $busy.get()) {
        return
      }

      const messages = $messages.get()
      const sourceIndex = messages.findIndex(m => m.id === sourceId)
      const source = messages[sourceIndex]

      if (!source || source.role !== 'user' || chatMessageText(source).trim() === text) {
        return
      }

      // Failed turn: optimistic user msg never reached the gateway, so truncating
      // by ordinal would 422. Submit as a plain resend instead.
      const nextMessage = messages[sourceIndex + 1]
      const isFailedTurn = nextMessage?.role === 'assistant' && Boolean(nextMessage.error)
      const editedMessage: ChatMessage = { ...source, parts: [textPart(text)] }

      clearNotifications()
      setMutableRef(busyRef, true)
      setBusy(true)
      setAwaitingResponse(true)
      updateSessionState(sessionId, state => ({
        ...state,
        busy: true,
        awaitingResponse: true,
        pendingBranchGroup: null,
        sawAssistantPayload: false,
        interrupted: false,
        messages: [...state.messages.slice(0, sourceIndex), editedMessage]
      }))

      const submit = (truncateOrdinal?: number) =>
        requestGateway(
          'prompt.submit',
          {
            session_id: sessionId,
            text,
            ...(truncateOrdinal !== undefined && { truncate_before_user_ordinal: truncateOrdinal })
          },
          PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
        )

      const isStaleTargetError = (err: unknown) =>
        /no longer in session history|not in session history/i.test(err instanceof Error ? err.message : String(err))

      try {
        await submit(isFailedTurn ? undefined : visibleUserOrdinal(messages, sourceIndex))
      } catch (err) {
        let surfaced = err

        if (!isFailedTurn && isStaleTargetError(err)) {
          try {
            await submit()

            return
          } catch (retryErr) {
            surfaced = retryErr
          }
        }

        setMutableRef(busyRef, false)
        setBusy(false)
        setAwaitingResponse(false)
        updateSessionState(sessionId, state => ({ ...state, busy: false, awaitingResponse: false }))
        notifyError(surfaced, '编辑失败')
      }
    },
    [activeSessionId, activeSessionIdRef, busyRef, requestGateway, updateSessionState]
  )

  const handleThreadMessagesChange = useCallback(
    (nextMessages: readonly ThreadMessage[]) => {
      const visibleIds = new Set(nextMessages.map(m => m.id))
      const sessionId = activeSessionIdRef.current

      if (!sessionId) {
        return
      }

      updateSessionState(sessionId, state => {
        let changed = false

        const messages = state.messages.map(message => {
          if (message.role !== 'assistant' || !message.branchGroupId) {
            return message
          }

          const hidden = !visibleIds.has(message.id)

          if (message.hidden === hidden) {
            return message
          }

          changed = true

          return { ...message, hidden }
        })

        return changed ? { ...state, messages } : state
      })
    },
    [activeSessionIdRef, updateSessionState]
  )

  return { cancelRun, editMessage, handleThreadMessagesChange, reloadFromMessage, submitText }
}
