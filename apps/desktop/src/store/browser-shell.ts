import { atom, computed, type ReadableAtom } from 'nanostores'

import type {
  FanBrowserShellActionResult,
  FanBrowserShellDownload,
  FanBrowserShellDownloadState,
  FanBrowserShellHealth,
  FanBrowserShellHealthStatus,
  FanBrowserShellNotice,
  FanBrowserShellPrompt,
  FanBrowserShellSnapshot
} from '@/global'

type BrowserShellArchive<T> = Readonly<Record<string, Readonly<Record<string, readonly T[]>>>>

export interface BrowserShellState {
  downloads: BrowserShellArchive<FanBrowserShellDownload>
  health: BrowserShellArchive<FanBrowserShellHealth>
  hydrated: boolean
  notices: BrowserShellArchive<FanBrowserShellNotice>
  prompts: BrowserShellArchive<FanBrowserShellPrompt>
  revision: number
}

const MAX_DOWNLOADS = 64
const MAX_HEALTH_RECORDS = 128
const MAX_NOTICES = 64
const MAX_PROMPTS = 32

const EMPTY_STATE: BrowserShellState = {
  downloads: {},
  health: {},
  hydrated: false,
  notices: {},
  prompts: {},
  revision: 0
}

export const $browserShell = atom<BrowserShellState>(EMPTY_STATE)

export const $pendingBrowserShellPrompt: ReadableAtom<FanBrowserShellPrompt | null> = computed(
  $browserShell,
  state =>
    flattenArchive(state.prompts)
      .filter(prompt => prompt.pending)
      .sort((a, b) => a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId))[0] ?? null
)

let attachmentCount = 0
let attachmentGeneration = 0
let unsubscribeFromEvents: null | (() => void) = null
const promptTombstones = new Map<string, number>()
const healthTombstones = new Map<string, number>()
const noticeTombstones = new Map<string, number>()

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function documentRevision(value: unknown): null | number | string {
  if (value == null) {
    return null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return typeof value === 'string' ? value : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function shellScope(value: Record<string, unknown>, tabRequired: boolean) {
  const eventId = stringValue(value.eventId)
  const tabId = stringValue(value.tabId)
  const workbenchId = stringValue(value.workbenchId)

  if (!eventId || !workbenchId || (tabRequired && !tabId)) {
    return null
  }

  return {
    documentRevision: documentRevision(value.documentRevision),
    eventId,
    tabId,
    workbenchId
  }
}

const DOWNLOAD_STATES = new Set<FanBrowserShellDownloadState>([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
  'paused',
  'progressing',
  'started'
])

const HEALTH_STATUSES = new Set<FanBrowserShellHealthStatus>(['crashed', 'degraded', 'ok', 'unresponsive'])

function normalizePrompt(value: unknown): FanBrowserShellPrompt | null {
  const record = objectValue(value)
  const scope = record ? shellScope(record, true) : null
  const createdAt = record ? finiteNumber(record.createdAt) : null

  if (!record || !scope || createdAt === null || typeof record.pending !== 'boolean') {
    return null
  }

  return {
    ...scope,
    accepted: typeof record.accepted === 'boolean' ? record.accepted : undefined,
    actions: stringList(record.actions),
    code: stringValue(record.code),
    createdAt,
    defaultValue: stringValue(record.defaultValue),
    dialogType: stringValue(record.dialogType),
    host: stringValue(record.host),
    kind: stringValue(record.kind) || 'generic',
    message: stringValue(record.message),
    pending: record.pending,
    permission: stringValue(record.permission),
    resolution: stringValue(record.resolution) || undefined,
    resolvedAt: finiteNumber(record.resolvedAt) ?? undefined,
    revision: finiteNumber(record.revision) ?? undefined,
    scheme: stringValue(record.scheme)
  }
}

function normalizeDownload(value: unknown): FanBrowserShellDownload | null {
  const record = objectValue(value)
  const scope = record ? shellScope(record, true) : null
  const state = record ? stringValue(record.state) : ''
  const phase = record ? stringValue(record.phase) : ''
  const receivedBytes = record ? finiteNumber(record.receivedBytes) : null
  const totalBytes = record ? finiteNumber(record.totalBytes) : null
  const startedAt = record ? finiteNumber(record.startedAt) : null
  const updatedAt = record ? finiteNumber(record.updatedAt) : null

  if (
    !record ||
    !scope ||
    !DOWNLOAD_STATES.has(state as FanBrowserShellDownloadState) ||
    (phase !== 'started' && phase !== 'progress' && phase !== 'done') ||
    receivedBytes === null ||
    receivedBytes < 0 ||
    totalBytes === null ||
    totalBytes < 0 ||
    startedAt === null ||
    updatedAt === null
  ) {
    return null
  }

  return {
    ...scope,
    canOpen: record.canOpen === true,
    canReveal: record.canReveal === true,
    done: record.done === true,
    doneAt: finiteNumber(record.doneAt),
    downloadId: stringValue(record.downloadId) || scope.eventId,
    filename: stringValue(record.filename) || '未命名下载',
    phase,
    receivedBytes,
    revision: finiteNumber(record.revision) ?? undefined,
    startedAt,
    state: state as FanBrowserShellDownloadState,
    totalBytes,
    updatedAt
  }
}

function normalizeHealth(value: unknown): FanBrowserShellHealth | null {
  const record = objectValue(value)
  const scope = record ? shellScope(record, false) : null
  const status = record ? stringValue(record.status) : ''
  const updatedAt = record ? finiteNumber(record.updatedAt) : null

  if (!record || !scope || !HEALTH_STATUSES.has(status as FanBrowserShellHealthStatus) || updatedAt === null) {
    return null
  }

  return {
    ...scope,
    active: record.active !== false,
    clearedAt: finiteNumber(record.clearedAt) ?? undefined,
    code: stringValue(record.code),
    revision: finiteNumber(record.revision) ?? undefined,
    status: status as FanBrowserShellHealthStatus,
    updatedAt
  }
}

function normalizeNotice(value: unknown): FanBrowserShellNotice | null {
  const record = objectValue(value)
  const scope = record ? shellScope(record, false) : null
  const level = record ? stringValue(record.level) : ''
  const raisedAt = record ? finiteNumber(record.raisedAt) : null

  if (
    !record ||
    !scope ||
    (level !== 'info' && level !== 'warning' && level !== 'error') ||
    raisedAt === null
  ) {
    return null
  }

  return {
    ...scope,
    actions: stringList(record.actions),
    active: record.active !== false,
    clearedAt: finiteNumber(record.clearedAt) ?? undefined,
    code: stringValue(record.code),
    level,
    raisedAt,
    revision: finiteNumber(record.revision) ?? undefined
  }
}

function flattenArchive<T>(archive: BrowserShellArchive<T>): T[] {
  return Object.values(archive).flatMap(tabs => Object.values(tabs).flatMap(records => [...records]))
}

function rebuildArchive<T extends { tabId: string; workbenchId: string }>(records: readonly T[]): BrowserShellArchive<T> {
  const archive: Record<string, Record<string, T[]>> = {}

  for (const record of records) {
    const workbench = (archive[record.workbenchId] ??= {})
    const tab = (workbench[record.tabId] ??= [])
    tab.push(record)
  }

  return archive
}

function upsertArchive<T extends { eventId: string; tabId: string; workbenchId: string }>(
  archive: BrowserShellArchive<T>,
  next: T,
  maxRecords: number,
  versionFor: (record: T) => number,
  snapshot: boolean
): BrowserShellArchive<T> {
  const records = flattenArchive(archive)
  const previousIndex = records.findIndex(record => record.eventId === next.eventId)

  if (previousIndex >= 0) {
    const previous = records[previousIndex]
    const previousVersion = versionFor(previous)
    const nextVersion = versionFor(next)

    if (nextVersion < previousVersion || (snapshot && nextVersion === previousVersion)) {
      return archive
    }

    records.splice(previousIndex, 1)
  }

  records.push(next)
  records.sort((a, b) => versionFor(b) - versionFor(a) || b.eventId.localeCompare(a.eventId))

  return rebuildArchive(records.slice(0, maxRecords))
}

function removeArchiveRecord<T extends { eventId: string; tabId: string; workbenchId: string }>(
  archive: BrowserShellArchive<T>,
  eventId: string
): BrowserShellArchive<T> {
  const records = flattenArchive(archive)
  const remaining = records.filter(record => record.eventId !== eventId)

  return remaining.length === records.length ? archive : rebuildArchive(remaining)
}

function recordTombstone(tombstones: Map<string, number>, eventId: string, version: number): void {
  tombstones.set(eventId, Math.max(tombstones.get(eventId) ?? 0, version))

  if (tombstones.size <= MAX_DOWNLOADS * 4) {
    return
  }

  const newest = [...tombstones.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DOWNLOADS * 2)

  tombstones.clear()

  for (const [id, updatedAt] of newest) {
    tombstones.set(id, updatedAt)
  }
}

function promptVersion(prompt: FanBrowserShellPrompt): number {
  return prompt.resolvedAt ?? prompt.createdAt
}

function noticeVersion(notice: FanBrowserShellNotice): number {
  return notice.clearedAt ?? notice.raisedAt
}

function applyPrompt(prompt: FanBrowserShellPrompt, snapshot = false): boolean {
  const version = promptVersion(prompt)
  const tombstoneAt = promptTombstones.get(prompt.eventId)

  if (!prompt.pending) {
    recordTombstone(promptTombstones, prompt.eventId, version)
    const state = $browserShell.get()
    const prompts = removeArchiveRecord(state.prompts, prompt.eventId)

    if (prompts !== state.prompts) {
      $browserShell.set({ ...state, prompts })
    }

    return true
  }

  if (tombstoneAt != null && tombstoneAt >= version) {
    return false
  }

  const state = $browserShell.get()
  const prompts = upsertArchive(state.prompts, prompt, MAX_PROMPTS, promptVersion, snapshot)

  if (prompts === state.prompts) {
    return false
  }

  $browserShell.set({ ...state, prompts })

  return true
}

function applyDownload(download: FanBrowserShellDownload, snapshot = false): boolean {
  const state = $browserShell.get()

  const downloads = upsertArchive(
    state.downloads,
    download,
    MAX_DOWNLOADS,
    record => record.updatedAt,
    snapshot
  )

  if (downloads === state.downloads) {
    return false
  }

  $browserShell.set({ ...state, downloads })

  return true
}

function applyHealth(health: FanBrowserShellHealth, snapshot = false): boolean {
  const version = health.clearedAt ?? health.updatedAt
  const tombstoneAt = healthTombstones.get(health.eventId)

  if (!health.active) {
    recordTombstone(healthTombstones, health.eventId, version)
    const state = $browserShell.get()
    const healthArchive = removeArchiveRecord(state.health, health.eventId)

    if (healthArchive !== state.health) {
      $browserShell.set({ ...state, health: healthArchive })
    }

    return true
  }

  if (tombstoneAt != null && tombstoneAt >= version) {
    return false
  }

  const state = $browserShell.get()
  const previous = flattenArchive(state.health).find(record => record.workbenchId === health.workbenchId)

  if (previous && (health.updatedAt < previous.updatedAt || (snapshot && health.updatedAt === previous.updatedAt))) {
    return false
  }

  const records = flattenArchive(state.health).filter(record => record.workbenchId !== health.workbenchId)
  records.push(health)
  records.sort((a, b) => b.updatedAt - a.updatedAt || b.eventId.localeCompare(a.eventId))
  $browserShell.set({ ...state, health: rebuildArchive(records.slice(0, MAX_HEALTH_RECORDS)) })

  return true
}

function applyNotice(notice: FanBrowserShellNotice, snapshot = false): boolean {
  const version = noticeVersion(notice)
  const tombstoneAt = noticeTombstones.get(notice.eventId)

  if (!notice.active) {
    recordTombstone(noticeTombstones, notice.eventId, version)
    const state = $browserShell.get()
    const notices = removeArchiveRecord(state.notices, notice.eventId)

    if (notices !== state.notices) {
      $browserShell.set({ ...state, notices })
    }

    return true
  }

  if (tombstoneAt != null && tombstoneAt >= version) {
    return false
  }

  const state = $browserShell.get()
  const records = flattenArchive(state.notices)
  const previous = records.find(record => record.workbenchId === notice.workbenchId)

  if (previous && (version < noticeVersion(previous) || (snapshot && version === noticeVersion(previous)))) {
    return false
  }

  const remaining = records.filter(record => record.workbenchId !== notice.workbenchId)
  remaining.push(notice)
  remaining.sort((a, b) => noticeVersion(b) - noticeVersion(a) || b.eventId.localeCompare(a.eventId))
  $browserShell.set({ ...state, notices: rebuildArchive(remaining.slice(0, MAX_NOTICES)) })

  return true
}

function applyRevision(revision: number | null): void {
  if (revision == null) {
    return
  }

  const state = $browserShell.get()

  if (revision > state.revision) {
    $browserShell.set({ ...state, revision })
  }
}

export function applyBrowserShellEvent(event: { payload: unknown; type: string }): boolean {
  const payload = objectValue(event?.payload)

  if (!payload) {
    return false
  }

  const revision = finiteNumber(payload.revision)

  if (revision != null && revision <= $browserShell.get().revision) {
    return false
  }

  let applied = false

  if (event.type === 'shell.prompt.changed') {
    const prompt = normalizePrompt(payload)
    applied = prompt ? applyPrompt(prompt) : false
  } else if (event.type === 'shell.download.changed') {
    const download = normalizeDownload(payload)
    applied = download ? applyDownload(download) : false
  } else if (event.type === 'shell.health.changed') {
    const health = normalizeHealth(payload)
    applied = health ? applyHealth(health) : false
  } else if (event.type === 'shell.notice.raised') {
    const notice = normalizeNotice(payload)
    applied = notice ? applyNotice(notice) : false
  } else {
    return false
  }

  if (applied) {
    applyRevision(revision)
  }

  return applied
}

function normalizedSnapshot(value: Record<string, unknown>) {
  const prompts = (Array.isArray(value.prompts) ? value.prompts : [])
    .map(normalizePrompt)
    .filter((item): item is FanBrowserShellPrompt => Boolean(item?.pending))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_PROMPTS)

  const downloads = (Array.isArray(value.downloads) ? value.downloads : [])
    .map(normalizeDownload)
    .filter((item): item is FanBrowserShellDownload => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_DOWNLOADS)

  const health = (Array.isArray(value.health) ? value.health : [])
    .map(normalizeHealth)
    .filter((item): item is FanBrowserShellHealth => Boolean(item?.active))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_HEALTH_RECORDS)

  const notices = (Array.isArray(value.notices) ? value.notices : [])
    .map(normalizeNotice)
    .filter((item): item is FanBrowserShellNotice => Boolean(item?.active))
    .sort((a, b) => b.raisedAt - a.raisedAt)
    .slice(0, MAX_NOTICES)

  return { downloads, health, notices, prompts }
}

export function restoreBrowserShellSnapshot(snapshot: unknown): boolean {
  const value = objectValue(snapshot)

  if (!value) {
    return false
  }

  const revision = finiteNumber(value.revision) ?? 0
  const normalized = normalizedSnapshot(value)
  const current = $browserShell.get()

  if (revision >= current.revision) {
    promptTombstones.clear()
    healthTombstones.clear()
    noticeTombstones.clear()
    $browserShell.set({
      downloads: rebuildArchive(normalized.downloads),
      health: rebuildArchive(normalized.health),
      hydrated: true,
      notices: rebuildArchive(normalized.notices),
      prompts: rebuildArchive(normalized.prompts),
      revision
    })

    return true
  }

  let accepted = false

  for (const prompt of normalized.prompts) {
    accepted = applyPrompt(prompt, true) || accepted
  }

  for (const download of normalized.downloads) {
    accepted = applyDownload(download, true) || accepted
  }

  for (const health of normalized.health) {
    accepted = applyHealth(health, true) || accepted
  }

  for (const notice of normalized.notices) {
    accepted = applyNotice(notice, true) || accepted
  }

  const merged = $browserShell.get()

  if (!merged.hydrated) {
    $browserShell.set({ ...merged, hydrated: true })
  }

  return accepted
}

export function attachBrowserShell(): () => void {
  attachmentCount += 1

  if (attachmentCount === 1) {
    const generation = ++attachmentGeneration
    const api = window.fanDesktop?.browser

    unsubscribeFromEvents = api?.onEvent?.(event => {
      applyBrowserShellEvent(event)
    }) ?? null

    if (api?.shellState) {
      void api
        .shellState()
        .then(snapshot => {
          if (generation === attachmentGeneration) {
            restoreBrowserShellSnapshot(snapshot)
          }
        })
        .catch(() => {
          if (generation === attachmentGeneration) {
            const state = $browserShell.get()
            $browserShell.set({ ...state, hydrated: true })
          }
        })
    } else {
      const state = $browserShell.get()
      $browserShell.set({ ...state, hydrated: true })
    }
  }

  let detached = false

  return () => {
    if (detached) {
      return
    }

    detached = true
    attachmentCount = Math.max(0, attachmentCount - 1)

    if (attachmentCount === 0) {
      attachmentGeneration += 1
      unsubscribeFromEvents?.()
      unsubscribeFromEvents = null
    }
  }
}

export function browserShellDownloadsFor(
  state: BrowserShellState,
  workbenchId: null | string | undefined,
  tabId?: null | string
): FanBrowserShellDownload[] {
  if (!workbenchId) {
    return []
  }

  const workbench = state.downloads[workbenchId]
  const records = tabId ? [...(workbench?.[tabId] ?? [])] : Object.values(workbench ?? {}).flatMap(items => [...items])

  return records.sort((a, b) => b.updatedAt - a.updatedAt || b.eventId.localeCompare(a.eventId))
}

export function browserShellHealthFor(
  state: BrowserShellState,
  workbenchId: null | string | undefined,
  tabId?: null | string
): FanBrowserShellHealth | null {
  if (!workbenchId) {
    return null
  }

  const workbench = state.health[workbenchId]

  const records = tabId && workbench?.[tabId]?.length
    ? [...workbench[tabId]]
    : Object.values(workbench ?? {}).flatMap(items => [...items])

  return records.sort((a, b) => b.updatedAt - a.updatedAt || b.eventId.localeCompare(a.eventId))[0] ?? null
}

export function browserShellNoticeFor(
  state: BrowserShellState,
  workbenchId: null | string | undefined,
  tabId?: null | string
): FanBrowserShellNotice | null {
  if (!workbenchId) {
    return null
  }

  const workbench = state.notices[workbenchId]

  const records = tabId && workbench?.[tabId]?.length
    ? [...workbench[tabId]]
    : Object.values(workbench ?? {}).flatMap(items => [...items])

  return records.sort((a, b) => b.raisedAt - a.raisedAt || b.eventId.localeCompare(a.eventId))[0] ?? null
}

function shellActionError(result: FanBrowserShellActionResult | undefined, fallback: string): Error | null {
  return result?.ok ? null : new Error(result?.reason || fallback)
}

function settlePromptLocally(eventId: string): void {
  const state = $browserShell.get()
  const prompt = flattenArchive(state.prompts).find(item => item.eventId === eventId)
  recordTombstone(promptTombstones, eventId, Math.max(Date.now(), (prompt?.createdAt ?? 0) + 1))
  $browserShell.set({ ...state, prompts: removeArchiveRecord(state.prompts, eventId) })
}

export async function respondToBrowserShellPrompt(
  eventId: string,
  response: { accepted: boolean; value?: string }
): Promise<void> {
  const api = window.fanDesktop?.browser

  if (!api?.respondShellPrompt) {
    throw new Error('当前版本无法响应浏览器提示，请重启 Fan 后重试')
  }

  const result = await api.respondShellPrompt(eventId, response)
  settlePromptLocally(eventId)
  const error = shellActionError(result, '浏览器未接受这次响应')

  if (error) {
    throw error
  }
}

export async function openBrowserShellDownload(eventId: string): Promise<void> {
  const api = window.fanDesktop?.browser

  if (!api?.openDownload) {
    throw new Error('当前版本无法打开下载文件，请重启 Fan 后重试')
  }

  const error = shellActionError(await api.openDownload(eventId), '无法打开下载文件')

  if (error) {
    throw error
  }
}

export async function revealBrowserShellDownload(eventId: string): Promise<void> {
  const api = window.fanDesktop?.browser

  if (!api?.revealDownload) {
    throw new Error('当前版本无法定位下载文件，请重启 Fan 后重试')
  }

  const error = shellActionError(await api.revealDownload(eventId), '无法在文件夹中显示下载文件')

  if (error) {
    throw error
  }
}

export function resetBrowserShellState(): void {
  attachmentGeneration += 1
  attachmentCount = 0
  unsubscribeFromEvents?.()
  unsubscribeFromEvents = null
  promptTombstones.clear()
  healthTombstones.clear()
  noticeTombstones.clear()
  $browserShell.set(EMPTY_STATE)
}

export type { FanBrowserShellSnapshot }
