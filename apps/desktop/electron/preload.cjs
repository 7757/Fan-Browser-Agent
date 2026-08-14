const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('fanDesktop', {
  getConnection: () => ipcRenderer.invoke('fan:connection'),
  getGatewayWsUrl: () => ipcRenderer.invoke('fan:gateway:ws-url'),
  getBootProgress: () => ipcRenderer.invoke('fan:boot-progress:get'),
  lifecycle: {
    onBeforeQuit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:lifecycle:before-quit', listener)
      return () => ipcRenderer.removeListener('fan:lifecycle:before-quit', listener)
    },
    completeQuitFlush: () => ipcRenderer.send('fan:lifecycle:quit-flush-complete')
  },
  api: request => ipcRenderer.invoke('fan:api', request),
  notify: payload => ipcRenderer.invoke('fan:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('fan:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('fan:readFileDataUrl', filePath),
  readFileText: filePath => ipcRenderer.invoke('fan:readFileText', filePath),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('fan:workspace:sanitize', cwd),
  selectPaths: options => ipcRenderer.invoke('fan:selectPaths', options),
  // Collect vault: OS-keychain-encrypted local store for reusable collect-card
  // values (prefill on repeat collections). See main.cjs fan:vault:*.
  vault: {
    get: names => ipcRenderer.invoke('fan:vault:get', { names }),
    set: entries => ipcRenderer.invoke('fan:vault:set', { entries })
  },
  writeClipboard: text => ipcRenderer.invoke('fan:writeClipboard', text),
  saveImageFromUrl: url => ipcRenderer.invoke('fan:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('fan:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('fan:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('fan:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('fan:watchPreviewFile', url),
  stopPreviewFileWatch: id => ipcRenderer.invoke('fan:stopPreviewFileWatch', id),
  setTitleBarTheme: payload => ipcRenderer.send('fan:titlebar-theme', payload),
  applicationMenu: {
    showInTitlebar: process.platform !== 'darwin',
    popup: () => ipcRenderer.invoke('fan:application-menu:popup')
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('fan:window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('fan:window:toggle-maximize'),
    close: () => ipcRenderer.invoke('fan:window:close'),
    isMaximized: () => ipcRenderer.invoke('fan:window:is-maximized'),
    onMaximizedChange: callback => {
      const listener = (_event, maximized) => callback(Boolean(maximized))
      ipcRenderer.on('fan:window:maximized', listener)
      return () => ipcRenderer.removeListener('fan:window:maximized', listener)
    }
  },
  setPreviewShortcutActive: active => ipcRenderer.send('fan:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('fan:openExternal', url),
  fetchLinkTitle: url => ipcRenderer.invoke('fan:fetchLinkTitle', url),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('fan:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('fan:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('fan:setting:defaultProjectDir:pick')
  },
  zoom: {
    get: () => ipcRenderer.invoke('fan:zoom:get'),
    setPercent: percent => ipcRenderer.send('fan:zoom:set-percent', percent),
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:zoom:changed', listener)
      return () => ipcRenderer.removeListener('fan:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('fan:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('fan:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('fan:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('fan:fs:gitRoot', startPath),
  terminal: {
    dispose: id => ipcRenderer.invoke('fan:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('fan:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('fan:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('fan:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `fan:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `fan:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('fan:close-preview-requested', listener)
    return () => ipcRenderer.removeListener('fan:close-preview-requested', listener)
  },
  onOpenAboutRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('fan:open-about', listener)
    return () => ipcRenderer.removeListener('fan:open-about', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('fan:open-updates', listener)
    return () => ipcRenderer.removeListener('fan:open-updates', listener)
  },
  onOpenSettingsRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('fan:open-settings', listener)
    return () => ipcRenderer.removeListener('fan:open-settings', listener)
  },
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('fan:window-state-changed', listener)
    return () => ipcRenderer.removeListener('fan:window-state-changed', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('fan:preview-file-changed', listener)
    return () => ipcRenderer.removeListener('fan:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('fan:backend-exit', listener)
    return () => ipcRenderer.removeListener('fan:backend-exit', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('fan:power-resume', listener)
    return () => ipcRenderer.removeListener('fan:power-resume', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('fan:boot-progress', listener)
    return () => ipcRenderer.removeListener('fan:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.cjs (apps/desktop/electron/bootstrap-runner.cjs).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('fan:bootstrap:get'),
  resetBootstrap: () => ipcRenderer.invoke('fan:bootstrap:reset'),
  cancelBootstrap: () => ipcRenderer.invoke('fan:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('fan:bootstrap:event', listener)
    return () => ipcRenderer.removeListener('fan:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('fan:version'),
  updates: {
    check: () => ipcRenderer.invoke('fan:updates:check'),
    apply: opts => ipcRenderer.invoke('fan:updates:apply', opts),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:updates:progress', listener)
      return () => ipcRenderer.removeListener('fan:updates:progress', listener)
    }
  },
  // Embedded browser workbench: a native WebContentsView floated over a renderer
  // placeholder rect and driven by the Electron-native browser runtime. The
  // renderer can only position/show/hide it through these IPC calls.
  browser: {
    create: (id, url) => ipcRenderer.invoke('fan:browser:create', { id, url }),
    setBounds: (id, rect) => ipcRenderer.invoke('fan:browser:setBounds', { id, rect }),
    setVisible: (id, visible, reason) => ipcRenderer.invoke('fan:browser:setVisible', { id, visible, reason }),
    present: (id, rect, ownerId) => ipcRenderer.invoke('fan:browser:present', { id, rect, ownerId }),
    detachSurface: (id, reason, ownerId) => ipcRenderer.invoke('fan:browser:detachSurface', { id, reason, ownerId }),
    hideAll: reason => ipcRenderer.invoke('fan:browser:hideAll', { reason }),
    // Live overview tiles: position each session's real view over its tile rect,
    // shown simultaneously (bypasses single-foreground). Empty array = clear.
    overviewTiles: tiles => ipcRenderer.invoke('fan:browser:overviewTiles', { tiles }),
    getUrl: id => ipcRenderer.invoke('fan:browser:getUrl', { id }),
    navigate: (id, url, opts) =>
      ipcRenderer.invoke('fan:browser:navigate', {
        id,
        url,
        source: opts?.source,
        clientRequestId: opts?.clientRequestId,
        expectedTabId: opts?.expectedTabId
      }),
    back: id => ipcRenderer.invoke('fan:browser:nav', { id, op: 'back' }),
    forward: id => ipcRenderer.invoke('fan:browser:nav', { id, op: 'forward' }),
    reload: id => ipcRenderer.invoke('fan:browser:nav', { id, op: 'reload' }),
    stop: id => ipcRenderer.invoke('fan:browser:nav', { id, op: 'stop' }),
    navState: id => ipcRenderer.invoke('fan:browser:navState', { id }),
    presentationState: id => ipcRenderer.invoke('fan:browser:presentationState', { id }),
    controlState: async id => {
      const result = await ipcRenderer.invoke('fan:browser:controlState', { id })
      return result?.ok ? result.state || null : null
    },
    shellState: async id => {
      const result = await ipcRenderer.invoke('fan:browser:shellState', { id })
      return result?.ok
        ? result.state
        : { downloads: [], health: [], notices: [], prompts: [], revision: 0 }
    },
    respondShellPrompt: (eventId, response) =>
      ipcRenderer.invoke('fan:browser:respondShellPrompt', {
        accepted: response?.accepted === true,
        eventId,
        value: response?.value
    }),
    openDownload: eventId => ipcRenderer.invoke('fan:browser:openDownload', { eventId }),
    revealDownload: eventId => ipcRenderer.invoke('fan:browser:revealDownload', { eventId }),
    showDownloadPopover: payload => ipcRenderer.invoke('fan:browser:downloadPopover:show', payload),
    hideDownloadPopover: () => ipcRenderer.invoke('fan:browser:downloadPopover:hide'),
    onDownloadPopoverClosed: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:browser:downloadPopover:closed', listener)
      return () => ipcRenderer.removeListener('fan:browser:downloadPopover:closed', listener)
    },
    listTabs: id => ipcRenderer.invoke('fan:browser:listTabs', { id }),
    restoreTabs: (id, state) => ipcRenderer.invoke('fan:browser:restoreTabs', { id, state }),
    newTab: (id, url) => ipcRenderer.invoke('fan:browser:newTab', { id, url }),
    switchTab: (id, tabId) => ipcRenderer.invoke('fan:browser:switchTab', { id, tabId }),
    reorderTab: (id, tabId, toIndex) => ipcRenderer.invoke('fan:browser:reorderTab', { id, tabId, toIndex }),
    closeTab: (id, tabId) => ipcRenderer.invoke('fan:browser:closeTab', { id, tabId }),
    destroy: (id, opts) =>
      ipcRenderer.invoke('fan:browser:destroy', { id, reapPartition: opts?.reapPartition === true }),
    hibernate: id => ipcRenderer.invoke('fan:browser:hibernate', { id }),
    // Safari-style static thumbnail: capture a downscaled JPEG still of the
    // session's currently-shown page (null if not foregrounded/painted).
    captureThumbnail: id => ipcRenderer.invoke('fan:browser:captureThumbnail', { id }),
    // Final clean frame for a live Canvas tile. Main only accepts a currently
    // on-screen, attached overview View and revalidates it after capturePage.
    captureOverviewThumbnail: id => ipcRenderer.invoke('fan:browser:captureOverviewThumbnail', { id }),
    // Native dim layer over the browser rect while a modal is open (the DOM
    // backdrop cannot cover the WebContentsView). Click/Esc inside the scrim
    // surface come back via onScrimDismissed.
    scrimShow: rect => ipcRenderer.invoke('fan:browser:scrim:show', { rect }),
    scrimHide: () => ipcRenderer.invoke('fan:browser:scrim:hide'),
    onScrimDismissed: callback => {
      const listener = () => callback()
      ipcRenderer.on('fan:scrim:dismissed', listener)
      return () => ipcRenderer.removeListener('fan:scrim:dismissed', listener)
    },
    // A click on a live overview tile (caught by its transparent catcher view)
    // → open that session; a wheel over it → scroll the overview. See
    // overview-tile-preload.cjs / setOverviewLiveTiles.
    onOverviewOpen: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:overview:open', listener)
      return () => ipcRenderer.removeListener('fan:overview:open', listener)
    },
    onOverviewWheel: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:overview:wheel', listener)
      return () => ipcRenderer.removeListener('fan:overview:wheel', listener)
    },
    // Runtime events (navigation / agent-action / captcha / dialog / crash)
    // forwarded from the Electron-native browser runtime so the renderer can
    // drive co-browsing UX (live chrome, "agent operating" badge, captcha banner).
    onEvent: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('fan:browser:event', listener)
      return () => ipcRenderer.removeListener('fan:browser:event', listener)
    }
  }
})
