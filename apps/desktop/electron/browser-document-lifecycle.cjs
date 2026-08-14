'use strict'

function normalizedUrl(value, { stripHash = false } = {}) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    if (stripHash) parsed.hash = ''
    return parsed.href
  } catch {
    return raw
  }
}

function normalizedIdentity(value = {}) {
  return {
    documentRevision: Number(value.documentRevision) || 0,
    navigationEpoch: Number(value.navigationEpoch) || 0,
    viewEpoch: Number(value.viewEpoch) || 0
  }
}

function sameNavigationUrl(left, right) {
  const normalizedLeft = normalizedUrl(left, { stripHash: true })
  const normalizedRight = normalizedUrl(right, { stripHash: true })
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight)
}

function createFaviconDocumentGate(initial = {}) {
  let binding = normalizedIdentity(initial)

  return {
    bind(next = {}) {
      binding = normalizedIdentity(next)
    },
    invalidate() {
      binding = null
    },
    matches(candidate = {}) {
      const identity = normalizedIdentity(candidate)
      return Boolean(
        binding &&
        binding.documentRevision === identity.documentRevision &&
        binding.navigationEpoch === identity.navigationEpoch &&
        binding.viewEpoch === identity.viewEpoch
      )
    }
  }
}

class PendingNavigationAttempts {
  constructor({ limit = 16 } = {}) {
    this._attempts = []
    this._limit = Math.max(2, Math.min(64, Number(limit) || 16))
  }

  begin({ epoch, url } = {}) {
    const navigationEpoch = Number(epoch)
    if (!Number.isSafeInteger(navigationEpoch) || navigationEpoch <= 0) return null
    const existing = this._attempts.find(attempt => attempt.epoch === navigationEpoch)
    const alias = normalizedUrl(url, { stripHash: true })
    if (existing) {
      if (alias) existing.aliases.add(alias)
      return { epoch: existing.epoch, url: alias }
    }

    const attempt = { aliases: new Set(alias ? [alias] : []), epoch: navigationEpoch }
    this._attempts.push(attempt)
    if (this._attempts.length > this._limit) {
      this._attempts.splice(0, this._attempts.length - this._limit)
    }
    return { epoch: attempt.epoch, url: alias }
  }

  addAlias(epoch, url) {
    const attempt = this._attempts.find(item => item.epoch === Number(epoch))
    const alias = normalizedUrl(url, { stripHash: true })
    if (!attempt || !alias) return false
    attempt.aliases.add(alias)
    return true
  }

  consumeFailure(url, { aborted = false, currentEpoch } = {}) {
    const failedUrl = normalizedUrl(url, { stripHash: true })
    const activeEpoch = Number(currentEpoch)
    const hasActiveEpoch = Number.isSafeInteger(activeEpoch) && activeEpoch > 0
    const matches = this._attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => !failedUrl || attempt.aliases.has(failedUrl))

    let index = -1
    if (hasActiveEpoch && aborted) {
      // Starting a replacement navigation cancels the older provisional load.
      // Prefer that superseded attempt even if both navigations use the same URL;
      // a later real failure for the active attempt must retain its own epoch.
      index = matches.find(({ attempt }) => attempt.epoch !== activeEpoch)?.index ?? -1
      if (index < 0) index = matches.find(({ attempt }) => attempt.epoch === activeEpoch)?.index ?? -1
    } else if (hasActiveEpoch) {
      // A non-aborted provisional failure belongs to the active NavigationHandle.
      // Electron can emit synthetic did-fail-load events for rejected loadURL()
      // calls that never produced did-start-navigation; main intentionally does
      // not feed those events into this queue.
      index = matches.find(({ attempt }) => attempt.epoch === activeEpoch)?.index ?? -1
    } else if (failedUrl) {
      index = matches[0]?.index ?? -1
    } else if (this._attempts.length === 1) {
      index = 0
    }

    if (index < 0) return null
    const [attempt] = this._attempts.splice(index, 1)
    return { epoch: attempt.epoch, url: failedUrl }
  }

  consumeEpoch(epoch) {
    const index = this._attempts.findIndex(attempt => attempt.epoch === Number(epoch))
    if (index < 0) return null
    const [attempt] = this._attempts.splice(index, 1)
    return { epoch: attempt.epoch }
  }

  consumeOldest() {
    const attempt = this._attempts.shift()
    return attempt ? { epoch: attempt.epoch } : null
  }

  has(epoch) {
    return this._attempts.some(attempt => attempt.epoch === Number(epoch))
  }

  size() {
    return this._attempts.length
  }
}

function isAbortedNavigationFailure(errorOrCode) {
  const numericCode = Number(
    errorOrCode && typeof errorOrCode === 'object'
      ? (errorOrCode.errno ?? errorOrCode.errorCode ?? errorOrCode.code)
      : errorOrCode
  )
  if (numericCode === -3) return true
  if (!errorOrCode || typeof errorOrCode !== 'object') return false
  return [errorOrCode.code, errorOrCode.message, errorOrCode.description].some(value =>
    String(value || '')
      .toUpperCase()
      .includes('ERR_ABORTED')
  )
}

function declaredFaviconSet(values, documentUrl) {
  const declared = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || '').trim()
    if (!raw) continue
    try {
      declared.add(new URL(raw, documentUrl || undefined).href)
    } catch {
      declared.add(raw)
    }
  }
  return declared
}

function implicitOriginFavicon(documentUrl) {
  try {
    const parsed = new URL(String(documentUrl || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return `${parsed.origin}/favicon.ico`
  } catch {
    return ''
  }
}

function selectDocumentFavicon(candidates, snapshot = {}) {
  const values = (Array.isArray(candidates) ? candidates : []).map(value => String(value || '').trim()).filter(Boolean)
  const documentUrl = String(snapshot.documentUrl || '')
  const declared = declaredFaviconSet(snapshot.declaredIcons, documentUrl)
  const implicit = implicitOriginFavicon(documentUrl)

  if (!values.length) {
    return declared.size ? { accepted: false, favicon: '' } : { accepted: true, favicon: '' }
  }

  for (let index = values.length - 1; index >= 0; index -= 1) {
    let candidate = values[index]
    try {
      candidate = new URL(candidate, documentUrl || undefined).href
    } catch {
      // Preserve renderer-local schemes/opaque values for exact declaration matching.
    }
    // Chromium's implicit /favicon.ico lookup is valid only when the current
    // document did not declare an icon. Otherwise a delayed event from an older
    // same-origin document could override the new document's explicit choice.
    if (declared.has(candidate) || (declared.size === 0 && implicit && candidate === implicit)) {
      return { accepted: true, favicon: candidate }
    }
  }
  return { accepted: false, favicon: '' }
}

async function resolveCurrentDocumentFavicon({
  candidates,
  documentIdentity,
  gate,
  inspectDocument,
  isCurrent = () => true
} = {}) {
  const stillCurrent = () => Boolean(gate?.matches?.(documentIdentity) && isCurrent())
  if (!stillCurrent() || typeof inspectDocument !== 'function') return { accepted: false, favicon: '' }
  const snapshot = await inspectDocument()
  if (!stillCurrent()) return { accepted: false, favicon: '' }
  return selectDocumentFavicon(candidates, snapshot)
}

module.exports = {
  PendingNavigationAttempts,
  createFaviconDocumentGate,
  isAbortedNavigationFailure,
  resolveCurrentDocumentFavicon,
  sameNavigationUrl,
  selectDocumentFavicon
}
