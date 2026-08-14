import { map } from 'nanostores'

// Safari "show all tabs" model: each session tile shows a STATIC captured still
// of that session's page. This store holds those downscaled JPEG data URLs,
// keyed by session id, persisted so the Canvas overview survives reloads.
//
// Memory-safety is the whole point: the main process only ever hands back a
// bounded (~960px) JPEG, we keep at most MAX_THUMBNAILS of them (evicting the
// oldest), and there are NO live views and NO polling anywhere in this path.

type ThumbnailState = Record<string, string>

// Recency order (oldest → newest) kept alongside the map so we can evict the
// least-recently-captured entry once the cache is full. Not persisted directly;
// rebuilt from the persisted map on load (insertion order is preserved by JSON).
let recency: string[] = []

const STORAGE_KEY = 'fan.desktop.sessionThumbnails.v2'
const LEGACY_STORAGE_KEY = 'fan.desktop.sessionThumbnails.v1'
const MAX_THUMBNAILS = 12
const CAPTURE_TIMEOUT_MS = 2_000

let captureSequence = 0
const latestCaptureBySession = new Map<string, number>()

const readStoredEntries = (storageKey: string): Array<[string, string]> | null => {
  try {
    const raw = window.localStorage.getItem(storageKey)

    if (raw === null) {
      return null
    }

    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    return Object.entries(parsed).filter(
      (entry): entry is [string, string] => Boolean(entry[0]) && typeof entry[1] === 'string' && Boolean(entry[1])
    )
  } catch {
    return null
  }
}

const mergeStoredEntries = (...sources: Array<Array<[string, string]>>): ThumbnailState => {
  const values = new Map<string, string>()

  for (const entries of sources) {
    for (const [id, dataUrl] of entries) {
      // A v2 capture is newer than the same legacy entry. Re-inserting moves
      // the key to the newest position as well as replacing its image.
      values.delete(id)
      values.set(id, dataUrl)
    }
  }

  while (values.size > MAX_THUMBNAILS) {
    const oldest = values.keys().next().value

    if (typeof oldest !== 'string') {
      break
    }

    values.delete(oldest)
  }

  return Object.fromEntries(values)
}

const load = (): ThumbnailState => {
  if (typeof window === 'undefined') {
    return {}
  }

  const legacyEntries = readStoredEntries(LEGACY_STORAGE_KEY)
  const currentEntries = readStoredEntries(STORAGE_KEY)
  const state = mergeStoredEntries(legacyEntries ?? [], currentEntries ?? [])
  recency = Object.keys(state)

  if (legacyEntries?.length) {
    // v1 captures are lower resolution, but they are still better than FAN's
    // empty-page placeholder after a restart. Promote them into v2 and only
    // remove the legacy copy after the v2 write succeeds. If storage is full or
    // unavailable, the legacy cache remains available for the next launch.
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      // Keep both the in-memory still and the durable v1 fallback.
    }
  }

  return state
}

const save = (state: ThumbnailState): boolean => {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    if (Object.keys(state).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }

    return true
  } catch {
    return false
  }
}

export const $sessionThumbnails = map<ThumbnailState>(load())

function setThumbnail(id: string, dataUrl: string): boolean {
  if (!id || !dataUrl) {
    return false
  }

  const current = $sessionThumbnails.get()
  const previousRecency = recency
  const next: ThumbnailState = { ...current }

  // Reinsert rather than overwrite so JSON object order preserves the same
  // oldest→newest recency that we rebuild on the next launch.
  delete next[id]
  next[id] = dataUrl

  // Refresh recency: move this id to the newest position.
  recency = recency.filter(key => key !== id)
  recency.push(id)

  // Hard cap: evict oldest entries until we're within budget.
  while (recency.length > MAX_THUMBNAILS) {
    const oldest = recency.shift()

    if (oldest && oldest !== id) {
      delete next[oldest]
    }
  }

  // A count cap alone cannot guarantee localStorage capacity because JPEG size
  // varies by page. On quota failure, evict older stills one at a time and
  // retry atomically. If even the new image cannot be stored, keep the previous
  // in-memory state too so Canvas never pretends a non-durable write succeeded.
  let persisted = save(next)

  while (!persisted && recency.length > 1) {
    const oldest = recency.shift()

    if (oldest && oldest !== id) {
      delete next[oldest]
    }

    persisted = save(next)
  }

  if (!persisted) {
    recency = previousRecency

    return false
  }

  $sessionThumbnails.set(next)

  return true
}

/**
 * Persist a JPEG already captured by Main under the durable session id Canvas
 * renders. Overview live-tile retirement uses a different capture IPC from the
 * foreground browser, but both paths must share the same bounded cache and race
 * ordering: committing this frame invalidates any older in-flight foreground
 * capture for the same session.
 */
export function storeCapturedSessionThumbnail(
  storageSessionId: string | null | undefined,
  dataUrl: string | null | undefined
): boolean {
  const storageId = storageSessionId?.trim()

  if (!storageId || !dataUrl) {
    return false
  }

  const sequence = ++captureSequence
  latestCaptureBySession.set(storageId, sequence)

  try {
    return setThumbnail(storageId, dataUrl)
  } finally {
    if (latestCaptureBySession.get(storageId) === sequence) {
      latestCaptureBySession.delete(storageId)
    }
  }
}

// Capture the currently-shown workbench and store it under the durable session
// id used by Canvas. These ids are usually equal, but runtime resume/compression
// can make them differ; conflating them either asks main for a non-foreground
// view or saves a valid image under a key Canvas will never read.
export async function captureActiveThumbnail(
  storageSessionId: string | null | undefined,
  browserWorkbenchId?: string | null
): Promise<void> {
  const storageId = storageSessionId?.trim()
  const sourceId = browserWorkbenchId?.trim() || storageId

  if (!storageId || !sourceId) {
    return
  }

  const bridge = window.fanDesktop?.browser

  if (!bridge?.captureThumbnail) {
    return
  }

  const sequence = ++captureSequence
  latestCaptureBySession.set(storageId, sequence)
  let timeout = 0

  try {
    // capturePage is normally fast, but an unresponsive/destroying renderer can
    // leave IPC pending. Keep Canvas navigation bounded; a timed-out result is
    // deliberately ignored if it arrives after the caller has moved on.
    const result = await Promise.race([
      bridge.captureThumbnail(sourceId),
      new Promise<null>(resolve => {
        timeout = window.setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS)
      })
    ])

    // Ready/idle/Canvas captures can overlap. Only the newest request for this
    // durable session may win, otherwise a slow old frame can overwrite a more
    // recent page and become the image restored on the next launch.
    if (latestCaptureBySession.get(storageId) === sequence && result?.dataUrl) {
      setThumbnail(storageId, result.dataUrl)
    }
  } catch {
    // best-effort snapshot; the tile keeps its previous still or empty page
  } finally {
    window.clearTimeout(timeout)

    if (latestCaptureBySession.get(storageId) === sequence) {
      latestCaptureBySession.delete(storageId)
    }
  }
}
