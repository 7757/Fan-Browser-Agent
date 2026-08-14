'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const { browserRequestBlockReason } = require('../browser-request-guard.cjs')
const { EVENT_TYPES } = require('../events/event-types.cjs')

const DEFAULT_CODE_LIMIT_BYTES = 64 * 1024
const DEFAULT_STEP_LIMIT = 200
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_TIMEOUT_MS = 600_000
const DEFAULT_VALUE_LIMIT_BYTES = 512 * 1024
const DEFAULT_SNAPSHOT_LIMIT_BYTES = 512 * 1024
const DEFAULT_REQUEST_LIMIT_BYTES = 256 * 1024
const DEFAULT_CONSOLE_LIMIT = 100
const DEFAULT_CONSOLE_BYTES = 64 * 1024
const PROTECTED_VALUE_MARKER_KEY = '__fanProtectedValue'
const PROTECTED_VALUE_REF_PREFIX = 'fan-value://'
const PROTECTED_VALUE_METHODS = new Set([
  'type', 'fillForm', 'formSubmit', 'dialog', 'select', 'upload'
])
const PROTECTED_REDACTION_EXEMPT_KEYS = new Set([
  '__fanDecisionToken', '_fanDecisionToken', 'visualEvidenceToken',
  'observationId', '__fanObservationId', 'runId', 'actionId', 'requestId',
  'sessionId', 'workbenchId', 'tabId', 'stableId', 'frameId', 'targetId',
  'dialogId', 'downloadId', 'interventionId', 'challengeId', 'leaseId',
  'eventId', 'id'
])
// Keep the public character limit below the 512 KiB result boundary even for
// JSON's worst-case escaping. The byte projection below handles native
// content that still exceeds the host boundary.
const PAGE_CONTENT_MAX_CHARS = 80_000
const DEFAULT_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4
})

const EFFECTFUL_METHODS = new Set([
  'navigate', 'search', 'back', 'forward', 'reload',
  'click', 'clickPoint', 'type', 'fillForm', 'formSubmit', 'keys', 'dialog', 'select',
  'hover', 'focus', 'highlight', 'scroll', 'scrollToText', 'drag', 'dragPoint', 'upload',
  'newTab', 'switchTab', 'closeTab', 'saveScreenshot', 'savePdf'
])

const HUMAN_ERROR_CODES = new Set([
  'HUMAN_INTERVENTION_PENDING',
  'BROWSER_PROGRAM_HANDOFF',
  'BROWSER_PROGRAM_USER_INTERVENED'
])
const ACTION_SETTLEMENT_SYMBOL = Symbol.for('fan.browser.action-settlement')

const UNKNOWN_EFFECT_ERROR_CODES = new Set([
  'ACTION_TIMEOUT_PENDING',
  'BROWSER_ACTION_STATUS_UNKNOWN',
  'FORM_SUBMIT_INVALID_RESULT',
  'FORM_SUBMIT_INVALID_PROVENANCE'
])

const OPTION_KEYS = Object.freeze({
  // Canonical snapshots are a host invariant. Model code cannot trade away
  // indexed controls by tuning serializer, accessibility, or element limits.
  observe: new Set(),
  pageContent: new Set([
    'format',
    'extractLinks', 'extract_links',
    'extractImages', 'extract_images',
    'startFromChar', 'start_from_char',
    'maxChars', 'max_chars',
    'overlapLines', 'overlap_lines'
  ]),
  navigate: new Set([
    'waitUntil', 'wait_until', 'waitTimeoutMs', 'wait_timeout_ms',
    'networkIdleMs', 'network_idle_ms',
    'networkIdleTimeoutMs', 'network_idle_timeout_ms', 'timeoutMs'
  ]),
  search: new Set(['engine', 'timeoutMs']),
  back: new Set(['timeoutMs']),
  forward: new Set(['timeoutMs']),
  reload: new Set(['ignoreCache', 'ignore_cache', 'timeoutMs']),
  click: new Set(['allowOccluded', 'force', 'expected', 'timeoutMs']),
  type: new Set([
    'clear', 'typingMode', 'typing_mode', 'delayMs', 'delay_ms',
    'typingDelayMs', 'typing_delay_ms', 'fast',
    'autocompleteWait', 'autocomplete_wait',
    'autocompleteWaitMs', 'autocomplete_wait_ms', 'expected', 'expectedLabel',
    'timeoutMs'
  ]),
  fillForm: new Set(['timeoutMs']),
  formSubmit: new Set(['timeoutMs']),
  keys: new Set(['timeoutMs']),
  select: new Set(['timeoutMs']),
  dropdownOptions: new Set(['timeoutMs']),
  hover: new Set(['timeoutMs']),
  focus: new Set(['timeoutMs']),
  highlight: new Set(['limit', 'clear']),
  scroll: new Set(['down', 'up', 'pages', 'timeoutMs']),
  scrollToText: new Set(['exact', 'caseSensitive', 'case_sensitive', 'timeoutMs']),
  drag: new Set(['button', 'steps', 'timeoutMs']),
  upload: new Set(['timeoutMs']),
  wait: new Set(),
  waitForState: new Set(['timeoutMs', 'pollMs', 'description']),
  // `description` is a harmless label supported by the sibling declarative
  // wait APIs. Accept it as a compatibility input so a model cannot turn an
  // already-completed browser effect into failed_after_effect by reusing that
  // label on settle. It is stripped before reaching the native runtime.
  settle: new Set([
    'timeoutMs', 'timeout_ms', 'networkIdleMs', 'network_idle_ms', 'description'
  ]),
  newTab: new Set(['timeoutMs']),
  switchTab: new Set(['timeoutMs']),
  closeTab: new Set(['timeoutMs']),
  saveScreenshot: new Set([
    'fileName', 'file_name', 'format', 'quality',
    'captureBeyondViewport', 'fullPage', 'full_page',
    'includeHighlights', 'include_highlights', 'timeoutMs'
  ]),
  savePdf: new Set([
    'fileName', 'file_name', 'printBackground', 'print_background',
    'landscape', 'scale', 'paperFormat', 'paper_format', 'timeoutMs'
  ])
})

const FIELD_KEYS = new Set([
  'target', 'ref', 'index',
  'text', 'clear', 'typingMode', 'typing_mode', 'delayMs', 'delay_ms',
  'typingDelayMs', 'typing_delay_ms', 'fast',
  'autocompleteWait', 'autocomplete_wait',
  'autocompleteWaitMs', 'autocomplete_wait_ms',
  'expected', 'expectedLabel'
])

const SUBMIT_KEYS = new Set([
  'target', 'ref', 'index', '__fanRef', 'observationId', '__fanObservationId',
  // An element object returned by fan.observe is itself a valid target. These
  // descriptive fields are transport metadata, never forwarded to the action.
  'role', 'name', 'text', 'label', 'placeholder', 'tag', 'href',
  'allowOccluded', 'expected'
])

const BINARY_RESULT_KEYS = new Set([
  'screenshot', 'image', 'imageData', 'image_data', 'base64'
])

// The native observation contains several diagnostic and duplicate DOM
// representations. The program surface needs one canonical model view with
// the page identity and serialized DOM first, followed by the structured
// numbered elements used by in-program deterministic filters. Keeping this
// projection explicit prevents the generic object-entry guard from consuming
// its budget inside `elements` before it ever reaches browserUseText.
const SNAPSHOT_METADATA_KEYS = Object.freeze([
  'profileId', 'profile_id',
  'taskSpaceId', 'task_space_id',
  'pageId', 'page_id',
  'url', 'title', 'tabs',
  'readyState', 'viewport',
  'pagination',
  'truncated', 'elementsTruncated', 'omittedElementCount',
  'omittedInteractiveCount', 'maxElements', 'truncationHint',
  'pendingNetworkRequests', 'navigationFailure',
  'captcha', 'captchaState', 'interventionPending', 'interventionMeta', 'overlay',
  'browserContext', 'controlState',
  'documentRevision', 'document_revision',
  'selectorGeneration', 'selector_generation',
  'observationGeneration',
  'snapshotGeneration', 'snapshot_generation',
  'isPdfViewer', 'pdfDownloadPath',
  'snapshot', 'snapshotError',
  'accessibility', 'accessibilityError',
  'frames', 'frameMetadataError'
])

const SNAPSHOT_FALLBACK_METADATA_KEYS = Object.freeze([
  'profileId', 'profile_id',
  'taskSpaceId', 'task_space_id',
  'pageId', 'page_id',
  'url', 'title', 'tabs',
  'readyState', 'viewport', 'pagination',
  'captcha', 'captchaState', 'interventionPending', 'interventionMeta', 'overlay',
  'browserContext', 'controlState',
  'documentRevision', 'document_revision',
  'selectorGeneration', 'selector_generation',
  'observationGeneration',
  'snapshotGeneration', 'snapshot_generation',
  'isPdfViewer', 'pdfDownloadPath'
])

const COMPACT_ELEMENT_KEYS = Object.freeze([
  'tag', 'role', 'type', 'name', 'text', 'label', 'placeholder',
  'href', 'value', 'checked', 'disabled', 'readonly',
  'autocomplete', 'capabilities'
])

const COMPACT_ATTRIBUTE_KEYS = new Set([
  'id', 'name', 'type', 'role', 'title', 'href', 'value', 'placeholder',
  'for', 'form', 'target', 'rel', 'download', 'contenteditable',
  'disabled', 'readonly', 'required', 'checked', 'selected', 'multiple',
  'min', 'max', 'step', 'list', 'autocomplete', 'class'
])

function programError(message, code, details = undefined, statusCode = 400) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  if (details && typeof details === 'object') error.details = details
  return error
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(1, Math.min(maximum, Math.trunc(number)))
}

function canonicalSessionId(value) {
  return String(value || 'main').split('#')[0]
}

function boundedString(value, maxLength = 2000) {
  if (value == null) return undefined
  return String(value).slice(0, maxLength)
}

function normalizeProtectedValues(value) {
  if (value == null) return new Map()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw programError(
      'Browser program protected values must be an alias map',
      'BROWSER_PROGRAM_VALUE_REFS_INVALID',
      undefined,
      400
    )
  }
  const entries = Object.entries(value)
  if (entries.length > 32) {
    throw programError(
      'Browser program accepts at most 32 protected value aliases',
      'BROWSER_PROGRAM_VALUE_REFS_INVALID',
      undefined,
      400
    )
  }
  const result = new Map()
  for (const [alias, raw] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(alias) ||
      ['__proto__', 'constructor', 'prototype'].includes(alias) ||
      typeof raw !== 'string'
    ) {
      throw programError(
        `Browser program protected value alias is invalid: ${boundedString(alias, 64) || '(empty)'}`,
        'BROWSER_PROGRAM_VALUE_ALIAS_INVALID',
        undefined,
        400
      )
    }
    result.set(alias, raw)
  }
  return result
}

function escapeProtectedPattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function protectedValueRedactions(values) {
  if (!(values instanceof Map) || !values.size) return []
  return [...values.entries()]
    .filter(([, raw]) => typeof raw === 'string' && raw.length > 0)
    .map(([alias, raw]) => {
      const candidates = new Set([
        raw,
        raw.trim(),
        raw.replace(/\s+/g, ' ').trim()
      ])
      try {
        const encoded = encodeURIComponent(raw)
        candidates.add(encoded)
        candidates.add(encoded.replace(/%20/gi, '+'))
      } catch {
        // Invalid Unicode still receives exact raw-string redaction below.
      }
      const patterns = [...candidates]
        .filter(candidate => candidate.length >= 3)
        .sort((left, right) => right.length - left.length)
        .map(candidate => new RegExp(escapeProtectedPattern(candidate), 'gi'))
      const digits = raw.replace(/\D/g, '')
      const digitPattern = digits.length >= 6
        ? new RegExp(
            `(^|\\D)\\+?${digits
              .split('')
              .map(digit => escapeProtectedPattern(digit))
              .join('[\\s().-]*')}(?!\\d)`,
            'g'
          )
        : null
      return {
        alias,
        raw,
        marker: `[PROTECTED:${alias}]`,
        patterns,
        digitPattern
      }
    })
    .sort((left, right) => right.raw.length - left.raw.length)
}

function redactProtectedValues(value, redactions, key = '', depth = 0, seen = new WeakSet()) {
  if (!Array.isArray(redactions) || !redactions.length) return value
  if (PROTECTED_REDACTION_EXEMPT_KEYS.has(key)) return value
  if (typeof value === 'string') {
    let result = value
    for (const item of redactions) {
      if (item.raw.length < 3) {
        if (result === item.raw) result = item.marker
        continue
      }
      for (const pattern of item.patterns) {
        result = result.replace(pattern, item.marker)
      }
      if (item.digitPattern) {
        result = result.replace(
          item.digitPattern,
          (_match, prefix) => `${prefix}${item.marker}`
        )
      }
    }
    return result
  }
  if (value == null || typeof value !== 'object') return value
  if (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return value
  }
  if (depth >= 20 || seen.has(value)) return '[redacted]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map(item => redactProtectedValues(item, redactions, '', depth + 1, seen))
    }
    const result = {}
    for (const [childKey, item] of Object.entries(value)) {
      result[childKey] = redactProtectedValues(
        item,
        redactions,
        childKey,
        depth + 1,
        seen
      )
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function protectedValueAlias(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== PROTECTED_VALUE_MARKER_KEY) return ''
  const alias = value[PROTECTED_VALUE_MARKER_KEY]
  return typeof alias === 'string' ? alias : ''
}

function containsProtectedValue(value, depth = 0) {
  if (depth > 8 || value == null) return false
  if (protectedValueAlias(value)) return true
  if (Array.isArray(value)) {
    return value.some(item => containsProtectedValue(item, depth + 1))
  }
  if (typeof value !== 'object') return false
  return Object.values(value).some(item => containsProtectedValue(item, depth + 1))
}

function resolveProtectedValue(state, value, label) {
  const alias = protectedValueAlias(value)
  if (alias) {
    if (!state.protectedValues.has(alias)) {
      throw programError(
        `${label} references an unavailable protected value alias: ${boundedString(alias, 64)}`,
        'BROWSER_PROGRAM_VALUE_ALIAS_UNAVAILABLE',
        { beforeDispatch: true, dispatchAttempted: false, alias: boundedString(alias, 64) },
        400
      )
    }
    return state.protectedValues.get(alias)
  }
  if (typeof value === 'string' && value.startsWith(PROTECTED_VALUE_REF_PREFIX)) {
    throw programError(
      `${label} received a literal fan-value:// reference; use browser_run.value_refs and fan.protectedValue(alias)`,
      'BROWSER_PROGRAM_VALUE_REF_LITERAL',
      { beforeDispatch: true, dispatchAttempted: false },
      400
    )
  }
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value ?? '')
  }
  throw programError(
    `${label} must be text or fan.protectedValue(alias)`,
    'BROWSER_PROGRAM_INVALID_PROTECTED_VALUE',
    { beforeDispatch: true, dispatchAttempted: false },
    400
  )
}

function normalizeVisualPoint(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw programError(
      `${label} must be an object with own numeric x and y properties`,
      'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
    )
  }
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    keys = []
  }
  if (
    keys.length !== 2 ||
    !keys.includes('x') ||
    !keys.includes('y') ||
    keys.some(key => typeof key !== 'string')
  ) {
    throw programError(
      `${label} accepts only own x and y properties`,
      'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
    )
  }
  const point = {}
  for (const key of ['x', 'y']) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      descriptor = null
    }
    if (
      !descriptor ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      typeof descriptor.value !== 'number' ||
      !Number.isFinite(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 1000
    ) {
      throw programError(
        `${label}.${key} must be an own finite number from 0 through 1000`,
        'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
      )
    }
    point[key] = descriptor.value
  }
  return point
}

function safeError(error, fallbackCode = 'BROWSER_PROGRAM_FAILED') {
  const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? jsonSafe(error.details, { maxDepth: 6, maxEntries: 50, maxString: 2000 }).value
    : undefined
  return {
    name: boundedString(error?.name || 'Error', 80),
    message: boundedString(error?.message || error || 'Browser program failed', 2000),
    code: boundedString(error?.code || fallbackCode, 120),
    ...(details === undefined ? {} : { details })
  }
}

function jsonSafe(input, {
  maxDepth = 12,
  maxEntries = 2000,
  maxArray = 2000,
  maxString = 256 * 1024
} = {}) {
  let truncated = false
  const seen = new WeakSet()
  let entries = 0

  const visit = (value, depth) => {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') {
      return Number.isFinite(value) || typeof value !== 'number' ? value : String(value)
    }
    if (typeof value === 'string') {
      if (value.length <= maxString) return value
      truncated = true
      return `${value.slice(0, maxString)}…[truncated]`
    }
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
      truncated = true
      return undefined
    }
    if (depth >= maxDepth) {
      truncated = true
      return '[max-depth]'
    }
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) {
      truncated = true
      return '[circular]'
    }
    seen.add(value)
    try {
      if (ArrayBuffer.isView(value)) {
        truncated = true
        return {
          type: value.constructor?.name || 'TypedArray',
          byteLength: Number(value.byteLength) || 0
        }
      }
      if (value instanceof ArrayBuffer) {
        truncated = true
        return { type: 'ArrayBuffer', byteLength: value.byteLength }
      }
      if (value instanceof Date) return value.toISOString()
      if (Array.isArray(value)) {
        const limit = Math.min(value.length, maxArray)
        if (limit < value.length) truncated = true
        const result = []
        for (let index = 0; index < limit && entries < maxEntries; index += 1) {
          entries += 1
          result.push(visit(value[index], depth + 1))
        }
        if (limit < value.length || entries >= maxEntries) truncated = true
        return result
      }
      const result = {}
      for (const [key, item] of Object.entries(value)) {
        if (entries >= maxEntries) {
          truncated = true
          break
        }
        entries += 1
        const next = visit(item, depth + 1)
        if (next !== undefined) result[String(key).slice(0, 300)] = next
      }
      return result
    } finally {
      seen.delete(value)
    }
  }

  return { value: visit(input, 0), truncated }
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function projectToLimit(input, limitBytes, label, safeOptions = undefined) {
  const safe = jsonSafe(input, safeOptions)
  const bytes = serializedBytes(safe.value)
  if (bytes <= limitBytes) {
    return {
      value: safe.value,
      metadata: safe.truncated
        ? { truncated: true, reason: 'shape_limit', bytes }
        : null
    }
  }

  const previewBudget = Math.max(128, Math.min(64 * 1024, limitBytes - 512))
  let preview = ''
  try {
    preview = JSON.stringify(safe.value).slice(0, previewBudget)
  } catch {
    preview = String(input).slice(0, previewBudget)
  }
  return {
    value: {
      __fanTruncated: true,
      kind: label,
      originalBytes: Number.isFinite(bytes) ? bytes : null,
      jsonPreview: preview
    },
    metadata: {
      truncated: true,
      reason: 'byte_limit',
      originalBytes: Number.isFinite(bytes) ? bytes : null,
      limitBytes
    }
  }
}

const PAGE_CONTENT_CURSOR_STATS = Object.freeze([
  'method',
  'originalContentChars',
  'contentLength',
  'returnedChars',
  'startFromChar',
  'maxChars',
  'truncated',
  'hasMore',
  'nextStartChar',
  'chunkIndex',
  'totalChunks',
  'charOffsetStart',
  'charOffsetEnd',
  'overlapPrefixChars',
  'mainContentStart'
])

function setEnumerableValue(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  })
}

function canonicalPageContentResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw programError(
      'The native pageContent action returned an invalid result',
      'BROWSER_PROGRAM_RESULT_INVALID',
      { method: 'pageContent' },
      500
    )
  }
  const format = typeof input.format === 'string'
    ? input.format.toLowerCase()
    : ''
  if (!['markdown', 'html', 'text'].includes(format) || typeof input.content !== 'string') {
    throw programError(
      'The native pageContent action returned invalid content',
      'BROWSER_PROGRAM_RESULT_INVALID',
      { method: 'pageContent' },
      500
    )
  }

  const rawStats = input.stats && typeof input.stats === 'object' && !Array.isArray(input.stats)
    ? input.stats
    : {}
  const safeStats = jsonSafe(rawStats, {
    maxDepth: 6,
    maxEntries: 256,
    maxArray: 64,
    maxString: 4096
  }).value
  const stats = {}
  // Copy cursor fields first so verbose serializer diagnostics cannot crowd
  // pagination state out of the canonical envelope.
  for (const key of PAGE_CONTENT_CURSOR_STATS) {
    if (!Object.prototype.hasOwnProperty.call(rawStats, key)) continue
    const safeValue = jsonSafe(rawStats[key], {
      maxDepth: 3,
      maxEntries: 16,
      maxArray: 16,
      maxString: 512
    }).value
    if (safeValue !== undefined) setEnumerableValue(stats, key, safeValue)
  }
  if (safeStats && typeof safeStats === 'object' && !Array.isArray(safeStats)) {
    for (const [key, value] of Object.entries(safeStats)) {
      if (Object.prototype.hasOwnProperty.call(stats, key)) continue
      setEnumerableValue(stats, key, value)
    }
  }
  return { format, content: input.content, stats }
}

function isCanonicalPageContentEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  if (
    !Object.prototype.hasOwnProperty.call(input, 'format') ||
    !Object.prototype.hasOwnProperty.call(input, 'content') ||
    !Object.prototype.hasOwnProperty.call(input, 'stats')
  ) return false
  const format = typeof input.format === 'string'
    ? input.format.toLowerCase()
    : ''
  if (
    !['markdown', 'html', 'text'].includes(format) ||
    typeof input.content !== 'string' ||
    !input.stats ||
    typeof input.stats !== 'object' ||
    Array.isArray(input.stats)
  ) return false
  return PAGE_CONTENT_CURSOR_STATS.some(key => (
    Object.prototype.hasOwnProperty.call(input.stats, key)
  ))
}

function pageContentSourceStart(stats) {
  for (const key of ['charOffsetStart', 'startFromChar']) {
    const value = Number(stats?.[key])
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return 0
}

function safeStringPrefix(value, length) {
  let end = Math.max(0, Math.min(String(value).length, Math.trunc(length)))
  if (
    end > 0 &&
    end < value.length &&
    /[\uD800-\uDBFF]/u.test(value[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(value[end])
  ) {
    end -= 1
  }
  return value.slice(0, end)
}

function projectPageContentToLimit(input, limitBytes, {
  sensitiveFieldsRemoved = false
} = {}) {
  const canonical = canonicalPageContentResult(input)
  const originalBytes = serializedBytes(canonical)
  if (originalBytes <= limitBytes) {
    if (!sensitiveFieldsRemoved) return canonical
    return {
      ...canonical,
      __fanProjection: { sensitiveFieldsRemoved: true }
    }
  }

  const rawStats = canonical.stats
  const originalContent = canonical.content
  const reportedMainStart = Number(rawStats.mainContentStart)
  const overlapChars = Number(rawStats.overlapPrefixChars)
  const mainStart = Number.isSafeInteger(reportedMainStart) && reportedMainStart >= 0
    ? Math.min(originalContent.length, reportedMainStart)
    : Number.isSafeInteger(overlapChars) && overlapChars > 0
      ? Math.min(originalContent.length, overlapChars + 1)
      : 0
  // Overlap is duplicated context. When bytes are scarce, preserve unseen
  // source text and an exact continuation cursor.
  const sourceContent = originalContent.slice(mainStart)
  const sourceStart = pageContentSourceStart(rawStats)
  const sourceEnd = Number(rawStats.charOffsetEnd)
  const boundedSourceEnd = Number.isSafeInteger(sourceEnd) && sourceEnd >= sourceStart
    ? sourceEnd
    : sourceStart + sourceContent.length
  const coreStats = {}
  for (const key of PAGE_CONTENT_CURSOR_STATS) {
    if (Object.prototype.hasOwnProperty.call(rawStats, key)) {
      setEnumerableValue(coreStats, key, rawStats[key])
    }
  }

  const build = prefixLength => {
    const content = safeStringPrefix(sourceContent, prefixLength)
    const contentTruncated = content.length < sourceContent.length
    const nextStartChar = contentTruncated
      ? Math.min(boundedSourceEnd, sourceStart + content.length)
      : rawStats.nextStartChar ?? null
    return {
      format: canonical.format,
      content,
      stats: {
        ...coreStats,
        returnedChars: content.length,
        truncated: contentTruncated || rawStats.truncated === true,
        hasMore: contentTruncated || rawStats.hasMore === true,
        nextStartChar,
        ...(Object.prototype.hasOwnProperty.call(coreStats, 'charOffsetEnd')
          ? { charOffsetEnd: contentTruncated ? nextStartChar : coreStats.charOffsetEnd }
          : {}),
        overlapPrefixChars: 0,
        mainContentStart: 0,
        hostProjected: true,
        hostOriginalReturnedChars: originalContent.length
      },
      __fanProjection: {
        truncated: true,
        reason: 'byte_limit',
        originalBytes: Number.isFinite(originalBytes) ? originalBytes : null,
        limitBytes,
        contentTruncated,
        overlapDroppedChars: mainStart,
        ...(sensitiveFieldsRemoved ? { sensitiveFieldsRemoved: true } : {})
      }
    }
  }

  if (serializedBytes(build(0)) > limitBytes) {
    throw programError(
      'The pageContent pagination envelope exceeds the program result limit',
      'BROWSER_PROGRAM_RESULT_TOO_LARGE',
      { method: 'pageContent', limitBytes },
      500
    )
  }
  let lower = 0
  let upper = sourceContent.length
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (serializedBytes(build(middle)) <= limitBytes) lower = middle
    else upper = middle - 1
  }
  return build(lower)
}

function projectTerminalPageContentToLimit(input, limitBytes) {
  const projected = projectPageContentToLimit(input, limitBytes)
  if (
    Object.prototype.hasOwnProperty.call(projected, '__fanProjection') ||
    !input?.__fanProjection ||
    typeof input.__fanProjection !== 'object' ||
    Array.isArray(input.__fanProjection)
  ) {
    return projected
  }
  const priorProjection = jsonSafe(input.__fanProjection, {
    maxDepth: 4,
    maxEntries: 32,
    maxArray: 16,
    maxString: 512
  }).value
  const candidate = {
    ...projected,
    __fanProjection: priorProjection
  }
  return serializedBytes(candidate) <= limitBytes
    ? candidate
    : projected
}

function canonicalSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input

  const output = {}
  for (const key of SNAPSHOT_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key]
  }

  // Keep exactly one serialized DOM representation. browserUseText is the
  // canonical numbered form consumed by Fan's Python formatter.
  for (const key of ['browserUseText', 'browserUseDomTreeText', 'text', 'domTreeText', 'flatText']) {
    if (typeof input[key] !== 'string' || !input[key]) continue
    output[key] = input[key]
    break
  }
  if (Array.isArray(input.elements)) output.elements = input.elements
  if (
    output.elementsTruncated === undefined &&
    Number(output.omittedInteractiveCount) > 0
  ) {
    output.elementsTruncated = true
  }
  if (
    output.omittedElementCount === undefined &&
    Number(output.omittedInteractiveCount) > 0
  ) {
    output.omittedElementCount = Math.max(0, Number(output.omittedInteractiveCount) || 0)
  }
  return output
}

function compactSnapshotAttributeValue(name, value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  const limit = name === 'href' ? 2000 : name === 'class' ? 160 : 500
  return boundedString(value, limit)
}

function compactSnapshotAttributes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const attributes = {}
  for (const [rawName, value] of Object.entries(input)) {
    const name = String(rawName || '').toLowerCase()
    if (
      !COMPACT_ATTRIBUTE_KEYS.has(name) &&
      !name.startsWith('aria-') &&
      !['data-testid', 'data-test', 'data-qa', 'data-value'].includes(name)
    ) {
      continue
    }
    const compact = compactSnapshotAttributeValue(name, value)
    if (compact !== undefined) attributes[String(rawName).slice(0, 100)] = compact
  }
  return Object.keys(attributes).length ? attributes : undefined
}

function compactSnapshotElement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const index = Number(input.index)
  if (!Number.isSafeInteger(index) || index <= 0) return null

  const element = { index }
  const attributes = compactSnapshotAttributes(input.attributes)
  const id = input.id ?? attributes?.id
  if (id != null && String(id)) element.id = boundedString(id, 500)

  for (const key of COMPACT_ELEMENT_KEYS) {
    const value = input[key]
    if (value === undefined) continue
    if (key === 'autocomplete' || key === 'capabilities') {
      const compact = jsonSafe(value, {
        maxDepth: 4,
        maxEntries: 40,
        maxArray: 20,
        maxString: 500
      }).value
      if (compact !== undefined) element[key] = compact
      continue
    }
    if (typeof value === 'string') {
      const limit = key === 'href' ? 2000 : ['name', 'text', 'label'].includes(key) ? 500 : 300
      element[key] = boundedString(value, limit)
    } else if (
      value == null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      element[key] = value
    }
  }
  if (attributes) element.attributes = attributes
  return element
}

function packCompactSnapshotElements(input, budgetBytes) {
  const source = Array.isArray(input) ? input : []
  const elements = []
  let bytes = 2
  for (const rawElement of source) {
    const element = compactSnapshotElement(rawElement)
    if (!element) continue
    const itemBytes = serializedBytes(element) + (elements.length ? 1 : 0)
    if (bytes + itemBytes > budgetBytes) continue
    elements.push(element)
    bytes += itemBytes
  }
  return {
    elements,
    omittedCount: Math.max(0, source.length - elements.length)
  }
}

function compactSnapshotMetadata(canonical) {
  const metadata = {}
  for (const key of SNAPSHOT_FALLBACK_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(canonical || {}, key)) continue
    const compact = jsonSafe(canonical[key], {
      maxDepth: 6,
      maxEntries: 500,
      maxArray: 100,
      maxString: 4000
    }).value
    if (compact !== undefined) metadata[key] = compact
  }
  return metadata
}

function fitSnapshotText(snapshot, key, text, limitBytes) {
  if (!key || typeof text !== 'string' || !text) return snapshot
  const suffix = '\n…[snapshot truncated]'
  const baseBytes = serializedBytes(snapshot)
  const separatorBytes = Object.keys(snapshot).length ? 1 : 0
  const propertyBytes = serializedBytes(key) + 1
  const availableStringBytes = limitBytes - baseBytes - separatorBytes - propertyBytes
  if (availableStringBytes < 2) return snapshot

  let low = 0
  let high = text.length
  let fitted = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = middle < text.length
      ? `${text.slice(0, middle)}${suffix}`
      : text
    if (serializedBytes(candidate) <= availableStringBytes) {
      fitted = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return fitted ? { ...snapshot, [key]: fitted } : snapshot
}

function projectSnapshotToLimit(input, limitBytes) {
  const canonical = canonicalSnapshot(input)
  const safeOptions = {
    maxDepth: 16,
    maxEntries: 20_000,
    maxArray: 5_000,
    maxString: 256 * 1024
  }
  const projected = projectToLimit(canonical, limitBytes, 'snapshot', safeOptions)
  if (!projected.metadata?.truncated) return projected

  // Large pages still need an actionable in-program view. Give numbered
  // elements and serialized page text independent shares of the same hard byte
  // ceiling so verbose DOM fields or long prose cannot erase every action
  // target. The host keeps the full selector map and reference pins before this
  // projection, so the compact records never invent or rebind an index.
  const sourceElements = Array.isArray(canonical?.elements) ? canonical.elements : []
  const upstreamOmitted = Math.max(0, Number(canonical?.omittedInteractiveCount) || 0)
  const metadata = compactSnapshotMetadata(canonical)
  const omittedHint = count => (
    `The page snapshot was compacted and ${count} structured action elements were omitted from the program snapshot. ` +
    'If the target is absent from snapshot.elements, end this run. In the next turn, use fan.ref(N) from the final outer snapshot directly without calling fan.observe() first.'
  )
  const completeHint = 'The page snapshot was compacted. Every numbered action element remains available through snapshot.elements, although numbered DOM text may be truncated.'
  const pessimistic = {
    ...metadata,
    elements: [],
    truncated: true,
    elementsTruncated: sourceElements.length + upstreamOmitted > 0,
    omittedElementCount: sourceElements.length + upstreamOmitted,
    truncationHint: omittedHint(sourceElements.length + upstreamOmitted)
  }
  const envelopeBytes = serializedBytes(pessimistic)
  const availableBytes = Math.max(0, limitBytes - envelopeBytes - 128)
  const domKey = ['browserUseText', 'browserUseDomTreeText', 'text', 'domTreeText', 'flatText']
    .find(key => typeof canonical?.[key] === 'string' && canonical[key])
  const textBytes = domKey ? serializedBytes(canonical[domKey]) : 0
  const textReserveBytes = domKey
    ? Math.min(textBytes, Math.max(512, Math.floor(availableBytes * 0.35)))
    : 0
  const elementBudgetBytes = Math.max(0, availableBytes - textReserveBytes)
  const packed = packCompactSnapshotElements(sourceElements, elementBudgetBytes)
  const omittedElementCount = packed.omittedCount + upstreamOmitted
  let fallback = {
    ...metadata,
    elements: packed.elements,
    truncated: true,
    elementsTruncated: omittedElementCount > 0,
    omittedElementCount,
    truncationHint: omittedElementCount > 0
      ? omittedHint(omittedElementCount)
      : completeHint
  }
  fallback = fitSnapshotText(fallback, domKey, canonical?.[domKey], limitBytes)
  // Every fallback field above is already a bounded JSON value. Running the
  // generic 20k-entry shape guard a second time would silently cut a packed
  // element array and make omittedElementCount dishonest.
  const safeFallback = fallback
  if (serializedBytes(safeFallback) > limitBytes) {
    // The tiny fixed envelope should only exceed the limit when a host-supplied
    // metadata field is itself abusive. Fail closed to the generic bounded
    // marker instead of violating the configured byte ceiling.
    return projectToLimit({
      url: boundedString(canonical?.url, 2_000),
      title: boundedString(canonical?.title, 500),
      elements: [],
      truncated: true,
      elementsTruncated: sourceElements.length + upstreamOmitted > 0,
      omittedElementCount: sourceElements.length + upstreamOmitted,
      truncationHint: omittedHint(sourceElements.length + upstreamOmitted)
    }, limitBytes, 'snapshot-envelope')
  }
  return {
    value: safeFallback,
    metadata: {
      truncated: true,
      reason: projected.metadata?.reason || 'byte_limit',
      originalBytes: projected.metadata?.originalBytes ?? null,
      limitBytes
    }
  }
}

function stripDecisionToken(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { value: result, token: null }
  }
  const value = { ...result }
  const token = value.__fanDecisionToken
  delete value.__fanDecisionToken
  return {
    value,
    token: token && typeof token === 'object' && !Array.isArray(token) ? token : null
  }
}

function strictObjectOptions(label, value, allowed) {
  if (value == null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw programError(`${label} options must be an object`, 'BROWSER_PROGRAM_INVALID_OPTIONS')
  }
  const options = {}
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw programError(
        `${label} option '${key}' is not allowed`,
        'BROWSER_PROGRAM_OPTION_NOT_ALLOWED',
        { method: label, option: key, allowedOptions: [...allowed] },
        400
      )
    }
    options[key] = item
  }
  return options
}

function normalizeScrollOptions(options) {
  if (!Object.prototype.hasOwnProperty.call(options, 'up')) return options
  if (typeof options.up !== 'boolean') {
    throw programError(
      'scroll option \'up\' must be a boolean',
      'BROWSER_PROGRAM_INVALID_OPTIONS',
      { method: 'scroll', option: 'up', expected: 'boolean' },
      400
    )
  }

  const normalizedDown = !options.up
  if (
    Object.prototype.hasOwnProperty.call(options, 'down') &&
    options.down !== normalizedDown
  ) {
    throw programError(
      'scroll options \'up\' and \'down\' describe conflicting directions',
      'BROWSER_PROGRAM_SCROLL_DIRECTION_CONFLICT',
      {
        method: 'scroll',
        up: options.up,
        down: options.down
      },
      400
    )
  }

  const normalized = { ...options, down: normalizedDown }
  delete normalized.up
  return normalized
}

function normalizeHighlightOptions(value) {
  const options = strictObjectOptions(
    'highlight',
    value,
    OPTION_KEYS.highlight
  )
  if (
    Object.prototype.hasOwnProperty.call(options, 'limit') &&
    (
      !Number.isSafeInteger(options.limit) ||
      options.limit <= 0
    )
  ) {
    throw programError(
      "highlight option 'limit' must be a positive integer",
      'BROWSER_PROGRAM_INVALID_OPTIONS',
      { method: 'highlight', option: 'limit', expected: 'positive integer' },
      400
    )
  }
  if (
    Object.prototype.hasOwnProperty.call(options, 'clear') &&
    typeof options.clear !== 'boolean'
  ) {
    throw programError(
      "highlight option 'clear' must be a boolean",
      'BROWSER_PROGRAM_INVALID_OPTIONS',
      { method: 'highlight', option: 'clear', expected: 'boolean' },
      400
    )
  }
  return options
}

function methodOptions(method, value) {
  const allowed = OPTION_KEYS[method]
  if (!allowed) {
    throw programError(
      `Unknown browser program method: ${method}`,
      'BROWSER_PROGRAM_METHOD_NOT_ALLOWED',
      { method },
      400
    )
  }
  const options = strictObjectOptions(method, value, allowed)
  return method === 'scroll' ? normalizeScrollOptions(options) : options
}

function aliasedOption(options, canonical, legacy, method) {
  const hasCanonical = Object.prototype.hasOwnProperty.call(options, canonical)
  const hasLegacy = Object.prototype.hasOwnProperty.call(options, legacy)
  if (hasCanonical && hasLegacy && !Object.is(options[canonical], options[legacy])) {
    throw programError(
      `${method} options '${canonical}' and '${legacy}' conflict`,
      'BROWSER_PROGRAM_OPTION_ALIAS_CONFLICT',
      { method, option: canonical, alias: legacy },
      400
    )
  }
  return {
    present: hasCanonical || hasLegacy,
    value: hasCanonical ? options[canonical] : options[legacy]
  }
}

function strictBooleanOption(options, canonical, legacy, method) {
  const resolved = aliasedOption(options, canonical, legacy, method)
  if (!resolved.present) return resolved
  if (typeof resolved.value !== 'boolean') {
    throw programError(
      `${method} option '${canonical}' must be a boolean`,
      'BROWSER_PROGRAM_INVALID_OPTIONS',
      { method, option: canonical, expected: 'boolean' },
      400
    )
  }
  return resolved
}

function strictIntegerOption(
  options,
  canonical,
  legacy,
  method,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}
) {
  const resolved = aliasedOption(options, canonical, legacy, method)
  if (!resolved.present) return resolved
  if (
    typeof resolved.value !== 'number' ||
    !Number.isSafeInteger(resolved.value) ||
    resolved.value < minimum ||
    resolved.value > maximum
  ) {
    throw programError(
      `${method} option '${canonical}' must be an integer from ${minimum} to ${maximum}`,
      'BROWSER_PROGRAM_INVALID_OPTIONS',
      { method, option: canonical, expected: 'integer', minimum, maximum },
      400
    )
  }
  return resolved
}

function normalizePageContentOptions(value) {
  const options = methodOptions('pageContent', value)
  const normalized = {}
  if (Object.prototype.hasOwnProperty.call(options, 'format')) {
    const format = typeof options.format === 'string'
      ? options.format.toLowerCase()
      : ''
    if (
      typeof options.format !== 'string' ||
      !['markdown', 'html', 'text'].includes(format)
    ) {
      throw programError(
        "pageContent option 'format' must be 'markdown', 'html', or 'text'",
        'BROWSER_PROGRAM_INVALID_OPTIONS',
        {
          method: 'pageContent',
          option: 'format',
          expected: ['markdown', 'html', 'text']
        },
        400
      )
    }
    normalized.format = format
  }
  for (const [canonical, legacy] of [
    ['extractLinks', 'extract_links'],
    ['extractImages', 'extract_images']
  ]) {
    const resolved = strictBooleanOption(
      options,
      canonical,
      legacy,
      'pageContent'
    )
    if (resolved.present) normalized[canonical] = resolved.value
  }
  for (const [canonical, legacy, minimum, maximum] of [
    ['startFromChar', 'start_from_char', 0, Number.MAX_SAFE_INTEGER],
    ['maxChars', 'max_chars', 1, PAGE_CONTENT_MAX_CHARS],
    ['overlapLines', 'overlap_lines', 0, 50]
  ]) {
    const resolved = strictIntegerOption(
      options,
      canonical,
      legacy,
      'pageContent',
      { minimum, maximum }
    )
    if (resolved.present) normalized[canonical] = resolved.value
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'maxChars')) {
    normalized.maxChars = PAGE_CONTENT_MAX_CHARS
  }
  return normalized
}

function elementStateExpectation(value) {
  const expected = strictObjectOptions(
    'waitForState.state',
    value,
    new Set(['attached', 'enabled'])
  )
  if (!Object.keys(expected).length) {
    throw programError(
      'waitForState.state must contain attached or enabled',
      'BROWSER_ELEMENT_STATE_INVALID'
    )
  }
  for (const [key, item] of Object.entries(expected)) {
    if (typeof item !== 'boolean') {
      throw programError(
        `waitForState.state ${key} must be a boolean`,
        'BROWSER_ELEMENT_STATE_INVALID'
      )
    }
  }
  if (expected.attached === false && Object.prototype.hasOwnProperty.call(expected, 'enabled')) {
    throw programError(
      'waitForState cannot test enabled on a detached element',
      'BROWSER_ELEMENT_STATE_INVALID'
    )
  }
  return expected
}

function referencePinsFromSnapshot(snapshot) {
  const pins = new Map()
  for (const element of Array.isArray(snapshot?.elements) ? snapshot.elements : []) {
    const index = Number(element?.index)
    const backendNodeId = Number(element?.backendNodeId)
    if (!Number.isSafeInteger(index) || index <= 0 || !Number.isFinite(backendNodeId)) continue
    pins.set(index, Object.freeze({
      index,
      backendNodeId,
      sessionId: element?.sessionId == null || element.sessionId === ''
        ? null
        : String(element.sessionId)
    }))
  }
  return pins
}

function samePinnedIdentity(element, identity) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) return false
  return (
    Number(element.backendNodeId) === Number(identity?.backendNodeId) &&
    String(element.sessionId || '') === String(identity?.sessionId || '')
  )
}

function safeOutputResult(input) {
  let removed = false
  const seen = new WeakSet()

  const visit = (value, key = '', depth = 0) => {
    if (value == null || typeof value !== 'object') {
      if (
        typeof value === 'string' &&
        (
          BINARY_RESULT_KEYS.has(key) ||
          (key === 'data' && value.length > 1024)
        )
      ) {
        removed = true
        return undefined
      }
      return value
    }
    if (depth >= 12 || seen.has(value)) {
      removed = true
      return '[truncated]'
    }
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        return value.map(item => visit(item, '', depth + 1))
      }
      const result = {}
      for (const [childKey, item] of Object.entries(value)) {
        if (
          childKey === '__fanDecisionToken' ||
          childKey === 'observation' ||
          BINARY_RESULT_KEYS.has(childKey)
        ) {
          removed = true
          continue
        }
        const projected = visit(item, childKey, depth + 1)
        if (projected !== undefined) result[childKey] = projected
      }
      return result
    } finally {
      seen.delete(value)
    }
  }

  return { value: visit(input), removed }
}

function safeDownloadName(value, label) {
  const name = String(value || '').trim()
  if (!name) return ''
  if (path.isAbsolute(name) || /[\\/]/.test(name) || name === '.' || name === '..') {
    throw programError(
      `${label} must be a filename, not a path`,
      'BROWSER_PROGRAM_FILE_PATH_NOT_ALLOWED',
      { option: label },
      400
    )
  }
  return name
}

function screenshotFormatFromFileName(fileName) {
  switch (path.extname(String(fileName || '')).toLowerCase()) {
    case '.png':
      return 'png'
    case '.jpg':
    case '.jpeg':
      return 'jpeg'
    case '.webp':
      return 'webp'
    default:
      return ''
  }
}

function activeUrl(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const direct = String(value.url || value.currentUrl || value.current_url || '').trim()
  if (direct) return direct
  if (!Array.isArray(value.tabs)) return ''
  const active = value.tabs.find(tab => tab && typeof tab === 'object' && tab.current)
  return String(active?.url || '').trim()
}

function embeddedSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const nested = value.snapshot
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested
    : value
}

function safeCaptchaMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const output = {}
  for (const key of ['detected', 'requiresUserInput']) {
    if (typeof value[key] === 'boolean') output[key] = value[key]
  }
  for (const [key, limit] of [
    ['kind', 80],
    ['challengeId', 300],
    ['url', 2_000],
    ['title', 500]
  ]) {
    if (value[key] != null) output[key] = boundedString(value[key], limit)
  }
  for (const key of ['challengeStartedDocumentRevision', 'documentRevision']) {
    const revision = Number(value[key])
    if (Number.isFinite(revision)) output[key] = revision
  }
  return Object.keys(output).length ? output : undefined
}

function safeInterventionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const output = {}
  for (const [key, limit] of [
    ['kind', 80],
    ['inputKind', 80],
    ['sessionId', 300],
    ['workbenchId', 300],
    ['currentTabId', 300],
    ['anchorTabId', 300],
    ['agentAnchorTabId', 300],
    ['userTabId', 300],
    ['interventionId', 300],
    ['eventId', 300],
    ['eventType', 80],
    ['targetSessionId', 300]
  ]) {
    if (value[key] != null) output[key] = boundedString(value[key], limit)
  }
  for (const key of ['timestamp', 'updatedAt', 'pageTimestamp']) {
    const timestamp = Number(value[key])
    if (Number.isFinite(timestamp)) output[key] = timestamp
  }
  return Object.keys(output).length ? output : undefined
}

// A needs_human response must retain enough challenge identity for the Python
// verification prompt without exposing the DOM, numbered controls, or captcha
// match text. Keep this as an explicit allowlist rather than projecting the
// whole observation into the terminal envelope.
function safeHumanMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const snapshot = embeddedSnapshot(value)
  const metadata = {}
  const captcha = safeCaptchaMetadata(
    value.captchaState ||
    value.captcha ||
    snapshot?.captchaState ||
    snapshot?.captcha
  )
  if (captcha) metadata.captchaState = captcha

  const interventionPending = typeof value.interventionPending === 'boolean'
    ? value.interventionPending
    : snapshot?.interventionPending
  if (typeof interventionPending === 'boolean') {
    metadata.interventionPending = interventionPending
  }
  const interventionMeta = safeInterventionMetadata(
    value.interventionMeta ||
    snapshot?.interventionMeta
  )
  if (interventionMeta) metadata.interventionMeta = interventionMeta

  const url = value.url || snapshot?.url || captcha?.url
  const title = value.title || snapshot?.title || captcha?.title
  if (url != null) metadata.url = boundedString(url, 2_000)
  if (title != null) metadata.title = boundedString(title, 500)

  for (const key of ['documentRevision', 'document_revision']) {
    const raw = value[key] ?? snapshot?.[key]
    const revision = Number(raw)
    if (Number.isFinite(revision)) metadata[key] = revision
  }
  if (metadata.documentRevision == null && captcha?.documentRevision != null) {
    metadata.documentRevision = captcha.documentRevision
  }
  return metadata
}

function humanBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const snapshot = embeddedSnapshot(value)
  const captcha = (
    value.captchaState ||
    value.captcha ||
    snapshot?.captchaState ||
    snapshot?.captcha
  )
  const blocked = value.blocked || snapshot?.blocked
  const interventionPending = (
    value.interventionPending === true ||
    snapshot?.interventionPending === true
  )
  const verificationRequired = (
    captcha?.detected === true &&
    captcha?.requiresUserInput !== false
  )
  if (
    interventionPending ||
    blocked === 'human-intervention' ||
    blocked === 'human-verification' ||
    verificationRequired
  ) {
    const verification = blocked === 'human-verification' || verificationRequired
    return {
      status: 'needs_human',
      reason: verification
        ? 'The page requires human verification'
        : 'Human control is required',
      code: verification
        ? 'BROWSER_HUMAN_VERIFICATION_REQUIRED'
        : 'BROWSER_PROGRAM_USER_INTERVENED',
      humanMetadata: safeHumanMetadata(value)
    }
  }
  return null
}

function replanBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = String(value.status || value.execution_state || '').toLowerCase()
  if (
    value.replanRequired === true ||
    value.replan_required === true ||
    status === 'replan-required' ||
    status === 'needs_replan'
  ) {
    return {
      status: 'needs_replan',
      reason: boundedString(value.reason || value.error || 'The browser state changed; inspect the final snapshot and decide again'),
      code: boundedString(value.code || 'BROWSER_REPLAN_REQUIRED', 120)
    }
  }
  return null
}

function unknownResultBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = String(value.status || value.execution_state || '').toLowerCase()
  if (
    status === 'unknown' ||
    status === 'unknown_after_effect' ||
    value.doNotRetry === true ||
    value.do_not_retry === true
  ) {
    return {
      reason: boundedString(value.reason || value.error || 'The action may have produced an effect and must not be replayed'),
      code: boundedString(value.code || 'BROWSER_ACTION_STATUS_UNKNOWN', 120)
    }
  }
  return null
}

function enforceTypeVerificationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const readback = value.readback
  if (!readback || typeof readback !== 'object' || Array.isArray(readback)) return value
  if (readback.skipped === true) {
    return {
      ...value,
      status: 'unknown_after_effect',
      doNotRetry: true,
      code: 'TYPE_READBACK_UNAVAILABLE',
      reason: 'The browser sent text but could not verify the resulting value.'
    }
  }
  if (readback.valueMatches === false) {
    return {
      ...value,
      status: 'needs_replan',
      replanRequired: true,
      code: 'TYPE_READBACK_MISMATCH',
      reason: 'The browser value did not match the requested text; inspect the final snapshot before continuing.'
    }
  }
  return value
}

function errorIsHuman(error) {
  const code = String(error?.code || '')
  const reason = String(error?.details?.reason || '')
  return HUMAN_ERROR_CODES.has(code) || reason === 'human-intervention'
}

function errorNeedsReplan(error) {
  if (errorIsHuman(error)) return false
  if (
    error?.code === 'BROWSER_PRIVATE_URL_BLOCKED' ||
    error?.code === 'BROWSER_OBSERVATION_URL_UNVERIFIED'
  ) return false
  return error?.details?.replanRequired === true || error?.details?.replan_required === true
}

function errorHasUnknownEffect(error, method) {
  if (!EFFECTFUL_METHODS.has(method)) return false
  const details = error?.details || {}
  // Explicit dispatch provenance is stronger than a generic timeout/status
  // code. A host that proves it failed before dispatch must not be promoted to
  // unknown_after_effect merely because the outer action timer also expired.
  if (details.beforeDispatch === true && details.dispatchAttempted === false) return false
  if (details.dispatchAttempted === true && details.beforeDispatch !== true) return true
  if (UNKNOWN_EFFECT_ERROR_CODES.has(String(error?.code || ''))) return true
  return false
}

function compactTraceResult(method, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result == null ? undefined : boundedString(result, 300)
  }
  const summary = {}
  for (const key of [
    'status', 'ok', 'searched', 'navigated', 'clicked', 'typed', 'selected',
    'focused', 'hovered', 'highlighted', 'cleared',
    'dragged', 'uploaded', 'waited', 'settled', 'matched',
    'elapsedMs',
    'closed', 'switched', 'created', 'requestedUrl', 'finalUrl', 'url', 'title', 'effect',
    'completedCount', 'replanRequired', 'interventionPending', 'blocked'
  ]) {
    if (result[key] == null) continue
    const value = result[key]
    summary[key] = typeof value === 'string' ? value.slice(0, 300) : value
  }
  if (method === 'observe' && Array.isArray(result.elements)) {
    summary.elementCount = result.elements.length
  }
  if (method === 'select') {
    for (const key of ['value', 'text', 'type']) {
      if (result[key] == null) continue
      const value = result[key]
      summary[key] = typeof value === 'string' ? value.slice(0, 300) : value
    }
  }
  if (method === 'waitForState' && result.state && typeof result.state === 'object') {
    summary.state = {}
    for (const key of ['attached', 'enabled', 'disabled']) {
      if (typeof result.state[key] === 'boolean') summary.state[key] = result.state[key]
    }
  }
  if (method === 'click' && result.openedTab && typeof result.openedTab === 'object') {
    const openedTab = {}
    for (const key of ['stableId', 'tabId', 'url', 'title', 'current']) {
      if (result.openedTab[key] == null) continue
      const value = result.openedTab[key]
      openedTab[key] = typeof value === 'string' ? value.slice(0, 500) : value
    }
    if (Object.keys(openedTab).length) summary.openedTab = openedTab
  }
  return Object.keys(summary).length ? summary : undefined
}

class ProgramRunner {
  constructor({
    executeStep,
    runtime = null,
    eventBus = runtime?.eventBus || null,
    workerPath = path.join(__dirname, 'program-worker.cjs'),
    log,
    assertSnapshotAllowed = null,
    protectedFileRoots = null,
    codeLimitBytes = DEFAULT_CODE_LIMIT_BYTES,
    maxSteps = DEFAULT_STEP_LIMIT,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    valueLimitBytes = DEFAULT_VALUE_LIMIT_BYTES,
    snapshotLimitBytes = DEFAULT_SNAPSHOT_LIMIT_BYTES,
    requestLimitBytes = DEFAULT_REQUEST_LIMIT_BYTES,
    consoleLimit = DEFAULT_CONSOLE_LIMIT,
    consoleBytes = DEFAULT_CONSOLE_BYTES,
    workerResourceLimits = DEFAULT_WORKER_RESOURCE_LIMITS
  } = {}) {
    if (typeof executeStep !== 'function') throw new TypeError('executeStep is required')
    this.executeStep = executeStep
    this.runtime = runtime
    this.eventBus = eventBus
    this.workerPath = workerPath
    this.log = typeof log === 'function' ? log : () => undefined
    this.assertSnapshotAllowed = typeof assertSnapshotAllowed === 'function'
      ? assertSnapshotAllowed
      : null
    this.protectedFileRoots = Array.isArray(protectedFileRoots)
      ? protectedFileRoots.filter(Boolean).map(String)
      : [process.env.FAN_HOME].filter(Boolean).map(String)
    this.codeLimitBytes = positiveInteger(codeLimitBytes, DEFAULT_CODE_LIMIT_BYTES)
    this.maxSteps = positiveInteger(maxSteps, DEFAULT_STEP_LIMIT, DEFAULT_STEP_LIMIT)
    this.defaultTimeoutMs = positiveInteger(defaultTimeoutMs, DEFAULT_TIMEOUT_MS)
    this.maxTimeoutMs = positiveInteger(maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS)
    this.valueLimitBytes = positiveInteger(valueLimitBytes, DEFAULT_VALUE_LIMIT_BYTES)
    this.snapshotLimitBytes = positiveInteger(snapshotLimitBytes, DEFAULT_SNAPSHOT_LIMIT_BYTES)
    this.requestLimitBytes = positiveInteger(requestLimitBytes, DEFAULT_REQUEST_LIMIT_BYTES)
    this.consoleLimit = positiveInteger(consoleLimit, DEFAULT_CONSOLE_LIMIT)
    this.consoleBytes = positiveInteger(consoleBytes, DEFAULT_CONSOLE_BYTES)
    this.workerResourceLimits = {
      maxOldGenerationSizeMb: positiveInteger(
        workerResourceLimits?.maxOldGenerationSizeMb,
        DEFAULT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb
      ),
      maxYoungGenerationSizeMb: positiveInteger(
        workerResourceLimits?.maxYoungGenerationSizeMb,
        DEFAULT_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb
      ),
      stackSizeMb: positiveInteger(
        workerResourceLimits?.stackSizeMb,
        DEFAULT_WORKER_RESOURCE_LIMITS.stackSizeMb
      )
    }
    this.activeRuns = new Map()
    this.closed = false
    this._offIntervention = this.eventBus?.on?.(EVENT_TYPES.USER_INTERVENED, event => {
      this._handleIntervention(event)
    }) || null
    this._offControlState = this.eventBus?.on?.(EVENT_TYPES.CONTROL_STATE, event => {
      const payload = event?.payload || {}
      if (payload.active !== false) return
      const sessionId = payload.sessionId || payload.id || payload.workbenchId
      if (!sessionId) return
      this.stop(canonicalSessionId(sessionId), {
        status: 'failed',
        reason: 'Browser Agent control ended while the program was running',
        code: 'BROWSER_PROGRAM_CONTROL_ENDED'
      })
    }) || null
  }

  async run({
    sessionId = 'main',
    runId = crypto.randomUUID(),
    code = '',
    timeoutMs = this.defaultTimeoutMs,
    lease = null,
    initialDecisionToken = null,
    initialSnapshot = null,
    visualEvidenceRef = null,
    protectedValues = null
  } = {}) {
    if (this.closed) {
      throw programError('Browser program runner is closed', 'BROWSER_PROGRAM_RUNNER_CLOSED', undefined, 503)
    }
    const session = canonicalSessionId(sessionId)
    const id = String(runId || crypto.randomUUID())
    const source = String(code || '')
    const codeBytes = Buffer.byteLength(source, 'utf8')
    if (codeBytes > this.codeLimitBytes) {
      throw programError(
        `Browser program is ${codeBytes} bytes; the limit is ${this.codeLimitBytes} bytes`,
        'BROWSER_PROGRAM_CODE_TOO_LARGE',
        { codeBytes, limitBytes: this.codeLimitBytes },
        413
      )
    }
    if (this.activeRuns.has(session)) {
      throw programError(
        `A browser program is already running for session '${session}'`,
        'BROWSER_PROGRAM_ALREADY_RUNNING',
        { sessionId: session },
        409
      )
    }

    const timeout = Math.max(100, Math.min(
      this.maxTimeoutMs,
      positiveInteger(timeoutMs, this.defaultTimeoutMs, this.maxTimeoutMs)
    ))
    const initialObservationId = `${id}:observation:0`
    let initialReferencePins = new Map()
    if (
      initialDecisionToken &&
      typeof initialDecisionToken === 'object' &&
      !Array.isArray(initialDecisionToken) &&
      typeof this.runtime?._captureProgramReferencePins === 'function'
    ) {
      try {
        initialReferencePins = this.runtime._captureProgramReferencePins(
          session,
          initialDecisionToken
        )
      } catch (error) {
        // A navigation-only program is allowed to recover from a stale DOM
        // generation. Keep the ordinary decision token contract intact and
        // simply withhold pins: any later waitForState on that stale outer
        // observation will fail closed before host dispatch.
        if (!errorNeedsReplan(error)) throw error
      }
    }
    const initialSnapshotProjection = initialSnapshot == null
      ? null
      : projectSnapshotToLimit(initialSnapshot, this.snapshotLimitBytes).value
    const normalizedProtectedValues = normalizeProtectedValues(protectedValues)
    let resolveTerminal
    const terminalPromise = new Promise(resolve => { resolveTerminal = resolve })
    const state = {
      sessionId: session,
      runId: id,
      code: source,
      lease,
      visualEvidenceRef: typeof visualEvidenceRef === 'string' ? visualEvidenceRef : '',
      protectedValues: normalizedProtectedValues,
      protectedRedactions: protectedValueRedactions(normalizedProtectedValues),
      worker: null,
      workerReportedCompletion: null,
      pending: new Map(),
      requestTail: Promise.resolve(),
      observations: new Map(),
      observationPins: new Map(),
      nextObservation: 1,
      nextStep: 0,
      trace: [],
      effects: new Set(),
      effectSeen: false,
      uncertainEffect: false,
      effectAdmissionClosed: false,
      interventionMeta: null,
      latestSnapshot: initialSnapshotProjection,
      latestDecisionToken: initialDecisionToken &&
        typeof initialDecisionToken === 'object' &&
        !Array.isArray(initialDecisionToken)
        ? initialDecisionToken
        : null,
      consoleCount: 0,
      consoleBytes: 0,
      terminal: null,
      resolveTerminal,
      terminalPromise,
      timeoutTimer: null,
      terminationPromise: Promise.resolve()
    }
    if (initialDecisionToken && typeof initialDecisionToken === 'object' && !Array.isArray(initialDecisionToken)) {
      state.observations.set(initialObservationId, initialDecisionToken)
      state.observationPins.set(initialObservationId, initialReferencePins)
    }
    this.activeRuns.set(session, state)

    try {
      state.worker = new Worker(this.workerPath, {
        workerData: {
          code: source,
          initialObservationId
        },
        resourceLimits: this.workerResourceLimits
      })
      state.worker.on('message', message => this._handleWorkerMessage(state, message))
      state.worker.on('error', error => {
        this._setTerminal(state, { kind: 'failed', error })
      })
      state.worker.on('exit', exitCode => {
        if (!state.terminal && !state.workerReportedCompletion) {
          const error = programError(
            `Browser program Worker exited before producing a result (exit ${exitCode})`,
            'BROWSER_PROGRAM_WORKER_EXITED',
            { exitCode },
            500
          )
          this._setTerminal(state, { kind: 'failed', error })
        }
      })
      state.timeoutTimer = setTimeout(() => {
        const pendingEffect = [...state.pending.values()].some(step => EFFECTFUL_METHODS.has(step.method))
        if (pendingEffect) state.uncertainEffect = true
        const error = programError(
          `Browser program timed out after ${timeout}ms`,
          'BROWSER_PROGRAM_TIMEOUT',
          {
            timeoutMs: timeout,
            pendingEffect,
            dispatchAttempted: pendingEffect || undefined
          },
          408
        )
        // A final observe would enter the same lease behind the still-pending
        // request and defeat this hard timeout. Recovery takes a separate
        // programSnapshot only after the RPC settlement fence opens.
        this._setTerminal(state, {
          kind: 'failed',
          error,
          skipFinalSnapshot: state.pending.size > 0
        })
      }, timeout)

      const terminal = await state.terminalPromise
      await state.terminationPromise.catch(() => undefined)
      const final = terminal.kind === 'needs_human' || terminal.skipFinalSnapshot
        ? {
            snapshot: null,
            projection: null,
            decisionToken: null,
            error: null
          }
        : await this._captureFinalSnapshot(state)
      const output = this._buildOutput(state, terminal, final)
      return output
    } finally {
      if (state.timeoutTimer) clearTimeout(state.timeoutTimer)
      if (this.activeRuns.get(session) === state) this.activeRuns.delete(session)
      state.protectedValues.clear()
      state.protectedRedactions.length = 0
      if (state.worker && !state.terminal) {
        await state.worker.terminate().catch(() => undefined)
      }
    }
  }

  interventionBoundaryResult(result, {
    runId = crypto.randomUUID(),
    humanMetadata = null,
    source = 'control-lease'
  } = {}) {
    const output = result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : {
          runId: String(runId || crypto.randomUUID()),
          trace: [],
          effect: {
            occurred: false,
            uncertain: false,
            kinds: []
          }
        }
    const metadata = safeHumanMetadata(humanMetadata)

    // The activeRuns listener already authored the canonical human boundary.
    // Keep that exact result and only fill any metadata that the control-lease
    // latch learned after the event was published.
    if (String(output.status || '') === 'needs_human') {
      Object.assign(output, metadata)
      output.interventionPending = true
      return output
    }

    const priorStatus = boundedString(output.status || 'unknown', 80)
    const priorErrorSource = output.error ?? output.finalSnapshotError
    const priorError = priorErrorSource == null
      ? null
      : safeError(priorErrorSource)

    // A value, candidate set, or final snapshot produced before the user input
    // is no longer authoritative. Preserve trace/effect provenance, but make the
    // fresh post-handoff snapshot the only state available for the next decision.
    output.runId = String(output.runId || runId || crypto.randomUUID())
    output.status = 'needs_human'
    output.value = null
    output.finalSnapshot = null
    delete output.valueProjection
    delete output.finalSnapshotProjection
    delete output.finalSnapshotError
    delete output.candidates
    Object.assign(output, metadata)
    output.interventionPending = true
    output.error = {
      name: 'Error',
      code: 'BROWSER_PROGRAM_USER_INTERVENED',
      message: 'The user took control of the browser',
      details: {
        reason: 'human-intervention',
        source: boundedString(source, 120),
        priorStatus
      },
      ...(priorError ? { cause: priorError } : {})
    }
    return output
  }

  stop(sessionId, {
    status = 'needs_human',
    reason = 'Browser control was handed to the user',
    code = 'BROWSER_PROGRAM_HANDOFF',
    humanMetadata = null
  } = {}) {
    const session = canonicalSessionId(sessionId)
    const state = this.activeRuns.get(session)
    if (!state) return false
    const pendingEffect = [...state.pending.values()]
      .some(step => EFFECTFUL_METHODS.has(step.method))
    if (pendingEffect) state.uncertainEffect = true
    state.effectAdmissionClosed = true
    if (humanMetadata && typeof humanMetadata === 'object' && !Array.isArray(humanMetadata)) {
      state.interventionMeta = safeInterventionMetadata(humanMetadata.interventionMeta)
        ? humanMetadata
        : { interventionMeta: safeInterventionMetadata(humanMetadata) }
    }
    const interventionId = state.interventionMeta?.interventionMeta?.interventionId
    if (interventionId) {
      this.log(
        `[browser-takeover:${interventionId}] program.stop_requested ` +
        `session=${session} pending=${state.pending.size} pendingEffect=${pendingEffect}`
      )
    }
    if (status === 'needs_human') {
      this._setTerminal(state, {
        kind: 'needs_human',
        reason: boundedString(reason),
        code: boundedString(code, 120),
        humanMetadata: state.interventionMeta || undefined,
        skipFinalSnapshot: true
      })
    } else {
      const error = programError(
        String(reason || 'Browser program stopped'),
        String(code || 'BROWSER_PROGRAM_STOPPED'),
        undefined,
        409
      )
      this._setTerminal(state, {
        kind: 'failed',
        error,
        skipFinalSnapshot: true
      })
    }
    return true
  }

  stopAll(options = {}) {
    let stopped = 0
    for (const sessionId of [...this.activeRuns.keys()]) {
      if (this.stop(sessionId, options)) stopped += 1
    }
    return stopped
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.stopAll({
      status: 'failed',
      reason: 'Browser program runner closed',
      code: 'BROWSER_PROGRAM_RUNNER_CLOSED'
    })
    if (this._offIntervention) {
      try {
        this._offIntervention()
      } catch {
        // Event cleanup must not block runtime shutdown.
      }
      this._offIntervention = null
    }
    if (this._offControlState) {
      try {
        this._offControlState()
      } catch {
        // Event cleanup must not block runtime shutdown.
      }
      this._offControlState = null
    }
  }

  _handleIntervention(event) {
    const payload = event?.payload || {}
    const rawSession = payload.sessionId || payload.id || payload.workbenchId
    const humanMetadata = {
      interventionPending: true,
      interventionMeta: safeInterventionMetadata(payload)
    }
    const interventionId = humanMetadata.interventionMeta?.interventionId || 'unknown'
    this.log(
      `[browser-takeover:${interventionId}] program-admission-closed ` +
      `session=${rawSession ? canonicalSessionId(rawSession) : '*'} ` +
      `input=${humanMetadata.interventionMeta?.inputKind || 'unknown'}`
    )
    if (!rawSession) {
      this.stopAll({
        status: 'needs_human',
        reason: 'The user took control of the browser',
        code: 'BROWSER_PROGRAM_USER_INTERVENED',
        humanMetadata
      })
      return
    }
    this.stop(canonicalSessionId(rawSession), {
      status: 'needs_human',
      reason: 'The user took control of the browser',
      code: 'BROWSER_PROGRAM_USER_INTERVENED',
      humanMetadata
    })
  }

  _handleWorkerMessage(state, message) {
    if (!message || typeof message !== 'object' || state.terminal) return
    if (message.type === 'request') {
      const requestBytes = serializedBytes(message)
      if (requestBytes > this.requestLimitBytes) {
        const error = programError(
          `Browser program request is ${requestBytes} bytes; the limit is ${this.requestLimitBytes} bytes`,
          'BROWSER_PROGRAM_REQUEST_TOO_LARGE',
          { requestBytes, limitBytes: this.requestLimitBytes },
          413
        )
        this._setTerminal(state, { kind: 'failed', error })
        return
      }
      // Worker code may start several fan actions without awaiting them. Keep
      // host admission strictly ordered so a needs_replan/needs_human/unknown
      // result from one step prevents every later request from being
      // dispatched, rather than merely placing all of them in the lease queue.
      state.requestTail = state.requestTail
        .then(() => {
          if (state.terminal) return undefined
          return this._handleRequest(state, message)
        })
        .catch(error => {
          if (!state.terminal) {
            this._setTerminal(state, { kind: 'failed', error })
          }
        })
      return
    }
    if (message.type === 'log') {
      const level = String(message.level || 'log')
      const values = redactProtectedValues(
        Array.isArray(message.values) ? message.values : [],
        state.protectedRedactions
      )
      const logBytes = serializedBytes(values)
      state.consoleCount += 1
      state.consoleBytes += Number.isFinite(logBytes) ? logBytes : this.consoleBytes + 1
      if (state.consoleCount > this.consoleLimit || state.consoleBytes > this.consoleBytes) {
        const error = programError(
          'Browser program console output exceeded its host limit',
          'BROWSER_PROGRAM_CONSOLE_LIMIT',
          {
            count: state.consoleCount,
            bytes: state.consoleBytes,
            countLimit: this.consoleLimit,
            byteLimit: this.consoleBytes
          },
          413
        )
        this._setTerminal(state, { kind: 'failed', error })
        return
      }
      const projected = projectToLimit(values, 8 * 1024, 'console')
      this.log(`[browser-program:${state.runId}:${level}] ${JSON.stringify(projected.value)}`)
      return
    }
    if (message.type === 'completed') {
      state.workerReportedCompletion = { kind: 'completed', value: message.value }
      this._finishReportedCompletionIfDrained(state)
      return
    }
    if (message.type === 'boundary') {
      const needsHuman = message.status === 'needs_human'
      this._setTerminal(state, {
        kind: needsHuman ? 'needs_human' : 'needs_replan',
        reason: boundedString(message.reason || 'A fresh model decision is required'),
        code: boundedString(message.code || (
          needsHuman
            ? 'BROWSER_HUMAN_VERIFICATION_REQUIRED'
            : 'BROWSER_REPLAN_REQUIRED'
        ), 120),
        candidates: Array.isArray(message.candidates) ? message.candidates.slice(0, 8) : [],
        ...(needsHuman ? { skipFinalSnapshot: true } : {})
      })
      return
    }
    if (message.type === 'failed') {
      const code = String(message.error?.code || 'BROWSER_PROGRAM_FAILED')
      if (
        code === 'BROWSER_PROGRAM_SCOPE_RESET' &&
        !state.effectSeen &&
        !state.uncertainEffect &&
        state.pending.size === 0
      ) {
        this._setTerminal(state, {
          kind: 'needs_replan',
          reason: boundedString(
            message.error?.message ||
            'The browser_run scope was reset; declare the current snapshot in this run.'
          ),
          code
        })
        return
      }
      const error = programError(
        String(message.error?.message || 'Browser program failed'),
        code,
        message.error?.details,
        500
      )
      if (message.error?.name) error.name = String(message.error.name)
      this._setTerminal(state, { kind: 'failed', error })
    }
  }

  async _handleRequest(state, message) {
    if (state.terminal) return
    const requestId = String(message.requestId || '')
    const method = String(message.method || '')
    const args = Array.isArray(message.args) ? message.args : []
    const stepNumber = ++state.nextStep
    const trace = {
      step: stepNumber,
      actionId: `${state.runId}:${stepNumber}`,
      method,
      status: 'running',
      startedAt: Date.now()
    }
    state.trace.push(trace)
    state.pending.set(requestId, { method, stepNumber, trace })

    if (stepNumber > this.maxSteps) {
      trace.status = 'failed'
      trace.finishedAt = Date.now()
      trace.durationMs = trace.finishedAt - trace.startedAt
      trace.error = {
        code: 'BROWSER_PROGRAM_STEP_LIMIT',
        message: `Browser program exceeded ${this.maxSteps} steps`
      }
      const error = programError(
        `Browser program exceeded ${this.maxSteps} steps`,
        'BROWSER_PROGRAM_STEP_LIMIT',
        { stepLimit: this.maxSteps },
        413
      )
      state.pending.delete(requestId)
      this._setTerminal(state, { kind: 'failed', error })
      return
    }

    try {
      const mapped = await this._mapRequest(state, method, args, stepNumber)
      if (state.effectAdmissionClosed || state.terminal) {
        trace.status = 'stopped'
        trace.result = { blocked: 'human-intervention' }
        return
      }
      const result = await this._executeMapped(state, mapped, trace.actionId, method)
      trace.status = 'completed'
      trace.effect = boundedString(result?.effect || mapped.effect || 'none', 80)
      const summary = redactProtectedValues(
        compactTraceResult(method, result),
        state.protectedRedactions
      )
      if (summary !== undefined) trace.result = summary

      const human = humanBoundary(result)
      if (human) {
        state.effectAdmissionClosed = true
        state.interventionMeta = human.humanMetadata || null
        this._setTerminal(state, {
          kind: 'needs_human',
          ...human,
          skipFinalSnapshot: true
        })
        return
      }
      const unknown = unknownResultBoundary(result)
      if (unknown) {
        state.uncertainEffect = true
        const error = programError(unknown.reason, unknown.code, {
          dispatchAttempted: true
        }, 409)
        this._setTerminal(state, { kind: 'failed', error })
        return
      }
      const replan = replanBoundary(result)
      if (replan) {
        this._setTerminal(state, { kind: 'needs_replan', ...replan })
        return
      }

      const response = await this._prepareWorkerResponse(state, method, result)
      if (!state.terminal) {
        state.worker.postMessage({
          type: 'response',
          requestId,
          ok: true,
          result: response
        })
      }
    } catch (error) {
      trace.status = 'failed'
      trace.error = redactProtectedValues(
        safeError(error),
        state.protectedRedactions
      )
      const knownEffect = String(error?.details?.effect || '').trim().toLowerCase()
      if (knownEffect && knownEffect !== 'none') {
        state.effectSeen = true
        state.effects.add(knownEffect)
      }
      const unknownEffect = errorHasUnknownEffect(error, method)
      if (unknownEffect) {
        state.uncertainEffect = true
        this._setTerminal(state, { kind: 'failed', error })
      } else if (
        error?.code === 'BROWSER_PRIVATE_URL_BLOCKED' ||
        error?.code === 'BROWSER_OBSERVATION_URL_UNVERIFIED'
      ) {
        this._setTerminal(state, { kind: 'failed', error })
      } else if (errorIsHuman(error)) {
        const humanMetadata = {
          interventionPending: true,
          interventionMeta: safeInterventionMetadata(error?.details?.interventionMeta)
        }
        state.effectAdmissionClosed = true
        state.interventionMeta = humanMetadata
        this._setTerminal(state, {
          kind: 'needs_human',
          reason: boundedString(error.message),
          code: boundedString(error.code || 'BROWSER_PROGRAM_USER_INTERVENED', 120),
          humanMetadata,
          skipFinalSnapshot: true
        })
      } else if (errorNeedsReplan(error)) {
        this._setTerminal(state, {
          kind: 'needs_replan',
          reason: boundedString(error.message),
          code: boundedString(error.code || 'BROWSER_REPLAN_REQUIRED', 120)
        })
      } else if (!state.terminal) {
        // Ordinary step errors remain catchable inside the model program. A
        // stale reference or host boundary never takes this path.
        state.worker.postMessage({
          type: 'response',
          requestId,
          ok: false,
          error: redactProtectedValues(
            safeError(error),
            state.protectedRedactions
          )
        })
      }
    } finally {
      trace.finishedAt = Date.now()
      trace.durationMs = trace.finishedAt - trace.startedAt
      state.pending.delete(requestId)
      this._finishReportedCompletionIfDrained(state)
    }
  }

  _finishReportedCompletionIfDrained(state) {
    if (state.terminal || !state.workerReportedCompletion || state.pending.size) return
    this._setTerminal(state, state.workerReportedCompletion)
  }

  async _mapRequest(state, method, args, stepNumber) {
    if (
      !PROTECTED_VALUE_METHODS.has(method) &&
      containsProtectedValue(args)
    ) {
      throw programError(
        `fan.protectedValue(alias) is not allowed in fan.${method}`,
        'BROWSER_PROGRAM_PROTECTED_VALUE_SINK_NOT_ALLOWED',
        { beforeDispatch: true, dispatchAttempted: false, method },
        400
      )
    }
    const target = value => this._resolveTarget(state, value)
    const withTarget = (name, reference, value = {}) => {
      const resolved = target(reference)
      return {
        params: {
          ...methodOptions(name, value),
          index: resolved.index,
          _fanDecisionToken: resolved.token,
          // Program code may execute several native actions justified by the
          // same numbered observation. The 0.3.2 atomic-tool path clears the
          // selector map after every type/select/click because its next action
          // always came from a new model turn. A run-level lease instead keeps
          // this exact map alive across the transaction. Real navigation,
          // document replacement, tab changes, detached nodes, and watchdog
          // invalidation are still rejected by the existing decision-token
          // and per-action node/actionability checks.
          ...(['click', 'type', 'select'].includes(name)
              ? { preserveSelectorMap: true }
              : {})
        },
        observationId: resolved.observationId
      }
    }

    switch (method) {
      case 'observe':
        return { kind: 'observe', options: methodOptions('observe', args[0]), stepNumber }
      case 'pageContent':
        return {
          action: 'pageContent',
          pageRead: true,
          params: {
            ...normalizePageContentOptions(args[0]),
            ...(state.latestDecisionToken
              ? { _fanDecisionToken: state.latestDecisionToken }
              : {})
          }
        }
      case 'navigate':
        return { action: 'navigate', params: { ...methodOptions('navigate', args[1]), url: String(args[0] || '') } }
      case 'search':
        return { action: 'search', params: { ...methodOptions('search', args[1]), query: String(args[0] || '') } }
      case 'back':
        return { action: 'back', params: methodOptions('back', args[0]) }
      case 'forward':
        return { action: 'forward', params: methodOptions('forward', args[0]) }
      case 'reload':
        return { action: 'reload', params: methodOptions('reload', args[0]) }
      case 'click': {
        const mapped = withTarget('click', args[0], args[1])
        return { action: 'click', ...mapped }
      }
      case 'clickPoint': {
        const point = normalizeVisualPoint(args[0], 'fan.clickPoint point')
        return {
          action: 'mouse',
          params: {
            operation: 'click',
            x: point.x,
            y: point.y,
            normalized: true,
            visualEvidenceToken: state.visualEvidenceRef
          }
        }
      }
      case 'type': {
        const mapped = withTarget('type', args[0], args[2])
        const protectedInput = Boolean(protectedValueAlias(args[1]))
        return {
          action: 'type',
          params: {
            ...mapped.params,
            ...(protectedInput ? { _fanProtectedInput: true } : {}),
            text: resolveProtectedValue(state, args[1], 'fan.type text')
          },
          observationId: mapped.observationId
        }
      }
      case 'fillForm': {
        const fields = this._resolveFields(state, args[0])
        return {
          action: 'fillForm',
          params: {
            ...methodOptions('fillForm', args[1]),
            fields: fields.values,
            _fanDecisionToken: fields.token,
            ...(fields.hasProtectedValues ? { _fanProtectedInput: true } : {}),
            // A program transaction already captures one authoritative final
            // snapshot. Keep the outer selector map alive between stable form
            // filling and later numbered actions instead of publishing an
            // embedded observation that makes every outer fan.ref stale.
            preserveSelectorMap: true
          },
          observationId: fields.observationId
        }
      }
      case 'formSubmit': {
        const fields = this._resolveFields(state, args[0])
        const submitTarget = target(args[1])
        if (fields.observationId !== submitTarget.observationId) {
          throw this._referenceMismatchError()
        }
        const submitOptions = strictObjectOptions('formSubmit.submit', args[2], SUBMIT_KEYS)
        for (const key of Object.keys(submitOptions)) {
          if (key !== 'allowOccluded' && key !== 'expected') delete submitOptions[key]
        }
        if (submitOptions.allowOccluded === true) {
          throw programError(
            'formSubmit refuses an occluded submit target',
            'BROWSER_PROGRAM_UNSAFE_SUBMIT_OPTIONS',
            undefined,
            400
          )
        }
        return {
          action: 'formSubmit',
          params: {
            ...methodOptions('formSubmit', args[3]),
            fields: fields.values,
            submit: {
              ...submitOptions,
              index: submitTarget.index
            },
            _fanDecisionToken: fields.token,
            ...(fields.hasProtectedValues ? { _fanProtectedInput: true } : {})
          },
          observationId: fields.observationId
        }
      }
      case 'keys':
        return {
          action: 'sendKeys',
          params: {
            ...methodOptions('keys', args[1]),
            keys: args[0],
            // Host-private transaction routing: a focus/keyboard step must not
            // invalidate numbered refs captured by the run's outer snapshot.
            // `preserveSelectorMap` is intentionally absent from OPTION_KEYS,
            // so model code cannot opt into or override this behavior.
            preserveSelectorMap: true
          }
        }
      case 'dialog': {
        const action = typeof args[0] === 'string' ? args[0].trim() : ''
        if (!['accept', 'dismiss'].includes(action)) {
          throw programError(
            "dialog action must be 'accept' or 'dismiss'",
            'BROWSER_PROGRAM_INVALID_DIALOG_ACTION',
            { action: boundedString(args[0], 80) },
            400
          )
        }
        const promptText = args[1] == null
          ? null
          : resolveProtectedValue(state, args[1], 'fan.dialog promptText')
        const protectedInput = Boolean(protectedValueAlias(args[1]))
        return {
          action: 'dialog',
          effect: 'dialog',
          params: {
            action,
            ...(promptText == null ? {} : { promptText }),
            ...(protectedInput ? { _fanProtectedInput: true } : {}),
            ...(state.latestDecisionToken
              ? { _fanDecisionToken: state.latestDecisionToken }
              : {})
          }
        }
      }
      case 'select': {
        const mapped = withTarget('select', args[0], args[2])
        const protectedInput = Boolean(protectedValueAlias(args[1]))
        return {
          action: 'select',
          params: {
            ...mapped.params,
            ...(protectedInput ? { _fanProtectedInput: true } : {}),
            text: resolveProtectedValue(state, args[1], 'fan.select value')
          },
          observationId: mapped.observationId
        }
      }
      case 'dropdownOptions': {
        const mapped = withTarget('dropdownOptions', args[0], args[1])
        return { action: 'dropdownOptions', ...mapped }
      }
      case 'hover': {
        const mapped = withTarget('hover', args[0], args[1])
        return { action: 'hover', ...mapped }
      }
      case 'focus': {
        const mapped = withTarget('focus', args[0], args[1])
        return { action: 'focus', ...mapped }
      }
      case 'highlight': {
        const options = normalizeHighlightOptions(args[1])
        if (options.clear === true) {
          if (args[0] != null || Object.keys(options).some(key => key !== 'clear')) {
            throw programError(
              "fan.highlight({clear: true}) cannot include a target or limit",
              'BROWSER_PROGRAM_INVALID_OPTIONS',
              { method: 'highlight', option: 'clear' },
              400
            )
          }
          if (!state.latestDecisionToken) {
            throw programError(
              'fan.highlight({clear: true}) requires a current browser observation',
              'BROWSER_OBSERVATION_REQUIRED',
              { replanRequired: true },
              409
            )
          }
          return {
            action: 'highlight',
            params: {
              clear: true,
              _fanDecisionToken: state.latestDecisionToken
            }
          }
        }
        delete options.clear
        if (args[0] != null) {
          if (Object.prototype.hasOwnProperty.call(options, 'limit')) {
            throw programError(
              "fan.highlight(target) does not accept a limit",
              'BROWSER_PROGRAM_INVALID_OPTIONS',
              { method: 'highlight', option: 'limit' },
              400
            )
          }
          const resolved = target(args[0])
          return {
            action: 'highlight',
            params: {
              ...options,
              index: resolved.index,
              _fanDecisionToken: resolved.token
            },
            observationId: resolved.observationId
          }
        }
        if (!state.latestDecisionToken) {
          throw programError(
            'fan.highlight() requires a current browser observation',
            'BROWSER_OBSERVATION_REQUIRED',
            { replanRequired: true },
            409
          )
        }
        return {
          action: 'highlight',
          params: {
            ...options,
            _fanDecisionToken: state.latestDecisionToken
          }
        }
      }
      case 'scroll':
        if (args[0] == null) return { action: 'scroll', params: methodOptions('scroll', args[1]) }
        return { action: 'scroll', ...withTarget('scroll', args[0], args[1]) }
      case 'scrollToText':
        return {
          action: 'scrollToText',
          params: { ...methodOptions('scrollToText', args[1]), text: String(args[0] || '') }
        }
      case 'drag': {
        const source = target(args[0])
        const destination = target(args[1])
        if (source.observationId !== destination.observationId) throw this._referenceMismatchError()
        return {
          action: 'drag',
          params: {
            ...methodOptions('drag', args[2]),
            sourceIndex: source.index,
            targetIndex: destination.index,
            _fanDecisionToken: source.token
          },
          observationId: source.observationId
        }
      }
      case 'dragPoint': {
        const from = normalizeVisualPoint(args[0], 'fan.dragPoint from')
        const to = normalizeVisualPoint(args[1], 'fan.dragPoint to')
        return {
          action: 'mouse',
          params: {
            operation: 'drag',
            x: from.x,
            y: from.y,
            toX: to.x,
            toY: to.y,
            normalized: true,
            visualEvidenceToken: state.visualEvidenceRef
          }
        }
      }
      case 'upload': {
        const mapped = withTarget('upload', args[0], args[2])
        const protectedInput = (
          Array.isArray(args[1]) &&
          args[1].some(file => Boolean(protectedValueAlias(file)))
        )
        const files = Array.isArray(args[1])
          ? args[1]
              .map(file => resolveProtectedValue(state, file, 'fan.upload file').trim())
              .filter(Boolean)
          : null
        if (!files?.length) {
          throw programError(
            'upload files must be a non-empty array of explicit local paths',
            'BROWSER_PROGRAM_INVALID_UPLOAD_FILES',
            undefined,
            400
          )
        }
        return {
          action: 'upload',
          params: {
            ...mapped.params,
            files,
            ...(protectedInput ? { _fanProtectedInput: true } : {})
          },
          observationId: mapped.observationId
        }
      }
      case 'wait': {
        const milliseconds = Number(args[0])
        return {
          action: 'wait',
          params: {
            ...methodOptions('wait', args[1]),
            seconds: Math.max(0, Number.isFinite(milliseconds) ? milliseconds / 1000 : 0)
          }
        }
      }
      case 'waitForState': {
        const resolved = target(args[0])
        if (!resolved.pin) {
          throw programError(
            `Element index ${resolved.index} has no stable browser-node identity`,
            'BROWSER_ELEMENT_STATE_UNTRACKABLE',
            {
              retryable: true,
              replanRequired: true,
              index: resolved.index
            },
            409
          )
        }
        return {
          action: 'waitForState',
          params: {
            ...methodOptions('waitForState', args[2]),
            index: resolved.index,
            state: elementStateExpectation(args[1]),
            _fanDecisionToken: resolved.token,
            _fanPinnedTarget: resolved.pin
          },
          observationId: resolved.observationId
        }
      }
      case 'settle': {
        const params = methodOptions('settle', args[0])
        delete params.description
        return { action: 'settle', params }
      }
      case 'tabs':
        return { action: 'listTabs', params: {} }
      case 'newTab':
        return {
          action: 'newTab',
          params: { ...methodOptions('newTab', args[1]), url: String(args[0] || 'about:blank') }
        }
      case 'switchTab':
        return {
          action: 'switchTab',
          params: { ...methodOptions('switchTab', args[1]), tabId: String(args[0] || '') }
        }
      case 'closeTab':
        return {
          action: 'closeTab',
          params: { ...methodOptions('closeTab', args[1]), tabId: String(args[0] || '') }
        }
      case 'saveScreenshot': {
        const params = methodOptions('saveScreenshot', args[0])
        const fileName = safeDownloadName(params.fileName ?? params.file_name, 'saveScreenshot.fileName')
        delete params.file_name
        if (!fileName) {
          throw programError(
            'saveScreenshot requires a safe fileName',
            'BROWSER_PROGRAM_FILENAME_REQUIRED',
            undefined,
            400
          )
        }
        if (!String(params.format || '').trim()) {
          const inferredFormat = screenshotFormatFromFileName(fileName)
          if (inferredFormat) params.format = inferredFormat
        }
        return {
          action: 'saveScreenshot',
          contentExport: true,
          params: {
            ...params,
            fileName,
            ...(state.latestDecisionToken ? { _fanDecisionToken: state.latestDecisionToken } : {})
          }
        }
      }
      case 'savePdf': {
        const params = methodOptions('savePdf', args[0])
        const rawName = params.fileName ?? params.file_name
        delete params.file_name
        const fileName = rawName == null ? '' : safeDownloadName(rawName, 'savePdf.fileName')
        return {
          action: 'savePdf',
          contentExport: true,
          params: {
            ...params,
            ...(fileName ? { fileName } : {}),
            ...(state.latestDecisionToken ? { _fanDecisionToken: state.latestDecisionToken } : {})
          }
        }
      }
      default:
        throw programError(
          `Unknown browser program method: ${method}`,
          'BROWSER_PROGRAM_METHOD_NOT_ALLOWED',
          { method },
          400
        )
    }
  }

  _resolveTarget(state, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw programError(
        'Browser actions require a numbered snapshot reference',
        'BROWSER_SNAPSHOT_REFERENCE_REQUIRED',
        { replanRequired: true },
        409
      )
    }
    const index = Number(value.index)
    const observationId = String(value.observationId || value.__fanObservationId || '')
    if (!Number.isSafeInteger(index) || index <= 0 || !observationId) {
      throw programError(
        'Browser snapshot reference is invalid',
        'BROWSER_SNAPSHOT_REFERENCE_INVALID',
        { replanRequired: true },
        409
      )
    }
    if (!state.observations.has(observationId)) {
      throw programError(
        'Browser snapshot reference is stale or was not issued by this run',
        'STALE_ELEMENT_REFERENCE',
        { replanRequired: true, index, reason: 'unknown-observation' },
        409
      )
    }
    return {
      index,
      observationId,
      token: state.observations.get(observationId),
      pin: state.observationPins.get(observationId)?.get(index) || null
    }
  }

  _resolveFields(state, fields) {
    if (!Array.isArray(fields) || !fields.length) {
      throw programError('fields must be a non-empty array', 'BROWSER_PROGRAM_INVALID_FIELDS')
    }
    let observationId = null
    let token = null
    let hasProtectedValues = false
    const values = fields.map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw programError('each field must be an object', 'BROWSER_PROGRAM_INVALID_FIELDS')
      }
      const reference = this._resolveTarget(state, field.target)
      if (observationId && observationId !== reference.observationId) {
        throw this._referenceMismatchError()
      }
      observationId = reference.observationId
      token = reference.token
      const fieldOptions = strictObjectOptions('form field', field, FIELD_KEYS)
      delete fieldOptions.target
      delete fieldOptions.ref
      delete fieldOptions.index
      if (Object.prototype.hasOwnProperty.call(fieldOptions, 'text')) {
        if (protectedValueAlias(fieldOptions.text)) hasProtectedValues = true
        fieldOptions.text = resolveProtectedValue(
          state,
          fieldOptions.text,
          'fan.fillForm field text'
        )
      }
      return {
        ...fieldOptions,
        index: reference.index
      }
    })
    return { values, observationId, token, hasProtectedValues }
  }

  _referenceMismatchError() {
    return programError(
      'A browser action cannot mix element references from different snapshots',
      'BROWSER_REFERENCE_GENERATION_MISMATCH',
      { replanRequired: true },
      409
    )
  }

  async _executeMapped(state, mapped, actionId, method) {
    if (mapped.kind === 'observe') {
      return this._observe(state, mapped.options, actionId, mapped.stepNumber)
    }
    if (mapped.contentExport || mapped.pageRead) {
      await this._guardCurrentPage(state, `${actionId}:guard-before`, `${method}-preflight`)
    }
    const rawResult = await this.executeStep({
      lease: state.lease,
      sessionId: state.sessionId,
      action: mapped.action,
      params: mapped.params || {},
      actionId
    })
    const verifiedResult = method === 'type'
      ? enforceTypeVerificationResult(rawResult)
      : rawResult
    const result = (
      method === 'fillForm' &&
      verifiedResult &&
      typeof verifiedResult === 'object' &&
      !Array.isArray(verifiedResult) &&
      ['partial', 'failed'].includes(String(verifiedResult.status || '').toLowerCase())
    ) ? {
      // A partially filled batch is a hard planning boundary. Do not let model
      // code ignore the return value and continue into select/click/submit with
      // assumptions that no longer match the page.
      ...verifiedResult,
      replanRequired: true,
      reason: boundedString(
        rawResult.reason ||
        rawResult.error ||
        'The form was only partially filled; inspect the final snapshot and replan.'
      ),
      code: boundedString(
        rawResult.code ||
        rawResult.errorCode ||
        'BROWSER_FORM_FILL_REPLAN_REQUIRED',
        120
      )
    } : verifiedResult
    // Record the settled action before inspecting a trailing observation. A
    // privacy postflight may withhold that observation, but it must not erase
    // evidence that a form submission or navigation already happened.
    this._recordResultEffect(state, method, result)
    if (mapped.contentExport || mapped.pageRead) {
      await this._guardCurrentPage(state, `${actionId}:guard-after`, `${method}-postflight`)
    }
    await this._guardEmbeddedObservation(state, result, `${actionId}:result`)
    return result
  }

  async _observe(state, options, actionId, stepNumber, { final = false } = {}) {
    await this._guardCurrentPage(
      state,
      `${actionId}:guard`,
      final ? 'final-preflight' : 'observe-preflight'
    )

    const raw = await this.executeStep({
      lease: state.lease,
      sessionId: state.sessionId,
      action: 'observe',
      params: {
        ...methodOptions('observe', options),
        _fanPassiveRead: true
      },
      actionId
    })
    const observed = stripDecisionToken(raw)
    await this._assertSnapshotUrl(activeUrl(observed.value), {
      state,
      phase: final ? 'final-postflight' : 'observe-postflight'
    })
    if (!observed.token) {
      throw programError(
        'Browser observation did not include a decision token',
        'BROWSER_OBSERVATION_TOKEN_MISSING',
        { replanRequired: true },
        409
      )
    }
    if (!final) {
      const observationId = `${state.runId}:observation:${state.nextObservation++}`
      state.observations.set(observationId, observed.token)
      state.observationPins.set(observationId, referencePinsFromSnapshot(observed.value))
      state.latestDecisionToken = observed.token
      const projected = projectSnapshotToLimit(observed.value, this.snapshotLimitBytes)
      state.latestSnapshot = projected.value
      return {
        observationId,
        snapshot: projected.value,
        ...safeHumanMetadata(observed.value),
        ...(projected.metadata ? { projection: projected.metadata } : {})
      }
    }
    const projected = projectSnapshotToLimit(observed.value, this.snapshotLimitBytes)
    state.latestSnapshot = projected.value
    if (observed.token) state.latestDecisionToken = observed.token
    return {
      snapshot: projected.value,
      projection: projected.metadata,
      decisionToken: observed.token,
      ...safeHumanMetadata(observed.value)
    }
  }

  async _guardCurrentPage(state, actionId, phase) {
    const live = await this.executeStep({
      lease: state.lease,
      sessionId: state.sessionId,
      action: 'liveState',
      params: {},
      actionId
    })
    await this._assertSnapshotUrl(activeUrl(live), { state, phase })
    return live
  }

  async _guardEmbeddedObservation(state, result, phase) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return
    const observation = result.observation
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return
    const observed = stripDecisionToken(observation)
    await this._assertSnapshotUrl(activeUrl(observed.value), { state, phase })
    const projected = projectSnapshotToLimit(observed.value, this.snapshotLimitBytes)
    state.latestSnapshot = projected.value
    if (observed.token) state.latestDecisionToken = observed.token
  }

  async _assertSnapshotUrl(url, { state, phase }) {
    const location = String(url || '').trim()
    if (!location) {
      throw programError(
        'The active browser location could not be safely verified before exposing page content',
        'BROWSER_OBSERVATION_URL_UNVERIFIED',
        { reason: 'missing-active-url', phase, retryable: false },
        403
      )
    }
    if (this.assertSnapshotAllowed) {
      const result = await this.assertSnapshotAllowed(location, {
        sessionId: state.sessionId,
        runId: state.runId,
        phase
      })
      if (result === false || result?.allowed === false) {
        throw programError(
          `Browser page content was withheld by the privacy policy${result?.reason ? `: ${result.reason}` : ''}`,
          'BROWSER_PRIVATE_URL_BLOCKED',
          { reason: boundedString(result?.reason || 'snapshot-policy'), phase, retryable: false },
          403
        )
      }
      return
    }
    const reason = browserRequestBlockReason(location, {
      protectedFileRoots: this.protectedFileRoots
    })
    if (reason) {
      throw programError(
        'Browser page content was withheld by the privacy policy',
        'BROWSER_PRIVATE_URL_BLOCKED',
        { reason, phase, retryable: false },
        403
      )
    }
  }

  async _prepareWorkerResponse(state, method, result) {
    if (method === 'observe') {
      return redactProtectedValues(result, state.protectedRedactions)
    }
    if (method === 'waitForState') {
      return redactProtectedValues(
        this._prepareWaitForStateResponse(state, result),
        state.protectedRedactions
      )
    }
    let workerResult = result
    if (method === 'tabs') {
      const tabs = Array.isArray(result)
        ? result
        : result?.tabs
      if (!Array.isArray(tabs)) {
        throw programError(
          'The native listTabs action returned an invalid result',
          'BROWSER_PROGRAM_RESULT_INVALID',
          { method: 'tabs' },
          500
        )
      }
      workerResult = tabs
    }
    workerResult = redactProtectedValues(workerResult, state.protectedRedactions)
    const safe = safeOutputResult(workerResult)
    if (method === 'pageContent') {
      // Keep usable content and an honest continuation cursor instead of
      // replacing an oversized result with a generic JSON preview.
      return projectPageContentToLimit(safe.value, this.valueLimitBytes, {
        sensitiveFieldsRemoved: safe.removed
      })
    }
    const projected = projectToLimit(safe.value, this.valueLimitBytes, 'step-result')
    if (projected.metadata) {
      return {
        value: projected.value,
        projection: {
          ...projected.metadata,
          ...(safe.removed ? { sensitiveFieldsRemoved: true } : {})
        }
      }
    }
    if (safe.removed && safe.value && typeof safe.value === 'object' && !Array.isArray(safe.value)) {
      return {
        ...safe.value,
        __fanProjection: { sensitiveFieldsRemoved: true }
      }
    }
    return projected.value
  }

  _prepareWaitForStateResponse(state, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw programError(
        'The native waitForState action returned an invalid result',
        'BROWSER_PROGRAM_RESULT_INVALID',
        { method: 'waitForState' },
        500
      )
    }
    if (
      result.matched !== true ||
      !result.targetIdentity ||
      typeof result.targetIdentity !== 'object' ||
      Array.isArray(result.targetIdentity)
    ) {
      throw programError(
        'The native waitForState action did not prove the requested element state',
        'BROWSER_PROGRAM_RESULT_INVALID',
        { method: 'waitForState' },
        500
      )
    }
    const observed = stripDecisionToken(result.observation)
    if (!observed.token) {
      throw programError(
        'The waitForState observation did not include a decision token',
        'BROWSER_OBSERVATION_TOKEN_MISSING',
        { replanRequired: true },
        409
      )
    }
    const observationId = `${state.runId}:observation:${state.nextObservation++}`
    const pins = referencePinsFromSnapshot(observed.value)
    state.observations.set(observationId, observed.token)
    state.observationPins.set(observationId, pins)
    state.latestDecisionToken = observed.token
    const projected = projectSnapshotToLimit(observed.value, this.snapshotLimitBytes)
    state.latestSnapshot = projected.value

    if (result.state?.attached === false) {
      return {
        matched: result.matched === true,
        elapsedMs: Number(result.elapsedMs) || 0,
        state: { attached: false }
      }
    }

    const matches = (Array.isArray(observed.value?.elements) ? observed.value.elements : [])
      .filter(element => samePinnedIdentity(element, result.targetIdentity))
    if (matches.length !== 1) {
      throw programError(
        matches.length
          ? 'The waited browser node is ambiguous in the fresh snapshot'
          : 'The waited browser node is not numbered in the fresh snapshot',
        'BROWSER_ELEMENT_STATE_REBIND_FAILED',
        {
          retryable: true,
          replanRequired: true,
          matchCount: matches.length,
          index: Number(result.targetIdentity?.index)
        },
        409
      )
    }
    const safe = safeOutputResult(matches[0]).value
    return {
      ...safe,
      __fanObservationId: observationId
    }
  }

  _recordResultEffect(state, method, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      if (EFFECTFUL_METHODS.has(method)) {
        state.effectSeen = true
        state.effects.add(method)
      }
      return
    }
    const human = humanBoundary(result)
    const pendingSettlement = result[ACTION_SETTLEMENT_SYMBOL]
    if (human && pendingSettlement && typeof pendingSettlement === 'object') {
      const settlementEffect = String(
        pendingSettlement.state === 'fulfilled'
          ? (pendingSettlement.value?.effect || '')
          : (pendingSettlement.error?.details?.effect || '')
      ).trim().toLowerCase()
      if (settlementEffect && settlementEffect !== 'none') {
        state.effectSeen = true
        state.effects.add(settlementEffect)
      } else if (pendingSettlement.state === 'pending') {
        // The user boundary won the wrapper race, but the exact CDP action has
        // not settled yet. Do not call it a known effect or a known no-op.
        state.uncertainEffect = true
      } else if (pendingSettlement.state === 'rejected') {
        const details = pendingSettlement.error?.details || {}
        if (!(details.beforeDispatch === true && details.dispatchAttempted === false)) {
          state.uncertainEffect = true
        }
      }
    }
    if (human && result.effectUncertain === true) {
      state.uncertainEffect = true
    }
    const effect = String(result.effect || '').trim().toLowerCase()
    if (effect && effect !== 'none') {
      state.effectSeen = true
      state.effects.add(effect)
      return
    }
    // A human boundary alone does not prove that the action changed the page.
    // Preserve explicit settled effects above, but do not infer an effect just
    // because the requested method is normally effectful.
    if (human) return
    if (EFFECTFUL_METHODS.has(method) && !replanBoundary(result) && !unknownResultBoundary(result)) {
      state.effectSeen = true
      state.effects.add(method)
    }
  }

  _setTerminal(state, terminal) {
    if (state.terminal) return false
    state.terminal = terminal
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer)
      state.timeoutTimer = null
    }
    if (state.worker) {
      state.terminationPromise = Promise.resolve()
        .then(() => state.worker.terminate())
        .catch(() => undefined)
    }
    state.resolveTerminal(terminal)
    return true
  }

  async _captureFinalSnapshot(state) {
    try {
      return await this._observe(
        state,
        {},
        `${state.runId}:final`,
        'final',
        { final: true }
      )
    } catch (error) {
      return {
        // A previous observation is useful history, but it is not the final
        // authoritative state promised by browser_run. Never relabel stale
        // page data (or its decision token) as the final snapshot.
        snapshot: null,
        projection: null,
        decisionToken: null,
        error: safeError(error, 'BROWSER_FINAL_SNAPSHOT_FAILED')
      }
    }
  }

  _buildOutput(state, terminal, final) {
    // `completed` and `needs_replan` both promise a fresh authoritative
    // snapshot to the next model decision. If that read fails, surface a real
    // before/after-effect failure instead of reporting a false success or an
    // unusable replan boundary.
    const finalSnapshotRequired = (
      terminal.kind === 'completed' ||
      terminal.kind === 'needs_replan'
    )
    let effectiveTerminal = final.error && finalSnapshotRequired
      ? { kind: 'failed', error: final.error }
      : terminal
    if (!final.error && finalSnapshotRequired) {
      const finalHuman = humanBoundary(final)
      if (finalHuman) {
        effectiveTerminal = {
          kind: 'needs_human',
          ...finalHuman,
          skipFinalSnapshot: true
        }
      }
    }
    let status
    if (effectiveTerminal.kind === 'completed') status = 'completed'
    else if (effectiveTerminal.kind === 'needs_replan') status = 'needs_replan'
    else if (effectiveTerminal.kind === 'needs_human') status = 'needs_human'
    else if (state.uncertainEffect) status = 'unknown_after_effect'
    else if (state.effectSeen) status = 'failed_after_effect'
    else status = 'failed_before_effect'

    const value = effectiveTerminal.kind === 'completed'
      ? isCanonicalPageContentEnvelope(effectiveTerminal.value)
        ? {
            value: projectTerminalPageContentToLimit(
              effectiveTerminal.value,
              this.valueLimitBytes
            ),
            metadata: null
          }
        : projectToLimit(effectiveTerminal.value, this.valueLimitBytes, 'return-value')
      : { value: null, metadata: null }
    const trace = state.trace
      .slice(0, this.maxSteps)
      .map(item => jsonSafe(item, {
        maxDepth: 6,
        maxEntries: 100,
        maxArray: 20,
        maxString: 1000
      }).value)

    const output = {
      runId: state.runId,
      status,
      value: value.value,
      trace,
      finalSnapshot: effectiveTerminal.kind === 'needs_human'
        ? null
        : final.snapshot && typeof final.snapshot === 'object' && !Array.isArray(final.snapshot)
        ? {
            ...final.snapshot,
            ...(final.decisionToken ? { __fanDecisionToken: final.decisionToken } : {})
          }
        : final.snapshot || null,
      effect: {
        occurred: state.effectSeen,
        uncertain: state.uncertainEffect,
        kinds: [...state.effects].slice(0, 20)
      }
    }
    if (effectiveTerminal.kind === 'needs_human') {
      Object.assign(
        output,
        safeHumanMetadata(state.latestSnapshot),
        safeHumanMetadata(final),
        safeHumanMetadata(effectiveTerminal.humanMetadata)
      )
    }
    if (value.metadata) output.valueProjection = value.metadata
    if (final.projection && effectiveTerminal.kind !== 'needs_human') {
      output.finalSnapshotProjection = final.projection
    }
    if (final.error) output.finalSnapshotError = final.error
    if (effectiveTerminal.kind !== 'completed') {
      output.error = effectiveTerminal.error
        ? safeError(effectiveTerminal.error)
        : {
            code: effectiveTerminal.code || (
              effectiveTerminal.kind === 'needs_human'
                ? 'BROWSER_HUMAN_VERIFICATION_REQUIRED'
                : 'BROWSER_REPLAN_REQUIRED'
            ),
            message: effectiveTerminal.reason || 'Browser program stopped'
          }
      if (Array.isArray(effectiveTerminal.candidates) && effectiveTerminal.candidates.length) {
        output.candidates = projectToLimit(
          effectiveTerminal.candidates.slice(0, 8),
          16 * 1024,
          'candidates'
        ).value
      }
    }
    return redactProtectedValues(output, state.protectedRedactions)
  }
}

module.exports = {
  ProgramRunner,
  projectToLimit
}
