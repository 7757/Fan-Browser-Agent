const fs = require('node:fs/promises')

const { EVENT_TYPES } = require('../events/event-types.cjs')

async function storageState(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  await runtime._prepare(entry)
  runtime._assertEntryDecisionToken(entry, params, 'storageState')
  const cookieFilter = params.filter && typeof params.filter === 'object' ? params.filter : {}
  const cookies = await entry.webContents.session.cookies.get(cookieFilter)
  const origins = await runtime._storageOriginsFromDomStorage(entry).catch(error => {
    runtime.eventBus.emit(EVENT_TYPES.STORAGE_STATE_CAPTURED, {
      id: entry.id,
      storageOriginError: error.message
    })
    return []
  })
  const capturedOrigins = origins.length ? origins : [await runtime._currentOriginStorage(entry)]
  const normalizedOrigins = capturedOrigins.filter(
    origin => origin && (origin.localStorage?.length || origin.sessionStorage?.length || origin.error)
  )
  if (!normalizedOrigins.length && capturedOrigins[0]) normalizedOrigins.push(capturedOrigins[0])
  const output = {
    url: entry.webContents.getURL(),
    cookies,
    origins: normalizedOrigins
  }
  runtime.eventBus.emit(EVENT_TYPES.STORAGE_STATE_CAPTURED, {
    id: entry.id,
    cookiesCount: cookies.length,
    originsCount: output.origins.length
  })
  return output
}

async function currentOriginStorage(entry) {
  const originResult = await entry.client.send('Runtime.evaluate', {
    expression: `(() => {
      function entriesFor(storage) {
        const items = [];
        for (let i = 0; i < storage.length; i += 1) {
          const name = storage.key(i);
          items.push({ name, value: storage.getItem(name) });
        }
        return items;
      }
      try {
        return {
          origin: location.origin === 'null' ? location.href : location.origin,
          localStorage: entriesFor(window.localStorage),
          sessionStorage: entriesFor(window.sessionStorage)
        };
      } catch {
        return { origin: location.href, localStorage: [], sessionStorage: [], error: String(error && error.message || error) };
      }
    })()`,
    returnByValue: true
  })
  return originResult?.result?.value || {
    origin: '',
    localStorage: [],
    sessionStorage: []
  }
}

function extractFrameOrigins(runtime, frameTree, origins = new Set()) {
  const frame = frameTree?.frame || {}
  const origin = String(frame.securityOrigin || '').trim()
  if (origin && origin !== 'null') origins.add(origin)
  for (const child of frameTree?.childFrames || []) runtime._extractFrameOrigins(child, origins)
  return origins
}

async function domStorageEntries(entry, origin, isLocalStorage) {
  const result = await entry.client.send('DOMStorage.getDOMStorageItems', {
    storageId: {
      securityOrigin: origin,
      isLocalStorage: Boolean(isLocalStorage)
    }
  })
  const entries = Array.isArray(result?.entries) ? result.entries : []
  return entries
    .filter(item => Array.isArray(item) && item.length >= 2)
    .map(([name, value]) => ({ name: String(name), value: String(value ?? '') }))
}

async function storageOriginsFromDomStorage(runtime, entry) {
  await entry.client.send('DOMStorage.enable').catch(() => undefined)
  try {
    const frameTreeResult = await entry.client.send('Page.getFrameTree')
    const origins = Array.from(runtime._extractFrameOrigins(frameTreeResult?.frameTree || {}))
    const output = []
    for (const origin of origins) {
      const originData = { origin }
      const localStorage = await runtime._domStorageEntries(entry, origin, true).catch(() => [])
      const sessionStorage = await runtime._domStorageEntries(entry, origin, false).catch(() => [])
      if (localStorage.length) originData.localStorage = localStorage
      if (sessionStorage.length) originData.sessionStorage = sessionStorage
      if (originData.localStorage || originData.sessionStorage) output.push(originData)
    }
    return output
  } finally {
    await entry.client.send('DOMStorage.disable').catch(() => undefined)
  }
}

async function saveStorageState(runtime, id, params = {}) {
  const filePath = String(params.path || '').trim()
  if (!filePath) throw new Error('path is required')
  const state = await runtime.storageState(id, params)
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  runtime.eventBus.emit(EVENT_TYPES.STORAGE_STATE_SAVED, {
    id: String(id || 'main'),
    path: filePath,
    cookiesCount: state.cookies.length,
    originsCount: state.origins.length
  })
  return { path: filePath, cookiesCount: state.cookies.length, originsCount: state.origins.length }
}

async function loadStorageState(runtime, id, params = {}) {
  const entry = runtime.getWorkbench(id)
  await runtime._prepare(entry)
  runtime._assertEntryDecisionToken(entry, params, 'loadStorageState')
  let state = params.state || params.storageState || null
  const filePath = String(params.path || '').trim()
  if (!state) {
    if (!filePath) throw new Error('path or state is required')
    state = JSON.parse(await fs.readFile(filePath, 'utf8'))
  }
  const result = await runtime._applyStorageState(entry, state)
  runtime.eventBus.emit(EVENT_TYPES.STORAGE_STATE_LOADED, {
    id: entry.id,
    path: filePath || null,
    ...result
  })
  return { path: filePath || null, ...result }
}

async function applyStorageState(runtime, entry, state = {}) {
  const cookies = Array.isArray(state.cookies) ? state.cookies : []
  let cookiesApplied = 0
  for (const cookie of cookies) {
    const details = runtime._cookieDetailsForElectron(entry, cookie)
    if (!details) continue
    await entry.webContents.session.cookies.set(details)
    cookiesApplied += 1
  }

  const origins = Array.isArray(state.origins) ? state.origins : []
  const initScript = origins.length ? await runtime._installStorageInitScript(entry, origins) : null
  const storage = origins.length ? await runtime._applyCurrentOriginStorage(entry, origins) : {}
  const result = {
    cookiesCount: cookiesApplied,
    originsCount: origins.length,
    currentOriginApplied: Number(storage.originsApplied || 0),
    initScriptsCount: initScript ? 1 : 0,
    localStorageCount: Number(storage.localStorageCount || 0),
    sessionStorageCount: Number(storage.sessionStorageCount || 0)
  }
  runtime.eventBus.emit(EVENT_TYPES.STORAGE_STATE_APPLIED, {
    id: entry.id,
    ...result
  })
  return result
}

function storageApplyScript(origins) {
  return `(() => {
    const origins = ${JSON.stringify(origins)};
    const currentOrigin = location.origin === 'null' ? location.href : location.origin;
    const originState = origins.find(item => item && (item.origin === currentOrigin || item.origin === location.href));
    if (!originState) return { originsApplied: 0, localStorageCount: 0, sessionStorageCount: 0 };
    function apply(storage, items) {
      let count = 0;
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || item.name == null) continue;
        storage.setItem(String(item.name), String(item.value ?? ''));
        count += 1;
      }
      return count;
    }
    return {
      originsApplied: 1,
      localStorageCount: apply(window.localStorage, originState.localStorage),
      sessionStorageCount: apply(window.sessionStorage, originState.sessionStorage)
    };
  })()`
}

async function applyCurrentOriginStorage(runtime, entry, origins) {
  const storageResult = await entry.client.send('Runtime.evaluate', {
    expression: runtime._storageApplyScript(origins),
    returnByValue: true
  })
  return storageResult?.result?.value || {}
}

async function installStorageInitScript(entry, origins) {
  const expression = `(() => {
    const origins = ${JSON.stringify(origins)};
    function apply(storage, items) {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || item.name == null) continue;
        storage.setItem(String(item.name), String(item.value ?? ''));
      }
    }
    try {
      const currentOrigin = location.origin === 'null' ? location.href : location.origin;
      const originState = origins.find(item => item && (item.origin === currentOrigin || item.origin === location.href));
      if (!originState) return;
      apply(window.localStorage, originState.localStorage);
      apply(window.sessionStorage, originState.sessionStorage);
    } catch {}
  })();`
  const result = await entry.client.send('Page.addScriptToEvaluateOnNewDocument', { source: expression }).catch(error => ({
    error: error.message
  }))
  return result?.identifier || result
}

function cookieDetailsForElectron(entry, cookie = {}) {
  if (!cookie || cookie.name == null) return null
  const currentUrl = entry.webContents.getURL() || 'https://localhost/'
  let url = cookie.url
  if (!url) {
    const domain = String(cookie.domain || '').replace(/^\./, '')
    const cookiePath = cookie.path || '/'
    if (domain) {
      url = `${cookie.secure === false ? 'http' : 'https'}://${domain}${String(cookiePath).startsWith('/') ? cookiePath : `/${cookiePath}`}`
    } else {
      url = currentUrl
    }
  }
  const details = {
    url: String(url),
    name: String(cookie.name),
    value: String(cookie.value ?? ''),
    path: cookie.path || '/'
  }
  if (cookie.domain) details.domain = String(cookie.domain)
  if (cookie.secure != null) details.secure = Boolean(cookie.secure)
  if (cookie.httpOnly != null) details.httpOnly = Boolean(cookie.httpOnly)
  const expires = Number(cookie.expirationDate ?? cookie.expires)
  if (Number.isFinite(expires) && expires > 0) details.expirationDate = expires
  const sameSite = String(cookie.sameSite || '').toLowerCase()
  if (sameSite === 'strict') details.sameSite = 'strict'
  else if (sameSite === 'lax') details.sameSite = 'lax'
  else if (sameSite === 'none' || sameSite === 'no_restriction') details.sameSite = 'no_restriction'
  return details
}

module.exports = {
  applyCurrentOriginStorage,
  applyStorageState,
  cookieDetailsForElectron,
  currentOriginStorage,
  domStorageEntries,
  extractFrameOrigins,
  installStorageInitScript,
  loadStorageState,
  saveStorageState,
  storageApplyScript,
  storageOriginsFromDomStorage,
  storageState
}
