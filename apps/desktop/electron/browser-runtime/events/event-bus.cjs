class BrowserRuntimeEventBus {
  constructor({ maxHistory = 500, sanitize, retain } = {}) {
    this.maxHistory = maxHistory
    this.sanitize = typeof sanitize === 'function' ? sanitize : (_type, payload) => payload
    this.retain = typeof retain === 'function' ? retain : () => true
    this.handlers = new Map()
    this.history = []
  }

  emit(type, payload = {}) {
    let safePayload
    try {
      safePayload = this.sanitize(type, payload)
    } catch {
      // Event payloads can contain credentials, request bodies or page text.
      // If sanitization fails, discard the payload instead of leaking it or
      // breaking the browser operation that emitted the event.
      safePayload = { redacted: true, reason: 'event-sanitization-failed' }
    }
    const event = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      payload: safePayload,
      timestamp: Date.now()
    }
    let shouldRetain = false
    try {
      shouldRetain = this.retain(type, safePayload)
    } catch {
      shouldRetain = false
    }
    if (shouldRetain) {
      this.history.push(event)
      if (this.history.length > this.maxHistory) {
        this.history.splice(0, this.history.length - this.maxHistory)
      }
    }

    const handlers = this.handlers.get(type) || []
    for (const handler of handlers) {
      try {
        handler(event)
      } catch {
        // Event observers must not break browser automation.
      }
    }
    return event
  }

  on(type, handler) {
    const handlers = this.handlers.get(type) || []
    handlers.push(handler)
    this.handlers.set(type, handlers)
    return () => {
      const current = this.handlers.get(type) || []
      this.handlers.set(type, current.filter(item => item !== handler))
    }
  }

  getHistory(limit = 100) {
    return this.history.slice(-Math.max(0, Number(limit) || 0))
  }
}

module.exports = { BrowserRuntimeEventBus }
