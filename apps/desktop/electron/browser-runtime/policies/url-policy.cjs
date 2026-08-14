const net = require('node:net')
const { domainToASCII } = require('node:url')

const { isAlwaysBlockedMetadataHost } = require('../browser-request-guard.cjs')

const URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD = 100

function normalizeStringList(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean)
  return String(value || '')
    .split(/\s*,\s*|\s+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function emptyUrlPolicy() {
  return {
    allowedDomains: [],
    prohibitedDomains: [],
    blockIPAddresses: false,
    allowedDomainSet: null,
    prohibitedDomainSet: null
  }
}

function normalizePolicyHost(host) {
  const value = String(host || '').trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return domainToASCII(value) || value
}

function normalizeUrlPolicyPattern(pattern, normalizeHost = normalizePolicyHost) {
  const raw = String(pattern || '').trim()
  if (!raw) return ''
  if (raw.includes('://')) {
    const separator = raw.indexOf('://')
    const scheme = raw.slice(0, separator).toLowerCase()
    const rest = raw.slice(separator + 3)
    const hostEnd = rest.search(/[/?#]/)
    const hostPart = hostEnd === -1 ? rest : rest.slice(0, hostEnd)
    const suffix = hostEnd === -1 ? '' : rest.slice(hostEnd)
    if (!hostPart) return raw.toLowerCase()
    if (hostPart.startsWith('*.')) return `${scheme}://*.${normalizeHost(hostPart.slice(2))}${suffix}`
    if (!hostPart.includes('*')) return `${scheme}://${normalizeHost(hostPart)}${suffix}`
    return `${scheme}://${hostPart.toLowerCase()}${suffix}`
  }
  if (raw.startsWith('*.')) return `*.${normalizeHost(raw.slice(2))}`
  if (!raw.includes('*')) return normalizeHost(raw)
  return raw.toLowerCase()
}

function shouldWarnForUrlPolicyOptimization(patterns) {
  return Array.isArray(patterns) &&
    patterns.length >= URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD &&
    patterns.some(pattern => String(pattern).includes('*'))
}

function compileUrlPolicySet(patterns, normalizePattern = normalizeUrlPolicyPattern) {
  if (!Array.isArray(patterns) || patterns.length < URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD) return null
  return new Set(patterns.map(pattern => normalizePattern(pattern)).filter(Boolean))
}

function buildUrlPolicy(
  { allowedDomains = [], prohibitedDomains = [], blockIPAddresses = false } = {},
  {
    normalizeStringList: normalizeList = normalizeStringList,
    compileUrlPolicySet: compileSet = compileUrlPolicySet
  } = {}
) {
  const allowed = normalizeList(allowedDomains)
  const prohibited = normalizeList(prohibitedDomains)
  return {
    allowedDomains: allowed,
    prohibitedDomains: prohibited,
    blockIPAddresses: Boolean(blockIPAddresses),
    allowedDomainSet: compileSet(allowed),
    prohibitedDomainSet: compileSet(prohibited)
  }
}

function isRootDomain(domain, normalizeHost = normalizePolicyHost) {
  const value = normalizeHost(domain)
  return Boolean(value && !value.includes('*') && !value.includes('://') && value.split('.').length === 2)
}

function domainVariants(host, normalizeHost = normalizePolicyHost) {
  const value = normalizeHost(host)
  return value.startsWith('www.') ? [value, value.slice(4)] : [value, `www.${value}`]
}

function globToRegex(pattern) {
  const escaped = String(pattern || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function isIpHost(host) {
  const value = String(host || '').replace(/^\[/, '').replace(/\]$/, '')
  return net.isIP(value) !== 0
}

function isUrlPatternMatch(
  url,
  parsed,
  pattern,
  {
    normalizeUrlPolicyPattern: normalizePattern = normalizeUrlPolicyPattern,
    normalizePolicyHost: normalizeHost = normalizePolicyHost,
    globToRegex: makeRegex = globToRegex,
    isRootDomain: rootDomain = isRootDomain
  } = {}
) {
  const raw = String(pattern || '').trim()
  if (!raw) return false
  const normalizedPattern = normalizePattern(raw)
  const host = normalizeHost(parsed.hostname || '')
  const scheme = String(parsed.protocol || '').replace(/:$/, '').toLowerCase()
  const normalizedUrl = parsed.href
  if (normalizedPattern.includes('*')) {
    if (normalizedPattern.startsWith('*.')) {
      const domainPart = normalizedPattern.slice(2).toLowerCase()
      return ['http', 'https'].includes(scheme) && (host === domainPart || host.endsWith(`.${domainPart}`))
    }
    if (normalizedPattern.endsWith('/*') || normalizedPattern.includes('://')) {
      return makeRegex(normalizedPattern).test(normalizedUrl)
    }
    return makeRegex(normalizedPattern).test(host)
  }
  if (normalizedPattern.includes('://')) return normalizedUrl.startsWith(normalizedPattern) || url.startsWith(raw)
  const domain = normalizedPattern.toLowerCase()
  if (host === domain) return true
  return rootDomain(domain) && host === `www.${domain}`
}

function isHostAllowedByPolicySet(host, domainSet, { domainVariants: variants = domainVariants } = {}) {
  if (!(domainSet instanceof Set)) return null
  const [hostVariant, hostAlt] = variants(host)
  return domainSet.has(hostVariant) || domainSet.has(hostAlt)
}

function urlPolicyDecision(
  entry,
  url,
  {
    isAlwaysBlockedMetadataHost: isAlwaysBlocked = isAlwaysBlockedMetadataHost,
    normalizePolicyHost: normalizeHost = normalizePolicyHost,
    isIpHost: ipHost = isIpHost,
    isHostAllowedByPolicySet: hostAllowedBySet = isHostAllowedByPolicySet,
    isUrlPatternMatch: patternMatches = isUrlPatternMatch
  } = {}
) {
  const value = String(url || '').trim()
  if (!value) return { allowed: false, reason: 'empty_url', url: value }
  if (['about:blank', 'chrome://new-tab-page/', 'chrome://new-tab-page', 'chrome://newtab/'].includes(value)) {
    return { allowed: true, reason: 'internal', url: value }
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { allowed: false, reason: 'invalid_url', url: value }
  }
  if (isAlwaysBlocked(parsed.hostname || '')) {
    return { allowed: false, reason: 'always_blocked_metadata', url: value }
  }
  if (['data:', 'blob:'].includes(parsed.protocol)) return { allowed: true, reason: 'local', url: value }
  // Fan's browser is also a local automation surface. The Python boundary
  // still rejects Fan authority / credential files before model-visible reads,
  // while ordinary local HTML and its resources navigate like a normal browser.
  if (parsed.protocol === 'file:') {
    const fileHost = normalizeHost(parsed.hostname || '')
    if (fileHost && fileHost !== 'localhost') {
      return { allowed: false, reason: 'remote_file_host_blocked', url: value }
    }
    return { allowed: true, reason: 'local_file', url: value }
  }
  const host = normalizeHost(parsed.hostname || '')
  if (!host) return { allowed: false, reason: 'missing_host', url: value }
  const policy = entry.urlPolicy || {}
  if (policy.blockIPAddresses && ipHost(host)) {
    return { allowed: false, reason: 'ip_address_blocked', url: value, host }
  }
  const allowedDomains = policy.allowedDomains || []
  if (allowedDomains.length) {
    const allowed = policy.allowedDomainSet
      ? hostAllowedBySet(host, policy.allowedDomainSet)
      : allowedDomains.some(pattern => patternMatches(value, parsed, pattern))
    return { allowed, reason: allowed ? 'allowed_domain' : 'not_in_allowed_domains', url: value, host }
  }
  const prohibitedDomains = policy.prohibitedDomains || []
  if (prohibitedDomains.length) {
    const prohibited = policy.prohibitedDomainSet
      ? hostAllowedBySet(host, policy.prohibitedDomainSet)
      : prohibitedDomains.some(pattern => patternMatches(value, parsed, pattern))
    return { allowed: !prohibited, reason: prohibited ? 'prohibited_domain' : 'not_prohibited', url: value, host }
  }
  return { allowed: true, reason: 'unrestricted', url: value, host }
}

module.exports = {
  URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD,
  buildUrlPolicy,
  compileUrlPolicySet,
  domainVariants,
  emptyUrlPolicy,
  globToRegex,
  isHostAllowedByPolicySet,
  isIpHost,
  isRootDomain,
  isUrlPatternMatch,
  normalizePolicyHost,
  normalizeStringList,
  normalizeUrlPolicyPattern,
  shouldWarnForUrlPolicyOptimization,
  urlPolicyDecision
}
