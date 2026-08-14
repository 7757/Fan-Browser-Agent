const { EVENT_TYPES } = require('../events/event-types.cjs')

class DebuggerClient {
  constructor({ id, webContents, eventBus, log, commandTimeoutMs }) {
    this.id = String(id)
    this.webContents = webContents
    this.eventBus = eventBus
    this.log = typeof log === 'function' ? log : () => undefined
    this.attached = false
    this.closed = false
    // 单条 CDP 命令超时(对齐 TimeoutWrappedCDPClient 的 60s)。每条 sendCommand
    // 本身都是快返回——导航/加载/打字的等待都在更高层做——所以任何 sendCommand 在 Electron
    // debugger 队列里静默不返回都属异常。无此超时时,卡死的命令只能干等 180s 动作级安全网,
    // 且底层 promise 永挂。命中超时后抛干净错误,让上层动作安全网/自愈接手。
    this.commandTimeoutMs = Number(commandTimeoutMs) > 0 ? Number(commandTimeoutMs) : 60000
    this._onDetach = (_event, reason) => {
      this.attached = false
      this.eventBus?.emit(EVENT_TYPES.CDP_DETACHED, { id: this.id, reason: reason || 'unknown' })
    }
    this._onMessage = (_event, method, params, sessionId) => {
      this.eventBus?.emit(EVENT_TYPES.CDP_MESSAGE, { id: this.id, method, params, sessionId })
    }
  }

  _retiredError() {
    const error = new Error(`Browser workbench ${this.id} has been retired`)
    error.code = 'WORKBENCH_RETIRED'
    error.details = { retryable: false, workbenchId: this.id }
    return error
  }

  _assertOpen() {
    if (this.closed) throw this._retiredError()
  }

  async attach() {
    this._assertOpen()
    if (!this.webContents || this.webContents.isDestroyed()) {
      throw new Error(`Cannot attach CDP: workbench ${this.id} webContents is unavailable`)
    }
    if (!this.webContents.debugger.isAttached()) {
      try {
        this.webContents.debugger.attach('1.3')
      } catch (err) {
        const msg = String((err && err.message) || err)
        // CDP-5:Electron 单 webContents 只允许一个 debugger。用户打开开发者工具/DevTools
        // 会占用该槽位,attach 抛 "Another debugger is already attached to this target"。
        // 转成带 code 的友好错误,让上层提示用户关 DevTools,而非裸抛底层信息。
        if (/already attached/i.test(msg)) {
          this.attached = false
          const friendly = new Error(
            `The browser debugging channel is in use, most likely because DevTools is open for this tab. Close DevTools for the page and retry. Original error: ${msg}`
          )
          friendly.code = 'CDP_DEBUGGER_STOLEN'
          throw friendly
        }
        throw err
      }
    }
    this._assertOpen()
    if (!this.attached) {
      // An external detach leaves our listeners installed. Remove before
      // re-adding so repeated DevTools attach/detach cycles cannot multiply
      // every CDP event and leak listener references.
      this.webContents.debugger.removeListener('detach', this._onDetach)
      this.webContents.debugger.removeListener('message', this._onMessage)
      this.webContents.debugger.on('detach', this._onDetach)
      this.webContents.debugger.on('message', this._onMessage)
      this.attached = true
      this.eventBus?.emit(EVENT_TYPES.CDP_ATTACHED, { id: this.id })
    }
    return true
  }

  _detach(reason = 'runtime.detach') {
    if (!this.webContents) {
      this.attached = false
      return
    }
    // The native debugger is already gone with a destroyed WebContents, but
    // its EventEmitter can still retain our JS closures until we remove them.
    this.webContents.debugger.removeListener('detach', this._onDetach)
    this.webContents.debugger.removeListener('message', this._onMessage)
    if (this.webContents.isDestroyed()) {
      this.attached = false
      return
    }
    try {
      if (this.webContents.debugger.isAttached()) {
        this.webContents.debugger.detach()
      }
    } finally {
      this.attached = false
      this.eventBus?.emit(EVENT_TYPES.CDP_DETACHED, { id: this.id, reason })
    }
  }

  async detach() {
    this._detach()
  }

  async dispose() {
    if (this.closed) return
    // Irreversible and synchronous: stale async continuations observe closed
    // before they get another chance to attach or send a command.
    this.closed = true
    try {
      this._detach('runtime.dispose')
    } finally {
      this.webContents = null
      this.eventBus = null
      this.log = () => undefined
    }
  }

  async send(method, params = {}, sessionId = undefined, timeoutOverrideMs = undefined) {
    this._assertOpen()
    await this.attach()
    this._assertOpen()
    if (!method || typeof method !== 'string') {
      throw new Error('CDP method is required')
    }
    const call = this.webContents.debugger.sendCommand(method, params || {}, sessionId)
    // NAV-6:可选 per-call 超时覆盖(默认仍走 60s commandTimeoutMs)。个别命令(如 Page.navigate)
    // 在慢站点上合理地比 60s 还久或更需更短的超时,由调用方按 BU 默认显式传入。
    const timeoutMs = Number(timeoutOverrideMs) > 0 ? Number(timeoutOverrideMs) : this.commandTimeoutMs
    if (!(timeoutMs > 0)) return call
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`)
        error.code = 'CDP_COMMAND_TIMEOUT'
        error.method = method
        reject(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([call, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

module.exports = { DebuggerClient }
