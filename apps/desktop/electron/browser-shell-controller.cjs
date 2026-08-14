'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

const SHELL_EVENTS = Object.freeze({
  DOWNLOAD_CHANGED: 'shell.download.changed',
  HEALTH_CHANGED: 'shell.health.changed',
  NOTICE_RAISED: 'shell.notice.raised',
  PROMPT_CHANGED: 'shell.prompt.changed'
})

const DOWNLOAD_STATES = new Set(['cancelled', 'completed', 'failed', 'interrupted', 'paused', 'progressing', 'started'])
const HEALTH_STATES = new Set(['crashed', 'degraded', 'ok', 'unresponsive'])
const NOTICE_LEVELS = new Set(['error', 'info', 'warning'])

function boundedText(value, maxLength = 256) {
  return String(value == null ? '' : value)
    .replace(/\0/g, '')
    .slice(0, maxLength)
}

function privateText(value) {
  return String(value == null ? '' : value).replace(/\0/g, '')
}

function nonNegativeNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

function normalizeDocumentRevision(value) {
  if (value == null || value === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : boundedText(value, 128)
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return []
  return [...new Set(actions.map(value => boundedText(value, 64)).filter(Boolean))].slice(0, 8)
}

function normalizeScope(input = {}) {
  return {
    documentRevision: normalizeDocumentRevision(input.documentRevision),
    tabId: boundedText(input.tabId, 256),
    workbenchId: boundedText(input.workbenchId, 256)
  }
}

function scopeMatches(record, scope, level) {
  if (record.workbenchId !== scope.workbenchId) return false
  if (level === 'workbench') return true
  if (record.tabId !== scope.tabId) return false
  if (level === 'tab') return true
  return record.documentRevision === scope.documentRevision
}

function safeFilename(filename, savePath = '') {
  const raw = boundedText(filename || (savePath ? path.basename(savePath) : 'download'), 512)
  return path.basename(raw) || 'download'
}

class BrowserShellController {
  constructor({
    createId,
    emit,
    idFactory,
    log,
    maxDownloadsPerWorkbench = 20,
    now,
    openExternal,
    openPath,
    revealPath
  } = {}) {
    this._emit = typeof emit === 'function' ? emit : () => undefined
    this._log = typeof log === 'function' ? log : () => undefined
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._idFactory =
      typeof idFactory === 'function'
        ? idFactory
        : typeof createId === 'function'
          ? createId
          : kind => `${kind}-${crypto.randomUUID()}`
    this._openExternal = typeof openExternal === 'function' ? openExternal : null
    this._openPath = typeof openPath === 'function' ? openPath : null
    this._revealPath = typeof revealPath === 'function' ? revealPath : null
    this._maxDownloadsPerWorkbench = Math.max(1, Math.trunc(Number(maxDownloadsPerWorkbench) || 20))

    this._downloads = new Map()
    this._downloadKeys = new Map()
    this._downloadOrder = new Map()
    this._health = new Map()
    this._notices = new Map()
    this._permissionGrants = new Map()
    this._promptKeys = new Map()
    this._prompts = new Map()
    this._revision = 0
  }

  _newId(kind) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = boundedText(this._idFactory(kind), 256)
      if (
        candidate &&
        !this._prompts.has(candidate) &&
        !this._downloads.has(candidate) &&
        ![...this._health.values()].some(item => item.eventId === candidate) &&
        ![...this._notices.values()].some(item => item.eventId === candidate)
      ) {
        return candidate
      }
    }
    return `${boundedText(kind, 32) || 'event'}-${crypto.randomUUID()}`
  }

  _push(type, payload) {
    this._revision += 1
    const safePayload = { ...payload, revision: this._revision }
    try {
      this._emit(type, safePayload)
    } catch (error) {
      this._log(`browser shell emit failed (${type}): ${error?.message || error}`)
    }
    return safePayload
  }

  _promptDedupeKey(prompt) {
    return [
      prompt.workbenchId,
      prompt.tabId,
      prompt.documentRevision == null ? '' : prompt.documentRevision,
      prompt.kind,
      prompt.key
    ].join('\0')
  }

  _publicPrompt(prompt) {
    return {
      actions: [...prompt.actions],
      code: prompt.code,
      createdAt: prompt.createdAt,
      defaultValue: prompt.defaultValue,
      dialogType: prompt.dialogType,
      documentRevision: prompt.documentRevision,
      eventId: prompt.eventId,
      host: prompt.host,
      kind: prompt.kind,
      message: prompt.message,
      pending: true,
      permission: prompt.permission,
      scheme: prompt.scheme,
      tabId: prompt.tabId,
      workbenchId: prompt.workbenchId
    }
  }

  requestPrompt(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId || !scope.tabId) {
      return { ok: false, reason: 'invalid-scope' }
    }
    const kind = boundedText(input.kind || 'generic', 64)
    const key = boundedText(input.key || `${kind}:${input.code || input.permission || input.dialogType || ''}`, 512)
    const candidate = {
      actions: normalizeActions(input.actions),
      code: boundedText(input.code, 128),
      createdAt: this._now(),
      defaultValue: boundedText(input.defaultValue, 2048),
      dialogType: boundedText(input.dialogType, 64),
      eventId: '',
      host: boundedText(input.host, 512),
      key,
      kind,
      message: boundedText(input.message, 4096),
      onCancel: typeof input.onCancel === 'function' ? input.onCancel : null,
      onRespond: typeof input.onRespond === 'function' ? input.onRespond : null,
      permission: boundedText(input.permission, 128).toLowerCase(),
      privateData: input.privateData,
      scheme: boundedText(input.scheme, 64).toLowerCase(),
      ...scope
    }
    const dedupeKey = this._promptDedupeKey(candidate)
    const existingId = this._promptKeys.get(dedupeKey)
    const existing = existingId ? this._prompts.get(existingId) : null
    if (existing) {
      return { created: false, eventId: existing.eventId, ok: true, prompt: this._publicPrompt(existing) }
    }
    if (existingId) this._promptKeys.delete(dedupeKey)

    candidate.eventId = this._newId('prompt')
    candidate.dedupeKey = dedupeKey
    this._prompts.set(candidate.eventId, candidate)
    this._promptKeys.set(dedupeKey, candidate.eventId)
    const prompt = this._publicPrompt(candidate)
    this._push(SHELL_EVENTS.PROMPT_CHANGED, prompt)
    return { created: true, eventId: candidate.eventId, ok: true, prompt }
  }

  requestExternalOpen(input = {}) {
    const rawUrl = privateText(input.url)
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, reason: 'invalid-url' }
    }
    return this.requestPrompt({
      ...input,
      actions: ['cancel', 'open'],
      code: input.code || 'external-application-requested',
      host: input.host || parsed.hostname,
      key: input.key || rawUrl,
      kind: 'external-application',
      privateData: { ...(input.privateData || {}), externalUrl: rawUrl },
      scheme: parsed.protocol.replace(/:$/, '')
    })
  }

  requestPermission(input = {}) {
    const permission = boundedText(input.permission, 128).toLowerCase()
    if (!permission || permission === '*') return { ok: false, reason: 'invalid-permission' }
    return this.requestPrompt({
      ...input,
      actions: ['deny', 'allow'],
      code: input.code || 'permission-requested',
      key: input.key || permission,
      kind: 'permission',
      permission
    })
  }

  _takePrompt(eventId) {
    const id = boundedText(eventId, 256)
    const prompt = this._prompts.get(id)
    if (!prompt) return null
    this._prompts.delete(id)
    if (this._promptKeys.get(prompt.dedupeKey) === id) this._promptKeys.delete(prompt.dedupeKey)
    return prompt
  }

  async respondShellPrompt(eventId, response = {}) {
    const prompt = this._takePrompt(eventId)
    if (!prompt) return { ok: false, reason: 'not-found' }

    const accepted = response.accepted === true
    const value = response.value == null ? undefined : boundedText(response.value, 32768)
    this._push(SHELL_EVENTS.PROMPT_CHANGED, {
      ...this._publicPrompt(prompt),
      accepted,
      pending: false,
      resolution: 'responded',
      resolvedAt: this._now()
    })

    let externalOpened = null
    const externalUrl = prompt.privateData?.externalUrl
    if (accepted && externalUrl) {
      if (!this._openExternal) {
        externalOpened = false
      } else {
        try {
          const result = await this._openExternal(externalUrl)
          externalOpened = result !== false && !(typeof result === 'string' && result)
        } catch (error) {
          externalOpened = false
          this._log(`browser shell external open failed: ${error?.message || error}`)
        }
      }
    }

    if (accepted && prompt.kind === 'permission' && prompt.permission) {
      this.grantPermission(prompt)
    }

    try {
      if (prompt.onRespond) {
        await prompt.onRespond({
          accepted,
          eventId: prompt.eventId,
          externalOpened,
          privateData: prompt.privateData,
          value
        })
      }
    } catch (error) {
      this._log(`browser shell prompt response failed (${prompt.kind}): ${error?.message || error}`)
      return { ok: false, reason: 'handler-failed' }
    }

    if (accepted && externalUrl && externalOpened !== true) {
      return { ok: false, reason: this._openExternal ? 'open-failed' : 'open-unavailable' }
    }
    return { ok: true }
  }

  async cancelShellPrompt(eventId, reason = 'cancelled') {
    const prompt = this._takePrompt(eventId)
    if (!prompt) return { ok: false, reason: 'not-found' }
    const safeReason = boundedText(reason, 128) || 'cancelled'
    this._push(SHELL_EVENTS.PROMPT_CHANGED, {
      ...this._publicPrompt(prompt),
      pending: false,
      resolution: 'cancelled',
      resolvedAt: this._now()
    })
    try {
      if (prompt.onCancel) {
        await prompt.onCancel({
          eventId: prompt.eventId,
          privateData: prompt.privateData,
          reason: safeReason
        })
      }
    } catch (error) {
      this._log(`browser shell prompt cancel failed (${prompt.kind}): ${error?.message || error}`)
      return { ok: false, reason: 'handler-failed' }
    }
    return { ok: true }
  }

  _permissionScopeKey(input) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId || !scope.tabId || scope.documentRevision == null) return ''
    return [scope.workbenchId, scope.tabId, scope.documentRevision].join('\0')
  }

  grantPermission(input = {}) {
    const scopeKey = this._permissionScopeKey(input)
    const permission = boundedText(input.permission, 128).toLowerCase()
    if (!scopeKey || !permission || permission === '*') return { ok: false, reason: 'invalid-permission' }
    let grants = this._permissionGrants.get(scopeKey)
    if (!grants) {
      grants = new Set()
      this._permissionGrants.set(scopeKey, grants)
    }
    grants.add(permission)
    return { ok: true }
  }

  hasPermission(input = {}) {
    const scopeKey = this._permissionScopeKey(input)
    const permission = boundedText(input.permission, 128).toLowerCase()
    return Boolean(scopeKey && permission && this._permissionGrants.get(scopeKey)?.has(permission))
  }

  revokePermission(input = {}) {
    const scopeKey = this._permissionScopeKey(input)
    const permission = boundedText(input.permission, 128).toLowerCase()
    const grants = scopeKey ? this._permissionGrants.get(scopeKey) : null
    if (!grants || !grants.delete(permission)) return false
    if (!grants.size) this._permissionGrants.delete(scopeKey)
    return true
  }

  _downloadLookup(eventId, workbenchId, sourceKey) {
    const id = boundedText(eventId, 256)
    if (id) return this._downloads.get(id) || null
    const key = boundedText(sourceKey, 1024)
    const workbench = boundedText(workbenchId, 256)
    const mapped = key && workbench ? this._downloadKeys.get(`${workbench}\0${key}`) : ''
    return mapped ? this._downloads.get(mapped) || null : null
  }

  _publicDownload(download) {
    return {
      canOpen: Boolean(download.savePath && download.state === 'completed'),
      canReveal: Boolean(download.savePath),
      documentRevision: download.documentRevision,
      done: download.phase === 'done',
      doneAt: download.doneAt,
      downloadId: download.eventId,
      eventId: download.eventId,
      filename: download.filename,
      phase: download.phase,
      receivedBytes: download.receivedBytes,
      startedAt: download.startedAt,
      state: download.state,
      tabId: download.tabId,
      totalBytes: download.totalBytes,
      updatedAt: download.updatedAt,
      workbenchId: download.workbenchId
    }
  }

  downloadStarted(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId || !scope.tabId) return { ok: false, reason: 'invalid-scope' }
    const sourceKey = boundedText(input.sourceKey, 1024)
    let download = this._downloadLookup(input.eventId, scope.workbenchId, sourceKey)
    const timestamp = this._now()
    if (!download) {
      const eventId = this._newId('download')
      download = {
        ...scope,
        doneAt: null,
        eventId,
        filename: safeFilename(input.filename, input.savePath),
        phase: 'started',
        receivedBytes: nonNegativeNumber(input.receivedBytes),
        savePath: privateText(input.savePath),
        sourceKey,
        startedAt: timestamp,
        state: 'started',
        totalBytes: nonNegativeNumber(input.totalBytes),
        updatedAt: timestamp,
        url: privateText(input.url)
      }
      this._downloads.set(eventId, download)
      if (sourceKey) this._downloadKeys.set(`${scope.workbenchId}\0${sourceKey}`, eventId)
      const order = this._downloadOrder.get(scope.workbenchId) || []
      order.unshift(eventId)
      this._downloadOrder.set(scope.workbenchId, order)
      this._trimDownloads(scope.workbenchId)
    } else {
      this._mergeDownload(download, input, 'started')
    }
    const publicDownload = this._publicDownload(download)
    this._push(SHELL_EVENTS.DOWNLOAD_CHANGED, publicDownload)
    return { download: publicDownload, eventId: download.eventId, ok: true }
  }

  downloadProgress(eventId, input = {}) {
    return this._updateDownload(eventId, input, false)
  }

  downloadDone(eventId, input = {}) {
    return this._updateDownload(eventId, input, true)
  }

  _mergeDownload(download, input, fallbackState) {
    if (input.filename) download.filename = safeFilename(input.filename, download.savePath)
    if (input.savePath) download.savePath = privateText(input.savePath)
    if (input.url) download.url = privateText(input.url)
    if (input.receivedBytes != null) download.receivedBytes = nonNegativeNumber(input.receivedBytes)
    if (input.totalBytes != null) download.totalBytes = nonNegativeNumber(input.totalBytes)
    const requestedState = boundedText(input.state || fallbackState, 64).toLowerCase()
    download.state = DOWNLOAD_STATES.has(requestedState) ? requestedState : fallbackState
    download.updatedAt = this._now()
  }

  _updateDownload(eventId, input, done) {
    const download = this._downloads.get(boundedText(eventId, 256))
    if (!download) return { ok: false, reason: 'not-found' }
    this._mergeDownload(download, input, done ? 'completed' : 'progressing')
    download.phase = done ? 'done' : 'progress'
    if (done) {
      download.doneAt = download.updatedAt
      if (!input.state) download.state = 'completed'
    }
    const publicDownload = this._publicDownload(download)
    this._push(SHELL_EVENTS.DOWNLOAD_CHANGED, publicDownload)
    return { download: publicDownload, eventId: download.eventId, ok: true }
  }

  _trimDownloads(workbenchId) {
    const order = this._downloadOrder.get(workbenchId) || []
    while (order.length > this._maxDownloadsPerWorkbench) {
      const removedId = order.pop()
      const removed = this._downloads.get(removedId)
      this._downloads.delete(removedId)
      if (removed?.sourceKey) {
        const key = `${removed.workbenchId}\0${removed.sourceKey}`
        if (this._downloadKeys.get(key) === removedId) this._downloadKeys.delete(key)
      }
    }
    if (!order.length) this._downloadOrder.delete(workbenchId)
  }

  async openDownload(eventId) {
    return this._actOnDownload(eventId, this._openPath, 'open')
  }

  async revealDownload(eventId) {
    return this._actOnDownload(eventId, this._revealPath, 'reveal')
  }

  async _actOnDownload(eventId, callback, action) {
    const download = this._downloads.get(boundedText(eventId, 256))
    if (!download) return { ok: false, reason: 'not-found' }
    if (!download.savePath) return { ok: false, reason: 'path-unavailable' }
    if (action === 'open' && download.state !== 'completed') return { ok: false, reason: 'not-complete' }
    if (!callback) return { ok: false, reason: `${action}-unavailable` }
    try {
      const result = await callback(download.savePath)
      if (result === false || (typeof result === 'string' && result)) {
        this._log(`browser shell download ${action} failed (${download.eventId})`)
        return { ok: false, reason: `${action}-failed` }
      }
      return { ok: true }
    } catch (error) {
      this._log(`browser shell download ${action} failed (${download.eventId}): ${error?.message || error}`)
      return { ok: false, reason: `${action}-failed` }
    }
  }

  setHealth(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId) return { ok: false, reason: 'invalid-scope' }
    const requested = boundedText(input.status || 'ok', 64).toLowerCase()
    const status = HEALTH_STATES.has(requested) ? requested : 'degraded'
    const health = {
      ...scope,
      active: true,
      code: boundedText(input.code, 128),
      eventId: this._newId('health'),
      status,
      updatedAt: this._now()
    }
    this._health.set(scope.workbenchId, health)
    const payload = this._push(SHELL_EVENTS.HEALTH_CHANGED, { ...health })
    return { health: payload, ok: true }
  }

  raiseNotice(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId) return { ok: false, reason: 'invalid-scope' }
    const requested = boundedText(input.level || 'info', 32).toLowerCase()
    const notice = {
      ...scope,
      actions: normalizeActions(input.actions),
      active: true,
      code: boundedText(input.code, 128),
      eventId: this._newId('notice'),
      level: NOTICE_LEVELS.has(requested) ? requested : 'info',
      raisedAt: this._now()
    }
    this._notices.set(scope.workbenchId, notice)
    const payload = this._push(SHELL_EVENTS.NOTICE_RAISED, { ...notice, actions: [...notice.actions] })
    return { notice: payload, ok: true }
  }

  clearNotice(workbenchId, eventId = '') {
    const key = boundedText(workbenchId, 256)
    const notice = this._notices.get(key)
    if (!notice || (eventId && notice.eventId !== boundedText(eventId, 256))) {
      return { ok: false, reason: 'not-found' }
    }
    this._notices.delete(key)
    this._push(SHELL_EVENTS.NOTICE_RAISED, {
      ...notice,
      actions: [],
      active: false,
      clearedAt: this._now()
    })
    return { ok: true }
  }

  shellState(workbenchId = '') {
    const filter = boundedText(workbenchId, 256)
    const include = item => !filter || item.workbenchId === filter
    const prompts = [...this._prompts.values()].filter(include).map(prompt => this._publicPrompt(prompt))
    const downloads = []
    const workbenches = filter ? [filter] : [...this._downloadOrder.keys()]
    for (const key of workbenches) {
      for (const eventId of this._downloadOrder.get(key) || []) {
        const download = this._downloads.get(eventId)
        if (download) downloads.push(this._publicDownload(download))
      }
    }
    return {
      downloads,
      health: [...this._health.values()].filter(include).map(item => ({ ...item })),
      notices: [...this._notices.values()].filter(include).map(item => ({ ...item, actions: [...item.actions] })),
      prompts,
      revision: this._revision
    }
  }

  async _clearPrompts(scope, level, reason) {
    const ids = [...this._prompts.values()]
      .filter(prompt => scopeMatches(prompt, scope, level))
      .map(prompt => prompt.eventId)
    await Promise.all(ids.map(eventId => this.cancelShellPrompt(eventId, reason)))
    return ids.length
  }

  _clearPermissionGrants(scope, level) {
    let cleared = 0
    for (const key of [...this._permissionGrants.keys()]) {
      const [workbenchId, tabId, rawRevision] = key.split('\0')
      const record = {
        documentRevision: normalizeDocumentRevision(rawRevision),
        tabId,
        workbenchId
      }
      if (!scopeMatches(record, scope, level)) continue
      this._permissionGrants.delete(key)
      cleared += 1
    }
    return cleared
  }

  _clearStatus(scope, level) {
    for (const [workbenchId, health] of [...this._health.entries()]) {
      if (!scopeMatches(health, scope, level)) continue
      this._health.delete(workbenchId)
      this._push(SHELL_EVENTS.HEALTH_CHANGED, {
        ...health,
        active: false,
        clearedAt: this._now()
      })
    }
    for (const [workbenchId, notice] of [...this._notices.entries()]) {
      if (scopeMatches(notice, scope, level)) {
        this.clearNotice(workbenchId, notice.eventId)
      }
    }
  }

  async clearDocument(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId || !scope.tabId || scope.documentRevision == null) {
      return { ok: false, reason: 'invalid-scope' }
    }
    const prompts = await this._clearPrompts(scope, 'document', input.reason || 'document-changed')
    const permissions = this._clearPermissionGrants(scope, 'document')
    this._clearStatus(scope, 'document')
    return { ok: true, permissions, prompts }
  }

  async clearTab(input = {}) {
    const scope = normalizeScope(input)
    if (!scope.workbenchId || !scope.tabId) return { ok: false, reason: 'invalid-scope' }
    const prompts = await this._clearPrompts(scope, 'tab', input.reason || 'tab-closed')
    const permissions = this._clearPermissionGrants(scope, 'tab')
    this._clearStatus(scope, 'tab')
    return { ok: true, permissions, prompts }
  }

  async clearWorkbench(input = {}) {
    const scope = normalizeScope(typeof input === 'string' ? { workbenchId: input } : input)
    if (!scope.workbenchId) return { ok: false, reason: 'invalid-scope' }
    const prompts = await this._clearPrompts(scope, 'workbench', input.reason || 'workbench-closed')
    const permissions = this._clearPermissionGrants(scope, 'workbench')
    this._clearStatus(scope, 'workbench')
    for (const eventId of this._downloadOrder.get(scope.workbenchId) || []) {
      const download = this._downloads.get(eventId)
      this._downloads.delete(eventId)
      if (download?.sourceKey) this._downloadKeys.delete(`${scope.workbenchId}\0${download.sourceKey}`)
    }
    this._downloadOrder.delete(scope.workbenchId)
    return { ok: true, permissions, prompts }
  }
}

module.exports = {
  BrowserShellController,
  SHELL_EVENTS
}
