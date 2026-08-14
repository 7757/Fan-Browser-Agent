'use strict'

const { defaultLiveViewBudget, defaultMemoryBudgetMB } = require('./resource-policy.cjs')

// Inactive tabs are cheap to reconstruct and should not keep a renderer warm for
// long. The active tab of a background session gets a longer return window.
const DEFAULT_INACTIVE_TTL_MS = 60_000
const DEFAULT_BACKGROUND_ACTIVE_TTL_MS = 300_000
const MIN_IDLE_TTL_MS = 30_000
const KEEPALIVE_GRACE_MS = 20_000
const PER_VIEW_COST_MB = 165
const MEMORY_CLEAR_RATIO = 0.9
const GOVERNOR_INTERVAL_MS = 15_000

class BrowserResourceGovernor {
  constructor(options) {
    this._getLiveViewIds = options.getLiveViewIds
    this._getRetentionClass = options.getRetentionClass || (() => 'background-active')
    this._canEvict = options.canEvict
    this._evict = options.evict
    this._getTotalRssMB = options.getTotalRssMB
    this._getTotalMemoryBytes = options.getTotalMemoryBytes
    this._log = options.log || (() => undefined)
    this._now = options.now || Date.now
    this._setInterval = options.setInterval || setInterval
    this._clearInterval = options.clearInterval || clearInterval

    const env = options.env || process.env
    const platform = options.platform || process.platform
    this.liveViewBudget = Math.max(
      2,
      Number(env.FAN_LIVE_VIEW_BUDGET) || defaultLiveViewBudget(this._getTotalMemoryBytes())
    )
    const unifiedIdleTtlMs = Number(env.FAN_VIEW_IDLE_TTL_MS)
    this.inactiveTtlMs = Math.max(
      MIN_IDLE_TTL_MS,
      unifiedIdleTtlMs ||
        Number(env.FAN_INACTIVE_VIEW_IDLE_TTL_MS) ||
        DEFAULT_INACTIVE_TTL_MS
    )
    this.backgroundActiveTtlMs = Math.max(
      MIN_IDLE_TTL_MS,
      unifiedIdleTtlMs ||
        Number(env.FAN_BACKGROUND_ACTIVE_VIEW_IDLE_TTL_MS) ||
        DEFAULT_BACKGROUND_ACTIVE_TTL_MS
    )
    // Kept for existing diagnostics and integrations. When there is no unified
    // override, this represents the longest normal retention window.
    this.idleTtlMs = unifiedIdleTtlMs
      ? Math.max(MIN_IDLE_TTL_MS, unifiedIdleTtlMs)
      : this.backgroundActiveTtlMs
    this.pressureEnabled =
      env.FAN_MEM_GOVERNOR !== undefined
        ? env.FAN_MEM_GOVERNOR !== '0'
        : platform !== 'darwin'
    this._memoryBudgetOverrideMB = Number(env.FAN_MEM_BUDGET_MB)
    this._lastActive = new Map()
    this._memoryBudgetMB = 0
    this._timer = null
  }

  touch(viewId, reasonOrAt = 'unspecified', at = this._now()) {
    const legacyNumericTime = typeof reasonOrAt === 'number'
    const touchedAt = legacyNumericTime ? reasonOrAt : at
    const reason = legacyNumericTime
      ? 'legacy'
      : typeof reasonOrAt === 'string' && reasonOrAt
        ? reasonOrAt
        : 'unspecified'
    this._lastActive.set(String(viewId), { at: touchedAt, reason })
  }

  forget(viewId) {
    this._lastActive.delete(String(viewId))
  }

  isWithinKeepalive(viewId, at = this._now()) {
    return at - this._lastTouchAt(viewId) < KEEPALIVE_GRACE_MS
  }

  resourceState(viewId, at = this._now()) {
    const id = String(viewId)
    const touch = this._lastActive.get(id)
    const retentionClass = this._retentionClass(id)
    const ttlMs =
      retentionClass === 'inactive' ? this.inactiveTtlMs : this.backgroundActiveTtlMs
    const lastTouchAt = touch?.at || 0
    const eligibleAt = lastTouchAt + ttlMs
    return {
      lastTouchAt,
      lastTouchReason: touch?.reason || 'unknown',
      retentionClass,
      ttlMs,
      eligibleAt,
      remainingMs: Math.max(0, eligibleAt - at)
    }
  }

  evictToAdmit() {
    if (this._liveViewCount() < this.liveViewBudget) return 0
    let evicted = 0
    for (const viewId of this._lruCandidates()) {
      if (this._liveViewCount() < this.liveViewBudget) break
      if (this._evict(viewId, 'admit')) evicted += 1
    }
    return evicted
  }

  start() {
    if (this._timer) return
    this._memoryBudgetMB =
      this._memoryBudgetOverrideMB > 0
        ? this._memoryBudgetOverrideMB
        : defaultMemoryBudgetMB(this._getTotalMemoryBytes())
    this._log(
      `view governor ON: liveBudget=${this.liveViewBudget} idleTTL=${this.idleTtlMs}ms ` +
        `inactiveTTL=${this.inactiveTtlMs}ms backgroundActiveTTL=${this.backgroundActiveTtlMs}ms ` +
        `memBudget=${this._memoryBudgetMB}MB pressure=${this.pressureEnabled ? 'on' : 'off'}`
    )
    this._timer = this._setInterval(() => {
      try {
        this._runOnce()
      } catch (error) {
        this._log(`view governor tick failed: ${error?.message || error}`)
      }
    }, GOVERNOR_INTERVAL_MS)
    this._timer?.unref?.()
  }

  stop() {
    if (!this._timer) return
    this._clearInterval(this._timer)
    this._timer = null
  }

  _runOnce() {
    const now = this._now()
    for (const viewId of this._liveViewIds()) {
      if (this.resourceState(viewId, now).remainingMs === 0 && this._canEvict(viewId)) {
        this._evict(viewId, 'idle')
      }
    }

    if (!this.pressureEnabled) return
    const rssMB = this._getTotalRssMB()
    if (rssMB <= this._memoryBudgetMB) return

    const overshootMB = rssMB - this._memoryBudgetMB * MEMORY_CLEAR_RATIO
    const needed = Math.max(1, Math.ceil(overshootMB / PER_VIEW_COST_MB))
    let evicted = 0
    for (const viewId of this._lruCandidates()) {
      if (evicted >= needed) break
      if (this._evict(viewId, 'pressure')) evicted += 1
    }
    if (evicted > 0) {
      this._log(
        `pressure governor: RSS=${Math.round(rssMB)}MB > budget ${this._memoryBudgetMB}MB — ` +
          `evicted ${evicted} view(s)`
      )
    }
  }

  _liveViewIds() {
    return [...this._getLiveViewIds()].map(String)
  }

  _liveViewCount() {
    return this._liveViewIds().length
  }

  _lastTouchAt(viewId) {
    return this._lastActive.get(String(viewId))?.at || 0
  }

  _retentionClass(viewId) {
    return this._getRetentionClass(String(viewId)) === 'inactive'
      ? 'inactive'
      : 'background-active'
  }

  _lruCandidates() {
    return this._liveViewIds()
      .filter(viewId => this._canEvict(viewId))
      .sort((left, right) => {
        // Under a hard admission/memory budget, discard inactive siblings
        // before sacrificing the active tab of any background session. LRU is
        // still the tie-breaker within the same retention class.
        const classPriority = viewId => (this._retentionClass(viewId) === 'inactive' ? 0 : 1)
        return (
          classPriority(left) - classPriority(right) ||
          this._lastTouchAt(left) - this._lastTouchAt(right)
        )
      })
  }
}

module.exports = { BrowserResourceGovernor }
