'use strict'

const vm = require('node:vm')
const { parentPort, workerData } = require('node:worker_threads')

if (!parentPort) throw new Error('browser program worker requires a parent port')

const initialObservationId = String(workerData?.initialObservationId || '').slice(0, 200)

// Every function visible to model code is created inside the VM realm. Injecting
// a host-realm function would expose its Function/AsyncFunction constructor and
// let codeGeneration:false be bypassed (for example via
// fan.observe.constructor("return process")()). The only cross-realm values used
// by this bridge are JSON strings.
const BRIDGE_SOURCE = `
(() => {
  'use strict'

  const pending = new Map()
  const idleWaiters = []
  const requests = []
  const logs = []
  const maxPendingRequests = 200
  const maxRequestChars = 256 * 1024
  const maxLogEntries = 100
  const maxLogChars = 64 * 1024
  let requestSequence = 0
  let logChars = 0
  let logsTruncated = false
  const outerObservationId = ${JSON.stringify(initialObservationId)}
  let currentObservationId = outerObservationId
  let currentSnapshot = null
  let hasObserved = false
  let hardBoundary = null

  // The bridge and model intentionally share one VM realm so every function
  // exposed through fan is created under codeGeneration:false. Lock the
  // mutable intrinsics used by the bridge before model code runs: otherwise a
  // program could replace Reflect.ownKeys, Object.entries, Array#filter, or
  // request-plumbing methods and make a declarative wait execute hidden
  // effects. Ordinary use of these built-ins remains available; only
  // monkey-patching their shared definitions is forbidden.
  function lockIntrinsicBinding(name, value) {
    if (value?.prototype && (
      typeof value.prototype === 'object' ||
      typeof value.prototype === 'function'
    )) {
      Object.freeze(value.prototype)
    }
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      Object.freeze(value)
    }
    Object.defineProperty(globalThis, name, {
      value,
      configurable: false,
      enumerable: false,
      writable: false
    })
  }

  function lockBridgeIntrinsics() {
    const arrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]())
    const iteratorPrototype = Object.getPrototypeOf(arrayIteratorPrototype)
    Object.freeze(iteratorPrototype)
    Object.freeze(arrayIteratorPrototype)

    for (const [name, value] of [
      ['Object', Object],
      ['Function', Function],
      ['Array', Array],
      ['Number', Number],
      ['String', String],
      ['Boolean', Boolean],
      ['Date', Date],
      ['Promise', Promise],
      ['Map', Map],
      ['Set', Set],
      ['Error', Error],
      ['TypeError', TypeError],
      ['Symbol', Symbol],
      ['Math', Math],
      ['JSON', JSON],
      ['Reflect', Reflect]
    ]) {
      lockIntrinsicBinding(name, value)
    }
  }

  function disableExternalMemoryPrimitives() {
    // Worker resourceLimits constrain the V8 heap but explicitly do not cover
    // ArrayBuffer backing stores. Browser programs exchange JSON only, so they
    // have no legitimate binary-memory requirement. Remove every direct
    // allocator, including WebAssembly.Memory, before model code runs.
    for (const name of [
      'ArrayBuffer',
      'SharedArrayBuffer',
      'DataView',
      'Int8Array',
      'Uint8Array',
      'Uint8ClampedArray',
      'Int16Array',
      'Uint16Array',
      'Int32Array',
      'Uint32Array',
      'Float16Array',
      'Float32Array',
      'Float64Array',
      'BigInt64Array',
      'BigUint64Array',
      'Atomics',
      'WebAssembly'
    ]) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: false,
        enumerable: false,
        writable: false
      })
    }
  }

  class ReplanSignal extends Error {
    constructor(reason, candidates = []) {
      super(String(reason || 'A fresh model decision is required'))
      this.name = 'ReplanSignal'
      this.candidates = candidates
    }
  }

  function clipped(value, limit) {
    return String(value == null ? '' : value).slice(0, limit)
  }

  function candidateSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const result = Object.create(null)
    for (const key of ['index', 'id', 'role', 'name', 'text', 'label', 'placeholder', 'tag', 'href']) {
      if (value[key] == null) continue
      result[key] = typeof value[key] === 'string'
        ? value[key].slice(0, 300)
        : value[key]
    }
    return result
  }

  function setBoundary(status, reason, candidates = [], code = '') {
    if (!hardBoundary) {
      const boundaryCode = clipped(code, 120)
      hardBoundary = Object.freeze({
        status: status === 'needs_human' ? 'needs_human' : 'needs_replan',
        ...(boundaryCode ? { code: boundaryCode } : {}),
        reason: clipped(reason || 'A fresh model decision is required', 1000),
        candidates: Object.freeze(
          (Array.isArray(candidates) ? candidates : [])
            .slice(0, 8)
            .map(candidateSummary)
        )
      })
    }
    throw new ReplanSignal(hardBoundary.reason, hardBoundary.candidates)
  }

  function snapshotElementsIncomplete(snapshot = currentSnapshot) {
    return Boolean(
      snapshot &&
      typeof snapshot === 'object' &&
      (
        snapshot.elementsTruncated === true ||
        Number(snapshot.omittedElementCount || 0) > 0
      )
    )
  }

  function setSnapshotElementsTruncatedBoundary() {
    return setBoundary(
      'needs_replan',
      'Structured snapshot elements were truncated. End this browser_run and use ' +
        'the numbered targets from the final outer snapshot in the next browser_run, ' +
        'without calling fan.observe() first.',
      currentSnapshot?.elements || [],
      'BROWSER_SNAPSHOT_ELEMENTS_TRUNCATED'
    )
  }

  function makeRef(index, observationId = currentObservationId) {
    const value = Number(index)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Element reference must be a positive integer')
    }
    const boundObservationId = clipped(observationId, 200)
    if (!boundObservationId) {
      const error = new Error('No model-visible browser snapshot is bound to this run')
      error.code = 'BROWSER_SNAPSHOT_REQUIRED'
      throw error
    }
    return Object.freeze({
      __fanRef: true,
      index: value,
      observationId: boundObservationId
    })
  }

  function makeProtectedValue(alias) {
    const key = typeof alias === 'string' ? alias.trim() : ''
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      const error = new TypeError(
        'fan.protectedValue(alias) requires a valid value_refs alias'
      )
      error.code = 'BROWSER_PROGRAM_VALUE_ALIAS_INVALID'
      throw error
    }
    return Object.freeze({ __fanProtectedValue: key })
  }

  function isProtectedValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const keys = Object.keys(value)
    return (
      keys.length === 1 &&
      keys[0] === '__fanProtectedValue' &&
      typeof value.__fanProtectedValue === 'string'
    )
  }

  function normalizeTarget(target) {
    if (Number.isSafeInteger(target)) {
      throw new TypeError(
        'Bare numeric targets are ambiguous; use fan.ref(index) for the outer snapshot ' +
        'or pass an element returned by fan.observe()'
      )
    }
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      if (snapshotElementsIncomplete()) return setSnapshotElementsTruncatedBoundary()
      throw new TypeError('Browser action target must be a numbered snapshot element')
    }
    const observationId = String(
      target.observationId ||
      target.__fanObservationId ||
      ''
    )
    if (
      hasObserved &&
      target.__fanRef === true &&
      observationId === outerObservationId
    ) {
      return setBoundary(
        'needs_replan',
        'fan.ref(N) only belongs to the outer snapshot and cannot be used after ' +
          'fan.observe(). End this browser_run, or use the element object returned ' +
          'by the latest fan.observe().',
        currentSnapshot?.elements || [],
        'BROWSER_REF_AFTER_OBSERVE'
      )
    }
    return makeRef(Number(target.index), observationId)
  }

  function normalizeVisualPoint(point, label) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) {
      const error = new TypeError(label + ' must be an object with own numeric x and y properties')
      error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
      throw error
    }
    let keys
    try {
      keys = Reflect.ownKeys(point)
    } catch {
      const error = new TypeError(label + ' must expose ordinary own x and y data properties')
      error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
      throw error
    }
    if (
      keys.length !== 2 ||
      !keys.includes('x') ||
      !keys.includes('y') ||
      keys.some(key => typeof key !== 'string')
    ) {
      const error = new TypeError(label + ' accepts only own x and y properties')
      error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
      throw error
    }
    const normalized = Object.create(null)
    for (const key of ['x', 'y']) {
      let descriptor
      try {
        descriptor = Object.getOwnPropertyDescriptor(point, key)
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
        const error = new TypeError(
          label + '.' + key + ' must be an own finite number from 0 through 1000'
        )
        error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
        throw error
      }
      normalized[key] = descriptor.value
    }
    return Object.freeze(normalized)
  }

  function canonicalSnapshotText(snapshot) {
    for (const key of [
      'browserUseText',
      'browserUseDomTreeText',
      'text',
      'domTreeText',
      'flatText'
    ]) {
      if (typeof snapshot?.[key] === 'string' && snapshot[key]) return snapshot[key]
    }
    return ''
  }

  function annotateSnapshot(snapshot, observationId) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot
    // elements remains an ordinary array. Its positions are unrelated to the
    // model-visible [N] numbers, which live in each record's index field.
    const elements = Array.isArray(snapshot.elements)
      ? snapshot.elements.map(element => {
          if (!element || typeof element !== 'object' || !Number.isSafeInteger(Number(element.index))) {
            return element
          }
          return Object.freeze({
            ...element,
            id: element.id ?? element.attributes?.id,
            __fanObservationId: observationId
          })
        })
      : []
    const annotated = { ...snapshot, elements: Object.freeze(elements) }
    // The host keeps its historical browserUseText key because Python's final
    // snapshot formatter consumes it. Browser programs need one stable SDK
    // name for both numbered controls and unnumbered page prose, regardless of
    // which historical host key supplied the canonical text. Keep the alias
    // non-enumerable so returning or JSON-stringifying a whole snapshot does
    // not duplicate a potentially large DOM string.
    Object.defineProperty(annotated, 'text', {
      value: canonicalSnapshotText(snapshot),
      configurable: false,
      enumerable: false,
      writable: false
    })
    return Object.freeze(annotated)
  }

  function normalizeFields(fields) {
    if (!Array.isArray(fields) || !fields.length) {
      throw new TypeError('fields must be a non-empty array')
    }
    return fields.map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new TypeError('each field must be an object')
      }
      const target = field.target ?? field.ref ?? field.index
      const normalized = { ...field, target: normalizeTarget(target) }
      delete normalized.index
      delete normalized.ref
      return normalized
    })
  }

  function invokeUnchecked(method, args = []) {
    if (hardBoundary) {
      return Promise.reject(new ReplanSignal(hardBoundary.reason, hardBoundary.candidates))
    }
    if (pending.size >= maxPendingRequests) {
      const error = new Error('Browser program has too many concurrent pending steps')
      error.code = 'BROWSER_PROGRAM_STEP_LIMIT'
      return Promise.reject(error)
    }
    const requestId = 'request-' + (++requestSequence)
    return new Promise((resolve, reject) => {
      let encoded
      try {
        encoded = JSON.stringify({ requestId, method, args })
      } catch (error) {
        reject(new TypeError('Browser program arguments must be JSON serializable: ' + error.message))
        return
      }
      if (encoded.length > maxRequestChars) {
        const error = new Error(
          'Browser program step arguments exceed the ' + maxRequestChars + '-character limit'
        )
        error.code = 'BROWSER_PROGRAM_ARGUMENTS_TOO_LARGE'
        reject(error)
        return
      }
      pending.set(requestId, { resolve, reject })
      requests.push(encoded)
    })
  }

  function invoke(method, args = []) {
    return invokeUnchecked(method, args)
  }

  function notifyIdle() {
    if (pending.size) return
    while (idleWaiters.length) idleWaiters.shift()()
  }

  async function observeSnapshot(options = {}) {
    const response = await invoke('observe', [options])
    currentObservationId = clipped(response?.observationId, 200)
    currentSnapshot = annotateSnapshot(response?.snapshot, currentObservationId)
    hasObserved = true
    return currentSnapshot
  }

  function boundedWaitNumber(value, fallback, minimum, maximum, label) {
    if (value == null) return fallback
    const number = Number(value)
    if (!Number.isFinite(number)) {
      throw new TypeError(label + ' must be a finite number')
    }
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)))
  }

  const elementQueryKeys = new Set([
    'index',
    'id',
    'role',
    'name',
    'text',
    'label',
    'placeholder',
    'tag',
    'type',
    'href',
    'value',
    'checked',
    'attributes'
  ])

  function ownDataEntries(value, label) {
    const keys = Reflect.ownKeys(value)
    const entries = []
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new TypeError(label + ' may contain only string keys')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(label + " field '" + key + "' must be an ordinary data property")
      }
      entries.push([key, descriptor.value])
    }
    return entries
  }

  function normalizeQueryValue(value, label) {
    if (
      value == null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      return value
    }
    throw new TypeError(label + ' must be a string, number, boolean, or null')
  }

  function normalizeElementQuery(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new TypeError('fan.waitForElement requires a declarative query object')
    }
    const entries = ownDataEntries(query, 'fan.waitForElement query')
    if (!entries.length) {
      throw new TypeError('fan.waitForElement query must contain at least one field')
    }
    const normalized = Object.create(null)
    for (const [key, value] of entries) {
      if (!elementQueryKeys.has(key)) {
        throw new TypeError("fan.waitForElement query field '" + key + "' is not allowed")
      }
      if (key === 'attributes') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new TypeError('fan.waitForElement query attributes must be an object')
        }
        const attributeEntries = ownDataEntries(value, 'fan.waitForElement query attributes')
        if (!attributeEntries.length) {
          throw new TypeError('fan.waitForElement query attributes must not be empty')
        }
        const attributes = Object.create(null)
        for (const [attribute, attributeValue] of attributeEntries) {
          if (['__proto__', 'constructor', 'prototype'].includes(attribute)) {
            throw new TypeError(
              "fan.waitForElement query attribute '" + attribute + "' is not allowed"
            )
          }
          attributes[attribute] = normalizeQueryValue(
            attributeValue,
            "fan.waitForElement query attribute '" + attribute + "'"
          )
        }
        normalized.attributes = Object.freeze(attributes)
        continue
      }
      const normalizedValue = normalizeQueryValue(
        value,
        "fan.waitForElement query field '" + key + "'"
      )
      if (
        key === 'index' &&
        (!Number.isSafeInteger(Number(normalizedValue)) || Number(normalizedValue) <= 0)
      ) {
        throw new TypeError('fan.waitForElement query index must be a positive integer')
      }
      normalized[key] = key === 'index' ? Number(normalizedValue) : normalizedValue
    }
    return Object.freeze(normalized)
  }

  function queryValueMatches(actual, expected) {
    if (typeof expected === 'boolean') return actual === expected
    if (typeof expected === 'number') return Number(actual) === expected
    if (expected == null) return actual == null
    return String(actual ?? '') === String(expected)
  }

  function elementMatchesQuery(element, query) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) return false
    for (const [key, expected] of Object.entries(query)) {
      if (key === 'attributes') {
        for (const [attribute, attributeValue] of Object.entries(expected)) {
          if (!queryValueMatches(element.attributes?.[attribute], attributeValue)) return false
        }
        continue
      }
      if (!queryValueMatches(element[key], expected)) return false
    }
    return true
  }

  function normalizeElementWaitOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('fan.waitForElement options must be an object')
    }
    const allowed = new Set(['timeoutMs', 'pollMs', 'description'])
    const normalized = Object.create(null)
    for (const [key, value] of ownDataEntries(options, 'fan.waitForElement options')) {
      if (!allowed.has(key)) {
        throw new TypeError("fan.waitForElement option '" + key + "' is not allowed")
      }
      if (key === 'description') {
        if (typeof value !== 'string') {
          throw new TypeError('fan.waitForElement description must be a string')
        }
        normalized.description = value
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('fan.waitForElement ' + key + ' must be a finite number')
      }
      normalized[key] = value
    }
    return Object.freeze(normalized)
  }

  function normalizeElementState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('fan.waitForState state must be an object')
    }
    const entries = ownDataEntries(state, 'fan.waitForState state')
    if (!entries.length) {
      throw new TypeError('fan.waitForState state must contain attached or enabled')
    }
    const normalized = Object.create(null)
    for (const [key, value] of entries) {
      if (!['attached', 'enabled'].includes(key)) {
        throw new TypeError("fan.waitForState state field '" + key + "' is not allowed")
      }
      if (typeof value !== 'boolean') {
        throw new TypeError('fan.waitForState ' + key + ' must be a boolean')
      }
      normalized[key] = value
    }
    if (
      normalized.attached === false &&
      Object.prototype.hasOwnProperty.call(normalized, 'enabled')
    ) {
      throw new TypeError('fan.waitForState cannot test enabled on a detached element')
    }
    return Object.freeze(normalized)
  }

  function normalizeStateWaitOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('fan.waitForState options must be an object')
    }
    const allowed = new Set(['timeoutMs', 'pollMs', 'description'])
    const normalized = Object.create(null)
    for (const [key, value] of ownDataEntries(options, 'fan.waitForState options')) {
      if (!allowed.has(key)) {
        throw new TypeError("fan.waitForState option '" + key + "' is not allowed")
      }
      if (key === 'description') {
        if (typeof value !== 'string') {
          throw new TypeError('fan.waitForState description must be a string')
        }
        normalized.description = value
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError('fan.waitForState ' + key + ' must be a finite number')
      }
      normalized[key] = value
    }
    return Object.freeze(normalized)
  }

  const fan = Object.freeze({
    observe(options = {}) {
      return observeSnapshot(options)
    },

    pageContent(options = {}) {
      return invoke('pageContent', [options])
    },

    async waitForElement(query, options = {}) {
      const normalizedQuery = normalizeElementQuery(query)
      const normalizedOptions = normalizeElementWaitOptions(options)
      const timeoutMs = boundedWaitNumber(
        normalizedOptions.timeoutMs,
        5000,
        100,
        30000,
        'timeoutMs'
      )
      const requestedPollMs = boundedWaitNumber(
        normalizedOptions.pollMs,
        200,
        50,
        5000,
        'pollMs'
      )
      // One poll consumes an observe step and usually one wait step. Keep a
      // single condition wait comfortably inside the host's 200-step ceiling.
      const pollMs = Math.max(requestedPollMs, Math.ceil(timeoutMs / 80))
      const description = clipped(normalizedOptions.description || 'browser element', 300)
      const deadline = Date.now() + timeoutMs

      while (true) {
        const snapshot = await observeSnapshot()
        const matches = (snapshot?.elements || []).filter(element =>
          elementMatchesQuery(element, normalizedQuery)
        )
        if (matches.length === 1) return matches[0]
        if (matches.length > 1) {
          return setBoundary(
            'needs_replan',
            description + ' matched ' + matches.length +
              ' elements; inspect the fresh snapshot and decide again',
            matches
          )
        }
        if (snapshotElementsIncomplete(snapshot)) {
          return setSnapshotElementsTruncatedBoundary()
        }

        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          return setBoundary(
            'needs_replan',
            'Timed out waiting for ' + description + ' after ' + timeoutMs + 'ms',
            snapshot?.elements || []
          )
        }
        await invoke('wait', [Math.min(pollMs, remaining), {}])
      }
    },

    waitForState(target, state, options = {}) {
      return invoke('waitForState', [
        normalizeTarget(target),
        normalizeElementState(state),
        normalizeStateWaitOptions(options)
      ])
    },

    ref(index) {
      // fan.ref addresses the model-visible outer snapshot only. A later
      // fan.observe returns already-bound element objects; rebinding the same
      // numeric literal to a new generation could silently target an unrelated
      // element that happened to receive the same number.
      return makeRef(index, outerObservationId)
    },

    protectedValue(alias) {
      // This marker contains only the model-visible alias. The raw value stays
      // in the host and is materialized only for an approved browser input.
      return makeProtectedValue(alias)
    },

    requireUnique(elements, description = 'element') {
      const candidates = Array.isArray(elements) ? elements.filter(Boolean) : []
      if (candidates.length === 1) return candidates[0]
      if (!candidates.length && snapshotElementsIncomplete()) {
        return setSnapshotElementsTruncatedBoundary()
      }
      return setBoundary(
        'needs_replan',
        String(description || 'element') + ' matched ' + candidates.length +
          ' elements; inspect the fresh snapshot and decide again',
        candidates
      )
    },

    replan(reason = 'A fresh model decision is required', candidates = currentSnapshot?.elements || []) {
      return setBoundary('needs_replan', reason, candidates)
    },

    navigate(url, options = {}) {
      return invoke('navigate', [url, options])
    },
    search(query, options = {}) {
      return invoke('search', [query, options])
    },
    back(options = {}) {
      return invoke('back', [options])
    },
    forward(options = {}) {
      return invoke('forward', [options])
    },
    reload(options = {}) {
      return invoke('reload', [options])
    },
    click(target, options = {}) {
      return invoke('click', [normalizeTarget(target), options])
    },
    clickPoint(point, ...extra) {
      if (extra.length) {
        const error = new TypeError('fan.clickPoint accepts exactly one point and no options')
        error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
        throw error
      }
      return invoke('clickPoint', [normalizeVisualPoint(point, 'fan.clickPoint point')])
    },
    type(target, text, options = {}) {
      return invoke('type', [normalizeTarget(target), text, options])
    },
    fillForm(fields, options = {}) {
      return invoke('fillForm', [normalizeFields(fields), options])
    },
    formSubmit(fields, submit, options = {}) {
      const submitTarget = (
        submit &&
        typeof submit === 'object' &&
        !Array.isArray(submit) &&
        (submit.__fanRef || submit.__fanObservationId || submit.observationId)
      )
        ? submit
        : (submit?.target ?? submit?.ref ?? submit?.index ?? submit)
      const submitOptions = Object.create(null)
      if (submit && typeof submit === 'object' && !Array.isArray(submit)) {
        for (const key of ['allowOccluded', 'expected']) {
          if (Object.prototype.hasOwnProperty.call(submit, key)) {
            submitOptions[key] = submit[key]
          }
        }
      }
      return invoke('formSubmit', [
        normalizeFields(fields),
        normalizeTarget(submitTarget),
        submitOptions,
        options
      ])
    },
    keys(keys, options = {}) {
      return invoke('keys', [keys, options])
    },
    dialog(action, promptText) {
      const normalizedAction = typeof action === 'string' ? action.trim() : ''
      if (!['accept', 'dismiss'].includes(normalizedAction)) {
        throw new TypeError("fan.dialog action must be 'accept' or 'dismiss'")
      }
      if (
        promptText != null &&
        typeof promptText !== 'string' &&
        !isProtectedValue(promptText)
      ) {
        throw new TypeError(
          'fan.dialog promptText must be a string or fan.protectedValue(alias)'
        )
      }
      return invoke('dialog', [normalizedAction, promptText])
    },
    select(target, value, options = {}) {
      return invoke('select', [normalizeTarget(target), value, options])
    },
    dropdownOptions(target, options = {}) {
      return invoke('dropdownOptions', [normalizeTarget(target), options])
    },
    hover(target, options = {}) {
      return invoke('hover', [normalizeTarget(target), options])
    },
    focus(target, options = {}) {
      return invoke('focus', [normalizeTarget(target), options])
    },
    highlight(targetOrOptions = null, options = {}) {
      const optionsOnly = (
        targetOrOptions &&
        typeof targetOrOptions === 'object' &&
        !Array.isArray(targetOrOptions) &&
        !targetOrOptions.__fanRef &&
        !targetOrOptions.__fanObservationId &&
        !targetOrOptions.observationId
      )
      return invoke('highlight', optionsOnly
        ? [null, targetOrOptions]
        : [
            targetOrOptions == null ? null : normalizeTarget(targetOrOptions),
            options
          ])
    },
    scroll(targetOrOptions = {}, options = {}) {
      if (
        Number.isSafeInteger(targetOrOptions) ||
        (targetOrOptions && typeof targetOrOptions === 'object' && (
          targetOrOptions.__fanRef ||
          targetOrOptions.__fanObservationId
        ))
      ) {
        return invoke('scroll', [normalizeTarget(targetOrOptions), options])
      }
      return invoke('scroll', [null, targetOrOptions || {}])
    },
    scrollToText(text, options = {}) {
      return invoke('scrollToText', [text, options])
    },
    drag(source, target, options = {}) {
      return invoke('drag', [normalizeTarget(source), normalizeTarget(target), options])
    },
    dragPoint(from, to, ...extra) {
      if (extra.length) {
        const error = new TypeError('fan.dragPoint accepts exactly two points and no options')
        error.code = 'BROWSER_PROGRAM_VISUAL_POINT_INVALID'
        throw error
      }
      return invoke('dragPoint', [
        normalizeVisualPoint(from, 'fan.dragPoint from'),
        normalizeVisualPoint(to, 'fan.dragPoint to')
      ])
    },
    upload(target, files, options = {}) {
      return invoke('upload', [normalizeTarget(target), files, options])
    },
    wait(milliseconds, options = {}) {
      return invoke('wait', [milliseconds, options])
    },
    settle(options = {}) {
      return invoke('settle', [options])
    },
    tabs() {
      return invoke('tabs', [])
    },
    newTab(url = 'about:blank', options = {}) {
      return invoke('newTab', [url, options])
    },
    switchTab(tabId, options = {}) {
      return invoke('switchTab', [tabId, options])
    },
    closeTab(tabId, options = {}) {
      return invoke('closeTab', [tabId, options])
    },
    saveScreenshot(options = {}) {
      return invoke('saveScreenshot', [options])
    },
    savePdf(options = {}) {
      return invoke('savePdf', [options])
    }
  })

  function formatLogValue(value) {
    if (typeof value === 'string') return value.slice(0, 2000)
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
      return JSON.stringify(value).slice(0, 2000)
    } catch {
      return '[unserializable value]'
    }
  }

  const safeConsole = Object.freeze(Object.fromEntries(
    ['log', 'info', 'warn', 'error'].map(level => [
      level,
      (...values) => {
        if (logsTruncated) return
        const encoded = JSON.stringify({
          level,
          values: values.slice(0, 8).map(formatLogValue)
        })
        if (logs.length >= maxLogEntries || logChars + encoded.length > maxLogChars) {
          logsTruncated = true
          logs.push(JSON.stringify({
            level: 'warn',
            values: ['browser program console output truncated']
          }))
          return
        }
        logChars += encoded.length
        logs.push(encoded)
      }
    ])
  ))

  Object.defineProperty(globalThis, 'fan', {
    value: fan,
    configurable: false,
    enumerable: true,
    writable: false
  })
  Object.defineProperty(globalThis, 'console', {
    value: safeConsole,
    configurable: false,
    enumerable: true,
    writable: false
  })
  // Browser programs have no legitimate need for meta-object interception.
  // Removing Proxy makes declarative wait inputs inspectable without invoking
  // model-defined ownKeys/getOwnPropertyDescriptor traps. Accessor properties
  // are rejected separately before any value is read.
  Object.defineProperty(globalThis, 'Proxy', {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false
  })

  function responseRequiresBoundary(response) {
    const result = response?.result
    const error = response?.error
    const details = error?.details
    if (
      result?.interventionPending === true ||
      (result?.captchaState?.detected === true && result.captchaState.requiresUserInput !== false) ||
      error?.code === 'HUMAN_INTERVENTION_PENDING'
    ) {
      return {
        status: 'needs_human',
        reason: details?.reason || error?.message || 'Human browser control is required',
        candidates: []
      }
    }
    if (
      result?.replanRequired === true ||
      result?.replan_required === true ||
      result?.status === 'replan-required' ||
      details?.replanRequired === true
    ) {
      return {
        status: 'needs_replan',
        reason: result?.reason || details?.reason || error?.message || 'A fresh browser decision is required',
        candidates: result?.observation?.elements || []
      }
    }
    return null
  }

  const bridge = Object.freeze({
    takeRequests() {
      return JSON.stringify(requests.splice(0))
    },

    takeLogs() {
      return JSON.stringify(logs.splice(0))
    },

    settle(serialized) {
      const response = JSON.parse(String(serialized || '{}'))
      const request = pending.get(String(response.requestId || ''))
      if (!request) return false
      pending.delete(String(response.requestId))
      const boundary = responseRequiresBoundary(response)
      if (boundary) {
        try {
          setBoundary(boundary.status, boundary.reason, boundary.candidates)
        } catch (error) {
          request.reject(error)
        }
        notifyIdle()
        return true
      }
      if (response.ok) {
        request.resolve(response.result)
        notifyIdle()
        return true
      }
      const error = new Error(clipped(response.error?.message || 'Browser program step failed', 2000))
      if (response.error?.code) error.code = clipped(response.error.code, 120)
      if (response.error?.details && typeof response.error.details === 'object') {
        error.details = response.error.details
      }
      request.reject(error)
      notifyIdle()
      return true
    },

    async waitForIdle() {
      // Model code can accidentally omit await on a fan action. A run must
      // never report completion or release its lease while that action is
      // still in flight. Drain both pending requests and promise continuations
      // that may enqueue a following step.
      do {
        if (pending.size) {
          await new Promise(resolve => idleWaiters.push(resolve))
        }
        await Promise.resolve()
        await Promise.resolve()
      } while (pending.size)
    },

    serializeCompletion(value) {
      if (hardBoundary) {
        return JSON.stringify({ type: 'boundary', ...hardBoundary })
      }
      try {
        return JSON.stringify({
          type: 'completed',
          value: value === undefined ? null : value
        })
      } catch (error) {
        return JSON.stringify({
          type: 'failed',
          error: {
            name: 'TypeError',
            message: clipped('Browser program return value must be JSON serializable: ' + error.message, 2000),
            code: 'PROGRAM_RESULT_NOT_SERIALIZABLE'
          }
        })
      }
    },

    serializeFailure(error) {
      if (hardBoundary || error instanceof ReplanSignal) {
        return JSON.stringify({
          type: 'boundary',
          ...(hardBoundary || {
            status: 'needs_replan',
            reason: clipped(error?.message || 'A fresh model decision is required', 1000),
            candidates: Array.isArray(error?.candidates)
              ? error.candidates.slice(0, 8).map(candidateSummary)
              : []
          })
        })
      }
      let name = 'Error'
      let message = 'Browser program failed'
      let code
      let stack
      let details
      try { name = clipped(error?.name || 'Error', 80) } catch {}
      try { message = clipped(error?.message || error || message, 2000) } catch {}
      try { code = error?.code ? clipped(error.code, 120) : undefined } catch {}
      try { stack = clipped(error?.stack || '', 8000) } catch {}
      try {
        details = error?.details && typeof error.details === 'object'
          ? error.details
          : undefined
      } catch {}
      const undeclared = name === 'ReferenceError'
        ? /^([A-Za-z_$][A-Za-z0-9_$]*) is not defined$/.exec(message)
        : null
      if (!code && undeclared?.[1] === 'snapshot') {
        code = 'BROWSER_PROGRAM_SCOPE_RESET'
        message = clipped(
          'snapshot is not defined. Each browser_run starts a fresh isolated ' +
          'JavaScript scope; a snapshot variable from an earlier call is ' +
          'unavailable. Declare \`const snapshot = await fan.observe()\` in ' +
          'this browser_run.',
          2000
        )
        details = {
          identifier: 'snapshot',
          scope: 'browser_run'
        }
      } else if (!code && undeclared) {
        code = 'BROWSER_PROGRAM_UNDECLARED_IDENTIFIER'
        message = clipped(
          message +
          '. Each browser_run starts a fresh isolated JavaScript scope; ' +
          'declare every variable in this code body. To read current page data, ' +
          'use \`const snapshot = await fan.observe()\` in the same browser_run.',
          2000
        )
        details = {
          identifier: undeclared[1],
          scope: 'browser_run'
        }
      }
      return JSON.stringify({
        type: 'failed',
        error: { name, message, code, stack, details }
      })
    }
  })

  lockBridgeIntrinsics()
  disableExternalMemoryPrimitives()
  return bridge
})()
`

function safeHostError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    message: String(error?.message || error || 'Browser program worker failed').slice(0, 2000),
    code: error?.code ? String(error.code).slice(0, 120) : undefined,
    stack: String(error?.stack || '').slice(0, 8000)
  }
}

function parseBridgeBatch(value) {
  const parsed = JSON.parse(String(value || '[]'))
  return Array.isArray(parsed) ? parsed : []
}

async function execute() {
  const context = vm.createContext(
    Object.create(null),
    {
      name: 'fan-browser-program',
      codeGeneration: { strings: false, wasm: false }
    }
  )
  const bridge = new vm.Script(BRIDGE_SOURCE, {
    filename: 'fan-browser-bridge.js'
  }).runInContext(context)

  let finished = false
  const pump = () => {
    if (finished) return
    for (const encoded of parseBridgeBatch(bridge.takeRequests())) {
      const request = JSON.parse(String(encoded || '{}'))
      parentPort.postMessage({
        type: 'request',
        requestId: String(request.requestId || ''),
        method: String(request.method || ''),
        args: request.args
      })
    }
    for (const encoded of parseBridgeBatch(bridge.takeLogs())) {
      const entry = JSON.parse(String(encoded || '{}'))
      parentPort.postMessage({
        type: 'log',
        level: String(entry.level || 'log'),
        values: Array.isArray(entry.values) ? entry.values : []
      })
    }
  }

  parentPort.on('message', message => {
    if (finished || !message || message.type !== 'response') return
    bridge.settle(JSON.stringify({
      requestId: String(message.requestId || ''),
      ok: message.ok === true,
      result: message.result,
      error: message.error
    }))
    pump()
  })

  // Keep the bridge exclusively in this host closure. Passing it as a VM
  // function argument made it reachable through the model function's lexical
  // `arguments[0]`, even when its randomized global property had been deleted.
  // A strict ordinary function gives model code its own empty arguments object;
  // there is no bridge identifier or host value in the VM global to discover.
  const source = `
    'use strict';
    (async function fanBrowserModelProgram() {
      'use strict';
      ${String(workerData?.code || '')}
    }).call(undefined)
  `
  const script = new vm.Script(source, { filename: 'fan-browser-program.js' })
  const timer = setInterval(pump, 1)
  try {
    let outcome
    try {
      const value = await script.runInContext(context)
      await bridge.waitForIdle()
      outcome = JSON.parse(String(bridge.serializeCompletion(value) || '{}'))
    } catch (error) {
      outcome = JSON.parse(String(bridge.serializeFailure(error) || '{}'))
    }
    pump()
    finished = true
    parentPort.postMessage(outcome)
  } finally {
    finished = true
    clearInterval(timer)
    parentPort.close()
  }
}

void execute().catch(error => {
  parentPort.postMessage({ type: 'failed', error: safeHostError(error) })
  parentPort.close()
})
