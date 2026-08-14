'use strict'

/* global CSS, Element, document, requestAnimationFrame, window */

const { ipcRenderer } = require('electron')

const ICONS = Object.freeze({
  alert:
    '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/></svg>',
  check:
    '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/></svg>',
  folder:
    '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5Z"/></svg>',
  package:
    '<svg aria-hidden="true" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4.5 7.8 7.5 4.1 7.5-4.1M12 12v9"/></svg>'
})

let currentDownloads = []
let latestPayload = null
let ready = false
const pendingActions = new Map()

function bytesLabel(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function downloadProgress(download) {
  if (download.totalBytes <= 0) return null
  return Math.min(100, Math.max(0, Math.round((download.receivedBytes / download.totalBytes) * 100)))
}

function downloadStatus(download) {
  const progress = downloadProgress(download)
  if (download.state === 'completed') return `已下载 · ${bytesLabel(download.receivedBytes)}`
  if (download.state === 'paused') return `已暂停 · ${bytesLabel(download.receivedBytes)}`
  if (download.state === 'cancelled') return '已取消'
  if (download.state === 'failed') return '下载失败'
  if (download.state === 'interrupted') return '下载已中断'
  if (progress != null) {
    return `${progress}% · ${bytesLabel(download.receivedBytes)} / ${bytesLabel(download.totalBytes)}`
  }
  return `正在下载 · ${bytesLabel(download.receivedBytes)}`
}

function stateMarkup(download) {
  if (download.state === 'completed') return ICONS.check
  if (download.state === 'failed' || download.state === 'interrupted') return ICONS.alert
  if (!download.done && (download.state === 'progressing' || download.state === 'started')) {
    return '<span aria-hidden="true" class="spinner"></span>'
  }
  return ICONS.package
}

function actionButton(action, download, label, contents, text = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `action${text ? ' action-text' : ''}`
  button.dataset.action = action
  button.dataset.eventId = download.eventId
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = contents
  button.disabled = pendingActions.has(download.eventId)
  return button
}

function createDownloadRow(download) {
  const row = document.createElement('div')
  row.className = 'row'
  row.dataset.eventId = download.eventId

  const state = document.createElement('span')
  state.className = 'state'
  state.dataset.state = download.state
  state.innerHTML = stateMarkup(download)

  const details = document.createElement('div')
  details.className = 'details'

  const filename = document.createElement('div')
  filename.className = 'filename'
  filename.textContent = download.filename
  filename.title = download.filename
  details.append(filename)

  const status = document.createElement('div')
  status.className = 'status'
  status.textContent = downloadStatus(download)
  details.append(status)

  const progress = downloadProgress(download)
  if (!download.done && progress != null) {
    const track = document.createElement('div')
    track.className = 'progress'
    track.setAttribute('aria-label', `下载进度 ${progress}%`)
    track.setAttribute('aria-valuemax', '100')
    track.setAttribute('aria-valuemin', '0')
    track.setAttribute('aria-valuenow', String(progress))
    track.setAttribute('role', 'progressbar')
    const value = document.createElement('div')
    value.className = 'progress-value'
    value.style.width = `${progress}%`
    track.append(value)
    details.append(track)
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (download.canOpen) {
    const loading = pendingActions.get(download.eventId) === 'open'
    actions.append(
      actionButton(
        'open',
        download,
        `打开 ${download.filename}`,
        loading ? '<span aria-hidden="true" class="spinner"></span>' : '打开',
        true
      )
    )
  }
  if (download.canReveal) {
    const loading = pendingActions.get(download.eventId) === 'reveal'
    actions.append(
      actionButton(
        'reveal',
        download,
        `在文件夹中显示 ${download.filename}`,
        loading ? '<span aria-hidden="true" class="spinner"></span>' : ICONS.folder
      )
    )
  }

  row.append(state, details, actions)
  return row
}

function applyTheme(theme) {
  for (const [key, value] of Object.entries(theme || {})) {
    document.documentElement.style.setProperty(`--popover-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value)
  }
}

function render(payload) {
  if (!ready) {
    latestPayload = payload
    return
  }

  currentDownloads = Array.isArray(payload?.downloads) ? payload.downloads : []
  applyTheme(payload?.theme)
  document.getElementById('title').textContent =
    currentDownloads.length > 1 ? `最近下载 (${currentDownloads.length})` : '最近下载'
  const list = document.getElementById('downloads')
  list.replaceChildren(...currentDownloads.map(createDownloadRow))

  const requestId = String(payload?.requestId || '')
  requestAnimationFrame(() => {
    ipcRenderer.send('fan:download-popover:rendered', { requestId })
  })
}

function runAction(action, eventId) {
  if (!eventId || pendingActions.has(eventId)) return
  pendingActions.set(eventId, action)
  render({ ...latestPayload, downloads: currentDownloads, requestId: '' })
  ipcRenderer.send('fan:download-popover:action', {
    action,
    eventId,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  })
}

ipcRenderer.on('fan:download-popover:update', (_event, payload) => {
  latestPayload = payload
  render(payload)
})

ipcRenderer.on('fan:download-popover:actionResult', (_event, payload) => {
  const eventId = String(payload?.eventId || '')
  if (eventId) pendingActions.delete(eventId)
  render({ ...latestPayload, downloads: currentDownloads, requestId: '' })

  if (payload?.ok === false) {
    const row = document.querySelector(`.row[data-event-id="${CSS.escape(eventId)}"]`)
    if (!row) return
    const error = document.createElement('div')
    error.className = 'error'
    error.setAttribute('role', 'status')
    error.textContent = payload.action === 'open' ? '无法打开文件' : '无法定位文件'
    row.append(error)
    window.setTimeout(() => error.remove(), 2400)
  }
})

window.addEventListener('DOMContentLoaded', () => {
  ready = true
  document.getElementById('dismiss').addEventListener('click', () => {
    ipcRenderer.send('fan:download-popover:action', { action: 'dismiss' })
  })
  document.getElementById('downloads').addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null
    if (!button) return
    runAction(button.dataset.action, button.dataset.eventId)
  })
  document.body.addEventListener('click', event => {
    if (event.target === document.body) {
      ipcRenderer.send('fan:download-popover:action', { action: 'escape' })
    }
  })
  if (latestPayload) render(latestPayload)
})

window.addEventListener(
  'keydown',
  event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      ipcRenderer.send('fan:download-popover:action', { action: 'escape' })
    }
  },
  true
)

window.addEventListener('contextmenu', event => event.preventDefault(), true)
