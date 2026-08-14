const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { DebuggerClient } = require('./cdp/debugger-client.cjs')
const { TargetManager } = require('./cdp/target-manager.cjs')
const { BrowserRuntimeEventBus } = require('./events/event-bus.cjs')
const { EVENT_TYPES } = require('./events/event-types.cjs')
const { SelectorMap } = require('./dom/selector-map.cjs')
const {
  buildEnhancedSnapshotState,
  snapshotBelongsToTarget,
  snapshotCaptureParams,
  serializeSnapshotContent
} = require('./dom/snapshot-service.cjs')
const { haystackForElement } = require('./dom/observation-format.cjs')
const { buildPageContentExpression, chunkContent, coerceFormat } = require('./dom/content-extractor.cjs')
const {
  coerceLimitedInteger,
  findElementsExpression,
  formatFindElementsResults,
  formatSearchPageResults,
  searchPageExpression
} = require('./dom/page-query.cjs')
const { sendKey, keyMode } = require('./actions/keys.cjs')
const {
  elementFunctionDeclaration,
  fixJavascriptString,
  formatJavaScriptEvaluationResult,
  stringifyEvaluateValue,
  validateAndFixJavaScript
} = require('./actions/evaluation-helpers.cjs')
const { ElectronWatchdog } = require('./watchdogs/electron-watchdog.cjs')
const { isAlwaysBlockedMetadataHost } = require('./browser-request-guard.cjs')
const browserIO = require('./network/browser-io.cjs')
const storageStateService = require('./storage/storage-state.cjs')
const { installInputOperations } = require('./input/operations.cjs')
const { installClickOperations } = require('./interaction/click-operations.cjs')
const { installStateOperations } = require('./interaction/state-operations.cjs')
const { SYNTHETIC_SELECTOR_INDEX_BASE, installObservationOperations } = require('./observation/operations.cjs')
const { installVisualOperations } = require('./visual/operations.cjs')
const { installNavigationOperations } = require('./navigation/operations.cjs')
const { installSessionOperations } = require('./session/operations.cjs')
const {
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
} = require('./policies/url-policy.cjs')

// Only control-plane actions that neither inspect nor mutate page data may run
// while a human has control. Everything else must stop before dispatch.
const INTERVENTION_SAFE_ACTIONS = new Set([
  'health', 'networkConfig', 'urlPolicy', 'captchaState',
  'listTabs', 'liveState',
  'acknowledgeIntervention', 'flagIntervention'
])

// A behavioral challenge owns page input until the user completes it. Observe
// and waitForCaptcha must stay available so the watcher can detect completion;
// control-plane reads remain harmless. Every other page action is rejected
// before dispatch, preventing a model-requested wait from sleeping for 30s
// while a verification request is already known.
const VERIFICATION_SAFE_ACTIONS = new Set([
  ...INTERVENTION_SAFE_ACTIONS,
  'events', 'observe', 'waitForCaptcha'
])

// A challenge must not trap the browser on its page. These operations abandon
// the current document without interacting with the challenge itself.
// Link clicks are checked separately against the observed selector metadata so
// only a real same-tab navigation can use the same escape path.
const VERIFICATION_ESCAPE_NAVIGATION_ACTIONS = new Set([
  'navigate', 'back'
])

// Turn-start context hydration reads the browser without the model requesting a
// browser tool. Those reads still hold a workbench lease so eviction cannot race
// them, but they must not publish the renderer-facing operating signal that
// expands a user's chat-only layout. The private marker is honored only for the
// one page read used by hydration; model-facing observe calls remain visible.
const PASSIVE_READ_ACTIONS = new Set(['listTabs', 'liveState'])

// Compact, content-free evidence for diagnosing an observed index that later
// stops resolving. DOM.enable + DOM.getDocument make these mutation events
// available after an observation. We retain only a counter and the last event
// name/time — never node text, attributes, URLs, request data, or page content.
const INDEX_TRACE_DOM_MUTATION_METHODS = new Set([
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'DOM.childNodeCountUpdated',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.documentUpdated',
  'DOM.setChildNodes',
  'DOM.shadowRootPopped',
  'DOM.shadowRootPushed'
])

// Process-local handoff from a timeout/intervention wrapper to the RPC ledger.
// The Symbol keeps the exact underlying Promise and its result out of JSON
// serialization while the server recovers its terminal outcome and fences the
// affected session.
const ACTION_SETTLEMENT_SYMBOL = Symbol.for('fan.browser.action-settlement')

class ElectronBrowserRuntime {
  constructor({
    getView,
    getViewEpoch,
    resolveActiveTab,
    createPagePopup,
    runNavigationCommand,
    assertNavigationCurrent,
    releaseNavigation,
    log,
    downloadsPath,
    autoDownloadPdfs,
    operatingVisuals,
    postClickSettle,
    tabController,
    onActionActivity,
    onOperatingStateChange,
    onBrowserDialog,
    onPermissionRequest,
    shouldGuardWindowClose,
    shouldObserveHumanInput
  } = {}) {
    this.getView = typeof getView === 'function' ? getView : () => null
    this.getViewEpoch = typeof getViewEpoch === 'function' ? getViewEpoch : () => 0
    this.resolveActiveTab = typeof resolveActiveTab === 'function' ? resolveActiveTab : null
    // setWindowOpenHandler cannot await host lifecycle work. Main injects this
    // synchronous factory and remains the sole owner of native view creation.
    this.createPagePopup = typeof createPagePopup === 'function' ? createPagePopup : null
    this.runNavigationCommand = typeof runNavigationCommand === 'function' ? runNavigationCommand : null
    this.assertNavigationCurrent = typeof assertNavigationCurrent === 'function' ? assertNavigationCurrent : null
    this.releaseNavigation = typeof releaseNavigation === 'function' ? releaseNavigation : null
    // main.cjs (the single owner of view lifecycle) provides open/switch/close-tab.
    this.tabController = tabController || null
    this.log = typeof log === 'function' ? log : () => undefined
    this.onBrowserDialog = typeof onBrowserDialog === 'function' ? onBrowserDialog : null
    this._pendingBrowserDialogResponses = new WeakSet()
    this.onPermissionRequest = typeof onPermissionRequest === 'function' ? onPermissionRequest : null
    this.permissionRequestTimeoutMs = this._coerceTimeout(
      process.env.ELECTRON_BROWSER_PERMISSION_REQUEST_TIMEOUT_MS,
      30000
    )
    this.shouldGuardWindowClose =
      typeof shouldGuardWindowClose === 'function' ? shouldGuardWindowClose : () => true
    // The host owns native presentation. A trusted page event is only evidence
    // of user takeover while that page is the interactive primary surface;
    // background/overview WebContentsViews are read-only presentation layers.
    this.shouldObserveHumanInput =
      typeof shouldObserveHumanInput === 'function' ? shouldObserveHumanInput : () => true
    this.actionTimeoutMs = this._coerceTimeout(process.env.ELECTRON_BROWSER_ACTION_TIMEOUT_MS, 180000)
    // EVT-01(对齐 每事件 event_timeout):每类动作各有上限,卡死的动作秒级失败让 agent
    // 重试,而非统一等满 180s 冻结整回合。值由 event_timeout(Click15/Type60/Scroll8/
    // Navigate30/Screenshot15/BrowserState30…)+ 余量派生(我们带拟人节奏+多步,略放宽)。
    // wait/settle 有各自内部预算,不在此表,走 actionTimeoutMs 全局兜底。
    this.actionTimeouts = {
      click: 25000, type: 70000, scroll: 15000, scrollToText: 15000,
      fillForm: 180000, formSubmit: 180000,
      navigate: 40000, reload: 40000, screenshot: 20000, observe: 60000,
      select: 25000, dropdownOptions: 25000, sendKeys: 20000, upload: 40000,
      findElements: 15000, searchPage: 15000, pageContent: 20000, highlight: 10000,
      switchTab: 15000, evaluateJavaScript: 30000, waitForState: 35000
    }
    this.downloadsPath = this._resolveDownloadsPath(downloadsPath)
    this.autoDownloadPdfs = autoDownloadPdfs !== false && process.env.ELECTRON_BROWSER_AUTO_DOWNLOAD_PDFS !== '0'
    this.eventBus = new BrowserRuntimeEventBus({
      // Raw CDP messages can contain console arguments, request bodies and
      // response metadata. Watchdogs consume them synchronously and emit the
      // compact semantic events the product needs, so retaining the raw copies
      // is unnecessary and creates both memory pressure and a privacy hazard.
      retain: type => type !== EVENT_TYPES.CDP_MESSAGE
    })
    // Opaque, process-unique identity for each observed captcha challenge. The
    // renderer uses this to ensure a late `captcha.cleared` from the previous
    // document cannot auto-answer a newer verification request.
    this.captchaChallengeEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    this.captchaChallengeSequence = 0
    this.workbenches = new Map()
    // Session takeover ledger: tab-strip and in-page trusted input both retain
    // one opaque intervention identity plus the Agent's first anchor and the
    // user's current tab. Read by _attachHumanState and acknowledgeIntervention.
    // Session scope means rapid user switches keep the original restore anchor.
    this._interventions = new Map()
    this._interventionSequence = 0
    // Authoritative per-session logical control lease. Safety and action
    // admission derive from this state; presentation may outlive it briefly via
    // the separate human-handoff visual hold below.
    this._controlStates = new Map()
    this._controlRevisions = new Map()
    // A human handoff releases the Agent's logical control lease immediately,
    // but the originating browser tool is still running while it waits for the
    // user. Keep that presentation lifetime separate from control ownership so
    // the operating frame can remain visible without treating human input as an
    // Agent-controlled action.
    this._operatingVisualHolds = new Map()
    // CDP frame injection/removal is asynchronous. Serialize it per session so
    // a slow `on` cannot finish after a later `off` and resurrect the frame.
    this._operatingTransitions = new Map()
    // Actual RPCs remain authoritative even if the renderer showing a session
    // unmounts. The host uses this signal to protect the active browser tab for
    // the full lifetime of in-flight automation work.
    this._activeActionCounts = new Map()
    // Exact view-level counts remain independent from session teardown. A timed
    // out action can keep running against its old view until the underlying
    // promise settles, so its workbench must stay busy for that full lifetime.
    this._activeWorkbenchActionCounts = new Map()
    this.onActionActivity = typeof onActionActivity === 'function' ? onActionActivity : () => undefined
    this.onOperatingStateChange = typeof onOperatingStateChange === 'function' ? onOperatingStateChange : () => undefined
    // P0 multi-tab seam: session id -> { tabs: [tabViewId...], active }. main.cjs
    // owns view lifecycle and pushes the group here as a read-only list/metadata
    // projection. When provided, resolveActiveTab is the canonical routing source;
    // the mirror's active index remains only as a compatibility fallback for hosts
    // that do not provide the resolver.
    this.sessionTabs = new Map()
    // Per-session monotonic counter, bumped whenever the tab SET changes
    // (a tab created or closed). liveState surfaces it and browser_state_note
    // diffs it with `!=`, so closing a BACKGROUND (non-active) tab — which
    // leaves active id + the active tab's pageGeneration untouched and emits
    // no USER_INTERVENED — still reaches the model as "tab list changed".
    // Kept OUT of the session group (that object is rebuilt every sync) so the
    // count survives across syncs; dropped on session destroy.
    this._tabListGeneration = new Map()
    // Coordinate actions must be tied to the exact screenshot/page generation
    // that produced them. Tokens are short-lived, process-local evidence, not
    // an authorization mechanism.
    this._visualEvidence = new Map()
    // Session-scoped goal context: events update this internal state so page
    // actions keep routing to the right active tab and observations can clear
    // "world changed" requirements without making the model manage events.
    this.sessionContexts = new Map()
    // Human-like operation visuals: a virtual cursor that glides to each target
    // and clicks, plus an "agent is operating" glowing frame around the page, so
    // co-browsing users always see the agent's hands. Explicit opt-in (main
    // enables it in production; bare unit tests leave it off so they can assert
    // exact CDP command sequences without the cosmetic injections).
    this.operatingVisuals = operatingVisuals === true
    this.cursorGlideMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CURSOR_GLIDE_MS) || 340)
    // Human-like cursor motion (research-grounded: Fitts's law + minimum-jerk
    // bell velocity). Glide duration scales with distance up to a cap; easing is
    // a symmetric ease-in-out (the old ease-out started at max velocity — an
    // unnatural instant onset); the cursor FADES in on first appearance instead
    // of teleporting; type() shows a soft focus pulse (caret landing) distinct
    // from the click ripple. All env-overridable.
    this.cursorGlideMaxMs = Math.max(this.cursorGlideMs, Number(process.env.ELECTRON_BROWSER_CURSOR_GLIDE_MAX_MS) || 460)
    this.cursorFadeMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CURSOR_FADE_MS) || 140)
    this.cursorFocusPulseMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CURSOR_FOCUS_PULSE_MS) || 320)
    // 点击前"稳定性沉降"上限(对齐 Playwright/Cypress:等元素 bbox 连续两帧不变=动画停了再取坐标,
    // 避免动画中元素移位导致点偏)。500ms 覆盖绝大多数 CSS transition(常 ≤400ms);超时则按当前坐标照点。
    // 取代此前固定 50ms 死等:静态元素更快(~2 帧≈32ms),动画元素才多等。可经 env 调。
    this.clickStabilityMaxMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CLICK_STABILITY_MAX_MS) || 500)
    // retry-until-actionable(最小版,对齐 Playwright/Cypress 思想但收敛):hit-test 判遮挡时,原坐标短重试
    // N 次、每次间隔 M ms——瞬态遮挡(loading spinner/淡出层/刚出现的提示)会在此窗口内消失 → 升级回真点击,
    // 持续遮挡(modal)才降级 JS click。只在【检测到遮挡时】才重试,无遮挡零开销。最多额外 N*M ms。
    // 对 LLM agent 是底层兜底——高层 agent 循环本就会重试,故收敛到几百 ms,不做 Playwright 那种 30s 长循环。
    this.clickActionableRetries = Math.max(0, Number(process.env.ELECTRON_BROWSER_CLICK_ACTIONABLE_RETRIES) || 3)
    this.clickActionableRetryMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CLICK_ACTIONABLE_RETRY_MS) || 150)
    this.cursorEasing = process.env.ELECTRON_BROWSER_CURSOR_EASING || 'cubic-bezier(.65,0,.35,1)'
    // Real CDP mouseMoved trajectory before every click/hover. The cosmetic
    // cursor above only paints pixels; page scripts and anti-bot heuristics see
    // nothing move unless we actually dispatch a stream of mouseMoved events
    // walking from the last pointer position to the target. Gated by visuals
    // (production-on, unit-tests-off so they can assert exact CDP sequences) and
    // a dedicated env kill-switch. Step count grows with distance (clamped); the
    // total walk time reuses the SAME Fitts's-law budget as _cursorTo's glide so
    // the real pointer and the painted cursor arrive together.
    this.mouseTrajectory =
      this.operatingVisuals && process.env.ELECTRON_BROWSER_MOUSE_TRAJECTORY !== '0'
    this.mouseTrajectoryMinSteps = Math.max(2, Number(process.env.ELECTRON_BROWSER_MOUSE_TRAJECTORY_MIN_STEPS) || 6)
    this.mouseTrajectoryMaxSteps = Math.max(
      this.mouseTrajectoryMinSteps,
      Number(process.env.ELECTRON_BROWSER_MOUSE_TRAJECTORY_MAX_STEPS) || 12
    )
    // Default resting pointer for a fresh workbench: viewport center. Overridden
    // lazily from Page layout metrics the first time we move (see _lastMousePoint).
    this.mouseTrajectoryDefaultX = Math.max(0, Number(process.env.ELECTRON_BROWSER_MOUSE_TRAJECTORY_X) || 640)
    this.mouseTrajectoryDefaultY = Math.max(0, Number(process.env.ELECTRON_BROWSER_MOUSE_TRAJECTORY_Y) || 400)
    // Human-like typing cadence (research: Aalto CHI 2018 — human mean
    // inter-key interval ~238ms / 52 WPM; latin base 70ms ±25% reads as a fast
    // confident typist and stays above the ~60ms motor floor). CJK commits whole
    // phrases from one IME candidate pick, so Han chars arrive in bursts (fast
    // intra-burst) with a ~750ms candidate-selection gap between bursts (USPTO
    // 7,013,258). A total budget caps very long inputs so they don't crawl. Only
    // applied for human-mode typing with no explicit delay, and only when visuals
    // are on (unit tests pass delayMs:0 → original flat path, untouched).
    this.typingBaseDelayMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_TYPING_BASE_DELAY_MS) || 70)
    this.typingJitterPct = Math.max(0, Math.min(0.6, Number(process.env.ELECTRON_BROWSER_TYPING_JITTER_PCT) || 0.25))
    this.typingWordPauseMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_TYPING_WORD_PAUSE_MS) || 250)
    this.typingWordPauseProb = Math.max(0, Math.min(1, Number(process.env.ELECTRON_BROWSER_TYPING_WORD_PAUSE_PROB) || 0.25))
    this.cjkBurstSize = Math.max(1, Number(process.env.ELECTRON_BROWSER_CJK_BURST_SIZE) || 3)
    this.cjkIntraBurstMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CJK_INTRA_BURST_MS) || 40)
    this.cjkBurstGapMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_CJK_BURST_GAP_MS) || 750)
    this.typingMaxTotalMs = Math.max(0, Number(process.env.ELECTRON_BROWSER_TYPING_MAX_TOTAL_MS) || 4000)
    // Post-click navigation settle: a click that follows a link, submits a form,
    // or triggers a same-workbench popup redirect / SPA route makes the watchdog
    // clear the selector map with a PAGE_CHANGED reason on the same tick as the
    // synthetic mouseup. When enabled, click waits a brief window for that signal
    // and — if it fires — lets the page settle, so the NEXT observation reflects
    // the page the click produced (not the page before it). This is what kills
    // both the "observed the old page → looks like the click did nothing" and the
    // downstream stale-index churn. Explicit opt-in: main enables it; bare unit
    // tests leave it off (keeps click instant + lets them assert exact CDP
    // sequences). The real navigation path is covered by the live e2e suite.
    this.postClickSettle = postClickSettle === true
    this.postClickNavProbeMs = this._coerceTimeout(process.env.ELECTRON_BROWSER_POST_CLICK_NAV_PROBE_MS, 350)
    this.postClickTabProbeMs = this._coerceTimeout(process.env.ELECTRON_BROWSER_POST_CLICK_TAB_PROBE_MS, 2000)
    // Human takeover: every reachable frame reports trusted browser events
    // through a CDP binding. Exact, short-lived host-side dispatch claims consume
    // the Agent's own CDP input. Only physical initiating events (pointer/key/
    // wheel/touch) can close admission; derived input/scroll events are diagnostic
    // because Chromium and native controls can produce them without a human.
    this.eventBus.on(EVENT_TYPES.CDP_MESSAGE, event => {
      const p = event?.payload
      if (p && INDEX_TRACE_DOM_MUTATION_METHODS.has(String(p.method || ''))) {
        const mutated = this.workbenches.get(String(p.id || ''))
        if (mutated) {
          const previous = mutated.domMutationTrace || {}
          mutated.domMutationTrace = {
            revision: Math.max(0, Number(previous.revision) || 0) + 1,
            lastMethod: String(p.method || ''),
            lastAt: Date.now(),
            sessionId: p.sessionId == null ? null : String(p.sessionId)
          }
        }
      }
      if (p && p.method === 'Target.attachedToTarget' && p.params?.sessionId) {
        const attachedEntry = this.workbenches.get(String(p.id || ''))
        const targetType = String(p.params?.targetInfo?.type || '').toLowerCase()
        const takeoverTarget = ['iframe', 'page', 'tab'].includes(targetType)
        if (
          attachedEntry &&
          takeoverTarget &&
          (
            attachedEntry._interventionArmed ||
            this._isControlActive(this._sessionIdForEntry(attachedEntry))
          )
        ) {
          void this._armInterventionWatch(
            attachedEntry,
            { sessionIds: [String(p.params.sessionId)] }
          ).catch(error => {
            this.log(
              `[browser-takeover-arm:${attachedEntry.id}:${p.params.sessionId}] ` +
              `attached-target arm exhausted error=${error?.message || String(error)}`
            )
          })
        }
      }
      if (p && p.method === 'Target.detachedFromTarget' && p.params?.sessionId) {
        const detachedEntry = this.workbenches.get(String(p.id || ''))
        const detachedKey = String(p.params.sessionId)
        detachedEntry?._interventionArmedSessions?.delete(detachedKey)
        detachedEntry?._interventionArmingSessions?.delete(detachedKey)
        detachedEntry?._interventionWatchScripts?.delete(detachedKey)
        if (Array.isArray(detachedEntry?._agentInputClaims)) {
          detachedEntry._agentInputClaims = detachedEntry._agentInputClaims.filter(
            claim => claim.targetSessionId !== detachedKey
          )
        }
      }
      if (p && p.method === 'Runtime.executionContextCreated') {
        const contextEntry = this.workbenches.get(String(p.id || ''))
        const context = p.params?.context
        const contextId = Number(context?.id)
        const targetSessionId = p.sessionId == null ? undefined : String(p.sessionId)
        const targetKey = this._interventionTargetKey(targetSessionId)
        if (
          contextEntry &&
          Number.isFinite(contextId) &&
          context?.auxData?.isDefault === true &&
          (
            contextEntry._interventionArmedSessions?.has(targetKey) ||
            contextEntry._interventionArmingSessions?.has(targetKey)
          )
        ) {
          // OOPIF targets do not expose the Page domain, so they cannot use
          // addScriptToEvaluateOnNewDocument. Runtime.addBinding survives their
          // document changes; refresh the listener in each new default context.
          void this._refreshInterventionContext(
            contextEntry,
            targetSessionId,
            contextId
          ).catch(error => {
            this.log(
              `[browser-takeover-arm:${contextEntry.id}:${targetKey}] ` +
              `execution-context refresh failed error=${error?.message || String(error)}`
            )
          })
        }
      }
      if (p && p.method === 'Runtime.bindingCalled' && p.params?.name === '__fanUserIntervened') {
        let info = {}
        try {
          info = JSON.parse(p.params.payload || '{}')
        } catch {
          info = {}
        }
        const intervened = this.workbenches.get(String(p.id))
        if (!intervened || info.trusted !== true) return
        const sessionId = this._sessionIdForEntry(intervened)
        // The listener is intentionally independent from the cosmetic frame and
        // remains installed across control turns. Runtime control ownership is
        // the authoritative admission gate.
        if (!this._isControlActive(sessionId)) return
        const ownedDispatch = this._consumeAgentInputDispatch(
          intervened,
          info,
          p.sessionId
        )
        if (ownedDispatch) return
        const inputKind = String(info.inputKind || info.eventType || 'unknown')
        const eventType = String(info.eventType || '')
        if (
          eventType === 'input' ||
          eventType === 'scroll' ||
          inputKind === 'input' ||
          inputKind === 'scroll'
        ) {
          // input/scroll are outcomes, not proof of a physical user action.
          // Browser autofill, form restoration, native controls and Agent
          // pointer/key gestures can all create trusted result events. A real
          // ordinary edit/scroll has already been caught by its earlier
          // pointerdown, keydown, wheel or touchstart.
          const now = Date.now()
          if (now - Number(intervened._lastIgnoredTakeoverResultLogAt || 0) >= 1000) {
            intervened._lastIgnoredTakeoverResultLogAt = now
            this.log(
              `[browser-takeover] ignored trusted result-only event ` +
              `session=${sessionId} workbench=${intervened.id} event=${eventType || inputKind} ` +
              `target=${p.sessionId == null ? 'main' : String(p.sessionId)}`
            )
          }
          return
        }
        if (
          this.shouldObserveHumanInput({
            eventType,
            inputKind,
            sessionId,
            targetSessionId: p.sessionId == null ? null : String(p.sessionId),
            workbenchId: String(intervened.id)
          }) === false
        ) {
          this.log(
            `[browser-takeover] ignored non-interactive-surface input ` +
            `session=${sessionId} workbench=${intervened.id} input=${inputKind}`
          )
          return
        }
        // Pointer input is expected while a behavioral verification is parked:
        // it is how the user solves sliders, puzzles and checkbox challenges.
        // Keep that input inside the verification handshake instead of also
        // latching the generic manual-control gate. Tab-strip takeovers use the
        // separate flagIntervention path and remain unaffected.
        const verificationPending = Boolean(
          intervened?.captchaState?.detected &&
          intervened.captchaState.requiresUserInput !== false
        )
        if (verificationPending) return
        if (this._sessionInterventionPending(sessionId)) return
        const currentTabId = String(this._activeTabId(sessionId) || intervened.id)
        const control = this._controlStates.get(sessionId)
        this._latchIntervention(sessionId, {
          kind: 'page-input',
          inputKind,
          workbenchId: sessionId,
          currentTabId,
          anchorTabId: String(control?.activeTabId || currentTabId),
          agentAnchorTabId: String(control?.activeTabId || currentTabId),
          userTabId: currentTabId,
          targetSessionId: p.sessionId == null ? null : String(p.sessionId),
          eventType,
          pageTimestamp: Number(info.timestamp) || null,
          topFrame: info.topFrame !== false,
          x: Number.isFinite(Number(info.x)) ? Number(info.x) : null,
          y: Number.isFinite(Number(info.y)) ? Number(info.y) : null,
          deltaX: Number.isFinite(Number(info.deltaX)) ? Number(info.deltaX) : null,
          deltaY: Number.isFinite(Number(info.deltaY)) ? Number(info.deltaY) : null,
          buttons: Number.isFinite(Number(info.buttons)) ? Number(info.buttons) : null,
          pointerType: info.pointerType ? String(info.pointerType) : null
        })
      }
    })
    this.eventBus.on(EVENT_TYPES.TAB_OPEN_REQUESTED, event => {
      const payload = event?.payload || {}
      const sessionId = String(payload.sessionId || payload.id || 'main').split('#')[0]
      this._updateBrowserContext(
        sessionId,
        {
          pendingTabOpen: {
            sourceTabId: payload.id ? String(payload.id) : null,
            url: payload.url ? String(payload.url) : '',
            requestedAt: event.timestamp || Date.now(),
            eventId: event.id || null
          }
        },
        'tab.open_requested'
      )
    })
    this.eventBus.emit(EVENT_TYPES.RUNTIME_STARTED)
  }

  _resolveDownloadsPath(downloadsPath) {
    const raw = String(downloadsPath || process.env.ELECTRON_BROWSER_DOWNLOADS_PATH || path.join(process.cwd(), 'downloads'))
    return path.resolve(raw)
  }

  registerWorkbench(id) {
    const key = String(id || 'main')
    const existing = this.workbenches.get(key)
    if (existing) return existing
    const view = this.getView(key)
    if (!view || !view.webContents) {
      throw new Error(`Cannot register browser workbench ${key}: WebContentsView not found`)
    }
    const client = new DebuggerClient({ id: key, webContents: view.webContents, eventBus: this.eventBus, log: this.log })
    const entry = {
      id: key,
      sessionId: String(key).split('#')[0],
      viewEpoch: Math.max(0, Number(this.getViewEpoch(key)) || 0),
      retired: false,
      view,
      webContents: view.webContents,
      client,
      targetManager: new TargetManager({ id: key, client, eventBus: this.eventBus }),
      downloadsPath: this.downloadsPath,
      autoDownloadPdfs: this.autoDownloadPdfs,
      watchdog: null,
      pendingDialog: null,
      // A sanitized clipboard write is Chromium's safe, gesture-gated baseline.
      // Every capability that can read private state or reach device hardware is
      // denied until an Agent grant or the host's user-facing permission prompt
      // records a temporary grant for this live tab.
      permissionPolicy: { granted: new Set(['clipboard-sanitized-write']) },
      networkConfig: {
        defaultUserAgent: typeof view.webContents.getUserAgent === 'function' ? view.webContents.getUserAgent() : '',
        userAgent: '',
        userAgentSet: false,
        extraHTTPHeaders: {},
        extraHTTPHeadersSet: false
      },
      // SEC-1:新标签继承 runtime 级全局 URL 策略(否则新标签起始无限制 → allowlist 逃逸)
      urlPolicy: this._defaultUrlPolicy || this._emptyUrlPolicy(),
      popupPolicy: 'new-tab',
      lastCaptchaSignature: null,
      lastCaptchaDocumentRevision: null,
      captchaState: { detected: false },
      captchaWatchActive: false,
      interventionPending: false,
      // 页面变更代次现统一由 entry.selectorMap.pageGeneration 提供(在 SelectorMap.clear 内、仅 PAGE_CHANGED
      // 原因自增,含 watchdog 直接 clear 的导航)。observe/liveState 都读它,不再单独维护 entry.observationGeneration。
      domState: null,
      // Diagnostic-only counters used by [browser-index-trace]. They contain
      // no page content and are reset naturally with the workbench lifecycle.
      domMutationTrace: { revision: 0, lastMethod: '', lastAt: 0, sessionId: null },
      lastObservationTrace: null,
      // Cross-document identity is independent from broad DOM invalidation.
      // Initial CDP hydration fills revision 0 without advancing it. After that,
      // only a top-level Page.frameNavigated commit advances the revision.
      documentState: Object.freeze({
        revision: 0,
        frameId: '',
        loaderId: '',
        url: this._visibleUrl({ webContents: view.webContents }),
        committedAt: 0
      }),
      // Main-frame network failures remain authoritative even after Chromium
      // commits its internal chrome-error document. The watchdog clears this
      // only when a later real cross-document navigation begins.
      mainFrameNavigationFailure: null,
      // Last REAL CDP pointer position, so the next click/hover can dispatch a
      // mouseMoved trajectory walking from here to the target. null => not yet
      // moved; _humanMouseTrajectory seeds it from layout-metrics center.
      _lastMouseX: null,
      _lastMouseY: null,
      screencast: { active: false, frames: [], maxFrames: 0, captureFrames: false },
      selectorMap: new SelectorMap(),
      syntheticSelectorIndexes: new Map(),
      syntheticSelectorDocumentRevision: 0,
      nextSyntheticSelectorIndex: SYNTHETIC_SELECTOR_INDEX_BASE
    }
    this._installAgentInputDispatchOwnership(entry)
    entry.watchdog = new ElectronWatchdog({ entry, eventBus: this.eventBus, runtime: this })
    entry.watchdog.start()
    this.workbenches.set(key, entry)
    this.eventBus.emit(EVENT_TYPES.WORKBENCH_REGISTERED, { id: key })
    if (this._isControlActive(entry.sessionId)) {
      void this._queueOperatingReconcile(entry.sessionId).catch(() => undefined)
    }
    return entry
  }

  _installAgentInputDispatchOwnership(entry) {
    const client = entry?.client
    if (!client?.send || client._fanInputOwnershipInstalled) return false
    const rawSend = client.send.bind(client)
    Object.defineProperty(client, '_fanInputOwnershipInstalled', {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false
    })
    Object.defineProperty(client, '_fanRawSend', {
      configurable: false,
      enumerable: false,
      value: rawSend,
      writable: false
    })
    client.send = async (method, params = {}, sessionId = undefined, timeoutOverrideMs = undefined) => {
      const ownership = this._beginAgentInputDispatch(entry, method, params, sessionId)
      // `_fanExpectedInputEvent` is host-only ownership metadata. CDP rejects
      // unknown command fields, so keep it visible to the claim ledger above
      // and remove it from the payload sent to Chromium.
      const dispatchParams = params?._fanExpectedInputEvent === true
        ? (() => {
            const next = { ...params }
            delete next._fanExpectedInputEvent
            return next
          })()
        : params
      try {
        const result = await rawSend(method, dispatchParams, sessionId, timeoutOverrideMs)
        this._finishAgentInputDispatch(entry, ownership)
        return result
      } catch (error) {
        this._finishAgentInputDispatch(entry, ownership, error)
        throw error
      }
    }
    return true
  }

  _dropVisualEvidenceForTab(tabId) {
    const key = String(tabId || '')
    for (const [token, evidence] of this._visualEvidence) {
      if (String(evidence?.activeTabId || '') === key) this._visualEvidence.delete(token)
    }
  }

  _retireWorkbenchEntry(key, entry) {
    if (!entry || entry.retired) return Promise.resolve(false)
    entry.retired = true
    entry.watchdog?.stop()
    entry.targetManager?.stop()
    if (this.workbenches.get(key) === entry) {
      // Registration ends synchronously. A replacement with the same id can
      // materialize while the old debugger detaches in the background.
      this.workbenches.delete(key)
      this.eventBus.emit(EVENT_TYPES.WORKBENCH_UNREGISTERED, { id: key })
    }
    this._dropVisualEvidenceForTab(key)
    // Do not put a replacement View behind an old cosmetic CDP timeout.
    // _applyOperatingFrame also checks entry identity after every await.
    this._operatingTransitions.delete(entry.sessionId)

    // Drop all retained page observations immediately. In-flight observes use
    // an entry-identity lease and cannot publish their local snapshots after the
    // entry has been removed from workbenches.
    entry.selectorMap?.clear?.('workbench.retired')
    entry.syntheticSelectorIndexes?.clear?.()
    entry.syntheticSelectorDocumentRevision = 0
    entry.nextSyntheticSelectorIndex = SYNTHETIC_SELECTOR_INDEX_BASE
    entry.domState = null
    entry.pendingDialog = null
    entry.recentDialogs = null
    if (entry.screencast) {
      entry.screencast.active = false
      entry.screencast.frames = []
      entry.screencast.maxFrames = 0
      entry.screencast.captureFrames = false
    }

    // dispose() closes the client synchronously before returning its promise;
    // stale async continuations therefore cannot attach again. The detach
    // fallback only supports lightweight legacy/test clients.
    let disposal
    try {
      disposal = typeof entry.client?.dispose === 'function'
        ? entry.client.dispose()
        : entry.client?.detach?.()
    } catch (error) {
      disposal = Promise.reject(error)
    }
    return Promise.resolve(disposal).catch(() => undefined).then(() => true)
  }

  async unregisterWorkbench(id) {
    const key = String(id || 'main')
    const entry = this.workbenches.get(key)
    if (!entry) return false
    return this._retireWorkbenchEntry(key, entry)
  }

  async stop() {
    const ids = Array.from(this.workbenches.keys())
    for (const id of ids) {
      await this.unregisterWorkbench(id).catch(() => undefined)
    }
    this.eventBus.emit(EVENT_TYPES.RUNTIME_STOPPED)
  }

  // Whether the agent's backend turn is currently driving this session
  // (beginControl -> endControl). Exposed so the host's eviction governor can
  // protect the session for the WHOLE turn — the renderer-side visual-frame
  // signal clears on session switches and must not be the only guard.
  isOperating(sessionId) {
    const key = String(sessionId || 'main')
    return this._isControlActive(key) || (this._activeActionCounts.get(key)?.count || 0) > 0
  }

  isVisuallyOperating(sessionId) {
    const key = String(sessionId || 'main')
    return this.isOperating(key) || this._isOperatingVisualHeld(key)
  }

  _browserDialogCommandParams(decision) {
    if (decision == null) return null
    if (typeof decision === 'boolean') return { accept: decision }
    if (typeof decision === 'string') {
      const action = decision.trim().toLowerCase()
      return ['accept', 'dismiss'].includes(action) ? { accept: action === 'accept' } : null
    }
    if (typeof decision !== 'object' || Array.isArray(decision)) return null
    let accept
    if (typeof decision.accept === 'boolean') {
      accept = decision.accept
    } else {
      const action = String(decision.action || '').trim().toLowerCase()
      if (!['accept', 'dismiss'].includes(action)) return null
      accept = action === 'accept'
    }
    const command = { accept }
    const promptText = decision.promptText ?? decision.prompt_text
    if (promptText != null) command.promptText = String(promptText)
    return command
  }

  async _respondToBrowserDialog(entry, dialogId, decision) {
    const command = this._browserDialogCommandParams(decision)
    if (!command) return { handled: false, reason: 'invalid-decision' }
    const dialog = entry?.pendingDialog
    if (
      !entry ||
      !dialog ||
      typeof dialog !== 'object' ||
      this.workbenches.get(String(entry.id || '')) !== entry ||
      String(dialog?.dialogId || '') !== String(dialogId || '')
    ) {
      return { handled: false, reason: 'stale-dialog' }
    }
    if (this._pendingBrowserDialogResponses.has(dialog)) {
      return { handled: false, reason: 'decision-pending' }
    }
    this._pendingBrowserDialogResponses.add(dialog)
    try {
      await entry.client?.send?.('Page.handleJavaScriptDialog', command)
      if (String(entry.pendingDialog?.dialogId || '') === String(dialogId || '')) {
        entry.pendingDialog = null
      }
      return { handled: true, action: command.accept ? 'accept' : 'dismiss' }
    } catch (error) {
      this._pendingBrowserDialogResponses.delete(dialog)
      this.log(`browser dialog host response failed for ${entry.id}: ${error?.message || error}`)
      return { handled: false, reason: 'command-failed' }
    }
  }

  _routeBrowserDialog(entry, dialog) {
    const sessionId = this._sessionIdForEntry(entry)
    const agentControlled = this.isOperating(sessionId)
    const dangerous = String(dialog?.type || '').toLowerCase() === 'beforeunload'
    const hostRequested = Boolean(this.onBrowserDialog && (!agentControlled || dangerous))
    if (!hostRequested) return { agentControlled, dangerous, hostRequested: false }

    const request = {
      id: String(entry?.id || ''),
      tabId: String(entry?.id || ''),
      sessionId,
      workbenchId: sessionId,
      agentControlled,
      dangerous,
      dialog,
      respond: decision => this._respondToBrowserDialog(entry, dialog?.dialogId, decision)
    }
    Promise.resolve()
      .then(() => this.onBrowserDialog(request))
      .then(decision => {
        if (decision !== undefined) return request.respond(decision)
        return undefined
      })
      .catch(error => {
        this.log(`browser dialog host callback failed for ${entry?.id || ''}: ${error?.message || error}`)
      })
    return { agentControlled, dangerous, hostRequested: true }
  }

  _routePermissionRequest(entry, request = {}) {
    if (!this.onPermissionRequest || typeof request.respond !== 'function') return false
    const sessionId = this._sessionIdForEntry(entry)
    const hostRequest = {
      id: String(entry?.id || ''),
      tabId: String(entry?.id || ''),
      sessionId,
      workbenchId: sessionId,
      permission: String(request.permission || ''),
      details: request.details || {},
      respond: request.respond
    }
    Promise.resolve()
      .then(() => this.onPermissionRequest(hostRequest))
      .then(decision => {
        if (decision !== undefined) return hostRequest.respond(decision)
        return undefined
      })
      .catch(error => {
        this.log(`browser permission host callback failed for ${entry?.id || ''}: ${error?.message || error}`)
        hostRequest.respond(false)
      })
    return true
  }

  _shouldGuardWindowClose(entry) {
    try {
      return this.shouldGuardWindowClose({
        id: String(entry?.id || ''),
        tabId: String(entry?.id || ''),
        sessionId: this._sessionIdForEntry(entry),
        workbenchId: this._sessionIdForEntry(entry),
        entry
      }) !== false
    } catch (error) {
      this.log(`window.close guard decision failed for ${entry?.id || ''}: ${error?.message || error}`)
      return true
    }
  }

  _notifyOperatingState(sessionId, workbenchId = null) {
    const key = String(sessionId || 'main').split('#')[0] || 'main'
    try {
      this.onOperatingStateChange(
        key,
        String(workbenchId || key),
        this.isVisuallyOperating(key)
      )
    } catch {
      // Host projection is best-effort and must never interrupt a browser action.
    }
  }

  // Thumbnail capture must also avoid the short endControl interval where the
  // logical control flag is already false but its page frame/cursor cleanup is
  // still in flight. Kept separate from isOperating so eviction/throttling keep
  // their existing turn-level semantics.
  isOperatingVisualTransitionPending(sessionId) {
    return this._operatingTransitions.has(this._controlSessionId(sessionId))
  }

  isWorkbenchBusy(viewId) {
    const key = String(viewId || 'main')
    return (this._activeWorkbenchActionCounts.get(key)?.count || 0) > 0
  }

  _beginActionActivity(id, options = {}) {
    const workbenchKey = String(id || 'main')
    const sessionKey = workbenchKey.split('#')[0]
    const announceOperating = options.announceOperating !== false
    let sessionBucket = null
    if (announceOperating) {
      sessionBucket = this._activeActionCounts.get(sessionKey)
      if (!sessionBucket) {
        sessionBucket = { count: 0 }
        this._activeActionCounts.set(sessionKey, sessionBucket)
      }
      sessionBucket.count += 1
    }
    let workbenchBucket = this._activeWorkbenchActionCounts.get(workbenchKey)
    if (!workbenchBucket) {
      workbenchBucket = { count: 0 }
      this._activeWorkbenchActionCounts.set(workbenchKey, workbenchBucket)
    }
    workbenchBucket.count += 1
    try { this.onActionActivity(sessionKey, workbenchKey, true) } catch { /* host resource hints are best-effort */ }
    if (announceOperating) this._notifyOperatingState(sessionKey, workbenchKey)
    return { announceOperating, sessionBucket, sessionKey, workbenchBucket, workbenchKey }
  }

  _endActionActivity(activity) {
    const sessionKey = String(activity?.sessionKey || '')
    const sessionBucket = activity?.sessionBucket
    const workbenchKey = String(activity?.workbenchKey || '')
    const workbenchBucket = activity?.workbenchBucket
    // Session or view ids can be reused while an old CDP promise is settling.
    // Each finalizer may only mutate the exact buckets captured at action start.
    if (sessionBucket && this._activeActionCounts.get(sessionKey) === sessionBucket) {
      sessionBucket.count = Math.max(0, sessionBucket.count - 1)
      if (sessionBucket.count === 0) this._activeActionCounts.delete(sessionKey)
    }
    if (workbenchBucket && this._activeWorkbenchActionCounts.get(workbenchKey) === workbenchBucket) {
      workbenchBucket.count = Math.max(0, workbenchBucket.count - 1)
      if (workbenchBucket.count === 0) this._activeWorkbenchActionCounts.delete(workbenchKey)
    }
    try { this.onActionActivity(sessionKey, workbenchKey, false) } catch { /* host resource hints are best-effort */ }
    if (activity?.announceOperating !== false) this._notifyOperatingState(sessionKey, workbenchKey)
  }

  getWorkbench(id) {
    const key = String(id || 'main')
    const entry = this.workbenches.get(key)
    if (entry && !entry.webContents.isDestroyed()) return entry
    if (entry) void this._retireWorkbenchEntry(key, entry)
    try {
      return this.registerWorkbench(key)
    } catch (error) {
      if (/WebContentsView not found/.test(String(error.message))) {
        const sessionId = String(key).split('#')[0]
        const activeTabId = this._activeTabId(sessionId)
        if (activeTabId !== key) {
          const stale = new Error(`Browser tab changed before workbench recovery: ${key}`)
          stale.code = 'TAB_CHANGED'
          throw stale
        }
        // Eviction is a resource concern. Recreate the requested ACTIVE tab
        // without changing canonical selection; recovery must never masquerade
        // as a user/agent tab switch.
        if (typeof this.tabController?.materializeTab === 'function') {
          try {
            this.tabController.materializeTab(sessionId, key)
            return this.registerWorkbench(key)
          } catch {
            // fall through to crash-recovery below
          }
        }
      }
      throw error
    }
  }

  // Resolve a session id to its ACTIVE tab's workbench id. Main's synchronous,
  // read-only resolver is the only authority; the runtime projection must never
  // make routing decisions from a delayed active index.
  _activeTabId(sessionId) {
    const key = String(sessionId || 'main')
    if (this.resolveActiveTab) {
      const resolved = this.resolveActiveTab(key)
      return resolved == null || String(resolved) === '' ? key : String(resolved)
    }
    return key
  }

  _activeTabIndex(sessionId, group) {
    if (!group || !Array.isArray(group.tabs) || !group.tabs.length) return 0
    const activeTabId = this._activeTabId(sessionId)
    const canonicalIndex = group.tabs.findIndex(tabId => String(tabId) === activeTabId)
    return canonicalIndex >= 0 ? canonicalIndex : 0
  }

  _sessionIdForEntry(entry) {
    if (entry?.sessionId) return String(entry.sessionId)
    return String(entry?.id || 'main').split('#')[0]
  }

  _documentStateSnapshot(entry) {
    const state = entry?.documentState || {}
    return {
      revision: Math.max(0, Number(state.revision) || 0),
      frameId: String(state.frameId || ''),
      loaderId: String(state.loaderId || ''),
      url: String(state.url || ''),
      committedAt: Math.max(0, Number(state.committedAt) || 0)
    }
  }

  _commitDocumentState(entry, frame = {}) {
    if (!entry) return null
    const previous = this._documentStateSnapshot(entry)
    const next = Object.freeze({
      revision: previous.revision + 1,
      frameId: String(frame.id || ''),
      loaderId: String(frame.loaderId || ''),
      url: String(frame.url || ''),
      committedAt: Date.now()
    })
    entry.documentState = next
    return next
  }

  async _initializeDocumentState(entry) {
    const before = this._documentStateSnapshot(entry)
    if (before.frameId) return before
    const frameTree = await entry.client.send('Page.getFrameTree').catch(() => null)
    const frame = frameTree?.frameTree?.frame
    if (!frame?.id) return this._documentStateSnapshot(entry)

    // A frameNavigated event may win while getFrameTree is in flight. Never let
    // hydration overwrite a committed revision or its loader identity.
    const current = this._documentStateSnapshot(entry)
    if (current.revision !== before.revision || current.frameId) return current
    const hydrated = Object.freeze({
      revision: current.revision,
      frameId: String(frame.id || ''),
      loaderId: String(frame.loaderId || ''),
      url: String(frame.url || current.url || ''),
      committedAt: current.committedAt
    })
    entry.documentState = hydrated
    return hydrated
  }

  // 新增标签的视图 id 形如 `${sessionKey}#t{seq}`(main.cjs:3823)→ 稳定句柄 't{seq}'
  // (_resolveTabId 用 stable token 解析)。主/首标签的视图 id 就是会话 key 本身(无 '#t',
  // main.cjs:3910)→ 统一映射为 t0,避免列表显示 0、模型却自然回传 t0 时解析失败。
  _stableTabId(tid, sessionId = null) {
    const m = String(tid).match(/#t(\d+)$/i)
    if (m) return `t${m[1]}`
    return sessionId != null && String(tid) === String(sessionId) ? 't0' : null
  }

  _browserDecisionToken(sessionId) {
    const sid = String(sessionId || 'main')
    const activeTabId = this._activeTabId(sid)
    const entry = this.workbenches.get(String(activeTabId))
    if (!entry?.selectorMap) return null
    return {
      version: 1,
      sessionId: sid,
      activeTabId: String(activeTabId),
      viewEpoch: Math.max(0, Number(entry.viewEpoch) || 0),
      documentRevision: this._documentStateSnapshot(entry).revision,
      pageGeneration: Number(entry.selectorMap.pageGeneration) || 0,
      selectorGeneration: Number(entry.selectorMap.generation) || 0,
      tabListGeneration: Number(this._tabListGeneration.get(sid)) || 0
    }
  }

  _paramsUseElementReference(action, params = {}) {
    if (
      (action === 'fillForm' || action === 'formSubmit') &&
      Array.isArray(params.fields) &&
      params.fields.some(field => field?.index != null)
    ) return true
    if (action === 'formSubmit' && params.submit?.index != null) return true
    if (params.index != null || params.sourceIndex != null || params.source_index != null) return true
    if (params.targetIndex != null || params.target_index != null) return true
    return ['element', 'dropdownOptions', 'select', 'upload', 'hover', 'focus', 'drag'].includes(String(action || ''))
  }

  _decisionTokenScope(action) {
    const name = String(action || '')
    if (name === 'search' || name === 'navigate') {
      // Explicit navigation does not consume DOM state. A memory-governor
      // rematerialization may replace the underlying View while preserving the
      // same logical session/tab; execute the user's intent against that new
      // View instead of rejecting it as stale.
      return { document: false, selectors: false, tabList: false, view: false }
    }
    if (name === 'wait' || name === 'settle') {
      // Waiting is specifically intended to span ordinary document/DOM churn.
      // Keep the logical session, foreground tab and concrete View as hard
      // safety boundaries, but do not reject just because the page progressed
      // while the model was deciding to wait. Background tab-list changes are
      // unrelated as long as the foreground tab stays the same.
      return { document: false, selectors: false, tabList: false, view: true }
    }
    if (name === 'waitForState') {
      // Program state waits are bound to a host-pinned backend node, not to a
      // selector-map slot. Same-document observations may therefore advance
      // selectorGeneration while the wait is running. The native wait performs
      // its own stricter page/document/tab identity check around every poll.
      return { document: true, selectors: false, tabList: false, view: true }
    }
    if (name === 'newTab' || name === 'switchTab' || name === 'closeTab') {
      return { document: false, selectors: false, tabList: true, view: false }
    }
    return {
      document: true,
      selectors: true,
      tabList: true,
      view: true
    }
  }

  _assertDecisionToken(sessionId, params = {}, action = 'browser action') {
    const expected = params?._fanDecisionToken
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return null
    const sid = String(sessionId || 'main')
    const current = this._browserDecisionToken(sid)
    const scope = this._decisionTokenScope(action)
    const mismatches = []
    if (String(expected.sessionId || '') !== sid) mismatches.push('session')
    if (!current) {
      mismatches.push('active-browser')
    } else {
      if (String(expected.activeTabId || '') !== current.activeTabId) mismatches.push('active-tab')
      if (scope.view && Number(expected.viewEpoch) !== current.viewEpoch) {
        mismatches.push('view-epoch')
      }
      if (
        scope.document &&
        expected.documentRevision != null &&
        Number(expected.documentRevision) !== current.documentRevision
      ) mismatches.push('document-revision')
      if (scope.selectors && Number(expected.pageGeneration) !== current.pageGeneration) mismatches.push('page-generation')
      if (scope.selectors && Number(expected.selectorGeneration) !== current.selectorGeneration) mismatches.push('selector-generation')
      if (scope.tabList && Number(expected.tabListGeneration) !== current.tabListGeneration) mismatches.push('tab-list-generation')
    }
    if (!mismatches.length) return current

    const error = new Error(
      `Browser state changed after the model observed it (${mismatches.join(', ')}). ` +
      `The ${action} action was not executed; observe again and replan from fresh element indices.`
    )
    if (mismatches.includes('session')) error.code = 'BROWSER_SESSION_MISMATCH'
    else if (this._paramsUseElementReference(action, params)) error.code = 'STALE_ELEMENT_REFERENCE'
    else error.code = 'BROWSER_STATE_CHANGED'
    error.details = {
      retryable: true,
      replanRequired: true,
      action: String(action || ''),
      reason: mismatches.join(','),
      stateChanges: mismatches.slice(),
      expected,
      current
    }
    throw error
  }

  _assertEntryDecisionToken(entry, params = {}, action = 'browser action') {
    this._assertNoSessionIntervention(this._sessionIdForEntry(entry), action)
    if (!params?._fanDecisionToken) return null
    return this._assertDecisionToken(this._sessionIdForEntry(entry), params, action)
  }

  _entryActionLease(entry, params = {}, action = 'browser action') {
    return () => this._assertEntryDecisionToken(entry, params, action)
  }

  _attachDecisionToken(sessionId, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result
    const token = this._browserDecisionToken(sessionId)
    if (token) result.__fanDecisionToken = token
    return result
  }

  _selectorLookupIndex(element = {}) {
    const value = Number(element.selectorIndex ?? element.selector_index ?? element.index)
    return Number.isFinite(value) ? value : Number(element.index)
  }

  // EVT-05:暴露给 agent 的事件做白名单投影(对齐 紧凑投影)。原始 history 里的
  // CDP_MESSAGE 带 console.consoleAPICalled 完整实参 / Network.responseReceived 完整 response 对象,
  // JSON.stringify 后单次工具结果轻松几十万字、触发持久化截断。只回 {type,timestamp}+按需紧凑标量,
  // 原始 CDP_MESSAGE 直接排除(agent 需要的语义事件走 navigation/network/download 等 typed 事件)。
  _projectEventsForAgent(events = []) {
    const out = []
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || ev.type === EVENT_TYPES.CDP_MESSAGE) continue
      const p = ev.payload || {}
      const slim = { type: ev.type, timestamp: ev.timestamp }
      if (p.id != null) slim.id = p.id
      if (p.url) slim.url = String(p.url).slice(0, 500)
      if (p.method) slim.method = String(p.method)
      if (p.reason) slim.reason = String(p.reason)
      if (p.state) slim.state = String(p.state)
      if (p.permission) slim.permission = String(p.permission)
      if (p.targetId) slim.targetId = String(p.targetId)
      if (p.sessionId != null) slim.sessionId = String(p.sessionId)
      if (p.workbenchId != null) slim.workbenchId = String(p.workbenchId)
      if (p.controlId != null) slim.controlId = String(p.controlId)
      if (p.revision != null) slim.revision = Number(p.revision) || 0
      if (p.active != null) slim.active = Boolean(p.active)
      if (p.toolName != null) slim.toolName = String(p.toolName)
      if (p.toolCallId != null) slim.toolCallId = String(p.toolCallId)
      if (p.targetUrl != null) slim.targetUrl = String(p.targetUrl).slice(0, 500)
      if (p.initialUrl != null) slim.initialUrl = String(p.initialUrl).slice(0, 500)
      if (p.activeTabId != null) slim.activeTabId = String(p.activeTabId)
      if (p.inputKind != null) slim.inputKind = String(p.inputKind)
      if (p.interventionId != null) slim.interventionId = String(p.interventionId)
      if (p.currentTabId != null) slim.currentTabId = String(p.currentTabId)
      if (p.anchorTabId != null) slim.anchorTabId = String(p.anchorTabId)
      if (p.agentAnchorTabId != null) slim.agentAnchorTabId = String(p.agentAnchorTabId)
      if (p.userTabId != null) slim.userTabId = String(p.userTabId)
      for (const timestampField of ['startedAt', 'updatedAt', 'stoppedAt']) {
        if (p[timestampField] != null) slim[timestampField] = Number(p[timestampField]) || null
      }
      if (p.timestamp != null) slim.interventionTimestamp = Number(p.timestamp) || null
      const err = p.error || p.errorDescription || p.errorText
      if (err) slim.error = String(err).slice(0, 300)
      if (p.download) slim.download = { url: p.download.url, filename: p.download.filename, state: p.download.state }
      out.push(slim)
    }
    return out
  }

  async handleRpc(payload = {}) {
    const action = String(payload.action || '').trim()
    const sessionId = String(payload.id || payload.workbenchId || 'main')
    const rawParams = payload.params && typeof payload.params === 'object' ? payload.params : {}
    const actionTraceId = String(payload.actionId || payload.action_id || '')
    const params = action === 'click' && actionTraceId
      ? { ...rawParams, _fanActionTraceId: actionTraceId }
      : rawParams
    if (!action) throw new Error('browser runtime action is required')

    // Control ownership is its own plane. It must remain recoverable while page
    // actions are blocked by intervention, and must not consume ordinary action
    // timeout/activity accounting merely to reconcile the native operating frame.
    if (action === 'beginControl') return this.beginControl(sessionId, params)
    // `force` is reserved for direct Main-process lifecycle cleanup. Remote RPC
    // callers must always identify the control they intend to end.
    if (action === 'endControl') return this.endControl(sessionId, { ...params, force: false })
    if (action === 'controlState') return this.controlState(sessionId)

    // Route page-level RPCs to the session's ACTIVE tab; tab-management actions
    // operate on the SESSION group itself. Single-tab resolves to the session id,
    // so page actions are unchanged until tabs are added.
    const id = this._activeTabId(sessionId)
    if (!INTERVENTION_SAFE_ACTIONS.has(action) && this._sessionInterventionPending(sessionId)) {
      return this._interventionBlockedResult(id, sessionId, action)
    }
    // Validate model decision identity before inspecting verification state.
    // Otherwise a stale indexed action can miss its former escape link and be
    // misreported as a fresh human-verification block instead of requiring a
    // new observation/replan.
    if (params._fanDecisionToken) this._assertDecisionToken(sessionId, params, action)
    const verificationPending = this._behavioralVerificationPending(id)
    const verificationEscape = verificationPending
      ? this._verificationEscapePlan(id, action, params)
      : null
    if (!VERIFICATION_SAFE_ACTIONS.has(action) && verificationPending && !verificationEscape) {
      return this._verificationBlockedResult(id, sessionId, action)
    }
    const beforeToken = this._browserDecisionToken(sessionId)
    // Main synchronously projects every tab add/remove into sessionTabs. Keep
    // only the pre-click identity set here so a tab-changing click can return
    // the exact newly opened tab without inventing another topology tracker.
    // Reading the raw identity projection also keeps ordinary clicks independent
    // of live WebContents metadata.
    const beforeClickTabIds = action === 'click'
      ? [...(this.sessionTabs.get(sessionId)?.tabs || [])].map(String)
      : null
    const passiveRead = PASSIVE_READ_ACTIONS.has(action) || (action === 'observe' && params._fanPassiveRead === true)

    const run = async () => {
      switch (action) {
        case 'health':
          return { ok: true, workbenches: Array.from(this.workbenches.keys()) }
        case 'events':
          return { events: this._projectEventsForAgent(this.eventBus.getHistory(params.limit || 100)) }
        case 'targets':
          return this.targets(id)
        case 'targetInfo':
          return this.targetInfo(id, params)
        case 'switchTarget':
          return this.switchTarget(id, params)
        case 'closeTarget':
          return this.closeTarget(id, params)
        case 'cdp':
          return this.cdp(id, params.method, params.params || {}, params.sessionId, params._fanDecisionToken)
        case 'storageState':
          return this.storageState(id, params)
        case 'saveStorageState':
          return this.saveStorageState(id, params)
        case 'loadStorageState':
          return this.loadStorageState(id, params)
        case 'grantPermissions':
          return this.grantPermissions(id, params)
        case 'setNetworkConfig':
          return this.setNetworkConfig(id, params)
        case 'networkConfig':
          return this.networkConfig(id, params)
        case 'setUrlPolicy':
          return this.setUrlPolicy(id, params)
        case 'urlPolicy':
          return this.urlPolicy(id, params)
        case 'har':
          return this.har(id, params)
        case 'saveHar':
          return this.saveHar(id, params)
        case 'captchaState':
          return this.captchaState(id)
        case 'waitForCaptcha':
          return this.waitForCaptcha(id, params)
        case 'acknowledgeIntervention':
          return this.acknowledgeIntervention(id, params)
        case 'flagIntervention':
          return this.flagIntervention(sessionId, params)
        case 'startScreencast':
          return this.startScreencast(id, params)
        case 'stopScreencast':
          return this.stopScreencast(id, params)
        case 'highlight':
          return this.highlight(id, params)
        case 'observe':
          return this.observe(id, params)
        case 'searchPage':
          return this.searchPage(id, params)
        case 'findElements':
          return this.findElements(id, params)
        case 'pageContent':
          return this.pageContent(id, params)
        case 'search':
          return this.search(id, params)
        case 'navigate':
          return this.navigate(id, params.url, params)
        case 'click':
          if (verificationEscape?.kind === 'link-navigation') {
            // Never dispatch pointer/click handlers while a behavioral
            // challenge is active. Selector metadata is page-controlled, so a
            // seemingly harmless anchor can still carry an onclick that
            // manipulates the challenge. Resolve its observed href and perform
            // a managed top-level navigation instead.
            const navigationParams = { ...params }
            delete navigationParams._fanDecisionToken
            delete navigationParams.index
            delete navigationParams.expected
            delete navigationParams.allowOccluded
            const navigated = await this.navigate(id, verificationEscape.url, navigationParams)
            return {
              ...navigated,
              clicked: Number(params.index),
              clickConvertedToNavigation: true
            }
          }
          return this.click(id, params)
        case 'type':
          return this.type(id, params)
        case 'fillForm':
          return this.fillForm(id, params)
        case 'formSubmit':
          return this.formSubmit(id, params)
        case 'scroll':
          return this.scroll(id, params)
        case 'scrollToText':
          return this.scrollToText(id, params)
        case 'dropdownOptions':
          return this.dropdownOptions(id, params)
        case 'select':
          return this.select(id, params)
        case 'mouse':
          return this.mouse(id, params)
        case 'hover':
          return this.hover(id, params)
        case 'focus':
          return this.focus(id, params)
        case 'drag':
          return this.drag(id, params)
        case 'evaluate':
          return this.evaluate(id, params)
        case 'evaluateJavaScript':
          return this.evaluateJavaScript(id, params)
        case 'element':
          return this.element(id, params)
        case 'dialog':
          return this.dialog(id, params)
        case 'screenshot':
          return this.screenshot(id, params)
        case 'saveScreenshot':
          return this.saveScreenshot(id, params)
        case 'savePdf':
          return this.savePdf(id, params)
        case 'setViewport':
          return this.setViewport(id, params)
        case 'upload':
          return this.upload(id, params)
        case 'sendKeys':
          return this.sendKeys(id, params)
        case 'back':
          return this.back(id, params)
        case 'forward':
          return this.forward(id, params)
        case 'reload':
          return this.reload(id, params)
        case 'wait':
          return this.wait(id, params)
        case 'waitForState':
          return this.waitForState(id, params)
        case 'settle':
          return this.settle(id, params)
        case 'listTabs':
          return this.listTabs(sessionId)
        case 'liveState':
          return this.liveState(sessionId)
        case 'newTab':
          return this.newTab(sessionId, params)
        case 'switchTab':
          return this.switchTab(sessionId, params)
        case 'closeTab':
          return this.closeTab(sessionId, params)
        default:
          throw new Error(`Unknown browser runtime action: ${action}`)
      }
    }

    if (['health', 'events'].includes(action)) return run()
    // `settle` reads params.timeoutMs as its OWN wait budget and returns a soft
    // { settled:false } at that deadline (a streaming chat page never goes network
    // idle, so it legitimately runs the full budget). Keying the action-timeout
    // safety-net to the SAME value makes the net race — and beat — that graceful
    // return, turning a normal "didn't settle" into a hard 'timed out' 500. Let
    // settle fall back to the long safety-net; its own budget does the real
    // bounding. Other actions keep params.timeoutMs as their hard cap.
    const safetyOverrideMs = ['settle', 'waitForState'].includes(action)
      ? undefined
      : params.timeoutMs
    let result
    try {
      result = await this._withActionTimeout(id, action, run, safetyOverrideMs, {
        announceOperating: !passiveRead
      })
    } catch (error) {
      // A takeover that races with another failure is the authoritative state:
      // do not expose a stale selector/CDP error and let the Agent continue.
      if (this._sessionInterventionPending(sessionId) || error?.code === 'HUMAN_INTERVENTION_PENDING') {
        const blocked = this._interventionBlockedResult(id, sessionId, action)
        const settlement = error?.[ACTION_SETTLEMENT_SYMBOL]
        if (settlement && blocked && typeof blocked === 'object') {
          // Keep the exact underlying CDP action available to the RPC
          // admission fence without leaking a Promise into JSON.
          Object.defineProperty(blocked, ACTION_SETTLEMENT_SYMBOL, {
            configurable: false,
            enumerable: false,
            value: settlement,
            writable: false
          })
        }
        const settledValue = settlement?.state === 'fulfilled' &&
          settlement.value &&
          typeof settlement.value === 'object'
          ? settlement.value
          : null
        const provenanceError = settlement?.state === 'rejected'
          ? settlement.error
          : error
        const details = provenanceError?.details && typeof provenanceError.details === 'object'
          ? provenanceError.details
          : {}
        const hasKnownEffect = (
          Object.prototype.hasOwnProperty.call(details, 'effect') ||
          Object.prototype.hasOwnProperty.call(settledValue || {}, 'effect')
        )
        const knownEffect = String(details.effect ?? settledValue?.effect ?? '').trim().toLowerCase()
        if (knownEffect && knownEffect !== 'none') {
          blocked.effect = knownEffect
        } else if (
          !hasKnownEffect &&
          !(details.beforeDispatch === true && details.dispatchAttempted === false)
        ) {
          // The native rejection and takeover can settle in the same turn. If
          // the error cannot prove that dispatch never happened, preserve an
          // unknown effect instead of turning the human boundary into a false
          // no-op that a higher layer might replay.
          blocked.effectUncertain = true
        }
        return blocked
      }
      throw error
    }
    // Navigation can legitimately abandon a behavioral challenge. Refresh its
    // state before attaching the action result; otherwise the pre-navigation
    // captchaState would make the Python guard open a verification prompt even
    // though the click already left the challenge page. If navigation did not
    // actually escape (preventDefault, reload into another challenge, etc.),
    // observe redetects it and the normal human gate still opens.
    let humanStateId = id
    if (verificationEscape) {
      humanStateId = this._activeTabId(sessionId)
      try {
        await this.observe(humanStateId, { _fanPassiveRead: true })
      } catch (error) {
        this.log(
          `browser verification escape refresh failed: action=${action} id=${humanStateId} ` +
          `error=${error?.message || String(error)}`
        )
      }
    }
    const withHumanState = this._attachHumanState(humanStateId, action, result)
    if (withHumanState && typeof withHumanState === 'object' && !Array.isArray(withHumanState)) {
      const afterToken = this._browserDecisionToken(sessionId)
      if (!withHumanState.effect) {
        withHumanState.effect = this._classifyActionEffect(action, beforeToken, afterToken, id)
      }
      if (
        action === 'click' &&
        withHumanState.effect === 'tab-change' &&
        withHumanState.openedTab == null
      ) {
        const openedTab = this._singleOpenedTab(beforeClickTabIds, this.listTabs(sessionId).tabs)
        if (openedTab) withHumanState.openedTab = openedTab
      }
      if (payload.actionId || payload.action_id) {
        withHumanState.actionId = String(payload.actionId || payload.action_id)
      }
    }
    return this._attachDecisionToken(sessionId, withHumanState)
  }

  _singleOpenedTab(beforeTargetIds, afterTabs) {
    if (!Array.isArray(beforeTargetIds) || !Array.isArray(afterTabs)) return null
    const beforeTargets = new Set(beforeTargetIds.map(String).filter(Boolean))
    const opened = afterTabs.filter(tab => {
      const targetId = String(tab?.targetId || '')
      return targetId && !beforeTargets.has(targetId)
    })
    if (opened.length !== 1) return null
    const tab = opened[0]
    return {
      stableId: String(tab.stableId || ''),
      tabId: String(tab.tabId || ''),
      url: String(tab.url || ''),
      title: String(tab.title || ''),
      current: tab.current === true,
      loading: tab.loading === true,
      crashed: tab.crashed === true
    }
  }

  _classifyActionEffect(action, before, after, id) {
    if (!before || !after) return 'none'
    if (before.activeTabId !== after.activeTabId || before.tabListGeneration !== after.tabListGeneration) {
      return 'tab-change'
    }
    if (before.pageGeneration !== after.pageGeneration) {
      const reason = String(this.workbenches.get(String(id))?.selectorMap?.reason || '')
      return reason === 'dom.documentUpdated' ? 'dom-structure' : 'navigation'
    }
    if (['navigate', 'back', 'forward', 'reload'].includes(action)) return 'navigation'
    if (['newTab', 'switchTab', 'closeTab'].includes(action)) return 'tab-change'
    const valueOnlyActions = new Set(['type', 'fillForm', 'focus'])
    if (valueOnlyActions.has(action)) return 'value-only'
    const structuralActions = new Set([
      'click', 'formSubmit', 'scroll', 'scrollToText', 'select', 'sendKeys', 'mouse', 'hover',
      'drag', 'evaluate', 'evaluateJavaScript', 'element', 'dialog', 'upload',
      'setViewport', 'dropdownOptions'
    ])
    if (structuralActions.has(action)) return 'dom-structure'
    return 'none'
  }

  // Surface the human-in-the-loop state on EVERY workbench action result so the
  // backend tool (electron_browser_tool._guard_human) can block the agent at the
  // next action boundary: a captcha challenge (captchaState.detected) or the user
  // taking manual control (interventionPending). observe refreshes captchaState
  // just before this runs; other actions carry the last-known state.
  _nextInterventionId(sessionId) {
    this._interventionSequence = Math.max(0, Number(this._interventionSequence) || 0) + 1
    return (
      `takeover-${String(sessionId || 'main')}-` +
      `${Date.now().toString(36)}-${this._interventionSequence.toString(36)}`
    )
  }

  _normalizeInterventionMeta(sessionId, meta = {}, previous = null) {
    const sid = String(sessionId || 'main').split('#')[0]
    const now = Date.now()
    const currentTabId = String(
      meta.currentTabId ||
      meta.userTabId ||
      this._activeTabId(sid) ||
      sid
    )
    const anchorTabId = String(
      previous?.anchorTabId ||
      previous?.agentAnchorTabId ||
      meta.anchorTabId ||
      meta.agentAnchorTabId ||
      this._controlStates.get(sid)?.activeTabId ||
      currentTabId
    )
    return {
      ...(previous || {}),
      ...meta,
      kind: String(meta.kind || previous?.kind || 'page-input'),
      inputKind: String(meta.inputKind || previous?.inputKind || meta.kind || 'unknown'),
      sessionId: sid,
      // workbenchId is the session-scoped renderer identity. Keep the physical
      // source/active tab separately so multi-tab takeover events are not
      // filtered out as though they belonged to another workbench.
      workbenchId: sid,
      currentTabId,
      anchorTabId,
      agentAnchorTabId: anchorTabId,
      userTabId: String(meta.userTabId || currentTabId),
      interventionId: String(
        previous?.interventionId ||
        meta.interventionId ||
        this._nextInterventionId(sid)
      ),
      timestamp: Number(previous?.timestamp || meta.timestamp) || now,
      updatedAt: now
    }
  }

  _latchIntervention(sessionId, meta = {}) {
    const sid = String(sessionId || 'main').split('#')[0]
    const previous = this._interventions.get(sid) || null
    const normalized = this._normalizeInterventionMeta(sid, meta, previous)

    // This is the synchronous effect-admission fence. Publish the complete
    // session metadata and mark every workbench before notifying ProgramRunner
    // or the host; queued program requests therefore observe the closed gate.
    this._interventions.set(sid, normalized)
    for (const entry of this.workbenches.values()) {
      if (this._sessionIdForEntry(entry) === sid) entry.interventionPending = true
    }
    const eventDetails = normalized.eventType
      ? (
          ` event=${normalized.eventType}` +
          ` target=${normalized.targetSessionId || 'main'}` +
          ` topFrame=${normalized.topFrame !== false}` +
          (normalized.x == null ? '' : ` x=${normalized.x}`) +
          (normalized.y == null ? '' : ` y=${normalized.y}`) +
          (normalized.deltaX == null ? '' : ` deltaX=${normalized.deltaX}`) +
          (normalized.deltaY == null ? '' : ` deltaY=${normalized.deltaY}`) +
          (normalized.buttons == null ? '' : ` buttons=${normalized.buttons}`) +
          (normalized.pointerType ? ` pointerType=${normalized.pointerType}` : '')
        )
      : ''
    this.log(
      `[browser-takeover:${normalized.interventionId}] intervention.detected ` +
      `session=${sid} workbench=${normalized.workbenchId} ` +
      `input=${normalized.inputKind} anchor=${normalized.agentAnchorTabId} ` +
      `userTab=${normalized.userTabId}${eventDetails}`
    )
    const event = this.eventBus.emit(EVENT_TYPES.USER_INTERVENED, {
      id: normalized.workbenchId || sid,
      tabId: normalized.currentTabId,
      ...normalized
    })
    const stored = { ...normalized, eventId: event?.id || null }
    this._interventions.set(sid, stored)
    return stored
  }

  _attachHumanState(id, action, result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result
    if (action === 'health' || action === 'events') return result
    const entry = this.workbenches.get(String(id))
    const sid = entry?.sessionId || String(id).split('#')[0]
    // captchaState() already returns the state as its top-level payload. Do not
    // assign that object back onto itself (`result.captchaState = result`),
    // which creates a circular RPC value and permanently contaminates the
    // workbench's stored challenge state.
    if (action !== 'captchaState' && result.captchaState === undefined) {
      result.captchaState = entry?.captchaState || { detected: false }
    }
    const tabIntervention = this._interventions.get(sid)
    if (result.interventionPending === undefined) {
      result.interventionPending = this._sessionInterventionPending(sid)
    }
    if (tabIntervention && result.interventionMeta === undefined) {
      // Carries kind/anchorTabId so the backend can tailor the banner ("切回工作标签").
      result.interventionMeta = tabIntervention
    }
    return result
  }

  _sessionInterventionPending(sessionId) {
    const sid = String(sessionId || 'main').split('#')[0]
    if (this._interventions.has(sid)) return true
    for (const entry of this.workbenches.values()) {
      if (this._sessionIdForEntry(entry) === sid && entry.interventionPending) return true
    }
    return false
  }

  sessionInterventionState(sessionId) {
    const sid = String(sessionId || 'main').split('#')[0]
    const interventionMeta = this._interventions.get(sid)
    return {
      interventionPending: this._sessionInterventionPending(sid),
      ...(interventionMeta ? { interventionMeta: { ...interventionMeta } } : {})
    }
  }

  _interventionBlockedResult(id, sessionId, action) {
    const blocked = this._attachHumanState(id, action, {
      blocked: 'human-intervention',
      ok: false
    })
    return this._attachDecisionToken(sessionId, blocked)
  }

  _behavioralVerificationPending(id) {
    const captcha = this.workbenches.get(String(id || ''))?.captchaState
    return Boolean(
      captcha?.detected &&
      captcha?.requiresUserInput !== false
    )
  }

  _verificationEscapePlan(id, action, params = {}) {
    if (VERIFICATION_ESCAPE_NAVIGATION_ACTIONS.has(action)) return { kind: action }
    if (action !== 'click' || params.index == null) return null

    const entry = this.workbenches.get(String(id || ''))
    const element = entry?.selectorMap?.get(params.index)
    const tag = String(element?.tag || '').trim().toLowerCase()
    if (tag !== 'a' && tag !== 'area') return null

    const attributes = element?.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const target = String(attributes.target || element?.target || '').trim().toLowerCase()
    if (target && target !== '_self') return null
    if (attributes.download != null || element?.download != null) return null

    const href = String(element?.href || attributes.href || '').trim()
    const currentHref = String(
      entry?.captchaState?.url ||
      entry?.domState?.url ||
      entry?.webContents?.getURL?.() ||
      ''
    ).trim()
    if (!href || !currentHref) return null

    try {
      const destination = new URL(href, currentHref)
      const current = new URL(currentHref)
      if (!['http:', 'https:'].includes(destination.protocol)) return null
      destination.hash = ''
      current.hash = ''
      return destination.href !== current.href
        ? { kind: 'link-navigation', url: destination.href }
        : null
    } catch {
      return null
    }
  }

  _verificationBlockedResult(id, sessionId, action) {
    const blocked = this._attachHumanState(id, action, {
      blocked: 'human-verification',
      ok: false
    })
    return this._attachDecisionToken(sessionId, blocked)
  }

  _assertNoSessionIntervention(sessionId, action = 'browser action') {
    const sid = String(sessionId || 'main').split('#')[0]
    if (!this._sessionInterventionPending(sid)) return
    const error = new Error(`Browser runtime action '${action}' blocked while human intervention is pending`)
    error.code = 'HUMAN_INTERVENTION_PENDING'
    error.details = {
      retryable: false,
      replanRequired: true,
      action: String(action || ''),
      reason: 'human-intervention',
      interventionMeta: this._interventions.get(sid) || undefined
    }
    throw error
  }

  _coerceTimeout(value, fallback) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback
    return Math.max(100, Math.min(600000, numeric))
  }

  _actionTimeoutFor(action) {
    return (this.actionTimeouts && this.actionTimeouts[action]) || this.actionTimeoutMs
  }

  async _withActionTimeout(id, action, operation, overrideMs, activityOptions = {}) {
    // EVT-01:显式 override 优先,否则用该动作的 per-action 上限(无表项才回落 180s 全局)
    const timeoutMs = this._coerceTimeout(overrideMs, this._actionTimeoutFor(action))
    const activity = this._beginActionActivity(id, activityOptions)
    const sessionId = String(id || 'main').split('#')[0]
    const settlement = {
      state: 'pending',
      value: undefined,
      error: undefined,
      promise: null
    }
    const attachSettlement = error => {
      Object.defineProperty(error, ACTION_SETTLEMENT_SYMBOL, {
        configurable: false,
        enumerable: false,
        value: settlement,
        writable: false
      })
      return error
    }
    let unsubscribeIntervention = null
    const intervention = INTERVENTION_SAFE_ACTIONS.has(action)
      ? new Promise(() => undefined)
      : new Promise((_resolve, reject) => {
          const rejectForIntervention = () => {
            const error = new Error(`Browser runtime action '${action}' interrupted by human control`)
            error.code = 'HUMAN_INTERVENTION_PENDING'
            error.details = {
              retryable: false,
              replanRequired: true,
              action: String(action || ''),
              reason: 'human-intervention'
            }
            reject(attachSettlement(error))
          }

          unsubscribeIntervention = this.eventBus.on(EVENT_TYPES.USER_INTERVENED, event => {
            const payload = event?.payload || {}
            const eventSessionId = String(payload.sessionId || payload.id || '').split('#')[0]
            if (eventSessionId && eventSessionId !== sessionId) return
            rejectForIntervention()
          })

          // Close the small gap between handleRpc's preflight check and installing
          // this listener. The underlying operation remains tracked until it really
          // settles, but the caller can display the control prompt immediately.
          if (this._sessionInterventionPending(sessionId)) rejectForIntervention()
        })
    let actionPromise
    try {
      actionPromise = typeof operation === 'function' ? operation() : operation
    } catch (error) {
      actionPromise = Promise.reject(error)
    }
    // The public timeout does not cancel CDP work. Keep the exact view protected
    // until the underlying operation actually settles, not merely until the
    // timeout race returns to its caller.
    const trackedPromise = Promise.resolve(actionPromise).finally(() => this._endActionActivity(activity))
    settlement.promise = trackedPromise.then(
      value => {
        settlement.state = 'fulfilled'
        settlement.value = value
      },
      error => {
        settlement.state = 'rejected'
        settlement.error = error
      }
    )
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Browser runtime action '${action}' timed out after ${timeoutMs}ms`)
        error.code = 'ACTION_TIMEOUT_PENDING'
        error.details = {
          retryable: false,
          replanRequired: true,
          action,
          reason: 'underlying-action-still-settling'
        }
        attachSettlement(error)
        this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id, action, error: error.message, timeoutMs })
        reject(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([trackedPromise, timeout, intervention])
    } finally {
      if (timer) clearTimeout(timer)
      if (unsubscribeIntervention) unsubscribeIntervention()
    }
  }

  async cdp(id, method, params = {}, sessionId = undefined, decisionToken = null) {
    const entry = this.getWorkbench(id)
    const sid = this._sessionIdForEntry(entry)
    const cdpMethod = String(method || '').trim()
    this._assertNoSessionIntervention(sid, 'cdp')
    if (cdpMethod === 'Target.createTarget') {
      const error = new Error('Raw CDP Target.createTarget is not allowed; use the newTab action instead')
      error.code = 'CDP_TARGET_CREATION_BLOCKED'
      throw error
    }
    await this._prepare(entry)
    this._assertNoSessionIntervention(sid, 'cdp')
    if (decisionToken) {
      this._assertDecisionToken(
        sid,
        { _fanDecisionToken: decisionToken },
        'cdp'
      )
    }
    const isTopLevel = sessionId == null
    if (!isTopLevel || !this._isTopLevelCdpNavigationMethod(cdpMethod)) {
      return entry.client.send(method, params, sessionId)
    }
    return this._runTopLevelCdpNavigation(entry, cdpMethod, params, sessionId)
  }

  async _usingResolvedBackendNode(entry, backendNodeId, sessionId, callback) {
    const resolved = await entry.client.send('DOM.resolveNode', { backendNodeId }, sessionId)
    const objectId = resolved?.object?.objectId
    if (!objectId) return null
    try {
      return await callback(objectId, resolved.object)
    } finally {
      await entry.client.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined)
    }
  }

  _runtimeEvaluationValue(result, actionName) {
    if (result?.exceptionDetails) {
      throw new Error(`${actionName} failed: ${result.exceptionDetails.text || 'Runtime.evaluate exception'}`)
    }
    if (!result?.result || !Object.prototype.hasOwnProperty.call(result.result, 'value')) {
      throw new Error(`${actionName} returned no result`)
    }
    const value = result.result.value
    if (value && typeof value === 'object' && value.error) {
      throw new Error(`${actionName}: ${value.error}`)
    }
    return value
  }

  _coerceLimitedInteger(value, fallback, min, max) {
    return coerceLimitedInteger(value, fallback, min, max)
  }

  _searchPageExpression(options) {
    return searchPageExpression(options)
  }

  _formatSearchPageResults(data, pattern) {
    return formatSearchPageResults(data, pattern)
  }

  async searchPage(id, params = {}) {
    const pattern = String(params.pattern || params.query || '').trim()
    if (!pattern) throw new Error('pattern is required')
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'searchPage')
    const contextChars = this._coerceLimitedInteger(params.contextChars ?? params.context_chars, 150, 0, 5000)
    const maxResults = this._coerceLimitedInteger(params.maxResults ?? params.max_results, 25, 1, 200)
    const expression = this._searchPageExpression({
      pattern,
      regex: params.regex === true,
      caseSensitive: params.caseSensitive === true || params.case_sensitive === true,
      contextChars,
      cssScope: params.cssScope ?? params.css_scope ?? null,
      maxResults
    })
    const evaluated = await entry.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const data = this._runtimeEvaluationValue(evaluated, 'searchPage')
    return {
      ...data,
      pattern,
      contextChars,
      maxResults,
      formatted: this._formatSearchPageResults(data, pattern)
    }
  }

  _findElementsExpression(options) {
    return findElementsExpression(options)
  }

  _formatFindElementsResults(data, selector) {
    return formatFindElementsResults(data, selector)
  }

  async findElements(id, params = {}) {
    const selector = String(params.selector || '').trim()
    if (!selector) throw new Error('selector is required')
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'findElements')
    const maxResults = this._coerceLimitedInteger(params.maxResults ?? params.max_results, 50, 1, 200)
    const attributes = Array.isArray(params.attributes)
      ? params.attributes.map(value => String(value || '').trim()).filter(Boolean).slice(0, 50)
      : null
    const includeText = params.includeText !== false && params.include_text !== false
    const actionableCandidates = typeof entry.selectorMap?.snapshot === 'function'
      ? entry.selectorMap.snapshot().elements
        .filter(element => element && element.selector && !element.sessionId)
        .map(element => ({ index: Number(element.index), selector: String(element.selector) }))
        .filter(element => Number.isFinite(element.index) && element.selector)
      : []
    const expression = this._findElementsExpression({
      selector,
      attributes,
      maxResults,
      includeText,
      actionableCandidates
    })
    const evaluated = await entry.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const data = this._runtimeEvaluationValue(evaluated, 'findElements')
    return {
      ...data,
      selector,
      attributes,
      maxResults,
      includeText,
      formatted: this._formatFindElementsResults(data, selector)
    }
  }

  async pageContent(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'pageContent')
    const format = coerceFormat(params.format)
    const opts = {
      format,
      extractLinks: params.extractLinks === true || params.extract_links === true,
      extractImages: params.extractImages === true || params.extract_images === true
    }

    let content = ''
    let stats = {}
    let method = 'cdp_snapshot'

    try {
      // SHC-3:数据源走 CDP 增强快照树(穿透 closed shadow + iframe),不再受页面 JS 沙箱 live DOM
      // 拿不到 closed shadow / 跨域 iframe 的限制。逐 session 抓(主 session 无 sessionId + 各 OOPIF)。
      const sessions = [{ sessionId: undefined, targetUrl: '' }]
      if (typeof entry.targetManager?.attachedTargets === 'function') {
        for (const item of entry.targetManager.attachedTargets()) {
          if (item?.sessionId) sessions.push({ sessionId: item.sessionId, targetUrl: item.target?.url || '' })
        }
      }
      const allRoots = []
      const seenDocKeys = new Set()
      for (const { sessionId, targetUrl } of sessions) {
        if (sessionId) {
          await entry.client.send('Runtime.enable', {}, sessionId).catch(() => undefined)
          await entry.client.send('DOM.enable', {}, sessionId).catch(() => undefined)
        }
        const snapshot = await entry.client
          .send('DOMSnapshot.captureSnapshot', snapshotCaptureParams(), sessionId)
          .catch(() => null)
        if (!snapshot) continue
        if (sessionId && targetUrl && !snapshotBelongsToTarget(snapshot, targetUrl)) continue
        // 内容提取走整棵 traversalRoots,无需 accessibility/jsListener/previousState/maxElements 裁剪
        const enhanced = buildEnhancedSnapshotState(snapshot, { maxElements: 1 })
        for (const root of enhanced.traversalRoots || []) {
          // 去重键:跨进程 iframe 文档可能既经主 session linkContentDocuments 缝进、又作 OOPIF 独立根
          const key = String(root?.documentUrl || '') + '::' + String(root?.frameId || '')
          if (key !== '::' && seenDocKeys.has(key)) continue
          if (key !== '::') seenDocKeys.add(key)
          allRoots.push(root)
        }
      }
      if (!allRoots.length) throw new Error('snapshot produced no roots')
      const serialized = serializeSnapshotContent(allRoots, opts)
      if (!serialized?.ok) throw new Error(serialized?.error || 'snapshot serialize failed')
      content = serialized.content
      stats = serialized.stats
    } catch (snapshotError) {
      // 回退:原 live-DOM 沙箱序列化器(快照失败/超时/空文档时),行为与改动前完全一致,零退化。
      method = 'live_dom'
      const expression = buildPageContentExpression(opts)
      const evaluated = await entry.client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      const value = this._runtimeEvaluationValue(evaluated, 'pageContent')
      if (!value?.ok) throw new Error(value?.error || 'pageContent failed')
      content = value.content || ''
      stats = { ...(value.stats || {}), fallbackReason: snapshotError.message }
    }

    const chunk = chunkContent(content, {
      startFromChar: params.startFromChar ?? params.start_from_char ?? 0,
      maxChars: params.maxChars ?? params.max_chars ?? 100000,
      format,
      overlapLines: params.overlapLines ?? params.overlap_lines ?? 5
    })
    return {
      format,
      content: chunk.content,
      stats: {
        ...stats,
        method,
        originalContentChars: String(content || '').length,
        returnedChars: chunk.content.length,
        startFromChar: chunk.startFromChar,
        maxChars: chunk.maxChars,
        truncated: chunk.truncated,
        hasMore: chunk.hasMore,
        nextStartChar: chunk.nextStartChar,
        chunkIndex: chunk.chunkIndex,
        totalChunks: chunk.totalChunks,
        charOffsetStart: chunk.charOffsetStart,
        charOffsetEnd: chunk.charOffsetEnd,
        overlapPrefixChars: String(chunk.overlapPrefix || '').length,
        mainContentStart: Number(chunk.mainContentStart) || 0
      }
    }
  }

  async _prepare(entry) {
    await entry.client.attach()
    await entry.targetManager.start()
    await entry.client.send('Runtime.enable').catch(() => undefined)
    await entry.client.send('Page.enable').catch(() => undefined)
    await this._initializeDocumentState(entry)
    await entry.client.send('DOM.enable').catch(() => undefined)
    await entry.client.send('Network.enable').catch(() => undefined)
    await entry.client.send('Security.enable').catch(() => undefined)
    await this._installStealth(entry)
    await this._applyNetworkConfig(entry)
    await this._armInterventionWatch(entry)
  }

  // Injected into the page's MAIN world before any page script and re-applied on
  // every navigation (CDP on-new-document), idempotent per workbench. Two jobs:
  //   1) close guard — anti-bot pages (e.g. zhipin) call window.close() to kill
  //      the page, which destroys the host-managed WebContentsView and wedges the
  //      session with "WebContentsView not found". The page must never be able to
  //      close the host's view.
  //   2) basic stealth — hide the most common automation tells that anti-bot
  //      scripts check FIRST (navigator.webdriver is the classic one). This is a
  //      cheap first layer, NOT a full anti-detection suite.
  async _installStealth(entry) {
    if (entry._stealthInstalled) return
    const guardWindowClose = this._shouldGuardWindowClose(entry)
    const source = `(() => {
      const def = (obj, prop, get) => { try { Object.defineProperty(obj, prop, { get, configurable: true }); } catch (e) {} };
      ${guardWindowClose
        ? "try { Object.defineProperty(window, 'close', { value: function () {}, writable: false, configurable: true }); } catch (e) {}"
        : ''}
      def(navigator, 'webdriver', () => false);
      try { if (!navigator.languages || !navigator.languages.length) def(navigator, 'languages', () => ['zh-CN', 'zh']); } catch (e) {}
      try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
      try { if (navigator.plugins && navigator.plugins.length === 0) def(navigator, 'plugins', () => [1, 2, 3, 4, 5]); } catch (e) {}
      try {
        const q = navigator.permissions && navigator.permissions.query;
        // PERM-2:仅当通知权限真未决(default)时才用 Notification.permission 回落;否则放行原生
        // q(p),让 setPermissionCheckHandler 授予的 'granted' 态透出(原无条件改写会盖掉它)。
        if (q) navigator.permissions.query = (p) => (p && p.name === 'notifications' && Notification.permission === 'default')
          ? Promise.resolve({ state: Notification.permission }) : q(p);
      } catch (e) {}
    })();`
    const added = await entry.client
      .send('Page.addScriptToEvaluateOnNewDocument', { source })
      .catch(() => null)
    if (added) entry._stealthInstalled = true
  }

  async targets(id) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    return entry.targetManager.snapshot()
  }

  async targetInfo(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'targetInfo')
    const snapshot = typeof entry.targetManager?.snapshot === 'function' ? entry.targetManager.snapshot() : { targets: [], sessions: [] }
    const identifier = params.targetId || params.target_id || params.tabId || params.tab_id
    let targetId = ''
    let target = null
    if (identifier) {
      const resolved = this._resolveTargetForAction(entry, params)
      targetId = resolved.targetId
      target = resolved.target || null
    } else if (entry.focusTargetId) {
      targetId = entry.focusTargetId
      target = snapshot.targets.find(item => item.targetId === targetId) || null
    }
    let cdpTargetInfo = null
    if (targetId) {
      cdpTargetInfo = await entry.client
        .send('Target.getTargetInfo', { targetId })
        .then(result => result?.targetInfo || null)
        .catch(() => null)
    }
    const targetInfo = cdpTargetInfo || target || {}
    const session = targetId ? snapshot.sessions.find(item => item.targetId === targetId) || null : null
    const currentPage = !identifier
    const webContentsUrl = typeof entry.webContents?.getURL === 'function' ? entry.webContents.getURL() : ''
    const webContentsTitle = typeof entry.webContents?.getTitle === 'function' ? entry.webContents.getTitle() : ''
    const output = {
      workbenchId: entry.id,
      targetId: targetInfo.targetId || targetId || null,
      tabId: targetInfo.targetId || targetId ? String(targetInfo.targetId || targetId).slice(-4) : null,
      type: targetInfo.type || (currentPage ? 'page' : ''),
      url: targetInfo.url || (currentPage ? webContentsUrl : ''),
      title: targetInfo.title || (currentPage ? webContentsTitle : ''),
      attached: Boolean(session),
      sessionId: session?.sessionId || null,
      current: currentPage || Boolean(targetId && targetId === entry.focusTargetId),
      targetInfo: Object.keys(targetInfo).length ? targetInfo : null
    }
    return output
  }

  _resolveTargetForAction(entry, params = {}) {
    const identifier = params.targetId || params.target_id || params.tabId || params.tab_id
    const value = String(identifier || '').trim()
    if (!value) throw new Error('targetId or tabId is required')
    const resolved = entry.targetManager.resolveTarget(value)
    if (!resolved) throw new Error(`Target ${value} is not available`)
    if (resolved.ambiguous) throw new Error(`Target ${value} is ambiguous`)
    return resolved
  }

  async switchTarget(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'switchTarget')
    const resolved = this._resolveTargetForAction(entry, params)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'switchTarget', targetId: resolved.targetId })
    try {
      await entry.client.send('Target.activateTarget', { targetId: resolved.targetId })
      entry.focusTargetId = resolved.targetId
      this._clearSelectorMap(entry, 'switch-target', { targetId: resolved.targetId })
      const output = {
        switched: true,
        targetId: resolved.targetId,
        tabId: resolved.targetId.slice(-4),
        target: resolved.target || null
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'switchTarget', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'switchTarget', error: error.message })
      throw error
    }
  }

  async closeTarget(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'closeTarget')
    const resolved = this._resolveTargetForAction(entry, params)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'closeTarget', targetId: resolved.targetId })
    try {
      const result = await entry.client.send('Target.closeTarget', { targetId: resolved.targetId })
      this._clearSelectorMap(entry, 'close-target', { targetId: resolved.targetId })
      const output = {
        closed: result?.success !== false,
        targetId: resolved.targetId,
        tabId: resolved.targetId.slice(-4),
        target: resolved.target || null
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'closeTarget', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'closeTarget', error: error.message })
      throw error
    }
  }

  _normalizeHTTPHeaders(headers = {}) {
    return browserIO.normalizeHTTPHeaders(headers)
  }

  _networkSessionIds(entry) {
    return browserIO.networkSessionIds(entry)
  }

  async _applyNetworkConfig(entry) {
    return browserIO.applyNetworkConfig(this, entry)
  }

  networkConfig(id, params = {}) {
    return browserIO.networkConfig(this, id, params)
  }

  async setNetworkConfig(id, params = {}) {
    return browserIO.setNetworkConfig(this, id, params)
  }

  _normalizeStringList(value) {
    return normalizeStringList(value)
  }

  urlPolicy(id, params = {}) {
    const entry = this.getWorkbench(id)
    this._assertEntryDecisionToken(entry, params, 'urlPolicy')
    const policy = entry.urlPolicy || {}
    return {
      allowedDomains: [...(policy.allowedDomains || [])],
      prohibitedDomains: [...(policy.prohibitedDomains || [])],
      blockIPAddresses: Boolean(policy.blockIPAddresses)
    }
  }

  _emptyUrlPolicy() {
    return emptyUrlPolicy()
  }

  _normalizePolicyHost(host) {
    return normalizePolicyHost(host)
  }

  _normalizeUrlPolicyPattern(pattern) {
    return normalizeUrlPolicyPattern(pattern, host => this._normalizePolicyHost(host))
  }

  _compileUrlPolicySet(patterns) {
    // SEC-3:一次性退化告警(对齐 profile.py)。域名列表 >= 100 时改用 Set 做 O(1) 精确
    // 匹配,此时通配符模式(*.domain.com)不再被支持;若列表里含通配符,提醒用户拆成精确域名或保持
    // 列表 < 100。门控字段避免每次 setUrlPolicy 刷屏。
    if (!this._urlPolicyOptimizeWarned && shouldWarnForUrlPolicyOptimization(patterns)) {
      this._urlPolicyOptimizeWarned = true
      console.warn(
        `URL policy: optimizing domain list with ${patterns.length} items to a set for O(1) lookup; ` +
        `pattern matching (*.domain.com) is not supported for lists >= ${URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD} items — ` +
        `use exact domains or keep list size < ${URL_POLICY_DOMAIN_OPTIMIZATION_THRESHOLD} for pattern support.`
      )
    }
    return compileUrlPolicySet(patterns, pattern => this._normalizeUrlPolicyPattern(pattern))
  }

  _buildUrlPolicy(input = {}) {
    return buildUrlPolicy(input, {
      normalizeStringList: value => this._normalizeStringList(value),
      compileUrlPolicySet: patterns => this._compileUrlPolicySet(patterns)
    })
  }

  setUrlPolicy(id, params = {}) {
    const entry = this.getWorkbench(id)
    this._assertEntryDecisionToken(entry, params, 'setUrlPolicy')
    const current = entry.urlPolicy || this._defaultUrlPolicy || this._emptyUrlPolicy()
    if (params.clear === true) {
      // SEC-1(对齐 profile 全局 allowlist):清空也对所有标签生效
      this._defaultUrlPolicy = this._emptyUrlPolicy()
      for (const e of this.workbenches.values()) e.urlPolicy = this._defaultUrlPolicy
      return this.urlPolicy(id)
    }
    const nextInput = {
      allowedDomains:
        params.allowedDomains != null || params.allowed_domains != null
          ? this._normalizeStringList(params.allowedDomains ?? params.allowed_domains)
          : [...(current.allowedDomains || [])],
      prohibitedDomains:
        params.prohibitedDomains != null || params.prohibited_domains != null
          ? this._normalizeStringList(params.prohibitedDomains ?? params.prohibited_domains)
          : [...(current.prohibitedDomains || [])],
      blockIPAddresses:
        params.blockIPAddresses != null || params.block_ip_addresses != null
          ? Boolean(params.blockIPAddresses ?? params.block_ip_addresses)
          : Boolean(current.blockIPAddresses)
    }
    // SEC-1:URL 策略是 runtime 级全局,对所有标签(含未来 registerWorkbench 的新标签)生效,
    // 杜绝「新开标签起始为空策略 → 访问被禁域名」的 allowlist 逃逸。
    this._defaultUrlPolicy = this._buildUrlPolicy(nextInput)
    for (const e of this.workbenches.values()) e.urlPolicy = this._defaultUrlPolicy
    return this.urlPolicy(id)
  }

  _isRootDomain(domain) {
    return isRootDomain(domain, host => this._normalizePolicyHost(host))
  }

  _domainVariants(host) {
    return domainVariants(host, value => this._normalizePolicyHost(value))
  }

  _globToRegex(pattern) {
    return globToRegex(pattern)
  }

  _isIpHost(host) {
    return isIpHost(host)
  }

  _isAlwaysBlockedMetadataHost(host) {
    return isAlwaysBlockedMetadataHost(host)
  }

  _isUrlPatternMatch(url, parsed, pattern) {
    return isUrlPatternMatch(url, parsed, pattern, {
      normalizeUrlPolicyPattern: value => this._normalizeUrlPolicyPattern(value),
      normalizePolicyHost: host => this._normalizePolicyHost(host),
      globToRegex: value => this._globToRegex(value),
      isRootDomain: domain => this._isRootDomain(domain)
    })
  }

  _isHostAllowedByPolicySet(host, domainSet) {
    return isHostAllowedByPolicySet(host, domainSet, {
      domainVariants: value => this._domainVariants(value)
    })
  }

  urlPolicyDecision(entry, url) {
    return urlPolicyDecision(entry, url, {
      isAlwaysBlockedMetadataHost: host => this._isAlwaysBlockedMetadataHost(host),
      normalizePolicyHost: host => this._normalizePolicyHost(host),
      isIpHost: host => this._isIpHost(host),
      isHostAllowedByPolicySet: (host, domainSet) => this._isHostAllowedByPolicySet(host, domainSet),
      isUrlPatternMatch: (value, parsed, pattern) => this._isUrlPatternMatch(value, parsed, pattern)
    })
  }

  _assertUrlAllowed(entry, url, source = 'navigation') {
    const decision = this.urlPolicyDecision(entry, url)
    if (decision.allowed) return decision
    const error = new Error(`Navigation to ${url} blocked by URL policy: ${decision.reason}`)
    error.code = 'URL_POLICY_BLOCKED'
    error.decision = decision
    this.eventBus.emit(EVENT_TYPES.NAVIGATION_FAILED, {
      id: entry.id,
      url,
      errorDescription: error.message,
      reason: decision.reason,
      source
    })
    throw error
  }

  async grantPermissions(id, params = {}) {
    return browserIO.grantPermissions(this, id, params)
  }

  async har(id, params = {}) {
    return browserIO.har(this, id, params)
  }

  async saveHar(id, params = {}) {
    return browserIO.saveHar(this, id, params)
  }

  _harWithContentMode(snapshot, contentMode) {
    return browserIO.harWithContentMode(snapshot, contentMode)
  }

  async _prepareHarForSave(snapshot, filePath, contentMode) {
    return browserIO.prepareHarForSave(this, snapshot, filePath, contentMode)
  }

  _harSidecarFilename(bytes, mimeType = '') {
    return browserIO.harSidecarFilename(this, bytes, mimeType)
  }

  _harHeaderValue(headers = {}, name = '') {
    return browserIO.harHeaderValue(headers, name)
  }

  _extensionForMime(mimeType = '') {
    return browserIO.extensionForMime(mimeType)
  }

  async captchaState(id) {
    const entry = this.getWorkbench(id)
    const state = entry.captchaState || { detected: false }
    return {
      ...state,
      ...(Array.isArray(state.matches)
        ? { matches: state.matches.map(match => ({ ...match })) }
        : {})
    }
  }

  async waitForCaptcha(id, params = {}) {
    const entry = this.getWorkbench(id)
    const timeoutMs = this._coerceTimeout(params.timeoutMs || params.timeout_ms, 120000)
    const pollMs = Math.max(250, Math.min(5000, Number(params.pollMs || params.poll_ms) || 1000))
    const startedAt = Date.now()
    const humanVerificationPending = () => Boolean(
      entry.captchaState?.detected && entry.captchaState.requiresUserInput !== false
    )
    if (!humanVerificationPending()) {
      return { waited: false, cleared: true, elapsedMs: 0, captcha: entry.captchaState || { detected: false } }
    }
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      await this._pollCaptchaState(entry).catch(() => undefined)
      if (!humanVerificationPending()) {
        return { waited: true, cleared: true, elapsedMs: Date.now() - startedAt, captcha: entry.captchaState }
      }
    }
    return { waited: true, cleared: false, elapsedMs: Date.now() - startedAt, captcha: entry.captchaState }
  }

  // Flag a tab-strip human-takeover. main calls this when the USER switches/opens a
  // tab while the agent is operating. Session-scoped so the agent blocks on its next
  // action regardless of which tab is active.
  flagIntervention(sessionId, meta = {}) {
    const sid = String(sessionId).split('#')[0]
    const normalized = this._latchIntervention(sid, {
      ...meta,
      kind: meta.kind || 'tab',
      inputKind: meta.inputKind || 'tab',
      workbenchId: sid,
      currentTabId: meta.currentTabId || meta.userTabId || this._activeTabId(sid) || sid,
      userTabId: meta.userTabId || meta.currentTabId || this._activeTabId(sid) || sid
    })
    return {
      flagged: true,
      anchorTabId: normalized.anchorTabId,
      agentAnchorTabId: normalized.agentAnchorTabId,
      userTabId: normalized.userTabId,
      interventionId: normalized.interventionId,
      timestamp: normalized.timestamp,
      eventId: normalized.eventId || null
    }
  }

  // Clear the human-takeover latch once the user hands control back (clicks 继续).
  // Without this the very next agent action would re-block on the stale flag. For a
  // tab-strip takeover, also switch the agent back to its working tab (anchor).
  async acknowledgeIntervention(id, params = {}) {
    const sid = String(id || 'main').split('#')[0]
    const meta = this._interventions.get(sid)
    const restoreAnchor = params.restoreAnchor !== false
    let restored = false
    if (
      restoreAnchor &&
      meta &&
      meta.anchorTabId &&
      this.tabController &&
      typeof this.tabController.switchTab === 'function'
    ) {
      try {
        // await so _resolve_block's follow-up observe lands on the anchor, not the
        // user's tab. switchTab returns false if the anchor tab was closed.
        restored = Boolean(await Promise.resolve(this.tabController.switchTab(sid, meta.anchorTabId)))
      } catch (err) {
        this.log(`acknowledgeIntervention restore failed: ${err?.message || err}`)
      }
    }
    const restoreRequired = Boolean(restoreAnchor && meta?.anchorTabId)
    if (restoreRequired && !restored) {
      return { acknowledged: false, restored: false, tabClosed: true }
    }
    for (const entry of this.workbenches.values()) {
      if (this._sessionIdForEntry(entry) === sid) entry.interventionPending = false
    }
    this._interventions.delete(sid)
    if (meta?.interventionId) {
      this.log(
        `[browser-takeover:${meta.interventionId}] acknowledged ` +
        `session=${sid} restored=${restored} anchor=${meta.agentAnchorTabId || meta.anchorTabId || ''}`
      )
    }
    return {
      acknowledged: true,
      restored,
      tabClosed: false,
      interventionId: meta?.interventionId || null
    }
  }

  async startScreencast(id, params = {}) {
    return browserIO.startScreencast(this, id, params)
  }

  async stopScreencast(id, params = {}) {
    return browserIO.stopScreencast(this, id, params)
  }

  async storageState(id, params = {}) {
    return storageStateService.storageState(this, id, params)
  }

  async _currentOriginStorage(entry) {
    return storageStateService.currentOriginStorage(entry)
  }

  _extractFrameOrigins(frameTree, origins = new Set()) {
    return storageStateService.extractFrameOrigins(this, frameTree, origins)
  }

  async _domStorageEntries(entry, origin, isLocalStorage) {
    return storageStateService.domStorageEntries(entry, origin, isLocalStorage)
  }

  async _storageOriginsFromDomStorage(entry) {
    return storageStateService.storageOriginsFromDomStorage(this, entry)
  }

  async saveStorageState(id, params = {}) {
    return storageStateService.saveStorageState(this, id, params)
  }

  async loadStorageState(id, params = {}) {
    return storageStateService.loadStorageState(this, id, params)
  }

  async _applyStorageState(entry, state = {}) {
    return storageStateService.applyStorageState(this, entry, state)
  }

  _storageApplyScript(origins) {
    return storageStateService.storageApplyScript(origins)
  }

  async _applyCurrentOriginStorage(entry, origins) {
    return storageStateService.applyCurrentOriginStorage(this, entry, origins)
  }

  async _installStorageInitScript(entry, origins) {
    return storageStateService.installStorageInitScript(entry, origins)
  }

  _cookieDetailsForElectron(entry, cookie = {}) {
    return storageStateService.cookieDetailsForElectron(entry, cookie)
  }

  async search(id, params = {}) {
    const query = String(params.query || '').trim()
    if (!query) throw new Error('query is required')
    // Default to Baidu for China-first desktop installs. Baidu uses `wd=`, not `q=`.
    const engine = String(params.engine || 'baidu').trim().toLowerCase()
    const encoded = new URLSearchParams({ q: query }).toString()
    const urls = {
      duckduckgo: `https://duckduckgo.com/?${encoded}`,
      google: `https://www.google.com/search?${encoded}&udm=14`,
      bing: `https://www.bing.com/search?${encoded}`,
      baidu: `https://www.baidu.com/s?${new URLSearchParams({ wd: query }).toString()}`
    }
    const url = urls[engine]
    if (!url) throw new Error(`Unsupported search engine: ${engine}. Options: duckduckgo, google, bing, baidu`)
    const result = await this.navigate(id, url, { _fanDecisionToken: params._fanDecisionToken })
    return {
      searched: true,
      query,
      engine,
      url,
      ...result
    }
  }

  _coerceScrollPages(value) {
    const pages = Number(value)
    return Math.max(0.5, Math.min(10, Number.isFinite(pages) && pages > 0 ? pages : 1))
  }

  _scrollPageSteps(pages) {
    const normalized = this._coerceScrollPages(pages)
    if (normalized < 1) return [normalized]
    const fullPages = Math.trunc(normalized)
    const remaining = normalized - fullPages
    const steps = Array.from({ length: fullPages }, () => 1)
    if (remaining > 0.001) steps.push(remaining)
    return steps
  }

  async scroll(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const actionGuard = this._entryActionLease(entry, params, 'scroll')
    actionGuard()
    const down = params.down !== false
    const pages = this._coerceScrollPages(params.pages)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'scroll', index: params.index ?? null })
    try {
    // SCROLL-07:index==0/缺失 → 滚【整页】(不走元素容器路径)
    if (params.index != null && Number(params.index) !== 0) {
      const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'scroll')
      if (element.backendNodeId) {
        actionGuard()
        const value = await this._scrollBackendNodeElement(entry, element, { pages, down }, actionGuard)
        // SCROLL-03:iframe 内容滚动后等 200ms 让其重排稳定(对齐 BU asyncio.sleep(0.2));非 iframe 不等
        if (value && value.targetKind === 'iframe-content') await this._sleep(200)
        entry.selectorMap.clear('scroll')
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'scroll', result: value })
        return value
      }
      actionGuard()
      const result = await entry.client.send('Runtime.evaluate', {
        expression: `(async () => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          let target = el;
          let targetKind = 'element';
          if (/^(iframe|frame)$/i.test(el.tagName || '')) {
            try {
              const doc = el.contentDocument || el.contentWindow?.document;
              target = doc && (doc.documentElement || doc.body);
              targetKind = 'iframe-content';
            } catch (error) {
              return { ok: false, error: 'Could not access iframe content: ' + error.message };
            }
          }
          if (!target) return { ok: false, error: 'scroll target not found' };
          const steps = ${JSON.stringify(this._scrollPageSteps(pages))};
          const base = target.clientHeight || window.innerHeight;  // SCROLL-01:容器自身可视高度(对齐 BU clientHeight,去掉过度滚小容器的 innerHeight*0.8 下限)
          const __startTop = target.scrollTop || 0;  // SCROLL-09:记录起始位置以判 JS 是否真的滚动了
          let __done = 0;  // SCROLL-11:只累加真的滚动了的页
          for (let i = 0; i < steps.length; i += 1) {
            const __prev = target.scrollTop || 0;
            const amount = base * steps[i] * ${down ? 1 : -1};
            if (typeof target.scrollBy === 'function') target.scrollBy({ top: amount, left: 0, behavior: 'instant' });
            else target.scrollTop += amount;
            if ((target.scrollTop || 0) !== __prev) __done += steps[i];
            if (steps.length > 1 && i < steps.length - 1) await new Promise(resolve => setTimeout(resolve, 150));
          }
          return {
            ok: true,
            index: ${JSON.stringify(Number(element.index))},
            targetKind,
            completedPages: __done,  // SCROLL-11:实际移动的页数(替代全量 reduce;到底/不可滚时如实反映 0)
            steps,
            movedPx: (target.scrollTop || 0) - __startTop,
            scrollTop: target.scrollTop || 0,
            scrollLeft: target.scrollLeft || 0,
            scrollHeight: target.scrollHeight || 0,
            clientHeight: target.clientHeight || 0
          };
        })()`,
        returnByValue: true,
        awaitPromise: true
      }, element.sessionId)
      const value = result?.result?.value || {}
      if (!value.ok) {
        const message = value.error || 'failed to scroll element'
        if (this._elementFailureLooksStale(message)) {
          throw this._staleElementError(element.index, message, 'scroll')
        }
        throw new Error(message)
      }
      // SCROLL-09:JS scrollBy 对该容器无效(movedPx<1)→ 真实 mouseWheel 兜底;仅 element(非 iframe)
      if (value.targetKind === 'element' && Math.abs(Number(value.movedPx) || 0) < 1) {
        actionGuard()
        await this._mouseWheelElementFallback(entry, element, { pages, down })
      }
      // SCROLL-03:iframe 内容滚动后等 200ms 让其重排稳定(对齐 BU asyncio.sleep(0.2));非 iframe 不等
      if (value.targetKind === 'iframe-content') await this._sleep(200)
      entry.selectorMap.clear('scroll')
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'scroll', result: value })
      return value
    }
    const steps = this._scrollPageSteps(pages)
    const stepResults = []
    for (const step of steps) {
      try {
        try {
          actionGuard()
          const gesture = await this._synthesizePageScrollGesture(entry, { pages: step, down }, actionGuard)
          stepResults.push({ pages: step, method: 'cdp-gesture', pixels: gesture.pixels, ok: true })
        } catch (error) {
          if (this._isBrowserReplanError(error)) throw error
          actionGuard()
          const fallback = await this._javascriptPageScroll(entry, { pages: step, down })
          stepResults.push({ pages: step, method: 'javascript', gestureError: error.message, ...fallback, ok: true })
        }
      } catch (stepError) {
        // SCROLL-11:某步的 gesture 与 JS 兜底都失败时不抛出循环(对齐 BU service.py 的
        // logger.warning + 继续),该步标 ok:false、不计入 completedPages。
        stepResults.push({ pages: step, method: 'failed', ok: false, error: stepError.message })
      }
      if (steps.length > 1) await this._sleep(150)
    }
    const result = await this._readPageScrollPosition(entry)
    entry.selectorMap.clear('scroll')
    const methods = new Set(stepResults.map(step => step.method))
    const value = {
      ...(result?.result?.value || {}),
      method: methods.size === 1 ? stepResults[0]?.method || 'unknown' : 'mixed',
      completedPages: stepResults.reduce((total, step) => total + (step.ok === false ? 0 : Number(step.pages || 0)), 0),
      steps: stepResults,
      gestureError: stepResults.find(step => step.gestureError)?.gestureError
    }
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'scroll', result: value })
    return value
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'scroll', error: error.message })
      throw error
    }
  }

  async _readPageScrollPosition(entry) {
    return entry.client.send('Runtime.evaluate', {
      expression: `(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }))()`,
      returnByValue: true
    })
  }

  async _javascriptPageScroll(entry, { pages = 1, down = true } = {}) {
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const amount = window.innerHeight * ${JSON.stringify(Number(pages) || 1)} * ${down ? 1 : -1};
        window.scrollBy({ top: amount, left: 0, behavior: 'instant' });
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      })()`,
      returnByValue: true
    })
    return result?.result?.value || {}
  }

  async _synthesizePageScrollGesture(entry, { pages = 1, down = true } = {}, actionGuard = null) {
    const metrics = await entry.client.send('Page.getLayoutMetrics')
    // SCROLL-08:优先 CSS 像素视口(cssLayoutViewport),与 _get_page_info 及我方
    // _lastMousePoint 的取数口径一致;device-px 的 layout/visualViewport 仅作回落。
    const viewport = metrics?.cssLayoutViewport || metrics?.cssVisualViewport || metrics?.layoutViewport || metrics?.visualViewport || {}
    const width = Number(viewport.clientWidth || viewport.width || 0)
    const height = Number(viewport.clientHeight || viewport.height || 0)
    if (width <= 0 || height <= 0) throw new Error('layout viewport is unavailable for CDP scroll gesture')
    const pixels = height * (Number(pages) || 1)
    if (typeof actionGuard === 'function') actionGuard()
    await entry.client.send('Input.synthesizeScrollGesture', {
      x: width / 2,
      y: height / 2,
      xDistance: 0,
      yDistance: down !== false ? -pixels : pixels,
      speed: 50000
    })
    return { ok: true, pixels }
  }

  async _scrollBackendNodeElement(entry, element = {}, { pages = 1, down = true } = {}, actionGuard = null) {
    const backendNodeId = Number(element.backendNodeId)
    if (!Number.isFinite(backendNodeId)) throw new Error('backendNodeId is required for backend-node scroll')
    const result = await this._usingResolvedBackendNode(entry, backendNodeId, element.sessionId, objectId => {
      if (typeof actionGuard === 'function') actionGuard()
      return entry.client.send('Runtime.callFunctionOn', {
        objectId,
        awaitPromise: true,
        returnByValue: true,
        arguments: [
          { value: Number(pages) || 1 },
          { value: down !== false }
        ],
        functionDeclaration: `async function(pages, down) {
        let target = this;
        let targetKind = 'element';
        if (/^(iframe|frame)$/i.test(this.tagName || '')) {
          try {
            const doc = this.contentDocument || this.contentWindow?.document;
            target = doc && (doc.documentElement || doc.body);
            targetKind = 'iframe-content';
          } catch (error) {
            return { ok: false, error: 'Could not access iframe content: ' + error.message };
          }
        }
        if (!target) return { ok: false, error: 'scroll target not found' };
        const normalizedPages = Math.max(0.5, Math.min(10, Number(pages || 1)));
        const fullPages = normalizedPages >= 1 ? Math.trunc(normalizedPages) : 0;
        const remaining = normalizedPages - fullPages;
        const steps = normalizedPages < 1 ? [normalizedPages] : Array.from({ length: fullPages }, () => 1);
        if (remaining > 0.001) steps.push(remaining);
        const base = target.clientHeight || window.innerHeight;  // SCROLL-01:容器自身可视高度(对齐 BU clientHeight,去掉过度滚小容器的 innerHeight*0.8 下限)
        const __startTop = target.scrollTop || 0;  // SCROLL-09:判 JS 是否真的滚动了
        let __done = 0;  // SCROLL-11:只累加真的滚动了的页
        for (let i = 0; i < steps.length; i += 1) {
          const __prev = target.scrollTop || 0;
          const amount = base * steps[i] * (down ? 1 : -1);
          if (typeof target.scrollBy === 'function') target.scrollBy({ top: amount, left: 0, behavior: 'instant' });
          else target.scrollTop += amount;
          if ((target.scrollTop || 0) !== __prev) __done += steps[i];
          if (steps.length > 1 && i < steps.length - 1) await new Promise(resolve => setTimeout(resolve, 150));
        }
        return {
          ok: true,
          targetKind,
          completedPages: __done,  // SCROLL-11:实际移动的页数(替代全量 reduce)
          steps,
          movedPx: (target.scrollTop || 0) - __startTop,
          scrollTop: target.scrollTop || 0,
          scrollLeft: target.scrollLeft || 0,
          scrollHeight: target.scrollHeight || 0,
          clientHeight: target.clientHeight || 0
        };
        }`
      }, element.sessionId)
    })
    if (!result) {
      throw this._staleElementError(
        element.index,
        'failed to resolve backend node for scroll',
        'scroll'
      )
    }
    const value = result?.result?.value || {}
    if (!value.ok) {
      const message = value.error || 'failed to scroll backend-node element'
      if (this._elementFailureLooksStale(message)) {
        throw this._staleElementError(element.index, message, 'scroll')
      }
      throw new Error(message)
    }
    // SCROLL-09:JS scrollBy 对该容器无效(movedPx<1)→ 真实 mouseWheel 兜底;仅 element(非 iframe)
    if (value.targetKind === 'element' && Math.abs(Number(value.movedPx) || 0) < 1) {
      await this._mouseWheelElementFallback(entry, element, { pages, down })
    }
    return { ...value, index: element.index, backendNodeId }
  }

  async _scrollToTextInSession(entry, { text, caseSensitive = false, exact = false, sessionId = undefined } = {}) {
    const result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const needleRaw = ${JSON.stringify(text)};
          const caseSensitive = ${caseSensitive ? 'true' : 'false'};
          const exact = ${exact ? 'true' : 'false'};
          const needle = caseSensitive ? needleRaw : needleRaw.toLowerCase();
          const visitedDocuments = new Set();
          let visitedFrameCount = 0;
          let inaccessibleFrameCount = 0;
          function normalize(value) {
            const compact = String(value || '').replace(/\\s+/g, ' ').trim();
            return caseSensitive ? compact : compact.toLowerCase();
          }
          function isVisible(el) {
            if (!el || !el.ownerDocument || !el.ownerDocument.defaultView) return false;
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (tag === 'script' || tag === 'style' || tag === 'noscript') return false;
            const style = el.ownerDocument.defaultView.getComputedStyle(el);
            // SCROLL-05/10:只排 display:none(真隐藏)。opacity:0 / visibility:hidden / 零尺寸 多是
            // scroll-reveal(滚入视口才淡入)或滚动驱动展开的待揭示真目标——BU 命中后 scrollIntoViewIfNeeded
            // 滚过去会触发显现。不能在匹配阶段就因不可见丢弃,否则整体报 'text not found' 比 BU 弱;
            // 是否真可见交给滚动后的结果,而非匹配前的硬启发式。
            return !!style && style.display !== 'none';
          }

          function matches(value) {
            const haystack = normalize(value);
            return exact ? haystack === needle : haystack.includes(needle);
          }

          function ownerSummary(owner) {
            return {
              tag: String(owner?.tagName || '').toLowerCase(),
              id: String(owner?.id || ''),
              name: String(owner?.getAttribute?.('name') || ''),
              title: String(owner?.getAttribute?.('title') || '')
            };
          }

          function scrollOwnerChain(ownerChain) {
            let scrolled = 0;
            // The target first scrolls inside its own document. Then reveal
            // each containing frame from the deepest owner back to the page.
            for (let index = ownerChain.length - 1; index >= 0; index -= 1) {
              try {
                ownerChain[index].scrollIntoView({
                  block: 'center',
                  inline: 'nearest',
                  behavior: 'instant'
                });
                scrolled += 1;
              } catch {}
            }
            return scrolled;
          }

          function matchedResult(el, value, ownerChain, matchedBy = 'text', attribute = '') {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            const frameOwnerScrollCount = scrollOwnerChain(ownerChain);
            const rect = el.getBoundingClientRect();
            const view = el.ownerDocument?.defaultView;
            return {
              ok: true,
              text: String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
              tag: String(el.tagName || '').toLowerCase(),
              matchedBy,
              ...(attribute ? { attribute } : {}),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
              scrollX: Number(view?.scrollX || 0),
              scrollY: Number(view?.scrollY || 0),
              frameDepth: ownerChain.length,
              frameOwnerScrollCount,
              framePath: ownerChain.map(ownerSummary)
            };
          }

          function searchDocument(doc, ownerChain = []) {
            if (!doc || visitedDocuments.has(doc)) return null;
            visitedDocuments.add(doc);
            const root = doc.body || doc.documentElement;
            if (!root) return null;

            const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT || 4;
            const walker = doc.createTreeWalker(root, showText);
            let node = null;
            while ((node = walker.nextNode())) {
              const parent = node.parentElement;
              if (!isVisible(parent) || !matches(node.textContent)) continue;
              return matchedResult(parent, node.textContent, ownerChain);
            }

            // SCROLL-04:文本节点没命中→补一趟属性扫描兜底(对齐 BU //*[@*[contains(., text)]]):
            // 文本可能藏在 aria-label/title/placeholder/value/alt/name 等属性里。
            for (const el of doc.querySelectorAll('*')) {
              if (!el.attributes || !el.attributes.length || !isVisible(el)) continue;
              for (const attr of el.attributes) {
                if (!normalize(attr.value) || !matches(attr.value)) continue;
                return matchedResult(el, attr.value, ownerChain, 'attribute', attr.name);
              }
            }

            // Same-origin frames are flattened into the numbered observation,
            // but they are not separate Target sessions. Walk their reachable
            // contentDocument trees here so text search matches what the
            // serialized snapshot actually showed.
            for (const frame of doc.querySelectorAll('iframe, frame')) {
              let childDocument = null;
              try {
                childDocument = frame.contentDocument || frame.contentWindow?.document || null;
              } catch {
                inaccessibleFrameCount += 1;
                continue;
              }
              if (!childDocument) {
                inaccessibleFrameCount += 1;
                continue;
              }
              visitedFrameCount += 1;
              const nested = searchDocument(childDocument, [...ownerChain, frame]);
              if (nested) return nested;
            }
            return null;
          }

          const matched = searchDocument(document);
          if (matched) {
            return {
              ...matched,
              visitedFrameCount,
              inaccessibleFrameCount
            };
          }
          return {
            ok: false,
            error: 'text not found in reachable documents',
            scope: 'reachable-documents',
            visitedFrameCount,
            inaccessibleFrameCount
          };
        })()`,
        returnByValue: true
      }, sessionId)
    return result?.result?.value || {}
  }

  async _scrollFrameOwnerIntoView(entry, frame = {}) {
    const backendNodeId = frame.frameOwnerBackendNodeId || frame.backendNodeId
    if (backendNodeId == null) return false
    const parentSessionId = frame.parentSessionId || undefined
    try {
      await entry.client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, parentSessionId)
      return true
    } catch {
      return false
    }
  }

  _frameOwnerChain(frame = {}, frameMetadata = null) {
    if (!frame) return []
    const byFrameId = frameMetadata?.byFrameId || {}
    const chain = []
    const seen = new Set()
    let current = frame
    while (current && !seen.has(current.frameId || current.id || '')) {
      const key = current.frameId || current.id || ''
      if (key) seen.add(key)
      if (current.frameOwnerBackendNodeId != null || current.backendNodeId != null || current.frameOwnerUnavailable) chain.push(current)
      const parentFrameId = current.parentFrameId || ''
      current = parentFrameId ? byFrameId[parentFrameId] : null
    }
    return chain.reverse()
  }

  async _scrollFrameOwnerChainIntoView(entry, frame = {}, frameMetadata = null) {
    const chain = this._frameOwnerChain(frame, frameMetadata)
    const frames = chain.length ? chain : [frame].filter(Boolean)
    const results = []
    for (const item of frames) {
      const backendNodeId = item.frameOwnerBackendNodeId || item.backendNodeId || null
      const scrolled = await this._scrollFrameOwnerIntoView(entry, item)
      results.push({
        frameId: item.frameId || item.id || '',
        parentFrameId: item.parentFrameId || '',
        backendNodeId,
        parentSessionId: item.parentSessionId || '',
        scrolled
      })
    }
    return {
      scrolled: results.some(result => result.scrolled),
      count: results.filter(result => result.scrolled).length,
      frames: results
    }
  }

  async scrollToText(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'scrollToText')
    const text = String(params.text || params.query || '').trim()
    if (!text) throw new Error('text is required')
    const caseSensitive = Boolean(params.caseSensitive || params.case_sensitive)
    const exact = Boolean(params.exact)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'scrollToText', text })
    try {
      const attempts = []
      const mainValue = await this._scrollToTextInSession(entry, { text, caseSensitive, exact })
      attempts.push({ source: 'main', ok: Boolean(mainValue.ok) })
      if (mainValue.ok) {
        const value = { ...mainValue, source: 'main' }
        entry.selectorMap.clear('scrollToText')
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'scrollToText', result: value })
        return value
      }

      const attachedTargets =
        typeof entry.targetManager?.attachedTargets === 'function' ? entry.targetManager.attachedTargets() : []
      let frameMetadata = null
      if (attachedTargets.length) {
        try {
          frameMetadata = await this._collectFrameMetadata(entry)
        } catch {
          frameMetadata = null
        }
      }

      for (const item of attachedTargets) {
        const sessionId = item.sessionId
        if (!sessionId) continue
        await entry.client.send('Runtime.enable', {}, sessionId).catch(() => undefined)
        await entry.client.send('DOM.enable', {}, sessionId).catch(() => undefined)
        const targetValue = await this._scrollToTextInSession(entry, { text, caseSensitive, exact, sessionId }).catch(error => ({
          ok: false,
          error: error.message
        }))
        attempts.push({ source: 'target-session', sessionId, targetId: item.targetId || '', ok: Boolean(targetValue.ok) })
        if (!targetValue.ok) continue
        const frame = this._frameForTarget(item, frameMetadata)
        const ownerScroll = frame
          ? await this._scrollFrameOwnerChainIntoView(entry, frame, frameMetadata)
          : { scrolled: false, count: 0, frames: [] }
        const value = {
          ...targetValue,
          source: 'target-session',
          sessionId,
          targetId: item.targetId || '',
          targetType: item.target?.type || '',
          targetUrl: item.target?.url || '',
          frameId: frame?.frameId || frame?.id || '',
          parentFrameId: frame?.parentFrameId || '',
          frameOwnerBackendNodeId: frame?.frameOwnerBackendNodeId || frame?.backendNodeId || null,
          frameOwnerUnavailable: Boolean(frame?.frameOwnerUnavailable),
          frameOwnerScrolled: ownerScroll.scrolled,
          frameOwnerScrollCount: ownerScroll.count,
          frameOwnerScrollChain: ownerScroll.frames
        }
        entry.selectorMap.clear('scrollToText')
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'scrollToText', result: value })
        return value
      }

      const error = new Error('text not found')
      error.attempts = attempts
      throw error
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
        id: entry.id,
        action: 'scrollToText',
        error: error.message,
        attempts: error.attempts || null
      })
      throw error
    }
  }

  _dropdownInspectorSource() {
    return `
      function fanDropdownText(el) {
        return String((el && (el.innerText || el.textContent || el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')))) || '')
          .replace(/\\s+/g, ' ')
          .trim();
      }
      function fanDropdownDisabled(el) {
        return Boolean(el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') != null));
      }
      function fanDropdownSelected(el) {
        if (!el) return false;
        if (el.selected) return true;
        if (!el.getAttribute) return false;
        if (el.getAttribute('aria-selected') === 'true') return true;
        if (el.getAttribute('aria-checked') === 'true') return true;
        if (el.classList && (el.classList.contains('selected') || el.classList.contains('active'))) return true;
        return false;
      }
      function fanDropdownOption(el, index) {
        const text = fanDropdownText(el);
        const value = el && el.getAttribute ? (el.getAttribute('value') || el.getAttribute('data-value') || el.getAttribute('data-id') || text) : text;
        if (!text && !value) return null;
        return {
          index,
          text,
          value: String(value || ''),
          disabled: fanDropdownDisabled(el),
          selected: fanDropdownSelected(el),
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          role: el.getAttribute ? String(el.getAttribute('role') || '') : ''
        };
      }
      function fanDropdownUnique(nodes) {
        const out = [];
        const seen = new Set();
        for (const node of nodes) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
          const option = fanDropdownOption(node, out.length);
          if (!option) continue;
          const key = (option.text + '|' + option.value).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(option);
          if (out.length >= 200) break;
        }
        return out;
      }
      function fanDropdownOpen(startElement) {
        if (!startElement) return false;
        try { startElement.focus(); } catch {}
        try { startElement.dispatchEvent(new FocusEvent('focus', { bubbles: true, cancelable: true })); } catch {}
        try { startElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: true })); } catch {}
        try { startElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); } catch {}
        try { startElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })); } catch {}
        try { startElement.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch {}
        try { startElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })); } catch {}
        return true;
      }
      function fanDropdownClose(startElement) {
        if (!startElement) return false;
        try { startElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
        try { startElement.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } catch {}
        try { startElement.blur(); } catch {}
        return true;
      }
      function fanDropdownHasOnlyEmptyOptions(options) {
        return Array.isArray(options) && options.length > 0 && options.every(option => {
          return !String(option && option.text || '').trim() && !String(option && option.value || '').trim();
        });
      }
      function fanDelay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }
      function fanDropdownContainers(startElement) {
        const containers = [];
        const doc = startElement.ownerDocument || document;
        const ids = [
          startElement.getAttribute && startElement.getAttribute('aria-controls'),
          startElement.getAttribute && startElement.getAttribute('aria-owns')
        ].filter(Boolean).join(' ').split(/\\s+/).filter(Boolean);
        for (const id of ids) {
          const controlled = doc.getElementById(id);
          if (controlled) containers.push(controlled);
        }
        containers.push(startElement);
        return containers;
      }
      function fanDropdownCandidateNodes(startElement) {
        const containers = fanDropdownContainers(startElement);
        const selectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[data-value]',
          '[data-id]',
          '.item',
          'li',
          'option',
          'button',
          'a'
        ].join(',');
        const nodes = [];
        for (const container of containers) {
          if (!container) continue;
          if (container.matches && container.matches(selectors)) nodes.push(container);
          nodes.push(...Array.from(container.querySelectorAll ? container.querySelectorAll(selectors) : []));
        }
        return nodes;
      }
      function fanInspectDropdown(startElement) {
        if (!startElement || !startElement.tagName || !startElement.isConnected) return { ok: false, error: 'element not found' };
        const tag = startElement.tagName.toLowerCase();
        const role = String(startElement.getAttribute('role') || '').toLowerCase();
        if (tag === 'select') {
          const options = Array.from(startElement.options || []).map((option, index) => ({
            index,
            text: String(option.text || '').trim(),
            value: String(option.value || ''),
            disabled: Boolean(option.disabled || (option.parentElement && option.parentElement.tagName.toLowerCase() === 'optgroup' && option.parentElement.disabled)),
            selected: Boolean(option.selected),
            tag: 'option',
            role: 'option'
          }));
          const selected = options.find(option => option.selected) || null;
          return {
            ok: true,
            type: 'select',
            source: 'native-select',
            optionCount: options.length,
            current: selected ? { index: selected.index, text: selected.text, value: selected.value } : null,
            options
          };
        }
        const containers = fanDropdownContainers(startElement);
        const nodes = fanDropdownCandidateNodes(startElement);
        const options = fanDropdownUnique(nodes).filter(option => option.text || option.value);
        const type = role === 'combobox' ? 'aria-combobox' : role === 'listbox' ? 'aria-listbox' : role === 'menu' ? 'aria-menu' : 'custom-dropdown';
        return options.length
          ? { ok: true, type, source: containers.length > 1 ? 'aria-controlled' : 'descendants', options }
          : { ok: false, error: 'dropdown options not found', type, source: 'none', options: [] };
      }
      function fanDropdownInitialDelay(startElement) {
        const role = String(startElement && startElement.getAttribute && startElement.getAttribute('role') || '').toLowerCase();
        const aria = startElement && startElement.getAttribute && (startElement.getAttribute('aria-controls') || startElement.getAttribute('aria-owns'));
        return (role === 'combobox' || aria) ? 500 : 180;
      }
      async function fanInspectDropdownAfterOpen(startElement, delayMs) {
        if (startElement && startElement.tagName && startElement.tagName.toLowerCase() === 'select') {
          return fanInspectDropdown(startElement);
        }
        fanDropdownOpen(startElement);
        await fanDelay(delayMs == null ? fanDropdownInitialDelay(startElement) : delayMs);
        let result = fanInspectDropdown(startElement);
        if (!result.ok || fanDropdownHasOnlyEmptyOptions(result.options)) {
          await fanDelay(650);
          result = fanInspectDropdown(startElement);
          if (result && typeof result === 'object') result.retried = true;
        }
        fanDropdownClose(startElement);
        return result;
      }
    `
  }

  async dropdownOptions(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'dropdownOptions')
    const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'dropdownOptions')
    try {
      const value = await this._dropdownOptionsForElement(entry, element)
      return { index: element.index, backendNodeId: element.backendNodeId || null, ...value }
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'dropdownOptions', index: element.index, error: error.message })
      throw error
    }
  }

  _dropdownActionError(value, fallbackMessage, action = 'select') {
    const detail = value && typeof value === 'object' ? value : {}
    const message = String(detail.error || fallbackMessage)
    const normalized = message.toLowerCase()
    let code = 'DROPDOWN_ACTION_FAILED'
    if (normalized.includes('option not found')) code = 'DROPDOWN_OPTION_NOT_FOUND'
    else if (normalized.includes('options not found')) code = 'DROPDOWN_OPTIONS_NOT_FOUND'
    else if (normalized.includes('option is disabled')) code = 'DROPDOWN_OPTION_DISABLED'
    else if (normalized.includes('selection reverted')) code = 'DROPDOWN_SELECTION_REVERTED'
    else if (normalized.includes('element not found')) code = 'STALE_ELEMENT_REFERENCE'

    const error = new Error(message)
    error.code = code
    error.details = {}
    if (code === 'STALE_ELEMENT_REFERENCE') {
      error.details.retryable = true
      error.details.replanRequired = true
      error.details.action = String(action || 'select')
    }
    if (Array.isArray(detail.options)) error.details.options = detail.options
    for (const key of ['retryable', 'retried']) {
      if (typeof detail[key] === 'boolean') error.details[key] = detail[key]
    }
    for (const key of ['value', 'expectedValue', 'text', 'type', 'source']) {
      if (detail[key] != null) error.details[key] = detail[key]
    }
    return error
  }

  async _dropdownOptionsForElement(entry, element) {
    const sessionId = element.sessionId
    if (element.backendNodeId) {
      const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `async function() { ${this._dropdownInspectorSource()} return await fanInspectDropdownAfterOpen(this); }`,
            awaitPromise: true,
            returnByValue: true
          },
          sessionId
        )
      ))
      if (!result) {
        throw this._staleElementError(
          element.index,
          `Dropdown element for index ${element.index} is not available`,
          'dropdownOptions'
        )
      }
      const value = result?.result?.value || {}
      if (!value.ok) throw this._dropdownActionError(value, 'dropdown options not found', 'dropdownOptions')
      return value
    }
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(async () => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        ${this._dropdownInspectorSource()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
        return await fanInspectDropdownAfterOpen(el);
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, sessionId)
    const value = result?.result?.value || {}
    if (!value.ok) throw this._dropdownActionError(value, 'dropdown options not found', 'dropdownOptions')
    return value
  }

  _looksLikeDropdown(element = {}) {
    const attributes = element.attributes || {}
    const role = String(element.role || attributes.role || '').toLowerCase()
    const haystack = haystackForElement(element).toLowerCase()
    return Boolean(
      element.capabilities?.selectable ||
        element.tag === 'select' ||
        ['combobox', 'listbox', 'menu', 'menuitem', 'option'].includes(role) ||
        attributes['aria-haspopup'] != null ||
        attributes['aria-controls'] != null ||
        attributes['aria-owns'] != null ||
        /\b(dropdown|select|combobox|listbox|menu)\b/.test(haystack)
    )
  }

  _customDropdownSelectSource() {
    return `
      ${this._dropdownInspectorSource()}
      function fanSelectDropdownOption(startElement, targetText) {
        if (!startElement || !startElement.tagName || !startElement.isConnected) return { ok: false, error: 'element not found' };
        const target = String(targetText || '').trim();
        const targetLower = target.toLowerCase();
        if (!target) return { ok: false, error: 'option text is required' };
        fanDropdownOpen(startElement);
        const nodes = fanDropdownCandidateNodes(startElement);
        const candidate = nodes.find(node => {
          const text = fanDropdownText(node);
          const value = node.getAttribute && (node.getAttribute('value') || node.getAttribute('data-value') || node.getAttribute('data-id') || '');
          return text === target || String(value || '') === target || text.toLowerCase() === targetLower || String(value || '').toLowerCase() === targetLower;
        });
        if (!candidate) {
          const inspected = fanInspectDropdown(startElement);
          return { ok: false, error: 'option not found', options: inspected.options || [], retryable: fanDropdownHasOnlyEmptyOptions(inspected.options) };
        }
        if (fanDropdownDisabled(candidate)) return { ok: false, error: 'option is disabled', text: fanDropdownText(candidate) };
        const startRole = String(startElement.getAttribute && startElement.getAttribute('role') || '').toLowerCase();
        const candidateRole = String(candidate.getAttribute && candidate.getAttribute('role') || '').toLowerCase();
        const semanticLike = Boolean(startElement.classList && (startElement.classList.contains('dropdown') || startElement.classList.contains('ui')));
        const ariaLike = ['menu', 'listbox', 'combobox'].includes(startRole) || ['menuitem', 'option'].includes(candidateRole);
        if (ariaLike || semanticLike) {
          for (const node of nodes) {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
            if (ariaLike && node.setAttribute) node.setAttribute('aria-selected', 'false');
            if (node.classList) node.classList.remove('selected', 'active');
          }
        }
        if (ariaLike && candidate.setAttribute) {
          candidate.setAttribute('aria-selected', 'true');
          if (candidate.classList) candidate.classList.add('selected');
        }
        if (semanticLike) {
          if (candidate.classList) candidate.classList.add('selected', 'active');
          const textElement = startElement.querySelector && (startElement.querySelector('.text:not(.default)') || startElement.querySelector('.text'));
          if (textElement) textElement.textContent = fanDropdownText(candidate);
        }
        try { candidate.scrollIntoView && candidate.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch {}
        try {
          candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        } catch {}
        candidate.click();
        startElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        startElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        fanDropdownClose(startElement);
        const text = fanDropdownText(candidate);
        const value = candidate.getAttribute && (candidate.getAttribute('value') || candidate.getAttribute('data-value') || candidate.getAttribute('data-id') || text);
        return { ok: true, value: String(value || ''), text, type: 'custom-dropdown', ariaUpdated: ariaLike, semanticUpdated: semanticLike };
      }
      async function fanSelectDropdownOptionWithRetry(startElement, targetText) {
        let result = fanSelectDropdownOption(startElement, targetText);
        if (!result.ok && result.retryable) {
          fanDropdownOpen(startElement);
          await fanDelay(900);
          result = fanSelectDropdownOption(startElement, targetText);
          if (result && typeof result === 'object') result.retried = true;
        }
        if (!result.ok) fanDropdownClose(startElement);
        return result;
      }
    `
  }

  async select(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const actionGuard = this._entryActionLease(entry, params, 'select')
    actionGuard()
    const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'select')
    const sessionId = element.sessionId
    const text = String(params.text ?? '').trim()
    if (!text) throw new Error('text is required')
    const complete = output => {
      const result = params._fanProtectedInput === true
        ? {
            selected: output?.selected ?? element.index,
            ...(output?.backendNodeId != null ? { backendNodeId: output.backendNodeId } : {}),
            ...(output?.type ? { type: output.type } : {})
          }
        : output
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'select', result })
      return result
    }
    const nativeSelect = Boolean(element.capabilities?.selectable || element.tag === 'select')
    if (!nativeSelect && !this._looksLikeDropdown(element)) {
      throw new Error(`Element index ${element.index} is not a dropdown/select element`)
    }
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'select', index: element.index })
    try {
    if (element.backendNodeId) {
      actionGuard()
      const output = nativeSelect
        ? await this._selectByBackendNode(entry, element, text, actionGuard)
        : await this._selectCustomDropdownByBackendNode(entry, element, text, actionGuard)
      if (!params.preserveSelectorMap) entry.selectorMap.clear('select')
      return complete(output)
    }
    if (!nativeSelect) {
      actionGuard()
      const output = await this._selectCustomDropdownBySelector(entry, element, text)
      if (!params.preserveSelectorMap) entry.selectorMap.clear('select')
      return complete(output)
    }
    actionGuard()
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
          if (!el || !el.isConnected || el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'select element not found' };
        const target = ${JSON.stringify(text)};
        const targetLower = target.toLowerCase();
        const options = Array.from(el.options || []);
        const option = options.find(opt => {
          const label = opt.text.trim();
          const value = String(opt.value || '');
          return label === target || value === target || label.toLowerCase() === targetLower || value.toLowerCase() === targetLower;
        });
        if (!option) return { ok: false, error: 'option not found', options: options.map(opt => opt.text.trim()).filter(Boolean) };
        if (option.disabled || (option.parentElement && option.parentElement.tagName.toLowerCase() === 'optgroup' && option.parentElement.disabled)) {
          return { ok: false, error: 'option is disabled', text: option.text.trim(), options: options.map(opt => opt.text.trim()).filter(Boolean) };
        }
        el.value = option.value;
        option.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value, text: option.text.trim() };
      })()`,
      returnByValue: true
    }, sessionId)
    const value = result?.result?.value
    if (!value?.ok) throw this._dropdownActionError(value, 'failed to select option')
    if (!params.preserveSelectorMap) entry.selectorMap.clear('select')
    const output = { selected: element.index, value: value.value, text: value.text }
    return complete(output)
    } catch (error) {
      if (
        params._fanProtectedInput === true &&
        error?.details &&
        typeof error.details === 'object'
      ) {
        for (const key of ['value', 'expectedValue', 'text', 'options']) {
          delete error.details[key]
        }
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'select', error: error.message })
      throw error
    }
  }

  async _selectByBackendNode(entry, element, text, actionGuard = null) {
    const sessionId = element.sessionId
    const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => {
      if (typeof actionGuard === 'function') actionGuard()
      return entry.client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function(targetText) {
          if (!this || !this.isConnected || this.tagName.toLowerCase() !== 'select') return { ok: false, error: 'select element not found' };
          const target = String(targetText || '');
          const targetLower = target.toLowerCase();
          const options = Array.from(this.options || []);
          const option = options.find(opt => {
            const label = String(opt.text || '').trim();
            const value = String(opt.value || '');
            return label === target || value === target || label.toLowerCase() === targetLower || value.toLowerCase() === targetLower;
          });
          if (!option) return { ok: false, error: 'option not found', options: options.map(opt => String(opt.text || '').trim()).filter(Boolean) };
          if (option.disabled || (option.parentElement && option.parentElement.tagName.toLowerCase() === 'optgroup' && option.parentElement.disabled)) {
            return { ok: false, error: 'option is disabled', text: String(option.text || '').trim(), options: options.map(opt => String(opt.text || '').trim()).filter(Boolean) };
          }
          this.focus();
          try { this.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); } catch {}
          this.value = option.value;
          option.selected = true;
          this.selectedIndex = option.index;
          try { option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); } catch {}
          this.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          try { this.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window })); } catch {}
          this.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          if (this.value !== option.value && this.selectedIndex !== option.index) {
            this.selectedIndex = option.index;
            option.selected = true;
            try { option.click(); } catch {}
            this.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          }
          if (this.value !== option.value && this.selectedIndex !== option.index) {
            return { ok: false, error: 'selection reverted by page framework', value: this.value, expectedValue: option.value };
          }
          return { ok: true, value: this.value, text: String(option.text || '').trim() };
          }`,
          arguments: [{ value: text }],
          returnByValue: true
        },
        sessionId
      )
    })
    if (!result) {
      throw this._staleElementError(
        element.index,
        `Select element for index ${element.index} is not available`,
        'select'
      )
    }
    const value = result?.result?.value || {}
    if (!value.ok) throw this._dropdownActionError(value, 'failed to select option')
    return { selected: element.index, backendNodeId: element.backendNodeId, value: value.value, text: value.text }
  }

  async _selectCustomDropdownByBackendNode(entry, element, text, actionGuard = null) {
    const sessionId = element.sessionId
    const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => {
      if (typeof actionGuard === 'function') actionGuard()
      return entry.client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `async function(targetText) { ${this._customDropdownSelectSource()} return await fanSelectDropdownOptionWithRetry(this, targetText); }`,
          arguments: [{ value: text }],
          awaitPromise: true,
          returnByValue: true
        },
        sessionId
      )
    })
    if (!result) {
      throw this._staleElementError(
        element.index,
        `Dropdown element for index ${element.index} is not available`,
        'select'
      )
    }
    const value = result?.result?.value || {}
    if (!value.ok) throw this._dropdownActionError(value, 'failed to select dropdown option')
    return { selected: element.index, backendNodeId: element.backendNodeId, value: value.value, text: value.text, type: value.type }
  }

  async _selectCustomDropdownBySelector(entry, element, text) {
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(async () => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        ${this._customDropdownSelectSource()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
        return await fanSelectDropdownOptionWithRetry(el, ${JSON.stringify(text)});
      })()`,
      awaitPromise: true,
      returnByValue: true
    }, element.sessionId)
    const value = result?.result?.value || {}
    if (!value.ok) throw this._dropdownActionError(value, 'failed to select dropdown option')
    return { selected: element.index, value: value.value, text: value.text, type: value.type }
  }

  async _liveActionPoint(entry, element, action = 'action') {
    const geometry = await this._resolveClickGeometry(entry, element, element.sessionId)
    if (!geometry?.rect) {
      throw this._staleElementError(
        element.index,
        `Element index ${element.index} has no live geometry for ${action}. ` +
        'Observe again and use a fresh visible element index.',
        action
      )
    }
    if (geometry.occluded) {
      throw new Error(
        `Element index ${element.index} is currently occluded${geometry.hitTag ? ` by <${geometry.hitTag}>` : ''}; ` +
        `refusing to ${action} a different element.`
      )
    }
    return { x: geometry.x, y: geometry.y, rect: geometry.rect, source: geometry.source || '' }
  }

  async mouse(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    if (params._fanDecisionToken) {
      this._assertDecisionToken(this._sessionIdForEntry(entry), params, 'mouse')
    }
    const decisionGuard = this._entryActionLease(entry, params, 'mouse')
    const operation = String(params.operation || params.action || 'click').trim()
    const sessionId = params.sessionId || params.session_id
    const button = params.button || 'left'
    const clickCount = Math.max(1, Math.min(3, Number(params.clickCount || params.click_count) || 1))
    let x = Number(params.x)
    let y = Number(params.y)
    const scrollOperation = operation === 'wheel' || operation === 'scroll'
    if (!scrollOperation && (!Number.isFinite(x) || !Number.isFinite(y))) throw new Error('x and y are required')
    // CLK-4:模型给的坐标是 0-1000 归一化 → 换算成 CSS-px。只在工具层打了 normalized 标志时换;
    // 内部 CSS-px 调用(SCROLL-09 直接调 _mouseScroll、drag()→mouse() 都不带标志)不受影响。
    // scroll 的 deltaX/deltaY 是滚动量不是坐标,不换算。
    const __normCoord = this._isNormalizedCoordinate(params)
    if (__normCoord && !scrollOperation && operation !== 'move') {
      this._assertVisualEvidence(entry, params)
    }
    if (__normCoord && Number.isFinite(x) && Number.isFinite(y)) {
      const css = await this._normalizedToCssPx(entry, x, y, sessionId || undefined)
      x = css.x; y = css.y
    }
    if (decisionGuard) decisionGuard()
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: `mouse.${operation}`, x, y })
    try {
      if (operation === 'move') {
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
      } else if (operation === 'down') {
        await this._markActingOn(entry.client, sessionId)
        if (decisionGuard) decisionGuard()
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, sessionId)
      } else if (operation === 'up') {
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, sessionId)
      } else if (scrollOperation) {
        // 滚动落点 x/y 已按归一化换算(若有);delta 不动
        const result = await this._mouseScroll(entry, (__normCoord && Number.isFinite(x)) ? { ...params, x, y } : params, sessionId)
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: `mouse.${operation}`, result })
        return { operation, ...result }
      } else if (operation === 'drag') {
        let toX = Number(params.toX ?? params.to_x)
        let toY = Number(params.toY ?? params.to_y)
        if (!Number.isFinite(toX) || !Number.isFinite(toY)) throw new Error('toX and toY are required for drag')
        if (__normCoord) {
          const css = await this._normalizedToCssPx(entry, toX, toY, sessionId || undefined)
          toX = css.x; toY = css.y
        }
        if (decisionGuard) decisionGuard()
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
        await this._markActingOn(entry.client, sessionId)
        if (decisionGuard) decisionGuard()
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, sessionId)
        const steps = Math.max(1, Math.min(50, Number(params.steps) || 8))
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps
          await entry.client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: x + (toX - x) * t,
            y: y + (toY - y) * t,
            button
          }, sessionId)
        }
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button, clickCount: 1 }, sessionId)
      } else {
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
        await this._markActingOn(entry.client, sessionId)
        if (decisionGuard) decisionGuard()
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount }, sessionId)
        await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount }, sessionId)
      }
      const result = { operation, x, y }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: `mouse.${operation}`, result })
      return result
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: `mouse.${operation}`, error: error.message })
      throw error
    }
  }

  async _mouseScroll(entry, params = {}, sessionId) {
    const deltaX = Number(params.deltaX ?? params.delta_x ?? 0)
    const deltaY = Number(params.deltaY ?? params.delta_y ?? 0)
    const rawX = Number(params.x)
    const rawY = Number(params.y)
    const layout = await entry.client.send('Page.getLayoutMetrics', {}, sessionId).catch(() => null)
    const viewport = layout?.layoutViewport || layout?.visualViewport || null
    const centerX = Number(viewport?.clientWidth) / 2
    const centerY = Number(viewport?.clientHeight) / 2
    const x = Number.isFinite(rawX) && rawX > 0 ? rawX : Number.isFinite(centerX) ? centerX : 0
    const y = Number.isFinite(rawY) && rawY > 0 ? rawY : Number.isFinite(centerY) ? centerY : 0
    try {
      await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY }, sessionId)
      return { x, y, deltaX, deltaY, method: 'mouseWheel' }
    } catch {
      try {
        await entry.client.send('Input.synthesizeScrollGesture', { x, y, xDistance: deltaX, yDistance: deltaY }, sessionId)
        return { x, y, deltaX, deltaY, method: 'synthesizeScrollGesture' }
      } catch {
        await entry.client.send('Runtime.evaluate', {
          expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})`,
          returnByValue: true
        }, sessionId)
        return { x, y, deltaX, deltaY, method: 'javascript' }
      }
    }
  }

  // SCROLL-09:JS scrollBy 对某些自定义滚动容器无效(scrollBy 被拦截/不动)时,派发真实 CDP
  // mouseWheel 兜底(对齐 元素滚动用 mouseWheel)。坐标在派发前重新解析,避免滚动或
  // 布局变化后沿用 observe 时的旧矩形而滚到相邻容器;每页像素=元素当前高度,回落 1000。
  async _mouseWheelElementFallback(entry, element, { pages = 1, down = true } = {}) {
    try {
      const point = await this._liveActionPoint(entry, element, 'scroll')
      const perPage = Number(point.rect?.height) || 1000
      const deltaY = perPage * Number(pages || 1) * (down ? 1 : -1)
      await this._mouseScroll(entry, { x: point.x, y: point.y, deltaY }, element.sessionId)
      return true
    } catch {
      return false
    }
  }

  async hover(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'hover')
    const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'hover')
    const decisionGuard = this._entryActionLease(entry, params, 'hover')
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'hover', index: element.index })
    try {
      const point = await this._liveActionPoint(entry, element, 'hover')
      await this._highlightElements(entry, [element], { color: '#06b6d4' }).catch(() => undefined)
      if (decisionGuard) decisionGuard()
      // A hover is a user-visible pointer action just like a click.  The CDP
      // mouseMoved events below affect the page but do not move Electron's
      // native cursor, so mirror the action with Fan's injected cursor before
      // dispatching the real trajectory.  Without this call hover worked
      // invisibly, which made successful actions look broken in the workbench.
      await this._cursorTo(entry, point.x, point.y, element.sessionId, {
        w: Number(point.rect?.width || 0),
        h: Number(point.rect?.height || 0)
      })
      if (decisionGuard) decisionGuard()
      await this._humanMouseTrajectory(entry, point.x, point.y, element.sessionId, undefined, decisionGuard)
      if (decisionGuard) decisionGuard()
      await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, element.sessionId)
      // Give :hover styles and their DOM mutations two paint opportunities
      // before the program continues to observe/assert.  A bounded timer keeps
      // this from hanging in a throttled/background renderer.
      await entry.client.send('Runtime.evaluate', {
        expression: `new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(true); } };
          setTimeout(finish, 80);
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(finish));
          } else {
            setTimeout(finish, 0);
          }
        })`,
        returnByValue: true,
        awaitPromise: true
      }, element.sessionId).catch(() => undefined)
      if (decisionGuard) decisionGuard()
      const result = { hovered: element.index, x: point.x, y: point.y, clickPointSource: point.source }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'hover', result })
      return result
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'hover', error: error.message })
      throw error
    }
  }

  async focus(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'focus')
    const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'focus')
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'focus', index: element.index })
    try {
      if (element.backendNodeId) {
        await entry.client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId }, element.sessionId).catch(() => undefined)
        await entry.client.send('DOM.focus', { backendNodeId: element.backendNodeId }, element.sessionId)
        const focused = await this._elementHasFocus(entry, element, element.sessionId)
        if (!focused) throw new Error('element did not become the active focus target')
        const output = { focused: element.index, backendNodeId: element.backendNodeId, tag: element.tag }
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'focus', result: output })
        return output
      }
      const result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el || !el.isConnected) return { ok: false, error: 'element not found' };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          return { ok: true, tag: el.tagName.toLowerCase() };
        })()`,
        returnByValue: true
      }, element.sessionId)
      const value = result?.result?.value || {}
      if (!value.ok) {
        const message = value.error || 'failed to focus element'
        if (this._elementFailureLooksStale(message)) {
          throw this._staleElementError(element.index, message, 'focus')
        }
        throw new Error(message)
      }
      const focused = await this._elementHasFocus(entry, element, element.sessionId)
      if (!focused) throw new Error('element did not become the active focus target')
      const output = { focused: element.index, tag: value.tag || element.tag }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'focus', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'focus', error: error.message })
      if (this._isBrowserReplanError(error)) throw error
      this._assertEntryDecisionToken(entry, params, 'focus')
      if (this._elementFailureLooksStale(error)) {
        throw this._staleElementError(element.index, error.message, 'focus')
      }
      throw error
    }
  }

  async drag(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'drag')
    const source = await this._elementForAction(
      entry,
      params.index ?? params.sourceIndex ?? params.source_index,
      params._fanDecisionToken,
      'drag'
    )
    let targetPoint = null
    let target = null
    if (params.targetIndex != null || params.target_index != null) {
      target = await this._elementForAction(
        entry,
        params.targetIndex ?? params.target_index,
        params._fanDecisionToken,
        'drag'
      )
      if (String(target.sessionId || '') !== String(source.sessionId || '')) {
        throw new Error('Drag source and target belong to different browser targets; cross-target drag is not supported safely')
      }
      targetPoint = await this._liveActionPoint(entry, target, 'drag to')
    } else {
      let tx = Number(params.toX ?? params.to_x)
      let ty = Number(params.toY ?? params.to_y)
      // CLK-4:模型给的 toX/toY 是 0-1000 归一化 → CSS-px;下面调 mouse() 传的是 CSS-px 且不带 normalized
      // 标志,故不会二次换算。targetIndex 分支使用实时元素 CSS-px,不换。
      if (this._isNormalizedCoordinate(params) && Number.isFinite(tx) && Number.isFinite(ty)) {
        this._assertVisualEvidence(entry, params)
        if (source.sessionId && !this._isPageTargetSession(entry, source.sessionId)) {
          throw new Error('Coordinate drag from an iframe target is ambiguous; provide a targetIndex in the same frame')
        }
        const css = await this._normalizedToCssPx(entry, tx, ty, undefined)
        tx = css.x; ty = css.y
      }
      targetPoint = { x: tx, y: ty }
    }
    if (!Number.isFinite(targetPoint.x) || !Number.isFinite(targetPoint.y)) throw new Error('targetIndex or toX/toY is required')
    const sourcePoint = await this._liveActionPoint(entry, source, 'drag')
    const result = await this.mouse(id, {
      operation: 'drag',
      x: sourcePoint.x,
      y: sourcePoint.y,
      toX: targetPoint.x,
      toY: targetPoint.y,
      button: params.button || 'left',
      steps: params.steps || 8,
      sessionId: source.sessionId,
      _fanDecisionToken: params._fanDecisionToken
    })
    return {
      ...result,
      dragged: source.index,
      target: target?.index ?? null,
      sourcePoint: { x: sourcePoint.x, y: sourcePoint.y },
      targetPoint: { x: targetPoint.x, y: targetPoint.y }
    }
  }

  _stringifyEvaluateValue(value) {
    return stringifyEvaluateValue(value)
  }

  _fixJavascriptString(jsCode) {
    return fixJavascriptString(jsCode)
  }

  async evaluate(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'evaluate')
    const pageFunction = this._fixJavascriptString(params.expression || params.function || params.pageFunction || params.page_function || '')
    if (!pageFunction) throw new Error('expression is required')
    if (!(pageFunction.startsWith('(') && pageFunction.includes('=>'))) {
      throw new Error('expression must be an arrow function starting with "("')
    }
    const args = Array.isArray(params.args) ? params.args : []
    const expression = `(${pageFunction})(${args.map(arg => JSON.stringify(arg)).join(', ')})`
    const sessionId = params.sessionId || params.session_id
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'evaluate' })
    try {
      const result = await entry.client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId)
      if (result?.exceptionDetails) throw new Error(`JavaScript evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
      const value = result?.result?.value
      const output = { value, text: this._stringifyEvaluateValue(value) }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'evaluate', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'evaluate', error: error.message })
      throw error
    }
  }

  _validateAndFixJavaScript(code) {
    return validateAndFixJavaScript(code)
  }

  _formatJavaScriptEvaluationResult(resultData = {}, maxChars = 20000) {
    return formatJavaScriptEvaluationResult(resultData, maxChars)
  }

  async evaluateJavaScript(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'evaluateJavaScript')
    const code = String(params.code || params.expression || params.javascript || '').trim()
    if (!code) throw new Error('code is required')
    const sessionId = params.sessionId || params.session_id
    const validatedCode = this._validateAndFixJavaScript(code)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'evaluateJavaScript' })
    try {
      const result = await entry.client.send('Runtime.evaluate', {
        expression: validatedCode,
        returnByValue: true,
        awaitPromise: true
      }, sessionId)
      if (result?.exceptionDetails) {
        const text = result.exceptionDetails.text || 'Unknown error'
        throw new Error(`JavaScript execution error: ${text}`)
      }
      const resultData = result?.result || {}
      if (resultData.wasThrown) throw new Error('JavaScript code execution failed (wasThrown=true)')
      const formatted = this._formatJavaScriptEvaluationResult(resultData, params.maxChars || params.max_chars || 20000)
      const output = {
        ...formatted,
        validatedCode,
        metadata: formatted.images.length ? { images: formatted.images } : null
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'evaluateJavaScript', result: { text: output.text, truncated: output.truncated } })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'evaluateJavaScript', error: error.message })
      throw error
    }
  }

  async element(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'element')
    const operation = String(params.operation || 'info').trim()
    const item = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'element')
    if (item.backendNodeId && (!item.selector || operation === 'info' || operation === 'attribute' || operation === 'evaluate')) {
      return this._elementByBackendNode(entry, item, params)
    }
    return this._elementBySelector(entry, item, params)
  }

  _elementFunctionDeclaration(expression) {
    return elementFunctionDeclaration(expression)
  }

  async _elementBySelector(entry, item, params = {}) {
    const operation = String(params.operation || 'info').trim()
    const functionDeclaration = operation === 'evaluate'
      ? this._elementFunctionDeclaration(params.expression || params.function || '')
      : ''
    const args = Array.isArray(params.args) ? params.args : []
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(item))}];
        ${this._resolveElementFunction()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
        if (!el) return { ok: false, error: 'element not found' };
        const op = ${JSON.stringify(operation)};
        if (op === 'attribute') {
          const name = ${JSON.stringify(params.name || '')};
          if (!name) return { ok: false, error: 'attribute name is required' };
          return { ok: true, index: item.index, name, value: el.getAttribute(name) };
        }
        if (op === 'evaluate') {
          const fn = (0, eval)('(' + ${JSON.stringify(functionDeclaration)} + ')');
          const args = ${JSON.stringify(args)};
          return Promise.resolve(fn.apply(el, args)).then(value => ({ ok: true, index: item.index, value }));
        }
        const rect = el.getBoundingClientRect();
        const attributes = {};
        for (const attr of Array.from(el.attributes || [])) attributes[attr.name] = attr.value;
        return {
          ok: true,
          index: item.index,
          tag: el.tagName.toLowerCase(),
          text: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
          attributes,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    }, item.sessionId)
    const value = result?.result?.value || {}
    if (!value.ok) {
      const message = value.error || 'element operation failed'
      if (this._elementFailureLooksStale(message)) {
        throw this._staleElementError(item.index, message, 'element')
      }
      throw new Error(message)
    }
    if (operation === 'evaluate') value.text = this._stringifyEvaluateValue(value.value)
    return value
  }

  async _elementByBackendNode(entry, item, params = {}) {
    const operation = String(params.operation || 'info').trim()
    const sessionId = item.sessionId
    if (operation === 'evaluate') {
      const functionDeclaration = this._elementFunctionDeclaration(params.expression || params.function || '')
      const args = Array.isArray(params.args) ? params.args : []
      const call = await this._usingResolvedBackendNode(entry, item.backendNodeId, sessionId, objectId => (
        entry.client.send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration,
            arguments: args.map(value => ({ value })),
            returnByValue: true,
            awaitPromise: true
          },
          sessionId
        )
      ))
      if (!call) {
        throw this._staleElementError(
          item.index,
          'element object is not available',
          'element'
        )
      }
      if (call?.exceptionDetails) throw new Error(`JavaScript evaluation failed: ${JSON.stringify(call.exceptionDetails)}`)
      const value = call?.result?.value
      return { ok: true, index: item.index, value, text: this._stringifyEvaluateValue(value) }
    }

    const pushed = await entry.client.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [item.backendNodeId] }, sessionId)
    const nodeId = pushed?.nodeIds?.[0]
    if (!nodeId) {
      throw this._staleElementError(
        item.index,
        'element node is not available',
        'element'
      )
    }
    const node = await entry.client.send('DOM.describeNode', { nodeId, depth: 0 }, sessionId)
    const described = node?.node || {}
    const attributesList = described.attributes || []
    const attributes = {}
    for (let index = 0; index < attributesList.length - 1; index += 2) {
      attributes[attributesList[index]] = attributesList[index + 1]
    }
    if (operation === 'attribute') {
      const name = String(params.name || '')
      if (!name) throw new Error('attribute name is required')
      return { ok: true, index: item.index, name, value: attributes[name] ?? null }
    }
    return {
      ok: true,
      index: item.index,
      backendNodeId: item.backendNodeId,
      nodeId,
      tag: String(described.nodeName || item.tag || '').toLowerCase(),
      nodeType: described.nodeType || null,
      nodeValue: described.nodeValue || '',
      attributes,
      rect: item.rect || null,
      text: item.text || ''
    }
  }

  async dialog(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'dialog')
    const action = String(params.action || '').trim()
    if (!['accept', 'dismiss'].includes(action)) {
      throw new Error("action must be 'accept' or 'dismiss'")
    }
    const promptText = params.promptText ?? params.prompt_text
    const commandParams = { accept: action === 'accept' }
    if (promptText != null) commandParams.promptText = String(promptText)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'dialog', dialogAction: action })
    try {
      const dialog = entry.pendingDialog
      await entry.client.send('Page.handleJavaScriptDialog', commandParams)
      if (!dialog?.dialogId || entry.pendingDialog?.dialogId === dialog.dialogId) {
        entry.pendingDialog = null
      }
      const output = { responded: action, dialog }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'dialog', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'dialog', error: error.message })
      throw error
    }
  }

  // SHC-7:sessionId 是否指向 page/tab 目标(而非 OOPIF iframe / worker 子目标)。
  // 主 session(sessionId 为空)即页目标;查不到 target 类型时保守当 page(不破坏现状)。
  _isPageTargetSession(entry, sessionId) {
    if (!sessionId) return true
    try {
      const tid = entry.targetManager?.sessions?.get(sessionId)
      const info = tid && entry.targetManager?.targets?.get(tid)
      const type = String(info?.type || '').toLowerCase()
      if (!type) return true
      return type === 'page' || type === 'tab'
    } catch {
      return true
    }
  }

  async screenshot(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'screenshot')
    let sessionId = params.sessionId || params.session_id
    let clip = params.clip && typeof params.clip === 'object' ? params.clip : null
    let clipSource = null
    if (params.index != null) {
      const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'screenshot')
      sessionId = element.sessionId
      const elementClip = await this._elementScreenshotClip(entry, element, sessionId)
      clip = elementClip.clip
      clipSource = elementClip.source
    }
    if (!clip && params.x != null && params.y != null && params.width != null && params.height != null) {
      clip = {
        x: Number(params.x),
        y: Number(params.y),
        width: Number(params.width),
        height: Number(params.height),
        scale: Number(params.scale) || 1
      }
    }
    // SHC-7:CDP Page.captureScreenshot 只对 page/tab 目标可靠;若元素落在跨域 OOPIF/worker 子目标,
    // 用该子 session 截图会报错/返回坏图。回退到页级 session(对齐 的 page-target 护栏)。
    // OOPIF-local 的元素 clip 在页 session 下坐标系不对,一并丢弃,降级成整页有效截图(好过失败/坏图)。
    if (sessionId && !this._isPageTargetSession(entry, sessionId)) {
      sessionId = undefined
      clip = null
      clipSource = 'oopif-page-fallback'
    }
    let format = String(params.format || 'png').toLowerCase()
    if (format === 'jpg') format = 'jpeg'
    if (!['png', 'jpeg', 'webp'].includes(format)) format = 'png'
    const includeHighlights = Boolean(params.includeHighlights || params.include_highlights)
    const request = {
      format,
      fromSurface: params.fromSurface !== false,
      captureBeyondViewport: Boolean(params.captureBeyondViewport || params.fullPage || params.full_page)
    }
    if (params.quality != null && ['jpeg', 'webp'].includes(format)) {
      request.quality = Math.max(1, Math.min(100, Number(params.quality) || 80))
    }
    // SHC-5:clip 原样透传 x/y(去掉 Math.max(0,..) 钳制),允许负偏移——对齐 交给
    // CDP Page.captureScreenshot 自校验;width/height 同样不强行抬到 1。scale 保留 0.1 下限(防 CDP
    // 报错的 floor,属我方更稳处,"只强不弱"保留)。
    if (clip) request.clip = {
      x: Number(clip.x || 0),
      y: Number(clip.y || 0),
      width: Number(clip.width || 0),
      height: Number(clip.height || 0),
      scale: Math.max(0.1, Number(clip.scale || 1))
    }
    const hideHighlights = !includeHighlights
    try {
      if (hideHighlights) await this._setHighlightOverlaysHidden(entry, true, sessionId)
      const result = await entry.client.send('Page.captureScreenshot', request, sessionId)
      return {
        ...result,
        format: request.format,
        clip: request.clip || null,
        clipSource,
        includeHighlights,
        visualEvidenceToken: this._issueVisualEvidence(entry)
      }
    } finally {
      if (hideHighlights) await this._setHighlightOverlaysHidden(entry, false, sessionId)
    }
  }

  async saveScreenshot(id, params = {}) {
    const result = await this.screenshot(id, params)
    const requestedPath = String(params.path || '').trim()
    const fileName = params.fileName || params.file_name
    let filePath = requestedPath
    if (!filePath && fileName) {
      const requestedExtension = path.extname(String(fileName)).slice(1).toLowerCase()
      const compatibleExtensions = result.format === 'jpeg'
        ? new Set(['jpg', 'jpeg'])
        : new Set([result.format])
      const extension = compatibleExtensions.has(requestedExtension)
        ? requestedExtension
        : result.format === 'jpeg' ? 'jpg' : result.format
      filePath = await this._uniqueDownloadFilePath(fileName, extension, 'screenshot')
    }
    if (!filePath) throw new Error('path or fileName is required')
    await fs.writeFile(filePath, Buffer.from(String(result.data || ''), 'base64'))
    return {
      path: filePath,
      fileName: path.basename(filePath),
      format: result.format,
      bytes: Buffer.byteLength(String(result.data || ''), 'base64'),
      clip: result.clip || null
    }
  }

  _pdfPaperSize(format) {
    const sizes = {
      letter: { paperWidth: 8.5, paperHeight: 11 },
      legal: { paperWidth: 8.5, paperHeight: 14 },
      a4: { paperWidth: 8.27, paperHeight: 11.69 },
      a3: { paperWidth: 11.69, paperHeight: 16.54 },
      tabloid: { paperWidth: 11, paperHeight: 17 }
    }
    const key = String(format || 'letter').trim().toLowerCase()
    return { paperFormat: sizes[key] ? key : 'letter', ...(sizes[key] || sizes.letter) }
  }

  async savePdf(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'savePdf')
    const sessionId = params.sessionId || params.session_id
    const paper = this._pdfPaperSize(params.paperFormat || params.paper_format || 'Letter')
    const scale = Math.max(0.1, Math.min(2, Number(params.scale) || 1))
    const request = {
      printBackground: params.printBackground ?? params.print_background ?? true,
      landscape: Boolean(params.landscape),
      scale,
      paperWidth: paper.paperWidth,
      paperHeight: paper.paperHeight,
      preferCSSPageSize: true
    }
    const title = typeof entry.webContents?.getTitle === 'function' ? entry.webContents.getTitle() : ''
    const fileName = params.fileName || params.file_name || title || 'page'
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'savePdf', paperFormat: paper.paperFormat })
    try {
      const printResult = await entry.client.send('Page.printToPDF', request, sessionId)
      const pdfData = printResult?.data
      if (!pdfData) throw new Error('CDP Page.printToPDF returned no data')
      const bytes = Buffer.from(String(pdfData), 'base64')
      const filePath = await this._uniqueDownloadPath(fileName)
      await fs.writeFile(filePath, bytes)
      const output = {
        saved: true,
        fileName: path.basename(filePath),
        path: filePath,
        bytes: bytes.length,
        mimeType: 'application/pdf',
        paperFormat: paper.paperFormat,
        printBackground: Boolean(request.printBackground),
        landscape: request.landscape,
        scale: request.scale
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'savePdf', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'savePdf', error: error.message })
      throw error
    }
  }

  async setViewport(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'setViewport')
    const width = Number(params.width)
    const height = Number(params.height)
    if (!Number.isFinite(width) || width <= 0) throw new Error('width must be a positive number')
    if (!Number.isFinite(height) || height <= 0) throw new Error('height must be a positive number')
    const deviceScaleFactor = Number(params.deviceScaleFactor ?? params.device_scale_factor ?? 1)
    const sessionId = params.sessionId || params.session_id
    const viewport = {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0 ? deviceScaleFactor : 1,
      mobile: Boolean(params.mobile)
    }
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'setViewport', viewport })
    try {
      await entry.client.send('Emulation.setDeviceMetricsOverride', viewport, sessionId)
      const output = { viewport }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'setViewport', result: output })
      return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'setViewport', error: error.message })
      throw error
    }
  }

  _uploadFileInputFinderSource() {
    return `
      function fanIsFileInput(el) {
        return !!(el && el.tagName && el.tagName.toLowerCase() === 'input' && String(el.type || '').toLowerCase() === 'file');
      }
      function fanElementChildren(node) {
        const children = Array.from(node && node.children ? node.children : []);
        if (node && node.shadowRoot) children.push(...Array.from(node.shadowRoot.children || []));
        return children;
      }
      function fanCollectFileInputsInDescendants(node, depth, output) {
        if (!node || depth < 0) return output;
        if (fanIsFileInput(node)) output.add(node);
        for (const child of fanElementChildren(node)) fanCollectFileInputsInDescendants(child, depth - 1, output);
        return output;
      }
      function fanUniqueFileInput(inputs) {
        const candidates = Array.from(inputs || []).filter(input => input && input.isConnected && fanIsFileInput(input));
        if (candidates.length > 1) {
          throw new Error('Multiple file upload inputs match the selected element. Observe again and select the specific upload control.');
        }
        return candidates[0] || null;
      }
      function fanExplicitFileInputForElement(element) {
        if (!element) return null;
        const candidates = new Set();
        const label = element.matches?.('label') ? element : element.closest?.('label');
        if (fanIsFileInput(label?.control)) candidates.add(label.control);
        const root = element.getRootNode?.() || document;
        for (const name of ['for', 'aria-controls']) {
          const value = String(element.getAttribute?.(name) || '').trim();
          for (const id of value.split(/\\s+/).filter(Boolean)) {
            const referenced = root.getElementById?.(id) || element.ownerDocument?.getElementById?.(id);
            if (fanIsFileInput(referenced)) candidates.add(referenced);
          }
        }
        return fanUniqueFileInput(candidates);
      }
      function fanFindFileInputNearElement(startElement, maxHeight, maxDescendantDepth) {
        let current = startElement;
        const height = maxHeight == null ? 3 : maxHeight;
        const depth = maxDescendantDepth == null ? 3 : maxDescendantDepth;
        for (let level = 0; current && level <= height; level += 1) {
          if (fanIsFileInput(current)) return current;
          const explicit = fanExplicitFileInputForElement(current);
          if (explicit) return explicit;
          const descendant = fanUniqueFileInput(fanCollectFileInputsInDescendants(current, depth, new Set()));
          if (descendant) return descendant;
          const parent = current.parentElement || current.getRootNode?.().host || null;
          if (parent) {
            const siblingCandidates = new Set();
            for (const sibling of fanElementChildren(parent)) {
              if (sibling === current) continue;
              fanCollectFileInputsInDescendants(sibling, depth, siblingCandidates);
            }
            const siblingMatch = fanUniqueFileInput(siblingCandidates);
            if (siblingMatch) return siblingMatch;
          }
          current = parent;
        }
        return null;
      }
      function fanCollectFileInputs(root, output) {
        if (!root) return output;
        if (fanIsFileInput(root)) output.push(root);
        for (const child of fanElementChildren(root)) fanCollectFileInputs(child, output);
        return output;
      }
      function fanUniqueFileInputOnPage() {
        const root = document.documentElement || document.body;
        return fanUniqueFileInput(new Set(fanCollectFileInputs(root, [])));
      }
      function fanPrepareUploadInput(input) {
        if (!input || !input.isConnected || !fanIsFileInput(input)) return null;
        input.scrollIntoView({ block: 'center', inline: 'center' });
        return input;
      }
    `
  }

  // UP-5/6:页内 JS finder 穿不透 closed shadow(node.shadowRoot 只见 open)、跨不了 iframe(困在元素
  // 自己的 document)。兜底用 CDP DOM.getDocument(pierce:true) 枚举全树(穿透 closed shadow + iframe
  // contentDocument)里的 <input type=file>。仅有一个候选时返回 backendNodeId;多个候选必须报歧义,
  // 不能按树顺序猜测并把文件交给错误表单。
  async _findFileInputViaCDP(entry, sessionId) {
    const found = new Set()
    try {
      const doc = await entry.client.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId)
      const isFileInput = node => {
        if (String(node.nodeName || '').toLowerCase() !== 'input') return false
        const attrs = node.attributes || []
        for (let i = 0; i + 1 < attrs.length; i += 2) {
          if (String(attrs[i]).toLowerCase() === 'type' && String(attrs[i + 1]).toLowerCase() === 'file') return true
        }
        return false
      }
      const walk = node => {
        if (!node || found.size > 1) return
        if (isFileInput(node) && node.backendNodeId != null) found.add(node.backendNodeId)
        for (const c of node.children || []) walk(c)
        for (const sr of node.shadowRoots || []) walk(sr)   // 含 closed shadow root
        if (node.contentDocument) walk(node.contentDocument)  // 跨 iframe 文档
      }
      walk(doc?.root)
    } catch {
      return null
    }
    if (found.size > 1) {
      throw new Error(
        'Multiple file upload inputs are available and the selected element could not be matched safely. ' +
        'Observe again and select the specific upload control.'
      )
    }
    return found.size ? found.values().next().value : null
  }

  async _resolveFileInputForUpload(entry, element) {
    const sessionId = element.sessionId
    const directFileInput = Boolean(
      element.capabilities?.upload || (element.tag === 'input' && String(element.type || '').toLowerCase() === 'file')
    )
    if (directFileInput && element.backendNodeId) {
      return { backendNodeId: element.backendNodeId, sessionId, strategy: 'direct-backend' }
    }

    if (element.backendNodeId) {
      const nearby = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function() { ${this._uploadFileInputFinderSource()} if (!this.isConnected) return null; return fanPrepareUploadInput(fanFindFileInputNearElement(this) || fanUniqueFileInputOnPage()); }`,
            objectGroup: 'fan-browser-runtime'
          },
          sessionId
        )
      ))
      if (!nearby) {
        throw this._staleElementError(
          element.index,
          `Element ${element.index} is not available`,
          'upload'
        )
      }
      if (nearby?.exceptionDetails) {
        const message = String(nearby.exceptionDetails.exception?.description || nearby.exceptionDetails.text || 'file upload input resolution failed').split('\n')[0]
        throw new Error(message)
      }
      if (nearby?.result?.objectId) return { objectId: nearby.result.objectId, sessionId, strategy: 'nearby-backend' }
      // UP-5/6:near-element 失败 → CDP pierce 兜底(穿透 closed shadow + iframe)
      const cdpBn = await this._findFileInputViaCDP(entry, sessionId)
      if (cdpBn != null) return { backendNodeId: cdpBn, sessionId, strategy: 'cdp-pierce' }
      throw new Error('No file upload element found on the page')
    }

    const remote = await entry.client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          ${this._uploadFileInputFinderSource()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el || !el.isConnected) throw new Error('__FAN_STALE_ELEMENT__');
          return fanPrepareUploadInput(fanFindFileInputNearElement(el) || fanUniqueFileInputOnPage());
        })()`,
        objectGroup: 'fan-browser-runtime'
      },
      sessionId
    )
    if (remote?.exceptionDetails) {
      const message = String(remote.exceptionDetails.exception?.description || remote.exceptionDetails.text || 'file upload input resolution failed').split('\n')[0]
      if (message.includes('__FAN_STALE_ELEMENT__')) {
        throw this._staleElementError(
          element.index,
          `Element ${element.index} is not available`,
          'upload'
        )
      }
      throw new Error(message)
    }
    const objectId = remote?.result?.objectId
    if (!objectId) {
      // UP-5/6:selector 路径同样 CDP pierce 兜底
      const cdpBn = await this._findFileInputViaCDP(entry, sessionId)
      if (cdpBn != null) return { backendNodeId: cdpBn, sessionId, strategy: 'cdp-pierce' }
      throw new Error('No file upload element found on the page')
    }
    return { objectId, sessionId, strategy: directFileInput ? 'direct-selector' : 'nearby-selector' }
  }

  async upload(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'upload')
    const files = (Array.isArray(params.files) ? params.files : [params.path || params.file].filter(Boolean))
      .map(file => String(file || '').trim())
      .filter(Boolean)
    if (!files.length) {
      throw this._uploadValidationError(
        'BROWSER_UPLOAD_FILES_REQUIRED',
        'Upload failed - at least one file path is required',
        'files-required'
      )
    }
    const element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'upload')
    const complete = output => {
      const result = params._fanProtectedInput === true
        ? {
            uploaded: output?.uploaded ?? element.index,
            ...(output?.backendNodeId != null ? { backendNodeId: output.backendNodeId } : {}),
            ...(output?.strategy ? { strategy: output.strategy } : {}),
            fileCount: Array.isArray(output?.files) ? output.files.length : 0,
            totalBytes: Array.isArray(output?.fileStats)
              ? output.fileStats.reduce(
                  (total, item) => total + (Number(item?.size) || 0),
                  0
                )
              : 0
          }
        : output
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'upload', result })
      return result
    }
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'upload', index: element.index })
    try {
    const validatedFiles = await this._validateUploadFiles(files, {
      redactPaths: params._fanProtectedInput === true
    })
    const canonicalFiles = validatedFiles.map(file => file.canonicalPath)
    const fileStats = validatedFiles.map(file => ({ path: file.path, size: file.size }))
    this._assertEntryDecisionToken(entry, params, 'upload')
    const target = await this._resolveFileInputForUpload(entry, element)
    if (target.backendNodeId) {
      this._assertEntryDecisionToken(entry, params, 'upload')
      await entry.client.send(
        'DOM.setFileInputFiles',
        {
          backendNodeId: target.backendNodeId,
          files: canonicalFiles
        },
        target.sessionId
      )
      entry.selectorMap.clear('upload')
      const output = {
        uploaded: element.index,
        backendNodeId: target.backendNodeId,
        files,
        fileStats,
        strategy: target.strategy
      }
      return complete(output)
    }

    try {
      this._assertEntryDecisionToken(entry, params, 'upload')
      await entry.client.send('DOM.setFileInputFiles', {
        objectId: target.objectId,
        files: canonicalFiles
      }, target.sessionId)
    } finally {
      await entry.client.send('Runtime.releaseObject', { objectId: target.objectId }, target.sessionId).catch(() => undefined)
    }
    entry.selectorMap.clear('upload')
    const output = { uploaded: element.index, files, fileStats, strategy: target.strategy }
    return complete(output)
    } catch (error) {
      const protectedInput = params._fanProtectedInput === true
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
        id: entry.id,
        action: 'upload',
        error: protectedInput ? 'Protected file upload failed' : error.message
      })
      if (this._isBrowserReplanError(error)) throw error
      this._assertEntryDecisionToken(entry, params, 'upload')
      if (this._elementFailureLooksStale(error)) {
        throw this._staleElementError(
          element.index,
          protectedInput ? 'Protected file upload target became unavailable' : error.message,
          'upload'
        )
      }
      if (protectedInput) {
        const details = error?.details && typeof error.details === 'object'
          ? error.details
          : {}
        error.message = 'Protected file upload failed'
        error.details = Object.fromEntries(
          Object.entries(details).filter(([key]) => [
            'retryable',
            'replanRequired',
            'replan_required',
            'beforeDispatch',
            'dispatchAttempted',
            'action',
            'reason',
            'effect'
          ].includes(key))
        )
      }
      throw error
    }
  }

  _uploadValidationError(code, message, reason) {
    const error = new Error(message)
    error.code = code
    error.details = {
      retryable: true,
      beforeDispatch: true,
      dispatchAttempted: false,
      action: 'upload',
      reason
    }
    return error
  }

  _expandUploadPath(file) {
    const requested = String(file || '').trim()
    if (!/^~(?:[\\/]|$)/.test(requested)) return requested
    const home = os.homedir()
    if (requested === '~') return home
    return path.resolve(home, requested.slice(2))
  }

  async _validateUploadFiles(files = [], { redactPaths = false } = {}) {
    if (!Array.isArray(files) || !files.length) {
      throw this._uploadValidationError(
        'BROWSER_UPLOAD_FILES_REQUIRED',
        'Upload failed - at least one file path is required',
        'files-required'
      )
    }
    const stats = []
    for (const [fileIndex, requestedPath] of files.entries()) {
      const file = this._expandUploadPath(requestedPath)
      const fileLabel = redactPaths
        ? `file #${fileIndex + 1}`
        : `file ${requestedPath}`
      // Resolve aliases, symlinks and relative segments before dispatching the
      // upload. The model may use any readable local file; validation only
      // rejects missing paths, directories and empty files.
      let real
      try {
        real = await fs.realpath(file)
      } catch {
        throw this._uploadValidationError(
          'BROWSER_UPLOAD_FILE_NOT_FOUND',
          `Upload failed - ${fileLabel} does not exist`,
          'file-not-found'
        )
      }
      let stat
      try {
        stat = await fs.stat(real)
      } catch {
        throw this._uploadValidationError(
          'BROWSER_UPLOAD_FILE_NOT_FOUND',
          `Upload failed - ${fileLabel} does not exist`,
          'file-not-found'
        )
      }
      if (!stat.isFile()) {
        throw this._uploadValidationError(
          'BROWSER_UPLOAD_NOT_A_FILE',
          `Upload failed - ${fileLabel} is not a file`,
          'not-a-file'
        )
      }
      if (stat.size === 0) {
        throw this._uploadValidationError(
          'BROWSER_UPLOAD_FILE_EMPTY',
          `Upload failed - ${fileLabel} is empty (0 bytes)`,
          'empty-file'
        )
      }
      stats.push({
        path: String(requestedPath),
        size: stat.size,
        canonicalPath: real
      })
    }
    return stats
  }

  async sendKeys(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const actionGuard = this._entryActionLease(entry, params, 'sendKeys')
    actionGuard()
    const keys = Array.isArray(params.keys) ? params.keys : [String(params.keys ?? params.text ?? '')].filter(Boolean)
    const sessionId = params.sessionId || params.session_id
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'sendKeys', keys })
    try {
    const sent = []
    for (const key of keys) {
      actionGuard()
      const rawKey = String(key ?? '')
      const textualInput = rawKey.length > 1 && keyMode(rawKey) === 'text'
      if (textualInput) {
        const typeability = await this._inspectActiveTypeability(entry, sessionId).catch(() => null)
        if (typeability?.typeable === false) {
          const error = new Error(
            `Cannot send text to the current focus because it is not an editable text target (${typeability.reason || 'not-typeable'}). ` +
            'Use fan.type with a numbered input or editable body.'
          )
          error.code = 'ACTIVE_ELEMENT_NOT_TYPEABLE'
          error.details = {
            retryable: false,
            replanRequired: true,
            beforeDispatch: true,
            dispatchAttempted: false,
            action: 'sendKeys',
            reason: String(typeability.reason || 'not-typeable')
          }
          throw error
        }
      }
      sent.push(await sendKey(entry.client, key, sessionId))
    }
    // Enter/Return 可能触发导航/提交,等 0.1s 沉降再返回(SK-6,
    if (keys.some(key => /enter|return/i.test(String(key)))) await this._sleep(100)
    // Legacy/atomic sendKeys invalidates the old observation as before.
    // ProgramRunner alone injects preserveSelectorMap for a leased multi-step
    // transaction whose later numbered actions still use that observation.
    if (params.preserveSelectorMap !== true) entry.selectorMap.clear('keys')
    const output = { sent: keys, details: sent }
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'sendKeys', result: output })
    return output
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'sendKeys', error: error.message })
      throw error
    }
  }

  async wait(id, params = {}) {
    const entry = this.getWorkbench(id)
    const actionGuard = this._entryActionLease(entry, params, 'wait')
    actionGuard()
    // NAV-2:默认 3s用 null 判断而非 `|| 3`,让显式 seconds:0 被尊重(不再被吞成默认)
    const raw = params.seconds == null ? 3 : Number(params.seconds)
    const seconds = Math.max(0, Math.min(30, Number.isFinite(raw) ? raw : 3))
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
      actionGuard()
    }
    return { waited: seconds }
  }

  async settle(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const actionGuard = this._entryActionLease(entry, params, 'settle')
    actionGuard()
    const timeoutMs = this._coerceTimeout(params.timeoutMs || params.timeout_ms, 5000)
    const idleMs = Math.max(50, Math.min(5000, Number(params.networkIdleMs ?? params.network_idle_ms) || 300))
    const startedAt = Date.now()
    let idleStartedAt = null
    let lastState = { readyState: '', pendingRequests: 0 }
    while (Date.now() - startedAt < timeoutMs) {
      actionGuard()
      const readyResult = await entry.client
        .send('Runtime.evaluate', {
          expression: `(() => ({ readyState: document.readyState, url: location.href, title: document.title }))()`,
          returnByValue: true
        })
        .catch(error => ({ result: { value: { readyState: 'unknown', error: error.message } } }))
      actionGuard()
      const ready = readyResult?.result?.value || {}
      const pendingRequests = typeof entry.watchdog?.pendingSettleCount === 'function'
        ? entry.watchdog.pendingSettleCount()
        : (entry.watchdog?.pendingRequests?.size || 0)
      lastState = { ...ready, pendingRequests }
      const readyEnough = ready.readyState === 'interactive' || ready.readyState === 'complete'
      if (readyEnough && pendingRequests === 0) {
        if (idleStartedAt == null) idleStartedAt = Date.now()
        if (Date.now() - idleStartedAt >= idleMs) {
          return { settled: true, elapsedMs: Date.now() - startedAt, ...lastState }
        }
      } else {
        idleStartedAt = null
      }
      await new Promise(resolve => setTimeout(resolve, 100))
      actionGuard()
    }
    return { settled: false, elapsedMs: Date.now() - startedAt, ...lastState }
  }
}

installInputOperations(ElectronBrowserRuntime)
installClickOperations(ElectronBrowserRuntime)
installStateOperations(ElectronBrowserRuntime)
installObservationOperations(ElectronBrowserRuntime)
installVisualOperations(ElectronBrowserRuntime)
installSessionOperations(ElectronBrowserRuntime)
installNavigationOperations(ElectronBrowserRuntime)

module.exports = { ElectronBrowserRuntime }
