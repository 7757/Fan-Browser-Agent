import { useStore } from '@nanostores/react'
import { Archive, Search, X } from 'lucide-react'
import type * as React from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { TabFavicon } from '@/app/chat/tab-favicon'
import { Tip } from '@/components/ui/tooltip'
import { FAN_LOGO_MARK } from '@/lib/brand'
import { cn } from '@/lib/utils'
import { $nativeViewOccluded } from '@/store/native-overlay'
import {
  $attentionSessionIds,
  $selectedStoredSessionId,
  $sessions,
  $sessionsLoading,
  $unreadSessionIds,
  $workingSessionIds,
  clearSessionUnread
} from '@/store/session'
import { $sessionTabs, type SessionTabsState, setSessionTabs } from '@/store/session-tabs'
import { $sessionThumbnails, storeCapturedSessionThumbnail } from '@/store/session-thumbnails'
import type { SessionInfo } from '@/types/fan'

import { NEW_CHAT_ROUTE, sessionRoute } from '../routes'

// last_active / started_at are unix seconds. Mirror the sidebar's relative-age
// buckets so tiles read the same way ("刚刚" / "5m" / "3h" / "2d").
const AGE_TICKS: ReadonlyArray<[number, string]> = [
  [86_400_000, 'd'],
  [3_600_000, 'h'],
  [60_000, 'm']
]

const OVERVIEW_THUMBNAIL_CAPTURE_TIMEOUT_MS = 2_500
const OVERVIEW_THUMBNAIL_CAPTURE_RETRY_MS = 100
const OVERVIEW_THUMBNAIL_COMMIT_TIMEOUT_MS = 100

export function browserWorkbenchIdForSession(session: Pick<SessionInfo, 'browser_workbench_id' | 'id'>): string {
  return session.browser_workbench_id?.trim() || session.id
}

function sessionIdentityIds(
  session: Pick<SessionInfo, '_lineage_root_id' | 'browser_workbench_id' | 'id'>
): string[] {
  return [
    ...new Set(
      [
        session.id,
        session._lineage_root_id?.trim(),
        session.browser_workbench_id?.trim()
      ].filter((value): value is string => Boolean(value))
    )
  ]
}

/** @internal Exported so the bounded live-tile handoff can be tested without Electron. */
export async function captureRetiringOverviewThumbnail(
  browserWorkbenchId: string,
  timeoutMs = OVERVIEW_THUMBNAIL_CAPTURE_TIMEOUT_MS
): Promise<string | null> {
  const capture = window.fanDesktop?.browser?.captureOverviewThumbnail

  if (!browserWorkbenchId.trim() || !capture) {
    return null
  }

  const deadline = Date.now() + Math.max(0, timeoutMs)

  while (Date.now() < deadline) {
    let attemptTimeout = 0

    try {
      const result = await Promise.race([
        capture(browserWorkbenchId),
        new Promise<null>(resolve => {
          attemptTimeout = window.setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
        })
      ])

      if (result?.ok && result.dataUrl) {
        return result.dataUrl
      }
    } catch {
      return null
    } finally {
      window.clearTimeout(attemptTimeout)
    }

    // The renderer can observe working=false just before Main clears its
    // control/unsafe guard. A clean overview capture is briefly refused in
    // that window, so retry null frames without ever extending the total
    // retirement deadline.
    const remaining = deadline - Date.now()

    if (remaining <= 0) {
      return null
    }

    await new Promise<void>(resolve => {
      window.setTimeout(resolve, Math.min(OVERVIEW_THUMBNAIL_CAPTURE_RETRY_MS, remaining))
    })
  }

  return null
}

function waitForOverviewThumbnailCommit(): Promise<void> {
  return new Promise(resolve => {
    let settled = false
    let frame = 0

    const finish = () => {
      if (settled) {
        return
      }

      settled = true
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      resolve()
    }

    // Hidden/throttled windows are allowed to defer rAF indefinitely. The
    // short timer preserves the handoff's bounded-release guarantee while the
    // normal visible-Canvas path still waits for React's next paint.
    const timeout = window.setTimeout(finish, OVERVIEW_THUMBNAIL_COMMIT_TIMEOUT_MS)
    frame = window.requestAnimationFrame(finish)
  })
}

function formatAge(seconds: number): string {
  const delta = Math.max(0, Date.now() - seconds * 1000)

  for (const [ms, suffix] of AGE_TICKS) {
    if (delta >= ms) {
      return `${Math.floor(delta / ms)}${suffix}`
    }
  }

  return '刚刚'
}

function sessionTitle(session: SessionInfo): string {
  return session.title?.trim() || session.preview?.trim() || '未命名会话'
}

interface SessionTileProps {
  dimmed: boolean
  onArchive: (id: string) => void
  onOpen: (id: string) => void
  opening: boolean
  selected: boolean
  session: SessionInfo
}

// One browser tab (Pencil Z17lB), mini scale. ACTIVE = white chrome tab: rounded
// top, bottom corners flaring into the strip (.chrome-tab), dark bold title.
// INACTIVE = transparent, muted title. Shared TabFavicon so icons match the full
// strip. shrink-0 so the strip clips whole overflow tabs at the card edge.
function TabPill({
  active,
  favicon,
  faviconPending,
  loadFailed,
  title,
  url
}: {
  active: boolean
  favicon?: string
  faviconPending?: boolean
  loadFailed?: boolean
  title: string
  url?: string
}) {
  const inner = (
    <>
      <TabFavicon faviconPending={faviconPending} loadFailed={loadFailed} size="sm" src={favicon} url={url} />
      <span
        className={cn(
          'min-w-0 max-w-[4.5rem] truncate',
          active ? 'font-semibold text-[#1A1D21]' : 'font-medium text-[#5C636E]'
        )}
      >
        {title || url || '新标签页'}
      </span>
    </>
  )

  if (active) {
    return (
      <div
        className="session-glass-tab flex shrink-0 items-center gap-[6px] px-[11px] py-[6px] text-[11.5px] leading-none"
        style={{ '--ct-flare': '6px', '--ct-radius': '7px' } as React.CSSProperties}
      >
        {inner}
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-[6px] px-[11px] py-[6px] text-[11.5px] leading-none">{inner}</div>
  )
}

// The card's mini browser tab strip (Pencil Z17lB): a grey chrome strip that
// renders EVERY tab (three tabs show three), thin dividers between INACTIVE
// neighbours, and the active tab as a flared white chrome tab. Clips whole tabs
// that overflow the card width. Falls back to a single active tab (the session
// title) for a cold session with no live tab state yet.
function TabStrip({ fallbackTitle, state }: { fallbackTitle: string; state?: SessionTabsState }) {
  const tabs = state?.tabs?.length ? state.tabs : null

  if (!tabs) {
    return (
      <div className="session-glass-tab-row flex shrink-0 flex-nowrap items-end overflow-hidden">
        <TabPill active title={fallbackTitle} />
      </div>
    )
  }

  const activeTabId = tabs[Math.min(state?.active ?? 0, tabs.length - 1)]?.tabId

  return (
    <div className="session-glass-tab-row flex shrink-0 flex-nowrap items-end overflow-hidden">
      {tabs.map((tab, i) => {
        const active = tab.tabId === activeTabId
        // Divider only between two INACTIVE neighbours — the active tab's flared
        // shape is its own separator (matches the Pencil design).
        const showSep = i > 0 && !active && tabs[i - 1].tabId !== activeTabId

        return (
          <Fragment key={tab.tabId}>
            {showSep && <span aria-hidden className="mb-[6px] h-[12px] w-px shrink-0 rounded-[1px] bg-[#DCE1E8]" />}
            <TabPill
              active={active}
              favicon={tab.favicon}
              faviconPending={tab.faviconPending}
              loadFailed={tab.loadFailed}
              title={tab.title}
              url={tab.url}
            />
          </Fragment>
        )
      })}
    </div>
  )
}

function SessionTile({ dimmed, onArchive, onOpen, opening, selected, session }: SessionTileProps) {
  const title = sessionTitle(session)
  const age = formatAge(session.last_active || session.started_at)
  const browserWorkbenchId = browserWorkbenchIdForSession(session)
  const identityIds = sessionIdentityIds(session)
  // Subscribe to the thumbnail store so a freshly captured still swaps the
  // skeleton in place. Static JPEG data URL, capped cache — no live view.
  const thumbnails = useStore($sessionThumbnails)
  const thumbnail = identityIds.map(id => thumbnails[id]).find(Boolean)
  // Whether THIS session's agent turn is running (cross-session signal). It's
  // "运行中/执行中", NOT strictly "driving the browser": the ground-truth
  // browser-operating set (operatingSessions/runtime.isOperating) is
  // FOREGROUND-only — it's cleared the moment you leave a session, so it's empty
  // in the overview and unusable here. A floated live view visibly MOVES when
  // the agent is actually browsing, so the browsing-vs-thinking distinction
  // reads from the tile itself; the label stays honest ("执行中").
  const workingIds = useStore($workingSessionIds)
  const activityId = identityIds.find(id => workingIds.includes(id)) || session.id
  const operating = identityIds.some(id => workingIds.includes(id))
  // Keep the latest still underneath the live WebContentsView. During the short
  // native-view placement handoff it is a better fallback than the blank state.
  const visibleThumbnail = thumbnail
  // Post-turn "a task finished, not yet seen" (persisted, per-viewer) and the
  // blocking mid-turn "needs your input" state — distinct concepts, distinct
  // badges, explicit precedence below.
  const unreadIds = useStore($unreadSessionIds)
  const attentionIds = useStore($attentionSessionIds)
  const unread = identityIds.some(id => unreadIds.includes(id))
  const needsInput = identityIds.some(id => attentionIds.includes(id))
  const tabState = useStore($sessionTabs)[browserWorkbenchId]

  // Seed the tab strip once on mount: tabs.state events only fire on a CHANGE, so
  // a session that isn't currently navigating would otherwise show no tabs. The
  // global tabs.state subscription (desktop-controller) keeps it live afterwards.
  useEffect(() => {
    let cancelled = false
    void window.fanDesktop?.browser
      ?.listTabs?.(browserWorkbenchId)
      .then(res => {
        if (cancelled || !res?.ok) {return}
        setSessionTabs(browserWorkbenchId, { active: res.active ?? 0, tabs: Array.isArray(res.tabs) ? res.tabs : [] })
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [browserWorkbenchId])

  // Archive routes through the SINGLE archiveSession action (use-session-
  // actions) — it owns the optimistic list update, rollback, pin cleanup AND
  // the wasSelected reset. stopPropagation so the button doesn't also open.
  const archiveTile = (event: React.MouseEvent) => {
    event.stopPropagation()
    onArchive(session.id)
  }

  const statusChip = operating ? (
    <span className="flex shrink-0 items-center gap-[4px] rounded-full bg-[#2D6BF0]/12 px-[7px] py-[1.5px] text-[10px] font-[600] leading-none text-[#2D6BF0]">
      <span className="size-[5px] animate-pulse rounded-full bg-[#2D6BF0]" />
      执行中
    </span>
  ) : needsInput ? (
    <span className="flex shrink-0 items-center gap-[4px] rounded-full bg-[#E8A33D]/14 px-[7px] py-[1.5px] text-[10px] font-[600] leading-none text-[#C77D1A]">
      <span className="size-[5px] animate-pulse rounded-full bg-[#E8A33D]" />
      待回复
    </span>
  ) : unread ? (
    <span className="flex shrink-0 items-center gap-[4px] rounded-full bg-[#E0474C]/12 px-[7px] py-[1.5px] text-[10px] font-[600] leading-none text-[#D0393E]">
      <span className="size-[5px] rounded-full bg-[#E0474C]" />
      新结果
    </span>
  ) : selected ? (
    <span className="flex shrink-0 items-center gap-[4px] rounded-full bg-[#2D6BF0]/10 px-[7px] py-[1.5px] text-[10px] font-[600] leading-none text-[#2D6BF0]">
      <span className="size-[5px] rounded-full bg-[#2D6BF0]" />
      当前
    </span>
  ) : null

  return (
    // group on the wrapper so hovering anywhere (card OR footer) reveals the
    // archive affordance; magnify + live-tile geometry target the card only.
    <div
      className={cn(
        'group flex flex-col gap-[9px] transition-opacity duration-150 ease-out motion-reduce:transition-none',
        dimmed && 'opacity-45'
      )}
    >
      <button
        className={cn(
          // Keep the design's RATIO so cards scale with the window (Safari-
          // overview behavior). Magnify = macOS-Dock fisheye driven by cursor
          // proximity in JS (CanvasView.applyMagnify), NOT a Tailwind hover:scale
          // (which bounced). Transform is JS-owned; state shows via ring/shadow/
          // glow ONLY so it never fights the transform, and an operating
          // (native-backed) tile is never geometry-moved. will-change scoped to
          // hover so idle tiles aren't all layer-promoted.
          'session-glass-card tile-motion relative flex aspect-[401/272] w-full flex-col overflow-hidden text-left hover:z-10 hover:will-change-transform',
          selected
            ? 'session-glass-card-selected ring-2 ring-[var(--bwa-primary)]'
            : 'ring-1 ring-white/70 hover:ring-white/90',
          opening &&
            'z-20 [transform:translateY(-3px)_scale(1.055)] shadow-[0_24px_52px_-18px_rgba(37,55,95,0.48)] ring-2 ring-white motion-reduce:[transform:none]',
          operating &&
            'ring-2 ring-[var(--bwa-primary)] [animation:fan-operating-glow_2.2s_ease-in-out_infinite] motion-reduce:animate-none'
        )}
        data-operating={operating ? '1' : ''}
        data-tile-activity-id={activityId}
        data-tile-card=""
        data-tile-identity-ids={identityIds.join(' ')}
        data-tile-session-id={session.id}
        onClick={() => onOpen(session.id)}
        type="button"
      >
        {/* Mini browser tab strip — how many tabs + which is active (ego UX). */}
        <TabStrip fallbackTitle={title} state={tabState} />

        {/* Snapshot: real captured still if we have one, otherwise FAN's real
            empty-browser state. The live overview view floats over this rect. */}
        {visibleThumbnail ? (
          <div
            className="min-h-0 flex-1 overflow-hidden bg-white/70"
            data-browser-workbench-id={browserWorkbenchId}
            data-tile-activity-id={activityId}
            data-tile-snapshot={session.id}
          >
            <img alt="" className="h-full w-full object-cover object-top" draggable={false} src={visibleThumbnail} />
          </div>
        ) : (
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[9px] bg-white/36 text-center"
            data-browser-workbench-id={browserWorkbenchId}
            data-tile-activity-id={activityId}
            data-tile-snapshot={session.id}
          >
            <img alt="" className="size-[30px] opacity-80" draggable={false} src={FAN_LOGO_MARK} />
            <span className="max-w-[15rem] px-4 text-[10.5px] leading-[1.45] text-(--bwa-text-muted)">
              输入网址或搜索，也可以让 Fan 代你操作
            </span>
          </div>
        )}

        {/* A full-card underlay bridges the native page's rounded corners into
            the Canvas chrome. The live WebContentsView stays above it, so page
            content is untouched while the tab strip and corner gaps feel like
            one continuous operating surface. */}
        {operating && (
          <span aria-hidden className="fan-operating-card-fill pointer-events-none absolute inset-0 z-[1]" />
        )}
      </button>

      {/* Footer BELOW the card (ego layout): session title + status, age +
          archive on the right. Clicking it also opens the session. */}
      <button
        className="flex items-center justify-between gap-[8px] px-[3px] text-left"
        onClick={() => onOpen(session.id)}
        type="button"
      >
        <div className="flex min-w-0 items-center gap-[7px]">
          <span className="min-w-0 truncate text-[13px] font-[650] text-(--bwa-text)">{title}</span>
          {statusChip}
        </div>
        <div className="flex shrink-0 items-center gap-[5px]">
          <span className="text-[11px] text-(--bwa-text-muted) group-hover:hidden">{age}</span>
          <Tip label="归档对话" side="top">
            <span
              aria-label="归档对话"
              className="hidden size-[18px] cursor-pointer place-items-center rounded-full text-(--bwa-text-muted) transition-colors hover:bg-[#E0474C]/12 hover:text-[#E0474C] group-hover:grid"
              onClick={archiveTile}
              role="button"
              tabIndex={-1}
            >
              <Archive size={11} strokeWidth={2} />
            </span>
          </Tip>
        </div>
      </button>
    </div>
  )
}

type CanvasViewProps = React.ComponentProps<'section'> & {
  onArchiveSession: (id: string) => void
}

export function CanvasView({ className, onArchiveSession, ...props }: CanvasViewProps) {
  const navigate = useNavigate()
  const sessions = useStore($sessions)
  const sessionsLoading = useStore($sessionsLoading)
  const selectedId = useStore($selectedStoredSessionId)
  const workingIds = useStore($workingSessionIds)
  const nativeViewOccluded = useStore($nativeViewOccluded)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const lastTilesKeyRef = useRef('')
  const nativeViewOccludedRef = useRef(nativeViewOccluded)
  // A completed Agent page remains floated until Main has captured its clean
  // final frame. This prevents the old cached still from flashing between the
  // live View and the replacement JPEG.
  const retiringSessionIdsRef = useRef(new Set<string>())
  const retirementRevisionRef = useRef(new Map<string, number>())
  const previousWorkingIdsRef = useRef(new Set(workingIds))
  const canvasMountedRef = useRef(true)
  const cardGeomRef = useRef<{ els: HTMLElement[]; cx: number[]; cyContent: number[]; w: number } | null>(null)
  const magnifyRafRef = useRef(0)
  const scrollRafRef = useRef(0)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const openTimerRef = useRef(0)
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null)

  const reduceMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  // Live overview tiles (plan B): Chromium won't composite HIDDEN views, so an
  // operating session can't be captured — instead its REAL WebContentsView is
  // positioned over its tile's snapshot rect (main.cjs setOverviewLiveTiles), so
  // you literally watch the agent work. Measure the on-screen operating tiles'
  // rects and push them to the main process; dedupe so we only IPC on change.
  const syncTiles = useCallback(() => {
    const api = window.fanDesktop?.browser

    if (!api?.overviewTiles) {return}
    const operating = new Set([...$workingSessionIds.get(), ...retiringSessionIdsRef.current])

    const tiles: Array<{
      id: string
      rect: { x: number; y: number; width: number; height: number }
      storageId: string
    }> = []

    const root = rootRef.current

    if (!nativeViewOccludedRef.current && root && operating.size) {
      const visibleSessionById = new Map(
        $sessions.get().map(session => [session.id, session])
      )
      root.querySelectorAll<HTMLElement>('[data-tile-snapshot]').forEach(el => {
        const storageId = el.dataset.tileSnapshot
        const visibleSession = storageId
          ? visibleSessionById.get(storageId)
          : undefined
        const identityIds = visibleSession
          ? sessionIdentityIds(visibleSession)
          : [el.dataset.tileActivityId || storageId].filter(
              (id): id is string => Boolean(id)
            )
        const activityId = identityIds.find(id => operating.has(id))

        if (!storageId || !activityId) {return}
        const browserWorkbenchId = el.dataset.browserWorkbenchId?.trim() || storageId
        const r = el.getBoundingClientRect()

        // Only place views for tiles actually on-screen.
        if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= window.innerHeight) {return}
        tiles.push({
          id: browserWorkbenchId,
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          storageId
        })
      })
    }

    const key = JSON.stringify(tiles)

    if (key === lastTilesKeyRef.current) {return}
    lastTilesKeyRef.current = key
    void api.overviewTiles(tiles)
  }, [])

  // Ask Main to place working native views before React's first Canvas paint.
  // Full-window overlays temporarily clear them; closing the final overlay
  // restores the same live tiles. Keep the occlusion value in a ref so
  // syncTiles remains stable and its lifetime cleanup does not run on every
  // overlay transition.
  useLayoutEffect(() => {
    nativeViewOccludedRef.current = nativeViewOccluded
    syncTiles()
  }, [nativeViewOccluded, syncTiles])

  // ── Dock-style magnification (Model A) ─────────────────────────────────────
  // A cursor-proximity fisheye over the STILL-image tiles — each card swells by
  // a smooth falloff of its distance to the cursor, like the macOS Dock, no
  // bounce. Operating tiles are NATIVE-backed (a WebContentsView floats above
  // the DOM and ignores CSS transforms), so they magnify by z-lift ONLY — never
  // geometry — or the live view would detach from the card. Card centers are
  // measured once on enter (transform-independent) and scroll-corrected
  // analytically, so a card's own scaling never feeds back into its measurement.
  const measureCards = useCallback(() => {
    const grid = gridRef.current
    const scroller = rootRef.current

    if (!grid || !scroller) {return}
    const els = Array.from(grid.querySelectorAll<HTMLElement>('[data-tile-card]'))
    const cx: number[] = []
    const cyContent: number[] = []
    const scrollTop = scroller.scrollTop
    let w = 0

    for (const el of els) {
      const r = el.getBoundingClientRect()
      cx.push(r.left + r.width / 2)
      cyContent.push(r.top + r.height / 2 + scrollTop) // scroll-independent center
      w = r.width
    }

    cardGeomRef.current = { els, cx, cyContent, w }
  }, [])

  const applyMagnify = useCallback((mx: number, my: number) => {
    const geom = cardGeomRef.current
    const scroller = rootRef.current

    if (!geom || !scroller || !geom.w) {return}
    const scrollTop = scroller.scrollTop
    const radius = geom.w * 1.35 // influence reaches ~1 neighbor
    const boost = 0.07

    for (let i = 0; i < geom.els.length; i++) {
      const el = geom.els[i]
      const cy = geom.cyContent[i] - scrollTop
      const d = Math.hypot(mx - geom.cx[i], my - cy)
      const t = Math.max(0, 1 - d / radius)
      const k = t * t * (3 - 2 * t) // smoothstep falloff

      if (
        el.dataset.operating === '1' ||
        (el.dataset.tileIdentityIds || '')
          .split(' ')
          .some(id => id && retiringSessionIdsRef.current.has(id))
      ) {
        el.style.transform = '' // native-backed: never geometry-move it
        el.style.zIndex = k > 0.02 ? '10' : ''
      } else {
        el.style.transform = k > 0.001 ? `scale(${(1 + boost * k).toFixed(4)})` : ''
        el.style.zIndex = k > 0.02 ? String(10 + Math.round(k * 20)) : ''
      }
    }
  }, [])

  const onGridPointerMove = useCallback(
    (event: React.MouseEvent) => {
      if (reduceMotion || openingSessionId) {return}
      const { clientX, clientY } = event
      lastPointerRef.current = { x: clientX, y: clientY }

      if (magnifyRafRef.current) {return}
      magnifyRafRef.current = requestAnimationFrame(() => {
        magnifyRafRef.current = 0
        applyMagnify(clientX, clientY)
      })
    },
    [applyMagnify, openingSessionId, reduceMotion]
  )

  const resetMagnify = useCallback(() => {
    if (magnifyRafRef.current) {
      cancelAnimationFrame(magnifyRafRef.current)
      magnifyRafRef.current = 0
    }

    lastPointerRef.current = null
    const geom = cardGeomRef.current

    if (!geom) {return}

    for (const el of geom.els) {
      el.style.transform = ''
      el.style.zIndex = ''
    }
  }, [])

  // One guarded rAF per scroll: reposition live tiles AND re-run magnify at the
  // last cursor position (wheel-scroll moves cards under a stationary pointer,
  // which fires no mousemove).
  const onScroll = useCallback(() => {
    if (scrollRafRef.current) {return}
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      syncTiles()
      const p = lastPointerRef.current

      if (p && !reduceMotion) {applyMagnify(p.x, p.y)}
    })
  }, [syncTiles, applyMagnify, reduceMotion])

  // Keep tiles positioned: first pass after the enter zoom settles, then on
  // resize; re-run when the operating set changes; clear all live tiles on
  // unmount (leaving the overview).
  useEffect(() => {
    const retiringSessionIds = retiringSessionIdsRef.current
    const retirementRevisions = retirementRevisionRef.current

    canvasMountedRef.current = true
    const settle = window.setTimeout(syncTiles, 280)
    const onResize = () => syncTiles()
    window.addEventListener('resize', onResize)

    return () => {
      canvasMountedRef.current = false
      retiringSessionIds.clear()
      retirementRevisions.clear()
      window.clearTimeout(settle)
      window.removeEventListener('resize', onResize)

      if (magnifyRafRef.current) {cancelAnimationFrame(magnifyRafRef.current)}

      if (scrollRafRef.current) {cancelAnimationFrame(scrollRafRef.current)}
      void window.fanDesktop?.browser?.overviewTiles?.([])
    }
  }, [syncTiles])

  // A slow safety tick is useful only while native views are actually floating
  // over cards. The previous unconditional 500ms scan woke an idle overview
  // forever, even with no running sessions.
  useEffect(() => {
    if (workingIds.length === 0) {
      return undefined
    }

    const tick = window.setInterval(syncTiles, 1_000)

    return () => window.clearInterval(tick)
  }, [syncTiles, workingIds.length])

  // Working -> idle is a two-phase handoff. Keep the native tile in the
  // retiring set while Main captures its final clean frame, persist that frame
  // under the durable session id, and only then remove the native tile. The
  // bounded capture helper guarantees failure cannot pin a live view forever.
  useEffect(() => {
    const previous = previousWorkingIdsRef.current
    const current = new Set(workingIds)
    const sessionByIdentity = new Map<string, SessionInfo>()
    for (const session of sessions) {
      for (const id of sessionIdentityIds(session)) {
        sessionByIdentity.set(id, session)
      }
    }
    const retirements: Array<{
      activityId: string
      revision: number
      thumbnailId: string
      workbenchId: string
    }> = []

    // A new turn supersedes an older retirement still in flight. Keep the live
    // view through the new turn and ignore the old capture when it resolves.
    for (const id of current) {
      if (retiringSessionIdsRef.current.delete(id)) {
        retirementRevisionRef.current.set(id, (retirementRevisionRef.current.get(id) ?? 0) + 1)
      }
    }

    for (const id of previous) {
      if (current.has(id)) {
        continue
      }

      const session = sessionByIdentity.get(id)
      const revision = (retirementRevisionRef.current.get(id) ?? 0) + 1
      retirementRevisionRef.current.set(id, revision)
      retiringSessionIdsRef.current.add(id)
      retirements.push({
        activityId: id,
        revision,
        thumbnailId: session?.id || id,
        workbenchId: session ? browserWorkbenchIdForSession(session) : id
      })
    }

    previousWorkingIdsRef.current = current
    // For a falling edge this re-asserts the same live tile (deduped); for a
    // rising edge it adds the newly-working tile immediately.
    syncTiles()

    for (const retirement of retirements) {
      void captureRetiringOverviewThumbnail(retirement.workbenchId).then(async dataUrl => {
        if (
          !canvasMountedRef.current ||
          retirementRevisionRef.current.get(retirement.activityId) !== retirement.revision
        ) {
          return
        }

        // A new turn can land between the capture acknowledgement and this
        // microtask. Never publish a possibly pre-turn still over that live page.
        if (!$workingSessionIds.get().includes(retirement.activityId) && dataUrl) {
          const stored = storeCapturedSessionThumbnail(retirement.thumbnailId, dataUrl)

          if (stored) {
            // Nanostore publication and React's <img> commit are separate
            // phases. Keep the native page through the next paint so detaching
            // it reveals the fresh still, never the previous cached frame.
            await waitForOverviewThumbnailCommit()

            if (
              !canvasMountedRef.current ||
              retirementRevisionRef.current.get(retirement.activityId) !== retirement.revision ||
              $workingSessionIds.get().includes(retirement.activityId)
            ) {
              return
            }
          }
        }

        retiringSessionIdsRef.current.delete(retirement.activityId)
        retirementRevisionRef.current.delete(retirement.activityId)
        syncTiles()
      })
    }
  }, [sessions, syncTiles, workingIds])

  // Archiving the LAST session leaves nothing to overview — return to the
  // first-entry "+" state instead of an empty grid (the overview only exists
  // when there is something to overview).
  useEffect(() => {
    if (!sessionsLoading && sessions.length === 0) {
      navigate(NEW_CHAT_ROUTE, { replace: true })
    }
  }, [navigate, sessions.length, sessionsLoading])

  const openSession = useCallback(
    (id: string) => {
      const visibleSession = sessions.find(session =>
        sessionIdentityIds(session).includes(id)
      )
      if (visibleSession) {
        for (const identityId of sessionIdentityIds(visibleSession)) {
          clearSessionUnread(identityId)
        }
      }

      if (reduceMotion) {
        navigate(sessionRoute(id))

        return
      }

      if (openTimerRef.current) {
        return
      }

      resetMagnify()
      setOpeningSessionId(id)
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = 0
        navigate(sessionRoute(id))
      }, 180)
    },
    [navigate, reduceMotion, resetMagnify, sessions]
  )

  useEffect(
    () => () => {
      if (openTimerRef.current) {
        window.clearTimeout(openTimerRef.current)
      }
    },
    []
  )

  // A running session's live view is floated over its tile and, being a native
  // layer above the DOM, swallows the tile's open-on-click. main floats a
  // transparent catcher over each live tile that forwards the click here (open the
  // session) and the wheel (so the overview scrolls even over a running tile).
  useEffect(() => {
    const api = window.fanDesktop?.browser

    const offOpen = api?.onOverviewOpen?.(({ id }) => {
      if (!id) {
        return
      }

      const storedId = sessions.find(session => browserWorkbenchIdForSession(session) === id)?.id ?? id

      openSession(storedId)
    })

    const offWheel = api?.onOverviewWheel?.(({ deltaY }) => {
      const el = rootRef.current

      if (el && deltaY) {el.scrollBy({ top: deltaY })}
    })

    return () => {
      offOpen?.()
      offWheel?.()
    }
  }, [openSession, sessions])

  // Real, client-side session search over the loaded $sessions: match the
  // trimmed, case-insensitive query against each session's title + preview.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    if (!needle) {
      return sessions
    }

    return sessions.filter(session => {
      const haystack = `${session.title ?? ''} ${session.preview ?? ''}`.toLowerCase()

      return haystack.includes(needle)
    })
  }, [query, sessions])

  return (
    <section
      {...props}
      className={cn(
        // Full-page surface below the top bar (which stays visible). The pt
        // clears the floating titlebar strip; the body scrolls on its own.
        // Enter zooms out gently into the overview. Session routes themselves
        // stay transform-free because their browser is a native WebContentsView.
        'flex h-full min-w-0 flex-col overflow-y-auto bg-transparent pt-(--titlebar-height) [animation:fan-overview-enter_260ms_cubic-bezier(0.22,0.9,0.3,1)] motion-reduce:animate-none',
        className
      )}
      onScroll={onScroll}
      ref={rootRef}
    >
      {/* Overview Toolbar (Oxrm4) — extra top gap clears the floating
          New/Canvas/Settings cluster that sits above in the titlebar strip. */}
      {/* Design: header row 14..48 + bar bottom pad 10 → toolbar content at
          58 + 6 pad = 64 from the window top = 34 titlebar var + 30. */}
      <div className="flex shrink-0 items-center justify-between px-[64px] pt-[30px]">
        <div className="flex items-center gap-[10px]">
          <h1 className="text-[16px] font-[700] text-(--bwa-text)">全部对话</h1>
          <span className="rounded-full bg-white/44 px-[9px] py-[2px] text-[11px] font-[600] text-(--bwa-text-muted) shadow-[0_0_0_1px_#FFFFFFE6,0_1.2px_1px_0_#FFFFFFF2] backdrop-blur-[14px]">
            {filtered.length} 个会话
          </span>
        </div>
        {/* Frosted search pill — a real in-canvas session filter (NOT the
            slash-command palette). ⌘K still opens the palette via the global
            shortcut in desktop-controller. */}
        <div className="flex items-center gap-[7px] rounded-full bg-white/44 px-[12px] py-[6px] shadow-[0_0_0_1px_#FFFFFFE6,0_1.2px_1px_0_#FFFFFFF2] backdrop-blur-[14px] transition-colors focus-within:bg-white/60">
          <Search className="shrink-0 text-(--bwa-text-muted)" size={13} strokeWidth={2} />
          <input
            aria-label="搜索对话"
            className="w-[52px] bg-transparent text-[12px] text-(--bwa-text) transition-[width] duration-200 placeholder:text-(--bwa-text-muted) focus:w-[168px] focus:outline-none"
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索对话"
            type="text"
            value={query}
          />
          {query ? (
            <button
              aria-label="清除搜索"
              className="grid shrink-0 place-items-center text-(--bwa-text-muted) transition-colors hover:text-(--bwa-text)"
              onClick={() => setQuery('')}
              type="button"
            >
              <X size={12} strokeWidth={2} />
            </button>
          ) : (
            <kbd className="shrink-0 rounded-[5px] bg-[#EEF2F7] px-[6px] py-px font-mono text-[9.5px] leading-none text-(--bwa-text-muted)">
              ⌘K
            </kbd>
          )}
        </div>
      </div>

      {/* Sessions Grid (iaBD0) — 3 columns, row gap 52, column gap 40 */}
      {filtered.length > 0 ? (
        <div
          className="grid grid-cols-3 gap-x-[40px] gap-y-[52px] px-[64px] pb-[40px] pt-[18px]"
          onMouseEnter={measureCards}
          onMouseLeave={resetMagnify}
          onMouseMove={onGridPointerMove}
          ref={gridRef}
        >
          {filtered.map(session => (
            <SessionTile
              dimmed={Boolean(openingSessionId && openingSessionId !== session.id)}
              key={session.id}
              onArchive={onArchiveSession}
              onOpen={openSession}
              opening={openingSessionId === session.id}
              selected={Boolean(selectedId && sessionIdentityIds(session).includes(selectedId))}
              session={session}
            />
          ))}
        </div>
      ) : (
        <div className="px-[64px] pb-[40px] pt-[40px] text-[12px] text-(--bwa-text-muted)">无匹配会话</div>
      )}
    </section>
  )
}
