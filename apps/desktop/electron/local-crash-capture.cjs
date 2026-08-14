const fs = require('node:fs')
const path = require('node:path')

function startLocalCrashCapture({ app, crashReporter, rootDir, appVersion, buildCommit, logger = console }) {
  const crashDumpsDir = path.join(path.resolve(rootDir), 'crash-dumps')

  try {
    fs.mkdirSync(crashDumpsDir, { recursive: true, mode: 0o700 })
    app.setPath('crashDumps', crashDumpsDir)
    crashReporter.start({
      companyName: 'Fan',
      productName: 'Fan',
      submitURL: 'https://127.0.0.1/crash-upload-disabled',
      uploadToServer: false,
      compress: false,
      globalExtra: {
        app_version: String(appVersion || '').slice(0, 64),
        build_commit: String(buildCommit || '').slice(0, 64)
      }
    })

    return { crashDumpsDir, started: true }
  } catch (error) {
    logger.warn?.(`[local-crash-capture] Crashpad start failed: ${error?.message || error}`)

    return { crashDumpsDir, started: false }
  }
}

module.exports = { startLocalCrashCapture }
