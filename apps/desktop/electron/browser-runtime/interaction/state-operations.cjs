'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')

const DETACHED_NODE_ERROR = /(?:could not find|no node|not found|detached|does not belong|cannot find context|session.*closed)/i

function targetSessionId(value) {
  const sessionId = value?.sessionId ?? value?.session_id
  return sessionId == null || sessionId === '' ? null : String(sessionId)
}

function referencePin(element) {
  const index = Number(element?.index)
  const backendNodeId = Number(element?.backendNodeId)
  if (!Number.isSafeInteger(index) || index <= 0 || !Number.isFinite(backendNodeId)) return null
  return Object.freeze({
    index,
    backendNodeId,
    sessionId: targetSessionId(element)
  })
}

class StateOperations {
  /**
   * Capture the real node identity behind every numbered element in one
   * observation. ProgramRunner calls this while it owns the Task Space lease,
   * before model code can perform a side effect. The returned pins contain no
   * page text and cannot be forged by the Worker.
   */
  _captureProgramReferencePins(sessionId, decisionToken) {
    const sid = String(sessionId || 'main').split('#')[0]
    this._assertDecisionToken(
      sid,
      { _fanDecisionToken: decisionToken },
      'program reference capture'
    )
    const entry = this.getWorkbench(this._activeTabId(sid))
    const pins = new Map()
    for (const element of entry.selectorMap?.items?.values?.() || []) {
      const pin = referencePin(element)
      if (pin) pins.set(pin.index, pin)
    }
    return pins
  }

  _normalizeElementStateExpectation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      const error = new Error('waitForState state must be an object')
      error.code = 'BROWSER_ELEMENT_STATE_INVALID'
      throw error
    }
    const keys = Object.keys(value)
    if (!keys.length || keys.some(key => !['attached', 'enabled'].includes(key))) {
      const error = new Error('waitForState supports only attached and enabled state checks')
      error.code = 'BROWSER_ELEMENT_STATE_INVALID'
      throw error
    }
    const expected = {}
    for (const key of keys) {
      if (typeof value[key] !== 'boolean') {
        const error = new Error(`waitForState ${key} must be a boolean`)
        error.code = 'BROWSER_ELEMENT_STATE_INVALID'
        throw error
      }
      expected[key] = value[key]
    }
    if (expected.attached === false && Object.prototype.hasOwnProperty.call(expected, 'enabled')) {
      const error = new Error('waitForState cannot test enabled on a detached element')
      error.code = 'BROWSER_ELEMENT_STATE_INVALID'
      throw error
    }
    return expected
  }

  _normalizePinnedTarget(value, requestedIndex) {
    const pin = referencePin(value)
    if (!pin || pin.index !== Number(requestedIndex)) {
      const error = new Error('waitForState requires a trusted numbered element identity')
      error.code = 'BROWSER_ELEMENT_STATE_UNTRACKABLE'
      error.details = {
        retryable: true,
        replanRequired: true,
        index: Number(requestedIndex)
      }
      throw error
    }
    return pin
  }

  _assertPinnedStateContext(sessionId, expectedToken, index) {
    const sid = String(sessionId || 'main').split('#')[0]
    const current = this._browserDecisionToken(sid)
    const changes = []
    if (String(expectedToken?.sessionId || '') !== sid) changes.push('session')
    if (!current) {
      changes.push('active-browser')
    } else {
      if (String(expectedToken?.activeTabId || '') !== current.activeTabId) changes.push('active-tab')
      if (Number(expectedToken?.viewEpoch) !== current.viewEpoch) changes.push('view-epoch')
      if (
        expectedToken?.documentRevision != null &&
        Number(expectedToken.documentRevision) !== current.documentRevision
      ) changes.push('document-revision')
      if (
        expectedToken?.pageGeneration != null &&
        Number(expectedToken.pageGeneration) !== current.pageGeneration
      ) changes.push('page-generation')
      if (
        expectedToken?.tabListGeneration != null &&
        Number(expectedToken.tabListGeneration) !== current.tabListGeneration
      ) changes.push('tab-list-generation')
    }
    if (!changes.length) return current

    const error = new Error(
      `Element index ${index} no longer belongs to the observed page (${changes.join(', ')}). ` +
      'The state wait stopped; observe again and use a fresh number.'
    )
    error.code = changes.includes('session')
      ? 'BROWSER_SESSION_MISMATCH'
      : 'STALE_ELEMENT_REFERENCE'
    error.details = {
      retryable: true,
      replanRequired: true,
      action: 'waitForState',
      index: Number(index),
      reason: changes.join(','),
      stateChanges: changes,
      expected: expectedToken,
      current
    }
    throw error
  }

  async _inspectPinnedElementState(entry, pin) {
    try {
      const inspected = await this._inspectLiveDisabledState(
        entry,
        {
          index: pin.index,
          backendNodeId: pin.backendNodeId,
          sessionId: pin.sessionId
        },
        pin.sessionId || undefined
      )
      if (!inspected) return { attached: false }
      return {
        attached: true,
        enabled: inspected.disabled !== true,
        disabled: inspected.disabled === true,
        ...(inspected.reason ? { disabledReason: String(inspected.reason).slice(0, 160) } : {})
      }
    } catch (error) {
      if (DETACHED_NODE_ERROR.test(String(error?.message || error || ''))) {
        return { attached: false }
      }
      throw error
    }
  }

  _elementStateMatches(actual, expected) {
    if (Object.prototype.hasOwnProperty.call(expected, 'attached') &&
        actual.attached !== expected.attached) return false
    if (Object.prototype.hasOwnProperty.call(expected, 'enabled')) {
      if (actual.attached !== true || actual.enabled !== expected.enabled) return false
    }
    return true
  }

  async waitForState(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const sessionId = this._sessionIdForEntry(entry)
    const decisionToken = params._fanDecisionToken
    const index = Number(params.index)
    const pin = this._normalizePinnedTarget(params._fanPinnedTarget, index)
    const expected = this._normalizeElementStateExpectation(params.state)
    const timeoutMs = Math.max(100, Math.min(30000, Number(params.timeoutMs) || 5000))
    const pollMs = Math.max(50, Math.min(1000, Number(params.pollMs) || 100))
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs

    this._assertPinnedStateContext(sessionId, decisionToken, index)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, {
      id: entry.id,
      action: 'waitForState',
      index
    })

    try {
      let actual = { attached: false }
      while (true) {
        this._assertNoSessionIntervention(sessionId, 'waitForState')
        this._assertPinnedStateContext(sessionId, decisionToken, index)
        actual = await this._inspectPinnedElementState(entry, pin)
        this._assertPinnedStateContext(sessionId, decisionToken, index)
        if (this._elementStateMatches(actual, expected)) {
          // Publish one authoritative observation only after the condition is
          // true. ProgramRunner will bind the exact pinned backend node to the
          // new generation, so a following type/click never reuses the old N.
          const observation = await this.observe(entry.id, { _fanPassiveRead: true })
          this._assertPinnedStateContext(sessionId, decisionToken, index)
          this._attachDecisionToken(sessionId, observation)
          const result = {
            matched: true,
            elapsedMs: Date.now() - startedAt,
            state: actual,
            targetIdentity: pin,
            observation
          }
          this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, {
            id: entry.id,
            action: 'waitForState',
            result: { matched: true, index, state: actual }
          })
          return result
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          const description = String(params.description || `element index ${index}`).slice(0, 300)
          const error = new Error(
            `Timed out after ${timeoutMs}ms waiting for ${description} state ${JSON.stringify(expected)}`
          )
          error.code = 'BROWSER_ELEMENT_STATE_TIMEOUT'
          error.details = {
            retryable: true,
            replanRequired: true,
            action: 'waitForState',
            index,
            expected,
            actual,
            timeoutMs
          }
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)))
      }
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
        id: entry.id,
        action: 'waitForState',
        error: String(error?.message || error)
      })
      throw error
    }
  }
}

const stateOperationDescriptors = Object.getOwnPropertyDescriptors(StateOperations.prototype)
delete stateOperationDescriptors.constructor

function installStateOperations(Runtime) {
  Object.defineProperties(Runtime.prototype, stateOperationDescriptors)
}

module.exports = { installStateOperations }
