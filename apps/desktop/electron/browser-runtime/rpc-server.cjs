const http = require('node:http')
const crypto = require('node:crypto')
const { browserRequestBlockReason } = require('./browser-request-guard.cjs')
const { EVENT_TYPES } = require('./events/event-types.cjs')
const { ProgramRunner } = require('./program/program-runner.cjs')
const { BrowserTaskLimiter } = require('./task-limiter.cjs')

const MUTATING_ACTIONS = new Set([
  'switchTarget', 'closeTarget', 'cdp', 'loadStorageState', 'grantPermissions',
  'setNetworkConfig', 'setUrlPolicy', 'acknowledgeIntervention', 'flagIntervention',
  'saveStorageState', 'saveHar', 'saveScreenshot', 'savePdf',
  'startScreencast', 'stopScreencast', 'highlight', 'search', 'navigate', 'click',
  'type', 'fillForm', 'formSubmit', 'scroll', 'scrollToText', 'dropdownOptions', 'select', 'mouse', 'hover', 'focus', 'drag',
  'evaluate', 'evaluateJavaScript', 'element', 'dialog', 'setViewport', 'upload',
  'sendKeys', 'back', 'forward', 'reload', 'newTab', 'switchTab', 'closeTab',
  'programRun'
])
// Stop must not queue behind the page action it is trying to interrupt.
const SERIAL_BYPASS_ACTIONS = new Set([
  'actionStatus', 'health', 'events', 'liveState', 'endControl',
  'programStop', 'programHandoff'
])
const ACTION_LEDGER_TTL_MS = 10 * 60 * 1000
const ACTION_LEDGER_MAX_RECORDS = 32
const ACTION_LEDGER_MAX_PROGRAM_RUNS_PER_SESSION = 32
const ACTION_LEDGER_MAX_PROGRAM_RUNS_GLOBAL = 256
const ACTION_LEDGER_MAX_SESSIONS = 32
const CONTROL_BOUNDARY_WAIT_MAX_MS = 4000
const ACTION_SETTLEMENT_SYMBOL = Symbol.for('fan.browser.action-settlement')
const ACTION_SETTLEMENT_RECOVERY_MS = 250
// ProgramRunner enforces the public 600s ceiling. The tracker gets a small
// private grace so a max-duration run can publish its structured terminal
// result instead of losing a timer race during Worker startup/termination.
const TRACKED_ACTION_HARD_CAP_MS = 605000
const BROWSER_STATE_CHANGE_KEYS = new Set([
  'session', 'active-browser', 'active-tab', 'view-epoch', 'document-revision',
  'page-generation', 'selector-generation', 'tab-list-generation'
])

function stableJson(value, ancestors = new Set()) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (typeof value !== 'object') return JSON.stringify(String(value))
  if (ancestors.has(value)) throw new TypeError('Browser action params must not contain circular references')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableJson(item, ancestors) ?? 'null').join(',')}]`
    }
    const fields = []
    for (const key of Object.keys(value).sort()) {
      const item = stableJson(value[key], ancestors)
      if (item !== undefined) fields.push(`${JSON.stringify(key)}:${item}`)
    }
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function actionRequestFingerprint(actionId, action, params) {
  const canonical = stableJson({
    actionId: String(actionId),
    action: String(action),
    params: params ?? {}
  })
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function actionIdConflict(actionId, action) {
  const error = new Error(`Browser action ID '${actionId}' was reused for a different request`)
  error.code = 'ACTION_ID_CONFLICT'
  error.statusCode = 409
  error.details = {
    retryable: false,
    replanRequired: true,
    action,
    reason: 'action-id-reused-with-different-request'
  }
  return error
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      if (!chunks.length) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function boundedString(value, maxLength = 500) {
  if (value == null) return undefined
  return String(value).slice(0, maxLength)
}

function sanitizeOption(option) {
  if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') {
    return boundedString(option)
  }
  if (!option || typeof option !== 'object' || Array.isArray(option)) return undefined
  const result = {}
  for (const key of ['text', 'value', 'tag', 'role']) {
    const value = boundedString(option[key])
    if (value !== undefined) result[key] = value
  }
  if (Number.isSafeInteger(option.index) && option.index >= 0) result.index = option.index
  for (const key of ['disabled', 'selected']) {
    if (typeof option[key] === 'boolean') result[key] = option[key]
  }
  return Object.keys(result).length ? result : undefined
}

function sanitizeDecisionToken(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const token = {}
  for (const key of ['version', 'pageGeneration', 'selectorGeneration', 'tabListGeneration']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) token[key] = value[key]
  }
  for (const key of ['sessionId', 'activeTabId']) {
    const item = boundedString(value[key], 200)
    if (item !== undefined) token[key] = item
  }
  return Object.keys(token).length ? token : undefined
}

function sanitizeElementSemantics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const semantic = {}
  for (const key of ['role', 'name', 'text', 'tag', 'label']) {
    const item = boundedString(value[key])
    if (item !== undefined) semantic[key] = item
  }
  if (Number.isSafeInteger(value.index) && value.index >= 0) semantic.index = value.index
  return Object.keys(semantic).length ? semantic : undefined
}

function sanitizeErrorDetails(error) {
  const input = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details
    : {}
  const details = {}
  if (Array.isArray(input.options)) {
    const options = input.options.slice(0, 100).map(sanitizeOption).filter(value => value !== undefined)
    if (options.length) details.options = options
  }
  if (Array.isArray(input.stateChanges)) {
    const stateChanges = [...new Set(
      input.stateChanges
        .slice(0, 16)
        .map(value => String(value || '').trim())
        .filter(value => BROWSER_STATE_CHANGE_KEYS.has(value))
    )]
    if (stateChanges.length) details.stateChanges = stateChanges
  }
  for (const key of [
    'retryable', 'retried', 'replanRequired', 'userRetryable',
    'beforeDispatch', 'dispatchAttempted'
  ]) {
    if (typeof input[key] === 'boolean') details[key] = input[key]
  }
  for (const key of [
    'value',
    'expectedValue',
    'text',
    'type',
    'source',
    'action',
    'reason',
    'errorDescription'
  ]) {
    const value = boundedString(input[key])
    if (value !== undefined) details[key] = value
  }
  for (const key of ['requestedUrl', 'validatedUrl']) {
    const value = boundedString(input[key], 2048)
    if (value !== undefined) details[key] = value
  }
  if (Number.isSafeInteger(input.networkErrorCode)) {
    details.networkErrorCode = input.networkErrorCode
  }
  if (Number.isSafeInteger(input.index) && input.index >= 0) details.index = input.index
  const expected = sanitizeDecisionToken(input.expected) || sanitizeElementSemantics(input.expected)
  const current = sanitizeDecisionToken(input.current)
  const actual = sanitizeElementSemantics(input.actual)
  if (expected) details.expected = expected
  if (current) details.current = current
  if (actual) details.actual = actual
  const decision = error?.decision
  if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
    const urlPolicy = {}
    if (typeof decision.allowed === 'boolean') urlPolicy.allowed = decision.allowed
    for (const key of ['reason', 'host']) {
      const value = boundedString(decision[key])
      if (value !== undefined) urlPolicy[key] = value
    }
    const url = boundedString(decision.url, 2048)
    if (url !== undefined) urlPolicy.url = url
    if (Object.keys(urlPolicy).length) details.urlPolicy = urlPolicy
  }
  return Object.keys(details).length ? details : undefined
}

function serializeRpcError(error) {
  const payload = { ok: false, error: error?.message || String(error) }
  const code = boundedString(error?.code, 80)
  if (code && /^[A-Za-z0-9_.-]+$/.test(code)) payload.errorCode = code
  const details = sanitizeErrorDetails(error)
  if (details) payload.errorDetails = details
  return payload
}

function createBrowserRuntimeRpcServer({
  runtime,
  token,
  log,
  protectedFileRoots = [],
  programRunnerOptions = {},
  actionSettlementRecoveryMs = ACTION_SETTLEMENT_RECOVERY_MS,
  trackedActionHardCapMs = TRACKED_ACTION_HARD_CAP_MS,
  programRunLedgerMaxPerSession = ACTION_LEDGER_MAX_PROGRAM_RUNS_PER_SESSION,
  programRunLedgerMaxGlobal = ACTION_LEDGER_MAX_PROGRAM_RUNS_GLOBAL,
  controlBoundaryWaitMs = CONTROL_BOUNDARY_WAIT_MAX_MS
}) {
  if (!runtime) throw new Error('runtime is required')
  if (!token) throw new Error('token is required')
  const logger = typeof log === 'function' ? log : () => undefined
  const limiter = new BrowserTaskLimiter({ maxConcurrent: 4, maxQueued: 128 })
  const actionLedger = new Map()
  const recoveryWindowMs = Math.max(
    0,
    Math.min(5000, Number(actionSettlementRecoveryMs) || 0)
  )
  const executionHardCapMs = Math.max(
    100,
    Math.min(TRACKED_ACTION_HARD_CAP_MS, Number(trackedActionHardCapMs) || TRACKED_ACTION_HARD_CAP_MS)
  )
  const programRunLimitPerSession = Math.max(
    1,
    Math.min(
      ACTION_LEDGER_MAX_PROGRAM_RUNS_PER_SESSION,
      Number(programRunLedgerMaxPerSession) || ACTION_LEDGER_MAX_PROGRAM_RUNS_PER_SESSION
    )
  )
  const programRunLimitGlobal = Math.max(
    1,
    Math.min(
      ACTION_LEDGER_MAX_PROGRAM_RUNS_GLOBAL,
      Number(programRunLedgerMaxGlobal) || ACTION_LEDGER_MAX_PROGRAM_RUNS_GLOBAL
    )
  )
  const controlBoundaryWaitBudgetMs = Math.max(
    1,
    Math.min(
      CONTROL_BOUNDARY_WAIT_MAX_MS,
      Number(controlBoundaryWaitMs) || CONTROL_BOUNDARY_WAIT_MAX_MS
    )
  )

  const waitWithin = async (promise, timeoutMs) => {
    const budgetMs = Math.max(0, Number(timeoutMs) || 0)
    if (budgetMs <= 0) return { settled: false, value: undefined }
    let timer = null
    try {
      return await Promise.race([
        Promise.resolve(promise).then(value => ({ settled: true, value })),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ settled: false, value: undefined }), budgetMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const settlementOutcome = error => {
    const settlement = error?.[ACTION_SETTLEMENT_SYMBOL]
    if (!settlement || typeof settlement !== 'object') return null
    if (settlement.state === 'fulfilled') {
      return Promise.resolve({ status: 'fulfilled', value: settlement.value })
    }
    if (settlement.state === 'rejected') {
      return Promise.resolve({ status: 'rejected', error: settlement.error })
    }
    if (!settlement.promise || typeof settlement.promise.then !== 'function') return null
    return Promise.resolve(settlement.promise)
      .catch(() => undefined)
      .then(() => {
        if (settlement.state === 'fulfilled') {
          return { status: 'fulfilled', value: settlement.value }
        }
        if (settlement.state === 'rejected') {
          return { status: 'rejected', error: settlement.error }
        }
        // A malformed handoff must fail closed: do not release a session fence
        // merely because its bookkeeping Promise resolved without a terminal
        // underlying action outcome.
        return new Promise(() => undefined)
      })
  }

  const trimLedger = (ledger, now = Date.now()) => {
    for (const [actionId, record] of ledger) {
      const terminal = record?.status === 'completed' || record?.status === 'failed'
      if (terminal && record.finishedAt && now - record.finishedAt >= ACTION_LEDGER_TTL_MS) {
        ledger.delete(actionId)
      }
    }
    if (ledger.size <= ACTION_LEDGER_MAX_RECORDS) return
    // A single browser program may legitimately create up to 200 step
    // records. Never let those child records evict their own completed
    // programRun idempotency record; otherwise retrying the same run ID could
    // replay the entire transaction. Evict ordinary terminal actions first.
    for (const [actionId, record] of ledger) {
      if (ledger.size <= ACTION_LEDGER_MAX_RECORDS) break
      if (record?.status === 'running' || record?.status === 'queued') continue
      if (record?.action === 'programRun') continue
      ledger.delete(actionId)
    }
    // Queued/running records are already bounded by BrowserTaskLimiter. Allow
    // them—and every unexpired programRun idempotency record—to exceed this
    // soft target. A count cap must never make a still-valid run replayable.
  }

  const pruneActionLedgers = (now = Date.now()) => {
    for (const [sessionId, ledger] of actionLedger) {
      trimLedger(ledger, now)
      if (!ledger.size) actionLedger.delete(sessionId)
    }
    if (actionLedger.size <= ACTION_LEDGER_MAX_SESSIONS) return
    for (const [sessionId, ledger] of actionLedger) {
      if (actionLedger.size <= ACTION_LEDGER_MAX_SESSIONS) break
      const hasActiveAction = [...ledger.values()].some(record => (
        record?.status === 'running' || record?.status === 'queued'
      ))
      const hasRetainedProgramRun = [...ledger.values()].some(record => (
        record?.action === 'programRun' &&
        (record.status === 'completed' || record.status === 'failed')
      ))
      if (!hasActiveAction && !hasRetainedProgramRun) actionLedger.delete(sessionId)
    }
  }

  const ledgerFor = sessionId => {
    const key = String(sessionId || 'main')
    pruneActionLedgers()
    let ledger = actionLedger.get(key)
    if (!ledger) {
      ledger = new Map()
      actionLedger.set(key, ledger)
    } else {
      // Map insertion order doubles as a small LRU for the global session cap.
      actionLedger.delete(key)
      actionLedger.set(key, ledger)
    }
    return ledger
  }

  const countProgramRuns = ledger => [...ledger.values()].filter(record => (
    record?.action === 'programRun'
  )).length

  const programRunCapacityError = scope => {
    const error = new Error(
      scope === 'session'
        ? 'Browser program idempotency capacity is full for this session'
        : 'Browser program idempotency capacity is full'
    )
    error.code = 'BROWSER_PROGRAM_RUN_LEDGER_FULL'
    error.statusCode = 429
    error.details = {
      retryable: true,
      replanRequired: false,
      beforeDispatch: true,
      dispatchAttempted: false,
      action: 'programRun',
      reason: scope === 'session'
        ? 'program-run-ledger-session-capacity'
        : 'program-run-ledger-global-capacity'
    }
    return error
  }

  const assertProgramRunCapacity = (sessionId, ledger) => {
    if (countProgramRuns(ledger) >= programRunLimitPerSession) {
      throw programRunCapacityError('session')
    }
    let total = 0
    for (const candidate of actionLedger.values()) {
      total += countProgramRuns(candidate)
      if (total >= programRunLimitGlobal) {
        if (!ledger.size) actionLedger.delete(String(sessionId || 'main'))
        throw programRunCapacityError('global')
      }
    }
  }

  const actionStatus = payload => {
    const sessionId = String(payload.id || payload.workbenchId || 'main').split('#')[0]
    const actionId = String(payload.actionId || payload.action_id || payload.params?.actionId || payload.params?.action_id || '')
    if (!actionId) return { status: 'unknown', actionId: '' }
    pruneActionLedgers()
    const ledger = actionLedger.get(sessionId)
    if (ledger) {
      actionLedger.delete(sessionId)
      actionLedger.set(sessionId, ledger)
    }
    const record = ledger?.get(actionId)
    if (!record) return { status: 'unknown', actionId }
    return {
      actionId,
      action: record.action,
      status: record.status,
      startedAt: record.startedAt || null,
      finishedAt: record.finishedAt || null,
      ...(record.status === 'completed' ? { result: record.result } : {}),
      ...(record.status === 'failed' ? { error: serializeRpcError(record.error) } : {})
    }
  }

  const executeTracked = ({
    payload,
    sessionId,
    action,
    actionId = crypto.randomUUID(),
    schedule,
    operation,
    settlementRecoveryMs = 0
  }) => {
    const resolvedActionId = String(actionId || crypto.randomUUID())
    const requestFingerprint = actionRequestFingerprint(
      resolvedActionId,
      action,
      payload.params
    )
    const ledger = ledgerFor(sessionId)
    const existing = ledger.get(resolvedActionId)
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw actionIdConflict(resolvedActionId, action)
      }
      if (existing.status === 'completed') return existing.result
      if (existing.status === 'failed') throw existing.error
      return existing.promise
    }
    if (action === 'programRun') {
      try {
        assertProgramRunCapacity(sessionId, ledger)
      } catch (error) {
        if (!ledger.size) actionLedger.delete(String(sessionId || 'main'))
        throw error
      }
    }

    const record = {
      action,
      actionId: resolvedActionId,
      requestFingerprint,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      promise: null
    }
    payload.actionId = resolvedActionId
    let responseSettled = false
    let resolveResponse
    let rejectResponse
    record.promise = new Promise((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    const resolvePublic = value => {
      if (responseSettled) return
      responseSettled = true
      resolveResponse(value)
    }
    const rejectPublic = error => {
      if (responseSettled) return
      responseSettled = true
      rejectResponse(error)
    }
    const finish = outcome => {
      if (record.status === 'completed' || record.status === 'failed') return
      if (outcome.status === 'fulfilled') {
        record.status = 'completed'
        record.result = outcome.value
        resolvePublic(outcome.value)
      } else {
        record.status = 'failed'
        record.error = outcome.error
        rejectPublic(outcome.error)
      }
      record.finishedAt = Date.now()
      trimLedger(ledger)
      pruneActionLedgers()
    }
    ledger.set(resolvedActionId, record)

    let scheduled
    try {
      scheduled = schedule(async lease => {
        record.status = 'running'
        record.startedAt = Date.now()
        const hardDeadline = record.startedAt + executionHardCapMs
        const operationOutcome = Promise.resolve()
          .then(() => operation(lease))
          .then(
            value => ({ status: 'fulfilled', value }),
            error => ({ status: 'rejected', error })
          )
        // This Promise represents the actual underlying terminal outcome, not a
        // timeout/intervention wrapper that won Promise.race first.
        const eventualOutcome = operationOutcome.then(outcome => (
          settlementOutcome(
            outcome.status === 'fulfilled' ? outcome.value : outcome.error
          ) || outcome
        ))

        const initial = await waitWithin(
          operationOutcome,
          hardDeadline - Date.now()
        )
        if (!initial.settled) {
          const error = new Error(
            `Browser action '${action}' exceeded the ${executionHardCapMs}ms tracked execution hard cap`
          )
          error.code = 'ACTION_TIMEOUT_PENDING'
          error.details = {
            retryable: false,
            replanRequired: true,
            action,
            reason: 'tracked-operation-hard-cap'
          }
          limiter.blockSessionUntil(sessionId, eventualOutcome)
          rejectPublic(error)
          void eventualOutcome.then(finish)
          logger(`browser runtime tracked action hit hard cap: ${sessionId}:${action}:${resolvedActionId}`)
          return undefined
        }

        const outcome = initial.value
        if (outcome.status === 'fulfilled') {
          const wrappedSettlement = settlementOutcome(outcome.value)
          if (wrappedSettlement) {
            // Human intervention is a terminal public result, but the action
            // that lost the race may still be inside CDP. Preserve the
            // structured needs-human response while fencing this session until
            // that exact action settles. Its late result is intentionally not
            // allowed to overwrite the intervention boundary in the ledger.
            limiter.blockSessionUntil(sessionId, eventualOutcome)
            finish(outcome)
            // The session fence, not a global concurrency slot, owns the late
            // action from here. Healthy Task Spaces must not wait behind an
            // abandoned native action.
            return outcome.value
          }
          finish(outcome)
          return outcome.value
        }

        const wrappedSettlement = settlementOutcome(outcome.error)
        if (!wrappedSettlement) {
          if (
            outcome.error?.code === 'ACTION_TIMEOUT_PENDING' ||
            outcome.error?.code === 'HUMAN_INTERVENTION_PENDING'
          ) {
            // A wrapper that claims an in-flight effect but omits the private
            // handoff cannot be proven safe. Return promptly and permanently
            // fence this session instead of silently admitting another action.
            limiter.blockSessionUntil(sessionId, null)
            rejectPublic(outcome.error)
            logger(`browser runtime wrapper omitted settlement handoff: ${sessionId}:${action}:${resolvedActionId}`)
            return undefined
          }
          finish(outcome)
          return undefined
        }

        // Timeout and intervention wrappers return control to their caller, but
        // the exact underlying action remains the source of truth for the ledger
        // and for same-session serialization.
        limiter.blockSessionUntil(sessionId, eventualOutcome)
        if (outcome.error?.code === 'ACTION_TIMEOUT_PENDING') {
          const recoveryBudgetMs = Math.min(
            Math.max(0, Number(settlementRecoveryMs) || 0),
            recoveryWindowMs,
            Math.max(0, hardDeadline - Date.now())
          )
          const recovered = await waitWithin(
            eventualOutcome,
            recoveryBudgetMs
          )
          if (recovered.settled) {
            finish(recovered.value)
            return recovered.value.status === 'fulfilled'
              ? recovered.value.value
              : undefined
          }
        }

        rejectPublic(outcome.error)
        void eventualOutcome.then(finish)
        // Return the limiter slot immediately. The per-session fence remains
        // until eventualOutcome settles, so no same-space action can interleave
        // while unrelated sessions retain the configured concurrency.
        return undefined
      })
    } catch (error) {
      finish({ status: 'rejected', error })
      return record.promise
    }

    void Promise.resolve(scheduled).catch(error => {
      // Queue saturation/closure rejects before the task callback starts, so
      // the callback's catch/finally cannot update the idempotency ledger.
      if (record.status === 'queued') {
        finish({ status: 'rejected', error })
      }
    })
    return record.promise
  }

  const snapshotPolicyError = (url, reason) => {
    const error = new Error('Browser page content was withheld by the privacy policy')
    error.code = 'BROWSER_PRIVATE_URL_BLOCKED'
    error.statusCode = 403
    error.details = {
      retryable: false,
      reason: String(reason || 'snapshot-policy'),
      validatedUrl: String(url || '').slice(0, 2048)
    }
    return error
  }

  const snapshotUrl = snapshot => {
    const direct = String(snapshot?.url || '').trim()
    if (direct) return direct
    const active = Array.isArray(snapshot?.tabs)
      ? snapshot.tabs.find(tab => tab && typeof tab === 'object' && tab.current === true)
      : null
    return String(active?.url || '').trim()
  }

  const assertSnapshotAllowed = snapshot => {
    const url = snapshotUrl(snapshot)
    if (!url) throw snapshotPolicyError('', 'missing-active-url')
    const reason = browserRequestBlockReason(url, { protectedFileRoots })
    if (reason) throw snapshotPolicyError(url, reason)
  }

  let programRunner = null
  const executeProgramStep = ({ lease, sessionId, action, params, actionId }) => {
    const payload = {
      action,
      id: sessionId,
      params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
      actionId
    }
    return executeTracked({
      payload,
      sessionId,
      action,
      actionId,
      schedule: task => limiter.executeWithinLease(lease, sessionId, task),
      operation: () => runtime.handleRpc(payload),
      settlementRecoveryMs: recoveryWindowMs
    })
  }

  programRunner = new ProgramRunner({
    ...programRunnerOptions,
    runtime,
    protectedFileRoots,
    assertSnapshotAllowed: (url, context) => {
      const reason = browserRequestBlockReason(url, { protectedFileRoots })
      if (reason) return { allowed: false, reason, context }
      return { allowed: true }
    },
    executeStep: executeProgramStep,
    log: typeof programRunnerOptions.log === 'function' ? programRunnerOptions.log : logger
  })
  const cancelQueuedForControlBoundary = (sessionId, reason, code) => {
    const options = {
      code,
      message: `Queued browser work was cancelled: ${reason}`,
      reason
    }
    if (sessionId) return limiter.cancelQueuedSession(sessionId, options)
    return limiter.cancelAllQueued(options)
  }
  const controlBoundaryTokens = new Set()
  const pendingControlReleases = new Map()
  const beginControlBoundaryFence = sessionId => {
    let release = () => undefined
    const boundary = new Promise(resolve => {
      release = resolve
    })
    const token = limiter.blockSessionUntil(sessionId, boundary)
    controlBoundaryTokens.add(token)
    return {
      token,
      async release() {
        release()
        // blockSessionUntil releases its token in a Promise reaction. Let that
        // reaction run before the control RPC returns and admits the next turn.
        await Promise.resolve()
        controlBoundaryTokens.delete(token)
      }
    }
  }
  const endProgramControl = async (sessionId, controlId, reason) => {
    if (!controlId) {
      return runtime.handleRpc({ action: 'controlState', id: sessionId, params: {} })
    }
    return runtime.handleRpc({
      action: 'endControl',
      id: sessionId,
      params: {
        controlId,
        reason,
        _fanDeferVisualCleanup: true,
        _fanDrainInterventionEvents: true,
        // The logical Agent lease must end before the user can operate the page,
        // while the browser tool itself remains in flight waiting for hand-back.
        // Keep only the cosmetic operating lifetime; the Gateway's ordinary
        // endControl at completion/Stop/finally releases this exact-ID hold.
        _fanPreserveOperatingVisual: true,
        // A user-intervention latch owns the anchor/user-tab metadata until
        // Continue acknowledges it and restores the Agent tab. Ordinary
        // explicit handoffs have no latch, so this is a no-op for them.
        _fanPreserveIntervention: true
      }
    })
  }
  const finishProgramControlRelease = ({
    sessionId,
    controlId,
    reason
  }) => {
    const key = String(sessionId || 'main')
    const existing = pendingControlReleases.get(key)
    if (existing) return existing
    const pending = (async () => {
      while (!limiter.closed) {
        try {
          await limiter.waitForAcceptedSessionWork(
            key,
            controlBoundaryTokens,
            controlBoundaryWaitBudgetMs
          )
          break
        } catch (error) {
          if (error?.code !== 'BROWSER_CONTROL_BOUNDARY_TIMEOUT') throw error
          const current = await runtime.handleRpc({
            action: 'controlState',
            id: key,
            params: {}
          })
          if (
            current?.active !== true ||
            (controlId && String(current?.controlId || '') !== controlId)
          ) {
            return current
          }
          logger(`[browser-control] ${JSON.stringify({
            event: 'native_action.settlement_pending',
            sessionId: key,
            controlId
          })}`)
        }
      }
      if (limiter.closed) return null
      logger(`[browser-control] ${JSON.stringify({
        event: 'native_action.settled',
        sessionId: key,
        controlId
      })}`)
      const control = await endProgramControl(key, controlId, reason)
      logger(`[browser-control] ${JSON.stringify({
        event: 'control.released',
        sessionId: key,
        controlId,
        ended: control?.ended === true
      })}`)
      return control
    })().catch(error => {
      logger(
        `deferred browser control release failed for ${key}: ` +
        `${error?.code || 'BROWSER_CONTROL_RELEASE_FAILED'} ${error?.message || error}`
      )
      return null
    }).finally(() => {
      if (pendingControlReleases.get(key) === pending) {
        pendingControlReleases.delete(key)
      }
    })
    pendingControlReleases.set(key, pending)
    return pending
  }
  const offUserIntervened = runtime.eventBus?.on?.(EVENT_TYPES.USER_INTERVENED, event => {
    const payload = event?.payload || {}
    const rawSession = payload.sessionId || payload.id || payload.workbenchId
    cancelQueuedForControlBoundary(
      rawSession ? String(rawSession).split('#')[0] : '',
      'human-intervention',
      'BROWSER_PROGRAM_USER_INTERVENED'
    )
  }) || null
  const offControlState = runtime.eventBus?.on?.(EVENT_TYPES.CONTROL_STATE, event => {
    const payload = event?.payload || {}
    if (payload.active !== false) return
    const rawSession = payload.sessionId || payload.id || payload.workbenchId
    if (!rawSession) return
    cancelQueuedForControlBoundary(
      String(rawSession).split('#')[0],
      'browser-control-ended',
      'BROWSER_PROGRAM_CONTROL_ENDED'
    )
  }) || null

  const programSnapshot = async (payload, sessionId) => {
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? payload.params
      : {}
    const scope = String(params.scope || 'active_page')
    if (scope !== 'active_page') {
      const error = new Error(`Unsupported browser snapshot scope: ${scope}`)
      error.code = 'BROWSER_SNAPSHOT_SCOPE_UNSUPPORTED'
      error.statusCode = 400
      throw error
    }
    // A snapshot is the recovery boundary for an unknown browser effect, but
    // reading while that exact effect is still running would publish a racy
    // state as "settled". Give the existing settlement fence one short bounded
    // chance to clear; limiter.run then returns a retryable transient error if
    // it is still pending.
    if (limiter.isSessionBlocked(sessionId)) {
      await limiter.waitForSessionUnblocked(
        sessionId,
        Math.min(2000, recoveryWindowMs || ACTION_SETTLEMENT_RECOVERY_MS)
      )
    }
    return limiter.run(sessionId, async () => {
      const observed = await runtime.handleRpc({
        action: 'observe',
        id: sessionId,
        actionId: payload.actionId || payload.action_id,
        params: { _fanPassiveRead: true }
      })
      assertSnapshotAllowed(observed)
      if (params.includeScreenshot !== true && params.include_screenshot !== true) return observed
      const screenshot = await runtime.handleRpc({
        action: 'screenshot',
        id: sessionId,
        actionId: `${payload.actionId || payload.action_id || crypto.randomUUID()}:screenshot`,
        params: {
          format: 'jpeg',
          quality: 90,
          captureBeyondViewport: false,
          includeHighlights: false,
          _fanPassiveRead: true
        }
      })
      const safeScreenshot = screenshot && typeof screenshot === 'object' && !Array.isArray(screenshot)
        ? { ...screenshot }
        : screenshot
      if (safeScreenshot && typeof safeScreenshot === 'object') {
        delete safeScreenshot.__fanDecisionToken
      }
      const afterCapture = await runtime.handleRpc({
        action: 'liveState',
        id: sessionId,
        params: {}
      })
      assertSnapshotAllowed(afterCapture)
      return { ...observed, screenshot: safeScreenshot }
    })
  }

  const controlValidationError = ({
    code,
    message,
    reason,
    expectedControlId,
    currentControlId,
    retryable = false,
    statusCode = 409
  }) => {
    const error = new Error(message)
    error.code = code
    error.statusCode = statusCode
    error.details = {
      retryable,
      replanRequired: true,
      beforeDispatch: true,
      dispatchAttempted: false,
      action: 'programRun',
      reason,
      ...(expectedControlId ? { expectedValue: expectedControlId } : {}),
      ...(currentControlId ? { value: currentControlId } : {})
    }
    return error
  }

  const assertProgramControl = async (sessionId, params) => {
    if (!Object.prototype.hasOwnProperty.call(params, '_fanControlId')) return
    const expectedControlId = typeof params._fanControlId === 'string'
      ? params._fanControlId.trim()
      : ''
    if (!expectedControlId) {
      throw controlValidationError({
        code: 'BROWSER_CONTROL_ID_INVALID',
        message: 'Browser program control ID is invalid',
        reason: 'browser-control-id-invalid'
      })
    }

    let current
    try {
      current = await runtime.handleRpc({
        action: 'controlState',
        id: sessionId,
        params: {}
      })
    } catch {
      throw controlValidationError({
        code: 'BROWSER_CONTROL_STATE_UNAVAILABLE',
        message: 'Browser control state could not be verified',
        reason: 'browser-control-state-unavailable',
        expectedControlId,
        retryable: true,
        statusCode: 503
      })
    }

    const currentControlId = typeof current?.controlId === 'string'
      ? current.controlId
      : ''
    if (current?.active !== true) {
      throw controlValidationError({
        code: 'BROWSER_CONTROL_INACTIVE',
        message: 'Browser Agent control is no longer active',
        reason: 'browser-control-inactive',
        expectedControlId,
        currentControlId
      })
    }
    if (currentControlId !== expectedControlId) {
      throw controlValidationError({
        code: 'BROWSER_CONTROL_ID_MISMATCH',
        message: 'Browser Agent control changed before the program started',
        reason: 'browser-control-id-mismatch',
        expectedControlId,
        currentControlId
      })
    }
  }

  const pendingProgramIntervention = sessionId => {
    const state = runtime.sessionInterventionState(sessionId)
    return state?.interventionPending === true ? state : null
  }

  const promoteProgramIntervention = (result, {
    sessionId,
    runId,
    source
  }) => {
    const humanMetadata = pendingProgramIntervention(sessionId)
    if (!humanMetadata) return result
    return programRunner.interventionBoundaryResult(result, {
      runId,
      humanMetadata,
      source
    })
  }

  const dispatch = async payload => {
    const action = String(payload.action || '')
    if (action === 'actionStatus') return actionStatus(payload)
    const sessionId = String(payload.id || payload.workbenchId || 'main').split('#')[0]
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
      ? payload.params
      : {}

    if (action === 'programSnapshot') return programSnapshot(payload, sessionId)
    if (action === 'programStop') {
      cancelQueuedForControlBoundary(
        sessionId,
        'browser-program-stopped',
        params.code || 'BROWSER_PROGRAM_STOPPED'
      )
      return {
        stopped: programRunner.stop(sessionId, {
          status: 'failed',
          reason: params.reason || 'Browser program stopped by the host',
          code: params.code || 'BROWSER_PROGRAM_STOPPED'
        })
      }
    }
    if (action === 'programHandoff') {
      cancelQueuedForControlBoundary(
        sessionId,
        'browser-program-handoff',
        'BROWSER_PROGRAM_HANDOFF'
      )
      const boundary = beginControlBoundaryFence(sessionId)
      try {
        const stopped = programRunner.stop(sessionId, {
          status: 'needs_human',
          reason: params.reason || 'Browser control was handed to the user',
          code: 'BROWSER_PROGRAM_HANDOFF'
        })
        const current = await runtime.handleRpc({ action: 'controlState', id: sessionId, params: {} })
        const controlId = String(params.controlId || current?.controlId || '')
        logger(`[browser-control] ${JSON.stringify({
          event: 'native_action.cancelling',
          sessionId,
          controlId
        })}`)
        let control = current
        let controlSettling = false
        let settlementError = null
        try {
          await limiter.waitForAcceptedSessionWork(
            sessionId,
            controlBoundaryTokens,
            controlBoundaryWaitBudgetMs
          )
          logger(`[browser-control] ${JSON.stringify({
            event: 'native_action.settled',
            sessionId,
            controlId
          })}`)
          control = await endProgramControl(
            sessionId,
            controlId,
            params.reason || 'browser-program-handoff'
          )
          logger(`[browser-control] ${JSON.stringify({
            event: 'control.released',
            sessionId,
            controlId,
            ended: control?.ended === true
          })}`)
        } catch (error) {
          if (error?.code !== 'BROWSER_CONTROL_BOUNDARY_TIMEOUT') throw error
          // The accepted native action still owns the page. Project the human
          // pause now, keep Continue disabled, and release control
          // asynchronously the instant that action settles. A four-second
          // observation budget must never erase the takeover prompt.
          controlSettling = true
          settlementError = {
            code: 'BROWSER_CONTROL_BOUNDARY_TIMEOUT',
            reason: String(error?.details?.reason || 'accepted-browser-work-still-running')
          }
          void finishProgramControlRelease({
            sessionId,
            controlId,
            reason: params.reason || 'browser-program-handoff'
          })
        }
        return {
          status: 'needs_human',
          stopped,
          instructions: boundedString(params.instructions, 2000),
          control,
          controlSettling,
          ...(settlementError ? { settlementError } : {})
        }
      } finally {
        await boundary.release()
      }
    }
    if (action === 'endControl') {
      cancelQueuedForControlBoundary(
        sessionId,
        'browser-control-ended',
        'BROWSER_PROGRAM_CONTROL_ENDED'
      )
      const boundary = beginControlBoundaryFence(sessionId)
      try {
        programRunner.stop(sessionId, {
          status: 'needs_human',
          reason: params.reason || 'Browser Agent control ended',
          code: 'BROWSER_PROGRAM_CONTROL_ENDED'
        })
        await limiter.waitForAcceptedSessionWork(
          sessionId,
          controlBoundaryTokens,
          controlBoundaryWaitBudgetMs
        )
        return await runtime.handleRpc(payload)
      } finally {
        await boundary.release()
      }
    }
    if (SERIAL_BYPASS_ACTIONS.has(action)) return runtime.handleRpc(payload)
    if (action === 'programRun') {
      const intent = String(params.intent || '').trim()
      if (!intent) {
        const error = new Error('Browser program intent is required')
        error.code = 'BROWSER_PROGRAM_INTENT_REQUIRED'
        error.statusCode = 400
        throw error
      }
      if (typeof params.code !== 'string' || !params.code.trim()) {
        const error = new Error('Browser program code is required')
        error.code = 'BROWSER_PROGRAM_CODE_REQUIRED'
        error.statusCode = 400
        throw error
      }
      const actionId = String(payload.actionId || payload.action_id || crypto.randomUUID())
      let result
      try {
        result = await executeTracked({
          payload,
          sessionId,
          action,
          actionId,
          schedule: task => limiter.runWithLease(sessionId, task),
          operation: async lease => {
            await assertProgramControl(sessionId, params)
            const admissionBoundary = promoteProgramIntervention(null, {
              sessionId,
              runId: actionId,
              source: 'control-lease-admission'
            })
            if (admissionBoundary) return admissionBoundary
            const programResult = await programRunner.run({
              sessionId,
              runId: actionId,
              code: params.code,
              timeoutMs: params.timeoutMs ?? params.timeout_ms,
              lease,
              initialDecisionToken: params._fanDecisionToken,
              visualEvidenceRef: params._fanVisualEvidenceRef,
              protectedValues: params._fanProtectedValues
            })
            return promoteProgramIntervention(programResult, {
              sessionId,
              runId: actionId,
              source: 'control-lease-post-run'
            })
          }
        })
      } catch (error) {
        const humanMetadata = pendingProgramIntervention(sessionId)
        if (!humanMetadata) throw error
        const details = error?.details && typeof error.details === 'object'
          ? error.details
          : {}
        const rejectedBeforeDispatch = (
          (details.beforeDispatch === true && details.dispatchAttempted === false) ||
          (
            error?.code === 'BROWSER_PROGRAM_USER_INTERVENED' &&
            details.reason === 'human-intervention'
          )
        )
        result = programRunner.interventionBoundaryResult({
          runId: actionId,
          status: rejectedBeforeDispatch ? 'failed_before_effect' : 'unknown_after_effect',
          value: null,
          trace: [],
          finalSnapshot: null,
          effect: {
            occurred: false,
            uncertain: !rejectedBeforeDispatch,
            kinds: []
          },
          error
        }, {
          runId: actionId,
          humanMetadata,
          source: 'control-lease-rejection'
        })
      }
      // Keep browser control alive across LLM reasoning gaps. The next browser
      // tool atomically replaces this tool's control ID, while the Gateway's
      // turn finalizer (or Stop/handoff) ends the latest lease. This preserves
      // the whole-turn operating frame and lets human takeover remain active
      // between browser programs, matching the pre-0.4.3 lifecycle.
      return promoteProgramIntervention(result, {
        sessionId,
        runId: actionId,
        source: 'control-lease-return'
      })
    }
    if (!MUTATING_ACTIONS.has(action)) {
      return limiter.run(sessionId, () => runtime.handleRpc(payload))
    }

    const actionId = String(payload.actionId || payload.action_id || crypto.randomUUID())
    return executeTracked({
      payload,
      sessionId,
      action,
      actionId,
      schedule: task => limiter.run(sessionId, task),
      operation: () => runtime.handleRpc(payload)
    })
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') {
        writeJson(res, 404, { ok: false, error: 'not found' })
        return
      }
      const auth = String(req.headers.authorization || '')
      if (auth !== `Bearer ${token}`) {
        writeJson(res, 401, { ok: false, error: 'unauthorized' })
        return
      }
      const payload = await readJson(req)
      const result = await dispatch(payload)
      writeJson(res, 200, { ok: true, result })
    } catch (error) {
      logger(`browser runtime rpc error: ${error?.message || error}`)
      const statusCode = Number(error?.statusCode) || (error?.code === 'BROWSER_QUEUE_FULL' ? 429 : 500)
      writeJson(res, statusCode, serializeRpcError(error))
    }
  })

  return {
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.removeListener('error', reject)
          const address = server.address()
          resolve({
            url: `http://${host}:${address.port}/rpc`,
            close: () => new Promise(closeResolve => {
              try { offUserIntervened?.() } catch { /* shutdown is best-effort */ }
              try { offControlState?.() } catch { /* shutdown is best-effort */ }
              pendingControlReleases.clear()
              programRunner.close()
              limiter.close()
              server.close(() => closeResolve())
            })
          })
        })
      })
    },
    server,
    limiter,
    actionLedger,
    programRunner
  }
}

module.exports = { createBrowserRuntimeRpcServer, serializeRpcError }
