function limiterError(message, code, statusCode = 503) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

const ACCEPTED_SESSION_WORK_WAIT_MAX_MS = 4000

// Lease state is intentionally kept outside both the lease object and limiter
// instances. Callers receive a frozen, property-free capability that cannot be
// reconstructed from a session id or serialized across a process boundary.
const LEASE_STATES = new WeakMap()

class BrowserTaskLimiter {
  constructor({ maxConcurrent = 4, maxQueued = 128 } = {}) {
    this.maxConcurrent = Math.max(1, Number(maxConcurrent) || 4)
    const queued = Number(maxQueued)
    this.maxQueued = Math.max(0, Number.isFinite(queued) ? queued : 128)
    this.active = 0
    this.activeSessions = new Set()
    // A timed-out/interrupted wrapper may return before its underlying browser
    // effect settles. Keep that session fenced without consuming a global
    // concurrency slot forever; actionStatus/endControl/etc. bypass this
    // limiter at the RPC layer and remain available for recovery.
    this.blockedSessions = new Map()
    this.queue = []
    this.activeLeaseStates = new Set()
    this.closed = false
  }

  run(sessionId, task) {
    return this._enqueue(sessionId, task, false)
  }

  runWithLease(sessionId, task) {
    return this._enqueue(sessionId, task, true)
  }

  executeWithinLease(lease, sessionId, task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'))
    const state = lease && typeof lease === 'object' ? LEASE_STATES.get(lease) : null
    if (!state || state.owner !== this) {
      return Promise.reject(limiterError('Browser run lease is invalid', 'BROWSER_LEASE_INVALID', 403))
    }
    const key = String(sessionId || 'main')
    if (state.sessionId !== key) {
      return Promise.reject(limiterError(
        `Browser run lease belongs to session '${state.sessionId}', not '${key}'`,
        'BROWSER_LEASE_SESSION_MISMATCH',
        409
      ))
    }
    if (this.closed) {
      return Promise.reject(limiterError('Browser task limiter is closed', 'BROWSER_QUEUE_CLOSED'))
    }
    if (!state.accepting) {
      return Promise.reject(limiterError('Browser run lease has been released', 'BROWSER_LEASE_RELEASED', 409))
    }
    if (this.blockedSessions.has(key)) {
      return Promise.reject(this._sessionSettlingError(key))
    }

    const scheduled = state.tail.then(() => {
      if (this.closed) throw limiterError('Browser task limiter is closed', 'BROWSER_QUEUE_CLOSED')
      if (this.blockedSessions.has(key)) throw this._sessionSettlingError(key)
      return Promise.resolve().then(task)
    })
    // A failed step must reject its own caller without poisoning the lease
    // queue. Program code may catch that failure and deliberately request a
    // recovery observation as the next step.
    state.tail = scheduled.then(() => undefined, () => undefined)
    return scheduled
  }

  blockSessionUntil(sessionId, settlement) {
    const key = String(sessionId || 'main')
    const token = Object.freeze(Object.create(null))
    let blockers = this.blockedSessions.get(key)
    if (!blockers) {
      blockers = new Set()
      this.blockedSessions.set(key, blockers)
    }
    blockers.add(token)

    // Work queued before the uncertain outcome was known must not slip through
    // when the current limiter slot is eventually released.
    const retained = []
    for (const item of this.queue) {
      if (item.sessionId === key) {
        item.reject(this._sessionSettlingError(key))
      } else {
        retained.push(item)
      }
    }
    this.queue = retained

    if (settlement && typeof settlement.then === 'function') {
      void Promise.resolve(settlement).then(
        () => this._releaseSessionBlock(key, token),
        () => this._releaseSessionBlock(key, token)
      )
    }
    return token
  }

  isSessionBlocked(sessionId) {
    return this.blockedSessions.has(String(sessionId || 'main'))
  }

  async waitForSessionUnblocked(sessionId, timeoutMs = 1000) {
    const key = String(sessionId || 'main')
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    while (this.blockedSessions.has(key)) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return false
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remainingMs)))
    }
    return true
  }

  async waitForAcceptedSessionWork(
    sessionId,
    ignoredBlockers = null,
    timeoutMs = ACCEPTED_SESSION_WORK_WAIT_MAX_MS
  ) {
    const key = String(sessionId || 'main')
    const requestedTimeoutMs = Number(timeoutMs)
    const waitBudgetMs = Math.max(
      0,
      Math.min(
        ACCEPTED_SESSION_WORK_WAIT_MAX_MS,
        Number.isFinite(requestedTimeoutMs)
          ? requestedTimeoutMs
          : ACCEPTED_SESSION_WORK_WAIT_MAX_MS
      )
    )
    const deadline = Date.now() + waitBudgetMs
    while (true) {
      const blockers = this.blockedSessions.get(key)
      const hasOtherBlocker = blockers
        ? [...blockers].some(token => (
            ignoredBlockers instanceof Set
              ? !ignoredBlockers.has(token)
              : token !== ignoredBlockers
          ))
        : false
      if (!this.activeSessions.has(key) && !hasOtherBlocker) return
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        const error = limiterError(
          `Browser session '${key}' still has accepted work at the control boundary`,
          'BROWSER_CONTROL_BOUNDARY_TIMEOUT',
          409
        )
        error.details = {
          retryable: true,
          replanRequired: true,
          beforeDispatch: true,
          dispatchAttempted: false,
          reason: 'accepted-browser-work-still-running'
        }
        throw error
      }
      // Control-boundary requests bypass the ordinary queue so they can stop
      // admission immediately, but native work accepted before that boundary
      // remains authoritative. Never expose the page to the user until it has
      // actually settled.
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remainingMs)))
    }
  }

  cancelQueuedSession(sessionId, {
    code = 'BROWSER_SESSION_QUEUE_CANCELLED',
    message = 'Queued browser work was cancelled at a control boundary',
    reason = 'browser-control-boundary'
  } = {}) {
    const key = String(sessionId || 'main')
    let cancelled = 0
    const retained = []
    for (const item of this.queue) {
      if (item.sessionId !== key) {
        retained.push(item)
        continue
      }
      const error = limiterError(String(message), String(code), 409)
      error.details = {
        retryable: false,
        replanRequired: true,
        reason: String(reason)
      }
      item.reject(error)
      cancelled += 1
    }
    this.queue = retained
    return cancelled
  }

  cancelAllQueued(options = {}) {
    const sessions = [...new Set(this.queue.map(item => item.sessionId))]
    let cancelled = 0
    for (const sessionId of sessions) {
      cancelled += this.cancelQueuedSession(sessionId, options)
    }
    return cancelled
  }

  _sessionSettlingError(sessionId) {
    const error = limiterError(
      `Browser session '${sessionId}' still has an unsettled action`,
      'BROWSER_SESSION_ACTION_SETTLING',
      409
    )
    error.details = {
      retryable: true,
      replanRequired: true,
      reason: 'underlying-action-still-settling'
    }
    return error
  }

  _releaseSessionBlock(sessionId, token) {
    const blockers = this.blockedSessions.get(sessionId)
    if (!blockers) return
    blockers.delete(token)
    if (blockers.size) return
    this.blockedSessions.delete(sessionId)
    if (!this.closed) this._drain()
  }

  _enqueue(sessionId, task, withLease) {
    if (this.closed) return Promise.reject(limiterError('Browser task limiter is closed', 'BROWSER_QUEUE_CLOSED'))
    if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'))
    const key = String(sessionId || 'main')
    if (this.blockedSessions.has(key)) {
      return Promise.reject(this._sessionSettlingError(key))
    }
    const canStartImmediately = this.active < this.maxConcurrent && !this.activeSessions.has(key)
    if (!canStartImmediately && this.queue.length >= this.maxQueued) {
      return Promise.reject(limiterError('Browser task queue is full', 'BROWSER_QUEUE_FULL', 429))
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ sessionId: key, task, withLease, resolve, reject })
      this._drain()
    })
  }

  close() {
    this.closed = true
    for (const state of this.activeLeaseStates) state.accepting = false
    this.blockedSessions.clear()
    while (this.queue.length) {
      this.queue.shift().reject(limiterError('Browser task limiter is closed', 'BROWSER_QUEUE_CLOSED'))
    }
  }

  _drain() {
    if (this.closed) return
    while (this.active < this.maxConcurrent) {
      const index = this.queue.findIndex(item => (
        !this.activeSessions.has(item.sessionId) &&
        !this.blockedSessions.has(item.sessionId)
      ))
      if (index < 0) return
      const [item] = this.queue.splice(index, 1)
      this.active += 1
      this.activeSessions.add(item.sessionId)
      Promise.resolve()
        .then(async () => {
          if (this.closed) {
            throw limiterError('Browser task limiter is closed', 'BROWSER_QUEUE_CLOSED')
          }
          if (!item.withLease) return item.task()

          const lease = Object.freeze(Object.create(null))
          const state = {
            owner: this,
            sessionId: item.sessionId,
            accepting: true,
            tail: Promise.resolve()
          }
          LEASE_STATES.set(lease, state)
          this.activeLeaseStates.add(state)
          try {
            return await item.task(lease)
          } finally {
            // Close admission before draining already-accepted work. This lets a
            // caller launch an internal step without awaiting it while ensuring
            // no late Worker message can extend the lease after the run returns.
            state.accepting = false
            try {
              await state.tail
            } finally {
              this.activeLeaseStates.delete(state)
            }
          }
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1
          this.activeSessions.delete(item.sessionId)
          this._drain()
        })
    }
  }
}

module.exports = { BrowserTaskLimiter }
