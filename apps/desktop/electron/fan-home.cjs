'use strict'

const path = require('node:path')

function resolveDesktopFanHome({
  directoryExists,
  env = process.env,
  homeDir,
  isPackaged,
  isWindows,
  readWindowsUserEnvVar,
  userDataOverride
}) {
  if (env.FAN_HOME) return path.resolve(env.FAN_HOME)
  if (userDataOverride) return path.join(path.resolve(userDataOverride), 'fan-home')

  // Keep source/dev launches completely isolated from installed releases.
  // The Electron main process forwards this path to the Python backend via
  // FAN_HOME, so config, sessions, skills, logs, and caches all follow it.
  if (!isPackaged) return path.join(homeDir, '.dev_fan')

  if (isWindows) {
    // Explorer-launched apps can inherit a stale environment block. Read the
    // current user-scoped value before falling back to LOCALAPPDATA.
    const fromRegistry = readWindowsUserEnvVar('FAN_HOME')
    if (fromRegistry) return path.resolve(fromRegistry)
  }

  if (isWindows && env.LOCALAPPDATA) {
    const localappdata = path.join(env.LOCALAPPDATA, 'fan')
    const legacy = path.join(homeDir, '.fan')
    if (!directoryExists(localappdata) && directoryExists(legacy)) return legacy
    return localappdata
  }

  return path.join(homeDir, '.fan')
}

function resolveDevelopmentUserData({ fanHome, isPackaged, userDataOverride }) {
  if (isPackaged || userDataOverride) return null
  return path.join(fanHome, 'electron-user-data')
}

module.exports = { resolveDesktopFanHome, resolveDevelopmentUserData }
