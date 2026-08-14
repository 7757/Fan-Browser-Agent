'use strict'

// Only device capture and precise location require an explicit user decision.
// Electron has used several names for microphone/camera permissions across
// versions and platforms, so keep every known alias in the same policy.
const USER_GATED_BROWSER_PERMISSIONS = new Set([
  'audio-capture',
  'audiocapture',
  'camera',
  'camera-pan-tilt-zoom',
  'camerapantiltzoom',
  'geolocation',
  'media',
  'microphone',
  'video-capture',
  'videocapture'
])

// Opening an external application is routed through its own security flow. It
// is not a browser permission prompt and must not be silently preauthorized.
const EXTERNAL_APPLICATION_PERMISSIONS = new Set([
  'open-external',
  'openexternal'
])

function normalizeBrowserPermission(permission) {
  return String(permission || '').trim().toLowerCase()
}

function browserPermissionRequiresUserDecision(permission) {
  return USER_GATED_BROWSER_PERMISSIONS.has(normalizeBrowserPermission(permission))
}

function browserPermissionRequiresExternalConfirmation(permission) {
  return EXTERNAL_APPLICATION_PERMISSIONS.has(normalizeBrowserPermission(permission))
}

function browserPermissionRequiresHostDecision(permission) {
  const normalized = normalizeBrowserPermission(permission)
  return browserPermissionRequiresUserDecision(normalized) ||
    browserPermissionRequiresExternalConfirmation(normalized)
}

function browserPermissionAllowedByDefault(permission) {
  const normalized = normalizeBrowserPermission(permission)
  return Boolean(normalized) && !browserPermissionRequiresHostDecision(normalized)
}

module.exports = {
  browserPermissionAllowedByDefault,
  browserPermissionRequiresExternalConfirmation,
  browserPermissionRequiresHostDecision,
  browserPermissionRequiresUserDecision,
  normalizeBrowserPermission
}
