'use strict'

const DOWNLOAD_POPOVER_MAX_DOWNLOADS = 20
const DOWNLOAD_POPOVER_MAX_VISIBLE_ROWS = 4
const DOWNLOAD_POPOVER_OUTER_MARGIN = 8
const DOWNLOAD_POPOVER_HEADER_HEIGHT = 40
const DOWNLOAD_POPOVER_ROW_HEIGHT = 58
const DOWNLOAD_POPOVER_VIEW_WIDTH = 352
const DOWNLOAD_POPOVER_ANCHOR_GAP = 4

const DOWNLOAD_STATES = new Set([
  'cancelled',
  'completed',
  'failed',
  'interrupted',
  'paused',
  'progressing',
  'started'
])

const DOWNLOAD_POPOVER_DEFAULT_THEME = Object.freeze({
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
})

function boundedText(value, maxLength = 256) {
  return String(value == null ? '' : value)
    .replace(/\0/g, '')
    .slice(0, maxLength)
}

function nonNegativeNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

function normalizeCssColor(value, fallback) {
  const candidate = boundedText(value, 128).trim()
  if (!candidate || /[;{}]/.test(candidate)) return fallback
  return candidate
}

function normalizeDownloadPopoverTheme(theme = {}) {
  return Object.fromEntries(
    Object.entries(DOWNLOAD_POPOVER_DEFAULT_THEME).map(([key, fallback]) => [
      key,
      normalizeCssColor(theme?.[key], fallback)
    ])
  )
}

function normalizeDownloadPopoverDownloads(downloads) {
  if (!Array.isArray(downloads)) return []

  return downloads
    .slice(0, DOWNLOAD_POPOVER_MAX_DOWNLOADS)
    .map(download => {
      const eventId = boundedText(download?.eventId, 256)
      if (!eventId) return null

      const state = boundedText(download?.state, 32)
      return {
        canOpen: download?.canOpen === true,
        canReveal: download?.canReveal === true,
        done: download?.done === true,
        eventId,
        filename: boundedText(download?.filename || 'download', 512) || 'download',
        receivedBytes: nonNegativeNumber(download?.receivedBytes),
        state: DOWNLOAD_STATES.has(state) ? state : 'started',
        totalBytes: nonNegativeNumber(download?.totalBytes)
      }
    })
    .filter(Boolean)
}

function finiteCoordinate(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function positiveInteger(value) {
  const numeric = Math.round(Number(value))
  return Number.isFinite(numeric) ? Math.max(1, numeric) : 1
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum)
}

function downloadPopoverViewBounds(anchor = {}, contentSize = {}, downloadCount = 1) {
  const contentWidth = positiveInteger(contentSize.width)
  const contentHeight = positiveInteger(contentSize.height)
  const width = Math.min(DOWNLOAD_POPOVER_VIEW_WIDTH, contentWidth)
  const visibleRows = clamp(
    Math.max(1, Math.trunc(Number(downloadCount) || 1)),
    1,
    DOWNLOAD_POPOVER_MAX_VISIBLE_ROWS
  )
  const desiredHeight =
    DOWNLOAD_POPOVER_OUTER_MARGIN * 2 +
    DOWNLOAD_POPOVER_HEADER_HEIGHT +
    visibleRows * DOWNLOAD_POPOVER_ROW_HEIGHT
  const height = Math.min(desiredHeight, contentHeight)
  const anchorRight = finiteCoordinate(anchor.x) + Math.max(0, finiteCoordinate(anchor.width))
  const anchorBottom = finiteCoordinate(anchor.y) + Math.max(0, finiteCoordinate(anchor.height))
  const desiredX = anchorRight - (width - DOWNLOAD_POPOVER_OUTER_MARGIN)
  const desiredY = anchorBottom + DOWNLOAD_POPOVER_ANCHOR_GAP - DOWNLOAD_POPOVER_OUTER_MARGIN

  return {
    height,
    width,
    x: Math.round(clamp(desiredX, 0, Math.max(0, contentWidth - width))),
    y: Math.round(clamp(desiredY, 0, Math.max(0, contentHeight - height)))
  }
}

module.exports = {
  DOWNLOAD_POPOVER_DEFAULT_THEME,
  DOWNLOAD_POPOVER_MAX_DOWNLOADS,
  DOWNLOAD_POPOVER_MAX_VISIBLE_ROWS,
  downloadPopoverViewBounds,
  normalizeDownloadPopoverDownloads,
  normalizeDownloadPopoverTheme
}
