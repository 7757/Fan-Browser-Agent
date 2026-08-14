import type { Unstable_TriggerAdapter, Unstable_TriggerItem } from '@assistant-ui/core'
import { ComposerPrimitive, useAui, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'

import { fanDirectiveFormatter } from '@/components/assistant-ui/directive-text'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { SLASH_COMMAND_RE } from '@/lib/chat-runtime'
import { DATA_IMAGE_URL_RE } from '@/lib/embedded-images'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { $activeBrowserControl } from '@/store/browser-control'
import { $composerAttachments, clearComposerAttachments } from '@/store/composer'
import { $controlRequest, $verificationRequest } from '@/store/prompts'
import { $gatewayState } from '@/store/session'
import { $threadScrolledUp } from '@/store/thread-scroll'

import { extractDroppedFiles, FAN_PATHS_MIME } from '../hooks/use-composer-actions'

import { AttachmentList } from './attachments'
import { BrowserPausePrompt } from './browser-pause-prompt'
import { ContextMenu } from './context-menu'
import { AutoReviewPill, ComposerControls } from './controls'
import { COMPOSER_DROP_ACTIVE_CLASS, COMPOSER_DROP_FADE_CLASS } from './drop-affordance'
import {
  type ComposerInsertMode,
  focusComposerInput,
  markActiveComposer,
  onComposerFocusRequest,
  onComposerInsertRefsRequest,
  onComposerInsertRequest
} from './focus'
import { FollowTab } from './follow-tab'
import { HelpHint } from './help-hint'
import { useAtCompletions } from './hooks/use-at-completions'
import { useSlashCompletions } from './hooks/use-slash-completions'
import {
  dragHasAttachments,
  droppedFileInlineRef,
  type InlineRefInput,
  insertInlineRefsIntoEditor
} from './inline-refs'
import {
  composerPlainText,
  deleteChipBeforeCaret,
  deleteSelectionInEditor,
  insertPlainTextAtCaret,
  normalizeComposerEditorDom,
  placeCaretEnd,
  refChipElement,
  renderComposerContents,
  RICH_INPUT_SLOT
} from './rich-editor'
import { detectTrigger, extractClipboardImageBlobs, textBeforeCaret, type TriggerState } from './text-utils'
import { ComposerTriggerPopover } from './trigger-popover'
import type { ChatBarProps } from './types'
import { UrlDialog } from './url-dialog'

const COMPOSER_STACK_BREAKPOINT_PX = 320

// A single editor line is ~28px (--composer-input-min-height 1.625rem + 0.5rem
// vertical padding). Anything taller means the text wrapped to a second line,
// which is when the composer should expand to the stacked layout.
const COMPOSER_SINGLE_LINE_MAX_PX = 36

// Resting composer placeholders. New sessions get open-ended starters; an
// existing chat gets phrasings that read as a continuation of the thread.
// One is picked at random per session (stable until the session changes).
const NEW_SESSION_PLACEHOLDERS = [
  '我们来做什么？',
  '给 Fan 分配一个任务',
  '你在想什么？',
  '描述你的需求',
  '我们要解决什么？',
  '随便问',
  '从一个目标开始'
]

const FOLLOW_UP_PLACEHOLDERS = [
  '发送后续消息',
  '补充更多上下文',
  '细化请求',
  '接下来呢？',
  '继续吧',
  '再进一步',
  '调整或继续'
]

const pickPlaceholder = (pool: readonly string[]) => pool[Math.floor(Math.random() * pool.length)]

export function ChatBar({
  busy,
  cwd,
  disabled,
  focusKey,
  gateway,
  sessionId,
  state,
  onCancel,
  onAddUrl,
  onAttachDroppedItems,
  onAttachImageBlob,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages,
  onRemoveAttachment,
  onSubmit
}: ChatBarProps) {
  const { language, t } = useI18n()
  const aui = useAui()

  const setComposerText = useCallback(
    (next: string) => {
      try {
        aui.composer().setText(next)
      } catch {
        // The assistant-ui composer core is briefly unbound during startup
        // and session switches. The draft ref/DOM sync will replay the value.
      }
    },
    [aui]
  )
  const draft = useAuiState(s => s.composer.text)
  const attachments = useStore($composerAttachments)
  const scrolledUp = useStore($threadScrolledUp)
  const activeBrowserControl = useStore($activeBrowserControl)
  const controlRequest = useStore($controlRequest)
  const verificationRequest = useStore($verificationRequest)
  // Only the normal browser-follow state gets the status strip. A pending human
  // confirmation uses BrowserPausePrompt instead, without the strip underneath.
  const followTabActive = Boolean(activeBrowserControl && !controlRequest && !verificationRequest)
  const composerRef = useRef<HTMLFormElement | null>(null)
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef(draft)
  const urlInputRef = useRef<HTMLInputElement | null>(null)

  const cancelBrowserPause = useCallback(() => onCancel(), [onCancel])

  const [urlOpen, setUrlOpen] = useState(false)
  const [urlValue, setUrlValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [tight, setTight] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [focusRequestId, setFocusRequestId] = useState(0)
  const dragDepthRef = useRef(0)
  const composingRef = useRef(false) // true during IME composition (CJK input)

  const narrow = useMediaQuery('(max-width: 30rem)')

  const at = useAtCompletions({ gateway: gateway ?? null, sessionId: sessionId ?? null, cwd: cwd ?? null })
  const slash = useSlashCompletions({ gateway: gateway ?? null })

  // VDAxc: the composer is ALWAYS two rows — input line on top, controls row
  // (attach + 自动审查 | model + send) below. The old single-row compact mode is
  // retired; expanded/narrow/tight still drive other affordances.
  // eslint-disable-next-line no-constant-binary-expression -- intentional: the composer is always stacked; operands stay referenced for intent/history.
  const stacked = true || expanded || narrow || tight
  const hasComposerPayload = draft.trim().length > 0 || attachments.length > 0
  const canSubmit = busy || hasComposerPayload
  const busyAction = busy && hasComposerPayload ? 'steer' : 'stop'
  const showHelpHint = draft === '?'

  const gatewayState = useStore($gatewayState)
  // During a reconnect (gateway dropped, e.g. backend bounce) keep the textbox
  // editable so the user can keep drafting; only submit/backend actions stay
  // disabled until the gateway is open again.
  const reconnecting = gatewayState === 'closed' || gatewayState === 'error'
  const inputDisabled = disabled && !reconnecting

  // Resting placeholder: a starter for brand-new sessions, a continuation for
  // existing ones. Picked once and only re-rolled when we genuinely move to a
  // *different* conversation. Critically, the first id assignment of a freshly
  // started session (null → id, on the first send) is treated as the same
  // conversation so the placeholder doesn't visibly flip mid-stream.
  const [restingPlaceholder, setRestingPlaceholder] = useState(() =>
    pickPlaceholder(sessionId ? FOLLOW_UP_PLACEHOLDERS : NEW_SESSION_PLACEHOLDERS)
  )

  const prevSessionIdRef = useRef(sessionId)

  useEffect(() => {
    const prev = prevSessionIdRef.current
    prevSessionIdRef.current = sessionId

    if (prev === sessionId) {
      return
    }

    // null → id: the new session we're already in just got persisted. Keep the
    // starter we showed instead of swapping to a follow-up under the user.
    if (prev == null && sessionId) {
      return
    }

    setRestingPlaceholder(pickPlaceholder(sessionId ? FOLLOW_UP_PLACEHOLDERS : NEW_SESSION_PLACEHOLDERS))
  }, [language, sessionId])

  // When the bar is disabled it's because the gateway isn't open. Distinguish a
  // cold start ("Starting Fan...") from a dropped connection we're trying to
  // restore (e.g. after the Mac slept) so the stuck state reads as recoverable.
  const placeholder = disabled
    ? reconnecting
      ? t('正在重新连接 Fan…')
      : t('正在启动 Fan...')
    : t(restingPlaceholder)

  const focusInput = useCallback(() => {
    focusComposerInput(editorRef.current)
    markActiveComposer('main')
  }, [])

  const requestMainFocus = useCallback(() => {
    setFocusRequestId(id => id + 1)
  }, [])

  const appendExternalText = useCallback(
    (text: string, mode: ComposerInsertMode) => {
      const value = text.trim()

      if (!value) {
        return
      }

      const base = mode === 'replace' ? '' : mode === 'inline' ? draftRef.current.trimEnd() : draftRef.current
      const sep =
        mode === 'replace' ? '' : mode === 'inline' ? (base ? ' ' : '') : base && !base.endsWith('\n') ? '\n\n' : ''
      const next = `${base}${sep}${value}`

      draftRef.current = next
      setComposerText(next)

      const editor = editorRef.current

      if (editor) {
        renderComposerContents(editor, next)
        placeCaretEnd(editor)
      }

      setFocusRequestId(id => id + 1)
    },
    [setComposerText]
  )

  useEffect(() => {
    if (!inputDisabled) {
      focusInput()
    }
  }, [focusInput, focusKey, focusRequestId, inputDisabled])

  useEffect(() => {
    if (inputDisabled) {
      return undefined
    }

    const offFocus = onComposerFocusRequest(target => {
      if (target === 'main') {
        setFocusRequestId(id => id + 1)
      }
    })

    const offInsert = onComposerInsertRequest(({ mode, target, text }) => {
      if (target === 'main') {
        appendExternalText(text, mode)
      }
    })

    return () => {
      offFocus()
      offInsert()
    }
  }, [appendExternalText, inputDisabled])

  // Keep draftRef in sync with the assistant-ui composer state for callers
  // that read the latest text outside the React render cycle. We don't push
  // to `$composerDraft` per keystroke any more — nobody outside the composer
  // subscribes to it (verified by grep), and the round-trip
  // `setText` ⇄ `subscribe` ⇄ `setText` was adding two useEffects to the per-
  // keystroke critical path. `reconcileComposerTerminalSelections` only
  // matters when the draft is submitted; we now call it from the submit
  // path instead.
  useEffect(() => {
    draftRef.current = draft

    const editor = editorRef.current

    if (editor && document.activeElement !== editor && composerPlainText(editor) !== draft) {
      renderComposerContents(editor, draft)
    }
  }, [draft])

  useEffect(() => {
    if (urlOpen) {
      window.requestAnimationFrame(() => urlInputRef.current?.focus({ preventScroll: true }))
    }
  }, [urlOpen])

  // Expansion (input on its own full-width row, controls below) is driven by
  // the editor's *actual* rendered height via the ResizeObserver in
  // syncComposerMetrics — it only fires when the text genuinely wraps to a
  // second line, so the layout flips exactly at the wrap point rather than at
  // a guessed character count. We only handle the two cases the observer
  // can't: an explicit newline (expand before layout settles) and an emptied
  // draft (collapse back). We never read scrollHeight per keystroke.
  useEffect(() => {
    if (!draft) {
      setExpanded(false)

      return
    }

    if (expanded) {
      return
    }

    if (draft.trimEnd().includes('\n')) {
      setExpanded(true)
    }
  }, [draft, expanded])

  // Bucket measured heights so we only invalidate the global CSS var when
  // the size crosses a meaningful threshold. Without bucketing, the editor
  // grows ~1px per character → setProperty fires every keystroke → entire
  // tree's computed style is invalidated → next paint forces a full
  // recalculate-style pass. With an 8px bucket, the invalidation rate drops
  // ~8× and small char-by-char typing produces no style invalidation at all
  // until a wrap or row change actually happens.
  const lastBucketedHeightRef = useRef(0)
  const lastBucketedSurfaceHeightRef = useRef(0)
  const lastTightRef = useRef<boolean | null>(null)

  const syncComposerMetrics = useCallback(() => {
    const composer = composerRef.current

    if (!composer) {
      return
    }

    const { height, width } = composer.getBoundingClientRect()
    const surfaceHeight = composerSurfaceRef.current?.getBoundingClientRect().height
    const root = document.documentElement

    if (width > 0) {
      const nextTight = width < COMPOSER_STACK_BREAKPOINT_PX

      if (nextTight !== lastTightRef.current) {
        lastTightRef.current = nextTight
        setTight(nextTight)
      }
    }

    // Expand once the input has actually wrapped past a single line. The
    // observer only fires on real size changes, so this reads scrollHeight at
    // most once per wrap (not per keystroke). One line ≈ 28px (1.625rem
    // min-height + padding); a second line clears ~36px. We only ever expand
    // here — collapse is handled by the emptied-draft effect to avoid
    // oscillating across the wrap boundary as the input switches widths.
    const editor = editorRef.current

    if (editor && editor.scrollHeight > COMPOSER_SINGLE_LINE_MAX_PX) {
      setExpanded(true)
    }

    if (height > 0) {
      const bucket = Math.round(height / 8) * 8

      if (bucket !== lastBucketedHeightRef.current) {
        lastBucketedHeightRef.current = bucket
        root.style.setProperty('--composer-measured-height', `${bucket}px`)
      }
    }

    if (surfaceHeight && surfaceHeight > 0) {
      const bucket = Math.round(surfaceHeight / 8) * 8

      if (bucket !== lastBucketedSurfaceHeightRef.current) {
        lastBucketedSurfaceHeightRef.current = bucket
        root.style.setProperty('--composer-surface-measured-height', `${bucket}px`)
      }
    }
  }, [])

  useResizeObserver(syncComposerMetrics, composerRef, composerSurfaceRef, editorRef)

  useEffect(() => {
    return () => {
      const root = document.documentElement
      root.style.removeProperty('--composer-measured-height')
      root.style.removeProperty('--composer-surface-measured-height')
    }
  }, [])

  const insertText = (text: string) => {
    const currentDraft = draftRef.current
    const sep = currentDraft && !currentDraft.endsWith('\n') ? '\n' : ''
    const nextDraft = `${currentDraft}${sep}${text}`

    draftRef.current = nextDraft
    setComposerText(nextDraft)

    // Push the new text into the contentEditable editor directly. Setting the
    // assistant-ui composer state alone is not enough: the draft→editor sync
    // effect only re-renders the editor when it is NOT focused
    // (document.activeElement !== editor), and the dictation/insert paths
    // typically run while the editor has (or immediately regains) focus — so
    // the store would hold the text but the visible editor would stay empty
    // and there'd be nothing to send. Mirror appendExternalText here.
    const editor = editorRef.current

    if (editor) {
      renderComposerContents(editor, nextDraft)
      placeCaretEnd(editor)
    }

    requestMainFocus()
  }

  const insertInlineRefs = (refs: InlineRefInput[]) => {
    const editor = editorRef.current

    if (!editor) {
      return false
    }

    const nextDraft = insertInlineRefsIntoEditor(editor, refs)

    if (nextDraft === null) {
      return false
    }

    draftRef.current = nextDraft
    setComposerText(nextDraft)
    requestMainFocus()

    return true
  }

  // Latest-closure ref so the (once-only) subscription always calls the current
  // insertInlineRefs without re-subscribing every render.
  const insertInlineRefsRef = useRef(insertInlineRefs)
  insertInlineRefsRef.current = insertInlineRefs

  useEffect(() => {
    return onComposerInsertRefsRequest(({ refs, target }) => {
      if (target === 'main') {
        insertInlineRefsRef.current(refs)
      }
    })
  }, [])

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const imageBlobs = extractClipboardImageBlobs(event.clipboardData)

    if (imageBlobs.length > 0) {
      event.preventDefault()

      if (onAttachImageBlob) {
        triggerHaptic('selection')

        for (const blob of imageBlobs) {
          void onAttachImageBlob(blob)
        }
      }

      return
    }

    // Trim surrounding whitespace so a copy that dragged along leading/trailing
    // blank lines (common when selecting from terminals, code blocks, web pages)
    // doesn't dump multiline padding into the composer. Internal newlines are
    // preserved — only the edges are cleaned up.
    const pastedText = event.clipboardData.getData('text').trim()

    if (!pastedText) {
      event.preventDefault()

      // A Windows-host screenshot can arrive as an empty DOM paste under
      // WSL2/WSLg. Ask the main process for its guarded host-clipboard
      // fallback, but keep a genuinely empty paste quiet.
      if (onPasteClipboardImage) {
        triggerHaptic('selection')
        void onPasteClipboardImage({ silent: true })
      }

      return
    }

    if (DATA_IMAGE_URL_RE.test(pastedText)) {
      event.preventDefault()

      return
    }

    event.preventDefault()
    // Range-based insert instead of execCommand('insertText') — Chromium's
    // contenteditable pipeline is ~O(n²) on large multiline blobs (47KB paste
    // froze ~4.5s).
    insertPlainTextAtCaret(event.currentTarget, pastedText)
    syncDraftFromEditor(event.currentTarget)
  }

  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [triggerActive, setTriggerActive] = useState(0)
  const [triggerItems, setTriggerItems] = useState<readonly Unstable_TriggerItem[]>([])
  // Set synchronously in keydown when the open trigger popover consumes a
  // navigation/control key (Arrow/Enter/Tab/Escape). The subsequent keyup must
  // NOT run refreshTrigger for that keypress: it never edits text, and for
  // Escape the keydown has already set trigger=null, so a keyup refresh would
  // re-detect the still-present `/` and instantly reopen the menu. A ref is
  // used instead of reading `trigger` in keyup because by keyup time React has
  // re-rendered and the handler closure sees the post-keydown state.
  const triggerKeyConsumedRef = useRef(false)

  const refreshTrigger = useCallback(() => {
    const editor = editorRef.current

    if (!editor) {
      return
    }

    // Fast-bail: if neither `@` nor `/` appears in the current draft, there's
    // nothing for `detectTrigger` to match. Use `textContent` (cheap browser-
    // native walk) for the precondition check rather than `composerPlainText`
    // (recursive child walk with chip-aware logic). Only when a trigger char
    // is present do we pay the cost of the full walk + DOM range work.
    const rawText = editor.textContent ?? ''

    if (!rawText.includes('@') && !rawText.includes('/')) {
      if (trigger) {
        setTrigger(null)
        setTriggerActive(0)
      }

      return
    }

    const before = textBeforeCaret(editor)
    const detected = detectTrigger(before ?? composerPlainText(editor))

    setTrigger(detected)

    // Only reset the highlight when the trigger actually changed (opened, or
    // the query/kind differs). Re-detecting the *same* trigger — e.g. on a
    // caret move (mouseup) or a stray refresh — must preserve the user's
    // current selection instead of snapping back to the first item.
    if (detected?.kind !== trigger?.kind || detected?.query !== trigger?.query) {
      setTriggerActive(0)
    }
  }, [trigger])

  // Pull the editor's plain text into the draft state (ref + assistant-ui
  // composer). Shared by the input handler and onCompositionEnd: on Windows
  // IMEs a finalizing input event is NOT guaranteed to fire after
  // compositionend, so the composition handler calls this directly — otherwise
  // the committed CJK text never reaches the draft and Enter "sends nothing"
  // until a non-IME keypress (e.g. space) triggers a fresh input event.
  const syncDraftFromEditor = (editor: HTMLDivElement) => {
    normalizeComposerEditorDom(editor)

    const nextDraft = composerPlainText(editor)

    if (nextDraft !== draftRef.current) {
      draftRef.current = nextDraft
      setComposerText(nextDraft)
    }

    window.setTimeout(refreshTrigger, 0)
  }

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    // During IME composition the DOM contains uncommitted preedit text mixed
    // with real content. Skip state writes here; onCompositionEnd syncs the
    // finalized text (a trailing input event is unreliable on Windows IMEs).
    if (composingRef.current) {
      return
    }

    syncDraftFromEditor(event.currentTarget)
  }

  const triggerAdapter: Unstable_TriggerAdapter | null =
    trigger?.kind === '@' ? at.adapter : trigger?.kind === '/' ? slash.adapter : null

  useEffect(() => {
    if (!trigger || !triggerAdapter?.search) {
      setTriggerItems([])

      return
    }

    setTriggerItems(triggerAdapter.search(trigger.query))
  }, [trigger, triggerAdapter])

  const triggerLoading = trigger?.kind === '@' ? at.loading : trigger?.kind === '/' ? slash.loading : false

  const closeTrigger = () => {
    setTrigger(null)
    setTriggerItems([])
    setTriggerActive(0)
  }

  useEffect(() => {
    setTriggerActive(idx => Math.min(idx, Math.max(0, triggerItems.length - 1)))
  }, [triggerItems.length])

  const replaceTriggerWithChip = (item: Unstable_TriggerItem) => {
    const editor = editorRef.current

    if (!editor || !trigger) {
      return
    }

    const serialized = fanDirectiveFormatter.serialize(item)
    const starter = serialized.endsWith(':')
    const text = starter || serialized.endsWith(' ') ? serialized : `${serialized} `
    const directive = !starter && serialized.match(/^@([^:]+):(.+)$/)

    const finish = () => {
      draftRef.current = composerPlainText(editor)
      setComposerText(draftRef.current)
      requestMainFocus()
      starter ? window.setTimeout(refreshTrigger, 0) : closeTrigger()
    }

    const sel = window.getSelection()
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null
    const node = range?.startContainer
    const offset = range?.startOffset ?? 0

    if (!sel || !range || node?.nodeType !== Node.TEXT_NODE || offset < trigger.tokenLength) {
      const current = composerPlainText(editor)
      renderComposerContents(editor, `${current.slice(0, Math.max(0, current.length - trigger.tokenLength))}${text}`)
      placeCaretEnd(editor)

      return finish()
    }

    const replaceRange = document.createRange()
    replaceRange.setStart(node, offset - trigger.tokenLength)
    replaceRange.setEnd(node, offset)
    replaceRange.deleteContents()

    if (directive) {
      const chip = refChipElement(directive[1], directive[2])
      const space = document.createTextNode(' ')
      const fragment = document.createDocumentFragment()
      fragment.append(chip, space)
      replaceRange.insertNode(fragment)

      const caret = document.createRange()
      caret.setStart(space, 1)
      caret.collapse(true)
      sel.removeAllRanges()
      sel.addRange(caret)

      return finish()
    }

    document.execCommand('insertText', false, text)
    finish()
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // IME composition: the Enter that confirms a composition candidate arrives
    // with isComposing=true (key "Process", keyCode 229) — ignore it so it
    // commits the candidate instead of submitting. The real send-Enter that
    // follows is a clean key="Enter"/keyCode 13/isComposing=false event and
    // falls through to the submit below. (The committed CJK text is captured in
    // onCompositionEnd via syncDraftFromEditor, not here.)
    if (event.nativeEvent.isComposing) {
      return
    }

    if (trigger && triggerItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx + 1) % triggerItems.length)

        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        setTriggerActive(idx => (idx - 1 + triggerItems.length) % triggerItems.length)

        return
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        const item = triggerItems[triggerActive]

        if (item) {
          replaceTriggerWithChip(item)
        }

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        triggerKeyConsumedRef.current = true
        closeTrigger()

        return
      }
    }

    // Delete a ref chip and its auto-inserted trailing space as one edit.
    if (
      event.key === 'Backspace' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      deleteChipBeforeCaret(event.currentTarget)
    ) {
      event.preventDefault()
      syncDraftFromEditor(event.currentTarget)

      return
    }

    // Non-collapsed Backspace/Delete: native selection-delete is ~O(n²) on large
    // drafts (Ctrl+A → Delete froze ~1.3s). Collapsed carets fall through to
    // native word/line delete.
    if (
      (event.key === 'Backspace' || event.key === 'Delete') &&
      deleteSelectionInEditor(event.currentTarget)
    ) {
      event.preventDefault()
      syncDraftFromEditor(event.currentTarget)

      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()

      // Submit actions stay blocked while disabled (incl. reconnect); the
      // textbox is still editable.
      if (disabled) {
        return
      }

      submitDraft()
    }
  }

  const handleEditorKeyUp = () => {
    // If this keyup belongs to a key the open trigger popover already consumed
    // in keydown (Arrow/Enter/Tab/Escape), skip the refresh. Those keys never
    // edit text, and for Escape the keydown already closed the menu — a refresh
    // here would re-detect the still-present `/` and instantly reopen it. We
    // read a ref set during keydown rather than `trigger`, because by keyup
    // time React has re-rendered and `trigger` may already be null.
    if (triggerKeyConsumedRef.current) {
      triggerKeyConsumedRef.current = false

      return
    }

    window.setTimeout(refreshTrigger, 0)
  }

  const resetDragState = () => {
    dragDepthRef.current = 0
    setDragActive(false)
  }

  const handleDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, FAN_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1

    if (!dragActive) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, FAN_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    resetDragState()

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (candidates.length === 0) {
      return
    }

    if (Array.from(event.dataTransfer.types || []).includes(FAN_PATHS_MIME)) {
      const refs = candidates
        .map(candidate => droppedFileInlineRef(candidate, cwd))
        .filter((ref): ref is string => Boolean(ref))

      if (insertInlineRefs(refs)) {
        triggerHaptic('selection')
      }

      return
    }

    void Promise.resolve(onAttachDroppedItems(candidates)).then(attached => {
      if (attached) {
        triggerHaptic('selection')
        requestMainFocus()
      }
    })
  }

  const handleInputDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, FAN_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleInputDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, FAN_PATHS_MIME)) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    const refs = candidates
      .map(candidate => droppedFileInlineRef(candidate, cwd))
      .filter((ref): ref is string => Boolean(ref))

    if (!refs.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetDragState()

    if (insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }
  }

  const clearDraft = useCallback(() => {
    setComposerText('')
    draftRef.current = ''

    if (editorRef.current) {
      editorRef.current.replaceChildren()
    }
  }, [setComposerText])

  const steerCurrentDraft = () => {
    const submitted = draft
    const submittedAttachments = attachments

    void Promise.resolve(onSubmit(submitted, { attachments: submittedAttachments, fromSteer: true }))
      .then(accepted => {
        if (!accepted || draftRef.current !== submitted) {
          return
        }

        const currentAttachments = $composerAttachments.get()
        const stillOwnsAttachments =
          currentAttachments.length === submittedAttachments.length &&
          currentAttachments.every((attachment, index) => attachment.id === submittedAttachments[index]?.id)

        if (!stillOwnsAttachments) {
          return
        }

        clearDraft()
        clearComposerAttachments()
        triggerHaptic('selection')
      })
      .catch(() => {
        // submit actions surface their own user-facing error; keep the draft
        // available for retry if a transport unexpectedly rejects the steer.
      })
  }

  const submitDraft = () => {
    // Submit/backend actions stay blocked while disabled (incl. reconnect),
    // even though the textbox is editable.
    if (disabled) {
      return
    }

    if (busy) {
      // Slash commands should execute immediately even while the agent is
      // busy — they're client-side operations (/yolo, /skin, /new, /help,
      // etc.) or self-contained gateway RPCs (/status, /compress).  onSubmit
      // routes them to executeSlashCommand, which has its own per-command
      // busy guard for commands that genuinely need an idle session (skill
      // /send directives).  Queuing them would make every slash command wait
      // for the current turn to finish, which is how the TUI never behaves.
      if (!attachments.length && SLASH_COMMAND_RE.test(draft.trim())) {
        const submitted = draft
        triggerHaptic('submit')
        clearDraft()
        void onSubmit(submitted)
      } else if (hasComposerPayload) {
        steerCurrentDraft()
      } else {
        triggerHaptic('cancel')
        void Promise.resolve(onCancel())
      }
    } else if (draft.trim() || attachments.length > 0) {
      const submitted = draft
      triggerHaptic('submit')
      clearDraft()
      clearComposerAttachments()
      void onSubmit(submitted, { attachments })
    }

    focusInput()
  }

  const submitUrl = () => {
    const url = urlValue.trim()

    if (!url) {
      return
    }

    if (onAddUrl) {
      onAddUrl(url)
    } else {
      insertText(`@url:${url}`)
    }

    triggerHaptic('success')
    setUrlValue('')
    setUrlOpen(false)
  }

  const contextMenu = (
    <ContextMenu
      onInsertText={insertText}
      onOpenUrlDialog={() => {
        triggerHaptic('open')
        setUrlOpen(true)
      }}
      onPasteClipboardImage={onPasteClipboardImage}
      onPickFiles={onPickFiles}
      onPickFolders={onPickFolders}
      onPickImages={onPickImages}
      state={state}
    />
  )

  const controls = (
    <ComposerControls
      busy={busy}
      busyAction={busyAction}
      canSubmit={canSubmit}
      disabled={disabled}
      hasComposerPayload={hasComposerPayload}
      state={state}
    />
  )

  const input = (
    <div className={cn('relative', stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1')}>
      <div
        aria-disabled={inputDisabled ? true : undefined}
        aria-label={t('消息')}
        autoCapitalize="off"
        autoCorrect="off"
        className={cn(
          'min-h-(--composer-input-min-height) max-h-(--composer-input-max-height) overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-transparent pb-1 pr-1 pt-1 leading-normal text-foreground outline-none disabled:cursor-not-allowed',
          'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/60',
          '**:data-ref-text:cursor-default',
          stacked && 'pl-3',
          stacked ? 'w-full' : 'min-w-(--composer-input-inline-min-width) flex-1'
        )}
        contentEditable={!inputDisabled}
        data-placeholder={placeholder}
        data-slot={RICH_INPUT_SLOT}
        onBlur={() => window.setTimeout(closeTrigger, 80)}
        onCompositionEnd={event => {
          composingRef.current = false
          // Capture the just-committed text now. The trailing input event that
          // handleEditorInput relies on does not reliably fire after an IME
          // commit on Windows, which left the draft empty so Enter sent nothing
          // until the user typed another character (e.g. space).
          syncDraftFromEditor(event.currentTarget)
        }}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onDragOver={handleInputDragOver}
        onDrop={handleInputDrop}
        onFocus={() => markActiveComposer('main')}
        onInput={handleEditorInput}
        onKeyDown={handleEditorKeyDown}
        onKeyUp={handleEditorKeyUp}
        onMouseUp={refreshTrigger}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        spellCheck="true"
        suppressContentEditableWarning
      />
      {/* assistant-ui requires ComposerPrimitive.Input somewhere in the tree
        so the composer-state binding (text + IME + paste + form-submit hookup)
        wires up. We render the real input UI ourselves above via the
        contentEditable, so the primitive is invisible (sr-only).

        IMPORTANT: don't let it render its default <TextareaAutosize>. That
        component runs `useLayoutEffect(resizeTextarea)` on every value change
        and reads `node.scrollHeight` against a hidden measurement textarea,
        forcing two synchronous layouts per keystroke for an element the
        user can't see. Profiling 400-char synthetic typing showed >900ms
        cumulative cost in getHeight2/calculateNodeHeight alone (~2.3ms/key)
        on top of the per-keystroke React commit.

        `asChild` swaps TextareaAutosize for a Radix Slot wrapping our
        plain <textarea>, which carries the binding but skips autosize. */}
      <ComposerPrimitive.Input asChild submitMode="ctrlEnter" tabIndex={-1} unstable_focusOnScrollToBottom={false}>
        <textarea aria-hidden className="sr-only" tabIndex={-1} />
      </ComposerPrimitive.Input>
    </div>
  )

  return (
    <>
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root
          className="group/composer absolute bottom-0 left-1/2 z-30 w-[min(var(--composer-width),calc(100%-var(--composer-root-inline-gap)))] max-w-full -translate-x-1/2 rounded-[1.5rem] pt-2 pb-[var(--composer-shell-pad-block-end)]"
          data-drag-active={dragActive ? '' : undefined}
          data-follow-tab-active={followTabActive ? '' : undefined}
          data-slot="composer-root"
          data-thread-scrolled-up={scrolledUp ? '' : undefined}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onSubmit={e => {
            e.preventDefault()

            if (composingRef.current) {
              return
            }

            submitDraft()
          }}
          ref={composerRef}
        >
          {showHelpHint && <HelpHint />}
          {trigger && (
            <ComposerTriggerPopover
              activeIndex={triggerActive}
              items={triggerItems}
              kind={trigger.kind}
              loading={triggerLoading}
              onHover={setTriggerActive}
              onPick={replaceTriggerWithChip}
            />
          )}
          <FollowTab />
          <div className="relative w-full rounded-[inherit]">
            <div
              className={cn(
                'relative z-4 isolate rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] shadow-composer transition-[border-color,box-shadow] duration-200 ease-out',
                COMPOSER_DROP_FADE_CLASS,
                'group-focus-within/composer:border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(45%*var(--composer-ring-strength)),transparent)] group-focus-within/composer:shadow-composer-focus',
                'group-has-data-[state=open]/composer:border-t-transparent',
                'group-has-data-[state=open]/composer:shadow-[0_0.0625rem_0_0.0625rem_color-mix(in_srgb,var(--dt-composer-ring)_calc(35%*var(--composer-ring-strength)),transparent),0_0.5rem_1.5rem_color-mix(in_srgb,var(--shadow-ink)_6%,transparent)]',
                dragActive && COMPOSER_DROP_ACTIVE_CLASS
              )}
              data-slot="composer-surface"
              ref={composerSurfaceRef}
            >
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
                  'bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)]',
                  'transition-[background-color] duration-150 ease-out',
                  'group-data-[thread-scrolled-up]/composer:bg-[color-mix(in_srgb,var(--dt-card)_48%,transparent)]',
                  'group-focus-within/composer:bg-[color-mix(in_srgb,var(--dt-card)_85%,transparent)]'
                )}
              />
              <div
                className={cn(
                  'relative z-1 flex min-h-0 w-full flex-col gap-(--composer-row-gap) overflow-hidden rounded-[inherit] px-(--composer-surface-pad-x) pt-(--composer-surface-pad-y) pb-[0.875rem] transition-opacity duration-200 ease-out',
                  scrolledUp
                    ? 'opacity-30 group-hover/composer:opacity-100 group-focus-within/composer:opacity-100'
                    : 'opacity-100'
                )}
                data-slot="composer-fade"
              >
                <BrowserPausePrompt gateway={gateway} onCancel={cancelBrowserPause} />
                {attachments.length > 0 && <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />}
                {/* Toolbar: input on top, then a space-between row — left tools
                    (attach + 自动审查) vs right controls (model chip + send), per
                    the Pencil composer (h6hSoG). justify-between + min-w-0 on the
                    left group keeps the two pills apart instead of overlapping in
                    a narrow composer. */}
                <div className="flex w-full flex-col gap-(--composer-row-gap)">
                  <div className="min-w-0">{input}</div>
                  {/* Single row: left tools (attach + 自动审查) vs right controls
                      (model chip + send, pushed right by ml-auto). The model name
                      is width-capped + truncated (see model-chip) so the row fits
                      without cramming; the left group stays content-width so the
                      自动审查 pill never overflows into the model chip. */}
                  <div className="flex items-center gap-(--composer-control-gap)">
                    <div className="flex items-center gap-2.5">
                      {contextMenu}
                      <AutoReviewPill />
                    </div>
                    {controls}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>

      <UrlDialog
        inputRef={urlInputRef}
        onChange={setUrlValue}
        onOpenChange={setUrlOpen}
        onSubmit={submitUrl}
        open={urlOpen}
        value={urlValue}
      />
    </>
  )
}

export function ChatBarFallback() {
  return (
    <div
      className={cn(
        'group/composer absolute bottom-0 left-1/2 z-30 w-[min(var(--composer-width),calc(100%-var(--composer-root-inline-gap)))] max-w-full -translate-x-1/2 rounded-[1.5rem] pt-2 pb-[var(--composer-shell-pad-block-end)]'
      )}
      data-slot="composer-root"
    >
      <div className="composer-fallback-surface relative isolate h-(--composer-fallback-height) w-full rounded-[inherit] border border-[color-mix(in_srgb,var(--dt-composer-ring)_calc(18%*var(--composer-ring-strength)),var(--dt-input))] shadow-composer">
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 -z-10 rounded-[inherit]',
            'bg-[color-mix(in_srgb,var(--dt-card)_72%,transparent)]',
            'transition-[background-color] duration-150 ease-out',
            'group-data-[thread-scrolled-up]/composer:bg-[color-mix(in_srgb,var(--dt-card)_48%,transparent)]',
            'group-focus-within/composer:bg-[color-mix(in_srgb,var(--dt-card)_85%,transparent)]'
          )}
        />
      </div>
    </div>
  )
}
