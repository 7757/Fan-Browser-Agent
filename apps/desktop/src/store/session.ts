import { atom } from 'nanostores'

import type { ContextSuggestion } from '@/app/types'
import type { FanConnection } from '@/global'
import type { ChatMessage } from '@/lib/chat-messages'
import { persistString, persistStringArray, storedString, storedStringArray } from '@/lib/storage'
import type { SessionInfo, UsageStats } from '@/types/fan'

type Updater<T> = T | ((current: T) => T)

const WORKSPACE_CWD_KEY = 'fan.desktop.workspace-cwd'

export const getRememberedWorkspaceCwd = (): string => storedString(WORKSPACE_CWD_KEY)?.trim() || ''


interface AppAtom<T> {
  get: () => T
  set: (value: T) => void
}

function updateAtom<T>(store: AppAtom<T>, next: Updater<T>) {
  store.set(typeof next === 'function' ? (next as (current: T) => T)(store.get()) : next)
}

/** Durable id for pinning. Auto-compression rotates a conversation's session
 *  id (root -> continuation tip), so pins keyed on the live id evaporate. The
 *  lineage root is stable across every compression, so we pin on that. */
export const sessionPinId = (session: Pick<SessionInfo, '_lineage_root_id' | 'id'>): string =>
  session._lineage_root_id ?? session.id

// Accepted user turns are visible in the renderer before the SessionDB-backed
// recent list catches up. Key by compression lineage so a rotated tip inherits
// the same short-lived optimistic activity timestamp.
const optimisticSessionActivityByLineage = new Map<string, number>()

/** Merge a fresh server session page into the in-memory list, keeping any
 *  row the server omitted that we still want visible — both still-"working"
 *  sessions and pinned sessions.
 *
 *  Two reasons the server drops a row we must keep:
 *
 *  1. A brand-new session's first user message isn't flushed to the SessionDB
 *     until its turn is persisted, so `listSessions(min_messages=1)` skips
 *     sessions that are mid-first-response. Because every `message.complete`
 *     triggers a full refresh, a hard replace makes concurrent new chats vanish
 *     the instant any one of them finishes.
 *  2. The sidebar lists only the most-recent page (`SIDEBAR_SESSIONS_PAGE_SIZE`)
 *     ordered by activity. A pinned conversation that hasn't been touched in a
 *     while falls off that page, so a hard replace silently evicts it from the
 *     in-memory list — and because the Pinned section resolves pins against
 *     that list, the pin "disappears until you refresh".
 *
 *  `keepIds` carries both the working set and the pinned set. Pins are stored
 *  on the durable lineage-root id (see {@link sessionPinId}), while the loaded
 *  row surfaces under its live compression tip, so we match a survivor by
 *  either its live `id` or its `_lineage_root_id`. Optimistic deletes/archives
 *  drop the row from `previous` (and unpin it), so a removed session can't be
 *  resurrected here. */
export function mergeSessionPage(
  previous: SessionInfo[],
  incoming: SessionInfo[],
  keepIds: Iterable<string>
): SessionInfo[] {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds)

  if (keep.size === 0) {
    // With no running/pinned/selected/recently-settled row to protect, the
    // server page is authoritative and no optimistic activity can remain live.
    optimisticSessionActivityByLineage.clear()

    return incoming
  }

  const incomingIds = new Set(incoming.map(session => session.id))
  // Deduplicate by compression lineage: when auto-compression rotates the tip
  // id (old #4 → new #5), the incoming page carries the new tip but the previous
  // list still holds the old one. Without lineage-level dedup both rows survive
  // as separate sidebar entries.
  const incomingLineageKeys = new Set(incoming.map(sessionPinId))

  const survivors = previous.filter(
    session =>
      !incomingIds.has(session.id) &&
      !incomingLineageKeys.has(sessionPinId(session)) &&
      (keep.has(session.id) || (session._lineage_root_id != null && keep.has(session._lineage_root_id)))
  )

  const merged = survivors.length ? [...survivors, ...incoming] : incoming
  const visibleLineages = new Set(merged.map(sessionPinId))

  for (const lineageId of optimisticSessionActivityByLineage.keys()) {
    if (!visibleLineages.has(lineageId) && !keep.has(lineageId)) {
      optimisticSessionActivityByLineage.delete(lineageId)
    }
  }

  let hasOptimisticActivity = false

  const ranked = merged.map((session, index) => {
    const lineageId = sessionPinId(session)
    const optimisticAt = optimisticSessionActivityByLineage.get(lineageId)
    const fromAuthoritativePage = incomingLineageKeys.has(lineageId)

    if (optimisticAt === undefined) {
      return { activity: session.last_active || session.started_at || 0, index, session }
    }

    // The authoritative page has caught up: retire the local override. A kept
    // survivor is not authoritative and must not clear its own timestamp.
    if (fromAuthoritativePage && session.last_active >= optimisticAt) {
      optimisticSessionActivityByLineage.delete(lineageId)

      return { activity: session.last_active || session.started_at || 0, index, session }
    }

    hasOptimisticActivity = true

    return {
      activity: optimisticAt,
      index,
      session: session.last_active >= optimisticAt ? session : { ...session, last_active: optimisticAt }
    }
  })

  if (!hasOptimisticActivity) {
    return merged
  }

  // Preserve the server's relative order for equal activity while allowing a
  // genuinely newer completion from another session to outrank this turn.
  ranked.sort((left, right) => right.activity - left.activity || left.index - right.index)

  return ranked.map(item => item.session)
}

export const $connection = atom<FanConnection | null>(null)
export const $gatewayState = atom('idle')
export const $sessions = atom<SessionInfo[]>([])
const $sessionsTotal = atom<number>(0)
export const $sessionsLoading = atom(true)
export const $workingSessionIds = atom<string[]>([])
export const $activeSessionId = atom<string | null>(null)
export const $activeBrowserWorkbenchId = atom<string | null>(null)
export const $selectedStoredSessionId = atom<string | null>(null)
export const $messages = atom<ChatMessage[]>([])
export const $busy = atom(false)
export const $awaitingResponse = atom(false)
// Stored-session id whose latest resume left no runtime and no readable
// transcript. useRouteResume consumes this as a bounded self-heal signal.
export const $resumeFailedSessionId = atom<string | null>(null)
// Set only after automatic resume retries are exhausted, so the chat can show
// a terminal error and manual retry instead of an endless loading indicator.
export const $resumeExhaustedSessionId = atom<string | null>(null)

export const $currentModel = atom('')
// A brain model picked on a DRAFT (before the session exists). The chip can't call
// config.set without a session id, so it stashes the choice here; the create flow
// replays it via setSessionModel once the session is born (mirroring how the YOLO
// flag is armed on a draft) and clears it. Also gates applyRuntimeInfo from
// overwriting the optimistic pick with the server default in between.
export const $pendingModel = atom('')
/** A selectable brain (reasoning) LLM, sourced from the gateway `models.list` RPC. */
export interface ModelOption {
  id: string
  label: string
  supports_reasoning?: boolean
  supports_vision?: boolean
  capabilities?: string[]
}
export const $availableModels = atom<ModelOption[]>([])
export const $currentProvider = atom('')
export const $currentReasoningEffort = atom('')
const $currentServiceTier = atom('')
const $currentFastMode = atom(false)
// Effective approval-bypass state mirrored from the gateway (session.info).
// Persistence lives in the backend config (approvals.mode), so this is a plain
// reflection of the truth the gateway reports rather than its own store.
// Default = 完全访问 (YOLO on): a fresh session auto-approves dangerous commands
// (product decision). A resumed session still reflects its own stored flag (the
// gateway reports info.yolo on resume, which overrides this). The hardline
// blocklist in tools/approval.py still stops catastrophic commands regardless.
export const $yoloActive = atom(true)
export const $currentCwd = atom(getRememberedWorkspaceCwd())
export const $currentBranch = atom('')
export const $currentUsage = atom<UsageStats>({
  calls: 0,
  input: 0,
  output: 0,
  total: 0
})
export const $introPersonality = atom('')
const $currentPersonality = atom('')
const $availablePersonalities = atom<string[]>([])
export const $introSeed = atom(0)
export const $contextSuggestions = atom<ContextSuggestion[]>([])

export const setConnection = (next: Updater<FanConnection | null>) => updateAtom($connection, next)
export const setGatewayState = (next: Updater<string>) => updateAtom($gatewayState, next)
export const setSessions = (next: Updater<SessionInfo[]>) => updateAtom($sessions, next)
export const setSessionsTotal = (next: Updater<number>) => updateAtom($sessionsTotal, next)
export const setSessionsLoading = (next: Updater<boolean>) => updateAtom($sessionsLoading, next)
const setWorkingSessionIds = (next: Updater<string[]>) => updateAtom($workingSessionIds, next)
export const setActiveSessionId = (next: Updater<string | null>) => updateAtom($activeSessionId, next)
export const setActiveBrowserWorkbenchId = (next: Updater<string | null>) => updateAtom($activeBrowserWorkbenchId, next)
export const setSelectedStoredSessionId = (next: Updater<string | null>) => updateAtom($selectedStoredSessionId, next)
export const setMessages = (next: Updater<ChatMessage[]>) => updateAtom($messages, next)
export const setResumeFailedSessionId = (next: Updater<string | null>) =>
  updateAtom($resumeFailedSessionId, next)
export const setResumeExhaustedSessionId = (next: Updater<string | null>) =>
  updateAtom($resumeExhaustedSessionId, next)
export const setBusy = (next: Updater<boolean>) => updateAtom($busy, next)
export const setAwaitingResponse = (next: Updater<boolean>) => updateAtom($awaitingResponse, next)
export const setCurrentModel = (next: Updater<string>) => updateAtom($currentModel, next)
export const setPendingModel = (next: Updater<string>) => updateAtom($pendingModel, next)
export const setAvailableModels = (next: Updater<ModelOption[]>) => updateAtom($availableModels, next)
export const setCurrentProvider = (next: Updater<string>) => updateAtom($currentProvider, next)
export const setCurrentReasoningEffort = (next: Updater<string>) => updateAtom($currentReasoningEffort, next)
export const setCurrentServiceTier = (next: Updater<string>) => updateAtom($currentServiceTier, next)
export const setCurrentFastMode = (next: Updater<boolean>) => updateAtom($currentFastMode, next)
export const setYoloActive = (next: Updater<boolean>) => updateAtom($yoloActive, next)

/** Optimistically reflect an accepted user turn before the server's recent
 *  sessions projection catches up. The stable stored/lineage id is required:
 *  runtime ids can rotate after resume or compression. */
export function promoteSessionActivity(sessionId: null | string | undefined, at = Date.now() / 1000): void {
  const id = sessionId?.trim()

  if (!id || !Number.isFinite(at)) {
    return
  }

  setSessions(current => {
    const index = current.findIndex(session => session.id === id || session._lineage_root_id === id)

    if (index < 0) {
      return current
    }

    const session = current[index]
    const lastActive = Math.max(session.last_active || session.started_at || 0, at)
    const promoted = lastActive === session.last_active ? session : { ...session, last_active: lastActive }

    optimisticSessionActivityByLineage.set(
      sessionPinId(session),
      Math.max(optimisticSessionActivityByLineage.get(sessionPinId(session)) ?? 0, lastActive)
    )

    if (index === 0 && promoted === session) {
      return current
    }

    return [promoted, ...current.slice(0, index), ...current.slice(index + 1)]
  })
}

export const setCurrentCwd = (next: Updater<string>) => {
  updateAtom($currentCwd, next)
  // Keep localStorage in sync with the atom: a real folder is remembered, an
  // empty cwd clears the key (|| null → removeItem).
  persistString(WORKSPACE_CWD_KEY, $currentCwd.get().trim() || null)
}

// Cached copy of Settings → Sessions → Default project directory. The main
// process persists it (project-dir.json), but the renderer must ALSO honor it
// when seeding $currentCwd — otherwise the sticky-localStorage cwd wins and new
// sessions ignore the user's explicit picker choice.
let configuredDefaultProjectDir = ''

const getConfiguredDefaultProjectDir = (): string => configuredDefaultProjectDir

export function applyConfiguredDefaultProjectDir(dir: null | string | undefined): void {
  configuredDefaultProjectDir = dir?.trim() || ''
  // Cache only; seed the live workspace for a NEW chat (no active session).
  // Never rewrite a session's cwd mid-flight.
  if (configuredDefaultProjectDir && !$activeSessionId.get()) {
    setCurrentCwd(configuredDefaultProjectDir)
  }
}

// Cache the configured default dir (no seed).
async function syncConfiguredDefaultProjectDir(): Promise<string> {
  const getDir = window.fanDesktop?.settings?.getDefaultProjectDir
  if (!getDir) {
    configuredDefaultProjectDir = ''

    return ''
  }
  try {
    const { dir } = await getDir()
    configuredDefaultProjectDir = dir?.trim() || ''
  } catch {
    configuredDefaultProjectDir = ''
  }

  return configuredDefaultProjectDir
}

// Boot-time workspace seed: sanitize the configured default dir (or the
// remembered cwd) through the main process — rejecting install-dir / missing
// paths — before seeding $currentCwd for a NEW chat.
export async function ensureDefaultWorkspaceCwd(): Promise<void> {
  const sanitize = window.fanDesktop?.sanitizeWorkspaceCwd
  if (!sanitize) {
    // No sanitize IPC: fall back to the unsanitized configured-dir seed.
    await syncConfiguredDefaultProjectDir()
    applyConfiguredDefaultProjectDir(getConfiguredDefaultProjectDir())

    return
  }

  await syncConfiguredDefaultProjectDir()
  const configured = getConfiguredDefaultProjectDir()

  const seedLiveCwd = (cwd: string) => {
    if (cwd && !$activeSessionId.get()) {
      setCurrentCwd(cwd)
    }
  }

  try {
    if (configured) {
      const { cwd } = await sanitize(configured)
      seedLiveCwd(cwd)

      return
    }

    const { cwd } = await sanitize(getRememberedWorkspaceCwd())
    seedLiveCwd(cwd)
  } catch {
    // Best-effort.
  }
}

export const setCurrentBranch = (next: Updater<string>) => updateAtom($currentBranch, next)
export const setCurrentUsage = (next: Updater<UsageStats>) => updateAtom($currentUsage, next)
export const setIntroPersonality = (next: Updater<string>) => updateAtom($introPersonality, next)
export const setCurrentPersonality = (next: Updater<string>) => updateAtom($currentPersonality, next)
export const setAvailablePersonalities = (next: Updater<string[]>) => updateAtom($availablePersonalities, next)
export const setIntroSeed = (next: Updater<number>) => updateAtom($introSeed, next)
export const setContextSuggestions = (next: Updater<ContextSuggestion[]>) => updateAtom($contextSuggestions, next)

// Watchdog tracking — when does a "working" session count as stuck?
// Long-running tool calls (LLM inference, long shell commands, web fetches)
// can take a few minutes legitimately. We allow 8 minutes of complete
// silence on the stream before clearing the working flag; in practice this
// catches gateway hangs and dropped streams without false-positive-clearing
// real long turns.
const SESSION_WATCHDOG_TIMEOUT_MS = 8 * 60 * 1000
const sessionWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()

function armSessionWatchdog(sessionId: string) {
  const existing = sessionWatchdogTimers.get(sessionId)

  if (existing) {
    clearTimeout(existing)
  }

  const timer = setTimeout(() => {
    sessionWatchdogTimers.delete(sessionId)

    // Re-check the latest state at fire-time. Route through setSessionWorking
    // (NOT a raw setWorkingSessionIds) so a silently-dead turn — dropped stream
    // / gateway hang reaped here — still crosses the ONE working→idle edge that
    // marks it unread. That abnormal-finish case is exactly what a user needs
    // flagged. setSessionWorking is a no-op if it already settled.
    setSessionWorking(sessionId, false)
  }, SESSION_WATCHDOG_TIMEOUT_MS)

  sessionWatchdogTimers.set(sessionId, timer)
}

function clearSessionWatchdog(sessionId: string) {
  const existing = sessionWatchdogTimers.get(sessionId)

  if (existing) {
    clearTimeout(existing)
    sessionWatchdogTimers.delete(sessionId)
  }
}

// A session's "working" flag clears the instant its turn ends, but the
// listSessions aggregator (min_messages=1) only sees the just-persisted first
// turn a beat later. The active chat is shielded by the keep-set, but a
// brand-new session that finished *while you viewed a different chat* is, at the
// next refresh, neither working/pinned/active — so mergeSessionPage evicts it
// and nothing re-fetches. Keep it in the keep-set for a short grace period after
// its turn settles. Entries auto-expire (bounded, no timer) and can't resurrect
// a deleted row (mergeSessionPage only revives rows still in the in-memory
// list).
const SESSION_SETTLE_GRACE_MS = 30 * 1000
const settledSessionExpiry = new Map<string, number>()

function markSessionSettled(sessionId: string) {
  settledSessionExpiry.set(sessionId, Date.now() + SESSION_SETTLE_GRACE_MS)
}

function clearSessionSettled(sessionId: string) {
  settledSessionExpiry.delete(sessionId)
}

/** Stored ids of sessions whose turn ended within the grace window. Prunes
 *  expired entries as it reads, so it stays bounded without a timer. */
export function getRecentlySettledSessionIds(now: number = Date.now()): string[] {
  const live: string[] = []

  for (const [id, expiry] of settledSessionExpiry) {
    if (expiry > now) {
      live.push(id)
    } else {
      settledSessionExpiry.delete(id)
    }
  }

  return live
}

/** Call when a streaming event for a session lands. Refreshes the watchdog
 *  so the session keeps its "working" status as long as data keeps coming. */
export function noteSessionActivity(sessionId: string | null | undefined) {
  if (!sessionId || !$workingSessionIds.get().includes(sessionId)) {
    return
  }

  armSessionWatchdog(sessionId)
}

// Toggle an id's membership in a string-set atom, no-op when unchanged (keeps
// the same array reference so subscribers don't churn).
const toggleMembership = (set: (next: Updater<string[]>) => void, id: string, on: boolean) =>
  set(current => {
    const present = current.includes(id)

    if (on) {
      return present ? current : [...current, id]
    }

    return present ? current.filter(x => x !== id) : current
  })

// Stored session ids with a blocking prompt waiting on the user.
// Separate from $workingSessionIds: a session can be "working" (turn running)
// AND need input. The sidebar row reads this for a persistent indicator that,
// unlike a toast, survives window blur / alt-tab.
export const $attentionSessionIds = atom<string[]>([])
const setAttentionSessionIds = (next: Updater<string[]>) => updateAtom($attentionSessionIds, next)

export function setSessionAttention(sessionId: string | null | undefined, needsInput: boolean) {
  if (sessionId) {
    toggleMembership(setAttentionSessionIds, sessionId, needsInput)
  }
}

export function setSessionWorking(sessionId: string | null | undefined, working: boolean) {
  if (!sessionId) {
    return
  }

  const wasWorking = $workingSessionIds.get().includes(sessionId)

  toggleMembership(setWorkingSessionIds, sessionId, working)

  // Bookend the watchdog: arm on enter, disarm on leave. A later
  // noteSessionActivity() from a streaming event refreshes the timer.
  if (working) {
    clearSessionSettled(sessionId)
    armSessionWatchdog(sessionId)
  } else {
    clearSessionWatchdog(sessionId)
    // Only grant grace on a real working→idle transition (state ticks re-assert
    // `false` and must not keep extending the window), so the just-finished
    // session stays visible until the aggregator returns its persisted row.
    if (wasWorking) {
      markSessionSettled(sessionId)
      // The turn just finished. Badge it unread UNLESS its chat transcript is
      // already on screen. The embedded browser is a separate WebContentsView:
      // focusing that page makes the renderer's document.hasFocus() false even
      // though the user is still inside this exact session. Route/view identity
      // is therefore the read boundary, not renderer-DOM focus.
      const watching = sessionId === $viewingSessionId.get()
      if (!watching) {
        markSessionUnread(sessionId)
      }
    }
  }
}

// ── Unread task badges ───────────────────────────────────────────────────────
// A session whose agent finished a turn while you WEREN'T watching its chat is
// "unread" until you open it — the "a task completed, go look" signal the user
// asked for. Distinct from $attentionSessionIds (blocking, needs-input mid-turn;
// unread is completed, post-turn). Client-local + persisted: it's per-viewer
// state, and the gateway models no per-client identity, so a server flag would
// be shared across devices and cleared by whichever client opens first.
const UNREAD_KEY = 'fan.desktop.unread-sessions'
export const $unreadSessionIds = atom<string[]>(storedStringArray(UNREAD_KEY))
const setUnreadSessionIds = (next: Updater<string[]>) => updateAtom($unreadSessionIds, next)

function markSessionUnread(sessionId: string | null | undefined) {
  if (!sessionId) {return}
  toggleMembership(setUnreadSessionIds, sessionId, true)
  persistStringArray(UNREAD_KEY, $unreadSessionIds.get())
}

export function clearSessionUnread(sessionId: string | null | undefined) {
  if (!sessionId) {return}
  const before = $unreadSessionIds.get()
  toggleMembership(setUnreadSessionIds, sessionId, false)
  // toggleMembership returns the same array reference on a no-op, so only write
  // through when something actually changed.
  if ($unreadSessionIds.get() !== before) {
    persistStringArray(UNREAD_KEY, $unreadSessionIds.get())
  }
}

// The stored id of the chat transcript currently on screen (null in the overview
// / settings). The unread trigger consults it so a turn finishing on the session
// you're reading is not badged; setting it (= opening a session) clears its badge
// — the single "read" edge every open path funnels through.
const $viewingSessionId = atom<string | null>(null)
export function setViewingSessionId(sessionId: string | null) {
  updateAtom($viewingSessionId, sessionId)
  clearSessionUnread(sessionId)
}
