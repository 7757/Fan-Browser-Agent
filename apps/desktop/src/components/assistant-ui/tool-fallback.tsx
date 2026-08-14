'use client'

import { type ToolCallMessagePartProps, useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { createContext, type FC, type PropsWithChildren, type ReactNode, useContext, useMemo } from 'react'
import { useShallow } from 'zustand/shallow'

import { AnsiText } from '@/components/assistant-ui/ansi-text'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { CompactMarkdown } from '@/components/chat/compact-markdown'
import { DiffLines } from '@/components/chat/diff-lines'
import { DisclosureRow } from '@/components/chat/disclosure-row'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { ZoomableImage } from '@/components/chat/zoomable-image'
import { BrailleSpinner } from '@/components/ui/braille-spinner'
import { Codicon } from '@/components/ui/codicon'
import { CopyButton } from '@/components/ui/copy-button'
import { FadeText } from '@/components/ui/fade-text'
import { LinkifiedText as SharedLinkifiedText } from '@/lib/external-link'
import { AlertCircle, CheckCircle2 } from '@/lib/icons'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $approvalRequest } from '@/store/prompts'
import { $toolInlineDiffs } from '@/store/tool-diffs'
import { $toolDisclosureOpen, $toolViewMode, setToolDisclosureOpen } from '@/store/tool-view'

import { APPROVAL_TOOLS, PendingToolApproval } from './tool-approval'
import {
  groupCopyText as buildGroupCopyText,
  buildToolView,
  clampForDisplay,
  cleanVisibleText,
  groupPreviewTargets,
  groupStatus,
  groupStatusSummary,
  groupTitle,
  groupTotalDurationLabel,
  inlineDiffFromResult,
  isPreviewableTarget,
  looksRedundant,
  selectMessageRunning,
  stripInlineDiffChrome,
  toolCopyPayload,
  type ToolPart,
  toolPartDisclosureId,
  type ToolStatus
} from './tool-fallback-model'

// Tool names that ChainToolFallback intercepts and renders as something
// other than a ToolEntry — they don't count toward "is this a group of
// tool calls?" because they have no visible tool block.
const SPECIAL_TOOL_NAMES = new Set(['todo', 'collect'])

// `true` when the current ToolEntry is being rendered inside a group
// wrapper. Lets ToolEntry suppress per-row chrome (timer / preview) that
// the group already shows.
const ToolEmbedContext = createContext(false)

// Shared header chrome for tool rows. Both the single-tool DisclosureRow
// and the multi-tool group header pass through these constants so a
// "Patch" row and a "Tool actions · 2 steps" row are visually identical.
const TOOL_HEADER_TITLE_CLASS =
  'text-[length:var(--conversation-tool-font-size)] font-medium leading-(--conversation-line-height) text-(--ui-text-secondary)'

const TOOL_HEADER_DURATION_CLASS = 'shrink-0 text-[0.625rem] tabular-nums text-(--ui-text-tertiary)'

const TOOL_HEADER_SUBTITLE_CLASS =
  'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)'

const TOOL_HEADER_GLYPH_WRAP_CLASS = 'grid size-3.5 shrink-0 place-items-center self-center'

// Liquid Glass output-area recipe — Pencil b8iff diUi0 (Code Output Card):
// OUTPUT-style mono micro label + the tinted inset output surface
// (#22325C0A on glass, top highlight) that carries the payload text.
const TOOL_SECTION_LABEL_CLASS =
  'mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.8px] text-(--bwa-text-muted)'

// Inset scroll surface for any detail body — the design's tinted output area
// on the expanded glass card (rounded, faint navy tint, highlight seam).
const TOOL_SECTION_SURFACE_CLASS =
  'max-h-20 max-w-full overflow-auto rounded-[12px] bg-[#22325C0A] px-2.5 py-2 text-(--bwa-text-secondary) shadow-(--lg-inset-highlight) dark:bg-white/[0.04]'

const TOOL_SECTION_PRE_CLASS = cn(TOOL_SECTION_SURFACE_CLASS, 'font-mono text-[11.5px] leading-relaxed')

function rawTechnicalTrace(args: unknown, result: unknown): string {
  const parts = [args, result]
    .filter(value => value !== undefined && value !== null)
    .map(value => {
      if (typeof value === 'string') {
        return value
      }

      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .filter(Boolean)

  return clampForDisplay(parts.join('\n'))
}

function statusGlyph(status: ToolStatus): ReactNode {
  if (status === 'running') {
    return (
      <BrailleSpinner
        ariaLabel="运行中"
        className="size-3.5 shrink-0 text-[0.95rem] text-(--ui-text-tertiary)"
        spinner="breathe"
      />
    )
  }

  if (status === 'error') {
    return <AlertCircle aria-label="错误" className="size-3.5 shrink-0 text-destructive" />
  }

  if (status === 'warning') {
    return <AlertCircle aria-label="需要注意" className="size-3.5 shrink-0 text-(--ui-yellow)" />
  }

  return <CheckCircle2 aria-label="完成" className="size-3.5 shrink-0 text-(--ui-green)/85" />
}

// Leading glyph for any tool-row header. Status (running/error/warning)
// takes precedence; otherwise falls back to the tool's codicon. Returns
// null when neither applies so callers can render unconditionally.
function ToolGlyph({ icon, status }: { icon?: string; status?: ToolStatus }) {
  const node = status ? (
    statusGlyph(status)
  ) : icon ? (
    <Codicon className="text-(--ui-text-tertiary)" name={icon} size="0.875rem" />
  ) : null

  return node ? <span className={TOOL_HEADER_GLYPH_WRAP_CLASS}>{node}</span> : null
}

// Which status (if any) should pre-empt the tool's icon in the leading
// slot. Success is silent — the row reads as "done" without a checkmark.
function leadingStatus(isPending: boolean, status: ToolStatus): ToolStatus | undefined {
  if (isPending) {
    return 'running'
  }

  return status === 'success' ? undefined : status
}

function LinkifiedText({ className, text }: { className?: string; text: string }) {
  // explicitOnly: tool error/output text is full of filename/path/stack tokens
  // (agent.log, config.yaml, package.json, main.py:1) that the bare-domain
  // autolinker would turn into clickable https://… links opening a browser tab.
  // Match thread.tsx's system/slash rendering and only linkify real http(s)/www URLs.
  return <SharedLinkifiedText className={className} explicitOnly pretty text={cleanVisibleText(text)} />
}

interface ToolEntryProps {
  part: ToolPart
}

function useDisclosureOpen(disclosureId: string, fallbackOpen = false): boolean {
  const persistedOpen = useStore($toolDisclosureOpen(disclosureId))

  return persistedOpen ?? fallbackOpen
}

function ToolEntry({ part }: ToolEntryProps) {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)
  const embedded = useContext(ToolEmbedContext)
  const toolViewMode = useStore($toolViewMode)
  const disclosureId = `tool-entry:${messageId}:${toolPartDisclosureId(part)}`
  const open = useDisclosureOpen(disclosureId)
  const isPending = messageRunning && part.result === undefined
  // Only animate entries that mount while their message is actively
  // streaming — historical sessions mount with `messageRunning === false`,
  // so they paint statically without a settle cascade. The wrapping group
  // handles its own enter animation, so embedded children skip it.
  const enterRef = useEnterAnimation(messageRunning && !embedded, `tool-entry:${disclosureId}`)
  const elapsed = useElapsedSeconds(isPending, `tool:${disclosureId}`)
  const liveDiffs = useStore($toolInlineDiffs)
  const sideDiff = part.toolCallId ? liveDiffs[part.toolCallId] || '' : ''
  const inlineDiff = stripInlineDiffChrome(sideDiff) || inlineDiffFromResult(part.result)

  // Stale parts (no result, but message stopped running) get a synthetic
  // empty result so buildToolView treats them as completed-no-output.
  const view = useMemo(() => {
    const p = !isPending && part.result === undefined ? { ...part, result: {} } : part

    return buildToolView(p, inlineDiff)
  }, [inlineDiff, isPending, part])

  const detailSections = useMemo(() => {
    if (!view.detail) {
      return { body: '', summary: '' }
    }

    if (view.status !== 'error') {
      return { body: view.detail, summary: '' }
    }

    const chunks = view.detail
      .split(/\n\s*\n+/)
      .map(chunk => chunk.trim())
      .filter(Boolean)

    const [summary = '', ...rest] = chunks
    const subtitleNorm = view.subtitle.trim().toLowerCase()
    const summaryDuplicatesSubtitle = summary && summary.toLowerCase() === subtitleNorm

    if (summaryDuplicatesSubtitle) {
      return { body: rest.join('\n\n').trim(), summary: '' }
    }

    return { body: rest.join('\n\n').trim(), summary }
  }, [view.detail, view.status, view.subtitle])

  const detailMatchesSubtitle = looksRedundant(view.subtitle, view.detail)
  const showStatusSubtitle =
    !isPending &&
    (view.status === 'warning' || view.status === 'error') &&
    Boolean(view.subtitle) &&
    !looksRedundant(view.title, view.subtitle)

  const showDetail =
    (view.status === 'error' && Boolean(detailSections.summary || detailSections.body)) ||
    (view.status !== 'error' &&
      Boolean(view.detail) &&
      !looksRedundant(view.title, view.detail) &&
      !detailMatchesSubtitle)

  const renderDetailAsCode =
    view.status !== 'error' &&
    (part.toolName === 'terminal' || part.toolName === 'execute_code' || part.toolName === 'read_file')

  const hasExpandableContent = Boolean(
    (view.previewTarget && isPreviewableTarget(view.previewTarget)) ||
    view.imageUrl ||
    showDetail ||
    toolViewMode === 'technical'
  )

  const copyAction = useMemo(() => toolCopyPayload(part, view), [part, view])

  // The header trailing slot carries the live duration timer while running.
  // Copy normally lives in the expanded body's top-right (so it doesn't straddle
  // the disclosure caret —. But a NON-expandable, settled
  // row (onToggle undefined → can't open → body with the copy button never
  // renders) would otherwise lose its copy button entirely, so restore a header
  // copy button just for that case (matches the pre-move behavior for those rows).
  const trailing =
    isPending && !embedded ? (
      <ActivityTimerText className={TOOL_HEADER_DURATION_CLASS} seconds={elapsed} />
    ) : !isPending && !hasExpandableContent && copyAction.text ? (
      <CopyButton appearance="tool-row" label={copyAction.label} stopPropagation text={copyAction.text} />
    ) : undefined

  return (
    <div
      className={cn(
        'min-w-0 max-w-full text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)',
        // Expanded tool = Liquid Glass card (Pencil b8iff diUi0); collapsed
        // keeps the quiet row so the transcript doesn't become a wall of cards.
        // Inside an expanded group the card is ALREADY glass — a nested entry
        // gets a flat inset panel instead of stacking a second backdrop blur.
        // overflow-hidden only when card chrome needs radius clipping — a
        // resting row must NOT clip: the pending ApprovalBar (a glass card
        // itself) renders inside this box and its shadow would square off.
        open && (embedded ? 'overflow-hidden rounded-[12px] border border-(--lg-divider)' : 'lg-card overflow-hidden')
      )}
      data-slot="tool-block"
      ref={enterRef}
    >
      <div className={cn(open && 'border-b border-(--lg-divider) px-3 py-1.5')}>
        <DisclosureRow
          onToggle={hasExpandableContent ? () => setToolDisclosureOpen(disclosureId, !open) : undefined}
          open={open}
          trailing={trailing}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ToolGlyph icon={view.icon} status={leadingStatus(isPending, view.status)} />
            <FadeText
              className={cn(
                TOOL_HEADER_TITLE_CLASS,
                isPending && 'shimmer text-(--ui-text-tertiary)',
                view.status === 'error' && 'text-destructive',
                view.status === 'warning' && 'text-(--ui-yellow)'
              )}
            >
              {view.title}
            </FadeText>
            {!isPending && view.countLabel && <span className={TOOL_HEADER_DURATION_CLASS}>{view.countLabel}</span>}
            {!isPending && view.durationLabel && (
              <span className={TOOL_HEADER_DURATION_CLASS}>{view.durationLabel}</span>
            )}
          </span>
          {showStatusSubtitle && (
            <FadeText
              className={cn(
                TOOL_HEADER_SUBTITLE_CLASS,
                view.status === 'warning' ? 'text-(--ui-yellow)/85' : 'text-destructive/85'
              )}
              title={view.subtitle}
            >
              {view.subtitle}
            </FadeText>
          )}
        </DisclosureRow>
      </div>
      {isPending && <PendingToolApproval part={part} />}
      {open && (
        <div className="relative grid w-full min-w-0 max-w-full gap-1.5 overflow-hidden px-3 py-2.5">
          {copyAction.text && (
            <CopyButton
              appearance="inline"
              className="lg-icon-btn absolute right-1.5 top-1.5 z-10 size-6 gap-0 p-0 opacity-60 hover:opacity-100 focus-visible:opacity-100"
              iconClassName="size-3"
              label={copyAction.label}
              showLabel={false}
              stopPropagation
              text={copyAction.text}
            />
          )}
          {!embedded && view.previewTarget && isPreviewableTarget(view.previewTarget) && (
            <PreviewAttachment source="tool-result" target={view.previewTarget} />
          )}
          {view.imageUrl && (
            <div className="max-w-72 overflow-hidden rounded-xs border border-(--ui-stroke-tertiary)">
              <ZoomableImage alt="工具输出" className="h-auto w-full object-cover" src={view.imageUrl} />
            </div>
          )}
          {showDetail &&
            toolViewMode !== 'technical' &&
            (view.status === 'error' ? (
              detailSections.summary || detailSections.body ? (
                // Error payloads sit on the same tinted inset surface as any
                // other output (b8iff diUi0), just with destructive text.
                <div className="max-w-full text-xs leading-relaxed text-destructive">
                  {detailSections.summary && (
                    <LinkifiedText className="block font-medium" text={detailSections.summary} />
                  )}
                  {detailSections.body && (
                    <pre
                      className={cn(
                        TOOL_SECTION_SURFACE_CLASS,
                        'max-h-56 whitespace-pre-wrap wrap-anywhere font-mono text-[11.5px] leading-[1.55] text-destructive/90',
                        detailSections.summary && 'mt-1.5'
                      )}
                    >
                      {clampForDisplay(detailSections.body)}
                    </pre>
                  )}
                </div>
              ) : null
            ) : view.stdout || view.stderr ? (
              // Stdout + stderr split: render both as labeled blocks. stderr
              // is intentionally NOT painted destructive — many CLIs log
              // informational output there.
              <div className="max-w-full text-xs leading-relaxed text-(--ui-text-secondary)">
                {view.detailLabel && <p className={TOOL_SECTION_LABEL_CLASS}>{view.detailLabel}</p>}
                {view.stdout && (
                  <div className="space-y-0.5">
                    {view.stderr && <p className={TOOL_SECTION_LABEL_CLASS}>stdout</p>}
                    <pre className={cn(TOOL_SECTION_PRE_CLASS, 'whitespace-pre-wrap wrap-anywhere')}>
                      {view.rendersAnsi ? <AnsiText text={clampForDisplay(view.stdout)} /> : clampForDisplay(view.stdout)}
                    </pre>
                  </div>
                )}
                {view.stderr && (
                  <div className={cn('space-y-0.5', view.stdout && 'mt-1.5')}>
                    <p className={TOOL_SECTION_LABEL_CLASS}>stderr</p>
                    <pre
                      className={cn(
                        TOOL_SECTION_PRE_CLASS,
                        'whitespace-pre-wrap wrap-anywhere text-(--ui-text-tertiary)'
                      )}
                    >
                      {view.rendersAnsi ? <AnsiText text={clampForDisplay(view.stderr)} /> : clampForDisplay(view.stderr)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="max-w-full text-xs leading-relaxed text-(--ui-text-secondary)">
                {view.detailLabel && <p className={TOOL_SECTION_LABEL_CLASS}>{view.detailLabel}</p>}
                {renderDetailAsCode ? (
                  <pre className={cn(TOOL_SECTION_PRE_CLASS, 'whitespace-pre-wrap wrap-anywhere')}>
                    {view.rendersAnsi ? <AnsiText text={clampForDisplay(view.detail)} /> : clampForDisplay(view.detail)}
                  </pre>
                ) : (
                  <CompactMarkdown
                    className={cn(TOOL_SECTION_SURFACE_CLASS, 'wrap-anywhere')}
                    text={clampForDisplay(view.detail)}
                  />
                )}
              </div>
            ))}
          {toolViewMode === 'technical' && (
            <pre className={cn(TOOL_SECTION_PRE_CLASS, 'whitespace-pre-wrap wrap-anywhere')}>
              {rawTechnicalTrace(part.args, part.result)}
            </pre>
          )}
        </div>
      )}
      {/* When the card is open the diff joins the padded gutter; collapsed it
          renders flush as before (there is no card chrome to collide with). */}
      {view.inlineDiff && (
        <div className={cn(open && 'px-3 pb-2.5')}>
          <DiffLines text={view.inlineDiff} />
        </div>
      )}
    </div>
  )
}

/**
 * Always-present wrapper around the consecutive tool-call range that
 * `MessagePrimitive.Parts` already grouped for us. Renders a header +
 * collapsible body when there are 2+ visible tools; otherwise it's a
 * transparent passthrough that just owns the entry animation for the
 * single ToolEntry inside.
 *
 * Crucially, the wrapper element is the SAME `<div>` regardless of
 * group size — only the optional header element appears/disappears.
 * That preserves React identity for the inner `MessagePartByIndex`
 * children when the 1→2 transition happens, so existing tool blocks
 * never remount when a new tool joins them mid-stream.
 *
 * The previous design (per-tool ToolFallback computing its own group
 * lookup and conditionally returning either `<ToolEntry>` or
 * `<ToolGroup>`) flipped the React element type at the 1→2 transition
 * and tore down the existing tool entirely, which is what showed up as
 * "the previous tool's animation resets every time a new tool arrives."
 */
export const ToolGroupSlot: FC<PropsWithChildren<{ endIndex: number; startIndex: number }>> = ({
  children,
  endIndex,
  startIndex
}) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(selectMessageRunning)

  // Pull the visible tool parts in this range. `useShallow` makes this
  // re-render only when the actual part references change (assistant-ui
  // gives stable refs for unchanged parts), not on every text/reasoning
  // delta elsewhere in the message.
  const visibleParts = useAuiState(
    useShallow((s: { message: { parts: readonly unknown[] } }) =>
      s.message.parts.slice(startIndex, endIndex + 1).filter((p): p is ToolPart => {
        if (!p || typeof p !== 'object') {
          return false
        }

        const row = p as { toolName?: unknown; type?: unknown }

        return row.type === 'tool-call' && typeof row.toolName === 'string' && !SPECIAL_TOOL_NAMES.has(row.toolName)
      })
    )
  )

  const isGroup = visibleParts.length > 1
  const isRunning = messageRunning && visibleParts.some(p => p.result === undefined)
  // Stable across the group's lifetime (start index doesn't shift when
  // tools append to the end), so user-driven open/close persists across
  // streaming.
  const disclosureId = `tool-group:${messageId}:${startIndex}`
  const userOpen = useDisclosureOpen(disclosureId)

  // A live approval request must NEVER be buried inside a collapsed group —
  // the user has to be able to act on it without first expanding "Tool
  // actions · N steps". When an approval is in flight and this group hosts
  // the pending approval-eligible tool that raised it (terminal /
  // execute_code with no result yet — see tool-approval.tsx for why the
  // single pending row IS the one that raised it), force the body open so
  // the inline ApprovalBar surfaces. The user can still collapse the group
  // again once the approval resolves.
  const approvalRequest = useStore($approvalRequest)

  const hostsLiveApproval =
    approvalRequest !== null &&
    messageRunning &&
    visibleParts.some(p => p.result === undefined && APPROVAL_TOOLS.has(p.toolName))

  const open = userOpen || hostsLiveApproval
  const enterRef = useEnterAnimation(messageRunning, disclosureId)

  const status = groupStatus(visibleParts)
  const displayStatus = !isRunning && status === 'running' ? 'success' : status
  const totalDurationLabel = useMemo(() => groupTotalDurationLabel(visibleParts), [visibleParts])
  const statusSummary = useMemo(
    () => (displayStatus === 'running' ? '' : groupStatusSummary(visibleParts)),
    [displayStatus, visibleParts]
  )

  const groupCopyText = useMemo(() => buildGroupCopyText(visibleParts), [visibleParts])
  const previewTargets = useMemo(() => groupPreviewTargets(visibleParts), [visibleParts])

  return (
    <ToolEmbedContext.Provider value={isGroup}>
      {/* Expanded group = Liquid Glass card (Pencil b8iff KnPRd Multi-Tool
          Card): glass surface, header row, hairline-divided tool rows. */}
      <div
        className={cn('min-w-0 max-w-full', isGroup && open && 'lg-card overflow-hidden')}
        data-slot="tool-block"
        ref={enterRef}
      >
        {isGroup && (
          <DisclosureRow
            className={cn(open && 'px-3 pt-2')}
            key="header"
            onToggle={() => setToolDisclosureOpen(disclosureId, !open)}
            open={open}
            trailing={
              !isRunning && groupCopyText ? (
                <CopyButton appearance="tool-row" label="复制活动" stopPropagation text={groupCopyText} />
              ) : undefined
            }
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ToolGlyph status={displayStatus === 'success' ? undefined : displayStatus} />
              <FadeText
                className={cn(
                  TOOL_HEADER_TITLE_CLASS,
                  displayStatus === 'error' && 'text-destructive',
                  displayStatus === 'warning' && 'text-(--ui-yellow)'
                )}
              >
                {groupTitle(visibleParts)}
              </FadeText>
              {totalDurationLabel && <span className={TOOL_HEADER_DURATION_CLASS}>{totalDurationLabel}</span>}
            </span>
            {statusSummary && (
              <FadeText
                className={cn(
                  TOOL_HEADER_SUBTITLE_CLASS,
                  displayStatus === 'warning' ? 'text-(--ui-yellow)/85' : 'text-destructive/85'
                )}
              >
                {statusSummary}
              </FadeText>
            )}
          </DisclosureRow>
        )}
        {isGroup && previewTargets.length > 0 && (
          <div className="mt-2 grid w-full min-w-0 max-w-full gap-2 overflow-hidden pr-2 pl-3">
            {previewTargets.map(target => (
              <PreviewAttachment key={target} source="tool-result" target={target} />
            ))}
          </div>
        )}
        {/* Body is always rendered so children stay mounted across collapse/
            expand and across the 1→2 group transition. `hidden` removes it
            from a11y/visual flow without unmounting React subtree. */}
        <div
          className={cn(isGroup && 'mt-0.5 w-full overflow-hidden pr-2 pl-3', isGroup && open && 'divide-y divide-(--lg-divider) pb-2 [&>*]:py-1')}
          hidden={isGroup && !open}
          key="body"
        >
          {children}
        </div>
      </div>
    </ToolEmbedContext.Provider>
  )
}

/**
 * Per-tool fallback. Now strictly returns a single ToolEntry — the
 * grouping decision lives in ToolGroupSlot above, so this never swaps
 * its return type and the underlying ToolEntry stays mounted across
 * group-shape changes.
 */
export const ToolFallback = ({ toolCallId, toolName, args, isError, result }: ToolCallMessagePartProps) => {
  const part: ToolPart = { args, isError, result, toolCallId, toolName, type: 'tool-call' }

  return <ToolEntry part={part} />
}
