const {
  app,
  autoUpdater: nativeAutoUpdater,
  BrowserWindow,
  WebContentsView,
  Menu,
  Notification,
  clipboard,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net: electronNet,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray
} = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { execFileSync, spawn } = require('node:child_process')
const { detectRemoteDisplay, isWindowsBinaryPathInWsl, isWslEnvironment } = require('./bootstrap-platform.cjs')
const { canStartFanBackend } = require('./backend-probes.cjs')
const { createPackagedBackendEnv } = require('./packaged-backend-policy.cjs')
const {
  ElectronBrowserRuntime,
  createBrowserRuntimeRpcServer,
  installBrowserRequestGuard
} = require('./browser-runtime/index.cjs')
const {
  DATA_URL_READ_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  TEXT_PREVIEW_SOURCE_MAX_BYTES,
  resolveReadableFileForIpc,
  resolveRequestedPathForIpc,
  resolveTimeoutMs
} = require('./hardening.cjs')
const { readWindowsUserEnvVar } = require('./windows-user-env.cjs')
const { resolveDesktopFanHome, resolveDevelopmentUserData } = require('./fan-home.cjs')
const { readWslWindowsClipboardImage } = require('./wsl-clipboard-image.cjs')
const { BrowserPresentationController } = require('./browser-presentation-controller.cjs')
const { BrowserNavigationController } = require('./browser-navigation-controller.cjs')
const {
  PendingNavigationAttempts,
  createFaviconDocumentGate,
  isAbortedNavigationFailure,
  resolveCurrentDocumentFavicon,
  sameNavigationUrl
} = require('./browser-document-lifecycle.cjs')
const { BrowserPopupController } = require('./browser-popup-controller.cjs')
const {
  browserPermissionAllowedByDefault,
  browserPermissionRequiresExternalConfirmation,
  normalizeBrowserPermission
} = require('./browser-permission-policy.cjs')
const { BrowserShellController } = require('./browser-shell-controller.cjs')
const {
  downloadPopoverViewBounds,
  normalizeDownloadPopoverDownloads,
  normalizeDownloadPopoverTheme
} = require('./browser-download-popover.cjs')
const { BrowserSessionController } = require('./browser-session-controller.cjs')
const { BrowserSessionProjector } = require('./browser-session-projector.cjs')
const { BrowserTabManager } = require('./browser-tab-manager.cjs')
const { canHideBrowserSurface } = require('./browser-surface-policy.cjs')
const { BrowserViewLifecycle } = require('./browser-view-lifecycle.cjs')
const { ZOOM_STORAGE_KEY, applyZoomLevel, percentToZoomLevel, zoomLevelToPercent } = require('./zoom.cjs')
const { appendRotatingFile, appendRotatingFileSync } = require('./secure-log.cjs')
const { redactLocalLogText } = require('./local-log-redaction.cjs')
const { BrowserResourceGovernor } = require('./browser-resource-governor.cjs')
const { startLocalCrashCapture } = require('./local-crash-capture.cjs')

let nodePty = null

try {
  nodePty = require('node-pty')
} catch {
  // Packaged builds set `files:` in package.json, which excludes node_modules
  // from the asar.  Workspace dedup also hoists this native dep to the repo
  // root's node_modules, out of reach of electron-builder's collector.  We
  // ship a minimal copy under resources/native-deps/ via extraResources +
  // scripts/stage-native-deps.cjs; resolve from there when the normal
  // require() fails.  Dev mode never reaches this branch -- the hoisted
  // resolve succeeds via Node's normal module lookup.
  try {
    const path = require('node:path')
    const resourcesPath = process.resourcesPath
    if (resourcesPath) {
      nodePty = require(path.join(resourcesPath, 'native-deps', 'node-pty'))
    }
  } catch {
    nodePty = null
  }
}

const USER_DATA_OVERRIDE = process.env.FAN_DESKTOP_USER_DATA_DIR
if (USER_DATA_OVERRIDE) {
  const resolvedUserData = path.resolve(USER_DATA_OVERRIDE)
  fs.mkdirSync(resolvedUserData, { recursive: true })
  app.setPath('userData', resolvedUserData)
}

const PORT_FLOOR = 9120
const PORT_CEILING = 9199
const DEV_SERVER = process.env.FAN_DESKTOP_DEV_SERVER
// process.defaultApp is the reliable dev signal: it is set whenever the app
// was launched by passing a path to the electron binary (`electron .`),
// which never happens for a real packaged build.
const IS_PACKAGED = app.isPackaged && !process.defaultApp
const IS_MAC = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'
const IS_WSL = isWslEnvironment()
const APP_ROOT = app.getAppPath()
const FAN_HOME = resolveDesktopFanHome({
  directoryExists,
  env: process.env,
  homeDir: app.getPath('home'),
  isPackaged: IS_PACKAGED,
  isWindows: IS_WINDOWS,
  readWindowsUserEnvVar,
  userDataOverride: USER_DATA_OVERRIDE
})
const DEVELOPMENT_USER_DATA = resolveDevelopmentUserData({
  fanHome: FAN_HOME,
  isPackaged: IS_PACKAGED,
  userDataOverride: USER_DATA_OVERRIDE
})

// Electron's single-instance lock is scoped by userData. Give source/dev
// launches their own Chromium state before requestSingleInstanceLock() runs,
// otherwise an installed Fan process makes `npm run dev` exit immediately.
if (DEVELOPMENT_USER_DATA) {
  fs.mkdirSync(DEVELOPMENT_USER_DATA, { recursive: true })
  app.setPath('userData', DEVELOPMENT_USER_DATA)
}
let mainWindow = null
let applicationTray = null

function showAndFocusMainWindow() {
  if (isAppQuitting || !app.isReady()) return

  // app.show() reverses Cmd+H even if an exceptional native teardown means a
  // replacement window has to be created below.
  if (IS_MAC) app.show()

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }

  // The explicit focus call is needed when the request came from the status
  // item while another application is active.
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (IS_MAC) app.focus({ steal: true })
}

function hasUsableApplicationTray() {
  return Boolean(applicationTray && !applicationTray.isDestroyed())
}

function createApplicationTray() {
  if (hasUsableApplicationTray()) return
  applicationTray = null

  try {
    const imagePath = IS_MAC
      ? path.join(APP_ROOT, 'assets', 'fanTemplate.png')
      : path.join(APP_ROOT, 'assets', IS_WINDOWS ? 'icon.ico' : 'icon.png')
    if (!imagePath) {
      rememberLog('[tray] Fan tray image was not found; status item was not created')
      return
    }

    let image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) {
      rememberLog('[tray] Fan tray image is empty; status item was not created')
      return
    }

    if (IS_MAC) {
      image.setTemplateImage(true)
    } else if (!IS_WINDOWS) {
      image = image.resize({ height: 22, quality: 'best', width: 22 })
    }

    applicationTray = new Tray(image)
    applicationTray.setToolTip(APP_NAME)
    applicationTray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: `显示 ${APP_NAME}`,
          click: showAndFocusMainWindow
        },
        {
          label: '检查更新…',
          click: () => {
            showAndFocusMainWindow()
            setImmediate(sendOpenUpdatesRequested)
          }
        },
        { type: 'separator' },
        {
          label: `退出 ${APP_NAME}`,
          click: () => app.quit()
        }
      ])
    )
    // Linux desktop environments may expose only the context menu, while
    // macOS and Windows also support direct click-to-restore.
    applicationTray.on('click', showAndFocusMainWindow)
  } catch (error) {
    applicationTray = null
    rememberLog(`[tray] failed to create status item: ${error?.message || String(error)}`)
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showAndFocusMainWindow()
  })
}

function registerFanProtocolClient() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      return app.setAsDefaultProtocolClient('fan', process.execPath, [path.resolve(process.argv[1])])
    }
    return app.setAsDefaultProtocolClient('fan')
  } catch (error) {
    rememberLog(`Protocol registration failed: ${error.message}`)
    return false
  }
}

// Inject windowsHide:true into a child-process options object (unless the caller
// set it explicitly) so GUI-launched child spawns — reg query, py launcher,
// git, the updater — don't flash a black console window on Windows.
function hiddenWindowsChildOptions(options = {}) {
  if (!IS_WINDOWS || Object.prototype.hasOwnProperty.call(options, 'windowsHide')) {
    return options
  }
  return { ...options, windowsHide: true }
}

// Remote displays (SSH X11 forwarding, VNC, RDP) make Chromium's GPU
// compositor flicker — accelerated layers can't be presented cleanly over the
// wire, so the window flashes during scroll/streaming/animation. Local
// Windows/macOS (and WSLg, which renders locally via vGPU) composite on the
// GPU and never see it. Fall back to software rendering when a remote display
// is detected; it's rock-steady over the wire and the CPU cost is negligible
// next to the connection's latency. Must run before app `ready` — these
// switches only apply pre-launch. Override with FAN_DESKTOP_DISABLE_GPU
// (1/true → always disable, 0/false → keep GPU on).
const REMOTE_DISPLAY_REASON = detectRemoteDisplay()
if (REMOTE_DISPLAY_REASON) {
  app.disableHardwareAcceleration()
  // Belt-and-suspenders for X11/VNC, where the Viz compositor can still glitch
  // with only --disable-gpu: force compositing onto the CPU too.
  app.commandLine.appendSwitch('disable-gpu-compositing')
  console.log(
    `[fan] remote display detected (${REMOTE_DISPLAY_REASON}); disabling GPU hardware acceleration to prevent flicker`
  )
}

// WSLg exposes a real Windows GPU through /dev/dxg, but Chromium can blacklist
// the virtual Mesa adapter and fall back to sluggish software composition.
// Do not override the explicit remote-display safety path above.
if (IS_WSL && !REMOTE_DISPLAY_REASON && fs.existsSync('/dev/dxg')) {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  console.log('[fan] WSL GPU passthrough detected; enabling GPU acceleration')
}

// Background policy is scoped per webContents below. The chat renderer stays
// responsive while an answer streams, and only browser views belonging to an
// active agent turn opt out of Chromium throttling. Process-wide disable flags
// kept every hidden website's timers/animation/compositor running indefinitely.

const DESKTOP_BROWSER_RUNTIME = 'electron'

const SOURCE_REPO_ROOT = path.resolve(APP_ROOT, '../..')

// Build-time install stamp -- the git ref this .exe was built against.
//
// Written by apps/desktop/scripts/write-build-stamp.cjs during `npm run build`
// and bundled into packaged apps via electron-builder's extraResources entry,
// so the runtime stamp ends up at process.resourcesPath/install-stamp.json
// after install. The bootstrap runner (Phase 1D) reads it to know which
// commit to clone when running install.ps1 stages at first launch.
//
// Returns null when the file is missing (dev runs from a checkout where
// build hasn't been invoked, or schema mismatch). Callers must handle null.
//
// Schema:
//   { schemaVersion: 1, commit, branch, builtAt, dirty, source }
const INSTALL_STAMP_SCHEMA_VERSION = 1
function loadInstallStamp() {
  // Try packaged location first (resources/install-stamp.json), then the
  // dev/local build output (apps/desktop/build/install-stamp.json) so
  // someone running `npm run start` after a local `npm run build` also
  // sees a stamp without needing a packaged build.
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'install-stamp.json') : null,
    path.join(APP_ROOT, 'build', 'install-stamp.json')
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed.commit === 'string' && parsed.commit.length >= 7) {
        if (parsed.schemaVersion !== INSTALL_STAMP_SCHEMA_VERSION) {
          console.warn(
            `[fan] install-stamp.json schemaVersion ${parsed.schemaVersion} != expected ${INSTALL_STAMP_SCHEMA_VERSION}; ignoring`
          )
          continue
        }
        return Object.freeze({
          schemaVersion: parsed.schemaVersion,
          commit: parsed.commit,
          branch: parsed.branch || null,
          builtAt: parsed.builtAt || null,
          dirty: Boolean(parsed.dirty),
          source: parsed.source || null,
          path: p
        })
      }
    } catch {
      // Either ENOENT or malformed JSON; try the next candidate
    }
  }
  return null
}
const INSTALL_STAMP = loadInstallStamp()
if (INSTALL_STAMP) {
  console.log(
    `[fan] install stamp: ${INSTALL_STAMP.commit.slice(0, 12)}${INSTALL_STAMP.branch ? ` (${INSTALL_STAMP.branch})` : ''}${INSTALL_STAMP.dirty ? ' [DIRTY]' : ''} from ${INSTALL_STAMP.source || 'unknown'}`
  )
} else if (IS_PACKAGED) {
  // Dev builds without a stamp are normal; packaged builds without one
  // mean the bootstrap won't know what to clone. Surface clearly.
  console.error(
    '[fan] WARNING: no install-stamp.json found in packaged build. First-launch bootstrap will not have a pinned ref to install.'
  )
}

// FAN_HOME — the user-facing root for everything Fan-related. Mirrors
// scripts/install.ps1's $FanHome and scripts/install.sh's $FAN_HOME.
//
// Defaults:
//   Development: ~/.dev_fan (isolated from installed releases)
//   Packaged Windows: %LOCALAPPDATA%\fan (matches install.ps1)
//   Packaged macOS / Linux: ~/.fan (matches install.sh)
//
// Special case for Windows: if the user has a legacy ~/.fan directory
// (e.g., from a prior pip install or a manual setup) AND no
// %LOCALAPPDATA%\fan yet, prefer the legacy path so we don't orphan their
// existing config / sessions / .env. New installs go to %LOCALAPPDATA%.
//
// FAN_DESKTOP_USER_DATA_DIR (used by test:desktop:fresh) puts the sandbox
// FAN_HOME beneath the throwaway userData dir so a fresh-install run never
// touches the user's real ~/.fan / %LOCALAPPDATA%\fan.
const NATIVE_FAN_ROOT = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), 'fan')
  : path.join(app.getPath('home'), '.fan')
const BROWSER_PROTECTED_FILE_ROOTS = [...new Set([FAN_HOME, NATIVE_FAN_ROOT].map(value => path.resolve(value)))]
if (hasSingleInstanceLock) {
  startLocalCrashCapture({
    app,
    crashReporter,
    rootDir: path.join(FAN_HOME, 'crashes'),
    appVersion: app.getVersion(),
    buildCommit: INSTALL_STAMP?.commit || ''
  })
}
// ACTIVE_FAN_ROOT — the canonical mutable Fan install. Same path
// install.ps1 / install.sh use, so a desktop-only user and a CLI-only user end
// up with identical layouts and can share one install.
const ACTIVE_FAN_ROOT = path.join(FAN_HOME, 'fan-agent')
// desktop.log lives under FAN_HOME/logs/ so it sits next to agent.log,
// errors.log, gateway.log produced by fan_logging.setup_logging — one log
// directory per user, regardless of which UI surface produced the line.
const DESKTOP_LOG_PATH = path.join(FAN_HOME, 'logs', 'desktop.log')
const DESKTOP_LOG_FLUSH_MS = 120
const DESKTOP_LOG_BUFFER_MAX_CHARS = 64 * 1024
const DESKTOP_LOG_MAX_BYTES = 5 * 1024 * 1024
const DESKTOP_LOG_BACKUPS = 3

const BOOT_FAKE_MODE = process.env.FAN_DESKTOP_BOOT_FAKE === '1'
const BOOT_FAKE_STEP_MS = (() => {
  const raw = Number.parseInt(String(process.env.FAN_DESKTOP_BOOT_FAKE_STEP_MS || ''), 10)
  if (!Number.isFinite(raw) || raw <= 0) return 650
  return Math.max(120, raw)
})()
const APP_NAME = 'Fan'
const TITLEBAR_HEIGHT = 34
const MACOS_TRAFFIC_LIGHTS_HEIGHT = 14
const WINDOW_BUTTON_POSITION = {
  x: 24,
  // Design: ONE header row at y 14..48 (the bar's own 14px top padding — the
  // mock's extra 14px window-inset ring is decorative framing, NOT in-window
  // spacing). Traffic lights center on that row while staying near the top,
  // per macOS convention. 14 + (34 - lights height) / 2.
  y: 14 + (34 - MACOS_TRAFFIC_LIGHTS_HEIGHT) / 2
}
const WORKSPACE_WINDOW_SIZE = { width: 1220, height: 800 }
const WORKSPACE_MIN_SIZE = { width: 900, height: 620 }
const WORKSPACE_WINDOW_STATE_PATH = path.join(FAN_HOME, 'desktop-workspace-window.json')
const WORKSPACE_WINDOW_MIN_VISIBLE = 48

const isFiniteWindowNumber = value => typeof value === 'number' && Number.isFinite(value)

function readWorkspaceWindowState() {
  try {
    const raw = JSON.parse(fs.readFileSync(WORKSPACE_WINDOW_STATE_PATH, 'utf8'))
    if (!raw || typeof raw !== 'object' || !isFiniteWindowNumber(raw.width) || !isFiniteWindowNumber(raw.height)) {
      return null
    }
    const state = {
      width: Math.max(WORKSPACE_MIN_SIZE.width, Math.round(raw.width)),
      height: Math.max(WORKSPACE_MIN_SIZE.height, Math.round(raw.height)),
      isMaximized: raw.isMaximized === true
    }
    if (isFiniteWindowNumber(raw.x) && isFiniteWindowNumber(raw.y)) {
      state.x = Math.round(raw.x)
      state.y = Math.round(raw.y)
    }
    return state
  } catch {
    return null
  }
}

function workspaceBoundsOnAttachedDisplay(bounds, displays) {
  return displays.some(display => {
    const area = display?.workArea
    if (!area) return false
    const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return overlapWidth >= WORKSPACE_WINDOW_MIN_VISIBLE && overlapHeight >= WORKSPACE_WINDOW_MIN_VISIBLE
  })
}

function restoredWorkspaceBounds(state) {
  if (!state) return null
  const displays = screen.getAllDisplays()
  const largest = displays.reduce(
    (current, display) => {
      const area = display?.workArea
      if (!area || !isFiniteWindowNumber(area.width) || !isFiniteWindowNumber(area.height)) return current
      return {
        width: Math.max(current.width, area.width),
        height: Math.max(current.height, area.height)
      }
    },
    { width: 0, height: 0 }
  )
  const width = largest.width ? Math.min(Math.max(state.width, WORKSPACE_MIN_SIZE.width), largest.width) : state.width
  const height = largest.height
    ? Math.min(Math.max(state.height, WORKSPACE_MIN_SIZE.height), largest.height)
    : state.height
  const bounds = { width, height }
  if (
    isFiniteWindowNumber(state.x) &&
    isFiniteWindowNumber(state.y) &&
    workspaceBoundsOnAttachedDisplay({ ...bounds, x: state.x, y: state.y }, displays)
  ) {
    bounds.x = state.x
    bounds.y = state.y
  }
  return bounds
}

function persistWorkspaceWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
  try {
    const bounds = mainWindow.getNormalBounds?.() || mainWindow.getBounds()
    if (bounds.width < WORKSPACE_MIN_SIZE.width || bounds.height < WORKSPACE_MIN_SIZE.height) return
    fs.mkdirSync(path.dirname(WORKSPACE_WINDOW_STATE_PATH), { recursive: true })
    writeFileAtomic(
      WORKSPACE_WINDOW_STATE_PATH,
      JSON.stringify({ ...bounds, isMaximized: mainWindow.isMaximized() }, null, 2),
      'utf8'
    )
  } catch {
    // Geometry persistence is best-effort; a corrupt/missing state simply
    // falls back to the normal workspace default on the next launch.
  }
}

function debounceWindowStateWrite(fn, delayMs) {
  let timer = null
  const debounced = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn()
    }, delayMs)
  }
  debounced.flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    fn()
  }
  return debounced
}

const scheduleWorkspaceWindowStatePersist = debounceWindowStateWrite(persistWorkspaceWindowState, 250)
// Width Electron reserves for the Windows/Linux native min/max/close cluster
// when `titleBarOverlay` is enabled. The OS paints these buttons in the
// top-right corner of the renderer; we have to leave that much room on the
// right edge so our system tools (file browser, haptics, settings) don't sit
// underneath them. macOS uses left-side traffic lights instead and reports a
// position via getWindowButtonPosition(), so this width is non-zero only on
// non-macOS platforms.
// Width the renderer reserves top-right for the window buttons. On Windows /
// Linux these are now SELF-DRAWN in the renderer (the native overlay's hover
// highlight can't be styled), so this is the self-drawn cluster's footprint.
const NATIVE_OVERLAY_BUTTON_WIDTH = 128
const APP_ICON_PATHS = [
  path.join(APP_ROOT, 'public', 'apple-touch-icon.png'),
  path.join(APP_ROOT, 'dist', 'apple-touch-icon.png'),
  path.join(unpackedPathFor(APP_ROOT), 'dist', 'apple-touch-icon.png')
]

let rendererTitleBarTheme = null
const terminalSessions = new Map()

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

// Native window buttons float on a TRANSPARENT strip (the glass UI shows
// through — no opaque band over the panels). Kept at the compact logical
// titlebar height so the symbols stay small and high, clear of the panels
// (which add their own top inset below the strip).
const TITLEBAR_OVERLAY_EXTRA = 0

function getTitleBarOverlayOptions() {
  if (IS_MAC) {
    return { height: TITLEBAR_HEIGHT }
  }

  if (rendererTitleBarTheme) {
    return {
      color: '#00000000',
      height: TITLEBAR_HEIGHT + TITLEBAR_OVERLAY_EXTRA,
      symbolColor: rendererTitleBarTheme.foreground
    }
  }

  const useDarkColors = nativeTheme.shouldUseDarkColors

  return {
    color: '#00000000',
    height: TITLEBAR_HEIGHT + TITLEBAR_OVERLAY_EXTRA,
    symbolColor: useDarkColors ? '#f7f7f7' : '#242424'
  }
}

const MEDIA_MIME_TYPES = {
  '.avi': 'video/x-msvideo',
  '.bmp': 'image/bmp',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
}

const PREVIEW_HTML_EXTENSIONS = new Set(['.html', '.htm'])
const PREVIEW_WATCH_DEBOUNCE_MS = 120
const LOCAL_PREVIEW_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1', '[::1]', 'localhost'])
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024
const PREVIEW_LANGUAGE_BY_EXT = {
  '.c': 'c',
  '.conf': 'ini',
  '.cpp': 'cpp',
  '.css': 'css',
  '.csv': 'csv',
  '.go': 'go',
  '.graphql': 'graphql',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.kt': 'kotlin',
  '.lua': 'lua',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.sql': 'sql',
  '.svg': 'xml',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.txt': 'text',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'shell'
}

function looksBinary(buffer) {
  if (!buffer.length) return false

  let suspicious = 0

  for (const byte of buffer) {
    if (byte === 0) return true
    // Allow common whitespace controls: tab, LF, CR.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) suspicious += 1
  }

  return suspicious / buffer.length > 0.12
}

function previewFileMetadata(filePath, mimeType) {
  let byteSize = 0
  let binary = false

  try {
    const stat = fs.statSync(filePath)
    byteSize = stat.size

    if (!mimeType.startsWith('image/')) {
      const fd = fs.openSync(filePath, 'r')

      try {
        const sample = Buffer.alloc(Math.min(byteSize, 4096))
        const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0)
        binary = looksBinary(sample.subarray(0, bytesRead))
      } finally {
        fs.closeSync(fd)
      }
    }
  } catch {
    // Metadata is best-effort; the read handlers surface hard errors later.
  }

  return {
    binary,
    byteSize,
    large: byteSize > TEXT_PREVIEW_MAX_BYTES
  }
}

app.setName(APP_NAME)
// Windows toast notifications take their TITLE + ICON from the
// AppUserModelID, not from the Notification's icon param — without this they
// render as "Electron" + the Electron logo. Match build.appId so the
// packaged Start-Menu shortcut (electron-builder registers it under this
// AUMID) drives the Fan name + icon. Note: in unpackaged dev there's no
// registered shortcut, so Windows may still fall back to the generic
// identity; it lights up fully only in an installed build.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.xingfan.fan')
}
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  // Dev launches run from a rebranded Electron.app bundle, whose native
  // version is the Electron runtime (for example 43.2.0). Always override
  // both macOS About fields with Fan's canonical product version.
  applicationVersion: resolveFanVersion(),
  version: resolveFanVersion(),
  copyright: 'Copyright © 2025-2026 Xingfan Technology'
})

// Custom scheme for streaming local media (video/audio) into the renderer.
// Reading large media through `readFileDataUrl` failed: it base64-loads the
// whole file into memory and is hard-capped at DATA_URL_READ_MAX_BYTES (16 MB),
// so any non-trivial video silently refused to load. Streaming via a protocol
// handler removes the size cap and gives the <video> element seekable,
// range-aware playback. Must be registered before the app is ready.
const MEDIA_PROTOCOL = 'fan-media'
// Only audio/video may be streamed. Without this the handler would read any
// non-blocklisted local file (no size cap) for any `fetch(fan-media://…)`.
const STREAMABLE_MEDIA_EXTS = new Set([
  '.avi',
  '.flac',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.opus',
  '.wav',
  '.webm'
])

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: {
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true
    }
  }
])

function registerMediaProtocol() {
  protocol.handle(MEDIA_PROTOCOL, async request => {
    let realPath
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      // Use the realpath()-resolved target for the extension check + fetch so
      // the read hits the inode the sensitive-path blacklist validated, not a
      // symlink that could be re-pointed between validation and read (TOCTOU).
      ;({ realPath } = await resolveReadableFileForIpc(filePath, { purpose: 'Media stream' }))
    } catch {
      return new Response('Media not found', { status: 404 })
    }

    if (!STREAMABLE_MEDIA_EXTS.has(path.extname(realPath).toLowerCase())) {
      return new Response('Unsupported media type', { status: 415 })
    }

    // Delegate to Electron's net stack on a file:// URL — it resolves the
    // content-type and honors Range requests so seeking works. Forward the
    // renderer's headers (notably Range) and skip custom-protocol re-entry.
    return electronNet.fetch(pathToFileURL(realPath).toString(), {
      bypassCustomProtocolHandlers: true,
      headers: request.headers
    })
  })
}

let fanProcess = null
let connectionPromise = null
let isAppQuitting = false
// Native update installation closes windows before Electron's ordinary
// before-quit event. Mark that explicit exit at the earlier updater event so
// the cross-platform close-to-Tray policy cannot cancel quitAndInstall().
nativeAutoUpdater.on('before-quit-for-update', () => {
  isAppQuitting = true
})
const expectedFanProcessExits = new WeakSet()
// Auto-reload budget for renderer crashes. A deterministic startup crash would
// otherwise loop forever (reload → crash → reload), pinning CPU and spamming
// logs. Allow a few reloads per rolling window, then stop and leave the dead
// window so the user can read the error / quit.
const RENDERER_RELOAD_WINDOW_MS = 60_000
const RENDERER_RELOAD_MAX = 3
let rendererReloadTimes = []

// Per-tab crash-loop guard (mirrors the main-window reload limiter): viewId ->
// recent crash timestamps. A page that OOMs/crashes on load would otherwise be
// rebuilt forever — a CPU/memory storm that hangs the whole app.
const viewCrashTimes = new Map()

// Latched bootstrap failure: when the first-launch install fails, we hold
// onto the error so subsequent startFan() calls (e.g. the renderer's
// ensureGatewayOpen retrying after the WS won't open) return the same error
// instead of re-running install.ps1 in a hot loop. Cleared explicitly by
// the renderer's "Reload and retry" path or by quitting the app.
let bootstrapFailure = null
// Latch ordinary startup failures as well. Renderer reconnect attempts must
// not continuously respawn a backend whose executable/runtime is broken;
// explicit reset is the recovery boundary.
let backendStartFailure = null
// Active first-launch install, so the renderer's Cancel button (and app quit)
// can abort the in-flight install.sh/ps1 instead of leaving it running.
let bootstrapAbortController = null
const fanLog = []
const previewWatchers = new Map()
let previewShortcutActive = false
let desktopLogBuffer = ''
let desktopLogFlushTimer = null
let desktopLogFlushPromise = Promise.resolve()
let bootProgressState = {
  error: null,
  fakeMode: BOOT_FAKE_MODE,
  message: 'Waiting to start Fan backend',
  phase: 'idle',
  progress: 0,
  running: false,
  timestamp: Date.now()
}

function flushDesktopLogBufferSync() {
  if (!desktopLogBuffer) return
  const chunk = desktopLogBuffer
  desktopLogBuffer = ''

  try {
    appendRotatingFileSync(DESKTOP_LOG_PATH, chunk, {
      maxBytes: DESKTOP_LOG_MAX_BYTES,
      backups: DESKTOP_LOG_BACKUPS
    })
  } catch {
    // Logging must never block app startup/shutdown.
  }
}

function flushDesktopLogBufferAsync() {
  if (!desktopLogBuffer) return desktopLogFlushPromise
  const chunk = desktopLogBuffer
  desktopLogBuffer = ''

  desktopLogFlushPromise = desktopLogFlushPromise
    .then(async () => {
      await appendRotatingFile(DESKTOP_LOG_PATH, chunk, {
        maxBytes: DESKTOP_LOG_MAX_BYTES,
        backups: DESKTOP_LOG_BACKUPS
      })
    })
    .catch(() => {
      // Logging must never crash the desktop shell.
    })

  return desktopLogFlushPromise
}

function scheduleDesktopLogFlush() {
  if (desktopLogFlushTimer) return
  desktopLogFlushTimer = setTimeout(() => {
    desktopLogFlushTimer = null
    void flushDesktopLogBufferAsync()
  }, DESKTOP_LOG_FLUSH_MS)
}

function rememberLog(chunk) {
  const text = redactLocalLogText(String(chunk || ''), DESKTOP_LOG_BUFFER_MAX_CHARS * 4).trim()
  if (!text) return
  const lines = text.split(/\r?\n/).map(line => `[fan] ${line}`)
  fanLog.push(...lines)
  if (fanLog.length > 300) {
    fanLog.splice(0, fanLog.length - 300)
  }

  desktopLogBuffer += `${lines.join('\n')}\n`

  if (desktopLogBuffer.length >= DESKTOP_LOG_BUFFER_MAX_CHARS) {
    if (desktopLogFlushTimer) {
      clearTimeout(desktopLogFlushTimer)
      desktopLogFlushTimer = null
    }
    void flushDesktopLogBufferAsync()

    return
  }

  scheduleDesktopLogFlush()
}

function openExternalUrl(rawUrl) {
  const raw = String(rawUrl || '').trim()
  if (!raw) return false

  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }

  // `file://` URLs come from the artifacts panel (the renderer can't open
  // them itself because Chromium blocks file:// navigation from the app
  // origin). Hand them to `shell.openPath`, which dispatches to the OS
  // file association. If the OS can't open it (`error` is a non-empty
  // string), fall back to revealing the file in the system file manager.
  if (parsed.protocol === 'file:') {
    let localPath
    try {
      // Hardened: rejects Windows device paths (\\?\, \GlobalRoot\Device\…) +
      // null bytes before handing the path to the OS.
      localPath = resolveRequestedPathForIpc(parsed.toString(), { purpose: 'Open file' })
    } catch {
      return false
    }

    void shell
      .openPath(localPath)
      .then(error => {
        if (!error) {
          return
        }

        rememberLog(`[file] openPath failed: ${error}; revealing in folder instead`)

        try {
          shell.showItemInFolder(localPath)
        } catch (revealError) {
          rememberLog(`[file] showItemInFolder failed: ${revealError.message}`)
        }
      })
      .catch(error => rememberLog(`[file] openPath rejected: ${error.message}`))

    return true
  }

  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    return false
  }

  const url = parsed.toString()

  if (IS_WSL) {
    rememberLog(`[link] opening via WSL→Windows: ${url}`)
    const proc = spawn('cmd.exe', ['/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    proc.on('error', error => {
      rememberLog(`[link] cmd.exe start failed: ${error.message}; falling back to xdg-open`)
      shell.openExternal(url).catch(fallback => rememberLog(`[link] xdg-open failed: ${fallback.message}`))
    })
    proc.unref()

    return true
  }

  shell.openExternal(url).catch(error => rememberLog(`[link] openExternal failed: ${error.message}`))

  return true
}

function ensureWslWindowsFonts() {
  if (!IS_WSL) return

  const fontsDir = ['/mnt/c/Windows/Fonts', '/mnt/c/windows/fonts'].find(candidate => {
    try {
      return fs.statSync(candidate).isDirectory()
    } catch {
      return false
    }
  })
  if (!fontsDir) return

  try {
    const confDir = path.join(app.getPath('home'), '.config', 'fontconfig', 'conf.d')
    const confPath = path.join(confDir, '99-fan-wsl-windows-fonts.conf')
    let existing = ''
    try {
      existing = fs.readFileSync(confPath, 'utf8')
    } catch {
      existing = ''
    }
    if (existing.includes(fontsDir)) return

    fs.mkdirSync(confDir, { recursive: true })
    fs.writeFileSync(
      confPath,
      `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${fontsDir}</dir>\n</fontconfig>\n`
    )
    rememberLog(`[fonts] wired WSL Windows fonts for renderer: ${fontsDir}`)

    const cache = spawn('fc-cache', ['-f', fontsDir], { detached: true, stdio: 'ignore' })
    cache.on('error', () => undefined)
    cache.unref()
  } catch (error) {
    rememberLog(`[fonts] WSL font setup skipped: ${error.message}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function clampBootProgress(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function broadcastBootProgress() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:boot-progress', bootProgressState)
}

// The bootstrap snapshot is queryable through fan:bootstrap:get so a renderer
// reload can recover the most recent installation state.
let bootstrapState = {
  active: false,
  manifest: null,
  stages: {},
  error: null,
  log: [],
  startedAt: null,
  completedAt: null,
  unsupportedPlatform: null
}

function getBootstrapState() {
  return bootstrapState
}

function updateBootProgress(update, options = {}) {
  const nextProgressRaw =
    typeof update.progress === 'number' ? clampBootProgress(update.progress) : bootProgressState.progress
  const nextProgress = options.allowDecrease ? nextProgressRaw : Math.max(bootProgressState.progress, nextProgressRaw)

  bootProgressState = {
    ...bootProgressState,
    ...update,
    error: update.error === undefined ? bootProgressState.error : update.error,
    fakeMode: BOOT_FAKE_MODE || Boolean(update.fakeMode),
    progress: nextProgress,
    timestamp: Date.now()
  }

  if (update.message) {
    rememberLog(`[boot] ${update.message}`)
  }

  broadcastBootProgress()
}

async function advanceBootProgress(phase, message, progress) {
  updateBootProgress({
    phase,
    message,
    progress,
    running: true,
    error: null
  })

  if (BOOT_FAKE_MODE) {
    await sleep(BOOT_FAKE_STEP_MS)
  }
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function directoryExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function unpackedPathFor(filePath) {
  return filePath.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked')
}

function findOnPath(command) {
  if (!command) return null

  if (path.isAbsolute(command) || command.includes(path.sep) || (IS_WINDOWS && command.includes('/'))) {
    if (!fileExists(command)) return null
    if (isWindowsBinaryPathInWsl(command, { isWsl: IS_WSL })) return null
    return command
  }

  const pathEntries = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  const extensions = IS_WINDOWS
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : ['']

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`)
      if (fileExists(candidate)) return candidate
    }
  }

  return null
}

function isFanSourceRoot(root) {
  return directoryExists(root) && fileExists(path.join(root, 'fan_cli', 'main.py'))
}

function findPythonForRoot(root) {
  const override = process.env.FAN_DESKTOP_PYTHON
  if (override && fileExists(override)) return override

  const relativePaths = IS_WINDOWS
    ? [path.join('.venv', 'Scripts', 'python.exe'), path.join('venv', 'Scripts', 'python.exe')]
    : [path.join('.venv', 'bin', 'python'), path.join('venv', 'bin', 'python')]

  for (const relativePath of relativePaths) {
    const candidate = path.join(root, relativePath)
    if (fileExists(candidate)) return candidate
  }

  return findSystemPython()
}

function findSystemPython() {
  if (!IS_WINDOWS) {
    // POSIX systems: PATH lookup is safe.
    for (const command of ['python3', 'python']) {
      const candidate = findOnPath(command)
      if (candidate) return candidate
    }
    return null
  }

  // Windows: PATH-based detection has TWO landmines we have to dodge.
  //
  //  (1) The Microsoft Store "Python stub" lives at
  //      %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe and is on PATH
  //      by default on modern Windows. It's a redirector that opens the
  //      Store window if no Store Python is installed. Running it for
  //      `-m venv` would either succeed (real Store install — fine) or
  //      pop the Store dialog (bad UX during boot).
  //  (2) `py.exe` (Python launcher) is missing from per-user installs
  //      that didn't check the launcher option, so PATH-only checks
  //      miss real Python 3.13 installs (user-reported case).
  //
  // We also restrict ourselves to Python 3.11–3.13. 3.14 is the latest
  // CPython but several Fan deps (notably pywinpty's Rust-built
  // windows_x86_64_msvc crate) don't yet publish 3.14 wheels, and
  // `pip install -e .` falls back to source-build, which fails without
  // a Rust toolchain. install.ps1 sidesteps this by pinning to 3.11
  // via uv; until we add the same uv-managed Python pathway here, the
  // simplest fix is to refuse 3.14 detection and let the NSIS prereq
  // page offer to install 3.11 alongside.
  //
  // Strategy: probe in three passes, in order from most-precise to
  // least-precise, and ONLY use PATH lookup as a last resort after
  // confirming the candidate isn't the WindowsApps redirector.
  //
  //  Pass 1: PEP 514 registry — every standards-compliant Python
  //          installer registers itself at SOFTWARE\Python\PythonCore.
  //          The MS Store stub does NOT register here, so a hit means
  //          a real Python install. Versions are explicit so we
  //          inherently filter 3.14 out.
  //  Pass 2: Filesystem probe of standard install locations
  //          (Program Files, LocalAppData\Programs\Python). Same
  //          version filtering by directory name.
  //  Pass 3: PATH lookup of `py.exe` (the launcher itself never
  //          triggers the Store) — but call it with a version flag so
  //          we resolve to a SPECIFIC supported version, not whatever
  //          py.exe's default is (which on a 3.14-only box would be
  //          3.14).

  const SUPPORTED_VERSIONS = ['3.11', '3.12', '3.13']
  const SUPPORTED_VERSIONS_NO_DOT = ['311', '312', '313']

  // Pass 1: registry. Use `reg query` since main process doesn't have
  // a reliable in-process registry API across all electron versions.
  for (const hive of ['HKLM', 'HKCU']) {
    for (const version of SUPPORTED_VERSIONS) {
      try {
        const out = execFileSync(
          'reg',
          ['query', `${hive}\\SOFTWARE\\Python\\PythonCore\\${version}\\InstallPath`, '/ve', '/reg:64'],
          hiddenWindowsChildOptions({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        )
        // Output format: "    (Default)    REG_SZ    C:\Path\To\Python\"
        const match = out.match(/REG_SZ\s+(.+?)\s*$/m)
        if (match) {
          const installPath = match[1].trim()
          const pythonExe = path.join(installPath, 'python.exe')
          if (fileExists(pythonExe)) return pythonExe
        }
      } catch {
        // Key not present — try next.
      }
    }
  }

  // Pass 2: filesystem probe of standard locations.
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA || ''
  for (const versionDir of SUPPORTED_VERSIONS_NO_DOT) {
    const systemWide = path.join(programFiles, `Python${versionDir}`, 'python.exe')
    if (fileExists(systemWide)) return systemWide
    if (localAppData) {
      const perUser = path.join(localAppData, 'Programs', 'Python', `Python${versionDir}`, 'python.exe')
      if (fileExists(perUser)) return perUser
    }
  }

  // Pass 3: py.exe with explicit version flag. The launcher itself is
  // safe to invoke (no Store popup) and `py -3.13 -c "import sys;
  // print(sys.executable)"` resolves to the actual python.exe path of
  // the requested version. We try in version-priority order so the
  // first hit wins.
  const pyExe = findOnPath('py.exe')
  if (pyExe) {
    for (const version of SUPPORTED_VERSIONS) {
      try {
        const out = execFileSync(
          pyExe,
          [`-${version}`, '-c', 'import sys; print(sys.executable)'],
          hiddenWindowsChildOptions({
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          })
        )
        const candidate = out.trim()
        if (candidate && fileExists(candidate)) return candidate
      } catch {
        // py couldn't find that version — try next.
      }
    }
  }

  // We deliberately do NOT fall back to plain `python.exe` on PATH.
  // Without a way to verify the version safely (running `python -V`
  // risks the Microsoft Store popup), accepting whatever's there
  // could land us on 3.14 and trigger the Rust-build-from-source
  // failure. Better to return null and let the NSIS prereq page
  // offer to install a known-good 3.11 via winget.
  return null
}

function recentFanLog() {
  return fanLog.slice(-20).join('\n')
}

// ─── Self-update ─────────────────────────────────────────────────────
// Packaged builds may opt into electron-updater by providing app-update.yml.
// Source builds and packages without an explicitly configured public feed do
// not perform an update-network request.

// Atomic file write: temp + rename (atomic on all platforms). Prevents
// partial writes on crash/power loss that corrupt JSON config files.
function writeFileAtomic(targetPath, data, encoding) {
  const tmp = targetPath + '.tmp'
  fs.writeFileSync(tmp, data, encoding)
  fs.renameSync(tmp, targetPath)
}

const OFFICIAL_SITE_URL = 'https://fandcode.com'

function emitUpdateProgress(payload) {
  const merged = { stage: 'idle', message: '', percent: null, error: null, ...payload, at: Date.now() }
  rememberLog(`[updates] ${merged.stage}: ${merged.message || merged.error || ''}`)
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('fan:updates:progress', merged)
  }
}

let _autoUpdater = null
function getAutoUpdater() {
  if (!IS_PACKAGED) return null
  if (!fileExists(path.join(process.resourcesPath, 'app-update.yml'))) return null
  if (_autoUpdater) return _autoUpdater
  try {
    // Dev/workspace builds resolve the hoisted package; packaged builds carry
    // no node_modules in the asar, so fall back to the esbuild-bundled copy
    // staged by scripts/stage-native-deps.cjs (same rung pattern as node-pty).
    let updaterModule
    try {
      updaterModule = require('electron-updater')
    } catch {
      updaterModule = require(path.join(process.resourcesPath, 'native-deps', 'electron-updater', 'index.cjs'))
    }
    const { autoUpdater } = updaterModule
    autoUpdater.autoDownload = false
    // Install is user-driven from the updates dialog; a silent install-on-quit
    // mid-session would surprise people with unsaved browser state.
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.logger = {
      debug: () => {},
      error: message => rememberLog(`[updates] ${message}`),
      info: message => rememberLog(`[updates] ${message}`),
      warn: message => rememberLog(`[updates] ${message}`)
    }
    autoUpdater.on('download-progress', progress => {
      const percent = Math.round(progress?.percent || 0)
      emitUpdateProgress({ stage: 'fetch', message: `正在下载更新… ${percent}%`, percent })
    })
    _autoUpdater = autoUpdater
  } catch (error) {
    rememberLog(`[updates] electron-updater unavailable: ${error.message}`)
  }
  return _autoUpdater
}

async function checkUpdates() {
  if (!IS_PACKAGED) {
    return {
      supported: false,
      reason: 'dev-build',
      message: '开发构建不使用应用内更新——直接更新源码检出即可。',
      fetchedAt: Date.now()
    }
  }

  const updater = getAutoUpdater()
  if (!updater) {
    return {
      supported: false,
      reason: 'update-source-not-configured',
      message: '当前构建未配置公开更新源。',
      fetchedAt: Date.now()
    }
  }

  const result = await updater.checkForUpdates()
  const info = result?.updateInfo
  const currentVersion = app.getVersion()
  const available = Boolean(result?.isUpdateAvailable ?? (info?.version && info.version !== currentVersion))

  return {
    supported: true,
    behind: available ? 1 : 0,
    currentVersion,
    targetVersion: info?.version,
    // Legacy gate: the renderer's update toast fires on a truthy targetSha.
    targetSha: available ? info?.version : undefined,
    releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
    releaseDate: info?.releaseDate,
    commits: [],
    fetchedAt: Date.now()
  }
}

let updateInFlight = false

// applyUpdates — download + install through electron-updater.
// Windows (NSIS): full in-place flow — download with progress, then
// quitAndInstall. macOS uses the manual installer branch below.
async function applyUpdates() {
  if (updateInFlight) {
    throw new Error('已有更新正在进行。')
  }

  const updater = getAutoUpdater()
  if (!IS_PACKAGED || !updater) {
    const message = IS_PACKAGED ? '当前构建未配置公开更新源。' : '开发构建不使用应用内更新。'
    emitUpdateProgress({ stage: 'manual', message, percent: null })
    return { ok: true, manual: true, command: message }
  }

  updateInFlight = true
  try {
    emitUpdateProgress({ stage: 'prepare', message: '正在获取最新版本信息…', percent: 0 })
    const result = await updater.checkForUpdates()
    const info = result?.updateInfo
    const available = Boolean(result?.isUpdateAvailable ?? (info?.version && info.version !== app.getVersion()))

    if (!available || !info) {
      emitUpdateProgress({ stage: 'error', error: 'no-update', message: '当前已是最新版本。' })
      return { ok: false, error: 'no-update', message: '当前已是最新版本。' }
    }

    if (IS_MAC) {
      const dmg = (info.files || []).map(file => String(file.url || '')).find(url => url.toLowerCase().endsWith('.dmg'))
      const feed = String(updater.getFeedURL?.() || '').replace(/\/+$/, '')
      const url = dmg && feed ? `${feed}/${dmg}` : `${OFFICIAL_SITE_URL}/#download`
      await shell.openExternal(url)
      emitUpdateProgress({ stage: 'manual', message: url, percent: null })
      rememberLog(`[updates] macOS manual update; opened ${url} for v${info.version}`)
      return { ok: true, manual: true, command: url }
    }

    await updater.downloadUpdate()
    emitUpdateProgress({ stage: 'restart', message: '正在安装新版本并重启…', percent: 100 })
    setTimeout(() => updater.quitAndInstall(false, true), 400)
    return { ok: true, handedOff: true }
  } catch (error) {
    const message = error?.message || String(error)
    emitUpdateProgress({ stage: 'error', error: 'apply-failed', message })
    return { ok: false, error: 'apply-failed', message }
  } finally {
    updateInFlight = false
  }
}

// Backend root for display/diagnostics (About panel, fan:version). Dev → the
// source checkout; packaged → the bundled fan-src shipped in resources.
function resolveDisplayRoot() {
  const overrideRoot = process.env.FAN_DESKTOP_FAN_ROOT && path.resolve(process.env.FAN_DESKTOP_FAN_ROOT)
  if (overrideRoot && isFanSourceRoot(overrideRoot)) return overrideRoot
  if (IS_PACKAGED && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'fan-src')
    if (isFanSourceRoot(bundled)) return bundled
  }
  if (isFanSourceRoot(SOURCE_REPO_ROOT)) return SOURCE_REPO_ROOT
  return isFanSourceRoot(ACTIVE_FAN_ROOT) ? ACTIVE_FAN_ROOT : SOURCE_REPO_ROOT
}

// The first-launch bootstrap (git-clone installer + completion marker) is gone.
// Packaged releases carry their backend in resources (rung 1b).

function resolveWebDist() {
  const override = process.env.FAN_DESKTOP_WEB_DIST
  if (override && directoryExists(path.resolve(override))) return path.resolve(override)

  const unpackedDist = path.join(unpackedPathFor(APP_ROOT), 'dist')
  if (directoryExists(unpackedDist)) return unpackedDist

  // Final fallback: APP_ROOT/dist. When packaged with asar:true this lives
  // INSIDE app.asar — not a servable filesystem directory — so the embedded
  // dashboard backend 404s on static routes. If we still land here while
  // packaged, log it so the cause isn't silent.
  const fallback = path.join(APP_ROOT, 'dist')
  if (IS_PACKAGED && /app\.asar(?=$|[\\/])/.test(fallback) && !directoryExists(fallback)) {
    rememberLog(
      `[web-dist] dashboard frontend dir resolved to an asar-internal path that ` +
        `is not a real directory: ${fallback}. Static routes will 404. ` +
        `Ensure dist/** is unpacked (asarUnpack) or set FAN_DESKTOP_WEB_DIST.`
    )
  }
  return fallback
}

function resolveRendererIndex() {
  const candidates = [path.join(APP_ROOT, 'dist', 'index.html'), path.join(resolveWebDist(), 'index.html')]
  const found = candidates.find(fileExists)
  if (found) return found
  // Nothing on disk. A packaged build with no renderer bundle blank-pages with
  // a bare ERR_FILE_NOT_FOUND and no clue why. Surface the cause + the fix
  // before Electron loads the missing file.
  rememberLog(
    `[renderer] index.html not found — the desktop app was packaged without a ` +
      `renderer bundle. Tried: ${candidates.join(', ')}. ` +
      `Rebuild with: fan desktop --force-build`
  )
  return candidates[0]
}

// True when `dir` sits inside the packaged app install (APP_ROOT or the exe
// dir) — a new session must never be seeded there.
// minimal: skips the removable-app-path edge case.)
function isPackagedInstallPath(dir) {
  if (!IS_PACKAGED) {
    return false
  }
  try {
    const resolved = path.resolve(dir)
    return [APP_ROOT, path.dirname(process.execPath)].some(root => {
      const r = path.resolve(root)
      return resolved === r || resolved.startsWith(r + path.sep)
    })
  } catch {
    return false
  }
}

// Validate a requested workspace cwd: reject empty / packaged-install-dir /
// non-existent paths, falling back to the resolved default. Returns
// { cwd, sanitized } so the renderer can seed a safe cwd.
function sanitizeWorkspaceCwd(cwd) {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : ''

  if (!trimmed || isPackagedInstallPath(trimmed)) {
    return { cwd: resolveFanCwd(), sanitized: Boolean(trimmed) }
  }

  try {
    const resolved = path.resolve(trimmed)
    if (directoryExists(resolved)) {
      return { cwd: resolved, sanitized: false }
    }
  } catch {
    // Fall through to the resolved default.
  }

  return { cwd: resolveFanCwd(), sanitized: Boolean(trimmed) }
}

function resolveFanCwd() {
  // In a packaged build, `process.cwd()` resolves to the install root (e.g.
  // `…/win-unpacked` on Windows or `/Applications/Fan.app/Contents/...`
  // on macOS). Sessions spawned there leave files inside the app bundle
  // and bewilder users when "where did my files go?" is the install dir.
  // The user-configurable default project directory wins over everything,
  // followed by env hints (only honored when packaged if they point at a
  // real directory), then the home dir.
  const candidates = [
    readDefaultProjectDir(),
    process.env.FAN_DESKTOP_CWD,
    process.env.INIT_CWD,
    IS_PACKAGED ? null : process.cwd(),
    !IS_PACKAGED ? SOURCE_REPO_ROOT : null,
    app.getPath('home')
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.resolve(String(candidate))
    if (directoryExists(resolved)) return resolved
  }

  return app.getPath('home')
}

// Persisted "Default project directory" — surfaced as a setting in the
// renderer (see app/settings/sessions-settings.tsx). Stored as JSON in
// userData so it survives self-updates without bleeding into the new
// install. `null` means "no preference, fall back to the usual chain".
const DEFAULT_PROJECT_DIR_CONFIG_FILENAME = 'project-dir.json'

function defaultProjectDirConfigPath() {
  return path.join(app.getPath('userData'), DEFAULT_PROJECT_DIR_CONFIG_FILENAME)
}

function readDefaultProjectDir() {
  try {
    const raw = fs.readFileSync(defaultProjectDirConfigPath(), 'utf8')
    const parsed = JSON.parse(raw)

    if (parsed && typeof parsed.dir === 'string' && parsed.dir.trim()) {
      const resolved = path.resolve(parsed.dir)

      if (directoryExists(resolved)) {
        return resolved
      }
    }
  } catch {
    // Missing / unreadable / malformed → fall through to the rest of the
    // candidate chain.
  }

  return null
}

function writeDefaultProjectDir(dir) {
  const target = defaultProjectDirConfigPath()
  const payload = dir ? JSON.stringify({ dir: path.resolve(dir) }, null, 2) : JSON.stringify({}, null, 2)

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, payload, 'utf8')
  } catch (error) {
    rememberLog(`[settings] write default project dir failed: ${error.message}`)
  }
}

function createPythonBackend(root, label, dashboardArgs, options = {}) {
  const python = findPythonForRoot(root)
  if (!python) return null
  const env = {
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    // Preserve an explicit runtime identity for diagnostics and child
    // processes even though end-user source/PyPI self-update is retired.
    FAN_INSTALL_METHOD: 'dev'
  }
  if (
    !canStartFanBackend(python, {
      env,
      onFailure: detail =>
        rememberLog(
          `${label} import probe ${detail.timedOut ? 'timed out (proceeding)' : 'failed'}: ${detail.stderr || detail.message}`
        )
    })
  ) {
    rememberLog(`Ignoring ${label}: backend import probe failed for ${python}`)
    return null
  }

  return {
    kind: 'python',
    label,
    command: python,
    args: ['-P', '-m', 'fan_cli.main', ...dashboardArgs],
    env,
    root,
    bootstrap: Boolean(options.bootstrap),
    shell: false
  }
}

// createBundledBackend — a packaged release ships its OWN relocatable Python
// venv + pruned source under resourcesPath (electron-builder extraResources:
// `python/` = the venv, `fan-src/` = the repo; built by
// scripts/build-python-backend.mjs). A packaged release must never git-clone,
// hit PATH, or borrow a system Python. The interpreter is spawned DIRECTLY
// with PYTHONPATH at the bundled source — never via the venv shebang (which
// bakes the CI machine's absolute path). Returns null when the resources are
// absent (every dev build), so resolveFanBackend falls through transparently.
function createBundledBackend(dashboardArgs) {
  if (!process.resourcesPath) return null

  const pyRoot = path.join(process.resourcesPath, 'python')
  const srcRoot = path.join(process.resourcesPath, 'fan-src')
  // Full python-build-standalone layout (NOT a venv — see the build script):
  // POSIX <root>/bin/python3.11|python3, Windows <root>/python.exe.
  const python = IS_WINDOWS
    ? path.join(pyRoot, 'python.exe')
    : [path.join(pyRoot, 'bin', 'python3.11'), path.join(pyRoot, 'bin', 'python3')].find(fileExists)

  if (!python || !fileExists(python) || !isFanSourceRoot(srcRoot)) {
    return null
  }

  // Besides identifying the install method, this seals the bundled
  // Python/source tree against automatic .pyc and lazy-package writes. User
  // data and selected workspaces remain writable through FAN_HOME/fanCwd.
  const env = createPackagedBackendEnv(srcRoot, process.env.PYTHONPATH, path.delimiter)

  if (
    !canStartFanBackend(python, {
      allowTimeoutPass: true,
      env,
      onFailure: detail =>
        rememberLog(
          `bundled backend import probe ${detail.timedOut ? 'timed out (proceeding)' : 'failed'}: ${detail.stderr || detail.message}`
        )
    })
  ) {
    rememberLog(`Ignoring bundled backend: import probe failed for ${python}`)
    return null
  }

  return {
    kind: 'python',
    label: 'bundled Fan backend',
    command: python,
    args: ['-P', '-m', 'fan_cli.main', ...dashboardArgs],
    env,
    root: srcRoot,
    bootstrap: false,
    shell: false
  }
}

function resolveFanBackend(dashboardArgs) {
  // 1. Explicit override -- FAN_DESKTOP_FAN_ROOT points at a developer
  //    checkout. Honour it as-is (no bootstrap; the user is driving). Wins
  //    even over the bundled backend so a packaged app can be debugged
  //    against local Python source.
  const overrideRoot = process.env.FAN_DESKTOP_FAN_ROOT && path.resolve(process.env.FAN_DESKTOP_FAN_ROOT)
  if (overrideRoot && isFanSourceRoot(overrideRoot)) {
    const backend = createPythonBackend(overrideRoot, `Fan source at ${overrideRoot}`, dashboardArgs)
    if (backend) return backend
  }

  // 1b. Bundled backend -- a packaged release carries its own venv + source
  //     (createBundledBackend). Beats ACTIVE/PATH/system so a release is fully
  //     self-contained; absent in dev builds → falls through.
  const bundled = createBundledBackend(dashboardArgs)
  if (bundled) return bundled

  // 2. Development source -- when running `npm run dev` from a checkout, the
  //    cloned repo at SOURCE_REPO_ROOT takes precedence over ACTIVE and any
  //    installed `fan` on PATH so local Python edits are actually exercised.
  //    (In dev with no checkout, SOURCE_REPO_ROOT won't pass isFanSourceRoot.)
  if (!IS_PACKAGED && isFanSourceRoot(SOURCE_REPO_ROOT)) {
    const backend = createPythonBackend(SOURCE_REPO_ROOT, `Fan source at ${SOURCE_REPO_ROOT}`, dashboardArgs)
    if (backend) return backend
  }

  // 3. Nothing usable. A packaged release ALWAYS carries the bundled backend
  //    (rung 1b) and dev runs resolve via the override/source rungs above, so
  //    reaching here means a broken install (bundle missing/corrupt) or an
  //    unpinned dev shell. Runtime network bootstrap is intentionally not
  //    supported, so this terminal sentinel is surfaced as a reinstall or
  //    development-setup prompt rather than a recoverable install flow.
  return {
    kind: 'backend-missing',
    label: 'Fan backend not found',
    command: null,
    args: dashboardArgs,
    bootstrap: false,
    env: {},
    shell: false,
    isPackaged: IS_PACKAGED,
    platform: process.platform
  }
}

async function ensureRuntime(backend) {
  // 'backend-missing' is terminal: packaged apps carry their backend in
  // resources, while development shells pin one via FAN_DESKTOP_FAN_ROOT.
  if (backend.kind === 'backend-missing') {
    const missingError = new Error(
      IS_PACKAGED
        ? 'Fan 后端资源缺失或已损坏（安装包不完整）。请从 https://fandcode.com 重新下载并安装 Fan。'
        : '未找到 Fan 后端。开发模式请设置 FAN_DESKTOP_FAN_ROOT 指向源码检出（或在仓库内运行 npm run dev）后重启。'
    )
    missingError.isBootstrapFailure = true
    bootstrapFailure = missingError
    throw missingError
  }

  await advanceBootProgress('runtime.external', `Using ${backend.label}`, 32)
  return backend
}

function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function pickPort() {
  for (let port = PORT_FLOOR; port <= PORT_CEILING; port += 1) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No free localhost port in ${PORT_FLOOR}-${PORT_CEILING}`)
}

function fetchJson(url, token, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
    const parsed = new URL(url)
    const method = String(options.method || 'GET').toUpperCase()
    const client = parsed.protocol === 'https:' ? https : http
    const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`Unsupported Fan backend URL protocol: ${parsed.protocol}`))
      return
    }

    const req = client.request(
      parsed,
      {
        method,
        headers: {
          ...(options.headers || {}),
          'Content-Type': 'application/json',
          'X-Fan-Session-Token': token,
          ...(body ? { 'Content-Length': String(body.length) } : {})
        }
      },
      res => {
        const chunks = []
        res.on('error', reject)
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode || 500) >= 400) {
            const error = new Error(`${res.statusCode}: ${text || res.statusMessage}`)
            error.statusCode = res.statusCode || 500
            reject(error)
            return
          }
          if (!text) {
            resolve(null)
            return
          }
          // A 2xx response whose body is HTML means the request fell through
          // to the SPA index.html (e.g. an unregistered /api path). JSON.parse
          // would throw an opaque `Unexpected token '<'` here, so surface a
          // clear diagnostic with the offending URL instead.
          const looksHtml = /^\s*<(?:!doctype|html)/i.test(text)
          const contentType = String(res.headers['content-type'] || '')
          if (looksHtml || contentType.includes('text/html')) {
            reject(
              new Error(
                `Expected JSON from ${url} but got HTML (status ${res.statusCode}). ` +
                  'The endpoint is likely missing on the Fan backend.'
              )
            )
            return
          }
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`Invalid JSON from ${url} (status ${res.statusCode}): ${text.slice(0, 200)}`))
          }
        })
      }
    )

    req.on('error', reject)
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out connecting to Fan backend after ${timeoutMs}ms`))
    })
    if (body) req.write(body)
    req.end()
  })
}

function mimeTypeForPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase()

  return MEDIA_MIME_TYPES[ext] || 'application/octet-stream'
}

function extensionForMimeType(mimeType) {
  const type = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (type === 'image/png') return '.png'
  if (type === 'image/jpeg') return '.jpg'
  if (type === 'image/gif') return '.gif'
  if (type === 'image/webp') return '.webp'
  if (type === 'image/bmp') return '.bmp'
  if (type === 'image/svg+xml') return '.svg'
  return ''
}

function filenameFromUrl(rawUrl, fallback = 'image') {
  try {
    const parsed = new URL(rawUrl)
    const base = path.basename(decodeURIComponent(parsed.pathname || ''))
    return base && base.includes('.') ? base : fallback
  } catch {
    return fallback
  }
}

// Link title resolution — curl (tier 1) → hidden BrowserWindow (tier 2).
const titleCache = new Map()
const titleInflight = new Map()
const TITLE_CACHE_LIMIT = 500
const TITLE_BYTE_BUDGET = 96 * 1024
const TITLE_TIMEOUT_MS = 5000
const TITLE_MAX_REDIRECTS = 3
// Browser-shaped UA — many bot-walled sites (GetYourGuide, Cloudflare-protected
// pages) refuse anything that doesn't look like a real Chrome.
const TITLE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const TITLE_ERROR_RE =
  /\b(access denied|attention required|captcha|error|forbidden|just a moment|request blocked|too many requests)\b/i
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

// Tier-2 renderer fallback config. Only invoked when curl came back empty or
// matched TITLE_ERROR_RE — keeps cold/CDN-cached pages on the cheap path.
const RENDER_TITLE_MAX_CONCURRENT = 2
const RENDER_TITLE_TIMEOUT_MS = 8000
const RENDER_TITLE_GRACE_MS = 700
// Resource types we cancel before the network even fires — keeps the hidden
// renderer fast and cuts third-party tracking noise.
const RENDER_TITLE_BLOCKED_RESOURCES = new Set([
  'cspReport',
  'font',
  'imageset',
  'media',
  'object',
  'ping',
  'stylesheet'
])

let linkTitleSession = null
let renderTitleInFlight = 0
const renderTitleQueue = []

function canonicalTitleCacheKey(rawUrl) {
  const value = String(rawUrl || '').trim()
  if (!value) return ''

  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^www\./i, '').toLowerCase()
    const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '') || '/'

    return `${host}${pathname}${url.search || ''}`
  } catch {
    return value
  }
}

function cacheTitle(key, title) {
  if (titleCache.size >= TITLE_CACHE_LIMIT) titleCache.delete(titleCache.keys().next().value)
  titleCache.set(key, title)
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (_, k) => HTML_ENTITIES[k.toLowerCase()] ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16) || 32))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10) || 32))
}

function parseHtmlTitle(html) {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  return raw ? decodeHtmlEntities(raw).replace(/\s+/g, ' ').trim() : ''
}

function fetchHtmlTitleWithCurl(rawUrl) {
  return new Promise(resolve => {
    const url = String(rawUrl || '').trim()
    if (!url) return resolve('')

    const args = [
      '--silent',
      '--show-error',
      '--location',
      '--max-redirs',
      String(TITLE_MAX_REDIRECTS),
      '--max-time',
      String(Math.max(2, Math.ceil(TITLE_TIMEOUT_MS / 1000))),
      '--connect-timeout',
      '4',
      '--user-agent',
      TITLE_USER_AGENT,
      '--header',
      'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      '--header',
      'Accept-Language: en-US,en;q=0.7',
      '--header',
      'Accept-Encoding: identity',
      '--raw',
      url
    ]
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    let bytes = 0

    child.stdout.on('data', chunk => {
      if (bytes >= TITLE_BYTE_BUDGET) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remaining = TITLE_BYTE_BUDGET - bytes
      const next = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer
      chunks.push(next)
      bytes += next.length
    })

    child.on('error', () => resolve(''))
    child.on('close', () => {
      if (!chunks.length) return resolve('')
      resolve(parseHtmlTitle(Buffer.concat(chunks).toString('utf8')))
    })
  })
}

function getLinkTitleSession() {
  if (linkTitleSession || !app.isReady()) return linkTitleSession
  linkTitleSession = session.fromPartition('fan:link-titles', { cache: false })
  linkTitleSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: RENDER_TITLE_BLOCKED_RESOURCES.has(details.resourceType) })
  })
  return linkTitleSession
}

function dequeueRenderTitle() {
  while (renderTitleInFlight < RENDER_TITLE_MAX_CONCURRENT && renderTitleQueue.length) {
    const item = renderTitleQueue.shift()
    renderTitleInFlight += 1
    runRenderTitleJob(item.url).then(title => {
      renderTitleInFlight -= 1
      item.resolve(title)
      dequeueRenderTitle()
    })
  }
}

function runRenderTitleJob(rawUrl) {
  return new Promise(resolve => {
    if (!app.isReady()) return resolve('')

    const partitionSession = getLinkTitleSession()
    if (!partitionSession) return resolve('')

    let settled = false
    let window = null
    let hardTimer = null
    let graceTimer = null

    const finish = title => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      if (graceTimer) clearTimeout(graceTimer)
      const value = (title || '').replace(/\s+/g, ' ').trim()
      try {
        if (window && !window.isDestroyed()) window.destroy()
      } catch {
        // BrowserWindow may already be torn down; ignore.
      }
      resolve(value)
    }

    try {
      window = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: {
          contextIsolation: true,
          javascript: true,
          nodeIntegration: false,
          sandbox: true,
          session: partitionSession,
          webSecurity: true
        }
      })
      // This hidden fallback window loads arbitrary user-linked pages only to
      // read their title. Media pages can autoplay before the title is read,
      // so silence the offscreen renderer immediately.
      try {
        window.webContents.setAudioMuted(true)
      } catch {
        // Best-effort in degraded/headless environments; the short-lived
        // window is still destroyed by finish().
      }
    } catch {
      return finish('')
    }

    const readTitle = () => window?.webContents?.getTitle?.() || ''
    const scheduleGrace = () => {
      if (graceTimer) clearTimeout(graceTimer)
      graceTimer = setTimeout(() => finish(readTitle()), RENDER_TITLE_GRACE_MS)
    }

    hardTimer = setTimeout(() => finish(readTitle()), RENDER_TITLE_TIMEOUT_MS)

    window.webContents.setUserAgent(TITLE_USER_AGENT)
    window.webContents.on('page-title-updated', scheduleGrace)
    window.webContents.on('did-finish-load', scheduleGrace)
    window.webContents.on('did-fail-load', (_event, _code, _desc, _validatedURL, isMainFrame) => {
      if (isMainFrame) finish('')
    })

    window
      .loadURL(rawUrl, {
        httpReferrer: 'https://www.google.com/',
        userAgent: TITLE_USER_AGENT
      })
      .catch(() => finish(''))
  })
}

function fetchHtmlTitleWithRenderer(rawUrl) {
  return new Promise(resolve => {
    renderTitleQueue.push({ resolve, url: rawUrl })
    dequeueRenderTitle()
  })
}

// Strips known error/captcha titles (e.g. "GetYourGuide – Error", "Just a
// moment...") so they don't get cached as the resolved title.
const usableTitle = value => (value && !TITLE_ERROR_RE.test(value) ? value : '')

function fetchLinkTitle(rawUrl) {
  const url = String(rawUrl || '').trim()
  const key = canonicalTitleCacheKey(url)
  if (!key) return Promise.resolve('')
  if (titleCache.has(key)) return Promise.resolve(titleCache.get(key))
  if (titleInflight.has(key)) return titleInflight.get(key)

  const pending = fetchHtmlTitleWithCurl(url)
    .catch(() => '')
    .then(value => usableTitle((value || '').slice(0, 240)))
    .then(
      async value => value || usableTitle(((await fetchHtmlTitleWithRenderer(url).catch(() => '')) || '').slice(0, 240))
    )
    .then(clean => {
      cacheTitle(key, clean)
      titleInflight.delete(key)
      return clean
    })

  titleInflight.set(key, pending)
  return pending
}

async function resourceBufferFromUrl(rawUrl) {
  if (!rawUrl) throw new Error('Missing URL')
  if (rawUrl.startsWith('data:')) {
    const match = rawUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
    if (!match) throw new Error('Invalid data URL')
    const mimeType = match[1] || 'application/octet-stream'
    const encoded = match[3] || ''
    const buffer = match[2] ? Buffer.from(encoded, 'base64') : Buffer.from(decodeURIComponent(encoded), 'utf8')
    return { buffer, mimeType }
  }
  if (rawUrl.startsWith('file:')) {
    // Hardened: rejects Windows device paths + null bytes before reading the
    // file into a buffer (this path reads arbitrary file:// URLs).
    const filePath = resolveRequestedPathForIpc(rawUrl, { purpose: 'Read resource' })
    const buffer = await fs.promises.readFile(filePath)
    return { buffer, mimeType: mimeTypeForPath(filePath) }
  }

  const parsed = new URL(rawUrl)
  const client = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = client.get(parsed, res => {
      if ((res.statusCode || 500) >= 400) {
        reject(new Error(`Failed to fetch ${rawUrl}: ${res.statusCode}`))
        res.resume()
        return
      }
      const chunks = []
      res.on('error', reject)
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          buffer: Buffer.concat(chunks),
          mimeType: res.headers['content-type'] || 'application/octet-stream'
        })
      })
    })
    req.on('error', reject)
  })
}

async function copyImageFromUrl(rawUrl) {
  const { buffer } = await resourceBufferFromUrl(rawUrl)
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) throw new Error('Could not read image')
  clipboard.writeImage(image)
}

async function saveImageFromUrl(rawUrl) {
  const { buffer, mimeType } = await resourceBufferFromUrl(rawUrl)
  const fallbackName = filenameFromUrl(rawUrl, `image${extensionForMimeType(mimeType) || '.png'}`)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Image',
    defaultPath: fallbackName
  })
  if (result.canceled || !result.filePath) return false
  await fs.promises.writeFile(result.filePath, buffer)
  return true
}

async function writeComposerImage(buffer, ext = '.png') {
  const rawExt = String(ext || '.png')
    .trim()
    .toLowerCase()
  const normalizedExt = rawExt.startsWith('.') ? rawExt : `.${rawExt}`
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(normalizedExt) ? normalizedExt : '.png'
  const dir = path.join(app.getPath('userData'), 'composer-images')
  await fs.promises.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const random = crypto.randomBytes(3).toString('hex')
  const filePath = path.join(dir, `composer_${stamp}_${random}${safeExt}`)
  await fs.promises.writeFile(filePath, buffer)
  return filePath
}

function previewLabelForUrl(url) {
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
}

function expandUserPath(filePath) {
  const value = String(filePath || '').trim()

  if (value === '~') {
    return app.getPath('home')
  }

  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) {
    return path.join(app.getPath('home'), value.slice(2))
  }

  return value
}

function previewFileTarget(rawTarget, baseDir) {
  const raw = String(rawTarget || '').trim()
  const base = baseDir ? path.resolve(expandUserPath(baseDir)) : resolveFanCwd()
  const filePath = raw.startsWith('file:') ? fileURLToPath(raw) : path.resolve(base, expandUserPath(raw))
  let resolved = filePath

  if (directoryExists(resolved)) {
    resolved = path.join(resolved, 'index.html')
  }

  const ext = path.extname(resolved).toLowerCase()
  if (!fileExists(resolved)) {
    return null
  }

  const mimeType = mimeTypeForPath(resolved)
  const metadata = previewFileMetadata(resolved, mimeType)
  const isHtml = PREVIEW_HTML_EXTENSIONS.has(ext)
  const isImage = mimeType.startsWith('image/')
  const previewKind = isHtml ? 'html' : isImage ? 'image' : metadata.binary ? 'binary' : 'text'

  return {
    binary: metadata.binary,
    byteSize: metadata.byteSize,
    kind: 'file',
    large: metadata.large,
    label: path.basename(resolved),
    language: PREVIEW_LANGUAGE_BY_EXT[ext] || 'text',
    mimeType,
    path: resolved,
    previewKind,
    source: raw,
    url: pathToFileURL(resolved).toString()
  }
}

function previewUrlTarget(rawTarget) {
  const raw = String(rawTarget || '').trim()
  const url = new URL(raw)

  if (!['http:', 'https:'].includes(url.protocol)) {
    return null
  }

  if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) {
    return null
  }

  if (url.hostname === '0.0.0.0') {
    url.hostname = '127.0.0.1'
  }

  return {
    kind: 'url',
    label: previewLabelForUrl(url),
    source: raw,
    url: url.toString()
  }
}

function normalizePreviewTarget(rawTarget, baseDir) {
  const raw = String(rawTarget || '').trim()

  if (!raw) {
    return null
  }

  try {
    if (/^https?:\/\//i.test(raw)) {
      return previewUrlTarget(raw)
    }

    return previewFileTarget(raw, baseDir)
  } catch {
    return null
  }
}

function filePathFromPreviewUrl(rawUrl) {
  const filePath = fileURLToPath(String(rawUrl || ''))

  if (!fileExists(filePath)) {
    throw new Error('Preview file is not readable')
  }

  return filePath
}

function sendPreviewFileChanged(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:preview-file-changed', payload)
}

function watchPreviewFile(rawUrl) {
  const filePath = filePathFromPreviewUrl(rawUrl)
  const watchDir = path.dirname(filePath)
  const targetName = path.basename(filePath)
  const id = crypto.randomBytes(12).toString('base64url')
  let timer = null
  const watcher = fs.watch(watchDir, (_eventType, filename) => {
    const changedName = filename ? path.basename(String(filename)) : ''

    if (changedName && changedName !== targetName) {
      return
    }

    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!fileExists(filePath)) return
      sendPreviewFileChanged({ id, path: filePath, url: pathToFileURL(filePath).toString() })
    }, PREVIEW_WATCH_DEBOUNCE_MS)
  })

  previewWatchers.set(id, {
    close: () => {
      if (timer) clearTimeout(timer)
      watcher.close()
    }
  })

  return { id, path: filePath }
}

function stopPreviewFileWatch(id) {
  const watcher = previewWatchers.get(id)

  if (!watcher) {
    return false
  }

  watcher.close()
  previewWatchers.delete(id)

  return true
}

function closePreviewWatchers() {
  for (const id of previewWatchers.keys()) {
    stopPreviewFileWatch(id)
  }
}

async function waitForFan(baseUrl, token) {
  // Cold Windows disks/AV scans can make a healthy bundled backend take more
  // than 45s. Keep polling for 90s before treating startup as failed.
  const deadline = Date.now() + 90_000
  let lastError = null

  while (Date.now() < deadline) {
    try {
      await fetchJson(`${baseUrl}/api/status`, token)
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  throw new Error(`Fan backend did not become ready: ${lastError?.message || 'timeout'}`)
}

function getWindowButtonPosition() {
  if (!IS_MAC) return null
  return mainWindow?.getWindowButtonPosition?.() || WINDOW_BUTTON_POSITION
}

function getNativeOverlayWidth() {
  // macOS reports traffic-light coords via windowButtonPosition; the
  // titlebarOverlay there doesn't reserve right-edge space. Windows/Linux
  // render the native window-controls overlay on the right, so the renderer
  // needs to inset its right cluster by this much to clear them.
  return IS_MAC ? 0 : NATIVE_OVERLAY_BUTTON_WIDTH
}

function getWindowState() {
  return {
    isFullscreen: Boolean(mainWindow?.isFullScreen?.()),
    nativeOverlayWidth: getNativeOverlayWidth(),
    windowButtonPosition: getWindowButtonPosition()
  }
}

function sendBackendExit(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:backend-exit', payload)
}

function sendClosePreviewRequested() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:close-preview-requested')
}

// Tell the renderer the machine just woke. Sleep silently drops the
// renderer's WebSocket to the local backend; the renderer reconnects on this
// signal so the chat composer doesn't stay stuck on "Starting Fan...".
function sendPowerResume() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:power-resume')
}

let powerResumeRegistered = false

function registerPowerResumeListeners() {
  if (powerResumeRegistered) return
  powerResumeRegistered = true
  try {
    // 'resume' covers sleep/wake; 'unlock-screen' covers lock/unlock without a
    // full suspend. Either can drop an idle socket.
    powerMonitor.on('resume', sendPowerResume)
    powerMonitor.on('unlock-screen', sendPowerResume)
    // Linux may begin system shutdown without the Windows-only
    // query-session-end event. Let window close proceed instead of hiding back
    // into the Tray and delaying the OS.
    powerMonitor.on('shutdown', () => {
      isAppQuitting = true
    })
  } catch {
    // powerMonitor is unavailable before app 'ready' on some platforms; the
    // caller registers after 'ready', so this should not normally throw.
  }
}

function getAppIconPath() {
  return APP_ICON_PATHS.find(fileExists)
}

function applicationSurfaceRequestContext() {
  let focusedBrowserViewId = ''
  for (const [viewId, view] of browserViews.entries()) {
    const wc = view?.webContents
    if (!wc || wc.isDestroyed()) continue
    try {
      if (wc.isFocused()) {
        focusedBrowserViewId = String(viewId)
        break
      }
    } catch {
      // A view can be destroyed between the registry read and focus check.
    }
  }
  const operatingSessionIds = []
  for (const [sessionId, state] of operatingStateBySession.entries()) {
    if (state?.active === true) operatingSessionIds.push(String(sessionId))
  }
  return {
    focusedBrowserViewId,
    mainRendererFocused: Boolean(mainWindow?.webContents?.isFocused?.()),
    operatingSessionIds
  }
}

function logApplicationSurfaceRequest(surface, source, trigger) {
  _browserLog(`[app-surface] ${JSON.stringify({
    event: 'open-requested',
    surface,
    source: String(source || 'unknown'),
    trigger: String(trigger || 'unknown'),
    ...applicationSurfaceRequestContext()
  })}`)
}

function sendOpenSettingsRequested(source = 'application-menu', trigger = 'menu-selection') {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  logApplicationSurfaceRequest('settings', source, trigger)
  webContents.send('fan:open-settings')
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendOpenAboutRequested(source = 'application-menu', trigger = 'menu-selection') {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  logApplicationSurfaceRequest('about', source, trigger)
  webContents.send('fan:open-about')
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendOpenUpdatesRequested() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  webContents.send('fan:open-updates')
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function sendWindowStateChanged(nextIsFullscreen) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { webContents } = mainWindow
  if (!webContents || webContents.isDestroyed()) return
  const state = getWindowState()

  if (typeof nextIsFullscreen === 'boolean') {
    state.isFullscreen = nextIsFullscreen
  }

  webContents.send('fan:window-state-changed', state)
}

function buildApplicationMenu() {
  const closeCurrentSurface = {
    accelerator: 'CommandOrControl+W',
    click: () => {
      if (previewShortcutActive) {
        sendClosePreviewRequested()
      } else {
        mainWindow?.close()
      }
    },
    label: '关闭窗口'
  }
  const zoomItems = [
    {
      label: '实际大小',
      accelerator: 'CommandOrControl+0',
      click: () => {
        setAndPersistZoomLevel(mainWindow, 0)
      }
    },
    {
      label: '放大',
      accelerator: 'CommandOrControl+Plus',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          setAndPersistZoomLevel(mainWindow, mainWindow.webContents.getZoomLevel() + 0.1)
        }
      }
    },
    {
      label: '缩小',
      accelerator: 'CommandOrControl+-',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          setAndPersistZoomLevel(mainWindow, mainWindow.webContents.getZoomLevel() - 0.1)
        }
      }
    }
  ]
  const helpMenu = {
    label: '帮助',
    role: 'help',
    submenu: [
      {
        label: 'Fan 官网',
        click: () => openExternalUrl(OFFICIAL_SITE_URL)
      }
    ]
  }
  const applicationItems = [
    {
      label: `关于 ${APP_NAME}`,
      click: (_menuItem, _window, event) =>
        sendOpenAboutRequested(
          'application-menu',
          event?.triggeredByAccelerator === true ? 'accelerator' : 'menu-selection'
        )
    },
    {
      label: '检查更新…',
      click: () => sendOpenUpdatesRequested()
    },
    { type: 'separator' },
    {
      label: '设置…',
      accelerator: 'CommandOrControl+,',
      click: (_menuItem, _window, event) =>
        sendOpenSettingsRequested(
          'application-menu',
          event?.triggeredByAccelerator === true ? 'accelerator' : 'menu-selection'
        )
    },
    ...(IS_MAC
      ? [
          { type: 'separator' },
          { label: `隐藏 ${APP_NAME}`, role: 'hide' },
          { label: '隐藏其他', role: 'hideOthers' },
          { label: '全部显示', role: 'unhide' }
        ]
      : []),
    { type: 'separator' },
    { label: `退出 ${APP_NAME}`, role: 'quit' }
  ]
  const windowItems = [
    closeCurrentSurface,
    { label: '进入全屏幕', role: 'togglefullscreen' },
    { type: 'separator' },
    IS_MAC
      ? { label: '最小化', role: 'minimize' }
      : {
          label: '最小化',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
          }
        },
    IS_MAC
      ? { label: '缩放', role: 'zoom' }
      : {
          label: '最大化',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return
            if (mainWindow.isMaximized()) mainWindow.unmaximize()
            else mainWindow.maximize()
          }
        }
  ]

  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: applicationItems
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '显示',
      submenu: zoomItems
    },
    {
      label: '窗口',
      submenu: windowItems
    },
    helpMenu
  ])
}

function toggleDevTools(window) {
  // DevTools is enabled in packaged builds so users can diagnose renderer
  // issues without needing a dev build. Trade-off: tiny attack surface
  // increase versus a much better support story when WS connection or
  // CSP issues surface in the field.
  const { webContents } = window
  if (webContents.isDevToolsOpened()) {
    webContents.closeDevTools()
  } else {
    webContents.openDevTools({ mode: 'detach' })
  }
}

function installDevToolsShortcut(window) {
  // F12 / Cmd+Opt+I works in both dev and packaged builds.
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const isInspectShortcut =
      input.key === 'F12' ||
      (IS_MAC && input.meta && input.alt && key === 'i') ||
      (!IS_MAC && input.control && input.shift && key === 'i')
    if (!isInspectShortcut) return
    event.preventDefault()
    toggleDevTools(window)
  })
}

function installPreviewShortcut(window) {
  window.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase()
    const isPreviewCloseShortcut = key === 'w' && (IS_MAC ? input.meta : input.control) && !input.alt && !input.shift

    if (!isPreviewCloseShortcut || !previewShortcutActive) return

    event.preventDefault()
    sendClosePreviewRequested()
  })
}

// Window zoom is renderer-local persistence because it must survive reloads
// and crash recovery without creating another main-process preferences file.
function setAndPersistZoomLevel(window, zoomLevel) {
  if (!window || window.isDestroyed()) return
  const next = applyZoomLevel(window.webContents, zoomLevel)
  window.webContents
    .executeJavaScript(
      `try { localStorage.setItem(${JSON.stringify(ZOOM_STORAGE_KEY)}, ${JSON.stringify(String(next))}) } catch {}`
    )
    .catch(error => rememberLog(`[zoom] persist failed: ${error?.message || error}`))
}

function restorePersistedZoomLevel(window) {
  if (!window || window.isDestroyed()) return
  window.webContents
    .executeJavaScript(
      `(() => { try { return localStorage.getItem(${JSON.stringify(ZOOM_STORAGE_KEY)}) } catch { return null } })()`
    )
    .then(stored => {
      if (stored == null || !window || window.isDestroyed()) return
      applyZoomLevel(window.webContents, Number(stored))
    })
    .catch(error => rememberLog(`[zoom] restore failed: ${error?.message || error}`))
}

function installZoomShortcuts(window) {
  // Override Ctrl/Cmd + +/-/0 with half the default zoom step (0.1 vs 0.2).
  // The menu items handle this on macOS (where the menu is always present),
  // but on Linux/Windows the menu is null and Chromium's default handler
  // would use the full 0.2 step, so we intercept here for consistency.
  const ZOOM_STEP = 0.1
  window.webContents.on('before-input-event', (event, input) => {
    const mod = IS_MAC ? input.meta : input.control
    if (!mod || input.alt || input.shift) return

    const key = input.key
    if (key === '0') {
      event.preventDefault()
      setAndPersistZoomLevel(window, 0)
    } else if (key === '=' || key === '+') {
      event.preventDefault()
      setAndPersistZoomLevel(window, window.webContents.getZoomLevel() + ZOOM_STEP)
    } else if (key === '-') {
      event.preventDefault()
      setAndPersistZoomLevel(window, window.webContents.getZoomLevel() - ZOOM_STEP)
    }
  })
}

function installContextMenu(target, options = {}) {
  const webContents = target?.webContents || target
  const ownerWindow = options.ownerWindow || (target?.webContents ? target : mainWindow)
  if (!webContents || typeof webContents.on !== 'function') return false
  webContents.on('context-menu', (_event, params) => {
    const template = []
    const hasSelection = Boolean(params.selectionText?.trim())
    const hasImage = params.mediaType === 'image' && Boolean(params.srcURL)
    const hasLink = Boolean(params.linkURL)
    const isEditable = Boolean(params.isEditable)

    if (options.navigation) {
      const history = webContents.navigationHistory
      const canGoBack =
        typeof history?.canGoBack === 'function'
          ? history.canGoBack()
          : Boolean(webContents.canGoBack?.())
      const canGoForward =
        typeof history?.canGoForward === 'function'
          ? history.canGoForward()
          : Boolean(webContents.canGoForward?.())
      template.push(
        {
          label: 'Back',
          enabled: canGoBack,
          click: () => {
            if (history?.canGoBack?.()) history.goBack()
            else webContents.goBack?.()
          }
        },
        {
          label: 'Forward',
          enabled: canGoForward,
          click: () => {
            if (history?.canGoForward?.()) history.goForward()
            else webContents.goForward?.()
          }
        },
        { label: 'Reload', click: () => webContents.reload?.() }
      )
    }

    if (hasImage) {
      if (template.length) template.push({ type: 'separator' })
      template.push(
        {
          label: options.openLink ? 'Open Image in New Tab' : 'Open Image',
          click: () => {
            if (params.srcURL && !params.srcURL.startsWith('data:')) {
              if (options.openLink) options.openLink(params.srcURL)
              else openExternalUrl(params.srcURL)
            }
          },
          enabled: !params.srcURL.startsWith('data:')
        },
        {
          label: 'Copy Image',
          click: () => {
            void copyImageFromUrl(params.srcURL).catch(error => rememberLog(`Copy image failed: ${error.message}`))
          }
        },
        {
          label: 'Copy Image Address',
          click: () => clipboard.writeText(params.srcURL)
        },
        {
          label: 'Save Image As...',
          click: () => {
            void saveImageFromUrl(params.srcURL).catch(error => rememberLog(`Save image failed: ${error.message}`))
          }
        }
      )
    }

    if (hasLink) {
      if (template.length) template.push({ type: 'separator' })
      template.push(
        {
          label: options.openLink ? 'Open Link in New Tab' : 'Open Link',
          click: () => {
            if (options.openLink) options.openLink(params.linkURL)
            else openExternalUrl(params.linkURL)
          }
        },
        {
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL)
        }
      )
    }

    // Spell-check suggestions for the misspelled word under the caret.
    // Chromium surfaces them on `params.dictionarySuggestions`; we offer the
    // top 5 plus a "Add to dictionary" affordance.
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : []

    if (isEditable && params.misspelledWord && suggestions.length > 0) {
      if (template.length) template.push({ type: 'separator' })

      for (const suggestion of suggestions.slice(0, 5)) {
        template.push({
          label: suggestion,
          click: () => webContents.replaceMisspelling(suggestion)
        })
      }

      template.push({ type: 'separator' })
      template.push({
        label: 'Add to dictionary',
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      })
    }

    if (hasSelection || isEditable) {
      if (template.length) template.push({ type: 'separator' })
      if (isEditable) {
        template.push(
          { role: 'cut', enabled: params.editFlags.canCut },
          { role: 'copy', enabled: params.editFlags.canCopy },
          { role: 'paste', enabled: params.editFlags.canPaste },
          { type: 'separator' },
          { role: 'selectAll', enabled: params.editFlags.canSelectAll }
        )
      } else {
        template.push({ role: 'copy', enabled: params.editFlags.canCopy })
      }
    }

    if (!template.length) {
      template.push({ role: 'selectAll' })
    }

    Menu.buildFromTemplate(template).popup({ window: ownerWindow || undefined })
  })
  return true
}

// Microphone capture for the voice composer. The renderer drives mic access
// through getUserMedia, which Chromium gates behind these two session hooks.
//
// The naive `details.mediaTypes.includes('audio')` check works on macOS but
// breaks on Windows: Chromium frequently fires the mic permission request with
// an empty/undefined `mediaTypes`, so the strict check denies it and
// getUserMedia throws NotAllowedError ("Microphone permission was denied").
// We therefore treat an audio-capture request as allowed whenever it's the
// 'media'/'audioCapture' permission AND mediaTypes either includes 'audio' OR
// is empty/absent (the Windows case). Video is still denied.
function isAudioCapturePermission(permission, details) {
  if (permission === 'audioCapture') {
    return true
  }
  if (permission !== 'media') {
    return false
  }
  const mediaTypes = details?.mediaTypes
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) {
    // Windows: mediaTypes is often empty for a mic request. Don't deny on
    // missing metadata. (A video request would carry mediaTypes:['video'].)
    return true
  }
  return mediaTypes.includes('audio') && !mediaTypes.includes('video')
}

function installMediaPermissions() {
  // Async request handler: the prompt-style path (most platforms).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(isAudioCapturePermission(permission, details))
  })

  // Synchronous check handler: Chromium consults this for getUserMedia on
  // Windows in addition to (or instead of) the request handler. Without it,
  // the check defaults to false and the mic is denied before the request
  // handler ever runs.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (permission === 'media' || permission === 'audioCapture') {
      // details.mediaType is a single string here (not the mediaTypes array).
      const mediaType = details?.mediaType
      if (mediaType === 'video') {
        return false
      }

      return true
    }

    return false
  })
}

// Build a fresh WS URL for the current connection. The renderer calls this
// immediately before every gateway.connect() so each upgrade carries the
// loopback session token.
async function freshGatewayWsUrl() {
  const connection = await ensureBackend()
  // The cached wsUrl already carries the (long-lived) loopback token.
  return connection.wsUrl
}

// Resolve the single desktop backend connection. The desktop always uses the
// one default backend managed by startFan() + fanProcess.
async function ensureBackend() {
  return startFan()
}

async function startFan() {
  // Latched-failure short-circuit: once bootstrap has failed in this
  // process, every subsequent startFan() call re-throws the same error
  // without re-running install.ps1. This prevents the renderer's
  // ensureGatewayOpen retries (and any other getConnection callers) from
  // restarting a 5-10 minute install loop while the user is still reading
  // the failure overlay.
  if (bootstrapFailure) {
    throw bootstrapFailure
  }
  if (backendStartFailure) {
    throw backendStartFailure
  }
  if (connectionPromise) return connectionPromise

  const pending = (async () => {
    await advanceBootProgress('backend.resolve', 'Resolving Fan backend', 8)
    await advanceBootProgress('backend.port', 'Finding an open local port', 16)
    const port = await pickPort()
    const token = crypto.randomBytes(32).toString('base64url')
    const dashboardArgs = ['dashboard', '--no-open', '--host', '127.0.0.1', '--port', String(port)]
    await advanceBootProgress('backend.runtime', 'Resolving Fan runtime', 28)
    const backend = await ensureRuntime(resolveFanBackend(dashboardArgs))
    const fanCwd = resolveFanCwd()
    const webDist = resolveWebDist()
    const browserRuntimeEndpoint = await ensureBrowserRuntimeServer()

    await advanceBootProgress('backend.spawn', `Starting Fan backend via ${backend.label}`, 84)
    rememberLog(`Starting Fan backend via ${backend.label}`)

    const child = spawn(
      backend.command,
      backend.args,
      hiddenWindowsChildOptions({
        cwd: fanCwd,
        env: {
          ...process.env,
          // Explicitly pin FAN_HOME for the child so Python's get_fan_home()
          // resolves to the SAME location our resolveFanHome() picked. Without
          // this pin, Python falls back to ~/.fan on every platform — fine on
          // mac/linux (where our default matches), but on Windows our default is
          // %LOCALAPPDATA%\fan, which differs from C:\Users\<u>\.fan.
          // Mismatch would split config / sessions / .env / logs across two
          // directories. install.ps1 sets FAN_HOME via setx; the desktop
          // can't reliably do that, so we set it inline for every spawn.
          FAN_HOME,
          ...backend.env,
          // Pin the gateway's tool/terminal cwd to the same dir we chose for the
          // child. An inherited/stale TERMINAL_CWD can otherwise point at the
          // install dir even when spawn cwd is home.
          TERMINAL_CWD: fanCwd,
          FAN_DESKTOP_SESSION_TOKEN: token,
          FAN_BROWSER_RUNTIME: DESKTOP_BROWSER_RUNTIME,
          ELECTRON_BROWSER_RUNTIME_URL: browserRuntimeEndpoint.url,
          ELECTRON_BROWSER_RUNTIME_TOKEN: browserRuntimeEndpoint.token,
          // Vite serves the renderer directly during source development, so
          // the Python process only needs to expose its API and WebSocket
          // routes. Packaged builds still require and serve the bundled SPA.
          ...(DEV_SERVER ? { FAN_DESKTOP_API_ONLY: '1' } : {}),
          FAN_WEB_DIST: webDist
        },
        shell: backend.shell,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    )
    fanProcess = child

    child.stdout.on('data', rememberLog)
    child.stderr.on('data', rememberLog)
    let backendReady = false
    let rejectBackendStart = null
    const backendStartFailed = new Promise((_resolve, reject) => {
      rejectBackendStart = reject
    })
    child.once('error', error => {
      rememberLog(`Fan backend failed to start: ${error.message}`)
      // Only mutate shared state / flip the boot UI when this is still the
      // active backend — a stale process's delayed error must not null a newer
      // startFan()'s fanProcess/connectionPromise (concurrent-startFan race).
      if (fanProcess === child) {
        updateBootProgress(
          {
            error: error.message,
            message: `Fan backend failed to start: ${error.message}`,
            phase: 'backend.error',
            running: false
          },
          { allowDecrease: true }
        )
        fanProcess = null
        connectionPromise = null
        sendBackendExit({ code: null, signal: null, error: error.message })
      }
      rejectBackendStart?.(error)
    })
    child.once('exit', (code, signal) => {
      rememberLog(`Fan backend exited (${signal || code})`)
      // Only clear shared state + report backend-exit when this handler owns the
      // current active process; a stale process's late exit otherwise nulls the
      // newer connection and misfires a backend-exit notification.
      if (fanProcess === child) {
        fanProcess = null
        connectionPromise = null
        sendBackendExit({ code, signal })
      }
      if (!backendReady && !expectedFanProcessExits.has(child)) {
        const message = `Fan backend exited before it became ready (${signal || code}).`
        updateBootProgress(
          {
            error: message,
            message,
            phase: 'backend.error',
            running: false
          },
          { allowDecrease: true }
        )
        rejectBackendStart?.(
          new Error(
            `Fan backend exited before it became ready (${signal || code}). Log: ${DESKTOP_LOG_PATH}\n${recentFanLog()}`
          )
        )
      }
    })

    const baseUrl = `http://127.0.0.1:${port}`
    await advanceBootProgress('backend.wait', 'Waiting for Fan backend to become ready', 90)
    try {
      await Promise.race([waitForFan(baseUrl, token), backendStartFailed])
    } catch (error) {
      // Ready-wait failed. If the child is still alive (timeout path — the
      // exit path rejects via backendStartFailed with the process already
      // gone), terminate it before propagating: a half-dead backend that
      // finishes booting later would coexist with the retry's fresh spawn
      // (orphan/double backend), and its late exit flips a healthy session
      // back to the boot-failure overlay. Marking it expected keeps the exit
      // handler from recording a duplicate BACKEND_EXIT diagnostic.
      if (fanProcess === child && child.exitCode === null && !child.killed) {
        expectedFanProcessExits.add(child)
        // Null the active-process pointer before killing so the imminent exit
        // takes the stale-process branch, not re-broadcast backend-exit over the real
        // timeout error we are about to surface.
        fanProcess = null
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
        const escalate = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 5_000)
        escalate.unref?.()
      }
      throw error
    }
    backendReady = true
    backendStartFailure = null
    updateBootProgress({
      phase: 'backend.ready',
      message: 'Fan backend is ready. Finalizing desktop startup',
      progress: 94,
      running: true,
      error: null
    })
    return {
      baseUrl,
      mode: 'local',
      source: 'local',
      authMode: 'token',
      token,
      wsUrl: `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`,
      logs: fanLog.slice(-80),
      ...getWindowState()
    }
  })().catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    backendStartFailure = error instanceof Error ? error : new Error(message)
    updateBootProgress(
      {
        error: message,
        message: `Desktop boot failed: ${message}`,
        phase: 'backend.error',
        running: false
      },
      { allowDecrease: true }
    )
    // Only clear when connectionPromise still points at THIS startFan()'s
    // promise — a stale startFan()'s delayed rejection (e.g. a SIGTERM'd child
    // exiting after a reset + reload already spawned a new backend)
    // must not null the newer connection, which would re-spawn a duplicate/
    // orphan backend. Same identity-gate idea as the exit/error handlers above.
    if (connectionPromise === pending) {
      connectionPromise = null
    }
    throw error
  })

  connectionPromise = pending

  return connectionPromise
}

// ── Embedded browser workbench (Electron-native runtime) ────────────────────
// Each workbench id maps to ONE WebContentsView floated over the renderer's
// placeholder rect. The Electron-native runtime drives it through
// WebContents.debugger. The user sees + can click it natively.
// WebContentsView is an OS-level overlay, NOT a DOM node — the renderer can only
// position/show/hide it through these IPC calls.
const browserViews = new Map() // id (browser_workbench_id) -> WebContentsView
// The first host load is a renderer-readiness barrier for a fresh workbench.
// Weak keys keep this bookkeeping from retaining disposed WebContentsViews.
const browserViewInitialLoads = new WeakMap()
// Declared with the browser registry (rather than next to the overview UI)
// because foreground-presentation reconciliation can run while the first tab is
// being created, before the overview helpers are evaluated.
const overviewTileIds = new Set()
const overviewTileRects = new Map() // sessionId -> last tile rect, for tab-follow re-apply
// Canonical logical browser state. WebContentsViews remain owned by Main, while
// every session/tab/active-tab topology mutation goes through this controller.
const browserSessionController = new BrowserSessionController()
// TAB-01:崩溃焦点恢复的 per-session 并发去重(对齐 _recovery_lock/_recovery_in_progress)。
const recoveringSessions = new Set()
// Tab-strip human-takeover: while the runtime owns an active control turn, a
// USER tab op (switch / new) is treated like the page-click takeover — pause +
// ask + restore. Main only remembers the agent's working tab; the runtime is
// the sole authority for whether a session is controlled.
const anchorBySession = new Map() // sessionId -> agent's working tabId (restore target)
const operatingStateBySession = new Map() // sessionId -> { active, revision }

function isSessionOperating(sessionId) {
  const key = String(sessionId || '')
  return Boolean(
    key && browserRuntime && typeof browserRuntime.isOperating === 'function' && browserRuntime.isOperating(key)
  )
}

function isSessionVisuallyOperating(sessionId) {
  const key = String(sessionId || '')
  if (!key || !browserRuntime) return false
  if (typeof browserRuntime.isVisuallyOperating === 'function') {
    return browserRuntime.isVisuallyOperating(key)
  }
  return isSessionOperating(key)
}

function isSessionThumbnailCaptureUnsafe(sessionId) {
  const key = String(sessionId || '')
  return Boolean(
    key &&
    (
      isSessionVisuallyOperating(key) ||
      browserRuntime?.isOperatingVisualTransitionPending?.(key)
    )
  )
}
// Cap tabs per session so a page calling window.open in a loop can't spawn
// unbounded WebContentsViews; past the cap, popups fall back to navigating the
// active tab. Env-overridable.
const MAX_TABS_PER_SESSION = Math.max(1, Number(process.env.ELECTRON_BROWSER_MAX_TABS) || 20)
// Hard structural cap on the TOTAL number of live WebContentsViews across ALL
// sessions/tabs — the admission-control backstop. No code path (a render loop,
// a corrupted restoreTabs state, a runaway page) can spawn views past this, so a
// view-creation bug degrades to "refused view", never an OOM/freeze.
const MAX_TOTAL_BROWSER_VIEWS = Math.max(1, Number(process.env.ELECTRON_BROWSER_MAX_VIEWS) || 40)
let browserRuntime = null
let browserRuntimeServerPromise = null
let browserRuntimeServerInfo = null
// Tabs created by a page (window.open / target=_blank) are allowed to honour
// window.close(). Primary host tabs stay guarded because closing one behind the
// host's back would otherwise strand the Task Space on a dead native view.
const pageOpenedBrowserTabIds = new Set()
// Runtime download ids are native/private. Renderer actions address the
// Browser Shell's opaque event ids instead.
const browserShellDownloadIds = new Map()
// A site can issue the same permission request more than once before the user
// answers. Keep one visible prompt and settle every native callback together.
const browserPermissionWaiters = new Map()
const browserDialogPromptIds = new Map()

const IN_APP_BROWSER_PROTOCOLS = new Set(['about:', 'blob:', 'data:', 'file:', 'http:', 'https:'])
const BLOCKED_BROWSER_PROTOCOLS = new Set([
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'javascript:',
  'view-source:'
])
function parsedBrowserUrl(rawUrl) {
  const value = String(rawUrl || '').trim()
  if (!value || value.length > 32768) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function browserProtocolKind(rawUrl) {
  const parsed = parsedBrowserUrl(rawUrl)
  const protocol = String(parsed?.protocol || '').toLowerCase()
  if (!protocol) return { kind: 'invalid', parsed: null, protocol: '' }
  if (IN_APP_BROWSER_PROTOCOLS.has(protocol)) return { kind: 'in-app', parsed, protocol }
  if (BLOCKED_BROWSER_PROTOCOLS.has(protocol)) return { kind: 'blocked', parsed, protocol }
  return { kind: 'external', parsed, protocol }
}

function browserDocumentScope(workbenchId, tabId) {
  const safeWorkbenchId = String(workbenchId || browserSessionController.sessionIdForTab(tabId) || '')
  const safeTabId = String(tabId || browserSessionController.activeTabId(safeWorkbenchId) || '')
  return {
    documentRevision: documentRevisionByView.get(safeTabId) || 0,
    tabId: safeTabId,
    workbenchId: safeWorkbenchId
  }
}

function browserPermissionOrigin(details = {}) {
  const raw = details.requestingUrl || details.securityOrigin || details.requestingOrigin || ''
  const parsed = parsedBrowserUrl(raw)
  return String(parsed?.host || parsed?.hostname || '')
}

function browserTabHost(tabId) {
  const webContents = browserViews.get(String(tabId || ''))?.webContents
  const parsed = parsedBrowserUrl(webContents?.getURL?.())
  return String(parsed?.host || parsed?.hostname || '')
}

// Runtime events the renderer needs for co-browsing UX: which workbench the
// agent is acting on (badge), navigation lifecycle (chrome buttons), captcha
// (banner), dialogs, and crashes. Everything else stays in main.
const FORWARDED_BROWSER_EVENTS = [
  'navigation.started',
  'navigation.completed',
  'navigation.failed',
  'control.state',
  'action.started',
  'action.completed',
  'action.failed',
  'captcha.detected',
  'captcha.cleared',
  'dialog.opened',
  'dialog.closed',
  'permission.resolved',
  'download.started',
  'download.updated',
  'tab.created',
  'tab.closed',
  'tab.activated',
  'selector.invalidated',
  'observe.required',
  'browser.context.updated',
  'render-process.gone',
  'render-process.unresponsive',
  'render-process.responsive',
  'user.intervened'
]

function _sendBrowserEvent(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fan:browser:event', { type, payload })
  }
}

function _browserEventScope(payload = {}) {
  const explicitWorkbenchId = String(payload.workbenchId || payload.sessionId || '')
  const explicitTabId = String(payload.tabId || payload.activeTabId || '')
  const legacyId = String(payload.id || '')
  const candidateTabId =
    explicitTabId ||
    (legacyId && browserSessionController.sessionIdForTab(legacyId) ? legacyId : '')
  const workbenchId =
    explicitWorkbenchId ||
    (candidateTabId ? browserSessionController.sessionIdForTab(candidateTabId) : null) ||
    (legacyId && browserSessionController.hasSession(legacyId) ? legacyId : '')
  const tabId =
    candidateTabId ||
    (workbenchId && legacyId && browserSessionController.sessionIdForTab(legacyId) === workbenchId
      ? legacyId
      : '')
  return {
    workbenchId: String(workbenchId || ''),
    tabId: String(tabId || '')
  }
}

function _normalizeBrowserRuntimePayload(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const scope = _browserEventScope(payload)
  const normalized = {
    ...payload,
    ...(event?.id && !payload.eventId ? { eventId: String(event.id) } : {}),
    ...(scope.workbenchId ? { sessionId: scope.workbenchId, workbenchId: scope.workbenchId } : {}),
    ...(scope.tabId ? { tabId: scope.tabId } : {})
  }
  if (
    scope.tabId &&
    normalized.documentRevision == null &&
    documentRevisionByView.has(scope.tabId)
  ) {
    normalized.documentRevision = documentRevisionByView.get(scope.tabId) || 0
  }
  return normalized
}

function _publishBrowserOperatingState(sessionId, active) {
  const key = String(sessionId || '')
  if (!key) return null
  const nextActive = Boolean(active)
  const previous = operatingStateBySession.get(key)
  if (previous?.active === nextActive) return { id: key, workbenchId: key, ...previous }
  const next = { active: nextActive, revision: (previous?.revision || 0) + 1 }
  operatingStateBySession.set(key, next)
  const payload = { id: key, workbenchId: key, ...next }
  _sendBrowserEvent('operating.state', payload)
  return payload
}

function _browserOperatingSnapshot(sessionId) {
  const key = String(sessionId || '')
  if (!key) return null
  // Renderer layout/glow state follows the presentation lifetime. Logical
  // ownership remains `isSessionOperating`, so a human verification handoff can
  // accept user input while the originating browser tool still looks active.
  const active = isSessionVisuallyOperating(key)
  const previous = operatingStateBySession.get(key)
  return previous?.active === active
    ? { id: key, workbenchId: key, ...previous }
    : _publishBrowserOperatingState(key, active)
}

function _touchMaterializedView(viewId, reason) {
  const id = String(viewId || '')
  if (!id || !browserViews.has(id)) return false
  browserResourceGovernor.touch(id, reason)
  return true
}

function _handleBrowserRuntimeEvent(event) {
  const type = String(event?.type || '')
  const payload = _normalizeBrowserRuntimePayload(event)
  const sessionId = String(payload.workbenchId || '')
  if (type === 'permission.resolved') {
    const key = [
      payload.workbenchId || '',
      payload.tabId || '',
      payload.documentRevision ?? 0,
      String(payload.permission || '').toLowerCase()
    ].join('\0')
    const pending = browserPermissionWaiters.get(key)
    if (pending?.eventId) {
      void browserShellController.cancelShellPrompt(
        pending.eventId,
        String(payload.source || 'permission-resolved')
      )
    }
    return
  }
  if (type === 'dialog.closed') {
    const dialogId = String(payload.dialog?.dialogId || '')
    const promptId = dialogId ? browserDialogPromptIds.get(dialogId) : ''
    if (promptId) void browserShellController.cancelShellPrompt(promptId, 'dialog-closed')
  }
  if (type === 'download.started' || type === 'download.updated') {
    // The runtime event contains the private save path and source URL. Project
    // it through Browser Shell and do not forward that raw payload.
    translateBrowserDownloadEvent(type, payload)
    return
  }
  if (type === 'user.intervened') {
    const interruptedTabId = String(payload.tabId || payload.id || '')
    if (interruptedTabId) browserNavigationController.cancelTab(interruptedTabId)
  }
  if (sessionId && type === 'control.state') {
    _touchMaterializedView(
      payload.activeTabId || activeViewId(sessionId),
      payload.active === true ? 'agent-control-started' : 'agent-control-finished'
    )
    if (payload.active === true) {
      anchorBySession.set(sessionId, String(payload.activeTabId || activeViewId(sessionId)))
    } else if (!browserRuntime?.isOperating?.(sessionId)) {
      anchorBySession.delete(sessionId)
    }
    syncSessionBackgroundThrottling(sessionId)
  }
  _sendBrowserEvent(type, payload)
}

function createManagedPagePopup({ details, openerWebContents, sessionId, sourceTabId } = {}) {
  return browserPopupController.create({ details, openerWebContents, sessionId, sourceTabId })
}

function ensureBrowserRuntime() {
  if (!browserRuntime) {
    browserRuntime = new ElectronBrowserRuntime({
      getView: id => {
        // Never hand a dead (crashed) view to the runtime — it would throw
        // "WebContentsView not found" forever. Return null so getWorkbench treats
        // it as missing; the render-process-gone self-heal rebuilds it.
        const v = browserViews.get(String(id || 'main'))
        const wc = v && v.webContents
        return wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() ? v : null
      },
      getViewEpoch: id => viewEpochById.get(String(id || '')) || 0,
      resolveActiveTab: sessionId => browserSessionController.activeTabId(sessionId),
      createPagePopup: request => {
        const popupUrl = String(request?.details?.url || 'about:blank')
        const protocol = browserProtocolKind(popupUrl)
        if (protocol.kind === 'external') {
          requestExternalBrowserApplication({
            url: popupUrl,
            workbenchId: request.sessionId,
            tabId: request.sourceTabId,
            source: 'popup'
          })
          return { action: 'deny' }
        }
        if (protocol.kind === 'blocked' || protocol.kind === 'invalid') {
          raiseBrowserShellNotice(
            browserDocumentScope(request?.sessionId, request?.sourceTabId),
            protocol.kind === 'blocked' ? 'unsafe-protocol-blocked' : 'invalid-popup-url',
            'warning'
          )
          return { action: 'deny' }
        }
        return createManagedPagePopup(request)
      },
      runNavigationCommand: command =>
        runBrowserNavigationCommand({ ...command, waitForResult: true }),
      assertNavigationCurrent: transaction => browserNavigationController.assertCurrent(transaction),
      releaseNavigation: transaction => browserNavigationController.release(transaction),
      log: message => _browserLog(message),
      downloadsPath: app.getPath('downloads'),
      onBrowserDialog: request => routeBrowserDialog(request),
      onPermissionRequest: request => routeBrowserPermissionRequest(request),
      shouldGuardWindowClose: context => !pageOpenedBrowserTabIds.has(String(context?.tabId || context?.id || '')),
      // A session switch only changes native presentation; it must never be
      // interpreted as human takeover of the task left running in A/B/C.
      // Overview tiles are live previews with a transparent input catcher, and
      // background views are detached, so only the primary foreground browser
      // is an interactive takeover surface.
      shouldObserveHumanInput: ({ sessionId, workbenchId }) => {
        const key = String(sessionId || '')
        return Boolean(
          key &&
          foregroundSessionKey === key &&
          !overviewTileIds.has(key) &&
          String(workbenchId || '') === activeViewId(key)
        )
      },
      // Show the virtual cursor + operating frame so the user sees the agent
      // operate the page like a human. Disable with ELECTRON_BROWSER_OPERATING_VISUALS=0.
      operatingVisuals: process.env.ELECTRON_BROWSER_OPERATING_VISUALS !== '0',
      // Wait for a click-triggered navigation to settle before returning, so the
      // agent's next observation is the page the click produced (kills the
      // "click looked like it did nothing / stale index" churn on real sites
      // like Baidu). Disable with ELECTRON_BROWSER_POST_CLICK_SETTLE=0.
      postClickSettle: process.env.ELECTRON_BROWSER_POST_CLICK_SETTLE !== '0',
      // The runtime asks main to open/switch/close tabs (main owns view
      // lifecycle); the runtime only routes RPCs + mirrors the group.
      onActionActivity: (sessionId, workbenchId, active) => {
        _touchMaterializedView(
          workbenchId || activeViewId(sessionId),
          active ? 'agent-action-active' : 'agent-action-finished'
        )
        syncSessionBackgroundThrottling(sessionId)
      },
      // This is the renderer's layout lock, separate from the delayed visual
      // control badge. It flips at the logical control/action boundary, so a
      // hidden browser is revealed before page-operation visuals finish arming.
      onOperatingStateChange: (sessionId, workbenchId, active) => {
        _touchMaterializedView(
          workbenchId || activeViewId(sessionId),
          active ? 'agent-operating-started' : 'agent-operating-finished'
        )
        _publishBrowserOperatingState(sessionId, active)
        syncSessionBackgroundThrottling(sessionId)
      },
      tabController: {
        closeTab: (sessionId, tabId) => removeTab(sessionId, tabId),
        materializeTab: (sessionId, tabId) => ensureTabMaterialized(sessionId, tabId),
        openTab: (sessionId, url) => addTab(sessionId, url, 'agent'),
        resolveTab: (sessionId, reference) => browserSessionController.resolveTabRef(sessionId, reference),
        switchTab: (sessionId, tabId) => setActiveTab(sessionId, tabId, 'agent'),
      }
    })
    for (const type of FORWARDED_BROWSER_EVENTS) {
      browserRuntime.eventBus.on(type, event => _handleBrowserRuntimeEvent(event))
    }
  }
  return browserRuntime
}

async function ensureBrowserRuntimeServer() {
  if (!browserRuntimeServerPromise) {
    const token = crypto.randomBytes(32).toString('base64url')
    const runtime = ensureBrowserRuntime()
    const rpcServer = createBrowserRuntimeRpcServer({
      runtime,
      token,
      log: message => _browserLog(message),
      protectedFileRoots: BROWSER_PROTECTED_FILE_ROOTS
    })
    browserRuntimeServerPromise = rpcServer.listen(0, '127.0.0.1').then(info => {
      _browserLog(`runtime rpc listening at ${info.url}`)
      browserRuntimeServerInfo = { ...info, token }
      return browserRuntimeServerInfo
    })
  }
  return browserRuntimeServerPromise
}

function closeBrowserRuntime() {
  const serverInfo = browserRuntimeServerInfo
  browserRuntimeServerInfo = null
  browserRuntimeServerPromise = null
  if (serverInfo) {
    void serverInfo.close().catch(err => _browserLog(`runtime rpc close failed: ${err?.message || err}`))
  }
  if (browserRuntime) {
    void browserRuntime.stop().catch(err => _browserLog(`runtime stop failed: ${err?.message || err}`))
  }
}

function _browserLog(msg) {
  rememberLog(`[browser] ${msg}`)
}

function getBrowserView(id) {
  return browserViews.get(String(id))
}

// Resolve a session id to its ACTIVE tab's view id. Falls back to the id itself
// for a non-grouped id (a raw tab id, or a single-tab session) so callers that
// already pass a view id still work.
function activeViewId(id) {
  const key = String(id)
  return String(browserSessionController.activeTabId(key) || key)
}

// Reconcile the native foreground surface. A new View stays behind the React
// placeholder until its first usable document; after that, Chromium remains
// visible during every load, redirect and history transition.
function reconcileBrowserPresentation(sessionId) {
  const key = String(sessionId || '')
  if (!key) return false

  const state = browserPresentation.snapshot(key)
  const activeId = state.activeTabId || activeViewId(key)
  const activeView = getBrowserView(activeId)

  // Background sessions can continue loading, but may never paint over the
  // foreground workbench. Overview has its own explicit live-tile pipeline.
  if (foregroundSessionKey !== key) {
    if (!overviewTileIds.has(key) && activeView) browserViewLifecycle.detach(activeView)
    return false
  }

  // The primary surface owns exactly one native page view. Hide every sibling
  // and every other session before revealing the selected ready view.
  for (const [viewId, view] of browserViews) {
    if (viewId !== activeId) browserViewLifecycle.detach(view)
  }

  if (!activeView) return false

  const rect = browserPresentation.surfaceRect(key) || lastHostRect.get(key)
  if (rect) {
    const bounds = {
      x: Math.round(rect.x || 0),
      y: Math.round(rect.y || 0),
      width: Math.max(0, Math.round(rect.width || 0)),
      height: Math.max(0, Math.round(rect.height || 0))
    }
    activeView.setBounds(bounds)
  }

  const hasSurface = Boolean(rect && Number(rect.width) > 0 && Number(rect.height) > 0)
  const canPaint = Boolean(state.nativeVisible && hasSurface)
  let nativeVisible = false
  if (canPaint) {
    nativeVisible = browserViewLifecycle.show(activeView)
  } else if (state.phase === 'blank' || state.phase === 'preparing' || state.phase === 'loading') {
    // A freshly materialized workbench is still about:blank when the agent
    // issues its first Page.navigate. Keep that foreground target in the native
    // hierarchy (but invisible) before the navigation begins; waiting until
    // did-start-navigation to attach creates a deadlock because detached blank
    // targets on macOS may never emit that event. Background sessions are
    // already rejected above, so this does not retain inactive page surfaces.
    browserViewLifecycle.prepare(activeView)
  } else {
    browserViewLifecycle.detach(activeView)
  }

  // Modal scrim remains the top-most native layer if a modal is open. This is
  // intentionally after page visibility, so page lifecycle cannot reorder it.
  if (nativeVisible) ensureScrimOnTop()
  return nativeVisible
}

// The governor owns only budget/timing/LRU policy. Main remains the sole owner
// of browserViews, protection decisions and native WebContentsView disposal.

function _totalRssMB() {
  const metrics = app.getAppMetrics ? app.getAppMetrics() || [] : []
  let kb = 0
  for (const m of metrics) kb += (m.memory && m.memory.workingSetSize) || 0
  return kb / 1024
}

// Never evict the visible/active operating view or anything touched within the
// keepalive grace. Older INACTIVE tabs of an operating session may become lazy
// placeholders; protecting every sibling made the memory budget unenforceable.
function _viewProtectionReason(viewId) {
  const vid = String(viewId)
  const sessionId = vid.split('#')[0]
  const active = activeViewId(sessionId) === vid
  // Public action timeouts do not cancel their underlying CDP work. Protect the
  // exact View until that operation really settles, even after a tab switch.
  if (browserRuntime?.isWorkbenchBusy?.(vid)) return 'agent-action'
  if (active && isSessionOperating(sessionId)) return 'agent-session'
  if (sessionId === foregroundSessionKey && activeViewId(sessionId) === vid) return 'foreground'
  // A session floated as a LIVE overview tile is on-screen being watched — never
  // evict its active view mid-view (the tile would blank AND orphan its click-
  // catcher; a static overview does not continuously refresh its activity).
  if (overviewTileIds.has(sessionId) && activeViewId(sessionId) === vid) return 'overview-live'
  if (browserResourceGovernor.isWithinKeepalive(vid)) return 'keepalive'
  return null
}

function _canEvictView(viewId) {
  return _viewProtectionReason(viewId) === null
}

function evictView(viewId, reason) {
  const vid = String(viewId)
  const view = browserViews.get(vid)
  if (!view) return false
  const sessionId = vid.split('#')[0]
  // Eviction keeps the logical tab but replaces its native View later. Any
  // Agent result lease bound to this concrete View must die before Runtime/CDP
  // teardown; the rematerialized tab starts with a new viewEpoch.
  browserNavigationController.cancelTab(vid)
  // Refresh the placeholder meta FIRST so rematerialize returns to the page the
  // user actually left, not the restore-era url.
  const group = browserSessionController.runtimeSnapshot(sessionId)
  if (group) {
    const wc = view.webContents
    const alive = wc && !wc.isDestroyed()
    const prev = group.tabMeta[vid]
    // about:blank is a rebuild artifact, never a page worth remembering — let
    // the fallbacks win or an evict after a blank rebuild would permanently
    // overwrite the tab's real url in the persisted snapshot.
    let liveUrl = ''
    let liveTitle = ''
    if (alive) {
      try {
        liveUrl = wc.getURL()
        liveTitle = wc.getTitle()
      } catch {
        // A renderer can disappear between isDestroyed() and metadata reads.
      }
    }
    const metadataTransition = browserSessionController.patchTabMeta(sessionId, vid, {
      url: (liveUrl && liveUrl !== 'about:blank' ? liveUrl : '') || lastUrlByView.get(vid) || prev?.url || '',
      title: liveTitle || prev?.title || '',
      favicon: faviconByView.get(vid) || prev?.favicon || ''
    })
    if (metadataTransition.changed) {
      // Runtime and React consume immutable projections. Metadata written by
      // eviction must be published just like an ordinary controller transition.
      _syncSessionTopology(sessionId, { source: 'system' })
    }
  }
  if (browserRuntime) browserRuntime.unregisterWorkbench(vid).catch(() => undefined)
  // The tab metadata survives eviction, but its native surface does not. Keep
  // presentation truthful until setActiveTab materializes a replacement view.
  browserPresentation.suspendTab({ workbenchId: sessionId, tabId: vid })
  browserTabManager.unregisterView(vid, view)
  browserViewLifecycle.dispose(view)
  browserResourceGovernor.forget(vid)
  viewCrashTimes.delete(vid)
  // Eviction releases renderer memory, not user browsing data. HTTP and code
  // caches are disk-backed recovery assets; clearing them here turned every
  // rematerialization into a network cold start. Durable session deletion still
  // clears them in _reapPartition().
  const sessionStillLive = [...browserViews.keys()].some(
    otherId => String(otherId).split('#')[0] === sessionId
  )
  if (!sessionStillLive) destroyOverviewCatcher(sessionId)
  _browserLog(`evictView(${reason}): ${vid} (live=${browserViews.size})`)
  return true
}

const browserResourceGovernor = new BrowserResourceGovernor({
  getLiveViewIds: () => browserViews.keys(),
  getRetentionClass: viewId => {
    const vid = String(viewId)
    const sessionId = vid.split('#')[0]
    return activeViewId(sessionId) === vid ? 'background-active' : 'inactive'
  },
  canEvict: _canEvictView,
  evict: evictView,
  getTotalRssMB: _totalRssMB,
  getTotalMemoryBytes: () => os.totalmem(),
  log: message => _browserLog(message)
})

// ── Phase-4 disk hygiene ─────────────────────────────────────────────────────

// A real delete and a rapid same-id recreate share one persistent partition.
// Serialize that boundary so the old delete can never clear the replacement's
// cookies/storage after an await.
const partitionReapPromises = new Map()
// A durable session delete is final for the lifetime of this process. Renderer
// effects that were already awaiting persisted state must not recreate it after
// the delete IPC wins the race.
const deletedBrowserSessionIds = new Set()

async function waitForPartitionReap(sessionId) {
  const pending = partitionReapPromises.get(String(sessionId))
  if (pending) await pending
}

// Purge a session's on-disk partition. ONLY for a REAL delete (never archive —
// archived sessions must keep cookies/logins to resume). Storage cleared via
// the Session API first, then the partition dir removed best-effort.
async function _reapPartition(sessionId, beforeReap = null) {
  const key = String(sessionId)
  const existing = partitionReapPromises.get(key)
  if (existing) return existing

  let task
  task = (async () => {
    if (beforeReap) await beforeReap
    try {
      const sess = session.fromPartition(`persist:fan-browser-${key}`)
      await sess.clearStorageData().catch(() => undefined)
      if (typeof sess.clearCodeCaches === 'function') await sess.clearCodeCaches({}).catch(() => undefined)
      await sess.clearCache().catch(() => undefined)
    } catch (err) {
      _browserLog(`reap clearStorage failed for ${key}: ${err?.message || err}`)
    }
    try {
      await fs.promises.rm(path.join(app.getPath('userData'), 'Partitions', `fan-browser-${key}`), {
        recursive: true,
        force: true
      })
      _browserLog(`reaped partition fan-browser-${key}`)
    } catch (err) {
      _browserLog(`reap rm failed for ${key}: ${err?.message || err}`)
    } finally {
      if (partitionReapPromises.get(key) === task) partitionReapPromises.delete(key)
    }
  })()
  partitionReapPromises.set(key, task)
  return task
}

// Startup reaper for orphaned DRAFT partitions. A draft that became a session
// migrated to persist:fan-browser-<session_key>; one abandoned before first
// send left its dir behind forever (measured: 29 dirs = 256MB). At app-ready no
// draft can be live yet (the renderer hasn't booted), and any draft created
// later mints a fresh uuid, so everything matching draft-* here is garbage by
// construction. Non-draft partitions are NEVER touched (they may hold logins
// for resumable sessions).
async function reapOrphanDraftPartitions() {
  const root = path.join(app.getPath('userData'), 'Partitions')
  let entries = []
  try {
    entries = await fs.promises.readdir(root)
  } catch {
    return
  }
  const orphans = entries.filter(name => name.startsWith('fan-browser-draft-'))
  if (!orphans.length) return
  for (const name of orphans) {
    await fs.promises.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined)
  }
  _browserLog(`startup reaper: removed ${orphans.length} orphan draft partition(s)`)
}

// The last host rect the renderer pushed per session, so a newly-foregrounded
// tab can be placed where the previous active tab was.
const lastHostRect = new Map() // sessionId -> rect
// The last real URL each view loaded, so a crashed renderer can be rebuilt where
// it was instead of leaving a dead, un-navigable view.
const lastUrlByView = new Map() // viewId -> url
const faviconByView = new Map() // viewId -> favicon URL (site's own icon, '' = none)
// A tab id can be rebuilt after a renderer crash or lazy-session recovery. The
// epoch lets the presentation state reject events from the dead WebContents.
const viewEpochById = new Map()
// Monotonic top-level document commit count per logical tab. It is observation
// metadata, not a navigation gate: redirects and cross-site landings simply
// advance it and Chromium remains in charge of what is displayed.
const documentRevisionByView = new Map()

// The full browser surface sits inside a 10px glass viewport. Canvas overview
// tiles use the card's 20px radius instead: leaving the native view at 10px
// lets its page-level operating aura protrude through the two lower corners.
const BROWSER_SURFACE_BORDER_RADIUS = 10
const OVERVIEW_TILE_BORDER_RADIUS = 20

function setNativeViewBorderRadius(view, radius) {
  if (typeof view?.setBorderRadius !== 'function') return false
  try {
    view.setBorderRadius(radius)
    return true
  } catch {
    // Electron versions without the native API fall back to square corners.
    return false
  }
}

// Pages built for a desktop viewport (~1100 logical px) overflow in a narrow
// embedded pane (e.g. baidu — h-scrollbar, oversized logo). Fit-to-width: when
// the pane is narrower than this, zoom the whole page down proportionally; never
// zoom IN past 1. MUST be applied after did-finish-load (a pre-load zoom is reset
// to 1 by Electron). Env-tunable.
const BROWSER_FIT_VIEWPORT_WIDTH = Math.max(600, Number(process.env.ELECTRON_BROWSER_FIT_WIDTH) || 1280)
// A new/background Task Space can be driven before React has mounted its
// visible browser pane and sent host bounds. Chromium lays responsive pages out
// against the native View size, so leaving a newborn WebContentsView at 0x0
// produces a real but unusable DOM snapshot (wrong wrapping, geometry and
// pointer targets). Give every view a desktop-sized offscreen viewport from
// birth; the renderer's first setBrowserViewBounds call remains authoritative.
const BROWSER_DEFAULT_VIEWPORT_HEIGHT = 800
const _fitZoom = w => Math.min(1, (Number(w) || 0) / BROWSER_FIT_VIEWPORT_WIDTH)
const initialBrowserViewBounds = sessionId => {
  const host = lastHostRect.get(String(sessionId))
  if (Number(host?.width) > 0 && Number(host?.height) > 0) {
    return {
      x: Math.round(Number(host.x) || 0),
      y: Math.round(Number(host.y) || 0),
      width: Math.round(Number(host.width)),
      height: Math.round(Number(host.height))
    }
  }
  return {
    x: 0,
    y: 0,
    width: BROWSER_FIT_VIEWPORT_WIDTH,
    height: BROWSER_DEFAULT_VIEWPORT_HEIGHT
  }
}
// The session the user is currently VIEWING (set by the renderer's
// setVisible(true) / hideAll signals). A background session's tab activity must
// never steal the foreground, so setActiveTab gates its visibility side-effects
// on this.
let foregroundSessionKey = null
// Renderer-instance lease for the single primary browser surface. React can
// remount SessionBrowser for the same workbench; without a lease, the old
// instance's passive lifecycle cleanup can arrive after the new instance's
// present call and hide the current page indefinitely.
const browserSurfaceOwnerBySession = new Map()

function normalizeBrowserSurfaceOwner(ownerId) {
  return String(ownerId || '')
    .trim()
    .slice(0, 128)
}

const browserViewLifecycle = new BrowserViewLifecycle({
  getContentView: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.contentView : null),
  log: message => _browserLog(message)
})

// The renderer declares where the primary browser surface lives; this
// controller, in the main process, is the sole authority for whether a native
// WebContentsView is actually allowed to paint there. That distinction is what
// prevents a pre-first-paint native page from replacing the loader with white.
const browserPresentation = new BrowserPresentationController({
  getActiveTabId: workbenchId => browserSessionController.activeTabId(workbenchId),
  onChange: state => {
    // Reconcile first: renderer-facing nativeVisible is evidence that attach +
    // setVisible succeeded, not merely the controller's permission to try.
    // Projection failures must never interrupt the controller transaction.
    let nativeVisible = false
    try {
      nativeVisible = reconcileBrowserPresentation(state.workbenchId)
    } catch (error) {
      _browserLog(`presentation reconcile failed for ${state.workbenchId}: ${error?.message || error}`)
    }
    try {
      _sendBrowserEvent('presentation.state', {
        ...state,
        nativeVisible: Boolean(state.nativeVisible && nativeVisible)
      })
    } catch (error) {
      _browserLog(`presentation event failed for ${state.workbenchId}: ${error?.message || error}`)
    }
  }
})

const browserNavigationController = new BrowserNavigationController({
  getView: tabId => browserViews.get(String(tabId || '')) || null,
  getViewEpoch: tabId => viewEpochById.get(String(tabId || '')) || 0,
  sessions: browserSessionController
})

const browserShellController = new BrowserShellController({
  emit: (type, payload) => _sendBrowserEvent(type, payload),
  log: message => _browserLog(message),
  openExternal: async targetUrl => {
    if (browserProtocolKind(targetUrl).kind !== 'external') {
      throw new Error('Refusing to open a non-external browser URL')
    }
    await shell.openExternal(targetUrl)
    return true
  },
  openPath: async targetPath => {
    try {
      await fs.promises.access(targetPath, fs.constants.F_OK)
    } catch {
      return false
    }
    return shell.openPath(targetPath)
  },
  revealPath: targetPath => {
    if (!fs.existsSync(targetPath)) return false
    shell.showItemInFolder(targetPath)
    return true
  }
})

function raiseBrowserShellNotice(scope, code, level = 'warning', actions = []) {
  if (!scope?.workbenchId) return { ok: false, reason: 'invalid-scope' }
  return browserShellController.raiseNotice({ ...scope, actions, code, level })
}

function requestExternalBrowserApplication({ url, workbenchId, tabId, documentRevision, source = 'page' } = {}) {
  const protocol = browserProtocolKind(url)
  const scope = browserDocumentScope(workbenchId, tabId)
  if (protocol.kind !== 'external') {
    if (protocol.kind === 'blocked' && scope.workbenchId) {
      raiseBrowserShellNotice(scope, 'unsafe-protocol-blocked', 'warning')
    }
    return { ok: false, reason: protocol.kind === 'blocked' ? 'blocked-protocol' : 'not-external' }
  }
  return browserShellController.requestExternalOpen({
    ...scope,
    ...(documentRevision == null ? {} : { documentRevision }),
    code: 'external-application-requested',
    host: browserTabHost(scope.tabId),
    key: String(url || ''),
    message: `当前页面希望打开 ${protocol.protocol.replace(/:$/, '')} 外部应用。`,
    privateData: { source },
    url
  })
}

function settlePermissionWaiters(key, accepted) {
  const pending = browserPermissionWaiters.get(key)
  browserPermissionWaiters.delete(key)
  let handled = false
  for (const respond of pending?.responders || []) {
    try {
      if (respond(Boolean(accepted)) !== false) handled = true
    } catch (error) {
      _browserLog(`browser permission response failed: ${error?.message || error}`)
    }
  }
  return handled
}

function routeBrowserPermissionRequest(request = {}) {
  const permission = normalizeBrowserPermission(request.permission)
  const scope = browserDocumentScope(request.workbenchId || request.sessionId, request.tabId || request.id)
  const externalUrl = String(request.details?.externalURL || '')
  if (browserPermissionRequiresExternalConfirmation(permission) || externalUrl) {
    // Chromium's native permission continuation is denied. An accepted Browser
    // Shell prompt opens the exact URL once through shell.openExternal instead.
    request.respond?.(false)
    const result = requestExternalBrowserApplication({
      ...scope,
      source: 'permission',
      url: externalUrl
    })
    if (!result.ok && result.reason !== 'not-external') {
      raiseBrowserShellNotice(scope, 'external-application-blocked', 'warning')
    }
    return undefined
  }

  if (!permission) {
    request.respond?.(false)
    return undefined
  }

  // Every real browser permission except microphone, camera and geolocation is
  // approved immediately. Those three (including Electron's media/capture
  // aliases) continue through the user-facing Browser Shell prompt below.
  if (browserPermissionAllowedByDefault(permission)) {
    request.respond?.(true)
    return undefined
  }

  const key = [scope.workbenchId, scope.tabId, scope.documentRevision, permission].join('\0')
  const existing = browserPermissionWaiters.get(key)
  if (existing) {
    existing.responders.push(request.respond)
    return undefined
  }
  const pending = { eventId: '', responders: [request.respond] }
  browserPermissionWaiters.set(key, pending)
  const result = browserShellController.requestPermission({
    ...scope,
    code: 'permission-requested',
    host: browserPermissionOrigin(request.details),
    message: '当前页面请求使用浏览器权限。',
    onCancel: () => settlePermissionWaiters(key, false),
    onRespond: response => {
      if (!settlePermissionWaiters(key, response.accepted === true)) {
        throw new Error('Browser permission request is no longer pending')
      }
    },
    permission
  })
  if (result.ok) pending.eventId = result.eventId
  else settlePermissionWaiters(key, false)
  return undefined
}

function routeBrowserDialog(request = {}) {
  const dialog = request.dialog || {}
  const dialogId = String(dialog.dialogId || '')
  const dialogType = String(dialog.type || '').toLowerCase()
  const beforeUnload = dialogType === 'beforeunload'
  const scope = browserDocumentScope(request.workbenchId || request.sessionId, request.tabId || request.id)
  const settle = decision => {
    if (dialogId) browserDialogPromptIds.delete(dialogId)
    return request.respond?.(decision)
  }
  const result = browserShellController.requestPrompt({
    ...scope,
    actions: beforeUnload
      ? ['stay', 'leave']
      : dialogType === 'alert'
        ? ['ok']
        : ['cancel', 'ok'],
    code: beforeUnload ? 'beforeunload-requested' : 'javascript-dialog-requested',
    defaultValue: dialog.defaultPrompt || '',
    dialogType,
    key: dialogId || `${dialogType}:${dialog.message || ''}`,
    kind: beforeUnload ? 'beforeunload' : 'javascript-dialog',
    message: String(dialog.message || ''),
    onCancel: () => settle('dismiss'),
    onRespond: response =>
      settle({
        action: response.accepted === true ? 'accept' : 'dismiss',
        promptText: response.value
      })
  })
  if (result.ok && dialogId) browserDialogPromptIds.set(dialogId, result.eventId)
  return result.ok ? undefined : 'dismiss'
}

function translateBrowserDownloadEvent(type, payload = {}) {
  const scope = browserDocumentScope(payload.workbenchId || payload.sessionId, payload.tabId || payload.id)
  const nativeDownload = payload.download && typeof payload.download === 'object' ? payload.download : {}
  const nativeId = String(payload.downloadId || nativeDownload.downloadId || '')
  if (!scope.workbenchId || !scope.tabId || !nativeId) return false
  const mapKey = `${scope.workbenchId}\0${nativeId}`
  let eventId = browserShellDownloadIds.get(mapKey)
  const stateMap = {
    cancelled: 'cancelled',
    completed: 'completed',
    failed: 'failed',
    in_progress: 'progressing',
    interrupted: 'interrupted',
    paused: 'paused'
  }
  const state = stateMap[String(payload.state || nativeDownload.state || '').toLowerCase()] || 'progressing'
  const update = {
    ...scope,
    filename: nativeDownload.filename,
    receivedBytes: nativeDownload.receivedBytes,
    savePath: nativeDownload.savePath,
    sourceKey: nativeId,
    state,
    totalBytes: nativeDownload.totalBytes,
    url: nativeDownload.url
  }
  if (!eventId || type === 'download.started') {
    const started = browserShellController.downloadStarted(update)
    if (!started.ok) return false
    eventId = started.eventId
    browserShellDownloadIds.set(mapKey, eventId)
  }
  const done = payload.done === true || ['cancelled', 'completed', 'failed', 'interrupted'].includes(state)
  if (type !== 'download.started') {
    if (done) browserShellController.downloadDone(eventId, update)
    else browserShellController.downloadProgress(eventId, update)
  }
  return true
}

const browserPopupController = new BrowserPopupController({
  cleanupFailedTabCreation: (...args) => cleanupFailedTabCreation(...args),
  createTabView: (...args) => _createTabView(...args),
  createView: (webContents, webPreferences) =>
    webContents
      ? new WebContentsView({ webContents })
      : new WebContentsView({ webPreferences }),
  ensureRuntime: () => ensureBrowserRuntime(),
  getView: tabId => browserViews.get(String(tabId || '')) || null,
  getViewCount: () => browserViews.size,
  isSessionOperating,
  log: message => _browserLog(message),
  maxTabsPerSession: MAX_TABS_PER_SESSION,
  maxTotalViews: MAX_TOTAL_BROWSER_VIEWS,
  onDenied: event => {
    const scope = browserDocumentScope(event.sessionId, event.sourceTabId)
    const reason = String(event.reason || '')
    const code = ['popup-flood', 'tab-limit', 'view-limit'].includes(reason)
      ? reason
      : 'popup-blocked'
    raiseBrowserShellNotice(scope, code, 'warning')
  },
  partitionNameFor: sessionId => `persist:fan-browser-${String(sessionId || '')}`,
  resourceGovernor: browserResourceGovernor,
  sessions: browserSessionController,
  setActiveTab: (...args) => setActiveTab(...args),
  syncTopology: (...args) => _syncSessionTopology(...args)
})

const browserSessionProjector = new BrowserSessionProjector({
  emit: (type, payload) => _sendBrowserEvent(type, payload),
  getFavicon: tabId => faviconByView.get(String(tabId || '')) || '',
  getFaviconPending: (sessionId, tabId) => {
    const state = browserPresentation.tabSnapshot(String(sessionId || ''), String(tabId || ''))
    return Boolean(state?.loading && !state.error)
  },
  getLoadFailed: (sessionId, tabId) =>
    browserPresentation.tabSnapshot(String(sessionId || ''), String(tabId || ''))?.phase === 'failed',
  getRuntime: () => browserRuntime,
  getView: tabId => browserViews.get(String(tabId || '')) || null,
  log: message => _browserLog(message),
  sessions: browserSessionController,
  syncThrottling: sessionId => syncSessionBackgroundThrottling(sessionId)
})

const browserTabManager = new BrowserTabManager({
  anchorBySession,
  browserViewInitialLoads,
  browserViews,
  createTabView: (...args) => _createTabView(...args),
  deletedBrowserSessionIds,
  documentRevisionByView,
  destroyOverviewCatcher: sessionId => destroyOverviewCatcher(sessionId),
  destroySessionForRestore: sessionId => destroyBrowserView(sessionId, false),
  emit: (type, payload) => _sendBrowserEvent(type, payload),
  ensureRuntime: () => ensureBrowserRuntime(),
  evictView: (...args) => evictView(...args),
  faviconByView,
  flagSessionIntervention: (...args) => flagSessionIntervention(...args),
  getForegroundSession: () => foregroundSessionKey,
  getNavState: sessionId => getBrowserViewNavState(sessionId),
  getRuntime: () => browserRuntime,
  isSessionOperating,
  lastHostRect,
  lastUrlByView,
  log: message => _browserLog(message),
  maxTabsPerSession: MAX_TABS_PER_SESSION,
  maxTotalViews: MAX_TOTAL_BROWSER_VIEWS,
  overviewTileIds,
  overviewTileRects,
  popupController: browserPopupController,
  presentation: browserPresentation,
  reapPartition: (...args) => _reapPartition(...args),
  reconcilePresentation: sessionId => reconcileBrowserPresentation(sessionId),
  recoveringSessions,
  refreshOverviewTile: sessionId => refreshOverviewTileFor(sessionId),
  resourceGovernor: browserResourceGovernor,
  sessions: browserSessionController,
  setForegroundSession: sessionId => { foregroundSessionKey = sessionId },
  syncTopology: (...args) => _syncSessionTopology(...args),
  viewCrashTimes,
  viewEpochById,
  viewLifecycle: browserViewLifecycle,
  waitForPartitionReap: sessionId => waitForPartitionReap(sessionId)
})

// Create one tab's WebContentsView under a session. Tabs share the SESSION
// partition (cookies/login shared across tabs, like a real browser profile).
// nav events report at the SESSION level (active-tab state) so the renderer
// chrome follows the active tab regardless of which tab fired the event.
function _createTabView(viewId, sessionId, url, options = {}) {
  // Bounded pool admission (Phase 2): make room by LRU-evicting BEFORE the new
  // renderer is born. Single seam — every view birth passes through here.
  if (!options.admitted) {
    browserResourceGovernor.evictToAdmit()
  }
  // Native close may finish asynchronously. Pending disposals still consume
  // renderer memory and count against the structural safety cap.
  const materializedViewCount = browserViews.size + browserViewLifecycle.pendingViews().length
  if (materializedViewCount >= MAX_TOTAL_BROWSER_VIEWS) {
    throw new Error(`Browser view limit reached (${MAX_TOTAL_BROWSER_VIEWS})`)
  }
  const sess = session.fromPartition(`persist:fan-browser-${sessionId}`)
  // Install credential boundaries before the first loadURL. This covers
  // redirects, frames and page-initiated fetch/XHR while preserving ordinary
  // localhost, private-LAN and non-sensitive file:// browser automation.
  installBrowserRequestGuard(sess, { protectedFileRoots: BROWSER_PROTECTED_FILE_ROOTS })
  // Electron already uses the operating-system proxy by default. Explicitly
  // resetting it here races the first navigation on fresh partitions and makes
  // connectivity depend on one developer's local proxy setup.
  const view =
    options.view ||
    new WebContentsView({
    // Idle/hidden pages use Chromium's normal throttling. A session actively
    // driven by the agent opts out below and is restored to normal immediately
    // at the turn boundary, so automation remains reliable without keeping
    // every historical page at full speed.
    webPreferences: {
      session: sess,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: !isSessionOperating(String(sessionId))
      }
    })
  const logicalViewId = String(viewId)
  const newlyMarkedPageOpened = Boolean(options.pageOpened && !pageOpenedBrowserTabIds.has(logicalViewId))
  if (options.pageOpened) pageOpenedBrowserTabIds.add(logicalViewId)
  const hadViewEpoch = viewEpochById.has(logicalViewId)
  const priorEpoch = viewEpochById.get(logicalViewId) || 0
  const hadDocumentRevision = documentRevisionByView.has(logicalViewId)
  const initialDocumentRevision = documentRevisionByView.get(logicalViewId) || 0
  let presentationRegistered = false
  try {
  // Transparent until the page paints: a freshly-attached WebContentsView is
  // WHITE by default, which flashed a stark rectangle over the glass pane every
  // time a workbench opened. With a transparent base the loading period shows
  // the renderer's styled pane underneath; the page's own background covers it
  // on first paint.
  view.setBackgroundColor('#00000000')
  // Round the view's own corners (Electron 36+ native API) to ~match the host's
  // rounded glass viewport (rounded-[0.625rem] = 10px), so the page content is
  // no longer a hard square inside a rounded frame — and during agent takeover
  // it lines up with the rounded operating aura. CSS can't clip a native view,
  // so this is the only way to soften the OS-level surface's corners.
  setNativeViewBorderRadius(view, BROWSER_SURFACE_BORDER_RADIUS)
  view.setVisible(false)
  // Do this before the View joins the native hierarchy or loads its first
  // document. A later host rectangle may resize it, but no navigation or
  // snapshot is ever allowed to observe a zero-sized layout viewport.
  try {
    const currentBounds = typeof view.getBounds === 'function' ? view.getBounds() : null
    if (!(Number(currentBounds?.width) > 0 && Number(currentBounds?.height) > 0)) {
      view.setBounds(initialBrowserViewBounds(sessionId))
    }
  } catch (error) {
    _browserLog(`browser view initial bounds failed for ${viewId}: ${error?.message || error}`)
  }
  const wc = view.webContents
  try {
    // Browser-page keyboard input (including Agent-generated CDP key events)
    // belongs to the page, never Fan's application menu. Scope the isolation to
    // the visible browser-tool lifetime so normal host shortcuts return as soon
    // as automation ends.
    wc.setIgnoreMenuShortcuts(isSessionVisuallyOperating(String(sessionId)))
  } catch (error) {
    _browserLog(`browser menu shortcut isolation failed for ${viewId}: ${error?.message || error}`)
  }
  installContextMenu(wc, {
    navigation: true,
    ownerWindow: mainWindow,
    openLink: targetUrl => {
      const protocol = browserProtocolKind(targetUrl)
      const scope = browserDocumentScope(sessionId, viewId)
      if (protocol.kind === 'in-app') {
        void addTab(sessionId, targetUrl, 'user')
        return
      }
      if (protocol.kind === 'external') {
        requestExternalBrowserApplication({ ...scope, source: 'context-menu', url: targetUrl })
        return
      }
      raiseBrowserShellNotice(
        scope,
        protocol.kind === 'blocked' ? 'unsafe-protocol-blocked' : 'invalid-link-url',
        'warning'
      )
    }
  })
  wc.on('will-frame-navigate', details => {
    if (browserViews.get(String(viewId)) !== view) return
    const targetUrl = String(details?.url || '')
    const protocol = browserProtocolKind(targetUrl)
    if (protocol.kind === 'in-app' || protocol.kind === 'invalid') return
    details.preventDefault?.()
    const scope = browserDocumentScope(sessionId, viewId)
    if (protocol.kind === 'external') {
      requestExternalBrowserApplication({ ...scope, source: 'frame-navigation', url: targetUrl })
    } else {
      raiseBrowserShellNotice(scope, 'unsafe-protocol-blocked', 'warning')
    }
  })
  const viewEpoch = priorEpoch + 1
  viewEpochById.set(logicalViewId, viewEpoch)
  documentRevisionByView.set(logicalViewId, initialDocumentRevision)
  const initialUrl = String(url || 'about:blank')
  if (priorEpoch > 0 || browserPresentation.tabSnapshot(sessionId, viewId)) {
    browserPresentation.replaceTabView({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      documentRevision: initialDocumentRevision,
      allowBlankReady: Boolean(options.allowBlankReady),
      url: initialUrl
    })
  } else {
    browserPresentation.registerTab({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      documentRevision: initialDocumentRevision,
      allowBlankReady: Boolean(options.allowBlankReady),
      url: initialUrl
    })
  }
  presentationRegistered = true
  const applyFitZoom = () => {
    try {
      const b = view.getBounds()
      if (b.width > 0 && typeof wc.setZoomFactor === 'function') wc.setZoomFactor(_fitZoom(b.width))
    } catch (err) {
      void err
    }
  }
  const ensureLoadSurfaceAttached = () => {
    if (browserViewLifecycle.isAttached(view)) return
    const rect = lastHostRect.get(String(sessionId))
    if (rect) {
      try {
        view.setBounds({
          x: Math.round(rect.x || 0),
          y: Math.round(rect.y || 0),
          width: Math.max(0, Math.round(rect.width || 0)),
          height: Math.max(0, Math.round(rect.height || 0))
        })
      } catch (error) {
        _browserLog(`browser view load bounds failed for ${viewId}: ${error?.message || error}`)
      }
    }
    // A detached WebContents can execute and navigate, but macOS may not
    // produce a capturable compositor frame until its View joins a native
    // hierarchy. Keep it invisible while loading; presentation reconciliation
    // shows the foreground page or detaches a background page after ready.
    browserViewLifecycle.prepare(view)
    ensureScrimOnTop()
  }
  const pushNavState = () => {
    if (browserViews.get(String(viewId)) !== view) return
    const current = typeof wc.getURL === 'function' ? wc.getURL() : ''
    if (current && current !== 'about:blank') lastUrlByView.set(String(viewId), current)
    // Page lifecycle is metadata, not proof of user intent. Hidden sites may
    // update their title, route or document forever; treating those events as
    // activity lets a detached page renew its own retention deadline. Foreground
    // visibility, tab switches and Agent actions stamp the governor explicitly.
    // zoom is PER-ORIGIN and resets to 1 on every new origin. Re-apply it on each
    // nav event (incl. did-navigate, which fires before first paint of the new
    // page) so the first frame is already scaled — kills the big->small flash.
    applyFitZoom()
    _sendBrowserEvent('nav.state', { id: sessionId, ...getBrowserViewNavState(sessionId) })
    _emitTabsState(sessionId)
  }
  let adoptedGuestSettled = options.loadInitial !== false
  // Monotonic within this concrete WebContents. The View epoch rejects events
  // from a destroyed/rebuilt WebContents; this navigation epoch separates
  // successive top-level documents inside the surviving WebContents.
  let navigationEpoch = 0
  const pendingNavigationAttempts = new PendingNavigationAttempts({ limit: 16 })
  let initialLoadAttemptEpoch = null
  let initialLoadPending = options.loadInitial !== false
  let faviconEventSequence = 0
  let currentDocumentReadyFence = null
  const isChromiumErrorDocument = targetUrl => String(targetUrl || '').startsWith('chrome-error://')
  const faviconDocumentGate = createFaviconDocumentGate({
    documentRevision: initialDocumentRevision,
    navigationEpoch,
    viewEpoch
  })
  const invalidateCurrentFavicon = ({ forcePublish = false, publish = true } = {}) => {
    faviconEventSequence += 1
    faviconDocumentGate.invalidate()
    const targetId = String(viewId)
    const liveChanged = faviconByView.delete(targetId)
    const metadataTransition = browserSessionController.patchTabMeta(sessionId, targetId, { favicon: '' })

    if (publish && (forcePublish || liveChanged || metadataTransition.changed)) {
      if (metadataTransition.changed) _syncSessionTopology(sessionId, { source: 'page' })
      else _emitTabsState(sessionId)
    }

    return liveChanged || metadataTransition.changed
  }
  const settleAdoptedGuestIfReady = () => {
    if (adoptedGuestSettled || browserViews.get(String(viewId)) !== view || wc.isDestroyed?.()) return false
    const loading = typeof wc.isLoadingMainFrame === 'function' ? wc.isLoadingMainFrame() : wc.isLoading?.()
    if (loading) return false

    adoptedGuestSettled = true
    const adoptedUrl = String(wc.getURL?.() || 'about:blank')
    const observedDocumentRevision = documentRevisionByView.get(String(viewId)) || 0
    const adoptedDocumentRevision = observedDocumentRevision > initialDocumentRevision
      ? observedDocumentRevision
      : initialDocumentRevision + 1
    documentRevisionByView.set(String(viewId), adoptedDocumentRevision)
    const adoptedPresentation = browserPresentation.adoptReadyDocument({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      documentRevision: adoptedDocumentRevision,
      url: adoptedUrl
    })
    if (adoptedPresentation) {
      faviconDocumentGate.bind({
        documentRevision: adoptedDocumentRevision,
        navigationEpoch: adoptedPresentation.navigationEpoch,
        viewEpoch
      })
    }
    if (adoptedUrl !== 'about:blank') {
      const meta = browserSessionController.patchTabMeta(sessionId, String(viewId), { url: adoptedUrl })
      if (meta.changed) _syncSessionTopology(sessionId, { source: 'page' })
    }
    pushNavState()
    return true
  }
  // Chromium owns normal browsing. This event establishes the top-level
  // navigation identity before any failure/error-document lifecycle events.
  wc.on('did-start-navigation', (details, targetUrl, isInPlace, isMainFrame) => {
    const sameDocument =
      typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : Boolean(isInPlace)
    const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : Boolean(isMainFrame)
    if (sameDocument || !mainFrame || browserViews.get(String(viewId)) !== view) return
    const navigationUrl = String(details?.url || targetUrl || '')
    // Chromium may expose the internal document it creates for a failed load as
    // another navigation. It belongs to the failed request, not to a user retry,
    // and must not advance/clear the failure epoch.
    if (isChromiumErrorDocument(navigationUrl)) return
    void browserShellController.clearDocument({
      documentRevision: documentRevisionByView.get(String(viewId)) || 0,
      reason: 'document-navigation-started',
      tabId: String(viewId),
      workbenchId: String(sessionId)
    })
    if (currentDocumentReadyFence) {
      currentDocumentReadyFence.cancel()
      currentDocumentReadyFence = null
    }
    navigationEpoch += 1
    pendingNavigationAttempts.begin({ epoch: navigationEpoch, url: navigationUrl })
    if (initialLoadPending && initialLoadAttemptEpoch === null && sameNavigationUrl(navigationUrl, initialUrl)) {
      initialLoadAttemptEpoch = navigationEpoch
    }
    browserPresentation.beginNavigation({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      navigationEpoch
    })
    // A cross-document intent invalidates the old icon immediately. Waiting for
    // did-navigate misses connection failures because Chromium commits only its
    // internal chrome-error document in that path.
    invalidateCurrentFavicon({ forcePublish: true })
    ensureLoadSurfaceAttached()
  })
  // Redirects retain the identity of the navigation that initiated them. Add
  // every main-frame landing URL as an alias so did-fail-load can consume the
  // correct attempt even when validatedUrl is the redirect target.
  wc.on('will-redirect', (details, targetUrl, _isInPlace, isMainFrame) => {
    const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : Boolean(isMainFrame)
    if (!mainFrame || browserViews.get(String(viewId)) !== view) return
    const redirectUrl = String(details?.url || targetUrl || '')
    if (redirectUrl && !isChromiumErrorDocument(redirectUrl)) {
      pendingNavigationAttempts.addAlias(navigationEpoch, redirectUrl)
    }
  })
  wc.on('did-start-loading', () => {
    if (browserViews.get(String(viewId)) !== view) return
    browserPresentation.markLoading({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      navigationEpoch
    })
    pushNavState()
  })
  wc.on('did-stop-loading', () => {
    if (browserViews.get(String(viewId)) !== view) return
    // Backstop: a load that stops before dom-ready (error / stopped) still ends the bar.
    browserPresentation.markStopped({ workbenchId: sessionId, tabId: viewId, epoch: viewEpoch })
    pushNavState()
  })
  // User focus is KING. A loading page (Google's autofocus, a redirect chain, or
  // the view first appearing) auto-grabs OS focus and steals the user's typing
  // target — e.g. the chat input they just clicked. While the page is still
  // loading, immediately hand focus back to the app DOM (which restores the
  // previously-focused element). After load, a real user click focuses the page
  // normally — we only counter AUTOMATIC, load-time focus theft.
  wc.on('focus', () => {
    if (browserViews.get(String(viewId)) !== view) return
    if (!browserPresentation.tabSnapshot(sessionId, viewId)?.loading) return
    // An in-flight browser action intentionally owns this page. Returning focus
    // to the host here creates a cross-surface window where page input can be
    // interpreted by Fan itself (including its application menu). Keep the
    // existing user-focus guard for ordinary loading outside an active action.
    if (browserRuntime?.isWorkbenchBusy?.(String(viewId))) {
      _browserLog(`[focus-guard] ${viewId} retained browser focus mid-load for active agent action`)
      return
    }
    if (!mainWindow || mainWindow.isDestroyed()) return
    _browserLog(`[focus-guard] ${viewId} auto-grabbed focus mid-load → returned to app DOM`)
    mainWindow.webContents.focus()
  })
  // A full navigation lands on a new page whose favicon hasn't arrived yet —
  // drop the old one so the tab falls back to the globe until the real icon
  // loads (page-favicon-updated), instead of showing the previous site's icon.
  wc.on('did-navigate', (_event, targetUrl, httpResponseCode, httpStatusText) => {
    if (browserViews.get(String(viewId)) !== view) return
    const committedUrl = String(targetUrl || wc.getURL?.() || '')
    if (isChromiumErrorDocument(committedUrl)) return
    const statusCode = Number(httpResponseCode)
    // Chromium considers a received HTTP response a completed navigation, even
    // when an upstream proxy returns an empty 5xx response. Chrome's browser
    // shell supplies an error page for that case, while an embedded
    // WebContentsView would otherwise paint the empty document as a white pane.
    // Keep 4xx application pages intact; server 5xx responses are surfaced as a
    // recoverable browser failure instead.
    const serverFailure = Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599
    pendingNavigationAttempts.consumeEpoch(navigationEpoch)
    invalidateCurrentFavicon({ publish: false })
    const documentRevision = (documentRevisionByView.get(String(viewId)) || 0) + 1
    documentRevisionByView.set(String(viewId), documentRevision)
    const committedPresentation = browserPresentation.markCommitted({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      navigationEpoch,
      documentRevision,
      url: committedUrl
    })
    if (committedPresentation) {
      faviconDocumentGate.bind({ documentRevision, navigationEpoch, viewEpoch })
    }
    const meta = browserSessionController.patchTabMeta(sessionId, String(viewId), {
      url: committedUrl,
      favicon: ''
    })
    if (meta.changed) _syncSessionTopology(sessionId, { source: 'page' })
    if (serverFailure) {
      const statusText = String(httpStatusText || '').trim()
      const failedPresentation = browserPresentation.markFailed({
        workbenchId: sessionId,
        tabId: viewId,
        epoch: viewEpoch,
        navigationEpoch,
        error: {
          code: statusCode,
          description: `HTTP ERROR ${statusCode}${statusText ? `: ${statusText}` : ''}`,
          url: committedUrl
        }
      })
      if (failedPresentation) pushNavState()
      return
    }
    pushNavState()
  })
  wc.on('did-navigate-in-page', (_event, targetUrl, isMainFrame) => {
    if (!isMainFrame || browserViews.get(String(viewId)) !== view) return
    const committedUrl = String(targetUrl || wc.getURL?.() || '')
    if (isChromiumErrorDocument(committedUrl)) return
    browserPresentation.markInPage({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      url: committedUrl
    })
    const meta = browserSessionController.patchTabMeta(sessionId, String(viewId), { url: committedUrl })
    if (meta.changed) _syncSessionTopology(sessionId, { source: 'page' })
    pushNavState()
  })
  wc.on('page-title-updated', pushNavState)
  // The site's own favicon — surfaced into the tab strip via tabs.state.
  wc.on('page-favicon-updated', (_event, favicons) => {
    if (browserViews.get(String(viewId)) !== view) return
    const eventSequence = ++faviconEventSequence
    const currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
    const currentDocumentRevision = documentRevisionByView.get(String(viewId)) || 0
    const currentViewEpoch = viewEpochById.get(String(viewId)) || 0
    const documentIdentity = {
      documentRevision: currentDocumentRevision,
      navigationEpoch: currentPresentation?.navigationEpoch,
      viewEpoch: currentViewEpoch
    }
    if (
      !currentPresentation ||
      currentPresentation.error ||
      isChromiumErrorDocument(wc.getURL?.()) ||
      !faviconDocumentGate.matches(documentIdentity)
    ) {
      return
    }
    const candidates = Array.isArray(favicons) ? favicons.map(value => String(value || '')) : []
    void resolveCurrentDocumentFavicon({
      candidates,
      documentIdentity,
      gate: faviconDocumentGate,
      inspectDocument: () =>
        wc.executeJavaScript(
          `(() => ({
            documentUrl: location.href,
            declaredIcons: Array.from(document.querySelectorAll('link[rel]'))
              .filter(link => String(link.rel || '').toLowerCase().split(/\\s+/).some(token => token === 'icon'))
              .map(link => link.href)
              .filter(Boolean)
          }))()`,
          true
        ),
      isCurrent: () => {
        const presentation = browserPresentation.tabSnapshot(sessionId, viewId)
        return Boolean(
          eventSequence === faviconEventSequence &&
            browserViews.get(String(viewId)) === view &&
            !wc.isDestroyed?.() &&
            !presentation?.error &&
            !isChromiumErrorDocument(wc.getURL?.())
        )
      }
    })
      .then(result => {
        if (!result.accepted) return
        const next = result.favicon
        const targetId = String(viewId)
        const liveChanged = (faviconByView.get(targetId) || '') !== next
        if (next) faviconByView.set(targetId, next)
        else faviconByView.delete(targetId)
        // Keep the logical tab's metadata in sync too. Lazily restored tabs have
        // no live View until first activation; once materialized, this event
        // heals old rows that predate favicon persistence and survives eviction.
        const metadataTransition = browserSessionController.patchTabMeta(sessionId, targetId, { favicon: next })
        if (liveChanged || metadataTransition.changed) _emitTabsState(sessionId)
      })
      .catch(error => _browserLog(`favicon inspection failed for ${viewId}: ${error?.message || error}`))
  })
  const markCurrentDocumentReady = token => {
    if (browserViews.get(String(viewId)) !== view) return false
    if (wc.isDestroyed?.()) return false
    const currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
    if (!currentPresentation || currentPresentation.error) return false
    if (
      currentPresentation.epoch !== token.viewEpoch ||
      currentPresentation.navigationEpoch !== token.navigationEpoch ||
      currentPresentation.documentRevision !== token.documentRevision ||
      navigationEpoch !== token.navigationEpoch ||
      (documentRevisionByView.get(String(viewId)) || 0) !== token.documentRevision
    ) {
      return false
    }
    const readyUrl = String(wc.getURL?.() || '')
    // Chromium's internal network-error document also emits dom-ready and
    // did-finish-load. It is never a successful replacement document, even if
    // did-fail-load/catch is delivered a moment later.
    if (isChromiumErrorDocument(readyUrl)) return false
    if (token.url && readyUrl && !sameNavigationUrl(token.url, readyUrl)) return false
    const readyPresentation = browserPresentation.markReady({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      navigationEpoch: token.navigationEpoch,
      documentRevision: token.documentRevision,
      url: readyUrl
    })
    if (!readyPresentation) return false
    faviconDocumentGate.bind({
      documentRevision: token.documentRevision,
      navigationEpoch: readyPresentation.navigationEpoch,
      viewEpoch
    })
    pushNavState()
    return true
  }
  const armCurrentDocumentReadyFence = () => {
    if (browserViews.get(String(viewId)) !== view || wc.isDestroyed?.()) return false
    let currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
    if (!currentPresentation || currentPresentation.error) return false
    const readyUrl = String(wc.getURL?.() || '')
    if (isChromiumErrorDocument(readyUrl)) return false

    let readyDocumentRevision = documentRevisionByView.get(String(viewId)) || 0
    if (readyUrl && readyUrl !== 'about:blank' && readyDocumentRevision <= initialDocumentRevision) {
      readyDocumentRevision = initialDocumentRevision + 1
      documentRevisionByView.set(String(viewId), readyDocumentRevision)
    }
    if (currentPresentation.documentRevision !== readyDocumentRevision) {
      const committed = browserPresentation.markCommitted({
        workbenchId: sessionId,
        tabId: viewId,
        epoch: viewEpoch,
        navigationEpoch,
        documentRevision: readyDocumentRevision,
        url: readyUrl
      })
      if (!committed) return false
      currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
    }
    const token = Object.freeze({
      documentRevision: readyDocumentRevision,
      key: `${viewEpoch}:${navigationEpoch}:${readyDocumentRevision}`,
      navigationEpoch,
      url: readyUrl,
      viewEpoch
    })
    if (currentDocumentReadyFence?.key === token.key) return true
    if (currentDocumentReadyFence) currentDocumentReadyFence.cancel()

    ensureLoadSurfaceAttached()
    let settled = false
    let fallback = null
    const cancel = () => {
      if (settled) return
      settled = true
      if (fallback) clearTimeout(fallback)
    }
    const settle = source => {
      if (settled) return
      settled = true
      if (fallback) clearTimeout(fallback)
      if (currentDocumentReadyFence?.key === token.key) currentDocumentReadyFence = null
      if (!markCurrentDocumentReady(token)) return
      if (source === 'timeout') {
        _browserLog(`browser first-frame fence timed out for ${viewId}; revealed at bounded fallback`)
      }
    }
    currentDocumentReadyFence = { cancel, key: token.key }

    // `dom-ready` precedes compositor presentation. capturePage is used only as
    // a frame fence: no pixels are retained or exposed. stayHidden keeps the
    // attached loading View behind the React fallback until the captured frame
    // belongs to this exact view/navigation/document identity.
    fallback = setTimeout(() => settle('timeout'), 500)
    fallback.unref?.()
    try {
      wc.invalidate?.()
    } catch (error) {
      void error
    }
    if (typeof wc.capturePage === 'function') {
      void wc
        .capturePage(undefined, { stayHidden: true })
        .then(image => {
          if (image && typeof image.isEmpty === 'function' && image.isEmpty()) return
          settle('capture')
        })
        .catch(error => {
          _browserLog(`browser first-frame capture failed for ${viewId}: ${error?.message || error}`)
        })
    }
    return true
  }
  wc.on('dom-ready', () => {
    if (browserViews.get(String(viewId)) !== view) return
    // Re-apply zoom as soon as the DOM exists (before first paint) to minimize flash.
    try {
      const bb = view.getBounds()
      if (bb.width > 0 && typeof wc.setZoomFactor === 'function') wc.setZoomFactor(_fitZoom(bb.width))
    } catch (err) {
      void err
    }
    // DOM readiness is semantic only. The native surface is revealed by the
    // bounded compositor fence, never directly from this pre-paint event.
    armCurrentDocumentReadyFence()
  })
  // A real Chromium NavigationHandle failure emits did-fail-provisional-load
  // before did-fail-load. Electron also emits synthetic did-fail-load events
  // when loadURL() is rejected before any navigation starts (for example a
  // re-entrant call while another load is ready to commit). Consuming only the
  // provisional event prevents that synthetic event from poisoning the active
  // attempt, especially when both calls target the same URL.
  wc.on('did-fail-provisional-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // ERR_ABORTED is normal when a newer Chromium navigation replaces an older
    // one. A real failure ends the progress state but never hides an existing
    // usable document.
    if (!isMainFrame || browserViews.get(String(viewId)) !== view) return
    const currentUrl = String(wc.getURL?.() || '')
    const failedUrl = String(validatedUrl || '')
    const aborted = isAbortedNavigationFailure(errorCode)
    const currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
    const failedAttempt = pendingNavigationAttempts.consumeFailure(failedUrl, {
      aborted,
      currentEpoch: currentPresentation?.navigationEpoch
    })
    // Without a recorded main-frame start there is no safe identity to attach
    // this positional Electron event to. Failing closed is preferable to
    // poisoning a newer same-URL retry.
    if (!failedAttempt) return
    // ERR_ABORTED is the expected terminal event for the attempt replaced by a
    // newer navigation. Consuming it above keeps the retry at the head of the
    // queue, but it must never become product failure state.
    if (aborted) return
    if (!currentPresentation || currentPresentation.navigationEpoch !== failedAttempt.epoch) return
    invalidateCurrentFavicon()
    const failedPresentation = browserPresentation.markFailed({
      workbenchId: sessionId,
      tabId: viewId,
      epoch: viewEpoch,
      navigationEpoch: failedAttempt.epoch,
      error: {
        code: errorCode,
        description: errorDescription || 'ERR_FAILED',
        url: failedUrl || currentUrl
      }
    })
    if (currentDocumentReadyFence) {
      currentDocumentReadyFence.cancel()
      currentDocumentReadyFence = null
    }
    if (failedPresentation) pushNavState()
  })
  wc.on('did-finish-load', () => {
    if (browserViews.get(String(viewId)) !== view) return
    // Fit-to-width zoom MUST be (re)applied AFTER load — a zoom set during load
    // gets reset to 1 by Electron. Use the view's current logical width.
    try {
      const b = view.getBounds()
      if (b.width > 0 && typeof wc.setZoomFactor === 'function') wc.setZoomFactor(_fitZoom(b.width))
    } catch (err) {
      void err
    }
    // dom-ready normally arms the compositor fence. This is only a backstop for
    // an adopted or unusual renderer whose dom-ready event was missed; load
    // completion itself is not evidence that native pixels are presentable.
    if (!browserPresentation.tabSnapshot(sessionId, viewId)?.hasUsableDocument) {
      armCurrentDocumentReadyFence()
    }
    settleAdoptedGuestIfReady()
  })
  wc.on('unresponsive', () => {
    if (browserViews.get(String(viewId)) !== view) return
    browserShellController.setHealth({
      ...browserDocumentScope(sessionId, viewId),
      code: 'renderer-unresponsive',
      status: 'unresponsive'
    })
  })
  wc.on('responsive', () => {
    if (browserViews.get(String(viewId)) !== view) return
    browserShellController.setHealth({
      ...browserDocumentScope(sessionId, viewId),
      code: 'renderer-responsive',
      status: 'ok'
    })
  })
  // Self-heal: if the page's renderer crashes (heavy / anti-bot sites can do
  // this), the WebContentsView is dead but still in browserViews — every later
  // action would throw "WebContentsView not found" or hang on navigate. Rebuild
  // it with its last URL so the session recovers instead of getting wedged.
  wc.on('render-process-gone', (_event, details) => {
    if (browserViews.get(String(viewId)) !== view) return
    browserShellController.setHealth({
      ...browserDocumentScope(sessionId, viewId),
      code: `renderer-${String(details?.reason || 'gone')}`,
      status: 'crashed'
    })
    // A renderer crash invalidates the concrete document and every Agent
    // command waiting on it. Rebuild may reuse the logical tab id, never the
    // old Intent or document identity.
    browserNavigationController.cancelTab(String(viewId))
    // Crash-loop guard (mirrors the main-window handler): if this view keeps
    // crashing (e.g. an OOM-on-load page), stop rebuilding it — endless rebuild
    // is a CPU/memory storm that hangs the app. Tear it down + recover focus.
    const nowCrash = Date.now()
    const crashes = (viewCrashTimes.get(String(viewId)) || []).filter(t => nowCrash - t < RENDERER_RELOAD_WINDOW_MS)
    crashes.push(nowCrash)
    viewCrashTimes.set(String(viewId), crashes)
    if (crashes.length > RENDERER_RELOAD_MAX) {
      _browserLog(
        `render-process-gone ${viewId}: suppressing rebuild (${crashes.length} crashes in ${RENDERER_RELOAD_WINDOW_MS}ms — crash loop)`
      )
      evictView(String(viewId), 'crash-loop')
      _recoverCrashLoopTab(String(sessionId), String(viewId))
      raiseBrowserShellNotice(
        browserDocumentScope(sessionId, viewId),
        'renderer-crash-loop',
        'error'
      )
      return
    }
    browserShellController.setHealth({
      ...browserDocumentScope(sessionId, viewId),
      code: 'renderer-recovering',
      status: 'degraded'
    })
    _browserLog(`render-process-gone ${viewId} (${details && details.reason}); rebuilding view`)
    const last =
      lastUrlByView.get(String(viewId)) ||
      browserSessionController.tabMeta(String(sessionId), String(viewId))?.url ||
      'about:blank'
    const failedWasActive = browserSessionController.activeTabId(String(sessionId)) === String(viewId)
    browserTabManager.unregisterView(String(viewId), view)
    browserViewLifecycle.dispose(view)
    // CDP-6:主动失效 runtime 侧旧 entry(旧 client/targetManager/selectorMap/watchdog),否则要等
    // 下一次 getWorkbench 的 isDestroyed() 懒检测,留下 watchdog/targetManager 继续空跑的竞态窗口。
    // unregisterWorkbench 同步 stop watchdog+targetManager;dispose 在崩溃的 webContents 上安全幂等
    // 由 .catch 吞掉。把"靠懒检测"升级为"主动失效+懒检测双保险"。
    if (browserRuntime) browserRuntime.unregisterWorkbench(String(viewId)).catch(() => undefined)
    const sessionInstanceId = browserSessionController.sessionInstanceId(String(sessionId))
    let rebuiltView = null
    try {
      rebuiltView = _createTabView(viewId, sessionId, last)
      ensureBrowserRuntime().registerWorkbench(String(viewId))
    } catch (error) {
      if (rebuiltView) {
        cleanupFailedTabMaterialization(String(sessionId), String(viewId), rebuiltView, sessionInstanceId)
      }
      _browserLog(`render-process-gone rebuild failed for ${viewId}: ${error?.message || error}`)
    }
    const group = browserSessionController.runtimeSnapshot(String(sessionId))
    if (group && group.tabs[group.active] === String(viewId)) setActiveTab(String(sessionId), String(viewId))
    // TAB-01:若就地重建没能产出存活视图(罕见:rebuild 也失败),走焦点恢复——迁到存活兄弟标签
    // 或把坏标签重建为 about:blank(对齐 BU _recover_agent_focus 的 emergency fallback)。
    const rebuilt = browserViews.get(String(viewId))
    const rebuiltWc = rebuilt && rebuilt.webContents
    if (!rebuiltWc || (typeof rebuiltWc.isDestroyed === 'function' && rebuiltWc.isDestroyed())) {
      if (failedWasActive && browserSessionController.activeTabId(String(sessionId)) === String(viewId)) {
        _recoverActiveTab(String(sessionId), String(viewId))
      } else {
        browserPresentation.suspendTab({ workbenchId: String(sessionId), tabId: String(viewId) })
        _syncSessionTopology(String(sessionId), { source: 'system' })
      }
      raiseBrowserShellNotice(
        browserDocumentScope(sessionId, viewId),
        'renderer-recovery-failed',
        'error'
      )
    } else {
      browserShellController.setHealth({
        ...browserDocumentScope(sessionId, viewId),
        code: 'renderer-recovered',
        status: 'ok'
      })
    }
  })
  wc.once('destroyed', () => {
    if (browserViews.get(String(viewId)) !== view) return
    browserNavigationController.cancelTab(String(viewId))
    const tabs = browserSessionController.tabIds(sessionId)
    if (!tabs.includes(String(viewId))) return
    if (tabs.length > 1) {
      void removeTab(sessionId, viewId, { sourceAlreadyDestroyed: true }).catch(error => {
        _browserLog(`native tab close failed for ${viewId}: ${error?.message || error}`)
      })
      return
    }

    // window.close() on the final popup must not leave the session pointing at
    // a destroyed WebContents. Keep the one logical tab, reset it to blank and
    // materialize a fresh native surface on the next main-process turn.
    const instanceId = browserSessionController.sessionInstanceId(sessionId)
    pageOpenedBrowserTabIds.delete(String(viewId))
    browserViewLifecycle.dispose(view)
    browserTabManager.unregisterView(String(viewId), view)
    if (browserRuntime) void browserRuntime.unregisterWorkbench(String(viewId)).catch(() => undefined)
    faviconByView.delete(String(viewId))
    browserResourceGovernor.forget(String(viewId))
    lastUrlByView.delete(String(viewId))
    viewCrashTimes.delete(String(viewId))
    browserSessionController.patchTabMeta(sessionId, String(viewId), {
      url: 'about:blank',
      title: '',
      favicon: ''
    })
    browserPresentation.suspendTab({ workbenchId: sessionId, tabId: String(viewId) })
    _syncSessionTopology(sessionId, { source: 'page' })
    setImmediate(() => {
      if (
        isAppQuitting ||
        browserSessionController.sessionInstanceId(sessionId) !== instanceId ||
        browserSessionController.activeTabId(sessionId) !== String(viewId) ||
        browserViews.has(String(viewId))
      ) {
        return
      }
      if (ensureTabMaterialized(sessionId, String(viewId))) {
        setActiveTab(sessionId, String(viewId), 'system')
      }
    })
  })
  // A fresh macOS WebContents must join a native hierarchy before it becomes
  // runtime-registerable. Page.navigate can acknowledge on a detached
  // about:blank target without ever starting a usable document, leaving every
  // following CDP command hung. Attach it hidden here, then let presentation
  // reconciliation immediately detach genuine background views.
  browserViewLifecycle.prepare(view)
  ensureScrimOnTop()
  // Register only AFTER the view is fully wired and load-capable, so runtime
  // lookup can never observe a detached newborn target.
  browserTabManager.registerView(String(viewId), view)
  browserResourceGovernor.touch(viewId, 'created')
  // Pre-scale from the last known host rect so the FIRST paint is already zoomed
  // (kills the brief big->small flash before dom-ready/did-finish-load re-apply).
  try {
    const rect0 = lastHostRect.get(String(sessionId))
    if (rect0 && rect0.width > 0 && typeof wc.setZoomFactor === 'function') wc.setZoomFactor(_fitZoom(rect0.width))
  } catch (err) {
    void err
  }
  // Host-load even about:blank once. On macOS a newborn WebContents can keep
  // getOSProcessId() === 0 until this first load, which leaves CDP talking to a
  // target that has no renderer process.
  const initialLoad = options.loadInitial === false
    ? Promise.resolve(true)
    : wc
        .loadURL(initialUrl)
        .then(() => {
          initialLoadPending = false
          if (initialLoadAttemptEpoch !== null) pendingNavigationAttempts.consumeEpoch(initialLoadAttemptEpoch)
          return true
        })
        .catch(err => {
          initialLoadPending = false
          if (browserViews.get(String(viewId)) !== view) return false
          const observedPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
          const attemptEpoch =
            initialLoadAttemptEpoch === null && observedPresentation?.navigationEpoch === 0
              ? 0
              : initialLoadAttemptEpoch
          if (attemptEpoch === null) return false
          pendingNavigationAttempts.consumeEpoch(attemptEpoch)
          if (isAbortedNavigationFailure(err)) return false
          _browserLog(`loadURL failed: ${err?.message || err}`)
          const currentPresentation = browserPresentation.tabSnapshot(sessionId, viewId)
          // The Promise belongs to the initial load even if it rejects after a
          // replacement navigation has started. Never stamp the mutable latest
          // epoch onto that older failure.
          if (
            !currentPresentation ||
            currentPresentation.navigationEpoch !== attemptEpoch ||
            currentPresentation.error
          ) {
            return false
          }
          invalidateCurrentFavicon()
          const failedPresentation = browserPresentation.markFailed({
            workbenchId: sessionId,
            tabId: viewId,
            epoch: viewEpoch,
            navigationEpoch: attemptEpoch,
            error: {
              code: err?.errno,
              description: err?.code || err?.message || 'ERR_FAILED',
              url: initialUrl
            }
          })
          if (failedPresentation) pushNavState()
          return false
        })
  browserViewInitialLoads.set(view, initialLoad)
  if (options.loadInitial === false) {
    // createWindow may hand us a guest whose initial document became ready
    // before Fan attached lifecycle listeners. Reconcile that native state on
    // the next main-process turn; never reload an adopted popup because doing
    // so would lose POST bodies, opener state and document.write content.
    setImmediate(settleAdoptedGuestIfReady)
  }
  return view
  } catch (error) {
    const targetId = String(viewId)
    browserTabManager.unregisterView(targetId, view)
    if (presentationRegistered) {
      browserPresentation.unregisterTab({ workbenchId: String(sessionId), tabId: targetId })
    }
    browserResourceGovernor.forget(targetId)
    if (hadDocumentRevision) documentRevisionByView.set(targetId, initialDocumentRevision)
    else documentRevisionByView.delete(targetId)
    if (hadViewEpoch) viewEpochById.set(targetId, priorEpoch)
    else viewEpochById.delete(targetId)
    faviconByView.delete(targetId)
    lastUrlByView.delete(targetId)
    viewCrashTimes.delete(targetId)
    if (newlyMarkedPageOpened) pageOpenedBrowserTabIds.delete(targetId)
    browserViewLifecycle.dispose(view)
    throw error
  }
}

function _tabsStateFor(sessionId) {
  return browserSessionProjector.tabsState(sessionId)
}

function _emitTabsState(sessionId, extra = {}) {
  browserSessionProjector.emit(sessionId, extra)
}

function _syncSessionTopology(sessionId, extra = {}) {
  return browserSessionProjector.sync(sessionId, extra)
}

function _recoverCrashLoopTab(sessionId, crashedTabId) { return browserTabManager._recoverCrashLoopTab(sessionId, crashedTabId) }

function _recoverActiveTab(sessionId, failedTabId = null) { return browserTabManager._recoverActiveTab(sessionId, failedTabId) }

function ensureTabMaterialized(sessionId, tabId) { return browserTabManager.ensureTabMaterialized(sessionId, tabId) }

function cleanupFailedTabMaterialization(sessionId, tabId, suppliedView = null, expectedInstanceId = null) { return browserTabManager.cleanupFailedTabMaterialization(sessionId, tabId, suppliedView, expectedInstanceId) }

function cleanupFailedTabCreation(sessionId, tabId, suppliedView = null, expectedInstanceId = null) {
  const cleaned = browserTabManager.cleanupFailedTabCreation(
    sessionId,
    tabId,
    suppliedView,
    expectedInstanceId
  )
  if (cleaned) {
    pageOpenedBrowserTabIds.delete(String(tabId || ''))
    void browserShellController.clearTab({
      tabId: String(tabId || ''),
      workbenchId: String(sessionId || ''),
      reason: 'tab-creation-failed'
    })
  }
  return cleaned
}

function flagSessionIntervention(sessionId, meta = {}) {
  const key = String(sessionId || '')
  if (!key) return false
  const anchorTabId = String(
    meta.anchorTabId || anchorBySession.get(key) || browserSessionController.activeTabId(key) || ''
  )
  if (anchorTabId) browserNavigationController.cancelTab(anchorTabId)
  if (!browserRuntime || !isSessionOperating(key)) return false
  try {
    browserRuntime.flagIntervention(key, {
      ...meta,
      anchorTabId: anchorTabId || null
    })
    return true
  } catch (error) {
    _browserLog(`flagIntervention(${key}) failed: ${error?.message || error}`)
    return false
  }
}

function setActiveTab(sessionId, tabId, source = 'system') { return browserTabManager.setActiveTab(sessionId, tabId, source) }

async function addTab(sessionId, url, source = 'system') { return browserTabManager.addTab(sessionId, url, source) }

async function removeTab(sessionId, tabId, options = {}) {
  browserNavigationController.cancelTab(String(tabId || ''))
  const removed = await browserTabManager.removeTab(sessionId, tabId, options)
  if (removed) {
    pageOpenedBrowserTabIds.delete(String(tabId || ''))
    await browserShellController.clearTab({
      tabId: String(tabId || ''),
      workbenchId: String(sessionId || ''),
      reason: 'tab-closed'
    })
  }
  return removed
}

function reorderTab(sessionId, tabId, toIndex) { return browserTabManager.reorderTab(sessionId, tabId, toIndex) }

async function restoreTabs(sessionId, state) { return browserTabManager.restoreTabs(sessionId, state) }

async function createBrowserView(id, url) { return browserTabManager.createBrowserView(id, url) }

function setBrowserViewBounds(id, rect) {
  const key = String(id)
  lastHostRect.set(key, rect)
  browserPresentation.setPrimarySurface({ workbenchId: key, rect })
  const view = getBrowserView(activeViewId(id))
  if (!view) return false
  // A Canvas tile temporarily uses the larger card radius. Restore the normal
  // viewport radius before the same native view returns to the session page.
  setNativeViewBorderRadius(view, BROWSER_SURFACE_BORDER_RADIUS)
  const bounds = {
    x: Math.round(rect?.x || 0),
    y: Math.round(rect?.y || 0),
    width: Math.max(0, Math.round(rect?.width || 0)),
    height: Math.max(0, Math.round(rect?.height || 0))
  }
  view.setBounds(bounds)
  if (bounds.width > 0 && bounds.height > 0) {
    // Fit-to-width: shrink a desktop page proportionally to fit a narrow pane so
    // it renders like a scaled-down full window instead of overflowing.
    const wc = view.webContents
    if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.setZoomFactor === 'function') {
      try {
        // Only re-zoom when the fit factor actually moved enough to see (>=2%).
        // A sidebar collapse/expand animation (or a divider drag) sweeps the
        // pane width ~every frame; calling setZoomFactor each frame forced a
        // full-page relayout -> jank + the native view lagging the animated
        // bounds. The geometry (setBounds above) still tracks every frame;
        // skipping sub-2% zoom steps kills the reflow storm. Any <=2% residual
        // is imperceptible and re-corrected by the next bounds change/load.
        const z = _fitZoom(bounds.width)
        const cur = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() : -1
        if (Math.abs(z - cur) >= 0.02) wc.setZoomFactor(z)
      } catch (err) {
        void err
      }
    }
  }
  reconcileBrowserPresentation(key)
  return true
}

// A session going into the background starts two explicit retention clocks.
// Its active tab remains warm for a likely return; sibling tabs become cheap
// lazy placeholders much sooner. Starting both clocks at this boundary makes
// the policy deterministic when the user enters the all-sessions overview.
function _markSessionBackgrounded(sessionId) {
  const key = String(sessionId || '')
  const group = browserSessionController.runtimeSnapshot(key)
  if (!key || !group) return
  const activeId = activeViewId(key)
  for (const tabId of group.tabs || []) {
    const id = String(tabId)
    _touchMaterializedView(
      id,
      id === activeId ? 'foreground-left' : 'session-backgrounded'
    )
  }
}

function setBrowserViewVisible(id, visible, reason = 'layout') {
  const key = String(id)
  const nextVisible = Boolean(visible)

  if (!nextVisible && !canHideBrowserSurface({ operating: isSessionOperating(key), reason })) {
    return false
  }

  const group = browserSessionController.runtimeSnapshot(key)
  let activeId = activeViewId(key)
  let view = getBrowserView(activeId)

  // Refocusing an evicted real page materializes it through the existing
  // activation funnel. Fresh active workbenches are already warm; only lazy
  // restore/eviction can leave this foreground tab without a live view.
  if (nextVisible && group && !view) {
    if (!setActiveTab(key, activeId, 'system')) return false
    activeId = activeViewId(key)
    view = getBrowserView(activeId)
  }

  if ((!group && !view) || (nextVisible && !view)) return false

  if (nextVisible) {
    // The renderer is foregrounding this session — record it so a background
    // session's tab activity can't steal the view.
    const enteringForeground = foregroundSessionKey !== key
    if (enteringForeground && foregroundSessionKey) {
      _markSessionBackgrounded(foregroundSessionKey)
    }
    if (enteringForeground) {
      _browserLog(
        `[presentation] foreground changed from=${foregroundSessionKey || '-'} to=${key} reason=${reason}`
      )
    }
    foregroundSessionKey = key
    if (enteringForeground && view) browserResourceGovernor.touch(activeId, 'foreground-shown')
    browserPresentation.refreshActiveTab({ workbenchId: key, tabId: activeId })
    browserPresentation.setPrimarySurface({
      workbenchId: key,
      rect: lastHostRect.get(key),
      visible: true
    })
  } else {
    if (foregroundSessionKey === key) {
      _markSessionBackgrounded(key)
      _browserLog(`[presentation] foreground changed from=${key} to=- reason=${reason}`)
      foregroundSessionKey = null
    }
    browserPresentation.setPrimarySurface({ workbenchId: key, visible: false })
  }
  reconcileBrowserPresentation(key)
  return true
}

// Atomic primary-surface declaration used by the renderer. It deliberately
// combines geometry and foreground intent in one main-process turn, replacing
// the old `setBounds(...).then(setVisible(true))` protocol whose late promise
// could reveal a stale/loading view after the user had switched workbenches.
function presentBrowserSurface(id, rect, ownerId = '') {
  const key = String(id || '')
  if (!key || !rect) return { ok: false }
  const owner = normalizeBrowserSurfaceOwner(ownerId)
  setBrowserViewBounds(key, rect)
  if (!setBrowserViewVisible(key, true)) return { ok: false }
  if (owner) browserSurfaceOwnerBySession.set(key, owner)
  else browserSurfaceOwnerBySession.delete(key)
  const state = browserPresentation.snapshot(key)
  const nativeVisible = reconcileBrowserPresentation(key)
  return {
    ok: !state.nativeVisible || nativeVisible,
    ...state,
    nativeVisible: Boolean(state.nativeVisible && nativeVisible)
  }
}

function detachBrowserSurface(id, reason = 'layout', ownerId = '') {
  const key = String(id || '')
  if (!key) return { ok: false }
  const owner = normalizeBrowserSurfaceOwner(ownerId)
  const currentOwner = browserSurfaceOwnerBySession.get(key)
  if (currentOwner && owner !== currentOwner) {
    _browserLog(`ignored stale surface detach for ${key} (${reason})`)
    return { ok: false, stale: true, ...browserPresentation.snapshot(key) }
  }
  if (!canHideBrowserSurface({ operating: isSessionOperating(key), reason })) {
    return { ok: false, blocked: 'operating', ...browserPresentation.snapshot(key) }
  }
  setBrowserViewVisible(key, false, reason)
  return { ok: true, ...browserPresentation.snapshot(key) }
}

function hideAllBrowserViews(reason = 'layout') {
  if (
    foregroundSessionKey &&
    !canHideBrowserSurface({ operating: isSessionOperating(foregroundSessionKey), reason })
  ) {
    return false
  }

  if (foregroundSessionKey) {
    _markSessionBackgrounded(foregroundSessionKey)
    _browserLog(
      `[presentation] foreground changed from=${foregroundSessionKey} to=- reason=${reason}`
    )
  }
  foregroundSessionKey = null
  browserPresentation.hideAllPrimarySurfaces()
  for (const sessionId of overviewTileIds) {
    _touchMaterializedView(activeViewId(sessionId), 'overview-left')
  }
  overviewTileIds.clear()
  overviewTileRects.clear()
  // Symmetric with the overview it tears down: catchers live outside browserViews,
  // so hiding every page view would otherwise leave them floating over the overlay.
  _reconcileOverviewCatchers(new Set())
  for (const view of browserViews.values()) {
    browserViewLifecycle.detach(view)
  }
  return true
}

function releaseBrowserViewsForClosedWindow(contentView = null) {
  hideAllBrowserViews('lifecycle')
  for (const viewId of [...browserViews.keys()]) {
    evictView(viewId, 'window-close')
  }
  // Native View disposal can complete after the logical maps are empty. Release
  // the captured host while it is still valid so no attached/pending View stays
  // strongly referenced after the BrowserWindow has gone away.
  browserViewLifecycle.releaseHost(contentView)
  _reconcileOverviewCatchers(new Set())
  destroyDownloadPopover()
  destroyBrowserScrim()
  void clearTransientBrowserPins('window-close')
}

// ── Live overview tiles (plan B) ─────────────────────────────────────────────
// The Canvas overview cannot capture hidden views (Chromium won't composite
// them — proven), so an operating session's tile shows its REAL WebContentsView
// positioned over the tile's snapshot rect, zoomed to fit. Multiple tiles show
// AT ONCE, so this deliberately bypasses setBrowserViewVisible's single-
// foreground exclusivity (which hides every other view). It never records
// lastHostRect, so returning to the full session view restores its real bounds.
// ── Overview live-tile click-catcher ─────────────────────────────────────────
// A running session's live view is floated over its overview tile (below). That
// native view sits ABOVE the DOM tile button, so it swallows the click that would
// OPEN the session (the "运行中卡片点不进" bug). For each floated tile we float a
// TRANSPARENT catcher view ON TOP of the live view; its preload
// (overview-tile-preload.cjs) forwards a click as "open this session" (resolved by
// catcher webContents id) and forwards wheel so the overview still scrolls over a
// running tile. The native View remains keyed by browser workbench id, while the
// click target may be the separate durable storage id supplied by the renderer.
// Same overlay-View pattern as the modal scrim. Catchers live in their OWN maps —
// NOT counted against MAX_TOTAL_BROWSER_VIEWS — so they MUST be destroyed on tile
// removal / overview exit / session destroy or they leak.
const overviewCatchers = new Map() // browser workbench id -> WebContentsView
const overviewCatcherOpenTarget = new Map() // catcher webContents.id -> durable storage id

function _ensureOverviewCatcher(workbenchId) {
  const existing = overviewCatchers.get(workbenchId)
  if (existing && !existing.webContents.isDestroyed()) return existing
  // Destroyed-but-still-mapped (e.g. window teardown): drop its stale wc.id→target
  // entry and detach before minting a replacement, or the old mapping lingers.
  if (existing) destroyOverviewCatcher(workbenchId)
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'overview-tile-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  view.setBackgroundColor('#00000000')
  setNativeViewBorderRadius(view, OVERVIEW_TILE_BORDER_RADIUS)
  view.setVisible(false)
  void view.webContents.loadURL(
    'data:text/html,<!doctype html><html><body style="margin:0;height:100vh;background:transparent"></body></html>'
  )
  overviewCatchers.set(workbenchId, view)
  return view
}

// Float (or re-raise) the catcher over a tile rect, ABOVE its live view.
function _showOverviewCatcher(workbenchId, rect, openTargetId = null) {
  if (!mainWindow || mainWindow.isDestroyed() || !rect) return
  const view = _ensureOverviewCatcher(workbenchId)
  // This assignment deliberately happens on EVERY show, not only creation: a
  // reused browser workbench may be rebound to a different durable Canvas
  // session between overview payloads. Internal refreshes omit openTargetId and
  // preserve the most recently supplied mapping.
  const openId = String(openTargetId || overviewCatcherOpenTarget.get(view.webContents.id) || workbenchId)
  overviewCatcherOpenTarget.set(view.webContents.id, openId)
  view.setBounds({
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0))
  })
  // Re-adding an attached view raises it to the top of the child list, so the
  // catcher lands ABOVE the live tile view (child order = z-order).
  mainWindow.contentView.addChildView(view)
  view.setVisible(true)
}

function destroyOverviewCatcher(workbenchId) {
  const view = overviewCatchers.get(workbenchId)
  if (!view) return
  overviewCatchers.delete(workbenchId)
  try {
    overviewCatcherOpenTarget.delete(view.webContents.id)
  } catch (err) {
    void err
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
  } catch (err) {
    void err
  }
  browserViewLifecycle.dispose(view)
}

// Destroy catchers for sessions no longer tiled (keepIds = the current tile set).
function _reconcileOverviewCatchers(keepIds) {
  for (const sid of [...overviewCatchers.keys()]) {
    if (!keepIds.has(sid)) destroyOverviewCatcher(sid)
  }
}

function ensureOverviewCatchersOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  for (const [sessionId, view] of overviewCatchers) {
    if (!overviewTileIds.has(sessionId) || view?.webContents?.isDestroyed?.()) continue
    // Any page lifecycle attach can change native child z-order. The overview
    // is read-only: always restore its transparent catcher above the live page
    // so scrolling/selecting sessions cannot reach the browser underneath.
    mainWindow.contentView.addChildView(view)
  }
}

// Position ONE view over a tile rect (zoom-to-fit) and temporarily match the
// overview card's radius. setBrowserViewBounds restores the full-session radius
// before this view returns to its normal host. Zoom reuses that path's >=2%
// guard so a hover/scroll width sweep can't trigger a per-frame reflow storm.
function _showTileView(view, rect) {
  const wc = view?.webContents
  if (!wc || wc.isDestroyed()) return false
  const bounds = {
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0))
  }
  if (bounds.width <= 0 || bounds.height <= 0) return false
  // Clip the native page (including its injected operating aura) to the same
  // 20px silhouette as .session-glass-card. This keeps both lower corners from
  // jutting outside the top-corner geometry while the page is floated.
  setNativeViewBorderRadius(view, OVERVIEW_TILE_BORDER_RADIUS)
  view.setBounds(bounds)
  try {
    if (typeof wc.setZoomFactor === 'function') {
      const z = _fitZoom(bounds.width)
      const cur = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() : -1
      if (Math.abs(z - cur) >= 0.02) wc.setZoomFactor(z)
    }
  } catch (err) {
    void err
  }
  return browserViewLifecycle.show(view)
}

function setOverviewLiveTiles(tiles) {
  const previousTileIds = new Set(overviewTileIds)
  const nextRects = new Map()
  const nextOpenTargets = new Map()
  const visibleViewIds = new Set()
  for (const t of Array.isArray(tiles) ? tiles : []) {
    const id = String(t?.id || '')
    const storageId = String(t?.storageId || '')
    const rect = t?.rect
    if (!id || !rect) continue
    const activeId = activeViewId(id)
    const view = browserViews.get(activeId)
    if (view && _showTileView(view, rect)) {
      if (!previousTileIds.has(id)) {
        browserResourceGovernor.touch(activeId, 'overview-live')
      }
      visibleViewIds.add(activeId)
      nextRects.set(id, rect)
      nextOpenTargets.set(id, storageId || id)
    }
  }
  // The overview shows ONLY each tiled session's ACTIVE tab. Hide every other
  // view: sibling tabs of tiled sessions (else a stale non-active tab paints over
  // the tile), views of sessions no longer tiled, and scrolled-off tiles. A real
  // foreground view (if any) is never touched.
  const fgView = foregroundSessionKey ? activeViewId(foregroundSessionKey) : null
  for (const [vid, view] of browserViews) {
    if (!visibleViewIds.has(vid) && vid !== fgView) browserViewLifecycle.detach(view)
  }
  for (const id of previousTileIds) {
    if (!nextRects.has(id)) {
      _touchMaterializedView(activeViewId(id), 'overview-left')
    }
  }
  overviewTileIds.clear()
  overviewTileRects.clear()
  const keepCatchers = new Set()
  for (const [id, rect] of nextRects) {
    overviewTileIds.add(id)
    overviewTileRects.set(id, rect)
    _showOverviewCatcher(id, rect, nextOpenTargets.get(id)) // click opens storageId || workbench id
    keepCatchers.add(id)
  }
  // Empty tiles (overview exit / nothing operating) → keepCatchers empty → destroy all.
  _reconcileOverviewCatchers(keepCatchers)
  ensureScrimOnTop()
  return true
}

// Re-point ONE tiled session's live view to its CURRENT active tab. setActiveTab
// hides the newly-active view for a background session (correct for normal use)
// and leaves the previously-floated tile view up — so without this the tile
// freezes on whatever tab it first floated while the agent moved on (the
// wrong-tab bug). Event-driven off setActiveTab, so tab switches track instantly
// (the renderer's rect-deduped push never re-fires on a tab change).
function refreshOverviewTileFor(sessionId) {
  const id = String(sessionId)
  if (!overviewTileIds.has(id)) return
  const rect = overviewTileRects.get(id)
  if (!rect) return
  const activeId = activeViewId(id)
  const group = browserSessionController.runtimeSnapshot(id)
  if (group) {
    for (const tid of group.tabs) {
      if (tid !== activeId) browserViewLifecycle.detach(browserViews.get(tid))
    }
  }
  const view = browserViews.get(activeId)
  if (view) {
    _showTileView(view, rect)
    // setActiveTab may have re-added the newly-active page view above the catcher;
    // re-raise the catcher so it stays on top of the live tile.
    _showOverviewCatcher(id, rect)
    ensureScrimOnTop()
  }
}

function getBrowserViewUrl(id) {
  const wc = getBrowserView(activeViewId(id))?.webContents
  if (!wc || wc.isDestroyed()) return null
  return wc.getURL?.() || null
}

function runBrowserNavigationCommand(command = {}) {
  const protocol = browserProtocolKind(command.url)
  if (protocol.kind === 'external') {
    requestExternalBrowserApplication({
      url: command.url,
      workbenchId: command.sessionId,
      tabId: command.tabId,
      source: 'agent-navigation'
    })
    const error = new Error('External application confirmation is required from the user')
    error.code = 'EXTERNAL_APPLICATION_CONFIRMATION_REQUIRED'
    throw error
  }
  if (protocol.kind === 'blocked') {
    raiseBrowserShellNotice(
      browserDocumentScope(command.sessionId, command.tabId),
      'unsafe-protocol-blocked',
      'warning'
    )
    const error = new Error('Unsafe browser protocol was blocked')
    error.code = 'UNSAFE_BROWSER_PROTOCOL'
    throw error
  }
  return browserNavigationController.run(command)
}

function navigateBrowserView(id, url, source = 'ui', options = {}) {
  const clientRequestId = options?.clientRequestId ?? null
  if (!url) return { clientRequestId, ok: false, reason: 'empty-url' }
  // URL-bar navigation on a session whose active view was evicted must
  // materialize it first — same funnel as every other activation.
  if (browserSessionController.hasSession(String(id)) && !getBrowserView(activeViewId(id))) {
    setActiveTab(String(id), activeViewId(id), 'system')
  }
  const workbenchId = String(id)
  const tabId = activeViewId(workbenchId)
  const wc = getBrowserView(tabId)?.webContents
  if (!wc || wc.isDestroyed()) return { clientRequestId, ok: false, reason: 'view-unavailable', tabId }
  if (options?.expectedTabId && String(options.expectedTabId) !== tabId) {
    return { clientRequestId, ok: false, reason: 'tab-changed', tabId }
  }
  const protocol = browserProtocolKind(url)
  if (protocol.kind === 'external') {
    const requested = requestExternalBrowserApplication({
      url,
      workbenchId,
      tabId,
      source: 'manual-navigation'
    })
    return {
      clientRequestId,
      ok: false,
      reason: requested.ok ? 'external-application-confirmation-required' : requested.reason,
      tabId
    }
  }
  if (protocol.kind === 'blocked') {
    raiseBrowserShellNotice(browserDocumentScope(workbenchId, tabId), 'unsafe-protocol-blocked', 'warning')
    return { clientRequestId, ok: false, reason: 'blocked-protocol', tabId }
  }
  if (source === 'omnibox' || source === 'ui') {
    flagSessionIntervention(workbenchId, {
      kind: 'navigation',
      anchorTabId: tabId,
      userTabId: tabId
    })
  }
  // Manual browsing is the browser's native fast path. It cancels an Agent
  // result lease for this tab, but never waits for or creates an application
  // navigation transaction and never controls page visibility.
  browserNavigationController.cancelTab(tabId)
  try {
    void Promise.resolve(wc.loadURL(String(url))).catch(error => {
      if (Number(error?.errno) !== -3) _browserLog(`navigate failed: ${error?.message || error}`)
    })
    return {
      clientRequestId,
      documentRevision: documentRevisionByView.get(String(tabId)) || 0,
      ok: true,
      tabId,
      viewEpoch: viewEpochById.get(String(tabId)) || 0
    }
  } catch (error) {
    _browserLog(`navigate failed: ${error?.message || error}`)
    return { clientRequestId, ok: false, reason: error?.code || 'navigation-failed', tabId }
  }
}

// User-driven nav controls drive the WebContentsView directly (not the eb
// runtime): the user just wants to move the page; the runtime watchdog clears
// the selector map on the resulting did-navigate, so the agent re-syncs on its
// next observe. canGoBack/goBack moved to webContents.navigationHistory in
// recent Electron — fall back to the legacy methods for older versions.
function getBrowserViewNavState(id) {
  const activeId = activeViewId(id)
  const wc = getBrowserView(activeId)?.webContents
  if (!wc || wc.isDestroyed()) return { ok: false }
  const hist = wc.navigationHistory
  const canBack =
    hist && typeof hist.canGoBack === 'function'
      ? hist.canGoBack()
      : typeof wc.canGoBack === 'function'
        ? wc.canGoBack()
        : false
  const canForward =
    hist && typeof hist.canGoForward === 'function'
      ? hist.canGoForward()
      : typeof wc.canGoForward === 'function'
        ? wc.canGoForward()
        : false
  return {
    ok: true,
    activeTabId: activeId,
    documentRevision: documentRevisionByView.get(String(activeId)) || 0,
    url: typeof wc.getURL === 'function' ? wc.getURL() : '',
    title: typeof wc.getTitle === 'function' ? wc.getTitle() : '',
    canGoBack: Boolean(canBack),
    canGoForward: Boolean(canForward),
    // Prefer the main-content flag (ends at dom-ready); fall back to isLoading
    // for a view that hasn't emitted a load event yet.
    loading:
      browserPresentation.tabSnapshot(String(id), activeId)?.loading ??
      (typeof wc.isLoading === 'function' ? wc.isLoading() : false)
  }
}

function browserViewNav(id, op) {
  const workbenchId = String(id)
  const tabId = activeViewId(workbenchId)
  const wc = getBrowserView(tabId)?.webContents
  if (!wc || wc.isDestroyed()) return { ok: false }
  flagSessionIntervention(workbenchId, {
    kind: 'navigation',
    anchorTabId: tabId,
    userTabId: tabId
  })
  browserNavigationController.cancelTab(tabId)
  const hist = wc.navigationHistory
  try {
    if (op === 'back') {
      if (hist?.canGoBack?.() || wc.canGoBack?.()) {
        if (hist?.canGoBack?.()) hist.goBack()
        else wc.goBack?.()
      }
    } else if (op === 'forward') {
      if (hist?.canGoForward?.() || wc.canGoForward?.()) {
        if (hist?.canGoForward?.()) hist.goForward()
        else wc.goForward?.()
      }
    } else if (op === 'reload') {
      wc.reload()
    } else if (op === 'stop') {
      wc.stop()
      browserPresentation.markStopped({
        workbenchId,
        tabId,
        epoch: viewEpochById.get(String(tabId)) || 0
      })
    }
  } catch (err) {
    _browserLog(`nav ${op} failed: ${err?.message || err}`)
  }
  return getBrowserViewNavState(id)
}

async function destroyBrowserView(id, reapPartition = false) {
  const key = String(id || '')
  const ownedTabIds = browserSessionController.tabIds(key)
  browserNavigationController.cancelSession(key)
  try {
    await browserShellController.clearWorkbench({ workbenchId: key, reason: 'workbench-closed' })
    return await browserTabManager.destroyBrowserView(id, reapPartition)
  } finally {
    for (const tabId of ownedTabIds) pageOpenedBrowserTabIds.delete(String(tabId))
    for (const mapKey of [...browserShellDownloadIds.keys()]) {
      if (mapKey.startsWith(`${key}\0`)) browserShellDownloadIds.delete(mapKey)
    }
    browserSurfaceOwnerBySession.delete(key)
  }
}

function hibernateBrowserSession(id) { return browserTabManager.hibernateBrowserSession(id) }

// ---- native download popover ----------------------------------------------
// Browser pages are native WebContentsViews, so a renderer-DOM popover cannot
// appear above them without hiding or resizing the page. This dedicated,
// transparent WebContentsView is a sibling overlay. Showing and hiding it never
// touches the page View, its bounds, its attachment, or its presentation state.
const DOWNLOAD_POPOVER_BLUR_CLOSE_DELAY_MS = 80
const DOWNLOAD_POPOVER_RENDER_TIMEOUT_MS = 500
let downloadPopoverView = null
let downloadPopoverLoadPromise = null
let downloadPopoverVisible = false
let downloadPopoverWorkbenchId = ''
let downloadPopoverShowSequence = 0
let downloadPopoverVisibilitySequence = 0
let downloadPopoverBlurTimer = null
const downloadPopoverRenderWaiters = new Map()

function clearDownloadPopoverBlurTimer() {
  if (!downloadPopoverBlurTimer) return
  clearTimeout(downloadPopoverBlurTimer)
  downloadPopoverBlurTimer = null
}

function notifyDownloadPopoverClosed(reason) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('fan:browser:downloadPopover:closed', { reason })
  }
}

function settleDownloadPopoverRender(requestId, rendered) {
  const waiter = downloadPopoverRenderWaiters.get(String(requestId || ''))
  if (!waiter) return false
  downloadPopoverRenderWaiters.delete(String(requestId || ''))
  clearTimeout(waiter.timer)
  waiter.resolve(rendered)
  return true
}

function waitForDownloadPopoverRender(requestId) {
  const key = String(requestId || '')
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      downloadPopoverRenderWaiters.delete(key)
      resolve(false)
    }, DOWNLOAD_POPOVER_RENDER_TIMEOUT_MS)
    downloadPopoverRenderWaiters.set(key, { resolve, timer })
  })
}

function ensureDownloadPopoverView() {
  if (downloadPopoverView && !downloadPopoverView.webContents.isDestroyed()) {
    return downloadPopoverView
  }
  if (downloadPopoverView) destroyDownloadPopover()

  const view = new WebContentsView({
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'download-popover-preload.cjs'),
      sandbox: true
    }
  })
  downloadPopoverView = view
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', event => event.preventDefault())
  view.webContents.on('blur', () => {
    if (!downloadPopoverVisible) return
    clearDownloadPopoverBlurTimer()
    // Defer outside-click close until after the renderer receives that click.
    // In particular, clicking the toolbar icon must remain one deterministic
    // close action instead of racing a blur notification and reopening itself.
    downloadPopoverBlurTimer = setTimeout(() => {
      downloadPopoverBlurTimer = null
      if (downloadPopoverVisible) hideDownloadPopover('outside', true)
    }, DOWNLOAD_POPOVER_BLUR_CLOSE_DELAY_MS)
  })
  view.webContents.on('render-process-gone', (_event, details) => {
    if (downloadPopoverView !== view) return
    rememberLog(`[download-popover] renderer gone: ${details?.reason || 'unknown'}`)
    destroyDownloadPopover()
    notifyDownloadPopoverClosed('unavailable')
  })
  view.webContents.on('destroyed', () => {
    if (downloadPopoverView !== view) return
    const wasOpen = downloadPopoverVisible || Boolean(downloadPopoverWorkbenchId)
    downloadPopoverShowSequence += 1
    downloadPopoverVisibilitySequence += 1
    downloadPopoverView = null
    downloadPopoverLoadPromise = null
    downloadPopoverVisible = false
    downloadPopoverWorkbenchId = ''
    clearDownloadPopoverBlurTimer()
    for (const requestId of [...downloadPopoverRenderWaiters.keys()]) {
      settleDownloadPopoverRender(requestId, false)
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
    } catch (err) {
      void err
    }
    if (wasOpen) notifyDownloadPopoverClosed('unavailable')
  })

  downloadPopoverLoadPromise = new Promise(resolve => {
    let settled = false
    const finish = loaded => {
      if (settled) return
      settled = true
      resolve(loaded)
    }
    view.webContents.once('did-finish-load', () => finish(true))
    view.webContents.once('destroyed', () => finish(false))
    void view.webContents.loadFile(path.join(__dirname, 'download-popover.html')).catch(error => {
      rememberLog(`[download-popover] failed to load: ${error?.message || error}`)
      finish(false)
    })
  })
  return view
}

function hideDownloadPopover(reason = 'toggle', notifyRenderer = false) {
  downloadPopoverShowSequence += 1
  downloadPopoverVisibilitySequence += 1
  clearDownloadPopoverBlurTimer()
  const wasOpen = downloadPopoverVisible || Boolean(downloadPopoverWorkbenchId)
  downloadPopoverVisible = false
  downloadPopoverWorkbenchId = ''

  if (downloadPopoverView && !downloadPopoverView.webContents.isDestroyed()) {
    downloadPopoverView.setVisible(false)
  }

  if (notifyRenderer && wasOpen) notifyDownloadPopoverClosed(reason)
  if (
    (reason === 'dismiss' || reason === 'escape') &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.focus()
  }
  return true
}

function destroyDownloadPopover() {
  hideDownloadPopover('lifecycle')
  const view = downloadPopoverView
  downloadPopoverView = null
  downloadPopoverLoadPromise = null
  for (const requestId of [...downloadPopoverRenderWaiters.keys()]) {
    settleDownloadPopoverRender(requestId, false)
  }
  if (!view) return true
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
  } catch (err) {
    void err
  }
  browserViewLifecycle.dispose(view)
  return true
}

async function showDownloadPopover(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const workbenchId = String(payload.workbenchId || '').replace(/\0/g, '').slice(0, 256)
  if (!workbenchId) return false

  const downloads = normalizeDownloadPopoverDownloads(
    browserShellController.shellState(workbenchId).downloads
  )
  if (!downloads.length) {
    hideDownloadPopover('empty', true)
    return false
  }

  const view = ensureDownloadPopoverView()
  const showSequence = ++downloadPopoverShowSequence
  const loaded = await downloadPopoverLoadPromise
  if (!loaded) {
    if (view === downloadPopoverView) destroyDownloadPopover()
    notifyDownloadPopoverClosed('unavailable')
    return false
  }
  if (
    showSequence !== downloadPopoverShowSequence ||
    view !== downloadPopoverView ||
    view.webContents.isDestroyed() ||
    !mainWindow ||
    mainWindow.isDestroyed()
  ) {
    return false
  }

  const [contentWidth, contentHeight] = mainWindow.getContentSize()
  const bounds = downloadPopoverViewBounds(
    payload.anchor,
    { height: contentHeight, width: contentWidth },
    downloads.length
  )
  view.setBounds(bounds)
  // Attach invisibly first. Dynamic text and theme are committed before the
  // first visible frame, so no default white/unstyled surface can flash.
  mainWindow.contentView.addChildView(view)

  const requestId = `${showSequence}:${browserShellController.shellState(workbenchId).revision}`
  const firstRender = downloadPopoverVisible ? null : waitForDownloadPopoverRender(requestId)
  view.webContents.send('fan:download-popover:update', {
    downloads,
    requestId,
    theme: normalizeDownloadPopoverTheme(payload.theme)
  })

  if (firstRender) {
    const rendered = await firstRender
    if (!rendered) {
      if (showSequence === downloadPopoverShowSequence && view === downloadPopoverView) {
        destroyDownloadPopover()
        notifyDownloadPopoverClosed('unavailable')
      }
      return false
    }
    if (
      showSequence !== downloadPopoverShowSequence ||
      view !== downloadPopoverView ||
      view.webContents.isDestroyed() ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return false
    }
    mainWindow.contentView.addChildView(view)
    view.setVisible(true)
    downloadPopoverVisible = true
    downloadPopoverVisibilitySequence += 1
    view.webContents.focus()
  }

  downloadPopoverWorkbenchId = workbenchId
  ensureScrimOnTop()
  return true
}

function ensureDownloadPopoverOnTop() {
  if (
    downloadPopoverVisible &&
    downloadPopoverView &&
    !downloadPopoverView.webContents.isDestroyed() &&
    mainWindow &&
    !mainWindow.isDestroyed()
  ) {
    mainWindow.contentView.addChildView(downloadPopoverView)
  }
}

ipcMain.handle('fan:browser:downloadPopover:show', (event, payload = {}) => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    return { ok: false }
  }
  return showDownloadPopover(payload).then(ok => ({ ok }))
})
ipcMain.handle('fan:browser:downloadPopover:hide', event => {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    return { ok: false }
  }
  return { ok: hideDownloadPopover('toggle') }
})
ipcMain.on('fan:download-popover:rendered', (event, payload = {}) => {
  if (
    event.sender !== downloadPopoverView?.webContents ||
    event.senderFrame !== downloadPopoverView?.webContents.mainFrame
  ) {
    return
  }
  settleDownloadPopoverRender(payload.requestId, true)
})
ipcMain.on('fan:download-popover:action', async (event, payload = {}) => {
  if (
    event.sender !== downloadPopoverView?.webContents ||
    event.senderFrame !== downloadPopoverView?.webContents.mainFrame
  ) {
    return
  }
  const action = String(payload.action || '')
  if (action === 'dismiss') {
    hideDownloadPopover('dismiss', true)
    return
  }
  if (action === 'escape') {
    hideDownloadPopover('escape', true)
    return
  }
  if (action !== 'open' && action !== 'reveal') return

  const eventId = String(payload.eventId || '').replace(/\0/g, '').slice(0, 256)
  const actionView = downloadPopoverView
  const actionWorkbenchId = downloadPopoverWorkbenchId
  const actionVisibilitySequence = downloadPopoverVisibilitySequence
  let result
  const scopedDownload =
    actionWorkbenchId &&
    normalizeDownloadPopoverDownloads(
      browserShellController.shellState(actionWorkbenchId).downloads
    ).find(download => download.eventId === eventId)
  const allowedAction =
    action === 'open' ? scopedDownload?.canOpen === true : scopedDownload?.canReveal === true
  if (!allowedAction) {
    result = { ok: false, reason: 'unknown-download' }
  } else {
    try {
      result =
        action === 'open'
          ? await browserShellController.openDownload(eventId)
          : await browserShellController.revealDownload(eventId)
    } catch (error) {
      rememberLog(`[download-popover] ${action} failed: ${error?.message || error}`)
      result = { ok: false, reason: 'action-failed' }
    }
  }
  if (
    downloadPopoverVisible &&
    downloadPopoverView === actionView &&
    downloadPopoverWorkbenchId === actionWorkbenchId &&
    downloadPopoverVisibilitySequence === actionVisibilitySequence &&
    actionView &&
    !actionView.webContents.isDestroyed()
  ) {
    actionView.webContents.send('fan:download-popover:actionResult', {
      action,
      eventId,
      ok: result?.ok === true,
      requestId: String(payload.requestId || '')
    })
  }
})

// ---- modal scrim over the embedded browser -------------------------------
// Official overlay-View pattern: DOM can never paint above a WebContentsView,
// so when a dialog / command palette opens, the renderer's DOM backdrop covers
// the DOM and THIS native view covers the browser rect — a plain dim layer
// that also (correctly) swallows input aimed at the page. The page underneath
// stays live: no hide, no frozen-snapshot swap.
let scrimView = null
let scrimVisible = false

function ensureScrimView() {
  if (scrimView && !scrimView.webContents.isDestroyed()) return scrimView
  if (scrimView) destroyBrowserScrim()
  scrimView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'scrim-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  scrimView.setBackgroundColor('#00000000')
  // Match the content views' 10px rounding so the dim follows the rounded
  // browser shape instead of overshooting its corners with a hard square.
  setNativeViewBorderRadius(scrimView, BROWSER_SURFACE_BORDER_RADIUS)
  scrimView.setVisible(false)
  void scrimView.webContents.loadURL(
    'data:text/html,<!doctype html><html><body style="margin:0;height:100vh;background:rgba(0,0,0,0.22)"></body></html>'
  )
  return scrimView
}

function showBrowserScrim(rect) {
  if (!mainWindow || mainWindow.isDestroyed() || !rect) return false
  const view = ensureScrimView()
  view.setBounds({
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0))
  })
  // Re-adding an attached view raises it to the top of the child list.
  mainWindow.contentView.addChildView(view)
  view.setVisible(true)
  scrimVisible = true
  return true
}

function hideBrowserScrim() {
  scrimVisible = false
  if (!scrimView || scrimView.webContents.isDestroyed()) return true
  scrimView.setVisible(false)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(scrimView)
  } catch (err) {
    void err
  }
  return true
}

function destroyBrowserScrim() {
  scrimVisible = false
  const view = scrimView
  scrimView = null
  if (!view) return true
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view)
  } catch (err) {
    void err
  }
  browserViewLifecycle.dispose(view)
  return true
}

// Any browser view attached while the scrim is up would land ABOVE it (child
// order = z-order). Call after every contentView.addChildView of a page view.
function ensureScrimOnTop() {
  ensureOverviewCatchersOnTop()
  ensureDownloadPopoverOnTop()
  if (scrimVisible && scrimView && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(scrimView)
  }
}
ipcMain.handle('fan:browser:scrim:show', (_event, payload = {}) => ({ ok: showBrowserScrim(payload.rect) }))
ipcMain.handle('fan:browser:scrim:hide', () => ({ ok: hideBrowserScrim() }))
ipcMain.on('fan:scrim:dismiss', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('fan:scrim:dismissed')
})

// Overview live-tile catcher (overview-tile-preload.cjs): a click over a running
// tile → open that session; a wheel → scroll the overview under the pointer.
ipcMain.on('fan:overview:tileClick', event => {
  const openTargetId = overviewCatcherOpenTarget.get(event.sender.id)
  if (openTargetId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fan:overview:open', { id: openTargetId })
  }
})
ipcMain.on('fan:overview:tileWheel', (_event, payload = {}) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('fan:overview:wheel', {
      deltaX: Number(payload.deltaX) || 0,
      deltaY: Number(payload.deltaY) || 0
    })
  }
})

ipcMain.handle('fan:browser:create', async (_event, payload = {}) => {
  const browserWorkbenchId = await createBrowserView(payload.id, payload.url)
  return {
    ok: Boolean(browserWorkbenchId),
    browserWorkbenchId
  }
})
ipcMain.handle('fan:browser:setBounds', (_event, payload = {}) => ({
  ok: setBrowserViewBounds(payload.id, payload.rect)
}))
ipcMain.handle('fan:browser:setVisible', (_event, payload = {}) => {
  const reason = payload.reason || 'layout'
  const blocked =
    payload.visible === false &&
    !canHideBrowserSurface({ operating: isSessionOperating(payload.id), reason })

  if (blocked) return { ok: false, blocked: 'operating' }

  return { ok: setBrowserViewVisible(payload.id, payload.visible, reason) }
})
ipcMain.handle('fan:browser:present', (_event, payload = {}) =>
  presentBrowserSurface(payload.id, payload.rect, payload.ownerId)
)
ipcMain.handle('fan:browser:detachSurface', (_event, payload = {}) => {
  return detachBrowserSurface(payload.id, payload.reason || 'layout', payload.ownerId)
})
ipcMain.handle('fan:browser:hideAll', (_event, payload = {}) => {
  const ok = hideAllBrowserViews(payload.reason || 'layout')
  return ok ? { ok: true } : { ok: false, blocked: 'operating' }
})
ipcMain.handle('fan:browser:overviewTiles', (_event, payload = {}) => ({ ok: setOverviewLiveTiles(payload.tiles) }))
ipcMain.handle('fan:browser:getUrl', (_event, payload = {}) => ({ ok: true, url: getBrowserViewUrl(payload.id) }))
ipcMain.handle('fan:browser:navigate', (_event, payload = {}) =>
  navigateBrowserView(payload.id, payload.url, payload.source === 'omnibox' ? 'omnibox' : 'ui', {
    clientRequestId: payload.clientRequestId,
    expectedTabId: payload.expectedTabId
  })
)
ipcMain.handle('fan:browser:nav', (_event, payload = {}) => browserViewNav(payload.id, payload.op))
ipcMain.handle('fan:browser:navState', (_event, payload = {}) => getBrowserViewNavState(payload.id))
ipcMain.handle('fan:browser:presentationState', (_event, payload = {}) => {
  const state = browserPresentation.snapshot(payload.id)
  const nativeVisible = reconcileBrowserPresentation(payload.id)
  return { ...state, nativeVisible: Boolean(state.nativeVisible && nativeVisible) }
})

function syncSessionBackgroundThrottling(sessionId) {
  const key = String(sessionId || '')
  if (!key) return
  const activeId = activeViewId(key)
  const operating = isSessionOperating(key)
  const visuallyOperating = isSessionVisuallyOperating(key)
  for (const [viewId, view] of browserViews.entries()) {
    if (String(viewId).split('#')[0] !== key) continue
    const wc = view?.webContents
    if (!wc || wc.isDestroyed()) continue
    try {
      // Only the active tab needs full-rate timers while automation is in
      // flight. Hidden sibling tabs keep Chromium's normal CPU throttling.
      wc.setBackgroundThrottling(!(operating && String(viewId) === activeId))
      // While the browser task remains visually active (including a human
      // verification hold), page input must not activate Fan's native menu.
      // The page still receives its own shortcuts; only Electron application
      // menu accelerators are ignored.
      wc.setIgnoreMenuShortcuts(visuallyOperating)
    } catch (err) {
      _browserLog(`browser runtime policy update failed for ${viewId}: ${err?.message || err}`)
    }
  }
}

function syncAllSessionBackgroundThrottling() {
  for (const sessionId of browserSessionController.sessionIds()) syncSessionBackgroundThrottling(sessionId)
}

async function clearTransientBrowserPins(reason) {
  const sessionIds = new Set(anchorBySession.keys())
  if (browserRuntime && typeof browserRuntime.isOperating === 'function') {
    for (const sessionId of browserSessionController.sessionIds()) {
      if (browserRuntime.isOperating(sessionId)) sessionIds.add(String(sessionId))
    }
  }

  anchorBySession.clear()
  const transitions = []
  if (browserRuntime) {
    for (const sessionId of sessionIds) {
      try {
        transitions.push(
          Promise.resolve(browserRuntime.endControl(sessionId, { force: true, reason })).catch(err => {
            _browserLog(`endControl(${sessionId}) during ${reason} failed: ${err?.message || err}`)
          })
        )
      } catch (err) {
        _browserLog(`endControl(${sessionId}) during ${reason} failed: ${err?.message || err}`)
      }
    }
  }
  for (const sessionId of sessionIds) syncSessionBackgroundThrottling(sessionId)
  await Promise.all(transitions)
  for (const sessionId of sessionIds) syncSessionBackgroundThrottling(sessionId)
}

ipcMain.handle('fan:browser:controlState', async (_event, payload = {}) => {
  const key = String(payload.id || '')
  if (!key) return { ok: false, state: null }
  const state = await Promise.resolve(ensureBrowserRuntime().controlState(key))
  const operating = _browserOperatingSnapshot(key)
  return {
    ok: true,
    state: state
      ? {
          ...state,
          operating: operating?.active === true,
          operatingRevision: operating?.revision || 0
        }
      : null
  }
})
ipcMain.handle('fan:browser:shellState', (_event, payload = {}) => ({
  ok: true,
  state: browserShellController.shellState(payload.id)
}))
ipcMain.handle('fan:browser:respondShellPrompt', (_event, payload = {}) =>
  browserShellController.respondShellPrompt(payload.eventId, {
    accepted: payload.accepted === true,
    value: payload.value
  })
)
ipcMain.handle('fan:browser:openDownload', (_event, payload = {}) =>
  browserShellController.openDownload(payload.eventId)
)
ipcMain.handle('fan:browser:revealDownload', (_event, payload = {}) =>
  browserShellController.revealDownload(payload.eventId)
)
ipcMain.handle('fan:browser:listTabs', (_event, payload = {}) => ({ ok: true, ..._tabsStateFor(payload.id) }))
ipcMain.handle('fan:browser:restoreTabs', async (_event, payload = {}) => ({
  ok: await restoreTabs(payload.id, payload.state || {})
}))
ipcMain.handle('fan:browser:newTab', async (_event, payload = {}) => {
  const tabId = await addTab(payload.id, payload.url || 'about:blank', 'user')
  return { ok: Boolean(tabId), tabId, reason: tabId ? undefined : 'view-limit' }
})
ipcMain.handle('fan:browser:switchTab', (_event, payload = {}) => ({
  ok: setActiveTab(payload.id, payload.tabId, 'user')
}))
ipcMain.handle('fan:browser:reorderTab', (_event, payload = {}) => ({
  ok: reorderTab(payload.id, payload.tabId, payload.toIndex)
}))
ipcMain.handle('fan:browser:closeTab', async (_event, payload = {}) => {
  // Closing the agent's working tab mid-takeover is lossy/irreversible, so unlike
  // switch/new (allow + pause + restore) we soft-block it; the renderer shows a
  // toast. The user can still close after the turn ends (operating cleared).
  const key = String(payload.id || '')
  const _diagOperating = isSessionOperating(key)
  _browserLog(`[tabdiag] closeTab IPC id=${key} tabId=${payload.tabId} operating=${_diagOperating}`)
  if (_diagOperating) return { ok: false, blocked: 'operating' }
  const _diagOk = await removeTab(key, payload.tabId)
  _browserLog(`[tabdiag] closeTab IPC done tabId=${payload.tabId} removeTab.ok=${_diagOk}`)
  return { ok: _diagOk }
})
ipcMain.handle('fan:browser:destroy', async (_event, payload = {}) => ({
  ok: await destroyBrowserView(payload.id, payload.reapPartition === true)
}))
ipcMain.handle('fan:browser:hibernate', (_event, payload = {}) => hibernateBrowserSession(payload.id))
ipcMain.handle('fan:browser:captureThumbnail', async (_event, payload = {}) => ({
  ok: true,
  dataUrl: await captureBrowserThumbnail(payload.id)
}))
ipcMain.handle('fan:browser:captureOverviewThumbnail', async (_event, payload = {}) => ({
  ok: true,
  dataUrl: await captureOverviewBrowserThumbnail(payload.id)
}))

function normalizedOverviewThumbnailRect(rect) {
  const normalized = {
    x: Math.round(Number(rect?.x)),
    y: Math.round(Number(rect?.y)),
    width: Math.round(Number(rect?.width)),
    height: Math.round(Number(rect?.height))
  }
  if (
    !Object.values(normalized).every(Number.isFinite) ||
    normalized.width <= 0 ||
    normalized.height <= 0
  ) {
    return null
  }
  return normalized
}

function isOverviewThumbnailRectOnScreen(rect) {
  if (
    !rect ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !mainWindow.isVisible() ||
    mainWindow.isMinimized()
  ) {
    return false
  }
  const contentBounds = mainWindow.getContentBounds()
  return (
    rect.x < contentBounds.width &&
    rect.y < contentBounds.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0
  )
}

function sameOverviewThumbnailRect(left, right) {
  return Boolean(
    left &&
    right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  )
}

function overviewThumbnailControlRevision(key) {
  try {
    const revision = browserRuntime?.controlState?.(key)?.revision
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
  } catch {
    return 0
  }
}

function currentOverviewThumbnailTarget(id) {
  const key = String(id || '')
  if (!key || !overviewTileIds.has(key) || isSessionThumbnailCaptureUnsafe(key)) return null

  const rect = normalizedOverviewThumbnailRect(overviewTileRects.get(key))
  if (!isOverviewThumbnailRectOnScreen(rect)) return null

  const activeId = activeViewId(key)
  const view = browserViews.get(activeId)
  const wc = view?.webContents
  if (!wc || wc.isDestroyed() || !browserViewLifecycle.isAttached(view)) return null
  if (typeof view.getVisible === 'function' && !view.getVisible()) return null

  const viewRect = normalizedOverviewThumbnailRect(view.getBounds?.())
  if (!sameOverviewThumbnailRect(rect, viewRect)) return null

  return {
    activeId,
    controlRevision: overviewThumbnailControlRevision(key),
    documentRevision: documentRevisionByView.get(activeId) || 0,
    key,
    rect,
    view,
    viewEpoch: viewEpochById.get(activeId) || 0,
    wc
  }
}

function isOverviewThumbnailTargetCurrent(target) {
  if (!target || isSessionThumbnailCaptureUnsafe(target.key)) return false
  if (!overviewTileIds.has(target.key) || activeViewId(target.key) !== target.activeId) return false
  if (browserViews.get(target.activeId) !== target.view) return false
  if (target.wc.isDestroyed() || !browserViewLifecycle.isAttached(target.view)) return false
  if (typeof target.view.getVisible === 'function' && !target.view.getVisible()) return false
  if (viewEpochById.get(target.activeId) !== target.viewEpoch) return false
  if ((documentRevisionByView.get(target.activeId) || 0) !== target.documentRevision) return false
  if (overviewThumbnailControlRevision(target.key) !== target.controlRevision) return false

  const rect = normalizedOverviewThumbnailRect(overviewTileRects.get(target.key))
  const viewRect = normalizedOverviewThumbnailRect(target.view.getBounds?.())
  return (
    isOverviewThumbnailRectOnScreen(rect) &&
    sameOverviewThumbnailRect(target.rect, rect) &&
    sameOverviewThumbnailRect(target.rect, viewRect)
  )
}

function browserThumbnailDataUrl(image) {
  const size = image?.getSize?.()
  if (!size?.width || !size?.height) return null
  const targetWidth = Math.min(960, size.width)
  const resized = image.resize({
    width: targetWidth,
    height: Math.round(size.height * (targetWidth / size.width)),
    quality: 'better'
  })
  return `data:image/jpeg;base64,${resized.toJPEG(82).toString('base64')}`
}

async function overviewThumbnailVisualsAreClean(wc) {
  if (!wc || wc.isDestroyed() || typeof wc.executeJavaScript !== 'function') return false
  try {
    return (
      (await wc.executeJavaScript(
        `(() => !document.getElementById('__fan_operating_frame') && !document.getElementById('__fan_cursor') && !document.getElementById('__fan_op_style'))()`,
        true
      )) === true
    )
  } catch {
    // Failing closed is important here: an unreachable/unresponsive document
    // cannot prove that the page-injected operating visuals were removed.
    return false
  }
}

// Capture the clean final frame of a page that is still visibly floated over
// an on-screen Canvas tile. This is intentionally a separate path from the
// foreground capture above: merely having a hidden/detached WebContents is not
// enough to guarantee a fresh Chromium compositor frame. The renderer owns the
// subsequent static-image swap and only removes the live tile after this call
// settles.
async function captureOverviewBrowserThumbnail(id) {
  const target = currentOverviewThumbnailTarget(id)
  if (!target) return null
  try {
    // endControl normally removes these before publishing inactive state, but
    // cleanup is best-effort when a renderer/debugger is unhealthy. Confirm the
    // main document itself is clean instead of baking a failed cleanup into the
    // durable Canvas still.
    if (!(await overviewThumbnailVisualsAreClean(target.wc))) return null
    if (!isOverviewThumbnailTargetCurrent(target)) return null
    const image = await target.wc.capturePage()
    // Capturing is asynchronous. A new Agent control lease, navigation, active
    // tab switch, View replacement, Canvas scroll/resize, or tile teardown may
    // have won while Chromium produced the NativeImage. Never persist that
    // ambiguously-timed frame.
    if (!isOverviewThumbnailTargetCurrent(target)) return null
    if (!(await overviewThumbnailVisualsAreClean(target.wc))) return null
    if (!isOverviewThumbnailTargetCurrent(target)) return null
    return browserThumbnailDataUrl(image)
  } catch (err) {
    _browserLog(`captureOverviewThumbnail failed: ${err?.message || err}`)
    return null
  }
}

// Safari "show all tabs" model: a STATIC downscaled still of the session's page,
// captured on demand right before the user leaves it. Never a live view, never
// polled. Only the currently-foregrounded, painted view can be captured — a
// background/destroyed view returns null. Operating pages are rejected before
// capturePage so the in-page frame/cursor can never enter durable state.
// The JPEG is capped at 960px: sharp enough for a ~400 CSS-pixel card on Retina,
// while the renderer's bounded cache prevents unbounded storage growth.
async function captureBrowserThumbnail(id) {
  const key = String(id || '')
  if (!key || key !== foregroundSessionKey) return null
  if (isSessionThumbnailCaptureUnsafe(key)) return null
  const view = getBrowserView(activeViewId(key))
  const wc = view?.webContents
  if (!wc || wc.isDestroyed()) return null
  try {
    const image = await wc.capturePage()
    // A new Agent turn may begin while Chromium is producing the NativeImage.
    // Discard that race instead of persisting an ambiguously-timed frame.
    if (isSessionThumbnailCaptureUnsafe(key)) return null
    return browserThumbnailDataUrl(image)
  } catch (err) {
    _browserLog(`captureThumbnail failed: ${err?.message || err}`)
    return null
  }
}
function createWindow() {
  const icon = getAppIconPath()
  const savedWorkspaceState = readWorkspaceWindowState()
  const savedWorkspaceBounds = restoredWorkspaceBounds(savedWorkspaceState)
  mainWindow = new BrowserWindow({
    // Hidden until the renderer paints its first frame — otherwise the empty
    // window shows as a white/opaque flash before React mounts (ready-to-show
    // below reveals it once content is ready).
    show: false,
    width: savedWorkspaceBounds?.width || WORKSPACE_WINDOW_SIZE.width,
    height: savedWorkspaceBounds?.height || WORKSPACE_WINDOW_SIZE.height,
    ...(!savedWorkspaceBounds ||
    !isFiniteWindowNumber(savedWorkspaceBounds.x) ||
    !isFiniteWindowNumber(savedWorkspaceBounds.y)
      ? {}
      : { x: savedWorkspaceBounds.x, y: savedWorkspaceBounds.y }),
    useContentSize: true,
    minWidth: WORKSPACE_MIN_SIZE.width,
    minHeight: WORKSPACE_MIN_SIZE.height,
    title: 'Fan',
    // macOS: hidden title bar + native traffic lights (inset via
    // trafficLightPosition). Windows/Linux: a fully frameless window — with
    // titleBarStyle:'hidden' the OS still paints its own caption buttons (they
    // doubled up under our self-drawn ones), so the frame is removed entirely
    // and the renderer draws min/max/close itself (fan:window:* IPC). Dragging
    // comes from the renderer's -webkit-app-region:drag strips.
    frame: IS_MAC ? undefined : false,
    titleBarStyle: IS_MAC ? 'hidden' : undefined,
    titleBarOverlay: IS_MAC ? getTitleBarOverlayOptions() : undefined,
    trafficLightPosition: IS_MAC ? WINDOW_BUTTON_POSITION : undefined,
    // Glass redesign: macOS gets a true transparent window with vibrancy. On
    // Windows, transparent + backgroundMaterial proved broken in practice (the
    // renderer's pixels never composite — a grey acrylic window with only the
    // native browser view visible), so Windows stays opaque and the renderer's
    // own bloom backdrop + CSS glass carry the look. Win11 still rounds the
    // window corners natively.
    transparent: IS_MAC,
    roundedCorners: true,
    vibrancy: IS_MAC ? 'under-window' : undefined,
    // Pin the native material to its ACTIVE appearance for the window's whole
    // lifetime. Default 'followWindow' swaps materials to a grey inactive
    // variant whenever the window loses key status — with Cmd+Tab / Stage
    // Manager that reads as a grey↔tinted flash on every focus change (and
    // the switcher snapshot gets taken in whichever state it happens to
    // catch). There is no runtime setter, so this must be set at construction.
    visualEffectState: IS_MAC ? 'active' : undefined,
    icon,
    // Windows is opaque, so this shows in the sliver between the OS window
    // rounding and the renderer's larger content rounding — keep it matched to
    // the bloom backdrop's base color (styles.css --bloom-grad) so the corners
    // never reveal a flat off-tone patch.
    backgroundColor: IS_MAC ? '#00000000' : '#e8edf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      webviewTag: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true,
      // Keep timers + rAF running at full speed when the window is blurred/
      // occluded — our chat transcript streams through a rAF-gated flush, so
      // Chromium's default background throttling would stall the live answer
      // whenever the window isn't focused. Matches the secondary window above.
      backgroundThrottling: false
    }
  })

  if (IS_MAC) {
    mainWindow.setWindowButtonPosition?.(WINDOW_BUTTON_POSITION)
  }

  if (savedWorkspaceState?.isMaximized) {
    mainWindow.maximize()
  }

  // Feed the renderer's self-drawn maximize/restore toggle.
  const sendMaximizedState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents?.send('fan:window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', () => {
    sendMaximizedState()
    scheduleWorkspaceWindowStatePersist()
  })
  mainWindow.on('unmaximize', () => {
    sendMaximizedState()
    scheduleWorkspaceWindowStatePersist()
  })
  mainWindow.on('resized', scheduleWorkspaceWindowStatePersist)
  mainWindow.on('moved', scheduleWorkspaceWindowStatePersist)
  const createdWindow = mainWindow
  const createdContentView = createdWindow.contentView
  createdWindow.on('close', event => {
    scheduleWorkspaceWindowStatePersist.flush()
    // Closing the window preserves the complete workspace on every desktop:
    // renderer state, native browser pages, terminals, and the gateway socket.
    // Explicit application quit and updater-driven replacement set
    // isAppQuitting first and fall through to the real teardown path below.
    if (!isAppQuitting && (IS_MAC || hasUsableApplicationTray())) {
      event.preventDefault()
      hideDownloadPopover('outside', true)
      createdWindow.hide()
      syncAllSessionBackgroundThrottling()
      return
    }
    releaseBrowserViewsForClosedWindow(createdContentView)
  })
  // Windows can end the desktop session without Electron's ordinary
  // before-quit sequence. Never let the close-to-Tray policy block OS logout
  // or shutdown.
  if (IS_WINDOWS) {
    createdWindow.on('query-session-end', () => {
      isAppQuitting = true
    })
    createdWindow.on('session-end', () => {
      isAppQuitting = true
    })
  }
  createdWindow.on('closed', () => {
    // Idempotent fallback for native teardown paths that bypass or interrupt
    // the normal close callback.
    if (mainWindow === createdWindow) destroyDownloadPopover()
    browserViewLifecycle.releaseHost(createdContentView)
    if (mainWindow !== createdWindow) return
    mainWindow = null
  })

  mainWindow.on('will-enter-full-screen', () => sendWindowStateChanged(true))
  mainWindow.on('enter-full-screen', () => sendWindowStateChanged(true))
  mainWindow.on('will-leave-full-screen', () => sendWindowStateChanged(false))
  mainWindow.on('leave-full-screen', () => sendWindowStateChanged(false))

  installPreviewShortcut(mainWindow)
  installDevToolsShortcut(mainWindow)
  installZoomShortcuts(mainWindow)
  installContextMenu(mainWindow)
  mainWindow.webContents.setWindowOpenHandler(details => {
    openExternalUrl(details.url)

    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if ((DEV_SERVER && url.startsWith(DEV_SERVER)) || (!DEV_SERVER && url.startsWith('file:'))) {
      return
    }

    event.preventDefault()
    openExternalUrl(url)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    rememberLog(`[renderer] render-process-gone reason=${details?.reason} exitCode=${details?.exitCode}`)

    // React cleanup never runs on a dead renderer. Hide every native surface,
    // but preserve Agent operating state and HITL anchors across the UI reload.
    // Throttling is recomputed from those existing states so active automation
    // can continue while the React shell recovers.
    hideAllBrowserViews('lifecycle')
    destroyDownloadPopover()
    hideBrowserScrim()
    syncAllSessionBackgroundThrottling()

    if (details?.reason === 'crashed' || details?.reason === 'oom') {
      const now = Date.now()
      rendererReloadTimes = rendererReloadTimes.filter(t => now - t < RENDERER_RELOAD_WINDOW_MS)

      if (rendererReloadTimes.length >= RENDERER_RELOAD_MAX) {
        rememberLog(
          `[renderer] suppressing reload: ${rendererReloadTimes.length} crashes within ${RENDERER_RELOAD_WINDOW_MS}ms (likely a crash loop)`
        )

        return
      }

      rendererReloadTimes.push(now)
      setImmediate(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        try {
          mainWindow.webContents.reload()
        } catch (err) {
          rememberLog(`[renderer] reload after crash failed: ${err?.message || err}`)
        }
      })
    }
  })

  mainWindow.webContents.on('unresponsive', () => rememberLog('[renderer] webContents became unresponsive'))

  // Electron always passes the event first. The canonical (Electron 36+) shape
  // is (event, messageDetails); the deprecated positional shape is
  // (event, level, message, line, sourceId). Handle both. `level` is numeric
  // (0..3), where 3 === error.
  mainWindow.webContents.on('console-message', (_event, detailsOrLevel, message, line, sourceId) => {
    const details = detailsOrLevel && typeof detailsOrLevel === 'object' ? detailsOrLevel : null
    const level = details ? details.level : detailsOrLevel

    if (level !== 3) return

    const text = details ? details.message : message
    const src = details ? details.sourceUrl : sourceId
    const lineNo = details ? details.lineNumber : line
    rememberLog(`[renderer console] ${text} (${src}:${lineNo})`)
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  if (DEV_SERVER) {
    mainWindow.loadURL(DEV_SERVER)
  } else {
    mainWindow.loadURL(pathToFileURL(resolveRendererIndex()).toString())
  }

  mainWindow.webContents.once('did-finish-load', () => {
    restorePersistedZoomLevel(mainWindow)
    broadcastBootProgress()
    sendWindowStateChanged()
    startFan().catch(error => rememberLog(error.stack || error.message))
  })
}

ipcMain.handle('fan:connection', async () => ensureBackend())
ipcMain.handle('fan:gateway:ws-url', async () => freshGatewayWsUrl())
ipcMain.handle('fan:bootstrap:reset', async () => {
  // Renderer's "Reload and retry" path. Clear the latched failure and
  // reset connection state so the next startFan() call restarts the
  // full backend flow (including a fresh runBootstrap pass).
  rememberLog('[bootstrap] reset requested by renderer; clearing latched failure')
  bootstrapFailure = null
  backendStartFailure = null
  connectionPromise = null
  bootstrapState = {
    active: false,
    manifest: null,
    stages: {},
    error: null,
    log: [],
    startedAt: null,
    completedAt: null,
    unsupportedPlatform: null
  }
  return { ok: true }
})
ipcMain.handle('fan:bootstrap:cancel', async () => {
  // Renderer's Cancel button during first-launch install. Abort the running
  // install script (SIGTERM via the runner's abortSignal). runBootstrap
  // resolves with { cancelled: true }, which surfaces the recovery overlay.
  if (bootstrapAbortController) {
    try {
      bootstrapAbortController.abort()
    } catch {
      void 0
    }
    return { ok: true, cancelled: true }
  }
  return { ok: false, cancelled: false }
})
ipcMain.handle('fan:boot-progress:get', async () => bootProgressState)
ipcMain.handle('fan:bootstrap:get', async () => getBootstrapState())

ipcMain.on('fan:previewShortcutActive', (_event, active) => {
  previewShortcutActive = Boolean(active)
})

ipcMain.handle('fan:requestMicrophoneAccess', async () => {
  if (!IS_MAC || typeof systemPreferences.askForMediaAccess !== 'function') {
    return true
  }

  return systemPreferences.askForMediaAccess('microphone')
})

ipcMain.handle('fan:api', async (_event, request) => {
  const connection = await ensureBackend()
  const timeoutMs = resolveTimeoutMs(request?.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
  const url = `${connection.baseUrl}${request.path}`
  // Local backend: REST is authed by the loopback session-token header.
  return fetchJson(url, connection.token, {
    method: request?.method,
    body: request?.body,
    timeoutMs
  })
})

ipcMain.handle('fan:notify', (_event, payload) => {
  if (!Notification.isSupported()) return false
  // Show the Fan mark in the OS notification (was icon-less). getAppIconPath
  // resolves the first existing apple-touch-icon.png (the round brand mark);
  // omit the key entirely if none is found so Electron falls back cleanly.
  const icon = getAppIconPath()
  new Notification({
    title: payload?.title || 'Fan',
    body: payload?.body || '',
    silent: Boolean(payload?.silent),
    ...(icon ? { icon } : {})
  }).show()
  return true
})

ipcMain.handle('fan:readFileDataUrl', async (_event, filePath) => {
  const { realPath } = await resolveReadableFileForIpc(filePath, {
    maxBytes: DATA_URL_READ_MAX_BYTES,
    purpose: 'File preview'
  })
  // Read the realpath()-resolved target (not the possibly-symlink resolvedPath)
  // so the read can't be redirected past the sensitive-path check (TOCTOU).
  const data = await fs.promises.readFile(realPath)
  return `data:${mimeTypeForPath(realPath)};base64,${data.toString('base64')}`
})

ipcMain.handle('fan:readFileText', async (_event, filePath) => {
  const { realPath, resolvedPath, stat } = await resolveReadableFileForIpc(filePath, {
    maxBytes: TEXT_PREVIEW_SOURCE_MAX_BYTES,
    purpose: 'Text preview'
  })
  // Open the realpath()-resolved target so the read can't be redirected past
  // the sensitive-path check (TOCTOU); keep resolvedPath for the UI `path`.
  const ext = path.extname(realPath).toLowerCase()
  const handle = await fs.promises.open(realPath, 'r')
  const bytesToRead = Math.min(stat.size, TEXT_PREVIEW_MAX_BYTES)

  try {
    const buffer = Buffer.alloc(bytesToRead)
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)

    return {
      binary: looksBinary(buffer.subarray(0, Math.min(bytesRead, 4096))),
      byteSize: stat.size,
      language: PREVIEW_LANGUAGE_BY_EXT[ext] || 'text',
      mimeType: mimeTypeForPath(realPath),
      path: resolvedPath,
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > TEXT_PREVIEW_MAX_BYTES
    }
  } finally {
    await handle.close()
  }
})

ipcMain.handle('fan:selectPaths', async (_event, options = {}) => {
  const properties = options?.directories ? ['openDirectory'] : ['openFile']
  if (options?.multiple !== false) properties.push('multiSelections')

  let resolvedDefaultPath
  if (options?.defaultPath) {
    try {
      resolvedDefaultPath = path.resolve(String(options.defaultPath))
    } catch {
      resolvedDefaultPath = undefined
    }
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title || 'Add context',
    defaultPath: resolvedDefaultPath,
    properties,
    filters: Array.isArray(options?.filters) ? options.filters : undefined
  })

  if (result.canceled) return []
  return result.filePaths
})

// ── Collect vault ────────────────────────────────────────────────────────────
// Local encrypted store for reusable form values the user gave the collect
// card (phone / ID / invoice title …), so repeat collections prefill (“越用越
// 聪明”). Values are encrypted with the OS keychain (safeStorage) and never
// leave this machine; one-time values (otp/captcha) are filtered renderer-side
// and never reach here.
const COLLECT_VAULT_FILE = () => path.join(app.getPath('userData'), 'collect-vault.json')
// Prototype-polluting keys would land on Object.prototype instead of the vault
// object (then vanish from JSON.stringify) — never accept them as entry names.
const VAULT_FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const VAULT_MAX_ENTRIES = 500
const VAULT_MAX_VALUE_LEN = 10_000

// True keychain-backed encryption only. Linux `basic_text` "encrypts" with a
// hardcoded Chromium key — storing PII under it would betray the collect
// card's "OS-keychain encrypted" promise, so treat it as unavailable.
function _vaultUsable() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    }
    return true
  } catch {
    return false
  }
}

function _readCollectVault() {
  // Null prototype: entry names come from the renderer, so lookups/assignments
  // must never collide with Object.prototype members.
  try {
    return Object.assign(Object.create(null), JSON.parse(fs.readFileSync(COLLECT_VAULT_FILE(), 'utf8')) || {})
  } catch {
    return Object.create(null)
  }
}

ipcMain.handle('fan:vault:get', (_event, payload) => {
  if (!_vaultUsable()) return {}
  const names = Array.isArray(payload?.names) ? payload.names.slice(0, VAULT_MAX_ENTRIES).map(String) : []
  const vault = _readCollectVault()
  const out = {}
  for (const name of names) {
    if (VAULT_FORBIDDEN_KEYS.has(name)) continue
    const entry = vault[name]
    if (!entry?.v) continue
    try {
      out[name] = safeStorage.decryptString(Buffer.from(entry.v, 'base64'))
    } catch {
      // Key changed (OS keychain reset) — drop silently; the user just retypes.
    }
  }
  return out
})

ipcMain.handle('fan:vault:set', (_event, payload) => {
  if (!_vaultUsable()) return false
  const entries = payload?.entries && typeof payload.entries === 'object' ? payload.entries : {}
  const vault = _readCollectVault()
  let changed = false
  for (const [name, value] of Object.entries(entries)) {
    const key = String(name).slice(0, 200)
    const text = String(value ?? '').trim()
    if (!key || !text || text.length > VAULT_MAX_VALUE_LEN || VAULT_FORBIDDEN_KEYS.has(key)) continue
    if (Object.keys(vault).length >= VAULT_MAX_ENTRIES && !(key in vault)) continue
    vault[key] = { v: safeStorage.encryptString(text).toString('base64'), t: Date.now() }
    changed = true
  }
  if (changed) {
    // Atomic tmp+rename (writeFileSync truncates in place — an ENOSPC crash
    // mid-write would wipe every remembered value) and 0600: PII stays
    // owner-readable only.
    const file = COLLECT_VAULT_FILE()
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(vault), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  return changed
})

ipcMain.handle('fan:writeClipboard', (_event, text) => {
  clipboard.writeText(String(text || ''))
  return true
})

ipcMain.handle('fan:saveImageFromUrl', (_event, url) => saveImageFromUrl(String(url || '')))

ipcMain.handle('fan:saveImageBuffer', async (_event, payload) => {
  const data = payload?.data
  if (!data) throw new Error('saveImageBuffer: missing data')

  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return writeComposerImage(buffer, payload?.ext || '.png')
})

ipcMain.handle('fan:saveClipboardImage', async () => {
  const image = clipboard.readImage()
  if (image && !image.isEmpty()) {
    return writeComposerImage(image.toPNG(), '.png')
  }

  // WSL2/WSLg does not consistently bridge Windows host clipboard images to
  // Electron's Linux clipboard.  A user-triggered paste may fall back to the
  // fixed host-reader helper; it returns null for an empty/invalid clipboard.
  if (IS_WSL) {
    const hostImage = readWslWindowsClipboardImage()
    if (hostImage) {
      return writeComposerImage(hostImage, '.png')
    }
  }

  return ''
})

ipcMain.handle('fan:normalizePreviewTarget', (_event, target, baseDir) =>
  normalizePreviewTarget(String(target || ''), baseDir ? String(baseDir) : '')
)

ipcMain.handle('fan:watchPreviewFile', (_event, url) => watchPreviewFile(String(url || '')))

ipcMain.handle('fan:stopPreviewFileWatch', (_event, id) => stopPreviewFileWatch(String(id || '')))

ipcMain.on('fan:titlebar-theme', (_event, payload) => {
  if (!payload || !isHexColor(payload.background) || !isHexColor(payload.foreground)) {
    return
  }

  rendererTitleBarTheme = {
    background: payload.background,
    foreground: payload.foreground
  }

  // Only macOS still has a native overlay; calling setTitleBarOverlay on a
  // window created without one throws.
  if (IS_MAC) {
    mainWindow?.setTitleBarOverlay?.(getTitleBarOverlayOptions())
  }
})

// Self-drawn window controls (Windows/Linux — the native overlay's hover
// highlight can't be styled, so the renderer draws its own buttons).
ipcMain.handle('fan:window:minimize', () => {
  mainWindow?.minimize()
})

ipcMain.handle('fan:window:toggle-maximize', () => {
  if (!mainWindow) {
    return false
  }
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
  return mainWindow.isMaximized()
})

ipcMain.handle('fan:window:close', () => {
  mainWindow?.close()
})

ipcMain.handle('fan:window:is-maximized', () => Boolean(mainWindow?.isMaximized()))

ipcMain.handle('fan:application-menu:popup', event => {
  if (
    IS_MAC ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    (event.senderFrame && event.senderFrame !== mainWindow.webContents.mainFrame)
  ) {
    return false
  }

  const menu = Menu.getApplicationMenu() || buildApplicationMenu()
  menu.popup({ window: mainWindow })
  return true
})

ipcMain.handle('fan:openExternal', (_event, url) => {
  if (!openExternalUrl(url)) {
    throw new Error('Invalid external URL')
  }
})

// User-configurable default project directory. The renderer reads this on
// settings mount and seeds the value into the picker; writing back persists
// it via writeDefaultProjectDir so resolveFanCwd picks it up on the next
// session spawn (no app restart needed).
ipcMain.handle('fan:setting:defaultProjectDir:get', async () => ({
  dir: readDefaultProjectDir(),
  defaultLabel: path.join(app.getPath('home'), 'fan-projects')
}))

// Validate a workspace cwd (reject install-dir / non-existent) before the
// renderer seeds it for a new session.
ipcMain.handle('fan:workspace:sanitize', async (_event, cwd) => sanitizeWorkspaceCwd(cwd))

ipcMain.handle('fan:setting:defaultProjectDir:set', async (_event, dir) => {
  const next = typeof dir === 'string' && dir.trim() ? dir.trim() : null

  if (next) {
    try {
      fs.mkdirSync(next, { recursive: true })
    } catch (error) {
      throw new Error(`Could not create directory: ${error.message}`)
    }
  }

  writeDefaultProjectDir(next)

  return { dir: next }
})

ipcMain.handle('fan:setting:defaultProjectDir:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose default project directory',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: readDefaultProjectDir() || app.getPath('home')
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, dir: null }
  }

  return { canceled: false, dir: result.filePaths[0] }
})

// Settings, menu actions, and Cmd/Ctrl zoom shortcuts all flow through the
// same persisted, clamped zoom scale.
ipcMain.handle('fan:zoom:get', event => {
  const window = BrowserWindow.fromWebContents(event.sender)
  const level = window && !window.isDestroyed() ? window.webContents.getZoomLevel() : 0
  return { level, percent: zoomLevelToPercent(level) }
})

ipcMain.on('fan:zoom:set-percent', (event, percent) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) return
  setAndPersistZoomLevel(window, percentToZoomLevel(Number(percent)))
})

ipcMain.handle('fan:fetchLinkTitle', (_event, url) => fetchLinkTitle(url))

ipcMain.handle('fan:logs:reveal', async () => {
  try {
    await fs.promises.mkdir(path.dirname(DESKTOP_LOG_PATH), { recursive: true })
    if (!fileExists(DESKTOP_LOG_PATH)) {
      await fs.promises.appendFile(DESKTOP_LOG_PATH, '')
    }
    shell.showItemInFolder(DESKTOP_LOG_PATH)
    return { ok: true, path: DESKTOP_LOG_PATH }
  } catch (error) {
    return { ok: false, path: DESKTOP_LOG_PATH, error: error.message }
  }
})

ipcMain.handle('fan:logs:recent', async () => ({ path: DESKTOP_LOG_PATH, lines: fanLog.slice(-200) }))

// Always-hidden noise (covers non-git projects too — gitignore would catch
// these anyway when present, but we want the same hygiene without one).
const FS_READDIR_HIDDEN = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
  'venv'
])

function findGitRoot(start) {
  let dir = start

  for (let i = 0; i < 50; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        return dir
      }
    } catch {
      return null
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      return null
    }

    dir = parent
  }

  return null
}

function terminalShellCommand() {
  if (IS_WINDOWS) {
    return { args: [], command: process.env.COMSPEC || 'cmd.exe' }
  }

  const configuredShell = process.env.SHELL || ''
  const shellPath =
    (path.isAbsolute(configuredShell) && fs.existsSync(configuredShell) && configuredShell) ||
    ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => fs.existsSync(candidate)) ||
    '/bin/sh'
  const shellName = path.basename(shellPath)
  const interactiveArgs = shellName.includes('zsh') || shellName.includes('bash') ? ['-il'] : ['-i']

  return { args: interactiveArgs, command: shellPath, name: shellName }
}

function safeTerminalCwd(cwd) {
  const candidate = path.resolve(String(cwd || app.getPath('home')))

  try {
    const stat = fs.statSync(candidate)

    return stat.isDirectory() ? candidate : path.dirname(candidate)
  } catch {
    return app.getPath('home')
  }
}

function terminalShellEnv() {
  const env = { ...process.env }

  // Electron is commonly launched through `npm run dev`; do not leak npm's
  // managed prefix into a user's interactive shell (nvm/proto warn loudly).
  for (const key of Object.keys(env)) {
    if (key === 'npm_config_prefix' || key.startsWith('npm_config_') || key.startsWith('npm_package_')) {
      delete env[key]
    }
  }

  // Strip color/theme-detection vars that ride along when Electron is launched
  // from a non-tty agent shell (Cursor's runner sets NO_COLOR/FORCE_COLOR=0
  // /TERM=dumb; some terminals set COLORFGBG which would flip Fan' TUI into
  // light-mode). Our PTY is a real xterm-compat terminal — force truecolor.
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  delete env.COLORFGBG

  env.COLORTERM = 'truecolor'
  env.LC_CTYPE = env.LC_CTYPE || 'UTF-8'
  env.TERM = 'xterm-256color'
  env.TERM_PROGRAM = 'Fan'
  env.TERM_PROGRAM_VERSION = app.getVersion()

  return env
}

function terminalChannel(id, suffix) {
  return `fan:terminal:${id}:${suffix}`
}

function disposeTerminalSession(id) {
  const sessionInfo = terminalSessions.get(id)

  if (!sessionInfo) {
    return false
  }

  terminalSessions.delete(id)

  try {
    sessionInfo.pty.kill()
  } catch {
    // Process may already be gone.
  }

  return true
}

ipcMain.handle('fan:fs:readDir', async (_event, dirPath) => {
  const resolved = path.resolve(String(dirPath || ''))

  if (!resolved) {
    return { entries: [], error: 'invalid-path' }
  }

  try {
    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true })

    const entries = dirents
      .filter(d => {
        if (FS_READDIR_HIDDEN.has(d.name)) {
          return false
        }

        return true
      })
      .map(d => ({ name: d.name, path: path.join(resolved, d.name), isDirectory: d.isDirectory() }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))

    return { entries }
  } catch (error) {
    return { entries: [], error: error?.code || 'read-error' }
  }
})

ipcMain.handle('fan:fs:gitRoot', async (_event, startPath) => {
  const input = String(startPath || '')
  const resolved = input.startsWith('file:') ? fileURLToPath(input) : path.resolve(input)

  try {
    const stat = await fs.promises.stat(resolved)
    const start = stat.isDirectory() ? resolved : path.dirname(resolved)

    return findGitRoot(start)
  } catch {
    return findGitRoot(resolved)
  }
})

ipcMain.handle('fan:terminal:start', async (event, payload = {}) => {
  if (!nodePty) {
    throw new Error('PTY support is unavailable. Reinstall desktop dependencies and restart Fan.')
  }

  const id = crypto.randomUUID()
  const { args, command, name } = terminalShellCommand()
  const cwd = safeTerminalCwd(payload?.cwd)
  const cols = Math.max(2, Number.parseInt(String(payload?.cols || 80), 10) || 80)
  const rows = Math.max(2, Number.parseInt(String(payload?.rows || 24), 10) || 24)
  const ptyProcess = nodePty.spawn(command, args, {
    cols,
    cwd,
    env: terminalShellEnv(),
    name: 'xterm-256color',
    rows
  })

  terminalSessions.set(id, { pty: ptyProcess, webContentsId: event.sender.id })

  const send = (suffix, payload) => {
    if (event.sender.isDestroyed()) {
      return
    }

    event.sender.send(terminalChannel(id, suffix), payload)
  }

  ptyProcess.onData(data => send('data', data))
  ptyProcess.onExit(({ exitCode, signal }) => {
    terminalSessions.delete(id)
    send('exit', { code: exitCode, signal: signal || null })
  })
  event.sender.once('destroyed', () => disposeTerminalSession(id))

  return { cwd, id, shell: name }
})

ipcMain.handle('fan:terminal:write', (_event, id, data) => {
  const sessionInfo = terminalSessions.get(String(id || ''))

  if (!sessionInfo) {
    return false
  }

  sessionInfo.pty.write(String(data || ''))

  return true
})

ipcMain.handle('fan:terminal:resize', (_event, id, size = {}) => {
  const sessionInfo = terminalSessions.get(String(id || ''))

  if (!sessionInfo) {
    return false
  }

  const cols = Math.max(2, Number.parseInt(String(size?.cols || 80), 10) || 80)
  const rows = Math.max(2, Number.parseInt(String(size?.rows || 24), 10) || 24)

  sessionInfo.pty.resize(cols, rows)

  return true
})
ipcMain.handle('fan:terminal:dispose', (_event, id) => disposeTerminalSession(String(id || '')))

ipcMain.handle('fan:updates:check', async () =>
  checkUpdates().catch(error => ({
    supported: true,
    error: 'check-failed',
    message: error?.message || String(error),
    fetchedAt: Date.now()
  }))
)

ipcMain.handle('fan:updates:apply', async () =>
  applyUpdates().catch(error => ({
    ok: false,
    error: 'apply-failed',
    message: error?.message || String(error)
  }))
)

// Resolve the canonical Fan version (the one `release.py` bumps in
// fan_cli/__init__.py + pyproject.toml) so the desktop About panel shows the
// real Fan version instead of the Electron app's own package.json version,
// which historically drifted (stuck at 0.0.2). Falls back to app.getVersion()
// when the source tree can't be read (e.g. a packaged build without the repo).
function resolveFanVersion() {
  try {
    const root = resolveDisplayRoot()
    const initPath = path.join(root, 'fan_cli', '__init__.py')
    if (fileExists(initPath)) {
      const raw = fs.readFileSync(initPath, 'utf8')
      const match = raw.match(/__version__\s*=\s*["']([^"']+)["']/)
      if (match) {
        return match[1]
      }
    }
  } catch {
    // Fall through to the Electron app version below.
  }
  return app.getVersion()
}

ipcMain.handle('fan:version', async () => ({
  appVersion: resolveFanVersion(),
  electronVersion: process.versions.electron,
  nodeVersion: process.versions.node,
  platform: process.platform,
  fanRoot: resolveDisplayRoot()
}))

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  registerFanProtocolClient()
  Menu.setApplicationMenu(buildApplicationMenu())
  installMediaPermissions()
  registerMediaProtocol()
  ensureWslWindowsFonts()
  configureSpellChecker()
  registerPowerResumeListeners()
  void reapOrphanDraftPartitions()
  createApplicationTray()
  createWindow()
  browserResourceGovernor.start()

  app.on('activate', showAndFocusMainWindow)
})

// Seed Chromium's spellchecker with the system locale (falling back to en-US).
// On macOS Electron uses the native spellchecker which ignores this list, but
// on Windows/Linux Chromium downloads Hunspell dictionaries on demand and
// won't enable any without an explicit language.
function configureSpellChecker() {
  try {
    const defaultSession = session.defaultSession

    if (!defaultSession || typeof defaultSession.setSpellCheckerLanguages !== 'function') {
      return
    }

    const available = defaultSession.availableSpellCheckerLanguages || []
    const locale = (app.getLocale && app.getLocale()) || 'en-US'
    const candidates = [locale, locale.split('-')[0], 'en-US', 'en']
    const chosen = candidates.find(lang => available.includes(lang)) || 'en-US'

    defaultSession.setSpellCheckerLanguages([chosen])
  } catch (error) {
    rememberLog(`Spellchecker setup failed: ${error.message}`)
  }
}

const RENDERER_QUIT_FLUSH_TIMEOUT_MS = 1_250
let rendererQuitFlushState = 'idle'
let rendererQuitFlushWebContents = null
let rendererQuitFlushTimer = null
let appShutdownFinalized = false

function usableRendererForQuitFlush() {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const webContents = mainWindow.webContents
  if (!webContents || webContents.isDestroyed() || webContents.isCrashed?.()) return null
  // A renderer that has not reached its document yet cannot have registered
  // the application-level persistence listener. Avoid delaying startup exits.
  if (!webContents.getURL?.() || webContents.isLoadingMainFrame?.()) return null
  return webContents
}

function releaseRendererQuitFlush(reason) {
  if (rendererQuitFlushState !== 'waiting') return false
  if (rendererQuitFlushTimer) {
    clearTimeout(rendererQuitFlushTimer)
    rendererQuitFlushTimer = null
  }
  rendererQuitFlushState = 'released'
  rendererQuitFlushWebContents = null
  rememberLog(`[lifecycle] renderer quit flush released (${reason})`)
  // The first quit was deliberately cancelled. Re-enter Electron's normal
  // quit path after this handler has unwound so before-quit can perform the
  // existing shutdown exactly once.
  setImmediate(() => app.quit())
  return true
}

function requestRendererQuitFlush(event) {
  if (rendererQuitFlushState === 'released' || appShutdownFinalized) return false
  if (rendererQuitFlushState === 'waiting') {
    event.preventDefault()
    return true
  }

  const webContents = usableRendererForQuitFlush()
  if (!webContents) return false

  event.preventDefault()
  rendererQuitFlushState = 'waiting'
  rendererQuitFlushWebContents = webContents
  rendererQuitFlushTimer = setTimeout(
    () => releaseRendererQuitFlush('timeout'),
    RENDERER_QUIT_FLUSH_TIMEOUT_MS
  )

  try {
    webContents.send('fan:lifecycle:before-quit', { timeoutMs: RENDERER_QUIT_FLUSH_TIMEOUT_MS })
  } catch (error) {
    rememberLog(`[lifecycle] renderer quit flush request failed: ${error?.message || String(error)}`)
    releaseRendererQuitFlush('send-failed')
  }
  return true
}

function isExpectedRendererQuitFlushSender(event) {
  const expected = rendererQuitFlushWebContents
  if (rendererQuitFlushState !== 'waiting' || !expected || expected.isDestroyed()) return false
  if (event.sender !== expected) return false
  // Electron supplies senderFrame for frame-originated IPC. Only the main
  // frame may acknowledge a shutdown flush; subframes are not trusted here.
  return !event.senderFrame || event.senderFrame === expected.mainFrame
}

ipcMain.on('fan:lifecycle:quit-flush-complete', event => {
  if (!isExpectedRendererQuitFlushSender(event)) {
    rememberLog('[lifecycle] ignored quit flush acknowledgement from an unexpected renderer')
    return
  }
  releaseRendererQuitFlush('renderer-ack')
})

function finalizeAppShutdown() {
  if (appShutdownFinalized) return
  appShutdownFinalized = true
  if (hasUsableApplicationTray()) {
    applicationTray.destroy()
  }
  applicationTray = null
  for (const id of [...terminalSessions.keys()]) {
    disposeTerminalSession(id)
  }
  browserResourceGovernor.stop()
  // Quitting mid-install should stop the installer, not orphan it.
  if (bootstrapAbortController) {
    try {
      bootstrapAbortController.abort()
    } catch {
      void 0
    }
  }

  if (desktopLogFlushTimer) {
    clearTimeout(desktopLogFlushTimer)
    desktopLogFlushTimer = null
  }
  flushDesktopLogBufferSync()
  closePreviewWatchers()
  closeBrowserRuntime()

  if (fanProcess && !fanProcess.killed) {
    expectedFanProcessExits.add(fanProcess)
    fanProcess.kill('SIGTERM')
  }
}

app.on('before-quit', event => {
  isAppQuitting = true
  if (requestRendererQuitFlush(event)) return
  finalizeAppShutdown()
})

app.on('window-all-closed', () => {
  if (!IS_MAC && !hasUsableApplicationTray()) app.quit()
})
