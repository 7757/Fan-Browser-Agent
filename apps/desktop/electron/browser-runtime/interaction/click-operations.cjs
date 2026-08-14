'use strict'

const crypto = require('node:crypto')

const { EVENT_TYPES } = require('../events/event-types.cjs')
const browserIO = require('../network/browser-io.cjs')
const { PAGE_CHANGED_CLEAR_REASONS } = require('../session/operations.cjs')

const VISUAL_EVIDENCE_TTL_MS = 2 * 60 * 1000

class ClickOperations {
  async _elementForAction(entry, index, decisionToken = null, action = 'element') {
    const numeric = Number(index)
    if (!Number.isFinite(numeric)) throw new Error('index is required')
    if (decisionToken && typeof decisionToken === 'object') {
      this._assertDecisionToken(
        this._sessionIdForEntry(entry),
        { _fanDecisionToken: decisionToken, index: numeric },
        action
      )
    }
    if (!entry.selectorMap.get(numeric)) {
      // A tokenized model action may use only the exact map the model saw.  The
      // legacy auto-observe path below is intentionally forbidden here: a new
      // page can reuse the same integer for an unrelated destructive control.
      if (decisionToken && typeof decisionToken === 'object') {
        const error = new Error(
          `Element index ${numeric} does not exist in the browser snapshot used for this decision. ` +
          'The action was not executed; observe again and choose a fresh index.'
        )
        error.code = 'ELEMENT_NOT_FOUND'
        error.details = {
          retryable: true,
          replanRequired: true,
          action: String(action || ''),
          index: numeric,
          current: this._browserDecisionToken(this._sessionIdForEntry(entry))
        }
        throw error
      }
      // If the map was emptied because the PAGE changed (navigation/document
      // swap), the caller's index was minted against the previous page —
      // auto-re-observing here would silently re-mint indices on the NEW page
      // and act on the wrong element. Fail with a model-actionable error
      // instead. Maps emptied by same-page action clears (click/type/scroll)
      // keep the auto-observe convenience.
      if (entry.selectorMap.size === 0 && PAGE_CHANGED_CLEAR_REASONS.has(entry.selectorMap.reason)) {
        throw this._staleElementError(
          numeric,
          `Element index ${numeric} is stale: the page changed since the last observation ` +
          `(${entry.selectorMap.reason}). Observe again and use fresh element indices.`,
          action,
          { reason: entry.selectorMap.reason }
        )
      }
      await this.observe(entry.id)
    }
    const element = entry.selectorMap.get(numeric)
    if (!element) {
      const error = new Error(`Element index ${numeric} is not available`)
      error.code = 'ELEMENT_NOT_FOUND'
      error.details = { retryable: true, replanRequired: true, action: String(action || ''), index: numeric }
      throw error
    }
    if (element.disabled) {
      const error = new Error(`Element index ${numeric} is disabled`)
      error.code = 'ELEMENT_DISABLED'
      error.details = { retryable: false, action: String(action || ''), index: numeric }
      throw error
    }
    return element
  }

  _staleElementError(index, message, action = 'element', details = {}) {
    const error = new Error(String(message || `Element index ${index} is stale`))
    error.code = 'STALE_ELEMENT_REFERENCE'
    error.details = {
      retryable: true,
      replanRequired: true,
      action: String(action || ''),
      index: Number(index),
      ...details
    }
    return error
  }

  _isBrowserReplanError(error) {
    if (error?.details?.replanRequired === true) return true
    return new Set([
      'STALE_ELEMENT_REFERENCE',
      'ELEMENT_NOT_FOUND',
      'BROWSER_STATE_CHANGED',
      'BROWSER_SESSION_MISMATCH'
    ]).has(String(error?.code || ''))
  }

  _failClosedClickError(element = {}, reason = 'unsafe-click', cause = null, provenance = {}) {
    const error = new Error(
      `Submit element index ${element.index} was not clicked because the native click path was unsafe (${reason}).`
    )
    const hasBeforeDispatch = Object.prototype.hasOwnProperty.call(provenance, 'beforeDispatch')
    const hasDispatchAttempted = Object.prototype.hasOwnProperty.call(provenance, 'dispatchAttempted')
    error.code = 'FORM_SUBMIT_CLICK_UNSAFE'
    error.details = {
      retryable: true,
      replanRequired: true,
      dispatchAttempted: hasDispatchAttempted ? Boolean(provenance.dispatchAttempted) : false,
      action: 'formSubmit',
      reason: String(reason || 'unsafe-click'),
      index: Number(element.index)
    }
    const beforeDispatch = hasBeforeDispatch ? provenance.beforeDispatch : true
    if (beforeDispatch !== undefined) error.details.beforeDispatch = beforeDispatch
    if (cause) error.cause = cause
    return error
  }

  _elementFailureLooksStale(error) {
    const message = String(error?.message || error || '').toLowerCase()
    return [
      'element not found',
      'element is detached',
      'failed to resolve element',
      'failed to resolve backend node',
      'no node with given id',
      'could not find node',
      'cannot find context',
      'execution context was destroyed'
    ].some(fragment => message.includes(fragment))
  }

  _browserIndexTraceError(error) {
    const details = error?.details && typeof error.details === 'object' ? error.details : {}
    return {
      errorCode: error?.code == null ? null : String(error.code),
      errorMessage: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 300),
      retryable: typeof details.retryable === 'boolean' ? details.retryable : null,
      replanRequired: typeof details.replanRequired === 'boolean' ? details.replanRequired : null
    }
  }

  _browserIndexTraceElement(element) {
    if (!element || typeof element !== 'object') return null
    return {
      index: Number.isFinite(Number(element.index)) ? Number(element.index) : null,
      backendNodeId: Number.isFinite(Number(element.backendNodeId)) ? Number(element.backendNodeId) : null,
      selectorIndex: Number.isFinite(Number(element.selectorIndex)) ? Number(element.selectorIndex) : null,
      hasSelector: Boolean(element.selector),
      frameSessionId: element.sessionId == null ? null : String(element.sessionId),
      source: element.source == null ? null : String(element.source),
      tag: element.tag == null ? null : String(element.tag),
      role: element.role == null ? null : String(element.role)
    }
  }

  _logBrowserIndexTrace(phase, entry, params = {}, element = null, extra = {}) {
    try {
      const sessionId = this._sessionIdForEntry(entry)
      const currentToken = this._browserDecisionToken(sessionId)
      const observed = entry?.lastObservationTrace || null
      const mutation = entry?.domMutationTrace || {}
      const currentMutationRevision = Math.max(0, Number(mutation.revision) || 0)
      const observedMutationRevision = Math.max(0, Number(observed?.mutationRevision) || 0)
      const documentState = this._documentStateSnapshot(entry)
      this.log(
        `[browser-index-trace] ${JSON.stringify({
          phase: String(phase || 'unknown'),
          actionId: params?._fanActionTraceId == null ? null : String(params._fanActionTraceId),
          requestedIndex: Number.isFinite(Number(params?.index)) ? Number(params.index) : null,
          tabId: String(entry?.id || ''),
          target: this._browserIndexTraceElement(element),
          observation: observed,
          current: currentToken,
          currentDocument: {
            revision: Number(documentState.revision) || 0,
            frameId: String(documentState.frameId || ''),
            loaderId: String(documentState.loaderId || '')
          },
          domMutations: {
            observedRevision: observedMutationRevision,
            currentRevision: currentMutationRevision,
            sinceObservation: Math.max(0, currentMutationRevision - observedMutationRevision),
            lastMethod: String(mutation.lastMethod || ''),
            lastAt: Number(mutation.lastAt) || 0,
            frameSessionId: mutation.sessionId == null ? null : String(mutation.sessionId)
          },
          ...extra
        })}`
      )
    } catch {
      // Diagnostic logging must never alter click behaviour.
    }
  }

  _viewportFromLayoutMetrics(metrics = {}) {
    const viewport = metrics.layoutViewport || metrics.visualViewport || {}
    const width = Number(viewport.clientWidth ?? viewport.width)
    const height = Number(viewport.clientHeight ?? viewport.height)
    return {
      width: Number.isFinite(width) && width > 0 ? width : 100000,
      height: Number.isFinite(height) && height > 0 ? height : 100000
    }
  }

  _boundsFromQuad(quad) {
    if (!Array.isArray(quad) || quad.length < 8) return null
    const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
    const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
    if (xs.some(value => !Number.isFinite(value)) || ys.some(value => !Number.isFinite(value))) return null
    const left = Math.min(...xs)
    const right = Math.max(...xs)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    // CLK-1:四点质心(对齐 的 sum/4),用作点击落点。轴对齐矩形/平行四边形下
    // 质心== bbox 中心(逐字节同),仅当 content-quad 因 3D/perspective 退化成非中心对称四边形时
    // 才与 bbox 中心分歧——此时质心更稳(bbox 中心可能落在元素外/相邻元素上致遮挡误判)。
    const cx = (xs[0] + xs[1] + xs[2] + xs[3]) / 4
    const cy = (ys[0] + ys[1] + ys[2] + ys[3]) / 4
    return { left, top, right, bottom, width: right - left, height: bottom - top, cx, cy }
  }

  _clickGeometryFromQuads(quads = [], viewport = this._viewportFromLayoutMetrics(), source = 'quad') {
    const candidates = quads
      .map(quad => this._boundsFromQuad(quad))
      .filter(bounds => bounds && bounds.width > 0 && bounds.height > 0)
    if (!candidates.length) return null
    let best = candidates[0]
    let bestArea = -1
    for (const bounds of candidates) {
      const visibleWidth = Math.max(0, Math.min(viewport.width, bounds.right) - Math.max(0, bounds.left))
      const visibleHeight = Math.max(0, Math.min(viewport.height, bounds.bottom) - Math.max(0, bounds.top))
      const visibleArea = visibleWidth * visibleHeight
      if (visibleArea > bestArea) {
        best = bounds
        bestArea = visibleArea
      }
    }
    // CLK-1:落点用四点质心(best.cx/cy),保留 viewport clamp;rect 仍用轴对齐 bbox(截图 clip 用)
    const x = Math.max(0, Math.min(viewport.width - 1, best.cx != null ? best.cx : (best.left + best.right) / 2))
    const y = Math.max(0, Math.min(viewport.height - 1, best.cy != null ? best.cy : (best.top + best.bottom) / 2))
    return {
      x,
      y,
      rect: { left: best.left, top: best.top, width: best.width, height: best.height },
      source
    }
  }

  // CLK-7:统一的点击派发序列。mouseMoved 后等 50ms、mousePressed 后等 80ms
  // default_action_watchdog.py:914/932 的 sleep0.05/0.08),给出真实的 mousedown 持续时间——
  // 个别按 mousedown 时长判 click/长按的控件需要它。抽成 helper 避免三/四处复制漂移(参考
  // INPUT/DD 双路径漂移教训)。
  async _dispatchClickSequence(
    entry,
    x,
    y,
    sessionId,
    decisionGuard = null,
    beforeClick = null,
    expectedInputEvent = false
  ) {
    if (decisionGuard) decisionGuard()
    await this._humanMouseTrajectory(entry, x, y, sessionId, undefined, decisionGuard)
    if (decisionGuard) decisionGuard()
    await entry.client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId)
    await this._sleep(50)
    if (decisionGuard) decisionGuard()
    await this._markActingOn(entry.client, sessionId)
    if (decisionGuard) decisionGuard()
    if (typeof beforeClick === 'function') {
      await beforeClick({ x, y, sessionId })
      if (decisionGuard) decisionGuard()
    }
    await entry.client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    }, sessionId)
    await this._sleep(80)
    // Once mousePressed has been sent, always pair it with mouseReleased. A
    // mousedown handler may itself navigate, and abandoning the release would
    // leave Chromium's input state stuck. The lease is checked immediately
    // before the press, which is the irreversible action boundary.
    await entry.client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
      ...(expectedInputEvent ? { _fanExpectedInputEvent: true } : {})
    }, sessionId)
  }

  // 稳定性沉降:在页面内用 requestAnimationFrame 反复采样目标 bbox,直到连续两帧完全一致(动画已停),
  // 或到 clickStabilityMaxMs 超时。对齐 Playwright 'stable' / Cypress 动画结束检测——避免在动画中(滑入弹窗、
  // 展开菜单)取坐标后元素移位导致点偏。静态元素 ~2 帧即返回(比固定 50ms 死等更快),动画元素才多等。
  // 永不抛错;解析/执行失败 → 直接返回(退回原有时序,不打断点击)。
  async _waitElementStable(entry, backendNodeId, sessionId) {
    const maxMs = Number(this.clickStabilityMaxMs) || 0
    if (maxMs <= 0) return false
    try {
      const r = await this._usingResolvedBackendNode(entry, backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(maxMs) {
          return new Promise((resolve) => {
            const el = this;
            const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const t0 = clock();
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            // 硬超时:不依赖 rAF——后台/隐藏标签会把 rAF 节流甚至暂停,此 setTimeout 保证最迟 maxMs 返回。
            setTimeout(() => finish({ stable: false, waitedMs: clock() - t0, timedOut: true }), maxMs);
            let prev = null;
            const sample = () => {
              if (done) return;
              const rc = el.getBoundingClientRect();
              const cur = rc.left + ',' + rc.top + ',' + rc.width + ',' + rc.height;
              if (prev !== null && cur === prev) { finish({ stable: true, waitedMs: clock() - t0 }); return; }
              prev = cur;
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          }`,
          arguments: [{ value: maxMs }],
          awaitPromise: true,
          returnByValue: true
        }, sessionId).catch(() => null)
      ))
      return Boolean(r?.result?.value?.stable)
    } catch (e) {
      void e
      return false
    }
  }

  async _backendNodeClickGeometry(entry, element = {}, sessionId = undefined) {
    const backendNodeId = Number(element.backendNodeId)
    if (!Number.isFinite(backendNodeId)) return null
    await entry.client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId).catch(() => undefined)
    // 等动画沉降(连续两帧 bbox 一致)再取坐标,取代固定 50ms 死等。
    await this._waitElementStable(entry, backendNodeId, sessionId)
    const metrics = await entry.client.send('Page.getLayoutMetrics', {}, sessionId).catch(() => ({}))
    const viewport = this._viewportFromLayoutMetrics(metrics)
    const contentQuads = await entry.client
      .send('DOM.getContentQuads', { backendNodeId }, sessionId)
      .catch(() => null)
    const contentGeometry = this._clickGeometryFromQuads(contentQuads?.quads || [], viewport, 'contentQuads')
    if (contentGeometry) return contentGeometry
    const boxModel = await entry.client.send('DOM.getBoxModel', { backendNodeId }, sessionId).catch(() => null)
    const contentBox = boxModel?.model?.content
    const boxGeometry = this._clickGeometryFromQuads(contentBox ? [contentBox] : [], viewport, 'boxModel')
    if (boxGeometry) return boxGeometry
    const rectResult = await this._usingResolvedBackendNode(entry, backendNodeId, sessionId, objectId => (
      entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
          let rect = this.getBoundingClientRect();
          // Fix B:元素自身无盒模型(0 尺寸——刚出现/动画中的图标按钮 <button><svg/>、display:contents
          // 包装等)→ 取首个有非零盒的后代(通常是可见的 SVG 图标),用它的几何做【真实坐标点击】,
          // 而不是让上层退化成 isTrusted=false 的 JS .click()(框架按钮如文心一言发送键可能不认 untrusted)。
          if (rect.width <= 0 || rect.height <= 0) {
            const kids = this.querySelectorAll ? this.querySelectorAll('*') : [];
            for (const k of kids) {
              const kr = k.getBoundingClientRect();
              if (kr.width > 0 && kr.height > 0) { rect = kr; break; }
            }
          }
          return { ok: true, x: rect.left, y: rect.top, width: rect.width, height: rect.height };
          }`,
          returnByValue: true
        }, sessionId)
        .catch(() => null)
    )).catch(() => null)
    const rect = rectResult?.result?.value
    if (!rect?.ok) return null
    const left = Number(rect.x)
    const top = Number(rect.y)
    const width = Number(rect.width)
    const height = Number(rect.height)
    if (![left, top, width, height].every(value => Number.isFinite(value)) || width <= 0 || height <= 0) return null
    return this._clickGeometryFromQuads([[left, top, left + width, top, left + width, top + height, left, top + height]], viewport, 'jsRect')
  }

  async _elementScreenshotClip(entry, element = {}, sessionId = undefined) {
    const backendGeometry = await this._backendNodeClickGeometry(entry, element, sessionId).catch(() => null)
    if (backendGeometry?.rect) {
      return {
        clip: {
          x: backendGeometry.rect.left,
          y: backendGeometry.rect.top,
          width: backendGeometry.rect.width,
          height: backendGeometry.rect.height,
          scale: 1
        },
        source: backendGeometry.source
      }
    }

    const selectorResult = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
        if (!el) return { ok: false, error: 'element not found' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          ok: true,
          rect: {
            x: rect.left + (resolved.offsetX || 0),
            y: rect.top + (resolved.offsetY || 0),
            width: rect.width,
            height: rect.height
          }
        };
      })()`,
      returnByValue: true,
      awaitPromise: true
    }, sessionId).catch(() => null)
    const selectorRect = selectorResult?.result?.value?.rect
    const cachedRect = element.rect || {}
    const rect = selectorRect || {
      x: cachedRect.left ?? cachedRect.x,
      y: cachedRect.top ?? cachedRect.y,
      width: cachedRect.width,
      height: cachedRect.height
    }
    const x = Number(rect.x)
    const y = Number(rect.y)
    const width = Number(rect.width)
    const height = Number(rect.height)
    if (![x, y, width, height].every(value => Number.isFinite(value)) || width <= 0 || height <= 0) {
      throw new Error(`Element index ${element.index} is not visible or has no bounding box`)
    }
    return {
      clip: { x, y, width, height, scale: 1 },
      source: selectorRect ? 'selectorRect' : 'cachedRect'
    }
  }

  _resolveElementFunction() {
    return `
      function resolveElementEntry(item) {
        if (!item || !item.selector) return null;
        const path = Array.isArray(item.path) && item.path.length
          ? item.path
          : (item.framePath || []).map(selector => ({ type: 'frame', selector })).concat([{ type: 'css', selector: item.selector }]);
        let root = document;
        let offsetX = 0;
        let offsetY = 0;
        let firstFrame = null;
        const frames = [];
        for (const step of path) {
          if (!step || !step.selector) continue;
          if (step.type === 'shadow') {
            const host = root.querySelector(step.selector);
            if (!host || !host.shadowRoot) return null;
            root = host.shadowRoot;
            continue;
          }
          if (step.type === 'frame') {
            const frame = root.querySelector(step.selector);
            if (!frame) return null;
            if (!firstFrame) firstFrame = frame;
            frames.push(frame);
            const frameRect = frame.getBoundingClientRect();
            // Child-document coordinates start at the iframe content box, not
            // its outer border box. clientLeft/clientTop account for borders.
            offsetX += frameRect.left + Number(frame.clientLeft || 0);
            offsetY += frameRect.top + Number(frame.clientTop || 0);
            root = frame.contentDocument;
            if (!root) return null;
            continue;
          }
          const el = root.querySelector(step.selector);
          return el ? { el, offsetX, offsetY, firstFrame, frames } : null;
        }
        return null;
      }
    `
  }

  _createDownloadWatcher(entry, params = {}) {
    return browserIO.createDownloadWatcher(this, entry, params)
  }

  async _applyClickDownloadMetadata(result, watcher) {
    return browserIO.applyClickDownloadMetadata(result, watcher)
  }

  _isPrintRelatedElement(element = {}) {
    return browserIO.isPrintRelatedElement(element)
  }

  _safeDownloadFilename(value, extension = 'bin', fallback = 'file') {
    return browserIO.safeDownloadFilename(value, extension, fallback)
  }

  _safePdfFilename(value) {
    return this._safeDownloadFilename(value, 'pdf', 'print')
  }

  async _pathExists(filePath) {
    return browserIO.pathExists(filePath)
  }

  async _uniqueDownloadFilePath(fileName, extension = 'pdf', fallback = 'file') {
    return browserIO.uniqueDownloadFilePath(this, fileName, extension, fallback)
  }

  async _uniqueDownloadPath(fileName) {
    return this._uniqueDownloadFilePath(fileName, 'pdf', 'print')
  }

  async _handlePrintButtonClick(entry, element = {}, sessionId = undefined) {
    return browserIO.handlePrintButtonClick(this, entry, element, sessionId)
  }

  _clickValidationError(element = {}) {
    const tag = String(element.tag || '').toLowerCase()
    const type = String(element.type || element.attributes?.type || '').toLowerCase()
    const label = element.index != null
      ? `element index ${element.index}`
      : element.coordinate
        ? `coordinates (${element.coordinate.x}, ${element.coordinate.y})`
        : 'target element'
    if (tag === 'select' || element.capabilities?.selectable) {
      return `Cannot click on <select> elements. Use dropdownOptions/select for ${label}.`
    }
    if (tag === 'input' && (type === 'file' || element.capabilities?.upload)) {
      return `Cannot click on file input ${label}. Use upload for file inputs.`
    }
    return ''
  }

  _normalizedSemanticText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  _disabledElementError(element = {}, reason = 'disabled') {
    const error = new Error(`Element index ${element.index} is disabled or unavailable`)
    error.code = 'ELEMENT_DISABLED'
    error.details = {
      retryable: false,
      action: 'click',
      index: Number(element.index),
      reason: String(reason || 'disabled')
    }
    return error
  }

  _disabledElementInspectionFunction() {
    return `function() {
      if (!this || !this.isConnected) return { ok: false, error: 'element is detached' };
      const classes = String(this.getAttribute && this.getAttribute('class') || '')
        .toLowerCase().split(/\\s+/).filter(Boolean);
      const disabledClasses = new Set([
        'disabled', 'is-disabled', 'is_disabled', 'unavailable',
        'ui-state-disabled', 'ui-datepicker-unselectable',
        'ant-picker-cell-disabled', 'mui-disabled', 'flatpickr-disabled',
        'react-datepicker__day--disabled'
      ]);
      const classDisabled = classes.some(name => disabledClasses.has(name) || /(?:^|[-_])disabled(?:$|[-_])/.test(name));
      const dataDisabled = this.hasAttribute && this.hasAttribute('data-disabled')
        ? String(this.getAttribute('data-disabled') || '').toLowerCase()
        : null;
      const nativeDisabled = Boolean(this.disabled || (this.matches && this.matches(':disabled')));
      const ariaDisabled = String(this.getAttribute && this.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
      const dataStateDisabled = dataDisabled === '' || dataDisabled === 'true';
      const fieldsetDisabled = Boolean(this.closest && this.closest('fieldset[disabled]'));
      const inert = Boolean((this.hasAttribute && this.hasAttribute('inert')) || (this.closest && this.closest('[inert]')));
      const disabled = nativeDisabled || ariaDisabled || dataStateDisabled || fieldsetDisabled || inert || classDisabled;
      let reason = '';
      if (nativeDisabled) reason = 'native-disabled';
      else if (ariaDisabled) reason = 'aria-disabled';
      else if (dataStateDisabled) reason = 'data-disabled';
      else if (fieldsetDisabled) reason = 'disabled-fieldset';
      else if (inert) reason = 'inert';
      else if (classDisabled) reason = classes.filter(name => disabledClasses.has(name) || /(?:^|[-_])disabled(?:$|[-_])/.test(name)).join(' ');
      return { ok: true, disabled, reason, className: classes.join(' ') };
    }`
  }

  async _inspectLiveDisabledState(entry, element = {}, sessionId = undefined) {
    let result = null
    if (element.backendNodeId) {
      result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: this._disabledElementInspectionFunction(),
          returnByValue: true
        }, sessionId)
      ))
    } else if (element.selector) {
      result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          return (${this._disabledElementInspectionFunction()}).call(el);
        })()`,
        returnByValue: true
      }, sessionId)
    }
    const value = result?.result?.value
    return value?.ok ? value : null
  }

  _elementSemantics(element = {}) {
    const attributes = element.attributes || {}
    return {
      role: String(element.role || attributes.role || ''),
      name: String(attributes['aria-label'] || attributes.name || attributes.title || element.text || ''),
      text: String(element.text || attributes['aria-label'] || attributes.title || ''),
      tag: String(element.tag || ''),
      label: String(attributes['aria-label'] || attributes.placeholder || attributes.name || element.text || '')
    }
  }

  _assertExpectedElement(element = {}, expected = {}, action = 'browser action') {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return
    const actual = this._elementSemantics(element)
    const mismatches = []
    for (const key of ['role', 'name', 'text', 'tag', 'label']) {
      if (expected[key] == null || String(expected[key]).trim() === '') continue
      const want = this._normalizedSemanticText(expected[key])
      const got = this._normalizedSemanticText(actual[key])
      const matches = key === 'text' || key === 'label' ? got.includes(want) : got === want
      if (!matches) mismatches.push(key)
    }
    if (!mismatches.length) return
    const error = new Error(
      `Refusing to ${action}: target semantics changed (${mismatches.join(', ')}). Observe again before acting.`
    )
    error.code = 'CLICK_TARGET_MISMATCH'
    error.details = {
      retryable: true,
      replanRequired: true,
      action,
      reason: mismatches.join(','),
      expected,
      actual,
      index: element.index
    }
    throw error
  }

  _issueVisualEvidence(entry) {
    const sessionId = this._sessionIdForEntry(entry)
    const decision = this._browserDecisionToken(sessionId)
    const token = crypto.randomBytes(18).toString('base64url')
    this._visualEvidence.set(token, {
      sessionId,
      activeTabId: decision?.activeTabId || entry.id,
      viewEpoch: decision?.viewEpoch ?? Math.max(0, Number(entry.viewEpoch) || 0),
      documentRevision: decision?.documentRevision ?? this._documentStateSnapshot(entry).revision,
      pageGeneration: decision?.pageGeneration ?? 0,
      selectorGeneration: decision?.selectorGeneration ?? 0,
      createdAt: Date.now()
    })
    while (this._visualEvidence.size > 128) {
      this._visualEvidence.delete(this._visualEvidence.keys().next().value)
    }
    return token
  }

  _assertVisualEvidence(entry, params = {}) {
    const token = String(params.visualEvidenceToken || params.visual_evidence_token || '')
    const evidence = this._visualEvidence.get(token)
    const current = this._browserDecisionToken(this._sessionIdForEntry(entry))
    const valid = Boolean(
      token && evidence && current &&
      Date.now() - evidence.createdAt <= VISUAL_EVIDENCE_TTL_MS &&
      evidence.sessionId === current.sessionId &&
      evidence.activeTabId === current.activeTabId &&
      evidence.viewEpoch === current.viewEpoch &&
      evidence.documentRevision === current.documentRevision &&
      evidence.pageGeneration === current.pageGeneration &&
      evidence.selectorGeneration === current.selectorGeneration
    )
    if (valid) {
      this._visualEvidence.delete(token)
      return evidence
    }
    if (token && evidence) this._visualEvidence.delete(token)
    const error = new Error('Coordinate click requires a screenshot from the current page generation.')
    error.code = 'VISUAL_EVIDENCE_REQUIRED'
    error.details = {
      retryable: true,
      replanRequired: true,
      reason: token ? 'visual-evidence-stale' : 'visual-evidence-missing'
    }
    throw error
  }

  _isToggleElement(element = {}) {
    const tag = String(element.tag || '').toLowerCase()
    const type = String(element.type || element.attributes?.type || '').toLowerCase()
    return tag === 'input' && (type === 'checkbox' || type === 'radio')
  }

  async _readToggleState(entry, element = {}, sessionId = undefined) {
    if (!this._isToggleElement(element)) return null
    if (element.backendNodeId) {
      const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { return { ok: true, checked: Boolean(this.checked) }; }',
          returnByValue: true
        }, sessionId)
      ))
      const value = result?.result?.value
      return value?.ok ? { checked: Boolean(value.checked) } : null
    }
    if (element.selector) {
      const result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          // fan-toggle-state
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false };
          return { ok: true, checked: Boolean(el.checked) };
        })()`,
        returnByValue: true
      }, sessionId)
      const value = result?.result?.value
      return value?.ok ? { checked: Boolean(value.checked), objectId: null } : null
    }
    return null
  }

  async _fallbackToggleClick(entry, element = {}, sessionId = undefined) {
    if (element.backendNodeId) {
      const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.click(); return { ok: true, checked: Boolean(this.checked) }; }',
          returnByValue: true,
          _fanExpectedInputEvent: true
        }, sessionId)
      ))
      const value = result?.result?.value
      return value?.ok ? { checked: Boolean(value.checked), fallback: true } : null
    }
    if (element.selector) {
      const result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          // fan-toggle-fallback-click
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false };
          el.click();
          return { ok: true, checked: Boolean(el.checked) };
        })()`,
        returnByValue: true,
        _fanExpectedInputEvent: true
      }, sessionId)
      const value = result?.result?.value
      return value?.ok ? { checked: Boolean(value.checked), fallback: true } : null
    }
    return null
  }

  async _fallbackElementClick(entry, element = {}, sessionId = undefined, reason = 'fallback', traceParams = {}) {
    const metadata = { fallbackClick: true, fallbackReason: reason }
    if (element.backendNodeId) {
      let result
      try {
        result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
          entry.client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function() {
            if (!this.isConnected) return { ok: false, error: 'element is detached' };
            this.click();
            const attrs = {};
            for (const attr of Array.from(this.attributes || [])) attrs[attr.name] = attr.value;
            return {
              ok: true,
              tag: this.tagName ? this.tagName.toLowerCase() : '',
              text: String(this.innerText || this.textContent || attrs['aria-label'] || attrs.title || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
            };
            }`,
            returnByValue: true,
            ...(this._isToggleElement(element) ? { _fanExpectedInputEvent: true } : {})
          }, sessionId)
        ))
      } catch (error) {
        this._logBrowserIndexTrace(
          'fallback-resolve-failed',
          entry,
          traceParams,
          element,
          { fallbackReason: String(reason || ''), ...this._browserIndexTraceError(error) }
        )
        throw error
      }
      if (!result) {
        throw this._staleElementError(
          element.index,
          'Failed to resolve element for JavaScript click fallback',
          'click'
        )
      }
      const value = result?.result?.value
      if (!value?.ok) {
        const message = value?.error || 'JavaScript click fallback failed'
        if (this._elementFailureLooksStale(message)) {
          throw this._staleElementError(element.index, message, 'click')
        }
        throw new Error(message)
      }
      return { ...metadata, tag: value.tag || '', text: value.text || '' }
    }
    if (element.selector) {
      const result = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          // fan-click-fallback
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          if (!el.isConnected) return { ok: false, error: 'element is detached' };
          el.click();
          const attrs = {};
          for (const attr of Array.from(el.attributes || [])) attrs[attr.name] = attr.value;
          return {
            ok: true,
            tag: el.tagName ? el.tagName.toLowerCase() : '',
            text: String(el.innerText || el.textContent || attrs['aria-label'] || attrs.title || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
          };
        })()`,
        returnByValue: true,
        ...(this._isToggleElement(element) ? { _fanExpectedInputEvent: true } : {})
      }, sessionId)
      const value = result?.result?.value
      if (!value?.ok) {
        const message = value?.error || 'JavaScript click fallback failed'
        if (this._elementFailureLooksStale(message)) {
          throw this._staleElementError(element.index, message, 'click')
        }
        throw new Error(message)
      }
      return { ...metadata, tag: value.tag || '', text: value.text || '' }
    }
    throw new Error('No resolvable element for JavaScript click fallback')
  }

  async _verifyToggleClick(entry, element = {}, sessionId = undefined, before = null) {
    if (!before || typeof before.checked !== 'boolean') return null
    await this._sleep(50)
    const after = await this._readToggleState(entry, element, sessionId).catch(() => null)
    if (!after) return null
    if (after.checked !== before.checked) return { checked: after.checked, toggleFallback: false }
    const fallback = await this._fallbackToggleClick(entry, element, sessionId).catch(() => null)
    if (fallback) return { checked: fallback.checked, toggleFallback: true }
    return { checked: after.checked, toggleFallback: false }
  }

  // CLK-4:模型(qwen3-vl)输出的坐标是【0-1000 归一化】(WebSearch+真机实测确认:目标归一化 772 对应
  // CSS 970)。换算成 CSS 视口像素 = 归一化/1000 × 视口宽/高,再喂 Input.dispatchMouseEvent(它要 CSS-px)。
  // 只对【模型给的坐标】(工具层打 normalized 标志)换算;内部 CSS-px 调用(如 SCROLL-09 的 _mouseScroll、
  // drag→mouse)不带标志、不换算,避免反而搞错。zoom<1 时视口被放大(innerWidth>面板宽),换算自动跟随。
  async _normalizedToCssPx(entry, x, y, sessionId = undefined) {
    const r = await entry.client.send('Runtime.evaluate', {
      expression: '({w: window.innerWidth || document.documentElement.clientWidth || 0, h: window.innerHeight || document.documentElement.clientHeight || 0})',
      returnByValue: true
    }, sessionId).catch(() => null)
    const vw = Number(r?.result?.value?.w) || 0
    const vh = Number(r?.result?.value?.h) || 0
    if (!(vw > 0) || !(vh > 0)) return { x: Number(x), y: Number(y) }  // 读不到视口就原样(保守不放大错误)
    return { x: (Number(x) / 1000) * vw, y: (Number(y) / 1000) * vh }
  }

  _isNormalizedCoordinate(params = {}) {
    return params.normalized === true || params.coordinatesNormalized === true || params.coordinates_normalized === true
  }

  _coordinateFromParams(params = {}) {
    const rawX = params.coordinateX ?? params.coordinate_x ?? params.x
    const rawY = params.coordinateY ?? params.coordinate_y ?? params.y
    if (rawX == null || rawY == null) return null
    const x = Number(rawX)
    const y = Number(rawY)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('coordinate_x and coordinate_y must be finite numbers')
    return { x: Math.max(0, x), y: Math.max(0, y) }
  }

  async _elementAtCoordinate(entry, x, y, sessionId = undefined) {
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const x = ${JSON.stringify(x)};
        const y = ${JSON.stringify(y)};
        const el = document.elementFromPoint(x, y);
        if (!el) return { ok: false, error: 'No element found at coordinates' };
        const attrs = {};
        for (const attr of Array.from(el.attributes || [])) attrs[attr.name] = attr.value;
        const rect = el.getBoundingClientRect();
        const tag = el.tagName ? el.tagName.toLowerCase() : '';
        const type = String(attrs.type || '').toLowerCase();
        return {
          ok: true,
          tag,
          type,
          text: String(el.innerText || el.textContent || attrs['aria-label'] || attrs.title || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          attributes: attrs,
          capabilities: {
            selectable: tag === 'select',
            upload: tag === 'input' && type === 'file'
          },
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          coordinate: { x, y }
        };
      })()`,
      returnByValue: true
    }, sessionId)
    const value = result?.result?.value
    if (!value?.ok) return null
    return value
  }

  async _clickCoordinate(entry, params = {}, coordinate) {
    const { x, y } = coordinate
    const sessionId = params.sessionId || params.session_id
    const force = params.force !== false
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'click', x, y, coordinate: true, force })
    try {
      let pointElement = null
      if (!force) {
        pointElement = await this._elementAtCoordinate(entry, x, y, sessionId)
        this._assertEntryDecisionToken(entry, params, 'click')
        if (pointElement) {
          const validationError = this._clickValidationError(pointElement)
          if (validationError) throw new Error(validationError)
          const printMetadata = await this._handlePrintButtonClick(entry, pointElement, sessionId)
          if (printMetadata?.pdfGenerated) {
            const result = {
              clickedCoordinate: true,
              x,
              y,
              force,
              text: pointElement.text || '',
              tag: pointElement.tag || '',
              ...printMetadata
            }
            this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
            return result
          }
        }
      }
      await this._cursorTo(entry, x, y, sessionId, { click: true, w: Number(pointElement?.rect?.width || 0), h: Number(pointElement?.rect?.height || 0) })
      const downloadWatcher = this._createDownloadWatcher(entry, params)
      try {
        const decisionGuard = this._entryActionLease(entry, params, 'click')
        decisionGuard()
        await this._dispatchClickSequence(
          entry,
          x,
          y,
          sessionId,
          decisionGuard,
          null,
          this._isToggleElement(pointElement)
        )
      } catch (error) {
        downloadWatcher.dispose()
        throw error
      }
      entry.selectorMap.clear('click-coordinate')
      let result = {
        clickedCoordinate: true,
        x,
        y,
        force,
        tag: pointElement?.tag || '',
        text: pointElement?.text || ''
      }
      await this._applyClickDownloadMetadata(result, downloadWatcher)
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
      return result
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'click', error: error.message, x, y, coordinate: true })
      throw error
    }
  }

  async click(id, params = {}) {
    const result = await this._clickAction(id, params)
    // If the click navigated, wait for the new page to settle BEFORE returning,
    // so the caller's follow-up observe() reflects the page the click produced.
    // No-op (cheap) when nothing navigated, and never lets settling turn a
    // successful click into a failure.
    if (this.postClickSettle) {
      await this._settleAfterClick(this.getWorkbench(id), params).catch(() => undefined)
    }
    return result
  }

  // The page-change signal is authoritative and free: the watchdog clears the
  // selector map with a PAGE_CHANGED reason the instant a main-frame navigation
  // starts (full-page link, same-workbench popup redirect, or in-page SPA
  // route). The JS that triggers it (window.open / pushState) runs async after
  // the synthetic mouseup, so poll a short bounded window for it and bail the
  // moment it fires; then let the page settle.
  async _settleAfterClick(entry, params = {}) {
    if (!entry) return
    try {
      const sessionId = this._sessionIdForEntry(entry)
      const initialActiveTabId = entry.id
      const startedAt = Date.now()
      const dialogPending = candidate => Boolean(candidate?.pendingDialog)
      const navigated = () =>
        entry.selectorMap &&
        entry.selectorMap.size === 0 &&
        PAGE_CHANGED_CLEAR_REASONS.has(entry.selectorMap.reason)
      const activeChanged = () => this._activeTabId(sessionId) !== initialActiveTabId
      const tabOpenRequested = () => {
        const pending = this._contextForSession(sessionId).pendingTabOpen
        if (!pending) return false
        const requestedAt = Number(pending.requestedAt) || 0
        const fresh = Date.now() - requestedAt <= this.postClickTabProbeMs + this.postClickNavProbeMs
        const sameSource = !pending.sourceTabId || pending.sourceTabId === initialActiveTabId
        return fresh && sameSource
      }
      if (dialogPending(entry)) return
      let sawTabOpen = tabOpenRequested()
      while (!navigated() && !activeChanged() && !dialogPending(entry)) {
        if (tabOpenRequested()) sawTabOpen = true
        const budget = sawTabOpen ? this.postClickTabProbeMs : this.postClickNavProbeMs
        if (Date.now() - startedAt >= budget) break
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      if (dialogPending(entry)) return
      if (activeChanged()) {
        const activeEntry = this.workbenches.get(this._activeTabId(sessionId))
        if (dialogPending(activeEntry)) return
        if (activeEntry) await this._waitForLoad(activeEntry, { waitUntil: 'settle', ...params })
        return
      }
      if (!navigated()) return
      // In-page nav keeps isLoading() false; settle's readyState/network-idle
      // check returns fast there. Full-page nav waits for the load gate.
      await this._waitForLoad(entry, { waitUntil: 'settle', ...params })
    } catch {
      // Best-effort: a settling hiccup must never fail an otherwise-good click.
    }
  }

  // Per-click hit-test:验证点击坐标 (x,y) 上最顶层的元素就是目标(或其后代/祖先/关联 label/shadow host)。
  // 对齐 _check_element_occlusion(default_action_watchdog.py:573):observe 之后才冒出的弹层/
  // cookie 横幅会盖住目标坐标,真鼠标事件会打到遮挡物上;此校验在派发前发现遮挡,让调用方降级 JS .click()
  // 直接点真元素。主路径元素无 selector、只有 backendNodeId,故用 DOM.resolveNode 解析(区别于 Path B 的页面内 index map)。
  // 返回 { occluded, hitTag } 或 null。【失败语义保守偏不打断】:解析/执行失败 → null;elementFromPoint 命中
  // 不到任何元素 → 不判遮挡(occluded:false)。只在【确认命中了别的元素】时才 occluded:true,避免 hit-test
  // 自身的不确定性废掉一次本来好的真坐标点击。
  async _hitTestBackendNode(entry, element, x, y, sessionId) {
    const backendNodeId = Number(element?.backendNodeId)
    if (!Number.isFinite(backendNodeId)) return null
    try {
      const r = await this._usingResolvedBackendNode(entry, backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(px, py) {
          const root = this.getRootNode && this.getRootNode();
          const shadowHost = root && root.host;
          let hit = document.elementFromPoint(px, py);
          if (!hit) return { occluded: false, hitTag: '' };
          let preciseShadowHit = false;
          // document.elementFromPoint retargets a hit inside shadow DOM to its
          // host. That is insufficient for an atomic submit: a sibling overlay
          // inside the same (including closed) shadow root could receive the
          // physical click. Since this function executes with the real target as
          // this, getRootNode() exposes that exact root even when it is closed.
          if (root && root !== document) {
            if (typeof root.elementFromPoint !== 'function') {
              return { occluded: false, hitTag: '', indeterminate: true };
            }
            const innerHit = root.elementFromPoint(px, py);
            if (!innerHit) return { occluded: false, hitTag: '', indeterminate: true };
            hit = innerHit;
            preciseShadowHit = true;
          }
          // Descend through any additional *open* nested shadow roots. Closed
          // roots containing the target were already handled by getRootNode().
          while (hit && hit.shadowRoot && typeof hit.shadowRoot.elementFromPoint === 'function') {
            const innerHit = hit.shadowRoot.elementFromPoint(px, py);
            if (!innerHit || innerHit === hit) break;
            hit = innerHit;
          }
          let labelOk = false;
          try {
            const label = hit.closest ? hit.closest('label') : null;
            if (label && (label.control === this ||
                (label.getAttribute && label.getAttribute('for') && this.id && label.getAttribute('for') === this.id) ||
                (label.contains && label.contains(this)))) labelOk = true;
            if (this.tagName && this.tagName.toLowerCase() === 'label' &&
                (this.control === hit || (this.getAttribute && this.getAttribute('for') && hit.id && this.getAttribute('for') === hit.id))) labelOk = true;
          } catch (e) { void e; }
          const hostFallbackOk = !preciseShadowHit &&
            (hit === shadowHost || (shadowHost && shadowHost.contains(hit)));
          const ok = hit === this || this.contains(hit) || hit.contains(this) || hostFallbackOk || labelOk;
          return { occluded: !ok, hitTag: hit.tagName ? hit.tagName.toLowerCase() : '' };
          }`,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true
        }, sessionId).catch(() => null)
      ))
      const val = r?.result?.value
      if (!val || typeof val.occluded !== 'boolean') return null
      return val
    } catch (e) {
      void e
      return null
    }
  }

  async _clickAction(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    const mappedElement = typeof entry.selectorMap?.get === 'function' ? entry.selectorMap.get(params.index) : null
    this._logBrowserIndexTrace('click-start', entry, params, mappedElement)
    if (params._fanDecisionToken) {
      this._assertDecisionToken(this._sessionIdForEntry(entry), params, 'click')
    }
    let coordinate = this._coordinateFromParams(params)
    if (coordinate && this._isNormalizedCoordinate(params)) {
      this._assertVisualEvidence(entry, params)
    }
    if (coordinate && this._isNormalizedCoordinate(params)) {
      // 坐标点击是主视口相对(模型看的是主页面截图)→ 主帧读视口,CDP sessionId 用 undefined
      coordinate = await this._normalizedToCssPx(entry, coordinate.x, coordinate.y, undefined)
    }
    if (params.index == null && coordinate) {
      return this._clickCoordinate(entry, params, coordinate)
    }
    let element
    try {
      element = await this._elementForAction(entry, params.index, params._fanDecisionToken, 'click')
    } catch (error) {
      this._logBrowserIndexTrace(
        'target-resolve-failed',
        entry,
        params,
        typeof entry.selectorMap?.get === 'function' ? entry.selectorMap.get(params.index) : null,
        this._browserIndexTraceError(error)
      )
      throw error
    }
    this._logBrowserIndexTrace('target-resolved', entry, params, element)
    this._assertExpectedElement(element, params.expected, 'click')
    const sessionId = element.sessionId
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'click', index: element.index })
    try {
      const validationError = this._clickValidationError(element)
      if (validationError) {
        throw new Error(validationError)
      }
      const liveDisabled = await this._inspectLiveDisabledState(entry, element, sessionId).catch(() => null)
      if (liveDisabled?.disabled) {
        throw this._disabledElementError(element, liveDisabled.reason)
      }
      this._assertEntryDecisionToken(entry, params, 'click')
      const printMetadata = await this._handlePrintButtonClick(entry, element, sessionId)
      if (printMetadata?.pdfGenerated) {
        const result = {
          clicked: element.index,
          text: element.text || '',
          source: element.source || '',
          ...printMetadata
        }
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
        return result
      }
      const toggleBefore = await this._readToggleState(entry, element, sessionId).catch(() => null)
      return await this._clickResolvedElement(entry, element, sessionId, params, toggleBefore)
    } catch (error) {
      this._logBrowserIndexTrace('click-failed', entry, params, element, this._browserIndexTraceError(error))
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'click', error: error.message })
      throw error
    }
  }

  // ── 统一点击执行(收口 Path A/B 双路径)───────────────────────────────────────
  // 历史上 _clickAction 按「元素有没有 selector」分两条几乎平行的点击实现:backendNodeId 路与
  // 页面内 selector 路。两条各自维护 hit-test / 遮挡降级 / 真鼠标派发 / 结果组装,极易改一条忘
  // 另一条(同 INPUT/DD 双路径漂移教训)。现收口为【单一控制流】:解析几何+初始遮挡(按元素
  // 类型分流到两个 resolver)→ 统一的遮挡短重试 → 统一的派发/兜底/结果。两个 resolver 只是
  // 【数据决定】的前端(有 backendNodeId 走 CDP 解析,只有 selector 走页面内 map),其后逻辑此一份。
  async _clickResolvedElement(entry, element, sessionId, params, toggleBefore) {
    const geo = await this._resolveClickGeometry(entry, element, sessionId, params)
    this._assertEntryDecisionToken(entry, params, 'click')
    if (!geo) {
      if (params?._fanFailClosedClick === true) {
        throw this._failClosedClickError(element, 'no-geometry')
      }
      // 无任何可用布局几何(0 尺寸包装元素 / display:contents 等):退化 JS .click()——直接在真
      // 节点派发 click,监听器照样触发(对齐 优雅降级,而不是让整个动作 500)。
      return this._finalizeClickFallback(entry, element, sessionId, params, toggleBefore, 'no-geometry', {})
    }
    const { x, y } = geo
    if (params?._fanFailClosedClick === true || params.allowOccluded !== true) {
      // 派发前 per-click hit-test + 遮挡短重试(#2):observe 之后才冒出的弹层/cookie 横幅会盖住目标
      // 坐标,真鼠标会打到遮挡物。瞬态遮挡(spinner/淡出层)会在此窗口消失,清了就用真点击;持续
      // 遮挡才降级 JS。元素已被稳定性检测保证不动,故重试只复测 hit-test、不重算几何。
      let occ = geo.occluded ? { occluded: true, hitTag: geo.hitTag } : { occluded: false }
      for (let i = 0; occ && occ.occluded && i < this.clickActionableRetries; i++) {
        await this._sleep(this.clickActionableRetryMs)
        occ = await this._recheckOcclusion(entry, element, x, y, sessionId, geo.strategy)
      }
      if (occ && occ.occluded) {
        this._assertEntryDecisionToken(entry, params, 'click')
        if (params?._fanFailClosedClick === true) {
          throw this._failClosedClickError(element, 'occluded')
        }
        return this._finalizeClickFallback(entry, element, sessionId, params, toggleBefore, 'occluded',
          { x, y, occluded: true, hitTag: occ.hitTag || '', ...(geo.source ? { clickPointSource: geo.source } : {}) })
      }
    }
    this._assertEntryDecisionToken(entry, params, 'click')
    return this._finalizeClickDispatch(entry, element, sessionId, params, toggleBefore, x, y, geo)
  }

  // 解析点击几何 + 初始遮挡。返回 { x, y, rect, source, strategy, occluded, hitTag };
  // 返回 null 表示「无几何 → 上层退化 JS click」;selector 元素无法解析(页面已变)→ 抛 stale 错。
  async _resolveClickGeometry(entry, element, sessionId, params = {}) {
    if (!element.selector && element.backendNodeId) {
      // 策略 A:backendNodeId → DOM.scrollIntoViewIfNeeded + 稳定性沉降 + content-quad 质心(均在 helper 内)。
      const geometry = await this._backendNodeClickGeometry(entry, element, sessionId).catch(error => {
        this._logBrowserIndexTrace(
          'geometry-resolve-failed',
          entry,
          params,
          element,
          this._browserIndexTraceError(error)
        )
        return null
      })
      if (!geometry?.rect) return null
      const rect = geometry.rect
      const x = geometry.x
      const y = geometry.y
      const occ = await this._hitTestBackendNode(entry, element, x, y, sessionId)
      return { x, y, rect, source: geometry?.source, strategy: 'backend', occluded: !!(occ && occ.occluded), hitTag: occ?.hitTag || '' }
    }
    if (!element.selector) {
      throw this._staleElementError(
        element.index,
        `Element index ${element.index} is stale: it has neither a resolvable BackendNodeId nor a selector. ` +
        'Observe again and use a fresh element index.',
        'click'
      )
    }
    // 策略 B:页面内 selector map 解析。一次 evaluate 完成 scrollIntoViewIfNeeded + 稳定性沉降 +
    // getClientRects 可见面积最大质心 + elementFromPoint hit-test。
    const pf = await this._selectorClickPreflight(entry, element, sessionId)
    if (!pf || pf.notFound) {
      // 页面内 map 已无该号(SPA 重渲染 / 元素移除)——元素确实不在了,JS 兜底也无从下手。给模型
      // 一个清晰可操作的 stale 错(对齐 _elementForAction 语义),而不是含糊的 'element not found'。
      throw this._staleElementError(
        element.index,
        `Element index ${element.index} is stale: it could not be resolved on the current page. ` +
        `Observe again and use fresh element indices.`,
        'click'
      )
    }
    if (pf.noGeometry) return null
    return {
      x: Math.max(0, Number(pf.x || 0)),
      y: Math.max(0, Number(pf.y || 0)),
      rect: pf.rect || null,
      source: undefined,
      strategy: 'selector',
      occluded: !!pf.occluded,
      hitTag: pf.hitTag || ''
    }
  }

  // 复测遮挡(重试用),按解析策略分流。返回 { occluded, hitTag } 或 null(无法判定 → 保守视作不遮挡)。
  async _recheckOcclusion(entry, element, x, y, sessionId, strategy) {
    if (strategy === 'backend') return this._hitTestBackendNode(entry, element, x, y, sessionId)
    return this._selectorHitTest(entry, element, x, y, sessionId)
  }

  // selector 元素的页面内 hit-test:resolveElementEntry 解析后 elementFromPoint(x,y) 校验点击点
  // 归属目标/后代/shadowHost/关联 label(与 _hitTestBackendNode 同语义,仅解析方式不同)。
  async _selectorHitTest(entry, element, x, y, sessionId) {
    try {
      const r = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          if (!resolved) return null;
          const { el, firstFrame } = resolved;
          const hit = document.elementFromPoint(${JSON.stringify(Number(x))}, ${JSON.stringify(Number(y))});
          if (!hit) return { occluded: false, hitTag: '' };
          const root = el.getRootNode && el.getRootNode();
          const shadowHost = root && root.host;
          let labelOk = false;
          try {
            const label = hit.closest ? hit.closest('label') : null;
            if (label && (label.control === el ||
                (label.getAttribute && label.getAttribute('for') && el.id && label.getAttribute('for') === el.id) ||
                (label.contains && label.contains(el)))) labelOk = true;
            if (el.tagName && el.tagName.toLowerCase() === 'label' &&
                (el.control === hit || (el.getAttribute && el.getAttribute('for') && hit.id && el.getAttribute('for') === hit.id))) labelOk = true;
          } catch (e) { void e; }
          const hitOk = firstFrame
            ? (hit === firstFrame || firstFrame.contains(hit))
            : (hit === el || el.contains(hit) || hit === shadowHost || (shadowHost && shadowHost.contains(hit)) || labelOk);
          return { occluded: !hitOk, hitTag: hit.tagName ? hit.tagName.toLowerCase() : '' };
        })()`,
        returnByValue: true
      }, sessionId).catch(() => null)
      const val = r?.result?.value
      if (!val || typeof val.occluded !== 'boolean') return null
      return val
    } catch (e) {
      void e
      return null
    }
  }

  // selector 元素的几何+遮挡解析(策略 B 前端)。一次 evaluate 内:解析 → scrollIntoViewIfNeeded →
  // 稳定性沉降(rAF 连续两帧 bbox 一致 / setTimeout 硬超时,对齐 _waitElementStable)→ getClientRects
  // 可见面积最大质心 → elementFromPoint hit-test。返回 { notFound } | { noGeometry } | { occluded, hitTag, rect, x, y }。
  async _selectorClickPreflight(entry, element, sessionId) {
    const maxMs = Number(this.clickStabilityMaxMs) || 0
    const r = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        const resolved = resolveElementEntry(item);
        if (!resolved) return Promise.resolve({ notFound: true });
        const { el, firstFrame, frames = [] } = resolved;
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        // A child element can scroll inside its own document while the iframe
        // itself remains outside an ancestor viewport. Bring every frame owner
        // into view from outermost to innermost before resolving the final point.
        for (const frame of frames) {
          const view = frame.ownerDocument && frame.ownerDocument.defaultView;
          const fr = frame.getBoundingClientRect();
          const fw = view && (view.innerWidth || frame.ownerDocument.documentElement.clientWidth);
          const fh = view && (view.innerHeight || frame.ownerDocument.documentElement.clientHeight);
          if (fr.top < 0 || fr.left < 0 || (fh && fr.bottom > fh) || (fw && fr.right > fw)) {
            frame.scrollIntoView({ block: 'center', inline: 'center' });
          }
        }
        // CLK-11:仅当元素未完整落在视口内才滚(对齐 scrollIntoViewIfNeeded),避免无谓视口跳动。
        const r0 = el.getBoundingClientRect();
        const elementView = el.ownerDocument && el.ownerDocument.defaultView;
        const elementVw = elementView && (elementView.innerWidth || el.ownerDocument.documentElement.clientWidth);
        const elementVh = elementView && (elementView.innerHeight || el.ownerDocument.documentElement.clientHeight);
        if (r0.top < 0 || r0.left < 0 || (elementVh && r0.bottom > elementVh) || (elementVw && r0.right > elementVw)) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
        }
        const MAXMS = ${maxMs};
        const settle = () => new Promise((res) => {
          if (MAXMS <= 0) return res();
          let done = false; const fin = () => { if (!done) { done = true; res(); } };
          // 硬超时:不依赖 rAF——后台/隐藏标签会节流 rAF,setTimeout 保证最迟 MAXMS 返回。
          setTimeout(fin, MAXMS);
          let prev = null;
          const sample = () => {
            if (done) return;
            const rc = el.getBoundingClientRect();
            const cur = rc.left + ',' + rc.top + ',' + rc.width + ',' + rc.height;
            if (prev !== null && cur === prev) return fin();
            prev = cur; requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        return settle().then(() => {
          // G2:用 getClientRects 挑「可见面积最大」rect 取中心(对齐 Path A / quad 质心),
          // 而非整体 bbox 中心——inline/换行/wrap 元素 bbox 中心可能落在行间空隙、命中相邻元素。
          let rect = el.getBoundingClientRect();
          const rects = (el.getClientRects && el.getClientRects().length) ? Array.from(el.getClientRects()) : [rect];
          let best = null, bestArea = -1;
          for (const rc of rects) {
            if (rc.width <= 0 || rc.height <= 0) continue;
            const viw = Math.max(0, Math.min(vw, rc.right) - Math.max(0, rc.left));
            const vih = Math.max(0, Math.min(vh, rc.bottom) - Math.max(0, rc.top));
            const area = viw * vih;
            if (area > bestArea) { bestArea = area; best = rc; }
          }
          if (best) rect = best;
          if (!rect || rect.width <= 0 || rect.height <= 0) return { noGeometry: true };
          let offsetX = 0, offsetY = 0;
          for (const frame of frames) {
            const frameRect = frame.getBoundingClientRect();
            offsetX += frameRect.left + Number(frame.clientLeft || 0);
            offsetY += frameRect.top + Number(frame.clientTop || 0);
          }
          const left = rect.left + offsetX;
          const top = rect.top + offsetY;
          const x = Math.max(0, Math.min(vw - 1, left + rect.width / 2));
          const y = Math.max(0, Math.min(vh - 1, top + rect.height / 2));
          const hit = document.elementFromPoint(x, y);
          const root = el.getRootNode && el.getRootNode();
          const shadowHost = root && root.host;
          // 命中目标关联的 <label> 视为合法(对齐 三 case):点被关联 label 覆盖的
          // checkbox/radio 时 elementFromPoint 命中 label 而非控件,不应判遮挡而降级。
          const labelAssociated = (() => {
            if (!hit) return false;
            const label = hit.closest ? hit.closest('label')
              : (hit.tagName && hit.tagName.toLowerCase() === 'label' ? hit : null);
            if (label) {
              if (label.control === el) return true;
              const forId = label.getAttribute && label.getAttribute('for');
              if (forId && el.id && forId === el.id) return true;
              if (label.contains && label.contains(el)) return true;
            }
            if (el.tagName && el.tagName.toLowerCase() === 'label') {
              if (el.control === hit) return true;
              const forId2 = el.getAttribute && el.getAttribute('for');
              if (forId2 && hit.id && forId2 === hit.id) return true;
            }
            return false;
          })();
          // hit 为 null(该点无任何元素,罕见)→ 保守视作不遮挡,与 _hitTestBackendNode / _selectorHitTest 一致,
          // 不因不确定就降级 JS。
          const hitOk = !hit ? true : (firstFrame
            ? (hit === firstFrame || firstFrame.contains(hit))
            : (hit === el || el.contains(hit) || hit === shadowHost || (shadowHost && shadowHost.contains(hit)) || labelAssociated));
          return {
            occluded: !hitOk,
            hitTag: hit ? hit.tagName.toLowerCase() : '',
            rect: { left, top, width: rect.width, height: rect.height },
            x,
            y
          };
        });
      })()`,
      returnByValue: true,
      awaitPromise: true
    }, sessionId).catch(() => null)
    // 导航/上下文销毁等让 evaluate 抛原始 CDP 错时,落回 null → 上层 _resolveClickGeometry 抛干净的
    // stale 错(对齐 backend 路径的 .catch(()=>null) 优雅降级,而不是把 'Cannot find context' 透给模型)。
    return r?.result?.value || null
  }

  // 统一结果组装。selector/source 为【数据驱动条件字段】:有 selector 的元素(策略 B)带 selector、
  // 有 source 的元素(策略 A 增强快照)带 source——这正是历史上 A/B 结果形状的全部差异来源,故单一
  // 组装器配条件展开即可逐字段复现两者,且不再可能漂移。
  _buildClickResult(element, extraFields = {}, fallbackMetadata = null) {
    const result = { clicked: element.index, text: element.text || '' }
    if (element.selector) result.selector = element.selector
    if (element.source) result.source = element.source
    Object.assign(result, extraFields)
    if (fallbackMetadata) Object.assign(result, fallbackMetadata)
    return result
  }

  // 统一 JS .click() 兜底收尾(no-geometry / occluded / 解析失败共用)。
  async _finalizeClickFallback(entry, element, sessionId, params, toggleBefore, reason, extraFields = {}) {
    if (params?._fanFailClosedClick === true) {
      throw this._failClosedClickError(element, reason || 'javascript-fallback')
    }
    const downloadWatcher = this._createDownloadWatcher(entry, params)
    let fallbackMetadata
    try {
      this._assertEntryDecisionToken(entry, params, 'click')
      if (typeof params?._fanBeforeClick === 'function') {
        await params._fanBeforeClick()
        this._assertEntryDecisionToken(entry, params, 'click')
      }
      fallbackMetadata = await this._fallbackElementClick(entry, element, sessionId, reason, params)
    } catch (fallbackError) {
      downloadWatcher.dispose()
      throw fallbackError
    }
    let result = this._buildClickResult(element, extraFields, fallbackMetadata)
    const toggle = await this._verifyToggleClick(entry, element, sessionId, toggleBefore)
    if (toggle) Object.assign(result, toggle)
    await this._applyClickDownloadMetadata(result, downloadWatcher)
    if (!params.preserveSelectorMap) entry.selectorMap.clear('click')
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
    return result
  }

  // 统一真鼠标派发收尾。派发失败 → JS 兜底('mouse-dispatch-failed');成功 → 校验 toggle/下载。
  async _finalizeClickDispatch(entry, element, sessionId, params, toggleBefore, x, y, geo) {
    await this._cursorTo(entry, x, y, sessionId, { click: true, w: Number(geo.rect?.width || 0), h: Number(geo.rect?.height || 0) })
    const downloadWatcher = this._createDownloadWatcher(entry, params)
    const extra = { x, y }
    if (geo.source) extra.clickPointSource = geo.source
    try {
      const decisionGuard = this._entryActionLease(entry, params, 'click')
      decisionGuard()
      await this._dispatchClickSequence(
        entry,
        x,
        y,
        sessionId,
        decisionGuard,
        typeof params?._fanBeforeClick === 'function' ? params._fanBeforeClick : null,
        this._isToggleElement(element)
      )
    } catch (dispatchError) {
      // A lease failure is a hard stop, never a reason to JavaScript-click the
      // old selector. For raw CDP failures, re-check the lease before deciding
      // that a same-page JavaScript fallback is still safe.
      if (this._isBrowserReplanError(dispatchError)) {
        downloadWatcher.dispose()
        throw dispatchError
      }
      if (params?._fanFailClosedClick === true) {
        downloadWatcher.dispose()
        // The CDP input sequence may have failed before, during, or after the
        // mousePressed request. Do not claim the submit was definitely skipped;
        // its physical outcome is unknown and must be verified from fresh state.
        throw this._failClosedClickError(
          element,
          'mouse-dispatch-failed',
          dispatchError,
          { beforeDispatch: undefined, dispatchAttempted: true }
        )
      }
      this._assertEntryDecisionToken(entry, params, 'click')
      let fallbackMetadata
      try {
        if (typeof params?._fanBeforeClick === 'function') {
          await params._fanBeforeClick()
          this._assertEntryDecisionToken(entry, params, 'click')
        }
        fallbackMetadata = await this._fallbackElementClick(entry, element, sessionId, 'mouse-dispatch-failed')
      } catch (fallbackError) {
        downloadWatcher.dispose()
        throw fallbackError
      }
      let result = this._buildClickResult(element, extra, fallbackMetadata)
      const toggle = await this._verifyToggleClick(entry, element, sessionId, toggleBefore)
      if (toggle) Object.assign(result, toggle)
      await this._applyClickDownloadMetadata(result, downloadWatcher)
      if (!params.preserveSelectorMap) entry.selectorMap.clear('click')
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
      return result
    }
    if (!params.preserveSelectorMap) entry.selectorMap.clear('click')
    let result = this._buildClickResult(element, extra, null)
    const toggle = await this._verifyToggleClick(entry, element, sessionId, toggleBefore)
    if (toggle) Object.assign(result, toggle)
    await this._applyClickDownloadMetadata(result, downloadWatcher)
    this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'click', result })
    return result
  }
}

const clickOperationDescriptors = Object.getOwnPropertyDescriptors(ClickOperations.prototype)
delete clickOperationDescriptors.constructor

function installClickOperations(Runtime) {
  Object.defineProperties(Runtime.prototype, clickOperationDescriptors)
}

module.exports = { installClickOperations }
