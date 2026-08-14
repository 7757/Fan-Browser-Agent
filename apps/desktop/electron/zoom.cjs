/**
 * Shared window zoom conversion helpers.
 *
 * Chromium stores a logarithmic zoom level while the UI should display a
 * straightforward percentage. Keeping menu shortcuts and Settings on this
 * one scale prevents them from drifting apart.
 */

const ZOOM_STORAGE_KEY = 'fan:desktop:zoomLevel'
const ZOOM_FACTOR_BASE = 1.2
const MIN_ZOOM_PERCENT = 75
const MAX_ZOOM_PERCENT = 150
const MIN_ZOOM_LEVEL = Math.log(MIN_ZOOM_PERCENT / 100) / Math.log(ZOOM_FACTOR_BASE)
const MAX_ZOOM_LEVEL = Math.log(MAX_ZOOM_PERCENT / 100) / Math.log(ZOOM_FACTOR_BASE)

function clampZoomLevel(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, MIN_ZOOM_LEVEL), MAX_ZOOM_LEVEL)
}

function zoomLevelToPercent(level) {
  return Math.round(Math.pow(ZOOM_FACTOR_BASE, clampZoomLevel(level)) * 100)
}

function percentToZoomLevel(percent) {
  if (!Number.isFinite(percent)) return 0
  const next = Math.min(Math.max(percent, MIN_ZOOM_PERCENT), MAX_ZOOM_PERCENT)
  return Math.log(next / 100) / Math.log(ZOOM_FACTOR_BASE)
}

function applyZoomLevel(webContents, level) {
  const next = clampZoomLevel(level)
  webContents.setZoomLevel(next)
  webContents.send('fan:zoom:changed', {
    level: next,
    percent: zoomLevelToPercent(next)
  })
  return next
}

module.exports = {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  ZOOM_STORAGE_KEY,
  applyZoomLevel,
  clampZoomLevel,
  percentToZoomLevel,
  zoomLevelToPercent
}
