import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  type ThreadMessage,
  useExternalStoreRuntime
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { Suspense, useCallback, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'

import { Thread } from '@/components/assistant-ui/thread'
import { PendingApprovalFallback } from '@/components/assistant-ui/tool-approval'
import { Backdrop } from '@/components/Backdrop'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { type FanGateway } from '@/fan'
import type { ChatMessage } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import { cn } from '@/lib/utils'
import type { ComposerAttachment } from '@/store/composer'
import {
  $activeSessionId,
  $awaitingResponse,
  $busy,
  $contextSuggestions,
  $currentCwd,
  $currentModel,
  $currentProvider,
  $gatewayState,
  $introPersonality,
  $introSeed,
  $messages,
  $resumeExhaustedSessionId,
  $selectedStoredSessionId
} from '@/store/session'

import { routeSessionId } from '../routes'

import { ChatDropOverlay } from './chat-drop-overlay'
import { ChatBar, ChatBarFallback } from './composer'
import { requestComposerInsert, requestComposerInsertRefs } from './composer/focus'
import { droppedFileInlineRef, type SessionDragPayload, sessionInlineRef } from './composer/inline-refs'
import type { ChatBarState } from './composer/types'
import type { DroppedFile } from './hooks/use-composer-actions'
import { useFileDropZone } from './hooks/use-file-drop-zone'
import { lastVisibleMessageIsUser, threadLoadingState } from './thread-loading'

interface ChatViewProps extends Omit<React.ComponentProps<'div'>, 'onSubmit'> {
  gateway: FanGateway | null
  onCancel: () => Promise<boolean | void> | boolean | void
  onAddContextRef: (refText: string, label?: string, detail?: string) => void
  onAddUrl: (url: string) => void
  onBranchInNewChat: (messageId: string) => void
  onAttachImageBlob: (blob: Blob) => Promise<boolean | void> | boolean | void
  onAttachDroppedItems: (candidates: DroppedFile[]) => Promise<boolean | void> | boolean | void
  onPasteClipboardImage: (opts?: { silent?: boolean }) => Promise<boolean> | void
  onPickFiles: () => void
  onPickFolders: () => void
  onPickImages: () => void
  onRemoveAttachment: (id: string) => void
  onSubmit: (
    text: string,
    options?: { attachments?: ComposerAttachment[]; fromSteer?: boolean }
  ) => Promise<boolean> | boolean
  onThreadMessagesChange: (messages: readonly ThreadMessage[]) => void
  onEdit: (message: AppendMessage) => Promise<void>
  onReload: (parentId: string | null) => Promise<void>
  onDismissError?: (messageId: string) => void
  onRetryResume: (sessionId: string) => void
}

export function ChatView({
  className,
  gateway,
  onCancel,
  onAddContextRef,
  onAddUrl,
  onAttachImageBlob,
  onAttachDroppedItems,
  onBranchInNewChat,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmit,
  onThreadMessagesChange,
  onEdit,
  onReload,
  onDismissError,
  onRetryResume
}: ChatViewProps) {
  const location = useLocation()
  const activeSessionId = useStore($activeSessionId)
  const awaitingResponse = useStore($awaitingResponse)
  const busy = useStore($busy)
  const contextSuggestions = useStore($contextSuggestions)
  const currentCwd = useStore($currentCwd)
  const currentModel = useStore($currentModel)
  const currentProvider = useStore($currentProvider)
  const gatewayState = useStore($gatewayState)
  const gatewayOpen = gatewayState === 'open'
  const introPersonality = useStore($introPersonality)
  const introSeed = useStore($introSeed)
  const messages = useStore($messages)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const selectedSessionId = useStore($selectedStoredSessionId)
  const runtimeMessageCacheRef = useRef(new WeakMap<ChatMessage, ThreadMessage>())
  const routedSessionId = routeSessionId(location.pathname)
  const isRoutedSessionView = Boolean(routedSessionId)

  // No draft concept: a brand-new REAL session (zero messages) shows the
  // intro hero until the first message lands.
  const showIntro = Boolean(activeSessionId) && messages.length === 0

  // Session is still loading if the route references a session we haven't
  // resumed yet. Once `activeSessionId` is set (runtime has resumed), the
  // session exists — even if it has zero messages (a brand-new routed
  // session). The flicker where `busy` flips true briefly during hydrate
  // is handled by `threadLoadingState`'s last-visible-user gate.
  const resumeExhausted = Boolean(routedSessionId && resumeExhaustedSessionId === routedSessionId)

  const loadingSession =
    !resumeExhausted && isRoutedSessionView && messages.length === 0 && !activeSessionId

  const threadLoading = threadLoadingState(loadingSession, busy, awaitingResponse, lastVisibleMessageIsUser(messages))
  const showChatBar = !loadingSession && !resumeExhausted
  const threadKey = selectedSessionId || activeSessionId || (isRoutedSessionView ? location.pathname : 'new')

  const chatBarState = useMemo<ChatBarState>(
    () => ({
      model: {
        model: currentModel,
        provider: currentProvider,
        loading: !gatewayOpen || (!currentModel && !currentProvider)
      },
      tools: {
        enabled: true,
        label: '添加上下文',
        suggestions: contextSuggestions
      }
    }),
    [contextSuggestions, currentModel, currentProvider, gatewayOpen]
  )

  const runtimeMessageRepository = useMemo(() => {
    const items: { message: ThreadMessage; parentId: string | null }[] = []
    const branchParentByGroup = new Map<string, string | null>()
    let visibleParentId: string | null = null
    let headId: string | null = null

    for (const message of messages) {
      let parentId = visibleParentId

      if (message.role === 'assistant' && message.branchGroupId) {
        if (!branchParentByGroup.has(message.branchGroupId)) {
          branchParentByGroup.set(message.branchGroupId, visibleParentId)
        }

        parentId = branchParentByGroup.get(message.branchGroupId) ?? null
      }

      const cachedMessage = runtimeMessageCacheRef.current.get(message)
      const runtimeMessage = cachedMessage ?? toRuntimeMessage(message)

      if (!cachedMessage) {
        runtimeMessageCacheRef.current.set(message, runtimeMessage)
      }

      items.push({ message: runtimeMessage, parentId })

      if (!message.hidden) {
        visibleParentId = message.id
        headId = message.id
      }
    }

    return ExportedMessageRepository.fromBranchableArray(items, { headId })
  }, [messages])

  // Upstream (@assistant-ui 0.14 / core 0.2.x) natively supports incremental
  // `messageRepository` adapter sync — the feature the old custom
  // `useIncrementalExternalStoreRuntime` in src/lib implemented against 0.12
  // internals. The custom override crashed on 0.14 (repository.
  // appendOptimisticMessage was removed) and skipped newer runtime behaviors,
  // so it was deleted in favor of the upstream hook.
  const cancelThread = useCallback(async () => {
    await onCancel()
  }, [onCancel])

  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messageRepository: runtimeMessageRepository,
    isRunning: busy,
    setMessages: onThreadMessagesChange,
    onNew: async () => {
      // Submission is handled explicitly by ChatBar.
      // Keeping this no-op avoids duplicate prompt.submit calls.
    },
    onEdit,
    onCancel: cancelThread,
    onReload
  })

  // Drop files anywhere in the conversation area, not just on the composer
  // input — appending the same inline `@file:` ref chips the composer drop
  // produces (vs. attachment cards) so both surfaces behave identically.
  const onDropFiles = useCallback(
    (candidates: DroppedFile[]) => {
      const refs = candidates
        .map(candidate => droppedFileInlineRef(candidate, currentCwd))
        .filter((ref): ref is string => Boolean(ref))

      if (refs.length) {
        requestComposerInsert(refs.join(' '), { mode: 'inline', target: 'main' })
      }
    },
    [currentCwd]
  )

  // Dropping a sidebar session inserts an @session link the agent can resolve
  // via session_search.
  const onDropSession = useCallback((session: SessionDragPayload) => {
    requestComposerInsertRefs([sessionInlineRef(session)], { target: 'main' })
  }, [])

  const { dragKind, dropHandlers } = useFileDropZone({ enabled: showChatBar, onDropFiles, onDropSession })

  return (
    <div className={cn('relative isolate flex h-full min-w-0 flex-col overflow-hidden bg-transparent', className)}>
      <Backdrop />

      <PendingApprovalFallback />

      <div
        className="relative min-h-0 max-w-full flex-1 overflow-hidden bg-transparent contain-[layout_paint]"
        {...dropHandlers}
      >
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread
            clampToComposer={showChatBar}
            cwd={currentCwd}
            gateway={gateway}
            intro={showIntro ? { personality: introPersonality, seed: introSeed } : undefined}
            loading={threadLoading}
            onBranchInNewChat={onBranchInNewChat}
            onCancel={cancelThread}
            onDismissError={onDismissError}
            sessionId={activeSessionId}
            sessionKey={threadKey}
          />
          {showChatBar && (
            <Suspense fallback={<ChatBarFallback />}>
              <ChatBar
                busy={busy}
                cwd={currentCwd}
                disabled={!gatewayOpen}
                focusKey={activeSessionId}
                gateway={gateway}
                onAddContextRef={onAddContextRef}
                onAddUrl={onAddUrl}
                onAttachDroppedItems={onAttachDroppedItems}
                onAttachImageBlob={onAttachImageBlob}
                onCancel={onCancel}
                onPasteClipboardImage={onPasteClipboardImage}
                onPickFiles={onPickFiles}
                onPickFolders={onPickFolders}
                onPickImages={onPickImages}
                onRemoveAttachment={onRemoveAttachment}
                onSubmit={onSubmit}
                sessionId={activeSessionId}
                state={chatBarState}
              />
            </Suspense>
          )}
        </AssistantRuntimeProvider>
        {resumeExhausted && routedSessionId && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-(--ui-chat-surface-background) px-8 py-10">
            <ErrorState
              className="max-w-sm"
              description="连接本地服务失败，自动重试仍未恢复。请确认服务正在运行，然后重试。"
              title="暂时无法加载此会话"
            >
              <div className="grid justify-items-center">
                <Button onClick={() => onRetryResume(routedSessionId)} size="sm" variant="outline">
                  重试
                </Button>
              </div>
            </ErrorState>
          </div>
        )}
        <ChatDropOverlay kind={dragKind} />
      </div>
    </div>
  )
}
