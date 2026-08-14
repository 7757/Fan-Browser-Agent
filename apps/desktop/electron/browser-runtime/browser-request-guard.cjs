const fs = require('node:fs')
const dns = require('node:dns')
const net = require('node:net')
const path = require('node:path')
const { domainToASCII, fileURLToPath } = require('node:url')
const { sensitiveFileBlockReason } = require('../hardening.cjs')

const DEFAULT_METADATA_DNS_TIMEOUT_MS = 750
// Keep successful answers only long enough to coalesce a page-load burst. A
// long independent allow-cache would widen the DNS-rebinding TOCTOU window.
const DEFAULT_METADATA_DNS_CACHE_TTL_MS = 5_000
const DEFAULT_METADATA_DNS_FAILURE_TTL_MS = 1_000
const DEFAULT_METADATA_DNS_CACHE_ENTRIES = 512

// Keep the browser network boundary aligned with tools.url_safety's
// non-negotiable cloud-metadata floor. This guard is intentionally narrow:
// loopback and private-LAN traffic are valid browser-automation targets.
function normalizeMetadataHost(host) {
  const value = String(host || '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.+$/, '')
    .toLowerCase()
  return domainToASCII(value) || value
}

function isAlwaysBlockedMetadataHost(host) {
  const value = normalizeMetadataHost(host)
  if (value === 'metadata.google.internal' || value === 'metadata.goog') return true
  if (value === '100.100.100.200' || value === 'fd00:ec2::254') return true

  if (net.isIP(value) === 4) {
    const octets = value.split('.').map(Number)
    return octets[0] === 169 && octets[1] === 254
  }

  if (value.startsWith('::ffff:')) {
    const embedded = value.slice('::ffff:'.length)
    if (net.isIP(embedded) === 4) return isAlwaysBlockedMetadataHost(embedded)
  }

  // WHATWG URL canonicalizes IPv4-mapped IPv6 to hexadecimal groups, e.g.
  // ::ffff:169.254.169.254 becomes ::ffff:a9fe:a9fe.
  if (value.startsWith('::ffff:a9fe:') || value === '::ffff:6464:64c8') return true
  return false
}

function isAlwaysBlockedMetadataUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim())
    return isAlwaysBlockedMetadataHost(parsed.hostname || '')
  } catch {
    return false
  }
}

function metadataDnsHostname(url) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    return ''
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return ''
  const host = normalizeMetadataHost(parsed.hostname || '')
  if (!host || net.isIP(host) || host === 'localhost' || host.endsWith('.localhost')) return ''
  return host
}

function resolvedAddresses(value) {
  const candidate = value && Array.isArray(value.endpoints) ? value.endpoints : value
  const records = Array.isArray(candidate) ? candidate : candidate ? [candidate] : []
  return records
    .map(record => typeof record === 'string' ? record : record && record.address)
    .map(address => String(address || '').trim())
    .filter(Boolean)
}

// URL-only filtering catches literal and well-known metadata hosts, but a page
// can navigate/redirect an arbitrary DNS name to the same link-local endpoint.
// Resolve each hostname once per bounded cache window before Electron starts
// the request. Ordinary loopback/private answers remain valid automation
// targets; only the non-negotiable metadata floor is rejected.
function createMetadataDnsGuard({
  lookup = dns.promises.lookup,
  timeoutMs = DEFAULT_METADATA_DNS_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_METADATA_DNS_CACHE_TTL_MS,
  failureCacheTtlMs = DEFAULT_METADATA_DNS_FAILURE_TTL_MS,
  maxCacheEntries = DEFAULT_METADATA_DNS_CACHE_ENTRIES,
  now = Date.now
} = {}) {
  const cache = new Map()
  const inFlight = new Map()
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_METADATA_DNS_TIMEOUT_MS)
  const successTtlMs = Math.max(0, Number(cacheTtlMs) || 0)
  const failureTtlMs = Math.max(0, Number(failureCacheTtlMs) || 0)
  const cacheEntryLimit = Math.max(1, Number(maxCacheEntries) || DEFAULT_METADATA_DNS_CACHE_ENTRIES)
  const currentTime = () => {
    const value = Number(now())
    return Number.isFinite(value) ? value : Date.now()
  }

  const resolveHost = async host => {
    const cached = cache.get(host)
    if (cached && cached.expiresAt > currentTime()) return cached.blocked
    if (inFlight.has(host)) return inFlight.get(host)

    const pending = (async () => {
      let timer = null
      try {
        const timeout = new Promise(resolve => {
          timer = setTimeout(() => resolve({ timedOut: true }), boundedTimeoutMs)
          timer.unref?.()
        })
        const answer = await Promise.race([
          Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })),
          timeout
        ])
        if (answer && answer.timedOut) {
          return { blocked: false, failed: true }
        }
        return {
          blocked: resolvedAddresses(answer).some(isAlwaysBlockedMetadataHost),
          failed: false
        }
      } catch {
        return { blocked: false, failed: true }
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()

    // Cache after settlement without allowing observability/cache maintenance
    // to alter the blocking result. DNS failure/timeout is deliberately
    // fail-open for ordinary pages and cached only briefly.
    const tracked = pending.then(outcome => {
      const blocked = Boolean(outcome && outcome.blocked)
      const ttlMs = outcome && outcome.failed ? failureTtlMs : successTtlMs
      if (cache.size >= cacheEntryLimit) {
        const timestamp = currentTime()
        for (const [key, value] of cache) {
          if (value.expiresAt <= timestamp) cache.delete(key)
        }
        while (cache.size >= cacheEntryLimit) {
          const oldest = cache.keys().next().value
          if (oldest == null) break
          cache.delete(oldest)
        }
      }
      cache.set(host, {
        blocked,
        expiresAt: currentTime() + ttlMs
      })
      return blocked
    }).finally(() => {
      inFlight.delete(host)
    })
    inFlight.set(host, tracked)
    return tracked
  }

  return async url => {
    const host = metadataDnsHostname(url)
    if (!host) return false
    return resolveHost(host)
  }
}

// Mirrors agent.file_safety.get_read_block_error for the local-file resources
// that can otherwise enter model-visible DOM snapshots/screenshots as iframe or
// subresource content without changing the active top-level URL.
const FAN_PROTECTED_RELATIVE_FILES = new Set([
  'auth.json',
  'auth.lock',
  'config.yaml',
  'config.validated.yaml',
  '.anthropic_oauth.json',
  '.env',
  'auth/google_oauth.json',
  'cache/bws_cache.json'
])
const SECRET_ENV_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.staging',
  '.envrc'
])

function comparablePath(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalPath(value) {
  const resolved = path.resolve(String(value || ''))
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function relativeInside(root, target) {
  const relative = path.relative(comparablePath(root), comparablePath(target))
  if (!relative) return ''
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

function isProtectedRelativeFanPath(relative) {
  if (relative == null) return false
  const value = process.platform === 'win32' ? relative.toLowerCase() : relative
  if (FAN_PROTECTED_RELATIVE_FILES.has(value)) return true
  return (
    value === 'mcp-tokens' ||
    value.startsWith('mcp-tokens/') ||
    value === 'pairing' ||
    value.startsWith('pairing/')
  )
}

function isProtectedLocalFileUrl(url, { protectedFileRoots = [] } = {}) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'file:') return false

  const host = normalizeMetadataHost(parsed.hostname || '')
  if (host && host !== 'localhost') return true

  let lexicalTarget
  try {
    lexicalTarget = path.resolve(fileURLToPath(parsed))
  } catch {
    // A malformed local-file request should not become a credential-boundary
    // bypass merely because its encoding is unusual.
    return true
  }
  const canonicalTarget = canonicalPath(lexicalTarget)
  const basename = path.basename(comparablePath(canonicalTarget))
  if (SECRET_ENV_BASENAMES.has(basename)) return true
  if (sensitiveFileBlockReason(lexicalTarget) || sensitiveFileBlockReason(canonicalTarget)) return true

  for (const configuredRoot of protectedFileRoots) {
    if (!configuredRoot) continue
    const lexicalRoot = path.resolve(String(configuredRoot))
    const canonicalRoot = canonicalPath(lexicalRoot)
    for (const root of [lexicalRoot, canonicalRoot]) {
      for (const target of [lexicalTarget, canonicalTarget]) {
        if (isProtectedRelativeFanPath(relativeInside(root, target))) return true
      }
    }
  }
  return false
}

function browserRequestBlockReason(url, options = {}) {
  if (isAlwaysBlockedMetadataUrl(url)) return 'always_blocked_metadata'
  if (isProtectedLocalFileUrl(url, options)) return 'protected_local_file'
  return null
}

// Electron Session permits one listener per webRequest event. Browser tabs in
// a Fan session share one partition, so install exactly once on that partition,
// before its first WebContentsView calls loadURL(). This catches top-level
// redirects plus iframe/fetch/XHR/subresource requests before network I/O.
const guardedSessions = new WeakSet()

function installBrowserRequestGuard(session, options = {}) {
  if (!session || typeof session !== 'object') return false
  const onBeforeRequest = session.webRequest && session.webRequest.onBeforeRequest
  if (typeof onBeforeRequest !== 'function' || guardedSessions.has(session)) return false

  const metadataDnsGuard = typeof options.metadataDnsGuard === 'function'
    ? options.metadataDnsGuard
    : createMetadataDnsGuard({
        lookup:
          options.metadataLookup ||
          (typeof session.resolveHost === 'function'
            ? async host => (await session.resolveHost(host, { cacheUsage: 'allowed' })).endpoints
            : dns.promises.lookup),
        timeoutMs: options.metadataDnsTimeoutMs,
        cacheTtlMs: options.metadataDnsCacheTtlMs,
        failureCacheTtlMs: options.metadataDnsFailureTtlMs,
        maxCacheEntries: options.metadataDnsMaxCacheEntries,
        now: options.now || Date.now
      })

  const finish = (details, callback, reason) => {
    if (reason && typeof options.onBlocked === 'function') {
      try {
        options.onBlocked({ reason, url: String(details && details.url || ''), resourceType: details?.resourceType || '' })
      } catch {
        // Observability must never weaken or delay the blocking decision.
      }
    }
    callback({ cancel: Boolean(reason) })
  }

  onBeforeRequest.call(session.webRequest, (details, callback) => {
    const requestUrl = String(details && details.url || '')
    const reason = browserRequestBlockReason(requestUrl, options)
    if (reason) {
      finish(details, callback, reason)
      return
    }
    Promise.resolve(metadataDnsGuard(requestUrl))
      .then(blocked => finish(details, callback, blocked ? 'always_blocked_metadata' : null))
      // DNS failure/timeout is intentionally fail-open for ordinary browser
      // traffic. Literal and well-known metadata targets were already blocked
      // synchronously above.
      .catch(() => finish(details, callback, null))
  })
  guardedSessions.add(session)
  return true
}

module.exports = {
  browserRequestBlockReason,
  createMetadataDnsGuard,
  installBrowserRequestGuard,
  isAlwaysBlockedMetadataHost,
  isAlwaysBlockedMetadataUrl,
  isProtectedLocalFileUrl,
  normalizeMetadataHost
}
