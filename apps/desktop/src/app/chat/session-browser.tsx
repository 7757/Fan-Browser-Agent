import { useStore } from '@nanostores/react'
import { type CSSProperties, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { FanLoader } from '@/components/ui/fan-loader'
import { Input } from '@/components/ui/input'
import { Tip } from '@/components/ui/tooltip'
import type {
  FanBrowserDownloadPopoverTheme,
  FanBrowserNavState,
  FanBrowserPresentationState,
  FanBrowserRect,
  FanBrowserSurfaceVisibilityReason
} from '@/global'
import { FAN_LOGO_MARK } from '@/lib/brand'
import { resolveOmniboxUrl, searchQueryFromUrl } from '@/lib/browser-home'
import { AlertTriangle, ChevronLeft, ChevronRight, Globe, Lock, RefreshCw, Search, X } from '@/lib/icons'
import { $activeBrowserControl } from '@/store/browser-control'
import { $browserShell, browserShellDownloadsFor } from '@/store/browser-shell'
import { setFollowTab } from '@/store/browser-tabs'
import { $nativeOverlaySuppressed, $nativeViewOccluded, dismissTopNativeScrim } from '@/store/native-overlay'
import { notify } from '@/store/notifications'
import { $paneStates } from '@/store/panes'
import {
  $controlRequest,
  $verificationRequest,
  clearControlRequest,
  clearVerificationRequest,
  setControlRequest
} from '@/store/prompts'
import { $activeBrowserWorkbenchId, $activeSessionId, $gatewayState, $selectedStoredSessionId } from '@/store/session'
import type { SessionTabInfo } from '@/store/session-tabs'
import { captureActiveThumbnail } from '@/store/session-thumbnails'

import { isInternalWorkbenchUrl } from '../browser-state-persistence'

import { BrowserShellActivityControl } from './browser-shell-activity'
import { isFanBlankTabUrl, sanitizePersistedFavicon, TabFavicon } from './tab-favicon'

interface SessionBrowserProps {
  requestGateway: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  surfaceVisible: boolean
}

// Inset the native WebContentsView a few px inside its host so the host's
// rounded glass viewport frame + border stay visible around it. CSS can't clip
// a native OS view, but the view rounds its OWN corners natively
// (view.setBorderRadius in main.cjs, ~matching this host's 10px) so the content
// nests inside the rounded frame instead of being a hard square.
const WEBVIEW_INSET = 2
const DOWNLOAD_DISMISSALS_STORAGE_KEY = 'fan.desktop.browserDownloadDismissals.v1'
const MAX_DOWNLOAD_DISMISSAL_SCOPES = 64

const DOWNLOAD_POPOVER_THEME_VARIABLES: Record<keyof FanBrowserDownloadPopoverTheme, string> = {
  active: '--ui-control-active-background',
  background: '--dt-popover',
  border: '--ui-stroke-tertiary',
  foreground: '--dt-popover-foreground',
  green: '--ui-green',
  hover: '--ui-control-hover-background',
  primary: '--dt-primary',
  primaryForeground: '--dt-primary-foreground',
  red: '--ui-red',
  secondary: '--ui-text-secondary',
  tertiary: '--ui-text-tertiary'
}

const DOWNLOAD_POPOVER_THEME_FALLBACKS: FanBrowserDownloadPopoverTheme = {
  active: 'rgba(15, 23, 42, 0.1)',
  background: '#ffffff',
  border: 'rgba(15, 23, 42, 0.12)',
  foreground: '#20242a',
  green: '#15a352',
  hover: 'rgba(15, 23, 42, 0.065)',
  primary: '#2563eb',
  primaryForeground: '#ffffff',
  red: '#e0474c',
  secondary: '#565d66',
  tertiary: '#7c848e'
}

function resolvedDownloadPopoverTheme(): FanBrowserDownloadPopoverTheme {
  if (typeof document === 'undefined') {
    return { ...DOWNLOAD_POPOVER_THEME_FALLBACKS }
  }

  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:fixed;pointer-events:none;visibility:hidden'
  document.documentElement.append(probe)

  const resolved = { ...DOWNLOAD_POPOVER_THEME_FALLBACKS }

  for (const key of Object.keys(DOWNLOAD_POPOVER_THEME_VARIABLES) as Array<
    keyof FanBrowserDownloadPopoverTheme
  >) {
    const fallback = DOWNLOAD_POPOVER_THEME_FALLBACKS[key]
    probe.style.color = `var(${DOWNLOAD_POPOVER_THEME_VARIABLES[key]}, ${fallback})`
    const color = window.getComputedStyle(probe).color.trim()
    resolved[key] = color && !color.includes('var(') ? color : fallback
  }

  probe.remove()

  return resolved
}

function readDownloadDismissals(): Record<string, string[]> {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DOWNLOAD_DISMISSALS_STORAGE_KEY) || '{}')

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string[]] =>
          Boolean(entry[0]) &&
          Array.isArray(entry[1]) &&
          entry[1].every(eventId => typeof eventId === 'string' && Boolean(eventId))
      )
    )
  } catch {
    return {}
  }
}

function downloadsDismissed(scope: string, eventIds: string[]): boolean {
  if (!scope || eventIds.length === 0) {
    return false
  }

  const dismissed = new Set(readDownloadDismissals()[scope] ?? [])

  return eventIds.every(eventId => dismissed.has(eventId))
}

function rememberDismissedDownloads(scope: string, eventIds: string[]): void {
  if (!scope || eventIds.length === 0 || typeof window === 'undefined') {
    return
  }

  try {
    const current = readDownloadDismissals()
    delete current[scope]
    current[scope] = [...new Set(eventIds)]

    const bounded = Object.fromEntries(Object.entries(current).slice(-MAX_DOWNLOAD_DISMISSAL_SCOPES))
    window.localStorage.setItem(DOWNLOAD_DISMISSALS_STORAGE_KEY, JSON.stringify(bounded))
  } catch {
    // Dismissal remains valid for this mounted session through component state.
  }
}

function boundsForHost(host: HTMLDivElement): FanBrowserRect | null {
  const rect = host.getBoundingClientRect()

  if (rect.width <= 1 || rect.height <= 1) {
    return null
  }

  return {
    x: rect.left + WEBVIEW_INSET,
    y: rect.top + WEBVIEW_INSET,
    width: Math.max(0, rect.width - WEBVIEW_INSET * 2),
    height: Math.max(0, rect.height - WEBVIEW_INSET * 2)
  }
}

function sameBounds(a: FanBrowserRect | null, b: FanBrowserRect): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

// Whether the tab strip is scrolled away from each edge (more tabs hidden there).
function tabScrollHintsFor(el: HTMLDivElement): { left: boolean; right: boolean } {
  return {
    left: el.scrollLeft > 1,
    right: Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth - 1
  }
}

// A mask that fades whichever edge has more tabs hidden behind it (a soft "scroll
// for more" cue). undefined when neither edge is clipped, so no mask is applied.
function tabStripMask(hints: { left: boolean; right: boolean }): string | undefined {
  if (!hints.left && !hints.right) {
    return undefined
  }

  const stops: string[] = [hints.left ? 'transparent 0' : '#000 0']

  if (hints.left) {
    stops.push('#000 1.5rem')
  }

  if (hints.right) {
    stops.push('#000 calc(100% - 1.5rem)')
  }

  stops.push(hints.right ? 'transparent 100%' : '#000 100%')

  return `linear-gradient(to right, ${stops.join(', ')})`
}

type BrowserLocationKind = 'blank' | 'page' | 'search'

interface CommittedBrowserLocation {
  display: string
  kind: BrowserLocationKind
  url: string
}

interface PendingOmniboxNavigation {
  display: string
  requestId: number
  startDocumentRevision: number
  startUrl: string
  tabId: string | null
  workbenchId: string
}

const EMPTY_LOCATION: CommittedBrowserLocation = { display: '', kind: 'blank', url: '' }
const RECENT_CAPTCHA_CLEAR_TTL_MS = 30_000
let browserSurfaceOwnerSequence = 0

function createBrowserSurfaceOwnerId(): string {
  browserSurfaceOwnerSequence += 1

  return `${Date.now().toString(36)}-${browserSurfaceOwnerSequence.toString(36)}`
}

const EMPTY_PRESENTATION: FanBrowserPresentationState = {
  activeTabId: null,
  committedUrl: '',
  documentRevision: 0,
  error: null,
  id: '',
  nativeVisible: false,
  phase: 'blank',
  viewEpoch: 0,
  workbenchId: ''
}

function captchaClearMatchesVerification(
  payload: Record<string, unknown>,
  pending: { challengeId?: string }
): boolean {
  const challengeId = typeof payload.challengeId === 'string' ? payload.challengeId : ''

  // Old runtimes/rehydrated requests without an opaque challenge identity keep
  // the manual Continue fallback. Auto-answering without identity is unsafe: a
  // delayed clear from the previous document can otherwise release this gate.
  if (!challengeId || !pending.challengeId || challengeId !== pending.challengeId) {
    return false
  }

  return true
}

function committedLocationFor(url: null | string | undefined): CommittedBrowserLocation {
  const normalized = typeof url === 'string' ? url : ''

  if (!normalized || isFanBlankTabUrl(normalized) || isInternalWorkbenchUrl(normalized)) {
    return EMPTY_LOCATION
  }

  return {
    // The omnibox is an address bar: it always represents the real committed
    // location. A search result is still marked as `search` for its glyph, but
    // its query must not replace the page URL in the visible text.
    display: normalized,
    kind: searchQueryFromUrl(normalized) == null ? 'page' : 'search',
    url: normalized
  }
}

function BrowserSlotState({
  error,
  nativeVisible,
  onRetry,
  phase
}: {
  error?: FanBrowserPresentationState['error']
  nativeVisible: boolean
  onRetry?: () => void
  phase: FanBrowserPresentationState['phase']
}) {
  if (error) {
    const code = Number(error.code)
    const isHttpServerError = error.code !== null && Number.isInteger(code) && code >= 500 && code <= 599
    let host = ''

    try {
      host = new URL(error.url).host
    } catch {
      host = ''
    }

    return (
      <div
        aria-label="页面加载失败"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--ui-chat-surface-background) px-8 text-center"
        role="alert"
      >
        <div className="space-y-1">
          <p className="text-base font-medium text-(--ui-text-primary)">
            {isHttpServerError ? '该网页无法正常运作' : error.description}
          </p>
          {isHttpServerError && (
            <p className="text-sm text-(--ui-text-secondary)">
              {host ? `${host} 目前无法处理此请求。` : '服务器目前无法处理此请求。'}
            </p>
          )}
        </div>
        {isHttpServerError ? (
          <p className="font-mono text-xs leading-relaxed text-(--ui-text-tertiary)">HTTP ERROR {code}</p>
        ) : error.code !== null ? (
          <p className="font-mono text-xs leading-relaxed text-(--ui-text-tertiary)">Error code: {error.code}</p>
        ) : null}
        {isHttpServerError && error.description && (
          <p className="font-mono text-xs leading-relaxed text-(--ui-text-tertiary)">{error.description}</p>
        )}
        {error.url && (
          <p className="max-w-sm break-all font-mono text-xs leading-relaxed text-(--ui-text-tertiary)">{error.url}</p>
        )}
        {onRetry && (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            重新加载
          </Button>
        )}
      </div>
    )
  }

  // A ready native page must cover this React layer. Returning no loader makes
  // any presentation regression visible as a surface problem instead of falsely
  // telling the user that Chromium is still loading.
  if (phase === 'ready' && nativeVisible) {
    return null
  }

  const label = phase === 'suspended' ? '正在恢复页面' : '正在加载浏览器'

  return (
    <div
      aria-label={label}
      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-(--ui-chat-surface-background)"
      role="status"
    >
      <FanLoader />
    </div>
  )
}

function BrowserNewTabState() {
  // A fresh session sits on a blank new-tab page — minimal brand mark + hint,
  // not the loading spinner and no auto-loaded search engine.
  return (
    <div
      aria-label="新标签页"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 bg-(--ui-chat-surface-background) text-center"
      role="status"
    >
      <img alt="" aria-hidden className="size-12 opacity-80 dark:invert" src={FAN_LOGO_MARK} />
      <p className="max-w-64 text-xs leading-relaxed text-(--ui-text-tertiary)">
        输入网址或搜索，也可以让 Fan 代你操作
      </p>
    </div>
  )
}

const AUTO_THUMBNAIL_CAPTURE_DELAY_MS = 800

interface StableBrowserThumbnailCaptureOptions {
  activeTabId: string | null
  activeTabUrl: string
  documentRevision: number
  nativeVisible: boolean
  operating: boolean
  overlayRouteOpen: boolean
  overlaySuppressed: boolean
  phase: FanBrowserPresentationState['phase']
  presentationActiveTabId: string | null
  presentationUrl: string
  presentationWorkbenchId: string
  storageSessionId: string | null
  viewEpoch: number
  workbenchId: string | null
}

function stableBrowserThumbnailCaptureKey(options: StableBrowserThumbnailCaptureOptions): string {
  const url = options.presentationUrl || options.activeTabUrl

  if (
    !options.storageSessionId?.trim() ||
    !options.workbenchId ||
    options.presentationWorkbenchId !== options.workbenchId ||
    !options.activeTabId ||
    options.presentationActiveTabId !== options.activeTabId ||
    options.phase !== 'ready' ||
    !options.nativeVisible ||
    options.operating ||
    options.overlayRouteOpen ||
    options.overlaySuppressed ||
    !url ||
    isFanBlankTabUrl(url) ||
    isInternalWorkbenchUrl(url)
  ) {
    return ''
  }

  // Agent operation visuals and the synthetic cursor live inside the page.
  // Never persist them as a Canvas still. Once the turn becomes idle this key
  // becomes valid again and the normal debounce captures the clean final page.
  return [
    options.storageSessionId,
    options.workbenchId,
    options.activeTabId,
    options.documentRevision,
    options.viewEpoch,
    url
  ].join('\u001f')
}

/** @internal Exported only so the debounce/lifecycle contract can be tested in isolation. */
export function useStableBrowserThumbnailCapture(options: StableBrowserThumbnailCaptureOptions): void {
  const storageSessionId = options.storageSessionId
  const workbenchId = options.workbenchId
  const captureKey = stableBrowserThumbnailCaptureKey(options)
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => {
    const onVisibilityChange = () => setDocumentVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (!captureKey || !documentVisible) {
      return
    }

    let cancelled = false

    const timer = window.setTimeout(() => {
      if (!cancelled && document.visibilityState === 'visible') {
        void captureActiveThumbnail(storageSessionId, workbenchId)
      }
    }, AUTO_THUMBNAIL_CAPTURE_DELAY_MS)

    const cancel = () => {
      cancelled = true
      window.clearTimeout(timer)
    }

    window.addEventListener('beforeunload', cancel)
    window.addEventListener('pagehide', cancel)

    return () => {
      cancel()
      window.removeEventListener('beforeunload', cancel)
      window.removeEventListener('pagehide', cancel)
    }
  }, [captureKey, documentVisible, storageSessionId, workbenchId])
}

export function SessionBrowser({ requestGateway, surfaceVisible }: SessionBrowserProps) {
  const activeSessionId = useStore($activeSessionId)
  const activeBrowserWorkbenchId = useStore($activeBrowserWorkbenchId)
  const activeBrowserControl = useStore($activeBrowserControl)
  const browserShell = useStore($browserShell)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const overlaySuppressed = useStore($nativeOverlaySuppressed)
  const verificationRequest = useStore($verificationRequest)
  const gatewayReady = useStore($gatewayState) === 'open'

  const hostRef = useRef<HTMLDivElement | null>(null)
  // The page's identity and the text currently being edited are intentionally
  // separate. A draft must never change the lock/search/Fan glyph before the
  // native browser has actually committed a navigation.
  const [omniboxDraft, setOmniboxDraft] = useState('')
  const [omniboxEditing, setOmniboxEditing] = useState(false)
  const [omniboxComposing, setOmniboxComposing] = useState(false)
  const [pendingOmniboxNavigation, setPendingOmniboxNavigation] = useState<PendingOmniboxNavigation | null>(null)
  const [openedWorkbenchId, setOpenedWorkbenchId] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<FanBrowserPresentationState>(EMPTY_PRESENTATION)
  const [navState, setNavState] = useState<FanBrowserNavState>({ ok: false })
  const committedLocation = committedLocationFor(navState.url || presentation.committedUrl)

  const [tabsState, setTabsState] = useState<{
    active: number
    tabs: SessionTabInfo[]
  }>({ active: 0, tabs: [] })

  // IPC pushes are newer than an in-flight listTabs seed pull. Track their
  // revision so a late about:blank snapshot cannot overwrite a navigation or
  // favicon event that already reached the renderer.
  const tabsStateRevisionRef = useRef(0)
  // Presentation pull is only an initial seed. Any push event received after
  // the request starts is authoritative and must not be overwritten by a late
  // IPC response from the same View/document.
  const presentationPushRevisionRef = useRef(0)

  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const omniboxInputRef = useRef<HTMLInputElement | null>(null)
  const downloadActivityButtonRef = useRef<HTMLButtonElement | null>(null)
  const [tabScrollHints, setTabScrollHints] = useState({ left: false, right: false })
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [downloadActivityOpen, setDownloadActivityOpenState] = useState(false)
  const [dismissedDownloadEventKey, setDismissedDownloadEventKey] = useState('')
  const inflightRef = useRef<Map<string, Promise<string | null>>>(new Map())
  const navigationRequestRef = useRef(0)
  const pendingOmniboxNavigationRef = useRef<PendingOmniboxNavigation | null>(null)
  const presentationRef = useRef(presentation)
  presentationRef.current = presentation
  const navStateRef = useRef(navState)
  navStateRef.current = navState

  const collapseOmniboxSelection = useCallback(() => {
    const input = omniboxInputRef.current

    if (!input || document.activeElement === input) {
      return
    }

    // Blurring an input does not clear its selection. Collapse it after the
    // controlled value has committed so a submitted URL is never left painted
    // as if the user had selected it manually.
    const end = input.value.length
    input.setSelectionRange(end, end)
  }, [])

  const workbenchId = activeBrowserWorkbenchId ?? activeSessionId
  const workbenchRef = useRef<string | null>(workbenchId)
  workbenchRef.current = workbenchId
  const scopedDownloads = browserShellDownloadsFor(browserShell, workbenchId)
  const downloadEventKey = scopedDownloads.map(download => download.eventId).join('\0')
  const downloadDismissalScope = selectedStoredSessionId?.trim() || workbenchId?.trim() || ''

  const persistedDownloadActivityDismissed = downloadsDismissed(
    downloadDismissalScope,
    downloadEventKey ? downloadEventKey.split('\0') : []
  )

  const resolvingCaptchaChallengesRef = useRef(new Set<string>())

  useEffect(() => {
    void window.fanDesktop?.browser?.hideDownloadPopover?.()
    setDownloadActivityOpenState(false)
    setDismissedDownloadEventKey('')
  }, [workbenchId])

  const setDownloadActivityOpen = useCallback((open: boolean) => {
    setDownloadActivityOpenState(open)

    if (open) {
      setDismissedDownloadEventKey('')
    }
  }, [])

  const dismissDownloadActivity = useCallback(() => {
    rememberDismissedDownloads(
      downloadDismissalScope,
      downloadEventKey ? downloadEventKey.split('\0') : []
    )
    setDownloadActivityOpenState(false)
    setDismissedDownloadEventKey(downloadEventKey)
  }, [downloadDismissalScope, downloadEventKey])

  useEffect(() => {
    const unsubscribe = window.fanDesktop?.browser?.onDownloadPopoverClosed?.(payload => {
      if (payload.reason === 'dismiss') {
        dismissDownloadActivity()
      } else {
        setDownloadActivityOpenState(false)
      }
    })

    return unsubscribe
  }, [dismissDownloadActivity])

  useEffect(() => {
    if (downloadActivityOpen) {
      return
    }

    void window.fanDesktop?.browser?.hideDownloadPopover?.()
  }, [downloadActivityOpen])

  useEffect(() => {
    if (!downloadActivityOpen) {
      return
    }

    const api = window.fanDesktop?.browser
    const showDownloadPopover = api?.showDownloadPopover

    if (!workbenchId || !showDownloadPopover) {
      setDownloadActivityOpenState(false)

      return
    }

    let cancelled = false
    let lastPayloadKey = ''
    let showRequest = 0

    const show = () => {
      const button = downloadActivityButtonRef.current

      if (!button) {
        return
      }

      const rect = button.getBoundingClientRect()

      if (rect.width <= 0 || rect.height <= 0) {
        return
      }

      const payload = {
        anchor: {
          height: rect.height,
          width: rect.width,
          x: rect.left,
          y: rect.top
        },
        theme: resolvedDownloadPopoverTheme(),
        workbenchId
      }

      const payloadKey = JSON.stringify(payload)

      if (payloadKey === lastPayloadKey) {
        return
      }

      lastPayloadKey = payloadKey
      showRequest += 1
      const request = showRequest

      void showDownloadPopover(payload)
        .then(result => {
          if (!cancelled && request === showRequest && result?.ok === false) {
            setDownloadActivityOpenState(false)
          }
        })
        .catch(() => {
          if (!cancelled && request === showRequest) {
            setDownloadActivityOpenState(false)
          }
        })
    }

    show()
    window.addEventListener('resize', show)
    window.visualViewport?.addEventListener('resize', show)
    document.addEventListener('scroll', show, true)
    document.addEventListener('transitionend', show, true)

    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(show) : null

    if (downloadActivityButtonRef.current) {
      resizeObserver?.observe(downloadActivityButtonRef.current)
    }

    if (hostRef.current) {
      resizeObserver?.observe(hostRef.current)
    }

    const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(show) : null

    themeObserver?.observe(document.documentElement, {
      attributeFilter: ['class', 'style'],
      attributes: true
    })

    return () => {
      cancelled = true
      window.removeEventListener('resize', show)
      window.visualViewport?.removeEventListener('resize', show)
      document.removeEventListener('scroll', show, true)
      document.removeEventListener('transitionend', show, true)
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
    }
  }, [browserShell.revision, downloadActivityOpen, workbenchId])

  useEffect(
    () => () => {
      void window.fanDesktop?.browser?.hideDownloadPopover?.()
    },
    []
  )

  const recentCaptchaClearsRef = useRef(
    new Map<string, { clearedAt: number; payload: Record<string, unknown> }>()
  )

  const autoResolveVerification = useCallback(
    (
      pending: NonNullable<ReturnType<typeof $verificationRequest.get>>,
      clearPayload: Record<string, unknown>
    ): boolean => {
      const challengeId = typeof clearPayload.challengeId === 'string' ? clearPayload.challengeId : ''

      if (
        !pending.sessionId ||
        !captchaClearMatchesVerification(clearPayload, pending) ||
        resolvingCaptchaChallengesRef.current.has(challengeId)
      ) {
        return false
      }

      resolvingCaptchaChallengesRef.current.add(challengeId)
      recentCaptchaClearsRef.current.delete(challengeId)
      void requestGateway('verification.respond', {
        answer: 'auto',
        challenge_id: challengeId,
        request_id: pending.requestId,
        session_id: pending.sessionId
      })
        .then(() => clearVerificationRequest(pending.sessionId, pending.requestId))
        .catch(() => undefined)
        .finally(() => resolvingCaptchaChallengesRef.current.delete(challengeId))

      return true
    },
    [requestGateway]
  )

  const replacePendingOmniboxNavigation = useCallback((next: PendingOmniboxNavigation | null) => {
    pendingOmniboxNavigationRef.current = next
    setPendingOmniboxNavigation(next)
  }, [])

  const clearPendingOmniboxNavigation = useCallback(
    (requestId?: number) => {
      const current = pendingOmniboxNavigationRef.current

      if (!current || (requestId != null && current.requestId !== requestId)) {
        return
      }

      replacePendingOmniboxNavigation(null)
    },
    [replacePendingOmniboxNavigation]
  )

  const settlePendingOmniboxNavigation = useCallback(
    (next: FanBrowserNavState, nextWorkbenchId: string) => {
      const pending = pendingOmniboxNavigationRef.current

      if (
        !pending ||
        pending.workbenchId !== nextWorkbenchId ||
        (pending.tabId != null && next.activeTabId != null && pending.tabId !== next.activeTabId)
      ) {
        return
      }

      const documentAdvanced = Number(next.documentRevision || 0) > pending.startDocumentRevision
      const locationChanged = Boolean(next.url && next.url !== pending.startUrl)

      if (!documentAdvanced && !locationChanged) {
        return
      }

      clearPendingOmniboxNavigation(pending.requestId)
      window.requestAnimationFrame(collapseOmniboxSelection)
    },
    [collapseOmniboxSelection, clearPendingOmniboxNavigation]
  )

  const applyPresentationState = useCallback(
    (next: FanBrowserPresentationState) => {
      const current = presentationRef.current
      // Pull responses may race push events. View/document identity is enough to
      // reject an old snapshot; phase ordering is not a transaction and normal
      // loading -> ready -> loading cycles must remain legal.

      if (
        current.workbenchId === next.workbenchId &&
        current.activeTabId === next.activeTabId &&
        (next.viewEpoch < current.viewEpoch ||
          (next.viewEpoch === current.viewEpoch &&
            Number(next.documentRevision || 0) < Number(current.documentRevision || 0)))
      ) {
        return
      }

      presentationRef.current = next
      setPresentation(next)

      if (next.error || next.phase === 'failed') {
        clearPendingOmniboxNavigation()
      }
    },
    [clearPendingOmniboxNavigation]
  )

  const nativeAllowed = Boolean(workbenchId && gatewayReady && openedWorkbenchId === workbenchId)

  // A fresh session sits on about:blank until the user/agent navigates. Show the
  // new-tab empty state (not the loading spinner) only for that idle case: a
  // single blank tab, never revealed a real page, nothing loading. Any other
  // state (real tab, restore/switch gap with 0 tabs, active load) → spinner.
  const activeTab = tabsState.tabs[tabsState.active] ?? tabsState.tabs[0]
  const nativeVisible = presentation.nativeVisible

  const controlActiveForTab = Boolean(activeBrowserControl && activeBrowserControl.activeTabId === activeTab?.tabId)

  const showFanMarkInAddressBar = committedLocation.kind === 'blank'

  const isNewTabIdle =
    tabsState.tabs.length === 1 &&
    (!activeTab?.url || activeTab.url === 'about:blank') &&
    presentation.phase === 'blank'

  const nativeAllowedRef = useRef(nativeAllowed)
  nativeAllowedRef.current = nativeAllowed
  const surfaceVisibleRef = useRef(surfaceVisible)
  surfaceVisibleRef.current = surfaceVisible

  // A full-window overlay route or modal covers the browser rect with DOM the
  // native view would paint over. The view is hidden as a PURE visibility
  // toggle: closing re-presents the SAME live page without navigation.
  const nativeViewOccluded = useStore($nativeViewOccluded)
  const nativeViewOccludedRef = useRef(nativeViewOccluded)
  nativeViewOccludedRef.current = nativeViewOccluded

  useStableBrowserThumbnailCapture({
    activeTabId: activeTab?.tabId ?? null,
    activeTabUrl: activeTab?.url ?? '',
    documentRevision: presentation.documentRevision,
    nativeVisible: surfaceVisible && nativeVisible,
    operating: Boolean(activeBrowserControl && activeBrowserControl.workbenchId === workbenchId),
    overlayRouteOpen: nativeViewOccluded,
    overlaySuppressed,
    phase: presentation.phase,
    presentationActiveTabId: presentation.activeTabId,
    presentationUrl: presentation.committedUrl,
    presentationWorkbenchId: presentation.workbenchId,
    storageSessionId: selectedStoredSessionId,
    viewEpoch: presentation.viewEpoch,
    workbenchId
  })

  const shownRef = useRef<null | string>(null)
  // True while the native scrim covers the browser rect (a modal is open) —
  // bounds pushes keep the scrim glued to the view as the layout changes.
  const scrimActiveRef = useRef(false)
  const createdRef = useRef<Set<string>>(new Set())
  const agentBoundRef = useRef<Set<string>>(new Set())
  const gatewayReadyRef = useRef(gatewayReady)
  gatewayReadyRef.current = gatewayReady
  const lastRectRef = useRef<FanBrowserRect | null>(null)
  const schedulePushRef = useRef<() => void>(() => undefined)
  // A remounted SessionBrowser may target the same workbench as the instance
  // being cleaned up. Main uses this lease to reject the old instance's late
  // detach after the new instance has already presented the native surface.
  const surfaceOwnerRef = useRef('')

  if (!surfaceOwnerRef.current) {
    surfaceOwnerRef.current = createBrowserSurfaceOwnerId()
  }

  // Invalidates delayed compatibility promises across rapid show/hide/show
  // transitions so an older setBounds acknowledgement cannot resurrect a view.
  const surfaceIntentRef = useRef(0)

  const ensureNativeWorkbench = useCallback(
    async (id: string): Promise<string | null> => {
      const api = window.fanDesktop?.browser

      if (!api) {
        return null
      }

      if (createdRef.current.has(id)) {
        return id
      }

      // Concurrent calls (the effect re-runs during restore) must not each
      // rebuild the group -> duplicated tabs. Share one in-flight promise per id.
      const pending = inflightRef.current.get(id)

      if (pending) {
        return pending
      }

      const run = (async (): Promise<string | null> => {
        // Restore the tabs this workbench had open before the app closed (real
        // browser behavior); a fresh session falls back to a blank new-tab page.
        let restoredTabs: Array<{ title?: string; url: string; favicon?: string }> = []
        let restoredActive = 0

        if (id) {
          const restored = await requestGateway<{
            state?: { active?: number; tabs?: Array<{ title?: string; url?: string; favicon?: unknown }> }
          }>('session.browserState.get', { browser_workbench_id: id }).catch(() => null)

          restoredTabs = (restored?.state?.tabs ?? [])
            .filter(
              (t): t is { title?: string; url: string; favicon?: unknown } =>
                typeof t?.url === 'string' && !isInternalWorkbenchUrl(t.url)
            )
            .map(tab => {
              const favicon = sanitizePersistedFavicon(tab.favicon)

              return {
                title: tab.title,
                url: tab.url,
                ...(favicon ? { favicon } : {})
              }
            })
          restoredActive = Math.min(Math.max(0, restored?.state?.active ?? 0), Math.max(0, restoredTabs.length - 1))
        }

        // Restore even a single saved tab through the metadata-aware path so
        // its persisted title/favicon are available before page events arrive.
        if (restoredTabs.length > 0 && api.restoreTabs) {
          const ok = await api.restoreTabs(id, { active: restoredActive, tabs: restoredTabs }).catch(() => null)

          if (ok?.ok) {
            createdRef.current.add(id)

            return id
          }
        }

        // Fresh session (no restorable tabs) → marker undefined → about:blank.
        const marker = restoredTabs[restoredActive]?.url ?? restoredTabs[0]?.url
        const result = await api.create(id, marker)

        if (!result?.browserWorkbenchId) {
          return null
        }

        createdRef.current.add(id)

        return id
      })()

      inflightRef.current.set(id, run)

      try {
        return await run
      } finally {
        inflightRef.current.delete(id)
      }
    },
    [requestGateway]
  )

  const hideShownView = useCallback((reason: FanBrowserSurfaceVisibilityReason = 'lifecycle') => {
    const api = window.fanDesktop?.browser
    const shown = shownRef.current

    if (api?.detachSurface && shown) {
      void api.detachSurface(shown, reason, surfaceOwnerRef.current)
    } else if (api?.hideAll) {
      void api.hideAll(reason)
    } else if (api && shown) {
      void api.setVisible(shown, false, reason)
    }

    shownRef.current = null
  }, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    const api = window.fanDesktop?.browser

    if (!host || !api) {
      return
    }

    let frame = 0

    function mayPresent(id: string) {
      return Boolean(
        surfaceVisibleRef.current &&
        gatewayReadyRef.current &&
        nativeAllowedRef.current &&
        !nativeViewOccludedRef.current &&
        workbenchRef.current === id
      )
    }

    function showAtBounds(id: string, bounds: FanBrowserRect) {
      if (!mayPresent(id)) {
        return
      }

      // One atomic declaration reaches the main-process presentation
      // controller. It owns native visibility, so a late resize can never
      // independently reveal a page that is still loading or no longer active.
      const intent = surfaceIntentRef.current
      shownRef.current = id

      if (api.present) {
        void api.present(id, bounds, surfaceOwnerRef.current)
      } else {
        // Compatibility for an older development main process during hot reload.
        void api.setBounds(id, bounds).then(() => {
          if (surfaceIntentRef.current !== intent || shownRef.current !== id || !mayPresent(id)) {
            return
          }

          return api.setVisible(id, true)
        })
      }

      if (scrimActiveRef.current && mayPresent(id)) {
        void api.scrimShow?.(bounds)
      }
    }

    function pushBounds() {
      // No bounds/visibility pushes while an overlay route covers the pane —
      // a window resize would otherwise re-show the view ON TOP of the card.
      const id = workbenchRef.current

      if (!host || !api || !id || !mayPresent(id)) {
        return
      }

      const bounds = boundsForHost(host)

      if (!bounds) {
        lastRectRef.current = null

        return
      }

      if (shownRef.current === id) {
        showAtBounds(id, bounds)
        lastRectRef.current = bounds

        return
      }

      if (sameBounds(lastRectRef.current, bounds)) {
        showAtBounds(id, bounds)
      } else {
        lastRectRef.current = bounds
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(pushBounds)
      }
    }

    const schedulePush = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(pushBounds)
    }

    schedulePushRef.current = schedulePush

    const observer = new ResizeObserver(pushBounds)
    observer.observe(host)
    window.addEventListener('resize', schedulePush)
    const unsubscribePanes = $paneStates.subscribe(schedulePush)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedulePush)
      unsubscribePanes()
    }
  }, [])

  useLayoutEffect(() => {
    if (shownRef.current && shownRef.current !== workbenchId) {
      hideShownView()
    }

    // The same React instance can move A -> B -> A. Rotate the native lease at
    // each workbench boundary so an old cleanup for A cannot hide the later A.
    surfaceOwnerRef.current = createBrowserSurfaceOwnerId()
    surfaceIntentRef.current += 1
  }, [hideShownView, workbenchId])

  useLayoutEffect(() => {
    surfaceIntentRef.current += 1

    if (!surfaceVisible) {
      scrimActiveRef.current = false
      void window.fanDesktop?.browser?.scrimHide?.()
      hideShownView('layout')
      // The next visible intent owns a new lease even when the workbench id did
      // not change (chat-only -> split/browser on the same session).
      surfaceOwnerRef.current = createBrowserSurfaceOwnerId()

      return
    }

    schedulePushRef.current()
  }, [hideShownView, surfaceVisible])

  // `ready + !nativeVisible` is not a loading state: Chromium has a usable
  // document, but Main no longer holds this renderer's foreground declaration.
  // Reassert it only while this exact panel is allowed to own the surface. This
  // is a recovery boundary for lifecycle/HMR races, never a generic retry that
  // could reveal a page behind another route or a chat-only layout.
  useLayoutEffect(() => {
    if (
      surfaceVisible &&
      nativeAllowed &&
      !nativeViewOccluded &&
      presentation.phase === 'ready' &&
      !presentation.nativeVisible
    ) {
      schedulePushRef.current()
    }
  }, [nativeAllowed, nativeViewOccluded, presentation.nativeVisible, presentation.phase, surfaceVisible])

  useEffect(() => {
    if (!workbenchId || !gatewayReady) {
      hideShownView()

      return
    }

    if (shownRef.current && shownRef.current !== workbenchId) {
      hideShownView()
    }

    let cancelled = false

    void (async () => {
      const boundWorkbenchId = await ensureNativeWorkbench(workbenchId)

      if (cancelled || workbenchRef.current !== workbenchId || !boundWorkbenchId) {
        return
      }

      // A workbench being created is enough to attach the primary surface.
      // Main keeps only the initial blank target hidden, then reveals Chromium
      // on its first real document commit. Waiting for dom-ready or a nonblank
      // URL in React was the old source of timing races and blank panes.
      setOpenedWorkbenchId(prev => (prev === workbenchId ? prev : workbenchId))
      lastRectRef.current = null
      schedulePushRef.current()

      if (activeSessionId) {
        const bindKey = `${activeSessionId}:${boundWorkbenchId}`

        if (!agentBoundRef.current.has(bindKey)) {
          await requestGateway('session.bindBrowser', {
            session_id: activeSessionId,
            browser_workbench_id: boundWorkbenchId
          })
            .then(() => agentBoundRef.current.add(bindKey))
            .catch(() => undefined)
        }
      }

      // Seed the tab strip explicitly. On a RESUMED session the native view
      // already exists and its page is loaded, so no nav event fires — and
      // tabs.state is only pushed on nav/tab changes. Without this pull the
      // strip stays empty (session switch reset it), so a restored session
      // showed a live page but no tab. tabs.state events keep it fresh after.
      const tabsRevision = tabsStateRevisionRef.current
      const tabs = await window.fanDesktop?.browser?.listTabs?.(boundWorkbenchId).catch(() => null)

      if (
        tabs?.ok &&
        !cancelled &&
        workbenchRef.current === workbenchId &&
        tabsStateRevisionRef.current === tabsRevision
      ) {
        setTabsState({ active: tabs.active, tabs: tabs.tabs })
      }

      const presentationRevision = presentationPushRevisionRef.current

      const nextPresentation = await window.fanDesktop?.browser
        ?.presentationState?.(boundWorkbenchId)
        ?.catch(() => null)

      if (
        nextPresentation &&
        !cancelled &&
        workbenchRef.current === workbenchId &&
        presentationPushRevisionRef.current === presentationRevision
      ) {
        applyPresentationState(nextPresentation)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    activeSessionId,
    applyPresentationState,
    ensureNativeWorkbench,
    gatewayReady,
    hideShownView,
    nativeAllowed,
    requestGateway,
    workbenchId
  ])

  useEffect(
    () => () => {
      hideShownView()
    },
    [hideShownView]
  )

  // A settings route or a window-centred DOM modal must own the entire
  // renderer plane. Hide the native browser view without destroying it, then
  // present the same live page again when the final overlay closes.
  useLayoutEffect(() => {
    const api = window.fanDesktop?.browser

    if (!api) {
      return
    }

    if (nativeViewOccluded) {
      if (api.detachSurface && shownRef.current) {
        void api.detachSurface(shownRef.current, 'overlay', surfaceOwnerRef.current)
      } else if (api.hideAll) {
        void api.hideAll('overlay')
      } else if (shownRef.current) {
        void api.setVisible(shownRef.current, false, 'overlay')
      }

      return
    }

    // pushBounds no-ops safely when nothing is allowed/shown yet; when the
    // view was visible before the overlay it re-shows in a single
    // setBounds + setVisible(true) round trip.
    schedulePushRef.current()
  }, [nativeViewOccluded])

  // Modal scrim (official overlay-View pattern): while a dialog / command
  // palette is open, a native dim view covers the browser rect — the page
  // stays LIVE underneath (no hiding, no frozen-snapshot swap) and input
  // aimed at it is correctly swallowed. The DOM backdrop covers everything
  // else; same color, so the two read as one continuous veil.
  useEffect(() => {
    const api = window.fanDesktop?.browser

    // While an overlay route covers the pane the view is hidden — a native
    // scrim would paint a stray dim rectangle ON TOP of the overlay card.
    if (!api?.scrimShow || !surfaceVisible || !overlaySuppressed || !nativeVisible || nativeViewOccluded) {
      return
    }

    const host = hostRef.current
    const bounds = lastRectRef.current ?? (host ? boundsForHost(host) : null)

    if (!bounds) {
      return
    }

    scrimActiveRef.current = true
    void api.scrimShow(bounds)

    return () => {
      scrimActiveRef.current = false
      void api.scrimHide()
    }
  }, [nativeViewOccluded, nativeVisible, overlaySuppressed, surfaceVisible])

  // Click/Esc land in the scrim view's own webContents — route them back to
  // the top-most modal as a dismiss.
  useEffect(() => window.fanDesktop?.browser?.onScrimDismissed?.(dismissTopNativeScrim), [])

  // Co-browsing UX: subscribe to runtime events for the ACTIVE workbench so the
  // chrome (back/forward/reload/loading + URL) tracks user- and agent-driven
  // navigation. Captcha / human-verification and user-takeover pauses are now
  // driven end-to-end by the backend tool (verification.request / control.request
  // → BrowserPausePrompt above the composer); here we only auto-resolve the
  // verification pause when the runtime reports the captcha cleared. The
  // The runtime control projection drives the operating chrome below.
  useEffect(() => {
    const api = window.fanDesktop?.browser

    // Reset the per-workbench chrome (tab strip, URL bar, nav state) on EVERY
    // workbench change — INCLUDING to null. Since "New" no longer mints a draft
    // id, a fresh session sets workbenchId to null; resetting only behind the
    // id guard below left the PREVIOUS session's tabs/URL on screen (the
    // "new session shows old tabs" bug). A fresh/blank workbench emits no nav
    // event, so this immediate clear is the only thing that empties the strip.
    navigationRequestRef.current += 1
    tabsStateRevisionRef.current += 1
    presentationPushRevisionRef.current += 1
    clearPendingOmniboxNavigation()
    setTabsState({ active: 0, tabs: [] })
    setOmniboxDraft('')
    setOmniboxEditing(false)
    setOmniboxComposing(false)
    const emptyPresentation = { ...EMPTY_PRESENTATION, id: workbenchId ?? '', workbenchId: workbenchId ?? '' }
    presentationRef.current = emptyPresentation
    setPresentation(emptyPresentation)

    navStateRef.current = { ok: false }
    setNavState(navStateRef.current)

    if (!api?.onEvent || !workbenchId) {
      return
    }

    void api
      .navState?.(workbenchId)
      .then(state => {
        if (state?.ok && workbenchRef.current === workbenchId) {
          navStateRef.current = state
          setNavState(state)
        }
      })
      .catch(() => undefined)

    if (api.presentationState) {
      const pullRevision = presentationPushRevisionRef.current
      void api
        .presentationState(workbenchId)
        .then(next => {
          if (workbenchRef.current === workbenchId && presentationPushRevisionRef.current === pullRevision) {
            applyPresentationState(next)
          }
        })
        .catch(() => undefined)
    }

    const unsubscribe = api.onEvent(event => {
      const type = event?.type
      const payload = event?.payload

      if (!type || !payload) {
        return
      }

      const eventWorkbenchId = payload.workbenchId ?? payload.sessionId ?? payload.id

      if (eventWorkbenchId != null && String(eventWorkbenchId) !== workbenchRef.current) {
        return
      }

      if (type === 'nav.state') {
        const state = payload as unknown as FanBrowserNavState
        setNavState(state)
        navStateRef.current = state
        const currentWorkbenchId = workbenchRef.current

        if (currentWorkbenchId) {
          settlePendingOmniboxNavigation(state, currentWorkbenchId)
        }

        // Persistence is driven by tabs.state (covers single- and multi-tab).

        return
      }

      if (type === 'tabs.state') {
        const p = payload as unknown as {
          active?: number
          tabs?: SessionTabInfo[]
        }

        const tabs = Array.isArray(p.tabs) ? p.tabs : []
        const active = typeof p.active === 'number' ? p.active : 0
        tabsStateRevisionRef.current += 1
        setTabsState({ active, tabs })

        return
      }

      if (type === 'presentation.state') {
        presentationPushRevisionRef.current += 1
        applyPresentationState(payload as unknown as FanBrowserPresentationState)

        return
      }

      if (type === 'user.intervened') {
        // Runtime input detection is the first authoritative signal. Project a
        // non-actionable inline "pausing" row immediately instead of waiting
        // for browser_run → programHandoff → Gateway control.request. The
        // Gateway event replaces this provisional request once native work has
        // settled far enough to offer Continue safely.
        const current = $controlRequest.get()

        if (!current || current.provisional) {
          const interventionId =
            typeof payload.interventionId === 'string' && payload.interventionId
              ? payload.interventionId
              : typeof payload.eventId === 'string' && payload.eventId
                ? payload.eventId
                : `${Date.now()}`
          const rawKind =
            typeof payload.inputKind === 'string'
              ? payload.inputKind
              : typeof payload.kind === 'string'
                ? payload.kind
                : 'browser-input'

          if (current?.provisional) {
            clearControlRequest(activeSessionId)
          }
          setControlRequest({
            message: '识别到你操作了浏览器，正在安全暂停 Fan',
            requestId: `runtime-intervention:${interventionId}`,
            sessionId: activeSessionId,
            url: typeof payload.url === 'string' ? payload.url : '',
            provisional: true,
            settling: true,
            tabKind:
              payload.tabKind === 'tab' || payload.kind === 'tab'
                ? 'tab'
                : undefined,
            anchorTabId:
              typeof payload.anchorTabId === 'string' ? payload.anchorTabId : undefined,
            userTabId:
              typeof payload.userTabId === 'string' ? payload.userTabId : undefined,
            inputKind: rawKind,
            interventionId,
            interventionTimestamp:
              typeof payload.interventionTimestamp === 'number'
                ? payload.interventionTimestamp
                : typeof payload.timestamp === 'number'
                  ? payload.timestamp
                  : Date.now()
          })
        }

        return
      }

      if (type === 'captcha.cleared') {
        // Auto-resolve the human-verification pause the instant the runtime sees
        // the captcha clear, so the agent resumes without the user also having to
        // acknowledge it in the composer. Detection and the blocking banner are
        // driven by the backend tool (verification.request → BrowserPausePrompt);
        // this signal is the only successful resume path for verification.
        const pending = $verificationRequest.get()
        const clearPayload = payload as Record<string, unknown>
        const challengeId = typeof clearPayload.challengeId === 'string' ? clearPayload.challengeId : ''

        if (challengeId) {
          const now = Date.now()

          for (const [id, recent] of recentCaptchaClearsRef.current) {
            if (now - recent.clearedAt > RECENT_CAPTCHA_CLEAR_TTL_MS) {
              recentCaptchaClearsRef.current.delete(id)
            }
          }

          recentCaptchaClearsRef.current.set(challengeId, { clearedAt: now, payload: clearPayload })
        }

        if (pending) {
          autoResolveVerification(pending, clearPayload)
        }

        return
      }
    })

    return () => {
      unsubscribe()
    }
  }, [
    applyPresentationState,
    activeSessionId,
    autoResolveVerification,
    clearPendingOmniboxNavigation,
    settlePendingOmniboxNavigation,
    workbenchId
  ])

  // Runtime IPC and gateway stream events travel over different transports. A
  // very fast solve can therefore deliver captcha.cleared just before the
  // matching verification.request is parked in the prompt store. Replay only
  // a recent clear with the exact opaque identity; stale or legacy events stay
  // fail-closed and keep the verification prompt visible.
  useEffect(() => {
    const challengeId = verificationRequest?.challengeId

    if (!challengeId) {
      return
    }

    const recent = recentCaptchaClearsRef.current.get(challengeId)

    if (!recent) {
      return
    }

    if (Date.now() - recent.clearedAt > RECENT_CAPTCHA_CLEAR_TTL_MS) {
      recentCaptchaClearsRef.current.delete(challengeId)

      return
    }

    autoResolveVerification(verificationRequest, recent.payload)
  }, [autoResolveVerification, verificationRequest])

  const navigate = (next: string) => {
    const trimmed = next.trim()

    if (!trimmed) {
      return
    }

    const id = workbenchRef.current

    // No draft concept: SessionBrowser only mounts under a real session, so a
    // missing workbench id means we're mid-teardown — ignore the nav input.
    if (!id) {
      return
    }

    const requestId = navigationRequestRef.current + 1
    const expectedTabId = activeTab?.tabId ?? presentationRef.current.activeTabId
    const startDocumentRevision = Number(navStateRef.current.documentRevision || 0)
    const startUrl = String(navStateRef.current.url || '')
    navigationRequestRef.current = requestId
    replacePendingOmniboxNavigation({
      display: trimmed,
      requestId,
      startDocumentRevision,
      startUrl,
      tabId: expectedTabId,
      workbenchId: id
    })
    setOmniboxEditing(false)
    setOmniboxComposing(false)

    void (async () => {
      // Omnibox: a URL navigates; anything else searches the configured engine
      // (typing "nihao" → engine search, "baidu.com" → the site).
      const target = await resolveOmniboxUrl(trimmed)

      if (
        navigationRequestRef.current !== requestId ||
        workbenchRef.current !== id ||
        (expectedTabId != null && presentationRef.current.activeTabId !== expectedTabId)
      ) {
        clearPendingOmniboxNavigation(requestId)

        return
      }

      replacePendingOmniboxNavigation({
        display: committedLocationFor(target).display || target,
        requestId,
        startDocumentRevision,
        startUrl,
        tabId: expectedTabId,
        workbenchId: id
      })

      const created = await ensureNativeWorkbench(id)

      if (!created || navigationRequestRef.current !== requestId || workbenchRef.current !== id) {
        clearPendingOmniboxNavigation(requestId)

        return
      }

      setOpenedWorkbenchId(prev => (prev === id ? prev : id))
      lastRectRef.current = null
      schedulePushRef.current()

      const result = await window.fanDesktop?.browser?.navigate(created, target, {
        source: 'omnibox',
        clientRequestId: requestId,
        expectedTabId
      })

      if (
        navigationRequestRef.current !== requestId ||
        (result?.clientRequestId != null && Number(result.clientRequestId) !== requestId)
      ) {
        return
      }

      if (!result?.ok) {
        clearPendingOmniboxNavigation(requestId)

        return
      }

      // A local page can commit before the IPC acknowledgement is delivered.
      // Re-check the last Chromium projection without resurrecting a request
      // already settled by the event stream.
      if (pendingOmniboxNavigationRef.current?.requestId === requestId) {
        settlePendingOmniboxNavigation(navStateRef.current, id)
      }
    })().catch(() => {
      if (navigationRequestRef.current === requestId) {
        clearPendingOmniboxNavigation(requestId)
      }
    })
  }

  const runNav = (op: 'back' | 'forward' | 'reload') => {
    const id = workbenchRef.current
    const api = window.fanDesktop?.browser

    if (!id || !api) {
      return
    }

    const call = op === 'back' ? api.back : op === 'forward' ? api.forward : api.reload

    void call(id)
      .then(state => {
        if (state?.ok) {
          navStateRef.current = state
          setNavState(state)
        }
      })
      .catch(() => undefined)
  }

  // Publish the followed (active) tab to a shared store so the composer Follow chip
  // — which lives outside this component — can mirror it. SessionBrowser is a single
  // instance that tracks the foreground session, so it is the sole publisher.
  useEffect(() => {
    const tabs = tabsState.tabs
    const activeTab = tabs[tabsState.active] || tabs[0]

    if (!activeTab) {
      setFollowTab(null)

      return
    }

    setFollowTab({
      tabId: activeTab.tabId,
      workbenchId: workbenchId || '',
      title: activeTab.title || '',
      url: activeTab.url || '',
      favicon: activeTab.favicon,
      faviconPending: activeTab.faviconPending,
      loadFailed: activeTab.loadFailed,
      tabCount: tabs.length
    })
  }, [tabsState, workbenchId])

  useEffect(() => () => setFollowTab(null), [])

  // Recompute the edge-fade hints whenever the tab set changes (its scrollWidth and
  // which edges are clipped change with it).
  useEffect(() => {
    const el = tabStripRef.current

    if (el) {
      setTabScrollHints(prev => {
        const next = tabScrollHintsFor(el)

        return prev.left === next.left && prev.right === next.right ? prev : next
      })
    }
  }, [tabsState])

  const switchToTab = (tabId: string) => {
    const id = workbenchRef.current

    if (id) {
      void window.fanDesktop?.browser?.switchTab?.(id, tabId).catch(() => undefined)
    }
  }

  const closeTabById = (tabId: string) => {
    const id = workbenchRef.current

    if (!id) {
      return
    }

    void window.fanDesktop?.browser
      ?.closeTab?.(id, tabId)
      .then(res => {
        // main soft-blocks closing a tab while the agent is operating (lossy, unlike
        // switch/new which pause + restore) — surface why nothing happened.
        if (res && res.ok === false && res.blocked === 'operating') {
          notify({ kind: 'info', message: 'AI 正在操作浏览器，暂时无法关闭标签页', durationMs: 3000 })
        }
      })
      .catch(() => undefined)
  }

  const navDisabled = !nativeAllowed

  const activePendingOmniboxNavigation =
    pendingOmniboxNavigation &&
    pendingOmniboxNavigation.workbenchId === workbenchId &&
    (pendingOmniboxNavigation.tabId == null || pendingOmniboxNavigation.tabId === activeTab?.tabId)
      ? pendingOmniboxNavigation
      : null

  const settledOmniboxValue = activePendingOmniboxNavigation?.display ?? committedLocation.display
  const omniboxValue = omniboxEditing ? omniboxDraft : settledOmniboxValue

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5 p-1.5">
      {tabsState.tabs.length >= 1 && (
        // Pencil Z17lB: a grey chrome strip. Tabs sit on the BOTTOM edge (items-
        // end) so the active tab's flared bottom merges into the strip and opens
        // onto the page below. overflow-x-auto scrolls the strip when tabs spill.
        <div
          className="flex shrink-0 items-end gap-1.5 overflow-x-auto rounded-t-[0.625rem] bg-[#F2F4F6] px-1.5 pt-1.5 dark:bg-[#26282B]"
          onDragLeave={event => {
            // Only clear when the pointer truly leaves the strip — moving between
            // child tabs fires dragleave on the tab being left.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropSlot(null)
            }
          }}
          onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault()
            const from = event.dataTransfer.getData('application/x-fan-tab')
            const id = workbenchRef.current
            const slot = dropSlot

            setDraggingTabId(null)
            setDropSlot(null)

            if (from && id && slot != null) {
              const fromIdx = tabsState.tabs.findIndex(t => t.tabId === from)
              // Removing `from` shifts later indices left by one, so a drop slot past
              // the source maps one lower.
              const dest = fromIdx >= 0 && fromIdx < slot ? slot - 1 : slot

              if (fromIdx >= 0 && dest !== fromIdx) {
                void window.fanDesktop?.browser?.reorderTab?.(id, from, dest).catch(() => undefined)
              }
            }
          }}
          onScroll={event => {
            const next = tabScrollHintsFor(event.currentTarget)

            setTabScrollHints(prev => (prev.left === next.left && prev.right === next.right ? prev : next))
          }}
          onWheel={event => {
            // Mouse wheel (vertical only) → horizontal scroll, so a mouse user can
            // reach tabs clipped off the right when there are many (trackpad already
            // scrolls horizontally on its own).
            if (event.deltaY !== 0 && event.deltaX === 0) {
              event.currentTarget.scrollLeft += event.deltaY
            }
          }}
          ref={tabStripRef}
          style={{ maskImage: tabStripMask(tabScrollHints), WebkitMaskImage: tabStripMask(tabScrollHints) }}
        >
          {tabsState.tabs.map((t, i) => {
            const active = i === tabsState.active

            const controlIdentity =
              activeBrowserControl?.id === workbenchId && activeBrowserControl.activeTabId === t.tabId
                ? activeBrowserControl.identity
                : null

            const displayedUrl = controlIdentity?.url || t.url
            const displayedTitle = controlIdentity?.title || t.title || t.url || '新标签页'

            return (
              <Fragment key={t.tabId}>
                {/* drop placeholder — a primary bar at the insertion slot, springing in */}
                {dropSlot === i && (
                  <span aria-hidden className="tab-drop-line h-7 w-[0.1875rem] shrink-0 rounded-full bg-primary" />
                )}
                {/* Divider between two INACTIVE neighbours (Pencil Z17lB) — the
                    active tab's flared shape is its own separator. */}
                {i > 0 && !active && i - 1 !== tabsState.active && dropSlot !== i && (
                  <span
                    aria-hidden
                    className="h-[1.125rem] w-px shrink-0 self-center rounded-[1px] bg-[#DCE1E8] dark:bg-white/10"
                  />
                )}
                <div
                  // Pencil Z17lB tab: ACTIVE = white chrome tab (.chrome-tab —
                  // rounded top, bottom corners flaring into the strip, faint
                  // drop shadow), dark bold title. INACTIVE = transparent, muted
                  // title. dark: keeps the fill/title legible on a dark strip.
                  className={`group flex max-w-40 min-w-0 shrink-0 cursor-default items-center gap-2 text-[0.8125rem] transition-opacity ${
                    draggingTabId === t.tabId ? 'opacity-40 ' : ''
                  }${
                    active
                      ? 'chrome-tab px-4 py-[0.5625rem] font-semibold text-[#1A1D21] dark:text-white dark:[--ct-fill:#2C2F33]'
                      : 'px-3.5 py-[0.5625rem] font-medium text-[#5C636E] dark:text-[#9BA1AA]'
                  }`}
                  draggable
                  onClick={() => switchToTab(t.tabId)}
                  onDragEnd={() => {
                    setDraggingTabId(null)
                    setDropSlot(null)
                  }}
                  onDragOver={event => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    const slot = event.clientX > rect.left + rect.width / 2 ? i + 1 : i

                    setDropSlot(prev => (prev === slot ? prev : slot))
                  }}
                  onDragStart={event => {
                    event.dataTransfer.setData('application/x-fan-tab', t.tabId)
                    event.dataTransfer.effectAllowed = 'move'
                    setDraggingTabId(t.tabId)
                  }}
                  role="button"
                  style={active ? ({ '--ct-flare': '11px', '--ct-radius': '10px' } as CSSProperties) : undefined}
                >
                  <TabFavicon
                    faviconPending={controlIdentity?.faviconPending ?? t.faviconPending}
                    loadFailed={controlIdentity?.loadFailed ?? t.loadFailed}
                    src={controlIdentity ? controlIdentity.favicon : t.favicon}
                    url={displayedUrl}
                  />
                  <span className="min-w-0 flex-1 truncate">{displayedTitle}</span>
                  <button
                    aria-label="关闭标签"
                    className={`grid size-3.5 shrink-0 place-items-center rounded-sm text-(--ui-text-tertiary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground hover:opacity-100 ${
                      active ? 'opacity-100' : 'opacity-50'
                    }`}
                    onClick={event => {
                      event.stopPropagation()
                      closeTabById(t.tabId)
                    }}
                    type="button"
                  >
                    <X aria-hidden className="size-3" />
                  </button>
                </div>
              </Fragment>
            )
          })}
          {dropSlot === tabsState.tabs.length && (
            <span aria-hidden className="tab-drop-line h-7 w-[0.1875rem] shrink-0 rounded-full bg-primary" />
          )}
        </div>
      )}
      <div className="relative flex shrink-0 items-center gap-1.5">
        <div className="flex shrink-0 items-center gap-0.5">
          <Tip label="后退" side="top">
            <Button
              aria-label="后退"
              className="size-7 rounded-lg p-0 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:opacity-40"
              disabled={navDisabled || !navState.canGoBack}
              onClick={() => runNav('back')}
              size="sm"
              variant="ghost"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </Button>
          </Tip>
          <Tip label="前进" side="top">
            <Button
              aria-label="前进"
              className="size-7 rounded-lg p-0 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:opacity-40"
              disabled={navDisabled || !navState.canGoForward}
              onClick={() => runNav('forward')}
              size="sm"
              variant="ghost"
            >
              <ChevronRight aria-hidden className="size-4" />
            </Button>
          </Tip>
          <Tip label="刷新" side="top">
            <Button
              aria-label="刷新"
              className="size-7 rounded-lg p-0 text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) hover:text-foreground disabled:opacity-40"
              disabled={navDisabled}
              onClick={() => runNav('reload')}
              size="sm"
              variant="ghost"
            >
              {/* Static refresh glyph — the single loading spinner lives in the
                  address bar; spinning this too gave two circles at once. */}
              <RefreshCw aria-hidden className="size-3.5" />
            </Button>
          </Tip>
        </div>
        <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[0.625rem] border border-(--ui-stroke-tertiary) bg-card px-2.5">
          {/* This glyph represents the last browser-committed page only. It is
              intentionally independent from the editable draft, so typing in a
              blank tab cannot turn the Fan mark into a globe before Enter. */}
          {committedLocation.kind === 'search' ? (
            <Search aria-hidden className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
          ) : showFanMarkInAddressBar ? (
            <img
              alt=""
              aria-hidden
              className="size-3.5 shrink-0 object-contain opacity-80 dark:invert"
              draggable={false}
              src={FAN_LOGO_MARK}
            />
          ) : /^https:/i.test(committedLocation.url) ? (
            <Lock aria-hidden className="size-3.5 shrink-0 text-(--ui-green)" />
          ) : /^http:/i.test(committedLocation.url) ? (
            <span
              aria-label="不安全连接"
              className="flex shrink-0 items-center gap-1 rounded-full bg-(--ui-red)/10 px-1.5 py-0.5 text-[10px] font-medium text-(--ui-red)"
            >
              <AlertTriangle aria-hidden className="size-3" />
              <span>不安全</span>
            </span>
          ) : (
            <Globe aria-hidden className="size-3.5 shrink-0 text-(--ui-text-tertiary)" />
          )}
          <Input
            autoComplete="off"
            // w-full + flex-1 so the input FILLS the bar — otherwise it sized to
            // its content and the empty right half of the bar was a dead zone
            // (clicks there didn't focus it), and the bar's usable width drifted
            // with the url length. Its selection deliberately inherits the same
            // global selection token as every other Fan input.
            className="h-6 w-full min-w-0 flex-1 border-0 bg-transparent px-0 py-0 font-mono text-xs shadow-none focus:shadow-none! focus-visible:shadow-none! focus-visible:ring-0"
            onBlur={() => {
              setOmniboxComposing(false)
              setOmniboxEditing(false)
            }}
            onChange={event => {
              // Enter does not blur a controlled input. If the user starts
              // typing again while the previous navigation is settling, return
              // to editing immediately instead of leaving an invisible draft.
              setOmniboxDraft(event.target.value)
              setOmniboxEditing(true)
            }}
            onCompositionEnd={() => setOmniboxComposing(false)}
            onCompositionStart={() => setOmniboxComposing(true)}
            onFocus={event => {
              setOmniboxDraft(activePendingOmniboxNavigation?.display ?? committedLocation.display)
              setOmniboxEditing(true)
              event.currentTarget.select()
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || omniboxComposing || event.nativeEvent.isComposing) {
                return
              }

              event.preventDefault()
              navigate(omniboxDraft)
              // A submitted navigation is no longer editable text. Releasing
              // DOM focus removes the stale blue selection and lets the normal
              // committed/pending address display take over.
              event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)
              event.currentTarget.blur()
            }}
            placeholder="搜索或输入网址"
            ref={omniboxInputRef}
            spellCheck={false}
            value={omniboxValue}
          />
          {/* umRky Agent Badge: a green "● 控制中" pill in the URL bar while the
              agent drives this page — live dot (gentle pulse) + label, matching
              the browser-mock chrome in the design. */}
          {controlActiveForTab && (
            <span className="flex shrink-0 items-center gap-[0.3125rem] rounded-full bg-[color-mix(in_srgb,var(--ui-green)_9%,transparent)] py-[0.1875rem] pl-2 pr-[0.625rem] text-(--ui-green)">
              <span className="size-[0.4375rem] rounded-full bg-(--ui-green) [animation:fan-live-pulse_2.4s_ease-out_infinite]" />
              <span className="font-mono text-[9.5px] tracking-[0.03125rem]">控制中</span>
            </span>
          )}
        </div>
        <BrowserShellActivityControl
          buttonRef={downloadActivityButtonRef}
          dismissed={dismissedDownloadEventKey === downloadEventKey || persistedDownloadActivityDismissed}
          onOpenChange={setDownloadActivityOpen}
          open={downloadActivityOpen}
          tabId={activeTab?.tabId}
          workbenchId={workbenchId}
        />
        {/* Indeterminate load bar in the gap below the nav row — absolute, so it
            never shifts the layout (and never re-bounds the native view). The
            lock stays put; multiple load cycles just sweep the bar again. */}
        {navState.loading && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -bottom-1 h-0.5 overflow-hidden rounded-full"
          >
            <div className="h-full w-1/3 rounded-full bg-primary [animation:browser-progress_1.1s_ease-in-out_infinite]" />
          </div>
        )}
      </div>
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-[0.625rem] border border-(--ui-stroke-tertiary) bg-card"
        ref={hostRef}
      >
        {/* This fallback stays below the native WebContentsView. A fresh tab uses
            it only until Chromium commits its first document; later navigation
            keeps the existing native page visible and reports progress above. */}
        {!nativeViewOccluded &&
          (isNewTabIdle ? (
            <BrowserNewTabState />
          ) : (
            <BrowserSlotState
              error={presentation.phase === 'failed' ? presentation.error : null}
              nativeVisible={presentation.nativeVisible}
              onRetry={presentation.phase === 'failed' ? () => runNav('reload') : undefined}
              phase={presentation.phase}
            />
          ))}
        {/* The native operating frame lives inside the page and is therefore
            invisible while the first WebContentsView is still behind this React
            fallback. Mirror the same control lease here until Chromium is
            revealed; the native page then covers this layer and takes over. */}
        {!nativeViewOccluded && controlActiveForTab && !nativeVisible && (
          <div
            aria-hidden
            className="fan-browser-control-fallback pointer-events-none absolute inset-0 z-20 rounded-[0.625rem]"
          >
            <span className="fan-browser-control-beam" data-edge="top" />
            <span className="fan-browser-control-beam" data-edge="right" />
            <span className="fan-browser-control-beam" data-edge="bottom" />
            <span className="fan-browser-control-beam" data-edge="left" />
          </div>
        )}
      </div>
    </div>
  )
}
