import { useEffect, useRef } from 'react'

import type { FanBrowserControlState, FanBrowserEvent } from '@/global'
import { applyBrowserControlEvent, applyBrowserOperatingEvent } from '@/store/browser-control'
import { $activeBrowserWorkbenchId } from '@/store/session'
import {
  $sessionLayoutPreference,
  markSessionBrowserAutoRevealed
} from '@/store/session-layout'
import { $sessionTabs, type SessionTabInfo, setSessionTabs } from '@/store/session-tabs'

import { sanitizePersistedFavicon } from './chat/tab-favicon'

const MAX_PERSISTED_TABS = 20
const DEFAULT_METADATA_COALESCE_MS = 250

export interface PersistedBrowserTab {
  favicon?: string
  title: string
  url: string
}

export interface PersistedBrowserState {
  active: number
  tabs: PersistedBrowserTab[]
}

export interface BrowserTabsSnapshot {
  active: number
  tabs: SessionTabInfo[]
}

interface NormalizedBrowserState {
  canonicalKey: string
  criticalKey: string
  state: PersistedBrowserState
}

interface PendingWrite {
  ready: boolean
  snapshot: NormalizedBrowserState
}

interface WorkbenchQueue {
  drainPromise: null | Promise<void>
  inFlight: NormalizedBrowserState | null
  lastPersisted: NormalizedBrowserState | null
  metadataTimer: null | ReturnType<typeof globalThis.setTimeout>
  pending: PendingWrite | null
}

// Kept behind a function so TypeScript does not incorrectly assume the value
// is still null after an awaited Gateway write; enqueue() may run meanwhile.
function pendingWriteAfterAwait(queue: WorkbenchQueue): PendingWrite | null {
  return queue.pending
}

export type BrowserStateWriter = (workbenchId: string, state: PersistedBrowserState) => Promise<unknown>

interface BrowserStatePersistenceOptions {
  metadataCoalesceMs?: number
}

interface BrowserPersistenceApi {
  listTabs: (id: string) => Promise<{ active: number; ok: boolean; tabs: SessionTabInfo[] }>
  onEvent: (callback: (event: FanBrowserEvent) => void) => () => void
}

export interface BrowserStatePersistenceAttachment {
  detach: () => void
  seed: (workbenchId: string) => void
}

interface GatewayRequest {
  <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
}

export function isInternalWorkbenchUrl(value: null | string | undefined): boolean {
  if (!value || value === 'about:blank') {
    return true
  }

  try {
    const parsed = new URL(value)

    return parsed.pathname === '/start' && parsed.searchParams.has('ws')
  } catch {
    return false
  }
}

/**
 * Converts a live Chromium tab snapshot into the bounded, durable shape stored
 * with a session. Empty snapshots are intentionally rejected: runtime teardown
 * emits one after destroying a workbench and it must never erase the last valid
 * restorable page set.
 */
export function normalizeBrowserState(snapshot: BrowserTabsSnapshot): NormalizedBrowserState | null {
  const sourceTabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : []
  const activeSourceIndex = Number.isSafeInteger(snapshot.active) ? snapshot.active : 0

  const kept = sourceTabs
    .map((tab, sourceIndex) => ({ sourceIndex, tab }))
    .filter(({ tab }) => typeof tab?.url === 'string' && Boolean(tab.url.trim()) && !isInternalWorkbenchUrl(tab.url))
    .slice(0, MAX_PERSISTED_TABS)

  if (kept.length === 0) {
    return null
  }

  const tabs = kept.map(({ tab }) => {
    const favicon = sanitizePersistedFavicon(tab.favicon)

    return {
      title: typeof tab.title === 'string' ? tab.title : '',
      url: tab.url.trim(),
      ...(favicon ? { favicon } : {})
    }
  })

  const mappedActive = kept.findIndex(({ sourceIndex }) => sourceIndex === activeSourceIndex)
  const state = { active: mappedActive >= 0 ? mappedActive : 0, tabs }

  return {
    canonicalKey: JSON.stringify(state),
    // Active selection and ordered URLs are the durable browser topology. A
    // title/favicon refresh is metadata-only and can be coalesced briefly.
    criticalKey: JSON.stringify([state.active, state.tabs.map(tab => tab.url)]),
    state
  }
}

/**
 * A per-workbench write coordinator. Writes for one workbench are strictly
 * serial and collapse to the newest pending snapshot; unrelated workbenches do
 * not block one another.
 */
export class BrowserStatePersistenceCoordinator {
  readonly #metadataCoalesceMs: number
  readonly #queues = new Map<string, WorkbenchQueue>()
  readonly #writer: BrowserStateWriter

  constructor(writer: BrowserStateWriter, options: BrowserStatePersistenceOptions = {}) {
    this.#writer = writer
    this.#metadataCoalesceMs = options.metadataCoalesceMs ?? DEFAULT_METADATA_COALESCE_MS
  }

  enqueue(workbenchId: string, state: BrowserTabsSnapshot): boolean {
    const id = String(workbenchId || '').trim()
    const snapshot = normalizeBrowserState(state)

    if (!id || !snapshot) {
      return false
    }

    const queue = this.#queueFor(id)
    const latest = queue.pending?.snapshot ?? queue.inFlight ?? queue.lastPersisted

    if (latest?.canonicalKey === snapshot.canonicalKey) {
      // A retained failed write is still pending. Receiving the same state is a
      // useful retry signal, but an already-debounced metadata write keeps its
      // original deadline so repeated identical events cannot starve it.
      if (queue.pending) {
        if (queue.pending.ready) {
          void this.#startDrain(id, queue).catch(() => undefined)
        } else if (queue.metadataTimer === null) {
          this.#schedule(id, queue, false)
        }
      }

      return false
    }

    const criticalChange = !latest || latest.criticalKey !== snapshot.criticalKey
    const ready = criticalChange || queue.pending?.ready === true
    queue.pending = { ready, snapshot }
    this.#schedule(id, queue, ready)

    return true
  }

  async flush(workbenchId: string): Promise<void> {
    const id = String(workbenchId || '').trim()
    const queue = this.#queues.get(id)

    if (!queue) {
      return
    }

    this.#clearMetadataTimer(queue)

    while (queue.pending || queue.drainPromise) {
      if (queue.pending) {
        queue.pending.ready = true
      }

      await this.#startDrain(id, queue)
    }
  }

  async flushAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#queues.keys()].map(id => this.flush(id)))

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to persist one or more browser workbenches')
    }
  }

  dispose(): void {
    for (const queue of this.#queues.values()) {
      this.#clearMetadataTimer(queue)
      queue.pending = null
    }
  }

  #clearMetadataTimer(queue: WorkbenchQueue): void {
    if (queue.metadataTimer !== null) {
      globalThis.clearTimeout(queue.metadataTimer)
      queue.metadataTimer = null
    }
  }

  async #drain(id: string, queue: WorkbenchQueue): Promise<void> {
    while (queue.pending?.ready) {
      const current = queue.pending.snapshot
      queue.pending = null

      if (queue.lastPersisted?.canonicalKey === current.canonicalKey) {
        continue
      }

      queue.inFlight = current

      try {
        await this.#writer(id, current.state)
        queue.lastPersisted = current
      } catch (error) {
        // Preserve the newest desired state for an explicit flush or the next
        // runtime event. Do not spin in an unbounded retry loop while the
        // Gateway is unavailable.
        const newerPending = pendingWriteAfterAwait(queue)

        if (!newerPending) {
          queue.pending = { ready: false, snapshot: current }
        } else {
          newerPending.ready = false
        }

        throw error
      } finally {
        queue.inFlight = null
      }
    }
  }

  #finishDrain(id: string, queue: WorkbenchQueue, run: Promise<void>, failed: boolean): void {
    // Only the owner that published this run may retire it. This protects a
    // newer lifecycle from stale completion cleanup if the implementation is
    // ever made re-entrant.
    if (queue.drainPromise !== run) {
      return
    }

    queue.drainPromise = null

    // A critical event may land after #drain's final queue check but before
    // this settlement callback. Start a fresh owner so it cannot be stranded.
    // Failed writes remain pending and wait for an explicit retry signal.
    if (!failed && queue.pending?.ready) {
      void this.#startDrain(id, queue).catch(() => undefined)
    }
  }

  #queueFor(id: string): WorkbenchQueue {
    const current = this.#queues.get(id)

    if (current) {
      return current
    }

    const created: WorkbenchQueue = {
      drainPromise: null,
      inFlight: null,
      lastPersisted: null,
      metadataTimer: null,
      pending: null
    }

    this.#queues.set(id, created)

    return created
  }

  #schedule(id: string, queue: WorkbenchQueue, immediate: boolean): void {
    this.#clearMetadataTimer(queue)

    if (immediate) {
      if (queue.pending) {
        queue.pending.ready = true
      }

      void this.#startDrain(id, queue).catch(() => undefined)

      return
    }

    queue.metadataTimer = globalThis.setTimeout(() => {
      queue.metadataTimer = null

      if (queue.pending) {
        queue.pending.ready = true
      }

      void this.#startDrain(id, queue).catch(() => undefined)
    }, this.#metadataCoalesceMs)
  }

  #startDrain(id: string, queue: WorkbenchQueue): Promise<void> {
    if (queue.drainPromise) {
      return queue.drainPromise
    }

    if (!queue.pending?.ready) {
      return Promise.resolve()
    }

    // Publish a lifecycle wrapper before #drain starts. This preserves the
    // existing immediate writer dispatch while ensuring even a synchronous
    // no-op drain cannot settle before its owner is visible on the queue.
    let rejectRun!: (reason?: unknown) => void
    let resolveRun!: () => void

    const run = new Promise<void>((resolve, reject) => {
      rejectRun = reject
      resolveRun = resolve
    })

    queue.drainPromise = run

    // #startDrain is the single owner of drainPromise. #drain only consumes
    // snapshots; settlement, cleanup and continuation all stay here.
    void run.then(
      () => this.#finishDrain(id, queue, run, false),
      () => this.#finishDrain(id, queue, run, true)
    )
    void this.#drain(id, queue).then(resolveRun, rejectRun)

    return run
  }
}

/** Attach the application-level runtime event feed to one persistence owner. */
export function attachBrowserStatePersistence(
  api: BrowserPersistenceApi,
  coordinator: BrowserStatePersistenceCoordinator
): BrowserStatePersistenceAttachment {
  const pushedRevisions = new Map<string, number>()
  let disposed = false

  const pullAuthoritativeTabs = (id: string, flushAfter: boolean) => {
    const startingRevision = pushedRevisions.get(id) ?? 0
    const startingStoreState = $sessionTabs.get()[id]

    void api
      .listTabs(id)
      .then(result => {
        if (
          disposed ||
          !result?.ok ||
          (pushedRevisions.get(id) ?? 0) !== startingRevision ||
          $sessionTabs.get()[id] !== startingStoreState
        ) {
          return
        }

        const state = {
          active: typeof result.active === 'number' ? result.active : 0,
          tabs: Array.isArray(result.tabs) ? result.tabs : []
        }

        setSessionTabs(id, state)
        coordinator.enqueue(id, state)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!disposed && flushAfter) {
          void coordinator.flush(id).catch(() => undefined)
        }
      })
  }

  const unsubscribe = api.onEvent(event => {
    if (disposed) {
      return
    }

    if (event?.type === 'tabs.state') {
      const payload = event.payload as unknown as {
        active?: number
        destroyed?: boolean
        id?: string
        tabs?: SessionTabInfo[]
      }

      const id = typeof payload.id === 'string' ? payload.id : ''

      if (!id) {
        return
      }

      const state = {
        active: typeof payload.active === 'number' ? payload.active : 0,
        tabs: Array.isArray(payload.tabs) ? payload.tabs : []
      }

      pushedRevisions.set(id, (pushedRevisions.get(id) ?? 0) + 1)
      setSessionTabs(id, state)

      // destroy() emits a terminal empty tabs.state. The live store should
      // clear, but the durable page set must remain available for restoration.
      if (!(payload.destroyed === true && state.tabs.length === 0)) {
        coordinator.enqueue(id, state)
      }

      return
    }

    if (event?.type === 'operating.state') {
      const accepted = applyBrowserOperatingEvent(event.type, event.payload)
      const operating = event.payload as unknown as { active?: boolean; id?: string }

      if (
        accepted &&
        operating.active === true &&
        operating.id === $activeBrowserWorkbenchId.get() &&
        $sessionLayoutPreference.get() === 'chat'
      ) {
        // Record the reveal synchronously with the runtime event. A very fast
        // action may start and finish before React commits an effect, but the
        // resulting browser page should still remain visible for inspection.
        markSessionBrowserAutoRevealed(operating.id)
      }

      return
    }

    if (event?.type !== 'control.state') {
      return
    }

    const accepted = applyBrowserControlEvent(event.type, event.payload)
    const control = event.payload as unknown as Partial<FanBrowserControlState>
    const id = typeof control.id === 'string' ? control.id : ''

    if (!accepted || control.active !== false || !id) {
      return
    }

    // The final tabs.state can precede or follow control.stop. Pull once from
    // main after the Agent releases control, then durably flush the newest
    // authoritative snapshot before the workbench becomes idle.
    pullAuthoritativeTabs(id, true)
  })

  return {
    detach() {
      disposed = true
      unsubscribe()
    },
    seed(workbenchId) {
      const id = String(workbenchId || '').trim()

      if (id && !disposed) {
        // IPC events are not replayed after a renderer reload. Seed the active
        // workbench once, while the revision/store guards above prevent a
        // delayed pull from replacing any newer push that arrives meanwhile.
        pullAuthoritativeTabs(id, false)
      }
    }
  }
}

let mountedCoordinator: BrowserStatePersistenceCoordinator | null = null

/** Used by the native quit handshake to await every acknowledged Gateway write. */
export function flushAllBrowserStatePersistence(): Promise<void> {
  return mountedCoordinator?.flushAll() ?? Promise.resolve()
}

/**
 * Owns persistence for the lifetime of DesktopWorkspace, independent of
 * whether SessionBrowser is mounted on the chat route or Canvas is visible.
 */
export function useBrowserStatePersistence(requestGateway: GatewayRequest, activeWorkbenchId?: null | string): void {
  const requestGatewayRef = useRef(requestGateway)
  requestGatewayRef.current = requestGateway
  const coordinatorRef = useRef<BrowserStatePersistenceCoordinator | null>(null)
  const attachmentRef = useRef<BrowserStatePersistenceAttachment | null>(null)

  if (!coordinatorRef.current) {
    coordinatorRef.current = new BrowserStatePersistenceCoordinator((browserWorkbenchId, state) =>
      requestGatewayRef.current('session.browserState.set', {
        browser_workbench_id: browserWorkbenchId,
        state
      })
    )
  }

  useEffect(() => {
    const coordinator = coordinatorRef.current
    const api = window.fanDesktop?.browser

    if (!coordinator || !api?.onEvent || !api.listTabs) {
      return
    }

    mountedCoordinator = coordinator
    const attachment = attachBrowserStatePersistence(api, coordinator)
    attachmentRef.current = attachment

    const detachBeforeQuit = window.fanDesktop?.lifecycle?.onBeforeQuit(() => {
      // Main owns the hard timeout. Always release its quit gate, even when the
      // Gateway is already unavailable, after every workbench got one durable
      // write attempt.
      void coordinator
        .flushAll()
        .catch(() => undefined)
        .finally(() => window.fanDesktop?.lifecycle?.completeQuitFlush())
    })

    const flushBestEffort = () => {
      void coordinator.flushAll().catch(() => undefined)
    }

    window.addEventListener('beforeunload', flushBestEffort)
    window.addEventListener('pagehide', flushBestEffort)

    return () => {
      attachment.detach()

      if (attachmentRef.current === attachment) {
        attachmentRef.current = null
      }

      detachBeforeQuit?.()
      window.removeEventListener('beforeunload', flushBestEffort)
      window.removeEventListener('pagehide', flushBestEffort)

      if (mountedCoordinator === coordinator) {
        mountedCoordinator = null
      }

      void coordinator
        .flushAll()
        .catch(() => undefined)
        .finally(() => {
          // React StrictMode rehearses cleanup/setup with the same ref. Do not
          // let the first cleanup dispose queues after that coordinator has
          // already become the active owner again.
          if (mountedCoordinator !== coordinator) {
            coordinator.dispose()
          }
        })
    }
  }, [])

  useEffect(() => {
    const id = String(activeWorkbenchId || '').trim()

    if (id) {
      attachmentRef.current?.seed(id)
    }
  }, [activeWorkbenchId])
}
