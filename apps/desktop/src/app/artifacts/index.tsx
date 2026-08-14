import { ChevronsUpDown, MessagesSquare } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ZoomableImage } from '@/components/chat/zoomable-image'
import { PageLoader } from '@/components/page-loader'
import { CopyButton } from '@/components/ui/copy-button'
import { TextTab, TextTabMeta } from '@/components/ui/text-tab'
import { Tip } from '@/components/ui/tooltip'
import { getSessionMessages, listSessions } from '@/fan'
import { sessionTitle } from '@/lib/chat-runtime'
import { ExternalLink, ExternalLinkIcon, hostPathLabel, urlSlugTitleLabel, useLinkTitle } from '@/lib/external-link'
import { FileImage, FileText, Link2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import type { SessionInfo, SessionMessage } from '@/types/fan'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PageSearchShell } from '../page-search-shell'
import { sessionRoute } from '../routes'

type ArtifactKind = 'image' | 'file' | 'link'
type ArtifactFilter = 'all' | ArtifactKind
const ARTIFACT_FILTERS: readonly ArtifactFilter[] = ['all', 'image', 'file', 'link']

interface ArtifactRecord {
  id: string
  kind: ArtifactKind
  value: string
  href: string
  label: string
  sessionId: string
  sessionTitle: string
  timestamp: number
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g
const URL_RE = /https?:\/\/[^\s<>"')]+/g
const PATH_RE = /(^|[\s("'`])((?:\/|~\/|\.\.?\/)[^\s"'`<>]+(?:\.[a-z0-9]{1,8})?)/gi
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\?.*)?$/i
const FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|txt|json|md|csv|zip|tar|gz|mp3|wav|mp4|mov)(?:\?.*)?$/i
const KEY_HINT_RE = /(path|file|url|image|artifact|output|download|result|target)/i

const ARTIFACT_TIME_FMT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short'
})

function normalizeValue(value: string): string {
  return value.trim().replace(/[),.;]+$/, '')
}

function parseMaybeJson(value: string): unknown {
  if (!value.trim()) {
    return null
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function looksLikePathOrUrl(value: string): boolean {
  return (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value.startsWith('data:image/') ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/')
  )
}

function looksLikeArtifact(value: string): boolean {
  if (/^(?:https?:\/\/|data:image\/)/.test(value)) {
    return true
  }

  if (looksLikePathOrUrl(value) && (IMAGE_EXT_RE.test(value) || FILE_EXT_RE.test(value))) {
    return true
  }

  return value.startsWith('/') && value.includes('.')
}

function artifactKind(value: string): ArtifactKind {
  if (value.startsWith('data:image/') || IMAGE_EXT_RE.test(value)) {
    return 'image'
  }

  if (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value.startsWith('file://')
  ) {
    return 'file'
  }

  return 'link'
}

function artifactHref(value: string): string {
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('file://') ||
    value.startsWith('data:')
  ) {
    return value
  }

  if (value.startsWith('/')) {
    return `file://${encodeURI(value)}`
  }

  return value
}

function artifactLabel(value: string): string {
  try {
    const url = new URL(value)
    const item = url.pathname.split('/').filter(Boolean).pop()

    return item || value
  } catch {
    const parts = value.split(/[\\/]/).filter(Boolean)

    return parts.pop() || value
  }
}

function messageText(message: SessionMessage): string {
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content
  }

  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text
  }

  if (typeof message.context === 'string' && message.context.trim()) {
    return message.context
  }

  return ''
}

function collectStringValues(
  value: unknown,
  keyPath: string,
  collector: (value: string, keyPath: string) => void
): void {
  if (typeof value === 'string') {
    collector(value, keyPath)

    return
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStringValues(entry, `${keyPath}.${index}`, collector))

    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectStringValues(child, keyPath ? `${keyPath}.${key}` : key, collector)
  }
}

function collectArtifactsFromText(text: string, pushValue: (value: string) => void): void {
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    pushValue(match[2] || '')
  }

  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = match.index ?? 0

    if (start > 0 && text[start - 1] === '!') {
      continue
    }

    const value = match[2] || ''

    if (looksLikeArtifact(value)) {
      pushValue(value)
    }
  }

  for (const match of text.matchAll(URL_RE)) {
    const value = match[0] || ''

    if (looksLikeArtifact(value)) {
      pushValue(value)
    }
  }

  for (const match of text.matchAll(PATH_RE)) {
    pushValue(match[2] || '')
  }
}

function collectArtifactsFromMessage(message: SessionMessage, pushValue: (value: string) => void): void {
  const text = messageText(message)

  if (text) {
    collectArtifactsFromText(text, pushValue)
  }

  if (message.role !== 'tool' && !Array.isArray(message.tool_calls)) {
    return
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      collectStringValues(call, 'tool_call', (value, keyPath) => {
        const normalized = normalizeValue(value)

        if (!normalized) {
          return
        }

        if (KEY_HINT_RE.test(keyPath) && (looksLikePathOrUrl(normalized) || FILE_EXT_RE.test(normalized))) {
          pushValue(normalized)
        }
      })
    }
  }

  const parsed = parseMaybeJson(text)

  if (parsed !== null) {
    collectStringValues(parsed, 'tool_result', (value, keyPath) => {
      const normalized = normalizeValue(value)

      if (!normalized) {
        return
      }

      if ((KEY_HINT_RE.test(keyPath) || looksLikePathOrUrl(normalized)) && looksLikeArtifact(normalized)) {
        pushValue(normalized)
      }
    })
  }
}

export function collectArtifactsForSession(session: SessionInfo, messages: SessionMessage[]): ArtifactRecord[] {
  const found = new Map<string, ArtifactRecord>()
  const title = sessionTitle(session)

  for (const message of messages) {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      continue
    }

    collectArtifactsFromMessage(message, candidate => {
      const value = normalizeValue(candidate)

      if (!value || !looksLikeArtifact(value)) {
        return
      }

      const key = `${session.id}:${value}`

      if (found.has(key)) {
        return
      }

      found.set(key, {
        id: key,
        kind: artifactKind(value),
        value,
        href: artifactHref(value),
        label: artifactLabel(value),
        sessionId: session.id,
        sessionTitle: title,
        timestamp: message.timestamp || session.last_active || session.started_at || Date.now()
      })
    })
  }

  return Array.from(found.values())
}

function formatArtifactTime(timestamp: number): string {
  return ARTIFACT_TIME_FMT.format(new Date(timestamp))
}

function pageRangeLabel(total: number, page: number, pageSize: number): string {
  if (total === 0) {
    return '0'
  }

  const start = (page - 1) * pageSize + 1
  const end = Math.min(total, page * pageSize)

  return `${start}-${end} of ${total}`
}

function paginationItems(page: number, pageCount: number): Array<number | 'ellipsis'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  const pages: Array<number | 'ellipsis'> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)

  if (start > 2) {
    pages.push('ellipsis')
  }

  for (let nextPage = start; nextPage <= end; nextPage += 1) {
    pages.push(nextPage)
  }

  if (end < pageCount - 1) {
    pages.push('ellipsis')
  }

  pages.push(pageCount)

  return pages
}

type CellCtx = {
  onOpen: (href: string) => void | Promise<void>
  onOpenChat: (sessionId: string) => void
}

interface ArtifactColumn {
  Cell: (props: { artifact: ArtifactRecord; ctx: CellCtx }) => React.ReactElement
  bodyClassName: string
  header: (filter: ArtifactFilter) => string
  id: 'location' | 'primary' | 'session' | 'time'
  width: (filter: ArtifactFilter) => string
}

const itemsLabel = (f: ArtifactFilter) => (f === 'link' ? '条链接' : f === 'file' ? '个文件' : '项')

type ArtifactsViewProps = React.ComponentProps<'section'> & {
  /** Renders inside the Settings overlay — drops the full-page top inset. */
  embedded?: boolean
}

export function ArtifactsView({ className, embedded = false, ...props }: ArtifactsViewProps) {
  const navigate = useNavigate()
  const [artifacts, setArtifacts] = useState<ArtifactRecord[] | null>(null)
  const [query, setQuery] = useState('')

  // Distinct from the settings `?tab=` param so the two don't fight when this
  // view is embedded inside the settings overlay.
  const [kindFilter, setKindFilter] = useRouteEnumParam('artifactsTab', ARTIFACT_FILTERS, 'all')

  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(() => new Set())
  const [imagePage, setImagePage] = useState(1)
  const [filePage, setFilePage] = useState(1)

  const refreshArtifacts = useCallback(async () => {
    try {
      const sessions = (await listSessions(30, 1)).sessions
      const results = await Promise.allSettled(sessions.map(session => getSessionMessages(session.id)))
      const nextArtifacts: ArtifactRecord[] = []

      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') {
          return
        }

        const session = sessions[index]
        nextArtifacts.push(...collectArtifactsForSession(session, result.value.messages))
      })

      setArtifacts(nextArtifacts.sort((a, b) => b.timestamp - a.timestamp))
    } catch (err) {
      notifyError(err, '产物加载失败')
      setArtifacts([])
    }
  }, [])

  useRefreshHotkey(refreshArtifacts)

  useEffect(() => {
    void refreshArtifacts()
  }, [refreshArtifacts])

  useEffect(() => {
    setImagePage(1)
    setFilePage(1)
  }, [artifacts, kindFilter, query])

  const visibleArtifacts = useMemo(() => {
    if (!artifacts) {
      return []
    }

    const q = query.trim().toLowerCase()

    return artifacts.filter(artifact => {
      if (kindFilter !== 'all' && artifact.kind !== kindFilter) {
        return false
      }

      if (!q) {
        return true
      }

      return (
        artifact.label.toLowerCase().includes(q) ||
        artifact.value.toLowerCase().includes(q) ||
        artifact.sessionTitle.toLowerCase().includes(q)
      )
    })
  }, [artifacts, kindFilter, query])

  const visibleImageArtifacts = useMemo(
    () => visibleArtifacts.filter(artifact => artifact.kind === 'image'),
    [visibleArtifacts]
  )

  const visibleFileArtifacts = useMemo(
    () => visibleArtifacts.filter(artifact => artifact.kind !== 'image'),
    [visibleArtifacts]
  )

  const imagePageCount = Math.max(1, Math.ceil(visibleImageArtifacts.length / 24))
  const filePageCount = Math.max(1, Math.ceil(visibleFileArtifacts.length / 100))
  const currentImagePage = Math.min(imagePage, imagePageCount)
  const currentFilePage = Math.min(filePage, filePageCount)

  const pagedImageArtifacts = useMemo(
    () => visibleImageArtifacts.slice((currentImagePage - 1) * 24, currentImagePage * 24),
    [currentImagePage, visibleImageArtifacts]
  )

  const pagedFileArtifacts = useMemo(
    () => visibleFileArtifacts.slice((currentFilePage - 1) * 100, currentFilePage * 100),
    [currentFilePage, visibleFileArtifacts]
  )

  const counts = useMemo(() => {
    const all = artifacts || []

    return {
      all: all.length,
      image: all.filter(artifact => artifact.kind === 'image').length,
      file: all.filter(artifact => artifact.kind === 'file').length,
      link: all.filter(artifact => artifact.kind === 'link').length
    }
  }, [artifacts])

  const openArtifact = useCallback(async (href: string) => {
    try {
      if (window.fanDesktop?.openExternal) {
        await window.fanDesktop.openExternal(href)
      } else {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      notifyError(err, '打开失败')
    }
  }, [])

  const markImageFailed = useCallback((id: string) => {
    setFailedImageIds(current => {
      if (current.has(id)) {
        return current
      }

      return new Set(current).add(id)
    })
  }, [])

  const cellCtx: CellCtx = {
    onOpen: openArtifact,
    onOpenChat: sessionId => navigate(sessionRoute(sessionId))
  }

  // Scroll root for the sticky section headers' stuck-state detection.
  const scrollRef = useRef<HTMLDivElement>(null)

  return (
    <PageSearchShell
      {...props}
      className={cn(embedded && 'pt-0', className)}
      onSearchChange={setQuery}
      searchHidden={counts.all === 0}
      searchPlaceholder="搜索产物…"
      searchValue={query}
      tabs={
        <>
          <TextTab active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>
            全部 <TextTabMeta>{counts.all}</TextTabMeta>
          </TextTab>
          <TextTab active={kindFilter === 'image'} onClick={() => setKindFilter('image')}>
            图片 <TextTabMeta>{counts.image}</TextTabMeta>
          </TextTab>
          <TextTab active={kindFilter === 'file'} onClick={() => setKindFilter('file')}>
            文件 <TextTabMeta>{counts.file}</TextTabMeta>
          </TextTab>
          <TextTab active={kindFilter === 'link'} onClick={() => setKindFilter('link')}>
            链接 <TextTabMeta>{counts.link}</TextTabMeta>
          </TextTab>
        </>
      }
    >
      {!artifacts ? (
        <PageLoader label="正在索引最近会话产物" />
      ) : visibleArtifacts.length === 0 ? (
        <div className="grid h-full place-items-center px-6 text-center">
          <div>
            <div className="text-sm font-medium">未找到产物</div>
            <div className="mt-1 text-xs text-muted-foreground">
              生成的图片和文件输出将在会话产生后显示于此。
            </div>
          </div>
        </div>
      ) : (
        <div className="h-full overflow-y-auto" ref={scrollRef}>
          {/* Tight 24px gutter (VGEJT IdV36/AoDXK padding), not the wide
              responsive PAGE_INSET. */}
          <div className="flex flex-col gap-3 px-6 pb-4">
            {visibleImageArtifacts.length > 0 && (
              <section className="flex flex-col gap-3.5 pt-1">
                {/* Section Header (e4Kg6D): 图片 + count, pager on the right.
                    Transparent at rest; the glass band fades in only once it's
                    actually pinned (StickyBar tracks the stuck state). */}
                <StickyBar className="h-9 justify-between gap-3" scrollRef={scrollRef}>
                  <span className="text-[0.8125rem] font-bold text-(--ui-text-secondary)">
                    图片
                    <span className="ml-1 font-mono text-[0.6875rem] font-medium text-(--ui-text-tertiary)">
                      {visibleImageArtifacts.length}
                    </span>
                  </span>
                  {/* The spec's image section is just the header — the pager
                      only appears when images actually overflow one page. */}
                  {visibleImageArtifacts.length > 24 && (
                    <ArtifactsPagination
                      className="justify-end"
                      itemLabel="张图片"
                      onPageChange={setImagePage}
                      page={currentImagePage}
                      pageSize={24}
                      total={visibleImageArtifacts.length}
                    />
                  )}
                </StickyBar>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(13.75rem,1fr))] items-start gap-3.5">
                  {pagedImageArtifacts.map(artifact => (
                    <ArtifactImageCard
                      artifact={artifact}
                      failedImage={failedImageIds.has(artifact.id)}
                      key={artifact.id}
                      onImageError={markImageFailed}
                      onOpenChat={sessionId => navigate(sessionRoute(sessionId))}
                    />
                  ))}
                </div>
              </section>
            )}

            {visibleFileArtifacts.length > 0 && (
              <section className="flex flex-col gap-3">
                <StickyBar className="h-9 overflow-x-auto" scrollRef={scrollRef}>
                  <ArtifactsPagination
                    className="ml-auto justify-end"
                    itemLabel={itemsLabel(kindFilter)}
                    onPageChange={setFilePage}
                    page={currentFilePage}
                    pageSize={100}
                    total={visibleFileArtifacts.length}
                  />
                </StickyBar>
                <div className="overflow-x-auto rounded-[1rem] border border-border bg-white shadow-[0_0.5rem_1.25rem_-0.375rem_#22325C14,0_0.125rem_0.3125rem_#22325C0A]">
                  <ArtifactTable artifacts={pagedFileArtifacts} ctx={cellCtx} filter={kindFilter} />
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </PageSearchShell>
  )
}

// A sticky section header whose background fades in only while it's actually
// pinned. A ~0px sentinel sits just above it; once that sentinel scrolls above
// the scroll root's top edge the bar is "stuck", and the app's faint-blue
// chrome fill (bg-background) transitions in. At rest the bar is fully
// transparent, so it never paints a band on the glass.
function StickyBar({
  children,
  className,
  scrollRef
}: {
  children: React.ReactNode
  className?: string
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = scrollRef.current

    if (!sentinel || !root) {
      return
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        const rootBounds = entry.rootBounds
        // Stuck = sentinel scrolled above the root's top edge. The rect
        // comparison (rather than just !isIntersecting) keeps the bar
        // transparent while its section is still below the fold.
        setStuck(rootBounds ? entry.boundingClientRect.top < rootBounds.top : !entry.isIntersecting)
      },
      { root, threshold: 0 }
    )

    io.observe(sentinel)

    return () => io.disconnect()
  }, [scrollRef])

  return (
    <>
      <div aria-hidden className="-mb-px h-px" ref={sentinelRef} />
      <div
        className={cn(
          'sticky top-0 z-10 -mx-6 flex items-center px-6 transition-colors duration-200 ease-out',
          stuck && 'bg-background',
          className
        )}
      >
        {children}
      </div>
    </>
  )
}

interface ArtifactsPaginationProps {
  className?: string
  itemLabel: string
  onPageChange: (page: number) => void
  page: number
  pageSize: number
  total: number
}

// VGEJT Pager (J2uYXG): mono count + a row of 32px pill controls — surface-2
// prev/next, a primary-filled current page, transparent inactive pages.
// Pagination logic (page / onPageChange / paginationItems) is unchanged.
function ArtifactsPagination({ className, itemLabel, onPageChange, page, pageSize, total }: ArtifactsPaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  // No fill on the step buttons (user call) — text + a quiet hover only; the
  // current page keeps its primary chip as the sole selection marker.
  const stepBtn =
    'flex h-8 items-center rounded-[0.5rem] px-3 text-[0.8125rem] font-medium text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:pointer-events-none disabled:opacity-45'

  return (
    <div className={cn('flex items-center justify-end gap-4 px-0.5', className)}>
      <div className="shrink-0 font-mono text-xs text-(--ui-text-tertiary)">
        {pageRangeLabel(total, page, pageSize)} {itemLabel}
      </div>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <button
            className={stepBtn}
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            type="button"
          >
            ‹ 上一页
          </button>
          {paginationItems(page, pageCount).map((item, index) =>
            item === 'ellipsis' ? (
              <span
                className="grid size-8 place-items-center text-[0.8125rem] text-(--ui-text-tertiary)"
                key={`ellipsis-${index}`}
              >
                …
              </span>
            ) : (
              <button
                aria-label={`跳转到第 ${item} 页`}
                className={cn(
                  // No fills anywhere in the pager (user call) — the current
                  // page is marked by bold primary ink, not a chip.
                  'grid size-8 place-items-center rounded-[0.5rem] text-[0.8125rem] transition-colors',
                  page === item
                    ? 'font-semibold text-primary'
                    : 'font-medium text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground'
                )}
                key={`${item}-${index}`}
                onClick={() => onPageChange(item)}
                type="button"
              >
                {item}
              </button>
            )
          )}
          <button
            className={stepBtn}
            disabled={page >= pageCount}
            onClick={() => onPageChange(Math.min(pageCount, page + 1))}
            type="button"
          >
            下一页 ›
          </button>
        </div>
      )}
    </div>
  )
}

interface ArtifactImageCardProps {
  artifact: ArtifactRecord
  failedImage: boolean
  onImageError: (id: string) => void
  onOpenChat: (sessionId: string) => void
}

function ArtifactImageCard({ artifact, failedImage, onImageError, onOpenChat }: ArtifactImageCardProps) {
  return (
    // VGEJT Image Card (B3bqD): 16px rounded white card, hairline border, soft
    // float shadow. Functionally unchanged — zoomable thumb, error placeholder,
    // open-chat action.
    <article className="group/artifact flex flex-col overflow-hidden rounded-[1rem] border border-border bg-white shadow-[0_0.625rem_1.5rem_-0.5rem_#22325C1F,0_0.125rem_0.375rem_#22325C0F]">
      {/* Thumb (BbvdW): 132px surface-2 bed; image fills it, an icon shows
          when it failed/absent. */}
      <div className="flex h-[8.25rem] w-full items-center justify-center overflow-hidden bg-muted">
        {failedImage ? (
          <FileImage aria-hidden className="size-[1.875rem] text-(--ui-text-tertiary)" />
        ) : (
          <ZoomableImage
            alt={artifact.label}
            className="size-full cursor-zoom-in object-cover"
            containerClassName="size-full"
            decoding="async"
            loading="lazy"
            onError={() => onImageError(artifact.id)}
            slot="artifact-media"
            src={artifact.href}
          />
        )}
      </div>

      {/* Content (YckAP): meta · divider · footer — kept compact so the wider
          card doesn't read as overly tall. */}
      <div className="flex flex-col gap-2.5 px-3.5 pt-2.5 pb-3">
        <div className="flex min-w-0 flex-col gap-[3px]">
          <div className="flex items-center gap-[5px] text-(--ui-text-tertiary)">
            <FileImage className="size-3" />
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.0625rem]">{artifact.kind}</span>
          </div>
          <div className="truncate text-[0.84375rem] font-semibold text-foreground">{artifact.label}</div>
          <div className="truncate font-mono text-[0.6875rem] text-(--ui-text-tertiary)">{artifact.value}</div>
        </div>

        <div aria-hidden className="h-px bg-border" />

        <div className="flex min-w-0 flex-col gap-1.5">
          <button
            className="inline-flex w-fit items-center gap-1.5 rounded-full bg-muted px-[0.6875rem] py-1.5 text-xs font-semibold text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground"
            onClick={() => onOpenChat(artifact.sessionId)}
            type="button"
          >
            <MessagesSquare className="size-[0.8125rem]" />
            对话
          </button>
          <div className="truncate text-[0.65625rem] leading-[1.4] text-(--ui-text-tertiary)">
            {artifact.sessionTitle} · {formatArtifactTime(artifact.timestamp)}
          </div>
        </div>
      </div>
    </article>
  )
}

// Single click target for any row cell. External URLs render as <ExternalLink>;
// local actions render as <button>. Padding lives here, NOT on the <td>, so
// the entire cell area is hoverable and clickable in both branches.
function ArtifactCellAction({
  children,
  href,
  onClick,
  title
}: {
  children: React.ReactNode
  href?: string
  onClick?: () => void
  title?: string
}) {
  if (href) {
    return (
      <ExternalLink
        className="flex h-full w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) font-normal text-(--ui-text-secondary) no-underline underline-offset-4 decoration-current/20 transition-colors hover:text-foreground hover:underline"
        href={href}
        showExternalIcon={false}
        title={title}
      >
        {children}
      </ExternalLink>
    )
  }

  return (
    <button
      className="flex h-full w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) font-normal text-(--ui-text-secondary) no-underline underline-offset-4 decoration-current/20 transition-colors hover:text-foreground hover:underline"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  )
}

function PrimaryCell({ artifact, ctx }: { artifact: ArtifactRecord; ctx: CellCtx }) {
  const isLink = artifact.kind === 'link'
  const Icon = isLink ? Link2 : FileText
  const fetchedTitle = useLinkTitle(isLink ? artifact.href : null)
  const label = isLink ? fetchedTitle || urlSlugTitleLabel(artifact.href) : artifact.label

  return (
    <ArtifactCellAction
      href={isLink ? artifact.href : undefined}
      onClick={isLink ? undefined : () => void ctx.onOpen(artifact.href)}
      title={label}
    >
      <span className="grid size-6 shrink-0 place-items-center self-center rounded-[0.4375rem] bg-[color-mix(in_srgb,var(--dt-primary)_8%,transparent)] text-primary">
        <Icon className="size-3.5" />
      </span>
      <span className={cn('min-w-0 flex-1', isLink ? 'wrap-anywhere' : 'truncate')}>
        {label}
        {isLink && <ExternalLinkIcon />}
      </span>
    </ArtifactCellAction>
  )
}

function LocationCell({ artifact }: { artifact: ArtifactRecord; ctx: CellCtx }) {
  const isLink = artifact.kind === 'link'
  const value = isLink ? hostPathLabel(artifact.value) : artifact.value
  const copyLabel = isLink ? '复制链接' : '复制路径'

  return (
    <div className="group/location flex min-w-0 items-center gap-1.5">
      <Tip label={artifact.value}>
        <div
          className={cn(
            'min-w-0 flex-1 truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)',
            isLink ? 'font-normal' : 'font-mono'
          )}
        >
          {value}
        </div>
      </Tip>
      <CopyButton
        appearance="icon"
        buttonSize="icon-xs"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/location:opacity-100"
        iconClassName="size-3.5"
        label={copyLabel}
        text={artifact.value}
        title={copyLabel}
      />
    </div>
  )
}

function SessionCell({ artifact, ctx }: { artifact: ArtifactRecord; ctx: CellCtx }) {
  return (
    <ArtifactCellAction onClick={() => ctx.onOpenChat(artifact.sessionId)} title={artifact.sessionTitle}>
      <span className="truncate">{artifact.sessionTitle}</span>
    </ArtifactCellAction>
  )
}

// 时间 is its own column now (pulled out of the session cell per the user) —
// a mono timestamp, matching the spec's session-time type.
function TimeCell({ artifact }: { artifact: ArtifactRecord; ctx: CellCtx }) {
  return (
    <div className="truncate font-mono text-[0.71875rem] text-(--ui-text-tertiary)">
      {formatArtifactTime(artifact.timestamp)}
    </div>
  )
}

const ARTIFACT_COLUMNS: readonly ArtifactColumn[] = [
  {
    Cell: PrimaryCell,
    bodyClassName: 'p-0',
    header: filter => (filter === 'link' ? '链接标题' : filter === 'file' ? '名称' : '标题 / 名称'),
    id: 'primary',
    width: filter => (filter === 'link' ? 'w-[40%]' : 'w-[32%]')
  },
  {
    Cell: LocationCell,
    bodyClassName: 'px-2.5 py-1.5',
    header: filter => (filter === 'link' ? 'URL' : filter === 'file' ? '路径' : '位置'),
    id: 'location',
    width: filter => (filter === 'link' ? 'w-[28%]' : 'w-[30%]')
  },
  {
    Cell: SessionCell,
    bodyClassName: 'p-0',
    header: () => '会话',
    id: 'session',
    width: filter => (filter === 'link' ? 'w-[18%]' : 'w-[22%]')
  },
  {
    Cell: TimeCell,
    bodyClassName: 'px-2.5 py-1.5',
    header: () => '时间',
    id: 'time',
    width: filter => (filter === 'link' ? 'w-[14%]' : 'w-[16%]')
  }
]

function ArtifactTable({
  artifacts,
  ctx,
  filter
}: {
  artifacts: readonly ArtifactRecord[]
  ctx: CellCtx
  filter: ArtifactFilter
}) {
  return (
    <table className="w-full min-w-176 table-fixed text-left text-[length:var(--conversation-caption-font-size)]">
      {/* VGEJT Header Row (FcW44): 44px surface-2 header, 12/600 labels with a
          decorative sort glyph — the list stays time-sorted, no column sort is
          wired (function unchanged). */}
      <thead className="border-b border-border bg-muted text-xs font-semibold text-(--ui-text-secondary)">
        <tr className="h-11">
          {ARTIFACT_COLUMNS.map(col => (
            <th className={cn(col.width(filter), 'px-4 font-semibold')} key={col.id}>
              <span className="inline-flex items-center gap-1.5">
                {col.header(filter)}
                <ChevronsUpDown aria-hidden className="size-3 text-(--ui-text-tertiary)" />
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {artifacts.map(artifact => (
          <tr
            className="group/artifact border-b border-border transition-colors last:border-0 hover:bg-[color-mix(in_srgb,var(--dt-primary)_8%,transparent)]"
            key={artifact.id}
          >
            {ARTIFACT_COLUMNS.map(col => {
              const Cell = col.Cell

              return (
                <td className={cn('h-12 align-middle', col.bodyClassName)} key={col.id}>
                  <Cell artifact={artifact} ctx={ctx} />
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
