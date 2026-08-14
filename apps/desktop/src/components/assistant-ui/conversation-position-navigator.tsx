import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useMediaQuery } from '@/hooks/use-media-query'
import { triggerHaptic } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { $effectiveSessionLayoutMode } from '@/store/session-layout'

import { MarkdownTextContent } from './markdown-text'

const MIN_TURNS = 4
const NAVIGATION_IDLE_MS = 900
const SCROLLABLE_THRESHOLD_PX = 12
const PREVIEW_CLOSE_MS = 140
const PREVIEW_TRANSITION_MS = 150
const PREVIEW_TEXT_LIMIT = 240
const PREVIEW_HALF_HEIGHT = 52

export interface ConversationTurnPosition {
  groupIndex: number
  id: string
  messageIndices: number[]
}

interface NavigatorSnapshot {
  activeIndex: number
  bottomInset: number
  scrollable: boolean
  visibleIndices: number[]
  viewportHeight: number
}

interface ConversationPositionNavigatorProps {
  onNavigate: (groupIndex: number) => void
  scrollerRef: RefObject<HTMLDivElement | null>
  turns: readonly ConversationTurnPosition[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
}

const INITIAL_SNAPSHOT: NavigatorSnapshot = {
  activeIndex: 0,
  bottomInset: 0,
  scrollable: false,
  visibleIndices: [],
  viewportHeight: 0
}

interface ConversationPreview {
  prompt: string
  response: string
  running: boolean
}

function contentPreview(content: unknown, limit: number = PREVIEW_TEXT_LIMIT, preserveMarkdown = false): string {
  if (typeof content === 'string') {
    const normalized = preserveMarkdown ? content.replace(/\r\n?/g, '\n').trim() : content.replace(/\s+/g, ' ').trim()

    return normalized.slice(0, limit)
  }

  if (!Array.isArray(content)) {
    return ''
  }

  let text = ''

  for (const part of content) {
    if (typeof part === 'string') {
      text += part
    } else if (part && typeof part === 'object') {
      const row = part as { text?: unknown; type?: unknown }

      if ((!row.type || row.type === 'text') && typeof row.text === 'string') {
        text += row.text
      }
    }

    if (text.length >= limit) {
      break
    }
  }

  const normalized = preserveMarkdown ? text.replace(/\r\n?/g, '\n').trim() : text.replace(/\s+/g, ' ').trim()

  return normalized.slice(0, limit)
}

function markdownAccessibleText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameSnapshot(left: NavigatorSnapshot, right: NavigatorSnapshot): boolean {
  return (
    left.activeIndex === right.activeIndex &&
    left.bottomInset === right.bottomInset &&
    left.scrollable === right.scrollable &&
    left.viewportHeight === right.viewportHeight &&
    left.visibleIndices.length === right.visibleIndices.length &&
    left.visibleIndices.every((value, index) => value === right.visibleIndices[index])
  )
}

function readComposerInset(scroller: HTMLDivElement): {
  bottomInset: number
  composer: HTMLElement | null
  scope: HTMLElement | null
} {
  let scope = scroller.parentElement

  while (scope && scope !== document.body) {
    const composer = scope.querySelector<HTMLElement>('[data-slot="composer-root"]')

    if (composer) {
      const scrollerRect = scroller.getBoundingClientRect()
      const composerRect = composer.getBoundingClientRect()

      return {
        bottomInset: Math.max(0, Math.min(scroller.clientHeight, scrollerRect.bottom - composerRect.top)),
        composer,
        scope
      }
    }

    scope = scope.parentElement
  }

  return { bottomInset: 0, composer: null, scope: null }
}

function readSnapshot(
  scroller: HTMLDivElement,
  turns: readonly ConversationTurnPosition[],
  virtualizer: Virtualizer<HTMLDivElement, Element>
): NavigatorSnapshot {
  if (turns.length === 0) {
    return INITIAL_SNAPSHOT
  }

  const viewportTop = scroller.scrollTop
  const scrollBottom = viewportTop + scroller.clientHeight
  const { bottomInset } = readComposerInset(scroller)
  const readableHeight = Math.max(0, scroller.clientHeight - bottomInset)
  const viewportBottom = viewportTop + readableHeight
  const readingLine = viewportTop + Math.min(readableHeight * 0.28, 180)
  const firstVisibleGroup = virtualizer.getVirtualItemForOffset(viewportTop + 4)?.index ?? 0

  const lastVisibleGroup =
    virtualizer.getVirtualItemForOffset(Math.max(viewportTop + 4, viewportBottom - 4))?.index ?? firstVisibleGroup

  const readingGroup = virtualizer.getVirtualItemForOffset(readingLine)?.index ?? firstVisibleGroup

  const visibleIndices = turns.flatMap((turn, turnIndex) =>
    turn.groupIndex >= firstVisibleGroup && turn.groupIndex <= lastVisibleGroup ? [turnIndex] : []
  )

  let activeIndex = 0

  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index].groupIndex > readingGroup) {
      break
    }

    activeIndex = index
  }

  if (scroller.scrollHeight - scrollBottom <= 4) {
    activeIndex = turns.length - 1
  }

  if (visibleIndices.length === 0) {
    visibleIndices.push(activeIndex)
  }

  return {
    activeIndex,
    bottomInset,
    scrollable: turns.length >= MIN_TURNS && scroller.scrollHeight - scroller.clientHeight > SCROLLABLE_THRESHOLD_PX,
    visibleIndices,
    viewportHeight: scroller.clientHeight
  }
}

function tickWidth(
  index: number,
  pointerY: number | null,
  trackHeight: number,
  turnCount: number,
  current: boolean,
  reducedMotion: boolean
): number {
  if (pointerY === null || reducedMotion || turnCount === 0) {
    return current ? 7 : 6
  }

  const tickCenter = ((index + 0.5) / turnCount) * trackHeight
  const proximity = Math.max(0, 1 - Math.abs(tickCenter - pointerY) / 34)
  const smoothProximity = proximity * proximity * (3 - 2 * proximity)

  return 6 + 20 * smoothProximity
}

interface ConversationPreviewCardProps {
  anchorY: number
  id: string
  latest: boolean
  onCloseSoon: () => void
  onKeepOpen: () => void
  open: boolean
  reducedMotion: boolean
  turn: ConversationTurnPosition
}

function ConversationPreviewCard({
  anchorY,
  id,
  latest,
  onCloseSoon,
  onKeepOpen,
  open,
  reducedMotion,
  turn
}: ConversationPreviewCardProps) {
  const [entered, setEntered] = useState(reducedMotion)

  const previewSignature = useAuiState(state => {
    let prompt = ''
    let response = ''
    let running = false

    for (const messageIndex of turn.messageIndices) {
      const message = state.thread.messages[messageIndex]

      if (!message) {
        continue
      }

      if (message.role === 'user' && !prompt) {
        prompt = contentPreview(message.content)
      } else if (message.role === 'assistant') {
        if (message.status?.type === 'running') {
          running = true
        }

        if (response.length < PREVIEW_TEXT_LIMIT) {
          const text = contentPreview(message.content, PREVIEW_TEXT_LIMIT - response.length, true)

          if (text) {
            response += `${response ? '\n\n' : ''}${text}`
          }
        }
      }
    }

    running ||= latest && state.thread.isRunning && !response

    return JSON.stringify({ prompt, response, running } satisfies ConversationPreview)
  })

  const preview = useMemo(() => JSON.parse(previewSignature) as ConversationPreview, [previewSignature])
  const response = preview.response || (preview.running ? 'Fan 正在回复…' : '本轮暂无文字回复')
  const shown = open && entered

  useEffect(() => {
    if (reducedMotion) {
      return undefined
    }

    const frame = requestAnimationFrame(() => setEntered(true))

    return () => cancelAnimationFrame(frame)
  }, [reducedMotion])

  return (
    <div
      aria-hidden={!open}
      aria-label={`${preview.prompt || '附件消息'}。${markdownAccessibleText(response)}`}
      className={cn(
        'lg-menu absolute left-16 z-50 max-h-[6.5rem] min-h-[3.75rem] w-80 max-w-[calc(100vw-5rem)] origin-left overflow-hidden px-4 py-2.5 text-left',
        '-translate-y-1/2 transition-[top,opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        shown
          ? 'translate-x-0 scale-100 pointer-events-auto opacity-100'
          : '-translate-x-1 scale-[0.98] pointer-events-none opacity-0'
      )}
      data-slot="aui_conversation-position-card"
      id={id}
      onPointerEnter={onKeepOpen}
      onPointerLeave={onCloseSoon}
      role="tooltip"
      style={{ top: `${anchorY}px` }}
    >
      <span className="block truncate text-sm font-semibold leading-5 text-foreground">
        {preview.prompt || '附件消息'}
      </span>
      <div
        aria-hidden="true"
        className="pointer-events-none mt-0.5 max-h-[3.75rem] overflow-hidden text-(--ui-text-secondary)"
        data-running={preview.running ? 'true' : undefined}
        inert
      >
        <MarkdownTextContent
          containerClassName={cn(
            'text-[0.8125rem]! leading-5! text-(--ui-text-secondary)!',
            '[&_*]:leading-5! [&_h1]:my-0! [&_h2]:my-0! [&_h3]:my-0! [&_h4]:my-0!',
            '[&_h1]:text-[0.8125rem]! [&_h2]:text-[0.8125rem]! [&_h3]:text-[0.8125rem]! [&_h4]:text-[0.8125rem]!',
            '[&_ol]:my-0! [&_ul]:my-0! [&_blockquote]:my-0! [&_.aui-md-table]:my-0!'
          )}
          containerProps={{ 'data-slot': 'aui_conversation-position-preview-markdown' }}
          isRunning={preview.running}
          key={turn.id}
          text={response}
        />
      </div>
    </div>
  )
}

export function ConversationPositionNavigator({
  onNavigate,
  scrollerRef,
  turns,
  virtualizer
}: ConversationPositionNavigatorProps) {
  const layoutMode = useStore($effectiveSessionLayoutMode)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const [snapshot, setSnapshot] = useState<NavigatorSnapshot>(INITIAL_SNAPSHOT)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [pointerY, setPointerY] = useState<number | null>(null)
  const [focusWithin, setFocusWithin] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const hoveredIndexRef = useRef<number | null>(null)
  const pointerYRef = useRef<number | null>(null)
  const pointerFrameRef = useRef(0)
  const previewCloseTimerRef = useRef<number | undefined>(undefined)
  const previewUnmountTimerRef = useRef<number | undefined>(undefined)
  const visibleIndices = useMemo(() => new Set(snapshot.visibleIndices), [snapshot.visibleIndices])
  const turnIdentity = useMemo(() => turns.map(turn => turn.id).join('\n'), [turns])
  const previousTurnIdentityRef = useRef(turnIdentity)
  const visible = layoutMode === 'chat' && turns.length >= MIN_TURNS && snapshot.scrollable

  const updateHoveredIndex = useCallback((index: number | null) => {
    if (hoveredIndexRef.current !== index) {
      hoveredIndexRef.current = index
      setHoveredIndex(index)
    }

    if (index !== null) {
      window.clearTimeout(previewUnmountTimerRef.current)
      setPreviewIndex(index)
    }
  }, [])

  const keepPreviewOpen = useCallback(() => {
    window.clearTimeout(previewCloseTimerRef.current)
  }, [])

  const closePreview = useCallback(() => {
    window.clearTimeout(previewCloseTimerRef.current)

    if (pointerFrameRef.current) {
      cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = 0
    }

    pointerYRef.current = null
    setPointerY(null)
    updateHoveredIndex(null)
    window.clearTimeout(previewUnmountTimerRef.current)

    if (reducedMotion) {
      setPreviewIndex(null)
    } else {
      previewUnmountTimerRef.current = window.setTimeout(() => setPreviewIndex(null), PREVIEW_TRANSITION_MS)
    }
  }, [reducedMotion, updateHoveredIndex])

  const closePreviewSoon = useCallback(() => {
    window.clearTimeout(previewCloseTimerRef.current)
    previewCloseTimerRef.current = window.setTimeout(closePreview, PREVIEW_CLOSE_MS)
  }, [closePreview])

  const updatePointer = useCallback(
    (nextPointerY: number, index: number) => {
      pointerYRef.current = nextPointerY
      updateHoveredIndex(index)

      if (!pointerFrameRef.current) {
        pointerFrameRef.current = requestAnimationFrame(() => {
          pointerFrameRef.current = 0
          setPointerY(pointerYRef.current)
        })
      }
    },
    [updateHoveredIndex]
  )

  useEffect(
    () => () => {
      window.clearTimeout(previewCloseTimerRef.current)
      window.clearTimeout(previewUnmountTimerRef.current)

      if (pointerFrameRef.current) {
        cancelAnimationFrame(pointerFrameRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (visible) {
      return
    }

    closePreview()
    setFocusWithin(false)
    setScrolling(false)

    const focusedTick = buttonRefs.current.find(button => button === document.activeElement)
    focusedTick?.blur()
  }, [closePreview, visible])

  useEffect(() => {
    if (previousTurnIdentityRef.current === turnIdentity) {
      return
    }

    previousTurnIdentityRef.current = turnIdentity
    closePreview()
    setFocusWithin(false)

    const focusedTick = buttonRefs.current.find(button => button === document.activeElement)
    focusedTick?.blur()
  }, [closePreview, turnIdentity])

  useEffect(() => {
    const scroller = scrollerRef.current

    if (!scroller || layoutMode !== 'chat') {
      return undefined
    }

    let frame = 0
    let idleTimer: number | undefined
    let observedComposer: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null

    const syncComposerObservation = () => {
      const { composer } = readComposerInset(scroller)

      if (composer === observedComposer) {
        return
      }

      if (observedComposer) {
        resizeObserver?.unobserve?.(observedComposer)
      }

      observedComposer = composer

      if (observedComposer) {
        resizeObserver?.observe(observedComposer)
      }
    }

    const measure = () => {
      frame = 0
      syncComposerObservation()
      const next = readSnapshot(scroller, turns, virtualizer)
      setSnapshot(current => (sameSnapshot(current, next) ? current : next))
    }

    const scheduleMeasure = () => {
      if (!frame) {
        frame = requestAnimationFrame(measure)
      }
    }

    const onScroll = () => {
      setScrolling(true)
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => setScrolling(false), NAVIGATION_IDLE_MS)
      scheduleMeasure()
    }

    scheduleMeasure()
    scroller.addEventListener('scroll', onScroll, { passive: true })

    resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure)
    resizeObserver?.observe(scroller)
    syncComposerObservation()

    if (scroller.firstElementChild) {
      resizeObserver?.observe(scroller.firstElementChild)
    }

    const { scope } = readComposerInset(scroller)
    let mutationObserver: MutationObserver | null = null

    if (scope && typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(scheduleMeasure)
      mutationObserver.observe(scope, { childList: true })
    }

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.clearTimeout(idleTimer)

      if (frame) {
        cancelAnimationFrame(frame)
      }
    }
  }, [layoutMode, scrollerRef, turns, virtualizer])

  const engaged = scrolling || hoveredIndex !== null || focusWithin
  const availableHeight = Math.max(40, snapshot.viewportHeight - snapshot.bottomInset)
  const trackHeight = Math.min(turns.length * 10, Math.max(40, availableHeight - 48))
  const resolvedPreviewIndex = previewIndex ?? 0
  const previewTurn = previewIndex === null ? undefined : turns[previewIndex]
  const previewTickY = ((resolvedPreviewIndex + 0.5) / Math.max(turns.length, 1)) * trackHeight

  const previewAnchorY =
    trackHeight <= PREVIEW_HALF_HEIGHT * 2
      ? trackHeight / 2
      : Math.max(PREVIEW_HALF_HEIGHT, Math.min(trackHeight - PREVIEW_HALF_HEIGHT, previewTickY))

  const navigate = (index: number) => {
    const turn = turns[index]

    if (!visible || !turn) {
      return
    }

    triggerHaptic('selection')
    onNavigate(turn.groupIndex)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()

    if (!rect.height || turns.length === 0) {
      return
    }

    const pointerY = Math.max(0, Math.min(rect.height - 0.01, event.clientY - rect.top))
    updatePointer(pointerY, Math.floor((pointerY / rect.height) * turns.length))
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex = index

    if (event.key === 'Escape') {
      event.preventDefault()
      closePreview()

      return
    } else if (event.key === 'ArrowUp') {
      targetIndex = Math.max(0, index - 1)
    } else if (event.key === 'ArrowDown') {
      targetIndex = Math.min(turns.length - 1, index + 1)
    } else if (event.key === 'Home') {
      targetIndex = 0
    } else if (event.key === 'End') {
      targetIndex = turns.length - 1
    } else {
      return
    }

    event.preventDefault()
    keepPreviewOpen()
    pointerYRef.current = ((targetIndex + 0.5) / turns.length) * trackHeight
    setPointerY(((targetIndex + 0.5) / turns.length) * trackHeight)
    updateHoveredIndex(targetIndex)
    buttonRefs.current[targetIndex]?.focus()
    navigate(targetIndex)
  }

  const handleBlur = (event: ReactFocusEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget

    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setFocusWithin(false)
      closePreview()
    }
  }

  return (
    <nav
      aria-hidden={!visible}
      aria-label={`对话位置，共 ${turns.length} 轮`}
      className={cn(
        'absolute left-0 z-50 flex w-12 -translate-y-1/2 flex-col justify-center overflow-visible',
        'transition-[opacity,transform,visibility] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        visible
          ? cn('visible translate-x-0 pointer-events-auto', engaged ? 'opacity-100' : 'opacity-70')
          : 'invisible -translate-x-1 pointer-events-none opacity-0'
      )}
      data-engaged={engaged ? 'true' : 'false'}
      data-slot="aui_conversation-position-navigator"
      inert={!visible}
      onBlurCapture={handleBlur}
      onFocusCapture={() => setFocusWithin(true)}
      onPointerEnter={keepPreviewOpen}
      onPointerLeave={closePreviewSoon}
      role="navigation"
      style={{ height: `${trackHeight}px`, top: `${availableHeight / 2}px` }}
    >
      <ol
        className="grid h-full w-full list-none grid-flow-row p-0 m-0"
        onPointerMove={handlePointerMove}
        style={{ gridTemplateRows: `repeat(${Math.max(turns.length, 1)}, minmax(0, 1fr))` }}
      >
        {turns.map((turn, index) => {
          const current = snapshot.activeIndex === index
          const highlighted = visibleIndices.has(index) || hoveredIndex === index

          return (
            <li className="min-h-0" key={turn.id}>
              <button
                aria-current={current ? 'location' : undefined}
                aria-describedby={hoveredIndex === index ? 'aui-conversation-position-preview' : undefined}
                aria-label={`跳转到第 ${index + 1} 轮对话`}
                className="group/tick flex size-full cursor-pointer items-center justify-start pl-4 [-webkit-app-region:no-drag]"
                onClick={() => navigate(index)}
                onFocus={() => {
                  keepPreviewOpen()
                  pointerYRef.current = ((index + 0.5) / turns.length) * trackHeight
                  setPointerY(pointerYRef.current)
                  updateHoveredIndex(index)
                }}
                onKeyDown={event => handleKeyDown(event, index)}
                ref={node => {
                  buttonRefs.current[index] = node
                }}
                tabIndex={visible && current ? 0 : -1}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'block h-px rounded-full transition-[width,background-color,opacity] duration-130 ease-[cubic-bezier(0.2,0.6,0.35,1)] motion-reduce:transition-none group-focus-visible/tick:h-0.5 group-focus-visible/tick:opacity-100',
                    current
                      ? 'bg-(--ui-text-primary) opacity-95'
                      : highlighted
                        ? 'bg-[color-mix(in_srgb,var(--ui-text-primary)_72%,transparent)]'
                        : 'bg-[color-mix(in_srgb,var(--ui-text-primary)_28%,transparent)]'
                  )}
                  style={{
                    width: `${tickWidth(index, pointerY, trackHeight, turns.length, current, reducedMotion)}px`
                  }}
                />
              </button>
            </li>
          )
        })}
      </ol>
      {visible && previewTurn && (
        <ConversationPreviewCard
          anchorY={previewAnchorY}
          id="aui-conversation-position-preview"
          latest={resolvedPreviewIndex === turns.length - 1}
          onCloseSoon={closePreviewSoon}
          onKeepOpen={keepPreviewOpen}
          open={hoveredIndex !== null}
          reducedMotion={reducedMotion}
          turn={previewTurn}
        />
      )}
    </nav>
  )
}
