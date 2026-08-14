const { EVENT_TYPES } = require('../events/event-types.cjs')

class TargetManager {
  constructor({ id, client, eventBus }) {
    this.id = String(id)
    this.client = client
    this.eventBus = eventBus
    this.started = false
    this.targets = new Map()
    this.sessions = new Map()
    // TAB-04:target→挂在其上的 sessionId 集合(引用计数,对齐 _target_sessions)。
    // 只有当某 target 的最后一个 session detach 时才删该 target,避免多 session 共享时误删。
    this.targetSessions = new Map()
    this._offMessage = null
    this._offDetached = null
    this._startPromise = null
    this._lifecycleGeneration = 0
  }

  async start() {
    if (this.started) return true
    if (this._startPromise) return this._startPromise
    const generation = this._lifecycleGeneration
    this._startPromise = (async () => {
      const offMessage = this.eventBus?.on(EVENT_TYPES.CDP_MESSAGE, event => {
        const payload = event.payload || {}
        if (payload.id !== this.id) return
        this._handleMessage(payload.method, payload.params, payload.sessionId)
      })
      const offDetached = this.eventBus?.on(EVENT_TYPES.CDP_DETACHED, event => {
        const payload = event.payload || {}
        if (payload.id !== this.id) return
        this._resetAfterDetach()
      })
      this._offMessage = offMessage
      this._offDetached = offDetached
      const discardStaleStart = () => {
        if (typeof offMessage === 'function') offMessage()
        if (typeof offDetached === 'function') offDetached()
        if (this._offMessage === offMessage) this._offMessage = null
        if (this._offDetached === offDetached) this._offDetached = null
      }
      const isCurrentStart = () => (
        generation === this._lifecycleGeneration &&
        this._offMessage === offMessage &&
        this._offDetached === offDetached
      )
      try {
        await this.client.send('Target.setDiscoverTargets', { discover: true })
        if (!isCurrentStart()) {
          discardStaleStart()
          return false
        }
        await this.client.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        })
        if (!isCurrentStart()) {
          discardStaleStart()
          return false
        }
        this.started = true
        return true
      } catch {
        // Do not latch a transient CDP failure forever. Main-target actions can
        // continue, and the next prepare() call will retry target discovery.
        discardStaleStart()
        if (generation === this._lifecycleGeneration) this.started = false
        return false
      }
    })()
    try {
      return await this._startPromise
    } finally {
      this._startPromise = null
    }
  }

  stop() {
    this._lifecycleGeneration += 1
    if (this._offMessage) {
      this._offMessage()
      this._offMessage = null
    }
    if (this._offDetached) {
      this._offDetached()
      this._offDetached = null
    }
    this.targets.clear()
    this.sessions.clear()
    this.targetSessions.clear()
    this.started = false
  }

  _resetAfterDetach() {
    this._lifecycleGeneration += 1
    if (this._offMessage) this._offMessage()
    if (this._offDetached) this._offDetached()
    this._offMessage = null
    this._offDetached = null
    this.targets.clear()
    this.sessions.clear()
    this.targetSessions.clear()
    this.started = false
  }

  _handleMessage(method, params = {}, sessionId) {
    if (method === 'Target.targetCreated' && params.targetInfo?.targetId) {
      this.targets.set(params.targetInfo.targetId, params.targetInfo)
    } else if (method === 'Target.targetInfoChanged' && params.targetInfo?.targetId) {
      this.targets.set(params.targetInfo.targetId, params.targetInfo)
    } else if (method === 'Target.targetDestroyed' && params.targetId) {
      // 浏览器告知 target 已亡:无条件清 target + 反查 sessions + 引用计数表。
      this.targets.delete(params.targetId)
      this.targetSessions.delete(params.targetId)
      for (const [sid, targetId] of this.sessions.entries()) {
        if (targetId === params.targetId) this.sessions.delete(sid)
      }
    } else if (method === 'Target.attachedToTarget' && params.sessionId) {
      const targetId = params.targetInfo?.targetId || ''
      this.sessions.set(params.sessionId, targetId)
      if (targetId) {
        this.targets.set(targetId, params.targetInfo)
        let set = this.targetSessions.get(targetId)
        if (!set) { set = new Set(); this.targetSessions.set(targetId, set) }
        set.add(params.sessionId)
      }
    } else if (method === 'Target.detachedFromTarget' && params.sessionId) {
      // TAB-04:引用计数 detach——只有该 target 的最后一个 session 走了才删 target
      // (对齐 remaining_sessions==0 才删;多 session 共享时不误删)。
      const targetId = this.sessions.get(params.sessionId)
      this.sessions.delete(params.sessionId)
      if (targetId && this.targetSessions.has(targetId)) {
        const set = this.targetSessions.get(targetId)
        set.delete(params.sessionId)
        if (set.size === 0) {
          this.targetSessions.delete(targetId)
          this.targets.delete(targetId)
        }
      }
    } else if (sessionId && !this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, '')
    }
  }

  snapshot() {
    return {
      targets: Array.from(this.targets.values()),
      sessions: Array.from(this.sessions.entries()).map(([sessionId, targetId]) => ({ sessionId, targetId }))
    }
  }

  attachedTargets() {
    return Array.from(this.sessions.entries())
      .map(([sessionId, targetId]) => ({
        sessionId,
        targetId,
        target: this.targets.get(targetId) || null
      }))
      .filter(item => {
        const type = String(item.target?.type || '').toLowerCase()
        return ['iframe', 'page', 'tab'].includes(type)
      })
  }

  resolveTarget(identifier) {
    const value = String(identifier || '').trim()
    if (!value) return null
    if (this.targets.has(value)) {
      return { targetId: value, target: this.targets.get(value), ambiguous: false }
    }
    const matches = Array.from(this.targets.values()).filter(target => String(target.targetId || '').endsWith(value))
    if (matches.length === 1) {
      return { targetId: matches[0].targetId, target: matches[0], ambiguous: false }
    }
    if (matches.length > 1) {
      return { targetId: '', target: null, ambiguous: true, matches }
    }
    return null
  }
}

module.exports = { TargetManager }
