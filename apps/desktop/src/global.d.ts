export {}

declare global {
  interface Window {
    fanDesktop: {
      // Resolve the window's backend connection (the single default backend,
      // reached over the local ws://127.0.0.1 loopback).
      getConnection: () => Promise<FanConnection>
      getGatewayWsUrl: () => Promise<string>
      getBootProgress: () => Promise<DesktopBootProgress>
      lifecycle?: {
        onBeforeQuit: (callback: (payload: { timeoutMs: number }) => void) => () => void
        completeQuitFlush: () => void
      }
      api: <T>(request: FanApiRequest) => Promise<T>
      notify: (payload: FanNotification) => Promise<boolean>
      requestMicrophoneAccess: () => Promise<boolean>
      readFileDataUrl: (filePath: string) => Promise<string>
      readFileText: (filePath: string) => Promise<FanReadFileTextResult>
      sanitizeWorkspaceCwd: (cwd?: null | string) => Promise<{ cwd: string; sanitized: boolean }>
      selectPaths: (options?: FanSelectPathsOptions) => Promise<string[]>
      // Collect vault: OS-keychain-encrypted local store for reusable
      // collect-card values (prefill on repeat collections).
      vault: {
        get: (names: string[]) => Promise<Record<string, string>>
        set: (entries: Record<string, string>) => Promise<boolean>
      }
      writeClipboard: (text: string) => Promise<boolean>
      saveImageFromUrl: (url: string) => Promise<boolean>
      saveImageBuffer: (data: ArrayBuffer | Uint8Array, ext: string) => Promise<string>
      saveClipboardImage: () => Promise<string>
      getPathForFile: (file: File) => string
      normalizePreviewTarget: (target: string, baseDir?: string) => Promise<FanPreviewTarget | null>
      watchPreviewFile: (url: string) => Promise<FanPreviewWatch>
      stopPreviewFileWatch: (id: string) => Promise<boolean>
      setTitleBarTheme?: (payload: FanTitleBarTheme) => void
      applicationMenu?: {
        popup: () => Promise<boolean>
        showInTitlebar: boolean
      }
      windowControls?: {
        close: () => Promise<void>
        isMaximized: () => Promise<boolean>
        minimize: () => Promise<void>
        onMaximizedChange: (callback: (maximized: boolean) => void) => () => void
        toggleMaximize: () => Promise<boolean>
      }
      setPreviewShortcutActive?: (active: boolean) => void
      openExternal: (url: string) => Promise<void>
      fetchLinkTitle: (url: string) => Promise<string>
      settings: {
        getDefaultProjectDir: () => Promise<{ defaultLabel: string; dir: null | string }>
        pickDefaultProjectDir: () => Promise<{ canceled: boolean; dir: null | string }>
        setDefaultProjectDir: (dir: null | string) => Promise<{ dir: null | string }>
      }
      zoom?: {
        get: () => Promise<{ level: number; percent: number }>
        setPercent: (percent: number) => void
        onChanged: (callback: (payload: { level: number; percent: number }) => void) => () => void
      }
      revealLogs: () => Promise<{ ok: boolean; path: string; error?: string }>
      getRecentLogs: () => Promise<{ path: string; lines: string[] }>
      readDir: (path: string) => Promise<FanReadDirResult>
      gitRoot?: (path: string) => Promise<string | null>
      terminal: {
        dispose: (id: string) => Promise<boolean>
        onData: (id: string, callback: (payload: string) => void) => () => void
        onExit: (id: string, callback: (payload: FanTerminalExit) => void) => () => void
        resize: (id: string, size: { cols: number; rows: number }) => Promise<boolean>
        start: (options?: { cols?: number; cwd?: string; rows?: number }) => Promise<FanTerminalSession>
        write: (id: string, data: string) => Promise<boolean>
      }
      onClosePreviewRequested?: (callback: () => void) => () => void
      onOpenAboutRequested?: (callback: () => void) => () => void
      onOpenUpdatesRequested?: (callback: () => void) => () => void
      onOpenSettingsRequested?: (callback: () => void) => () => void
      onWindowStateChanged?: (callback: (payload: FanWindowState) => void) => () => void
      onPreviewFileChanged: (callback: (payload: FanPreviewFileChanged) => void) => () => void
      onBackendExit: (callback: (payload: BackendExit) => void) => () => void
      onPowerResume?: (callback: () => void) => () => void
      onBootProgress: (callback: (payload: DesktopBootProgress) => void) => () => void
      getBootstrapState: () => Promise<DesktopBootstrapState>
      resetBootstrap: () => Promise<{ ok: boolean }>
      cancelBootstrap: () => Promise<{ ok: boolean; cancelled: boolean }>
      onBootstrapEvent: (callback: (payload: DesktopBootstrapEvent) => void) => () => void
      getVersion: () => Promise<DesktopVersionInfo>
      updates: {
        check: () => Promise<DesktopUpdateStatus>
        apply: (opts?: DesktopUpdateApplyOptions) => Promise<DesktopUpdateApplyResult>
        onProgress: (callback: (payload: DesktopUpdateProgress) => void) => () => void
      }
      // Embedded browser workbench: a native WebContentsView floated over a
      // renderer placeholder rect and driven by the Electron-native browser
      // runtime. Position / show / hide flow through these IPC calls.
      browser: {
        create: (
          id: string,
          url?: string
        ) => Promise<{
          browserWorkbenchId?: string | null
          ok: boolean
        }>
        setBounds: (id: string, rect: FanBrowserRect) => Promise<{ ok: boolean }>
        setVisible: (
          id: string,
          visible: boolean,
          reason?: FanBrowserSurfaceVisibilityReason
        ) => Promise<{ blocked?: 'operating'; ok: boolean }>
        present: (
          id: string,
          rect: FanBrowserRect,
          ownerId?: string
        ) => Promise<{ ok: boolean } & Partial<FanBrowserPresentationState>>
        detachSurface: (
          id: string,
          reason?: FanBrowserSurfaceVisibilityReason,
          ownerId?: string
        ) => Promise<{ blocked?: 'operating'; ok: boolean; stale?: boolean } & Partial<FanBrowserPresentationState>>
        hideAll: (reason?: FanBrowserSurfaceVisibilityReason) => Promise<{ blocked?: 'operating'; ok: boolean }>
        overviewTiles: (
          tiles: Array<{ id: string; rect: FanBrowserRect; storageId?: string }>
        ) => Promise<{ ok: boolean }>
        getUrl: (id: string) => Promise<{ ok: boolean; url: string | null }>
        navigate: (
          id: string,
          url: string,
          opts?: {
            source?: 'omnibox' | 'ui'
            clientRequestId?: number
            expectedTabId?: string | null
          }
        ) => Promise<{
          clientRequestId?: number | null
          documentRevision?: number
          ok: boolean
          reason?: string
          tabId?: string
          viewEpoch?: number
        }>
        back: (id: string) => Promise<FanBrowserNavState>
        forward: (id: string) => Promise<FanBrowserNavState>
        reload: (id: string) => Promise<FanBrowserNavState>
        stop: (id: string) => Promise<FanBrowserNavState>
        navState: (id: string) => Promise<FanBrowserNavState>
        presentationState: (id: string) => Promise<FanBrowserPresentationState>
        controlState: (id: string) => Promise<FanBrowserControlState | null>
        listTabs: (id: string) => Promise<{
          ok: boolean
          active: number
          tabs: Array<{
            tabId: string
            title: string
            url: string
            favicon?: string
            faviconPending?: boolean
            loadFailed?: boolean
          }>
        }>
        restoreTabs: (
          id: string,
          state: { active: number; tabs: Array<{ title?: string; url: string; favicon?: string }> }
        ) => Promise<{ ok: boolean }>
        newTab: (id: string, url?: string) => Promise<{ ok: boolean; tabId: string }>
        switchTab: (id: string, tabId: string) => Promise<{ ok: boolean }>
        reorderTab: (id: string, tabId: string, toIndex: number) => Promise<{ ok: boolean }>
        closeTab: (id: string, tabId: string) => Promise<{ ok: boolean; blocked?: string }>
        destroy: (id: string, opts?: { reapPartition?: boolean }) => Promise<{ ok: boolean }>
        hibernate: (id: string) => Promise<{ blocked?: string; count: number; ok: boolean }>
        captureThumbnail: (id: string) => Promise<{ ok: boolean; dataUrl: string | null }>
        captureOverviewThumbnail: (id: string) => Promise<{ ok: true; dataUrl: string | null }>
        scrimShow: (rect: FanBrowserRect) => Promise<{ ok: boolean }>
        scrimHide: () => Promise<{ ok: boolean }>
        onScrimDismissed: (callback: () => void) => () => void
        onOverviewOpen: (callback: (payload: { id: string }) => void) => () => void
        onOverviewWheel: (callback: (payload: { deltaX: number; deltaY: number }) => void) => () => void
        shellState?: (workbenchId?: string) => Promise<FanBrowserShellSnapshot>
        respondShellPrompt?: (
          eventId: string,
          response: { accepted: boolean; value?: string }
        ) => Promise<FanBrowserShellActionResult>
        openDownload?: (eventId: string) => Promise<FanBrowserShellActionResult>
        revealDownload?: (eventId: string) => Promise<FanBrowserShellActionResult>
        showDownloadPopover?: (
          payload: FanBrowserDownloadPopoverRequest
        ) => Promise<{ ok: boolean }>
        hideDownloadPopover?: () => Promise<{ ok: boolean }>
        onDownloadPopoverClosed?: (
          callback: (payload: FanBrowserDownloadPopoverClosed) => void
        ) => () => void
        onEvent: (callback: (event: FanBrowserEvent) => void) => () => void
      }
    }
  }
}

export interface FanBrowserRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FanBrowserNavState {
  ok: boolean
  activeTabId?: string
  documentRevision?: number
  url?: string
  title?: string
  canGoBack?: boolean
  canGoForward?: boolean
  loading?: boolean
}

export interface FanBrowserLoadError {
  code: number | null
  description: string
  url: string
}

export interface FanBrowserPresentationState {
  activeTabId: string | null
  committedUrl: string
  documentRevision: number
  error: FanBrowserLoadError | null
  id: string
  navigationEpoch?: number
  nativeVisible: boolean
  phase: 'blank' | 'preparing' | 'loading' | 'ready' | 'failed' | 'suspended' | 'destroyed'
  viewEpoch: number
  workbenchId: string
}

export interface FanBrowserEvent {
  type: string
  payload: { id?: string } & Record<string, unknown>
}

export type FanBrowserShellEventType =
  | 'shell.download.changed'
  | 'shell.health.changed'
  | 'shell.notice.raised'
  | 'shell.prompt.changed'

export interface FanBrowserShellScope {
  documentRevision: null | number | string
  eventId: string
  tabId: string
  workbenchId: string
}

export interface FanBrowserShellPrompt extends FanBrowserShellScope {
  accepted?: boolean
  actions: string[]
  code: string
  createdAt: number
  defaultValue: string
  dialogType: string
  host: string
  kind: string
  message: string
  pending: boolean
  permission: string
  resolution?: string
  resolvedAt?: number
  revision?: number
  scheme: string
}

export type FanBrowserShellDownloadState =
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'paused'
  | 'progressing'
  | 'started'

export interface FanBrowserShellDownload extends FanBrowserShellScope {
  canOpen: boolean
  canReveal: boolean
  done: boolean
  doneAt: null | number
  downloadId: string
  filename: string
  phase: 'done' | 'progress' | 'started'
  receivedBytes: number
  startedAt: number
  state: FanBrowserShellDownloadState
  totalBytes: number
  updatedAt: number
  revision?: number
}

export type FanBrowserShellHealthStatus = 'crashed' | 'degraded' | 'ok' | 'unresponsive'

export interface FanBrowserShellHealth extends FanBrowserShellScope {
  active: boolean
  clearedAt?: number
  code: string
  revision?: number
  status: FanBrowserShellHealthStatus
  updatedAt: number
}

export interface FanBrowserShellNotice extends FanBrowserShellScope {
  actions: string[]
  active: boolean
  clearedAt?: number
  code: string
  level: 'error' | 'info' | 'warning'
  raisedAt: number
  revision?: number
}

export interface FanBrowserShellSnapshot {
  downloads: FanBrowserShellDownload[]
  health: FanBrowserShellHealth[]
  notices: FanBrowserShellNotice[]
  prompts: FanBrowserShellPrompt[]
  revision: number
}

export interface FanBrowserShellActionResult {
  ok: boolean
  reason?: string
}

export interface FanBrowserDownloadPopoverTheme {
  active: string
  background: string
  border: string
  foreground: string
  green: string
  hover: string
  primary: string
  primaryForeground: string
  red: string
  secondary: string
  tertiary: string
}

export interface FanBrowserDownloadPopoverRequest {
  anchor: FanBrowserRect
  theme: FanBrowserDownloadPopoverTheme
  workbenchId: string
}

export interface FanBrowserDownloadPopoverClosed {
  reason: 'dismiss' | 'empty' | 'escape' | 'outside' | 'unavailable'
}

export interface FanBrowserControlState {
  active: boolean
  activeTabId?: string | null
  controlId: string | null
  id: string
  initialUrl?: string | null
  operating?: boolean
  operatingRevision?: number
  revision: number
  startedAt?: number | null
  stoppedAt?: number | null
  targetUrl?: string | null
  toolCallId?: string | null
  toolName?: string | null
  updatedAt?: number | null
  workbenchId: string
}

export type FanBrowserSurfaceVisibilityReason = 'layout' | 'lifecycle' | 'overlay'

export interface FanTerminalSession {
  cwd: string
  id: string
  shell: string
}

export interface FanTerminalExit {
  code: number | null
  signal: string | null
}

export interface DesktopVersionInfo {
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  fanRoot: string
}

export interface DesktopUpdateCommit {
  sha: string
  summary: string
  author: string
  at: number
}

export interface DesktopUpdateStatus {
  supported: boolean
  reason?: string
  message?: string
  error?: string
  /** 1 when a newer release exists on the feed, 0 otherwise. */
  behind?: number
  currentVersion?: string
  targetVersion?: string
  /** Legacy toast gate — carries the target version when an update exists. */
  targetSha?: string
  releaseNotes?: string
  releaseDate?: string
  commits?: DesktopUpdateCommit[]
  fetchedAt?: number
}

export type DesktopUpdateDirtyStrategy = 'abort' | 'stash' | 'force'

export interface DesktopUpdateApplyOptions {
  dirtyStrategy?: DesktopUpdateDirtyStrategy
}

export interface DesktopUpdateApplyResult {
  ok: boolean
  branch?: string
  error?: string
  message?: string
  /** True when this platform requires a manual install. `command` carries the
   *  URL or exact instruction to show. */
  manual?: boolean
  command?: string
  fanRoot?: string
}

export type DesktopUpdateStage = 'idle' | 'prepare' | 'fetch' | 'pull' | 'pydeps' | 'restart' | 'manual' | 'error'

export interface DesktopUpdateProgress {
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  at: number
}

export interface FanConnection {
  baseUrl: string
  isFullscreen: boolean
  nativeOverlayWidth: number
  token: string
  wsUrl: string
  logs: string[]
  windowButtonPosition: { x: number; y: number } | null
}

export interface FanTitleBarTheme {
  background: string
  foreground: string
}

export interface FanWindowState {
  isFullscreen: boolean
  nativeOverlayWidth: number
  windowButtonPosition: { x: number; y: number } | null
}

export interface DesktopBootProgress {
  error: string | null
  fakeMode: boolean
  message: string
  phase: string
  progress: number
  running: boolean
  timestamp: number
}

// First-launch install ("bootstrap") event types -- emitted by
// electron/bootstrap-runner.cjs and observed by the renderer install overlay.
// Mirrors the event shapes emitted by runBootstrap()'s onEvent callback.

export interface DesktopBootstrapStageDescriptor {
  name: string
  title?: string
  category?: string
  needs_user_input?: boolean
}

export type DesktopBootstrapStageState = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'

export interface DesktopBootstrapStageResult {
  state: DesktopBootstrapStageState
  durationMs: number | null
  startedAt: number | null
  json: { ok: boolean; skipped?: boolean; reason?: string | null; stage: string } | null
  error: string | null
}

export interface DesktopBootstrapUnsupportedPlatform {
  platform: string
  activeRoot: string
  installCommand: string
  docsUrl: string
}

export interface DesktopBootstrapState {
  active: boolean
  manifest: { type: 'manifest'; stages: DesktopBootstrapStageDescriptor[]; protocolVersion: number | null } | null
  stages: Record<string, DesktopBootstrapStageResult>
  error: string | null
  log: Array<{ ts: number; stage: string | null; line: string; stream?: 'stdout' | 'stderr' }>
  startedAt: number | null
  completedAt: number | null
  unsupportedPlatform: DesktopBootstrapUnsupportedPlatform | null
}

export type DesktopBootstrapEvent =
  | { type: 'manifest'; stages: DesktopBootstrapStageDescriptor[]; protocolVersion: number | null }
  | {
      type: 'stage'
      name: string
      state: DesktopBootstrapStageState
      durationMs?: number
      json?: DesktopBootstrapStageResult['json']
      error?: string | null
    }
  | { type: 'log'; stage?: string | null; line: string; stream?: 'stdout' | 'stderr' }
  | { type: 'complete'; marker: Record<string, unknown> }
  | { type: 'failed'; stage?: string | null; error: string }
  | {
      type: 'unsupported-platform'
      platform: string
      activeRoot: string
      installCommand: string
      docsUrl: string
    }

export interface FanApiRequest {
  path: string
  method?: string
  body?: unknown
  timeoutMs?: number
}

export interface FanNotification {
  title?: string
  body?: string
  silent?: boolean
}

export interface FanPreviewTarget {
  binary?: boolean
  byteSize?: number
  kind: 'file' | 'url'
  label: string
  large?: boolean
  language?: string
  mimeType?: string
  path?: string
  previewKind?: 'binary' | 'html' | 'image' | 'text'
  renderMode?: 'preview' | 'source'
  source: string
  url: string
}

export interface FanReadFileTextResult {
  binary?: boolean
  byteSize?: number
  language?: string
  mimeType?: string
  path: string
  text: string
  truncated?: boolean
}

export interface FanPreviewWatch {
  id: string
  path: string
}

export interface FanReadDirEntry {
  name: string
  path: string
  isDirectory: boolean
}

export interface FanReadDirResult {
  entries: FanReadDirEntry[]
  error?: string
}

export interface FanPreviewFileChanged {
  id: string
  path: string
  url: string
}

export interface FanSelectPathsOptions {
  title?: string
  defaultPath?: string
  directories?: boolean
  multiple?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface BackendExit {
  code: number | null
  signal: string | null
}
