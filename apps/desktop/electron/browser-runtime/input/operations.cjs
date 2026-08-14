'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')
const { sendKey, keyInfoForChar } = require('../actions/keys.cjs')
const { autocompleteMetadataFor } = require('../dom/autocomplete-semantics.cjs')

const FORM_SUBMIT_MUTATION_REGISTRY = '__fanBrowserRuntimeFormSubmitMutationWatches'

class InputOperations {
  _booleanAttributeEnabled(value) {
    if (value == null) return false
    return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
  }

  _cachedTypeability(element = {}) {
    const attributes = element.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const tag = String(element.tag || '').trim().toLowerCase()
    const type = String(element.type || attributes.type || '').trim().toLowerCase()
    const role = String(element.role || attributes.role || '').trim().toLowerCase()
    const hasContentEditable = Object.prototype.hasOwnProperty.call(attributes, 'contenteditable')
    const contentEditable = String(attributes.contenteditable ?? '').trim().toLowerCase()
    const axEditable = String(attributes.editable ?? '').trim().toLowerCase()
    const disabled = Boolean(
      element.disabled ||
      this._booleanAttributeEnabled(attributes.disabled) ||
      String(attributes['aria-disabled'] || '').trim().toLowerCase() === 'true' ||
      this._booleanAttributeEnabled(attributes.inert)
    )
    const readonly = Boolean(
      element.readonly ||
      this._booleanAttributeEnabled(attributes.readonly) ||
      String(attributes['aria-readonly'] || '').trim().toLowerCase() === 'true' ||
      contentEditable === 'false'
    )

    if (disabled) return { typeable: false, reason: 'disabled' }
    if (readonly) return { typeable: false, reason: 'readonly' }
    if (tag === 'iframe' || tag === 'frame') {
      return { typeable: false, reason: 'iframe-container' }
    }
    if (element.capabilities?.typeable === false) {
      return { typeable: false, reason: 'snapshot-not-typeable' }
    }
    if (element.capabilities?.typeable === true) return { typeable: true, reason: '' }
    if (tag === 'textarea') return { typeable: true, reason: '' }
    if (
      tag === 'input' &&
      !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
    ) {
      return { typeable: true, reason: '' }
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      return { typeable: true, reason: '' }
    }
    if (
      (
        hasContentEditable &&
        (contentEditable === '' || contentEditable === 'true' || contentEditable === 'plaintext-only')
      ) ||
      ['true', 'plaintext', 'richtext'].includes(axEditable)
    ) {
      return { typeable: true, reason: '' }
    }
    return { typeable: false, reason: 'not-an-editable-text-target' }
  }

  _notTypeableElementError(element = {}, reason = 'not-typeable') {
    const index = Number(element.index)
    const error = new Error(
      `Element index ${index} is not an editable text target (${reason}). ` +
      'Use the numbered input, textarea, or editable body inside the frame; observe again if none is available.'
    )
    error.code = 'ELEMENT_NOT_TYPEABLE'
    error.details = {
      retryable: false,
      replanRequired: true,
      beforeDispatch: true,
      dispatchAttempted: false,
      action: 'type',
      index,
      reason: String(reason || 'not-typeable')
    }
    error._fanNoTypingFallback = true
    return error
  }

  _typeabilityInspectionFunction() {
    return `function() {
      if (!this || !this.isConnected || !this.ownerDocument) {
        return { ok: false, error: 'element is detached' };
      }
      const read = name => String(this.getAttribute && this.getAttribute(name) || '').trim().toLowerCase();
      const has = name => Boolean(this.hasAttribute && this.hasAttribute(name));
      const tag = String(this.tagName || '').toLowerCase();
      const type = read('type');
      const role = read('role');
      const disabled = Boolean(
        this.disabled === true ||
        (this.matches && this.matches(':disabled')) ||
        read('aria-disabled') === 'true' ||
        (this.closest && this.closest('[inert]'))
      );
      const readonly = Boolean(
        this.readOnly === true ||
        has('readonly') ||
        read('aria-readonly') === 'true' ||
        read('contenteditable') === 'false'
      );
      let reason = '';
      let typeable = false;
      if (disabled) reason = 'disabled';
      else if (readonly) reason = 'readonly';
      else if (tag === 'iframe' || tag === 'frame') reason = 'iframe-container';
      else if (tag === 'textarea') typeable = true;
      else if (
        tag === 'input' &&
        !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)
      ) typeable = true;
      else if (this.isContentEditable === true) typeable = true;
      else if (tag === 'body' && String(this.ownerDocument.designMode || '').toLowerCase() === 'on') typeable = true;
      else reason = 'not-an-editable-text-target';
      return { ok: true, typeable, reason, tag, role, type };
    }`
  }

  async _inspectLiveTypeability(entry, element = {}, sessionId = undefined) {
    let response
    if (element.backendNodeId) {
      response = await this._usingResolvedBackendNode(
        entry,
        element.backendNodeId,
        sessionId,
        objectId => entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: this._typeabilityInspectionFunction(),
          returnByValue: true
        }, sessionId)
      )
    } else if (element.selector) {
      response = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          return (${this._typeabilityInspectionFunction()}).call(el);
        })()`,
        returnByValue: true
      }, sessionId)
    } else {
      return null
    }
    const value = response?.result?.value
    if (!value || typeof value.typeable !== 'boolean') return null
    return value
  }

  async _inspectActiveTypeability(entry, sessionId = undefined) {
    const response = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        ${this._deepActiveElementSource()}
        const el = fanDeepActiveElement(document);
        if (!el) return { ok: false, error: 'no active element' };
        return (${this._typeabilityInspectionFunction()}).call(el);
      })()`,
      returnByValue: true
    }, sessionId)
    const value = response?.result?.value
    if (!value || typeof value.typeable !== 'boolean') return null
    return value
  }

  _elementTextValueFunction() {
    return `function() {
      /* fan-read-target-text-value */
      if (!this || !this.isConnected || !this.ownerDocument) {
        return { ok: false, error: 'element is detached' };
      }
      if ('value' in this) return { ok: true, value: String(this.value ?? '') };
      if (
        this.isContentEditable === true ||
        (
          String(this.tagName || '').toLowerCase() === 'body' &&
          String(this.ownerDocument.designMode || '').toLowerCase() === 'on'
        )
      ) {
        return { ok: true, value: String(this.textContent ?? '') };
      }
      return { ok: false, error: 'target element does not expose an editable text value' };
    }`
  }

  async _readElementTextValue(entry, element = {}, sessionId = undefined) {
    let response
    if (element.backendNodeId) {
      response = await this._usingResolvedBackendNode(
        entry,
        element.backendNodeId,
        sessionId,
        objectId => entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: this._elementTextValueFunction(),
          returnByValue: true
        }, sessionId)
      )
    } else if (element.selector) {
      response = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          return (${this._elementTextValueFunction()}).call(el);
        })()`,
        returnByValue: true
      }, sessionId)
    } else {
      return null
    }
    const value = response?.result?.value
    if (!value?.ok) return null
    return String(value.value ?? '')
  }

  _typingReadbackError(readback, element = {}) {
    if (!readback || readback.skipped === true) {
      const error = new Error(
        `Typing into element index ${element.index} could not be verified; the action will not be reported as completed.`
      )
      error.code = 'TYPE_READBACK_UNAVAILABLE'
      error.details = {
        retryable: false,
        beforeDispatch: false,
        dispatchAttempted: true,
        action: 'type',
        index: Number(element.index),
        reason: String(readback?.reason || 'unavailable')
      }
      error._fanNoTypingFallback = true
      return error
    }
    if (readback.valueMatches !== true) {
      const error = new Error(
        `Typing into element index ${element.index} did not produce the requested value. ` +
        'Inspect the fresh snapshot before deciding what to do next.'
      )
      error.code = 'TYPE_READBACK_MISMATCH'
      error.details = {
        retryable: true,
        replanRequired: true,
        action: 'type',
        index: Number(element.index),
        effect: 'value-only',
        reason: 'readback-mismatch'
      }
      error._fanNoTypingFallback = true
      return error
    }
    return null
  }

  _requiresDirectValueAssignment(element = {}) {
    const type = String(element.type || element.attributes?.type || '').toLowerCase()
    if (['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)) return true
    if (type === 'text' || !type) {
      const attributes = element.attributes || {}
      const className = String(attributes.class || '').toLowerCase()
      if (/(^|\s)(datepicker|daterangepicker|datetimepicker|bootstrap-datepicker)(\s|$)/.test(className)) return true
      return ['data-datepicker', 'data-date-format', 'data-provide'].some(name => attributes[name] != null)
    }
    return false
  }

  _isContentEditableElement(element = {}) {
    const attributes = element.attributes || {}
    const contentEditable = String(attributes.contenteditable ?? '').toLowerCase()
    return (
      contentEditable === 'true' ||
      attributes.contenteditable === '' ||
      element.capabilities?.editable ||
      (String(element.role || attributes.role || '').toLowerCase() === 'textbox' &&
        !['input', 'textarea'].includes(String(element.tag || '').toLowerCase()))
    )
  }

  _typingMode(params = {}, element = {}) {
    const rawMode = String(params.typingMode || params.typing_mode || '').toLowerCase()
    if (params.fast === true || rawMode === 'fast' || rawMode === 'inserttext' || rawMode === 'insert-text') return 'fast'
    if (rawMode === 'direct' || this._requiresDirectValueAssignment(element)) return 'direct'
    return 'human'
  }

  _typingDelayMs(params = {}) {
    const value = Number(params.delayMs ?? params.delay_ms ?? params.typingDelayMs ?? params.typing_delay_ms)
    if (!Number.isFinite(value)) return 18
    return Math.max(0, Math.min(250, value))
  }

  _isCjkChar(ch) {
    const c = typeof ch === 'string' && ch.length ? ch.codePointAt(0) : 0
    // CJK Unified Ideographs (+ ext-A), Hangul syllables, Hiragana/Katakana.
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x3040 && c <= 0x30ff)
  }

  // Deterministic 0..1 jitter (xorshift, seeded by char index) — no Math.random
  // in the hot path, so pacing is reproducible and resume-safe.
  _seededJitter(seed) {
    let x = (Number(seed) * 2654435761) >>> 0
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }

  // Pure: ms to sleep AFTER emitting the character at index i. Latin chars get a
  // jittered human base with occasional word-boundary pauses; CJK chars are
  // emitted in fast bursts with an IME candidate-selection gap at burst
  // boundaries. Constants + their research sources live in the constructor.
  _humanCadenceDelay(value, i) {
    const ch = (value && value[i]) || ''
    if (this._isCjkChar(ch)) {
      let run = 0
      for (let j = i; j >= 0 && this._isCjkChar(value[j]); j -= 1) run += 1
      const atBurstEnd = run % this.cjkBurstSize === 0
      return atBurstEnd ? this.cjkBurstGapMs : this.cjkIntraBurstMs
    }
    let d = this.typingBaseDelayMs * (1 + (this._seededJitter(i + 1) * 2 - 1) * this.typingJitterPct)
    const isBoundary = ch === ' ' || '.,;:!?，。；：！？、'.includes(ch)
    if (isBoundary && this._seededJitter(i * 7 + 3) < this.typingWordPauseProb) d += this.typingWordPauseMs
    return Math.round(d)
  }

  _sleep(ms) {
    if (!ms) return Promise.resolve()
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  // 委托给 actions/keys.cjs 的权威实现(SK-10:消除近重复 + 同步标点 VK/CJK code 修正)
  _keyInfoForChar(char) {
    return keyInfoForChar(char)
  }

  async _dispatchTextCharacter(client, char, sessionId = undefined) {
    if (char === '\n') {
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      }, sessionId)
      await client.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter' }, sessionId)
      await client.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      }, sessionId)
      return 3
    }
    const info = this._keyInfoForChar(char)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: info.key,
      code: info.code,
      modifiers: info.modifiers,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode
    }, sessionId)
    await client.send('Input.dispatchKeyEvent', { type: 'char', text: char, key: char }, sessionId)
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      modifiers: info.modifiers,
      windowsVirtualKeyCode: info.windowsVirtualKeyCode
    }, sessionId)
    return 3
  }

  async _dispatchHumanText(client, text, sessionId = undefined, params = {}, element = {}, decisionGuard = null) {
    const delayMs = this._typingDelayMs(params)
    const value = String(text || '')
    const firstChar = value[0] || ''
    const checkFirstChar = Boolean(firstChar && params.clear !== false && this._isContentEditableElement(element))
    // Human cadence applies only when visuals are on AND the caller passed no
    // explicit delay (every unit test passes delayMs:0 → original flat path, so
    // keyEvents counts and timing assertions are untouched).
    const explicit = Number.isFinite(
      Number(params.delayMs ?? params.delay_ms ?? params.typingDelayMs ?? params.typing_delay_ms)
    )
    const humanCadence = this.operatingVisuals && !explicit
    let keyEvents = 0
    let retriedFirstChar = false
    let spent = 0
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i]
      if (typeof decisionGuard === 'function') decisionGuard()
      keyEvents += await this._dispatchTextCharacter(client, char, sessionId)
      if (i === 0 && checkFirstChar) {
        const actual = await this._readActiveElementValue(client, sessionId).catch(() => null)
        if (actual != null && !actual.includes(firstChar)) {
          if (typeof decisionGuard === 'function') decisionGuard()
          keyEvents += await this._dispatchTextCharacter(client, firstChar, sessionId)
          retriedFirstChar = true
        }
      }
      let sleepMs = delayMs
      if (humanCadence) {
        // Once the visible budget is spent, finish INSTANTLY so very long inputs
        // don't crawl — a true ceiling: capped chars add no further delay.
        if (spent >= this.typingMaxTotalMs) {
          sleepMs = 0
        } else {
          sleepMs = this._humanCadenceDelay(value, i)
          spent += sleepMs
        }
      }
      await this._sleep(sleepMs)
    }
    return { mode: 'human', keyEvents, delayMs, retriedFirstChar }
  }

  async _inputText(client, text, sessionId = undefined, params = {}, element = {}, decisionGuard = null) {
    const mode = this._typingMode(params, element)
    if (!text) return { mode, keyEvents: 0, delayMs: 0 }
    if (mode === 'fast') {
      if (typeof decisionGuard === 'function') decisionGuard()
      await client.send('Input.insertText', { text }, sessionId)
      return { mode, keyEvents: 0, delayMs: 0 }
    }
    if (mode === 'direct') return { mode, keyEvents: 0, delayMs: 0 }
    return this._dispatchHumanText(client, text, sessionId, params, element, decisionGuard)
  }

  _deepActiveElementSource() {
    return `
      function fanDeepActiveElementInfo(rootDocument) {
        let doc = rootDocument || document;
        let el = doc && doc.activeElement;
        let offsetX = 0;
        let offsetY = 0;
        const seen = new Set();
        while (el && !seen.has(el)) {
          seen.add(el);
          const shadowActive = el.shadowRoot && el.shadowRoot.activeElement;
          if (shadowActive) {
            el = shadowActive;
            continue;
          }
          if (/^(iframe|frame)$/i.test(el.tagName || '')) {
            try {
              const childDocument = el.contentDocument || el.contentWindow?.document;
              const childActive = childDocument && childDocument.activeElement;
              if (childActive) {
                const rect = el.getBoundingClientRect();
                offsetX += Number(rect.left || rect.x || 0) + Number(el.clientLeft || 0);
                offsetY += Number(rect.top || rect.y || 0) + Number(el.clientTop || 0);
                doc = childDocument;
                el = childActive;
                continue;
              }
            } catch (_) {}
          }
          break;
        }
        return { el, offsetX, offsetY };
      }
      function fanDeepActiveElement(rootDocument) {
        return fanDeepActiveElementInfo(rootDocument).el;
      }
      function fanComposedContains(container, node) {
        let current = node;
        const seen = new Set();
        while (current && !seen.has(current)) {
          if (current === container) return true;
          seen.add(current);
          if (current.parentElement) {
            current = current.parentElement;
            continue;
          }
          const root = current.getRootNode && current.getRootNode();
          if (root && root.host) {
            current = root.host;
            continue;
          }
          try {
            const frameElement = current.ownerDocument?.defaultView?.frameElement;
            if (frameElement) {
              current = frameElement;
              continue;
            }
          } catch (_) {}
          current = null;
        }
        return false;
      }
    `
  }

  async _assignActiveElementValue(client, text, sessionId = undefined) {
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
          /* fan-assign-active-element-value */
          ${this._deepActiveElementSource()}
          const el = fanDeepActiveElement(document);
          if (!el) return { ok: false, error: 'no active element' };
          const view = el.ownerDocument?.defaultView || window;
          const value = ${JSON.stringify(String(text || ''))};
          if ('value' in el) {
            let proto = Object.getPrototypeOf(el);
            let desc = null;
            while (proto && !desc) {
              desc = Object.getOwnPropertyDescriptor(proto, 'value');
              proto = Object.getPrototypeOf(proto);
            }
            if (desc && desc.set) desc.set.call(el, value);
            else el.value = value;
          } else if (el.isContentEditable) {
            el.textContent = value;
          } else {
            return { ok: false, error: 'active element does not accept value assignment' };
          }
          try {
            el.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          } catch (_) {
            el.dispatchEvent(new view.Event('input', { bubbles: true }));
          }
          el.dispatchEvent(new view.Event('change', { bubbles: true }));
          if (typeof jQuery !== 'undefined' && jQuery.fn) {
            try { jQuery(el).trigger('change'); } catch (_) {}
          }
          return { ok: true };
      })()`,
      returnByValue: true
    }, sessionId)
    const value = result?.result?.value
    if (!value?.ok) throw new Error(value?.error || 'failed to assign active element value')
    return value
  }

  async _triggerActiveElementInputEvents(client, sessionId = undefined) {
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
        ${this._deepActiveElementSource()}
        const el = fanDeepActiveElement(document);
        if (!el) return { ok: false, error: 'no active element' };
        const view = el.ownerDocument?.defaultView || window;
        // This compatibility replay is only used after direct value assignment.
        // Trusted CDP keyboard/insertText input already drove the page's native
        // beforeinput/input pipeline and must never reach this function.
        //
        // Do not synthesize focus/focusin/focusout/blur here. In particular,
        // autocomplete widgets commonly close their popup on blur. Dispatching a
        // fake blur after typing made a valid suggestion list disappear while
        // the DOM still reported the input as focused.
        const isContentEditable = el.isContentEditable === true ||
          el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '';
        if (isContentEditable && !('value' in el)) {
          return { ok: true, skipped: 'contenteditable', eventCount: 0, events: [], flags: {} };
        }
        const value = 'value' in el ? String(el.value ?? '') : String(el.textContent ?? '');
        const oldValue = el.__fanLastFrameworkEventValue || '';
        const events = [];
        const flags = {
          reactValueTracker: Boolean(el._valueTracker),
          reactInternal: Object.keys(el).some(key => key.startsWith('__reactProps$') || key.startsWith('__reactEventHandlers$') || key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')),
          vue: Boolean(el.__vue__ || el._vnode || el.__vueParentComponent),
          jquery: Boolean(typeof jQuery !== 'undefined' && jQuery.fn)
        };
        function dispatch(event) {
          el.dispatchEvent(event);
          events.push(event.type);
        }
        if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
          try { el._valueTracker.setValue(oldValue); } catch (_) {}
        }
        try {
          dispatch(new view.InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertReplacementText' }));
        } catch (_) {
          dispatch(new view.Event('input', { bubbles: true, cancelable: true }));
        }
        dispatch(new view.Event('change', { bubbles: true, cancelable: true }));
        if (flags.reactValueTracker || flags.reactInternal) {
          try {
            dispatch(new view.InputEvent('input', { bubbles: true, cancelable: true, data: value, inputType: 'insertReplacementText' }));
          } catch (_) {}
        }
        if (flags.jquery) {
          try {
            jQuery(el).trigger('input');
            jQuery(el).trigger('change');
            if (jQuery(el).data('datepicker')) jQuery(el).datepicker('update');
          } catch (_) {}
        }
        if (flags.vue) {
          try { setTimeout(() => el.dispatchEvent(new view.Event('input', { bubbles: true })), 0); } catch (_) {}
        }
        el.__fanLastFrameworkEventValue = value;
        return { ok: true, eventCount: events.length, events, flags };
      })()`,
      returnByValue: true
    }, sessionId)
    return result?.result?.value || {}
  }

  async _frameworkEventsAfterTyping(client, mode, sessionId = undefined) {
    if (mode !== 'direct') {
      return {
        ok: true,
        skipped: 'trusted-cdp-input',
        eventCount: 0,
        events: [],
        flags: {}
      }
    }
    return this._triggerActiveElementInputEvents(client, sessionId)
  }

  async _clearActiveTextFieldWithKeyboard(client, sessionId = undefined, actionGuard = null) {
    try {
      const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
      if (typeof actionGuard === 'function') actionGuard()
      await sendKey(client, selectAll, sessionId)
      if (typeof actionGuard === 'function') actionGuard()
      await sendKey(client, 'Backspace', sessionId)
      const value = await this._readActiveElementValue(client, sessionId).catch(() => null)
      if (value == null) {
        return { cleared: false, method: 'keyboard', verification: 'unavailable' }
      }
      if (!String(value || '').trim()) return { cleared: true, method: 'keyboard' }
      return { cleared: false, method: 'keyboard', remainingTextLength: String(value || '').length }
    } catch {
      return { cleared: false, method: 'failed' }
    }
  }

  async _clearActiveTextField(client, sessionId = undefined, actionGuard = null, options = {}) {
    // Autocomplete inputs often treat `change` as a commit boundary and
    // `blur` as a request to close their popup. Clear them through Chromium's
    // real editing pipeline so the field remains focused and the next typed
    // character can drive the widget's normal suggestion lifecycle.
    if (options.preferKeyboard === true) {
      return this._clearActiveTextFieldWithKeyboard(client, sessionId, actionGuard)
    }
    try {
      if (typeof actionGuard === 'function') actionGuard()
      const result = await client.send('Runtime.evaluate', {
        expression: `(() => {
          /* fan-clear-active-text-field */
          ${this._deepActiveElementSource()}
          const el = fanDeepActiveElement(document);
          if (!el) return { cleared: false, method: 'none', error: 'no active element' };
          const view = el.ownerDocument?.defaultView || window;
          const hasContentEditable = el.getAttribute?.('contenteditable') === 'true' ||
            el.getAttribute?.('contenteditable') === '' ||
            el.isContentEditable === true;
          if (hasContentEditable) {
            // 框架受控富文本编辑器(文心一言/Lexical/ProseMirror/Draft 等):【绝不】做破坏式 DOM 清空。
            // removeChild/innerHTML=''/textContent='' 会让框架的内部 model 与真实 DOM 脱节,编辑器被搞坏
            // 到连用户手动都删不掉(实测:文心一言输完点 Enter 后内容删不掉的根因)。这里只聚焦+不动内容,
            // 返回 cleared:false 让外层 fall through 到键盘式清除(真 Ctrl/Cmd+A + Backspace 经 CDP 派发,
            // 走框架的编辑管线,删除被框架正确接受,对齐 的键盘清除)。
            try { el.focus(); } catch (_) {}
            return { cleared: false, method: 'contenteditable-keyboard', finalText: String(el.textContent || '') };
          }
          if ('value' in el) {
            try { el.select(); } catch (_) {}
            let proto = Object.getPrototypeOf(el);
            let desc = null;
            while (proto && !desc) {
              desc = Object.getOwnPropertyDescriptor(proto, 'value');
              proto = Object.getPrototypeOf(proto);
            }
            if (desc && desc.set) desc.set.call(el, '');
            else el.value = '';
            el.dispatchEvent(new view.Event('input', { bubbles: true }));
            el.dispatchEvent(new view.Event('change', { bubbles: true }));
            return { cleared: true, method: 'value', finalText: String(el.value || '') };
          }
          return { cleared: false, method: 'none', error: 'not a supported input type' };
        })()`,
        returnByValue: true
      }, sessionId)
      const value = result?.result?.value || {}
      if (value.cleared && !String(value.finalText || '').trim()) {
        // 框架受控编辑器(文心一言/Lexical/ProseMirror/React 受控 textarea)会在 JS 清空后【异步把
        // 内容重渲回来】——同步那一刻看着空(finalText=''),稍后又回来。不能凭这一刻就上报成功,
        // 否则永远不会 fall through 到键盘兜底,表现为"删不掉"。等一拍重读确认真清掉了才返回;
        // 没清掉就继续走坐标/键盘清除(真 Select-All+Backspace 走框架编辑管线,删除才被框架接受,
        // 对齐 的键盘式清除)。
        await this._sleep(60)
        const recheck = await this._readActiveElementValue(client, sessionId).catch(() => null)
        if (recheck == null || !String(recheck || '').trim()) return { cleared: true, method: value.method || 'javascript' }
      }
    } catch {
      // Fall through to coordinate/keyboard clearing.
    }

    try {
      const bounds = await client.send('Runtime.evaluate', {
        expression: `(() => {
          /* fan-active-element-rect */
          ${this._deepActiveElementSource()}
          const active = fanDeepActiveElementInfo(document);
          const el = active.el;
          if (!el || typeof el.getBoundingClientRect !== 'function') return { ok: false, error: 'no active element bounds' };
          const rect = el.getBoundingClientRect();
          return {
            ok: true,
            x: Number(rect.x || rect.left || 0) + active.offsetX,
            y: Number(rect.y || rect.top || 0) + active.offsetY,
            width: rect.width,
            height: rect.height
          };
        })()`,
        returnByValue: true
      }, sessionId)
      const rect = bounds?.result?.value || {}
      if (rect.ok) {
        const x = Math.max(0, Number(rect.x || 0) + Number(rect.width || 0) / 2)
        const y = Math.max(0, Number(rect.y || 0) + Number(rect.height || 0) / 2)
        if (typeof actionGuard === 'function') actionGuard()
        await this._markActingOn(client, sessionId)
        if (typeof actionGuard === 'function') actionGuard()
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 3 }, sessionId)
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 3 }, sessionId)
        if (typeof actionGuard === 'function') actionGuard()
        await sendKey(client, 'Delete', sessionId)
        const value = await this._readActiveElementValue(client, sessionId).catch(() => null)
        if (value == null || !String(value || '').trim()) return { cleared: true, method: 'triple-click-delete' }
      }
    } catch {
      // Fall through to keyboard clearing.
    }

    return this._clearActiveTextFieldWithKeyboard(client, sessionId, actionGuard)
  }

  async _readActiveElementValue(client, sessionId = undefined) {
    const result = await client.send('Runtime.evaluate', {
      expression: `(() => {
        ${this._deepActiveElementSource()}
        const el = fanDeepActiveElement(document);
        if (!el) return { ok: false, error: 'no active element' };
        if ('value' in el) return { ok: true, value: String(el.value ?? '') };
        if (el.isContentEditable) return { ok: true, value: String(el.textContent ?? '') };
        return { ok: false, error: 'active element does not expose text value' };
      })()`,
      returnByValue: true
    }, sessionId)
    const value = result?.result?.value
    if (!value?.ok) return null
    return String(value.value ?? '')
  }

  async _readbackTypingResult(
    client,
    text,
    sessionId = undefined,
    params = {},
    element = {},
    actionGuard = null,
    beforeValue = null,
    readValue = null
  ) {
    try {
      const read = typeof readValue === 'function'
        ? readValue
        : () => this._readActiveElementValue(client, sessionId)
      let actual = await read()
      if (actual == null) return { skipped: true, reason: 'unavailable' }
      let retried = false
      const expected = String(text || '')
      // D2c: do NOT rewrite the field on autocomplete/combobox inputs — those
      // legitimately append/prepend content (suggestions, masks), so overwriting
      // makes the user see "input got cleared then retyped". Only fix obvious
      // prefix/suffix noise on plain inputs.
      const autocomplete = this._autocompleteTypingMetadata(element)
      if (
        params.clear !== false &&
        !autocomplete.detected &&
        typeof actual === 'string' &&
        actual !== expected &&
        actual.length > expected.length &&
        (actual.endsWith(expected) || actual.startsWith(expected))
      ) {
        if (typeof actionGuard === 'function') actionGuard()
        await this._assignActiveElementValue(client, expected, sessionId)
        retried = true
        actual = (await read()) ?? actual
      }
      const valueMatches = params.clear === false
        ? (
            actual === expected ||
            (
              expected.length > 0 &&
              actual !== beforeValue &&
              actual.includes(expected)
            )
          )
        : actual === expected
      return {
        skipped: false,
        valueMatches,
        actualTextLength: actual.length,
        retried
      }
    } catch {
      return { skipped: true, reason: 'error' }
    }
  }

  _autocompleteTypingMetadata(element = {}) {
    return autocompleteMetadataFor(element)
  }

  async _settleAutocompleteTyping(element = {}, params = {}) {
    const metadata = this._autocompleteTypingMetadata(element)
    const disabled = params.autocompleteWait === false || params.autocomplete_wait === false
    const waitValue = Number(params.autocompleteWaitMs ?? params.autocomplete_wait_ms ?? 400)
    const waitMs = Math.max(0, Math.min(2000, Number.isFinite(waitValue) ? waitValue : 400))
    if (metadata.detected && metadata.shouldWait && !disabled && waitMs > 0) {
      await this._sleep(waitMs)
      return { ...metadata, waited: true, waitMs }
    }
    return { ...metadata, waited: false, waitMs: metadata.shouldWait && !disabled ? waitMs : 0 }
  }

  async _elementHasFocus(entry, element = {}, sessionId = undefined) {
    if (element.backendNodeId) {
      const result = await this._usingResolvedBackendNode(entry, element.backendNodeId, sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
          if (!this.isConnected || !this.ownerDocument) return false;
          ${this._deepActiveElementSource()}
          const active = fanDeepActiveElement(this.ownerDocument);
          return active === this || fanComposedContains(this, active);
          }`,
          returnByValue: true
        }, sessionId)
      ))
      return result?.result?.value === true
    }
    if (!element.selector) return false
    const result = await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const map = window.__fanBrowserRuntimeSelectorMap || {};
        const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
        ${this._resolveElementFunction()}
        const resolved = resolveElementEntry(item);
        const el = resolved && resolved.el;
        if (!el || !el.isConnected) return false;
        ${this._deepActiveElementSource()}
        const active = fanDeepActiveElement(el.ownerDocument);
        return active === el || fanComposedContains(el, active);
      })()`,
      returnByValue: true
    }, sessionId)
    return result?.result?.value === true
  }

  async type(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    if (params._fanDecisionToken) {
      this._assertDecisionToken(this._sessionIdForEntry(entry), params, 'type')
    }
    const decisionGuard = this._entryActionLease(entry, params, 'type')
    const text = String(params.text ?? '')
    // INPUT-1(对齐 _type_to_page):index 为 0/缺失 → 不聚焦具体元素,
    // 直接向当前焦点(页面)逐字打字(搜索框已聚焦/SPA 等场景)。
    if (params.index == null || Number(params.index) === 0) {
      this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'type', index: 0 })
      try {
        const result = await this._typeToPage(entry, text, params.sessionId || params.session_id, params)
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'type', result })
        return result
      } catch (error) {
        this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'type', error: error.message })
        throw error
      }
    }
    const element = params._resolvedElement || await this._elementForAction(entry, params.index, params._fanDecisionToken, 'type')
    this._assertExpectedElement(
      element,
      params.expected || (params.expectedLabel ? { label: params.expectedLabel } : null),
      'type'
    )
    const sessionId = element.sessionId
    const cachedTypeability = this._cachedTypeability(element)
    if (!cachedTypeability.typeable) {
      throw this._notTypeableElementError(element, cachedTypeability.reason)
    }
    const liveTypeability = await this._inspectLiveTypeability(entry, element, sessionId).catch(() => null)
    if (liveTypeability?.ok === false) {
      throw this._staleElementError(
        element.index,
        `Element index ${element.index} is detached or unavailable. Observe again and use a fresh element index.`,
        'type'
      )
    }
    if (liveTypeability?.typeable === false) {
      throw this._notTypeableElementError(element, liveTypeability.reason || 'not-typeable')
    }
    const mode = this._typingMode(params, element)
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, { id: entry.id, action: 'type', index: element.index })
    try {
      if (element.backendNodeId) {
        // DOMSnapshot rectangles are document coordinates captured at observe
        // time. Resolve live geometry after scroll instead of clicking the old
        // coordinates (which can target a different element after scrolling).
        const geometry = await this._backendNodeClickGeometry(entry, element, sessionId).catch(() => null)
        const x = geometry ? geometry.x : null
        const y = geometry ? geometry.y : null
        if (geometry) {
          await this._cursorTo(entry, x, y, sessionId, {
            focus: true,
            w: Number(geometry.rect?.width || 0),
            h: Number(geometry.rect?.height || 0)
          })
        }
        let focus = null
        try {
          if (decisionGuard) decisionGuard()
          await entry.client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId }, sessionId)
          await entry.client.send('DOM.focus', { backendNodeId: element.backendNodeId }, sessionId)
          focus = { focused: true, method: 'dom-focus' }
        } catch (error) {
          focus = { focused: false, method: 'dom-focus', error: error.message }
        }
        if (!focus?.focused) {
          if (!geometry) {
            throw this._staleElementError(
              element.index,
              `Element index ${element.index} is stale or has no actionable geometry. ` +
              'Observe again and use a fresh element index.',
              'type'
            )
          }
          await this._dispatchClickSequence(entry, x, y, sessionId, decisionGuard)
          const focused = await this._elementHasFocus(entry, element, sessionId).catch(() => false)
          if (!focused) {
            throw new Error(`Mouse focus did not focus element index ${element.index}`)
          }
          focus = { focused: true, method: 'mouse-click' }
        }
        if (decisionGuard) decisionGuard()
        const clearResult = params.clear !== false && mode !== 'direct'
          ? await this._clearActiveTextField(entry.client, sessionId, decisionGuard, {
              preferKeyboard: this._autocompleteTypingMetadata(element).detected
            })
          : null
        const readTargetValue = () => this._readElementTextValue(entry, element, sessionId)
        const beforeValue = await readTargetValue().catch(() => null)
        const input = await this._inputText(entry.client, text, sessionId, params, element, decisionGuard)
        if (mode === 'direct') {
          if (decisionGuard) decisionGuard()
          await this._assignActiveElementValue(entry.client, text, sessionId)
        }
        if (decisionGuard) decisionGuard()
        const frameworkEvents = await this._frameworkEventsAfterTyping(entry.client, mode, sessionId).catch(error => ({
          ok: false,
          error: error.message
        }))
        const readback = await this._readbackTypingResult(
          entry.client,
          text,
          sessionId,
          params,
          element,
          decisionGuard,
          beforeValue,
          readTargetValue
        )
        const readbackError = this._typingReadbackError(readback, element)
        if (readbackError) throw readbackError
        const autocomplete = await this._settleAutocompleteTyping(element, params)
        if (!params.preserveSelectorMap) entry.selectorMap.clear('type')
        const result = {
          typed: element.index,
          textLength: text.length,
          source: element.source || '',
          typingMode: mode,
          keyEvents: input.keyEvents || 0,
          clear: clearResult,
          retriedFirstChar: Boolean(input.retriedFirstChar),
          frameworkEvents,
          readback,
          autocomplete,
          ...(geometry ? { x, y, clickPointSource: geometry.source } : {}),
          focus
        }
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'type', result })
        return result
      }
      let focus = null
      if (element.backendNodeId) {
        try {
          await entry.client.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: element.backendNodeId }, sessionId)
          await entry.client.send('DOM.focus', { backendNodeId: element.backendNodeId }, sessionId)
          focus = { focused: true, method: 'dom-focus' }
        } catch (error) {
          focus = { focused: false, method: 'dom-focus', error: error.message }
        }
      }
      if (decisionGuard) decisionGuard()
      const focusResult = await entry.client.send('Runtime.evaluate', {
        expression: `(() => {
          const map = window.__fanBrowserRuntimeSelectorMap || {};
          const item = map[${JSON.stringify(this._selectorLookupIndex(element))}];
          ${this._resolveElementFunction()}
          const resolved = resolveElementEntry(item);
          const el = resolved && resolved.el;
          if (!el) return { ok: false, error: 'element not found' };
          for (const frame of resolved.frames || []) {
            const view = frame.ownerDocument && frame.ownerDocument.defaultView;
            const frameRect = frame.getBoundingClientRect();
            if (view && (frameRect.top < 0 || frameRect.left < 0 || frameRect.bottom > view.innerHeight || frameRect.right > view.innerWidth)) {
              frame.scrollIntoView({ block: 'center', inline: 'center' });
            }
          }
          el.scrollIntoView({ block: 'center', inline: 'center' });
          ${focus?.focused ? '' : 'el.focus();'}
          const rect = el.getBoundingClientRect();
          let offsetX = 0, offsetY = 0;
          for (const frame of resolved.frames || []) {
            const frameRect = frame.getBoundingClientRect();
            offsetX += frameRect.left + Number(frame.clientLeft || 0);
            offsetY += frameRect.top + Number(frame.clientTop || 0);
          }
          return { ok: true, rect: { x: rect.x + offsetX, y: rect.y + offsetY, width: rect.width, height: rect.height } };
        })()`,
        returnByValue: true
      }, sessionId)
      const value = focusResult?.result?.value
      if (!value?.ok) throw new Error(value?.error || 'failed to focus element')
      if (!focus?.focused) focus = { focused: true, method: 'javascript-focus' }
      await this._cursorTo(entry, Math.max(0, Number(value.rect.x || 0) + Number(value.rect.width || 0) / 2), Math.max(0, Number(value.rect.y || 0) + Number(value.rect.height || 0) / 2), sessionId, { focus: true, w: Number(value.rect.width || 0), h: Number(value.rect.height || 0) })
      if (decisionGuard) decisionGuard()
      const clearResult = params.clear !== false && mode !== 'direct'
        ? await this._clearActiveTextField(entry.client, sessionId, decisionGuard, {
            preferKeyboard: this._autocompleteTypingMetadata(element).detected
          })
        : null
      const readTargetValue = () => this._readElementTextValue(entry, element, sessionId)
      const beforeValue = await readTargetValue().catch(() => null)
      const input = await this._inputText(entry.client, text, sessionId, params, element, decisionGuard)
      if (mode === 'direct') {
        if (decisionGuard) decisionGuard()
        await this._assignActiveElementValue(entry.client, text, sessionId)
      }
      if (decisionGuard) decisionGuard()
      const frameworkEvents = await this._frameworkEventsAfterTyping(entry.client, mode, sessionId).catch(error => ({
        ok: false,
        error: error.message
      }))
      const readback = await this._readbackTypingResult(
        entry.client,
        text,
        sessionId,
        params,
        element,
        decisionGuard,
        beforeValue,
        readTargetValue
      )
      const readbackError = this._typingReadbackError(readback, element)
      if (readbackError) throw readbackError
      const autocomplete = await this._settleAutocompleteTyping(element, params)
      if (!params.preserveSelectorMap) entry.selectorMap.clear('type')
      const result = {
        typed: element.index,
        textLength: text.length,
        selector: element.selector,
        typingMode: mode,
        keyEvents: input.keyEvents || 0,
        clear: clearResult,
        retriedFirstChar: Boolean(input.retriedFirstChar),
        frameworkEvents,
        readback,
        autocomplete,
        focus
      }
      this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'type', result })
      return result
    } catch (error) {
      if (error?._fanNoTypingFallback === true) {
        this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
          id: entry.id,
          action: 'type',
          error: error.message,
          code: error.code
        })
        throw error
      }
      // INPUT-2(对齐 on_TypeTextEvent except 分支):向元素打字失败不直接报错,
      // 而是尝试「点击聚焦该元素 → 改为向页面整页打字」兜底,提高脏 DOM/遮挡/detached 场景成功率。
      let focusError = null
      try {
        // CLK-10:不强制 allowOccluded——被 cookie 横幅/modal 遮住的输入框,真实坐标点击会落到
        // 覆盖层中心(点了"接受 Cookies"/触发别的导航,产生 BU 不会有的副作用)。去掉后遮挡时
        // 自动退化成 JS click 聚焦真元素(对齐 BU _click_element_node_impl 的"遮挡→JS click")。
        await this.click(id, {
          index: params.index,
          _fanDecisionToken: params._fanDecisionToken,
          preserveSelectorMap: params.preserveSelectorMap
        })
      } catch (clickError) {
        focusError = clickError
      }
      if (!focusError) {
        const focused = await this._elementHasFocus(entry, element, sessionId).catch(() => false)
        if (!focused) focusError = new Error('focus retry did not focus the requested element')
      }
      if (focusError) {
        const failure = new Error(
          `Failed to focus element ${element.index}; refusing to type into an unknown active element. ` +
          `Original error: ${error.message}. Focus retry: ${focusError.message}`
        )
        const staleCause = [error, focusError].find(item => item?.code === 'STALE_ELEMENT_REFERENCE')
        if (staleCause) {
          failure.code = staleCause.code
          failure.details = { ...(staleCause.details || {}), action: 'type', index: element.index }
        }
        this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'type', error: failure.message })
        throw failure
      }
      try {
        const result = await this._typeToPage(entry, text, sessionId, params)
        result.fallbackFrom = error.message
        this.eventBus.emit(EVENT_TYPES.ACTION_COMPLETED, { id: entry.id, action: 'type', result })
        return result
      } catch {
        this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, { id: entry.id, action: 'type', error: error.message })
        throw error
      }
    } finally {
      // 持久焦点环兜底清除:try 正常 return、catch 兜底 return、catch 抛出三条出口都过 finally,
      // 出错/超时/兜底也必移除,绝不残留。持久环在键派发前由 _cursorTo({focus:true}) 同步画好
      // (见 _cursorTo 的 focus 块),故 _cursorTo 返回时 #__fan_focus_ring 已在 DOM,此处必命中。
      await this._removeFocusRing(entry, sessionId).catch(() => {})
    }
  }

  // INPUT-1/INPUT-2(对齐 _type_to_page):不聚焦具体元素,向当前焦点逐字打字。
  async _typeToPage(entry, text, sessionId = undefined, params = {}) {
    const decisionGuard = this._entryActionLease(entry, params, 'type')
    decisionGuard()
    const clearResult = params.clear === true ? await this._clearActiveTextField(entry.client, sessionId, decisionGuard).catch(() => null) : null
    const input = await this._inputText(entry.client, text, sessionId, params, {}, decisionGuard)
    if (decisionGuard) decisionGuard()
    const frameworkEvents = await this._frameworkEventsAfterTyping(entry.client, input.mode, sessionId).catch(error => ({ ok: false, error: error.message }))
    if (!params.preserveSelectorMap) entry.selectorMap.clear('type')
    const result = {
      typed: null,
      target: 'page',
      textLength: text.length,
      typingMode: 'page',
      keyEvents: input.keyEvents || 0,
      clear: clearResult,
      retriedFirstChar: Boolean(input.retriedFirstChar),
      frameworkEvents
    }
    return result
  }

  async fillForm(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'fillForm')
    const fields = Array.isArray(params.fields) ? params.fields : []
    if (!fields.length || fields.length > 50) {
      const error = new Error('fillForm requires between 1 and 50 fields')
      error.code = 'INVALID_FORM_FIELDS'
      throw error
    }

    const resolved = []
    for (const field of fields) {
      if (!field || typeof field !== 'object' || field.index == null) {
        const error = new Error('Each fillForm field requires an index')
        error.code = 'INVALID_FORM_FIELDS'
        throw error
      }
      const text = String(field.text ?? '')
      if (!text) {
        const error = new Error(`fillForm field ${field.index} requires text`)
        error.code = 'INVALID_FORM_FIELDS'
        throw error
      }
      const element = await this._elementForAction(entry, field.index, params._fanDecisionToken, 'fillForm')
      this._assertExpectedElement(
        element,
        field.expected || (field.expectedLabel || field.expected_label
          ? { label: field.expectedLabel || field.expected_label }
          : null),
        'fill form field'
      )
      resolved.push({ field, text, element })
    }

    const initialPageGeneration = Number(entry.selectorMap.pageGeneration) || 0
    const results = []
    let failure = null
    for (const item of resolved) {
      try {
        const typed = await this.type(id, {
          index: item.field.index,
          text: item.text,
          clear: item.field.clear !== false,
          typingMode: item.field.typingMode || item.field.typing_mode,
          delayMs: item.field.delayMs ?? item.field.delay_ms,
          autocompleteWait: item.field.autocompleteWait ?? item.field.autocomplete_wait,
          autocompleteWaitMs: item.field.autocompleteWaitMs ?? item.field.autocomplete_wait_ms,
          expected: item.field.expected,
          expectedLabel: item.field.expectedLabel || item.field.expected_label,
          _fanDecisionToken: params._fanDecisionToken,
          ...(params._fanProtectedInput === true ? { _fanProtectedInput: true } : {}),
          _resolvedElement: item.element,
          preserveSelectorMap: true
        })
        results.push({
          index: Number(item.field.index),
          status: 'completed',
          readback: typed?.readback || null,
          typingMode: typed?.typingMode || null
        })
      } catch (error) {
        failure = {
          index: Number(item.field.index),
          code: String(error?.code || 'FORM_FIELD_FAILED'),
          message: String(error?.message || error)
        }
        results.push({ index: Number(item.field.index), status: 'failed', errorCode: failure.code })
        break
      }
      if ((Number(entry.selectorMap.pageGeneration) || 0) !== initialPageGeneration) {
        failure = {
          index: Number(item.field.index),
          code: 'FORM_PAGE_CHANGED',
          message: 'The page changed while filling the form; remaining fields were not executed.'
        }
        break
      }
    }

    let observation = null
    let observationError = null
    if (params.preserveSelectorMap !== true) {
      try {
        observation = await this.observe(id, {})
      } catch (error) {
        observationError = String(error?.message || error)
      }
    }
    const status = failure ? (results.some(item => item.status === 'completed') ? 'partial' : 'failed') : 'completed'
    return {
      status,
      completedCount: results.filter(item => item.status === 'completed').length,
      fields: results,
      ...(failure ? { failedIndex: failure.index, errorCode: failure.code, error: failure.message } : {}),
      ...(observation ? { observation } : {}),
      ...(observationError ? { observationError } : {}),
      effect: observationError
        ? 'dom-structure'
        : (Number(entry.selectorMap.pageGeneration) || 0) === initialPageGeneration
          ? 'value-only'
          : (String(entry.selectorMap.reason || '') === 'dom.documentUpdated' ? 'dom-structure' : 'navigation')
    }
  }

  _formSubmitError(message, code = 'INVALID_FORM_SUBMIT', details = {}) {
    const error = new Error(String(message || 'Invalid stable form submission'))
    error.code = code
    error.details = {
      retryable: false,
      replanRequired: false,
      action: 'formSubmit',
      ...details
    }
    return error
  }

  _formSubmitIndex(value, label) {
    const index = Number(value)
    if (!Number.isSafeInteger(index) || index <= 0) {
      throw this._formSubmitError(`${label} requires a positive integer index`, 'INVALID_FORM_SUBMIT_INDEX')
    }
    return index
  }

  _assertOrdinaryFormTextField(element = {}, index) {
    const tag = String(element.tag || '').trim().toLowerCase()
    const attributes = element.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const type = String(element.type || attributes.type || '').trim().toLowerCase()
    const allowedInputTypes = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number'])
    const autocomplete = autocompleteMetadataFor(element)
    if (autocomplete.detected) {
      throw this._formSubmitError(
        `Element index ${index} is a dynamic autocomplete field (${autocomplete.mode}). ` +
        'fan.formSubmit accepts only stable text fields. Use fan.type, then make a fresh page decision. ' +
        'If the task requires a canonical entity, wait for and click one uniquely identified numbered ' +
        'suggestion (it may be an option, menuitem, link, or button). For free-text input, suggestions ' +
        'may be skipped. In either case, observe again and use only a fresh submit target if submission is required.',
        'AUTOCOMPLETE_DECISION_REQUIRED',
        {
          index,
          replanRequired: true,
          beforeDispatch: true,
          dispatchAttempted: false,
          reason: 'autocomplete-decision-required',
          type: autocomplete.mode
        }
      )
    }
    if (!((tag === 'input' && allowedInputTypes.has(type)) || tag === 'textarea')) {
      throw this._formSubmitError(
        `Element index ${index} is not an ordinary text field; use separate browser actions for dynamic or non-text controls.`,
        'UNSUPPORTED_FORM_FIELD',
        {
          index,
          replanRequired: true,
          beforeDispatch: true,
          dispatchAttempted: false
        }
      )
    }
    if (element.disabled) {
      throw this._formSubmitError(
        `Element index ${index} is disabled`,
        'ELEMENT_DISABLED',
        { index }
      )
    }
  }

  _assertStableFormSubmitElement(element = {}, index) {
    const tag = String(element.tag || '').trim().toLowerCase()
    const attributes = element.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const type = String(element.type || attributes.type || '').trim().toLowerCase()
    const role = String(element.role || attributes.role || '').trim().toLowerCase()
    const nativeSubmit = tag === 'button' || (tag === 'input' && ['submit', 'button', 'image'].includes(type))
    const semanticButton = role === 'button' && !['input', 'textarea', 'select', 'option'].includes(tag)
    if (!nativeSubmit && !semanticButton) {
      throw this._formSubmitError(
        `Element index ${index} is not a native button or a semantic role=button control.`,
        'UNSUPPORTED_FORM_SUBMIT_TARGET',
        { index }
      )
    }
    const backendNodeId = Number(element.backendNodeId)
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) {
      const error = this._formSubmitError(
        `Element index ${index} cannot be pinned to its original DOM node; observe again before submitting.`,
        'UNSTABLE_FORM_SUBMIT_TARGET',
        { index }
      )
      error.details.retryable = true
      error.details.replanRequired = true
      throw error
    }
  }

  _formSubmitElementType(element = {}) {
    const tag = String(element.tag || '').trim().toLowerCase()
    const attributes = element.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const type = String(element.type || attributes.type || '').trim().toLowerCase()
    return tag === 'button' && !type ? 'submit' : type
  }

  _formSubmitSemanticFingerprint(element = {}) {
    const semantic = this._elementSemantics(element)
    const attributes = element.attributes && typeof element.attributes === 'object'
      ? element.attributes
      : {}
    const tag = this._normalizedSemanticText(semantic.tag)
    const type = this._normalizedSemanticText(this._formSubmitElementType(element))
    const implicitRole = tag === 'button' || (tag === 'input' && ['button', 'submit', 'image'].includes(type))
      ? 'button'
      : ''
    return {
      tag,
      type,
      role: this._normalizedSemanticText(semantic.role || implicitRole),
      name: this._normalizedSemanticText(semantic.name),
      text: this._normalizedSemanticText(semantic.text),
      label: this._normalizedSemanticText(semantic.label),
      formAction: String(attributes.formaction || ''),
      formMethod: this._normalizedSemanticText(attributes.formmethod || ''),
      formTarget: String(attributes.formtarget || ''),
      href: String(attributes.href || ''),
      value: String(attributes.value || ''),
      inert: Boolean(element.inert)
    }
  }

  async _inspectPinnedFormSubmitTarget(entry, element = {}) {
    const backendNodeId = Number(element.backendNodeId)
    const sessionId = element.sessionId
    const result = await this._usingResolvedBackendNode(entry, backendNodeId, sessionId, objectId => (
      entry.client.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          const read = name => String(this.getAttribute && this.getAttribute(name) || '');
          const has = name => Boolean(this.hasAttribute && this.hasAttribute(name));
          const attributes = {
            'aria-label': read('aria-label'),
            'aria-hidden': read('aria-hidden'),
            name: read('name'),
            title: read('title'),
            placeholder: read('placeholder'),
            role: read('role'),
            type: read('type'),
            formaction: String(this.formAction || this.form?.action || read('formaction') || ''),
            formmethod: String(this.formMethod || this.form?.method || read('formmethod') || ''),
            formtarget: String(this.formTarget || this.form?.target || read('formtarget') || ''),
            href: String(this.href || read('href') || ''),
            value: String(this.value ?? read('value') ?? ''),
            inert: has('inert') ? 'true' : ''
          };
          let disabled = Boolean(this.disabled || read('disabled') || read('aria-disabled') === 'true');
          try {
            const fieldset = this.closest && this.closest('fieldset[disabled]');
            if (fieldset) disabled = true;
          } catch (_) {}
          let hidden = Boolean(this.hidden || read('aria-hidden') === 'true');
          try {
            const style = this.ownerDocument?.defaultView?.getComputedStyle(this);
            if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) hidden = true;
          } catch (_) {}
          return {
            connected: Boolean(this.isConnected && this.ownerDocument),
            disabled,
            hidden,
            inert: Boolean(this.inert || has('inert')),
            tag: this.tagName ? this.tagName.toLowerCase() : '',
            type: String(this.type || attributes.type || '').toLowerCase(),
            role: attributes.role || (
              /^(button)$/i.test(this.tagName || '') ||
              (/^input$/i.test(this.tagName || '') && /^(button|submit|image)$/i.test(this.type || attributes.type || ''))
                ? 'button'
                : ''
            ),
            text: String(this.innerText || this.textContent || attributes['aria-label'] || attributes.title || '')
              .replace(/\\s+/g, ' ').trim().slice(0, 500),
            attributes
          };
        }`,
        returnByValue: true
      }, sessionId)
    ))
    return result?.result?.value || null
  }

  _liveFormSubmitElement(pinned, inspection = {}) {
    return {
      ...pinned.element,
      index: pinned.index,
      backendNodeId: pinned.element.backendNodeId,
      sessionId: pinned.element.sessionId,
      tag: inspection.tag || '',
      type: inspection.type || '',
      role: inspection.role || '',
      text: inspection.text || '',
      attributes: inspection.attributes || {},
      disabled: Boolean(inspection.disabled),
      inert: Boolean(inspection.inert)
    }
  }

  _assertPinnedFormSubmitTarget(pinned, inspection, { requireAvailable = false } = {}) {
    if (!inspection || inspection.connected !== true) {
      throw this._staleElementError(
        pinned.index,
        `Submit element index ${pinned.index} is detached; the form was not submitted.`,
        'formSubmit',
        { beforeDispatch: true, dispatchAttempted: false }
      )
    }
    const liveElement = this._liveFormSubmitElement(pinned, inspection)
    this._assertExpectedElement(liveElement, pinned.expected, 'submit form')
    const liveFingerprint = this._formSubmitSemanticFingerprint(liveElement)
    const mismatches = pinned.fingerprint
      ? Object.keys(pinned.fingerprint).filter(key => pinned.fingerprint[key] !== liveFingerprint[key])
      : []
    if (mismatches.length) {
      const error = new Error(
        `Refusing to submit: the pinned submit target semantics changed (${mismatches.join(', ')}).`
      )
      error.code = 'CLICK_TARGET_MISMATCH'
      error.details = {
        retryable: true,
        replanRequired: true,
        action: 'formSubmit',
        beforeDispatch: true,
        dispatchAttempted: false,
        reason: mismatches.join(','),
        index: pinned.index,
        expected: pinned.fingerprint,
        actual: liveFingerprint
      }
      throw error
    }
    if (requireAvailable && (inspection.disabled || inspection.hidden || inspection.inert)) {
      const error = new Error(
        `Submit element index ${pinned.index} is not currently available; the form was not submitted.`
      )
      error.code = inspection.disabled ? 'ELEMENT_DISABLED' : 'ELEMENT_NOT_ACTIONABLE'
      error.details = {
        retryable: true,
        replanRequired: true,
        action: 'formSubmit',
        beforeDispatch: true,
        dispatchAttempted: false,
        reason: inspection.disabled ? 'disabled' : (inspection.inert ? 'inert' : 'hidden'),
        index: pinned.index
      }
      throw error
    }
    return liveElement
  }

  _formSubmitEffect(initialToken, finalToken, selectorReason, submitted, completedCount, structuralFailure = false) {
    if (!initialToken || !finalToken) return submitted ? 'dom-structure' : (completedCount ? 'value-only' : 'none')
    if (
      initialToken.activeTabId !== finalToken.activeTabId ||
      initialToken.tabListGeneration !== finalToken.tabListGeneration ||
      initialToken.viewEpoch !== finalToken.viewEpoch
    ) return 'tab-change'
    if (
      initialToken.documentRevision !== finalToken.documentRevision ||
      initialToken.pageGeneration !== finalToken.pageGeneration
    ) return String(selectorReason || '') === 'dom.documentUpdated' ? 'dom-structure' : 'navigation'
    if (structuralFailure) return 'dom-structure'
    if (initialToken.selectorGeneration !== finalToken.selectorGeneration || submitted) return 'dom-structure'
    return completedCount ? 'value-only' : 'none'
  }

  _formSubmitFailureProvenance(error, defaults = {}) {
    const details = error?.details && typeof error.details === 'object'
      ? error.details
      : {}
    const provenance = {}
    const read = (key, fallback) => (
      Object.prototype.hasOwnProperty.call(details, key) ? details[key] : fallback
    )
    const beforeDispatch = read('beforeDispatch', defaults.beforeDispatch)
    const dispatchAttempted = read('dispatchAttempted', defaults.dispatchAttempted)
    const reason = read('reason', defaults.reason)
    if (beforeDispatch !== undefined) provenance.beforeDispatch = beforeDispatch
    if (dispatchAttempted !== undefined) provenance.dispatchAttempted = Boolean(dispatchAttempted)
    if (reason != null && String(reason)) provenance.reason = String(reason)
    return provenance
  }

  _formSubmitMutationError(message, code, details = {}) {
    return this._formSubmitError(message, code, {
      retryable: true,
      replanRequired: true,
      beforeDispatch: true,
      dispatchAttempted: false,
      ...details
    })
  }

  _formSubmitMutationSessions(elements = []) {
    const sessions = [undefined]
    for (const element of elements) {
      const rawSessionId = element?.sessionId == null ? '' : String(element.sessionId).trim()
      const sessionId = rawSessionId || undefined
      if (!sessions.some(existing => existing === sessionId)) sessions.push(sessionId)
    }
    return sessions
  }

  _formSubmitMutationStateFactorySource() {
    const actionableAttributes = JSON.stringify([
      'action', 'aria-controls', 'aria-disabled', 'aria-expanded', 'aria-haspopup',
      'aria-hidden', 'aria-pressed', 'aria-selected', 'contenteditable', 'disabled',
      'for', 'form', 'formaction', 'formmethod', 'formtarget', 'hidden', 'href', 'id',
      'inert', 'method', 'name', 'open', 'popover', 'readonly', 'required', 'role',
      'src', 'tabindex', 'target', 'type', 'class', 'style'
    ])
    return `
      const __fanCreateFormSubmitMutationState = (candidateRoots, anchor) => {
        const attributes = ${actionableAttributes};
        if (typeof MutationObserver !== 'function') return { ok: false, reason: 'observer-unavailable' };
        const roots = [];
        for (const root of candidateRoots || []) {
          if (!root || typeof root.nodeType !== 'number') return { ok: false, reason: 'root-unavailable' };
          if (!roots.includes(root)) roots.push(root);
        }
        if (!roots.length) return { ok: false, reason: 'root-unavailable' };

        const elementFor = node => node && node.nodeType === 1
          ? node
          : node && node.parentElement;
        const isFanArtifact = node => {
          let element = elementFor(node);
          while (element) {
            const id = String(element.id || (element.getAttribute && element.getAttribute('id')) || '');
            const className = String((element.getAttribute && element.getAttribute('class')) || '');
            if (id.indexOf('__fan_') === 0 || className.indexOf('__fan_') !== -1) return true;
            element = element.parentElement;
          }
          return false;
        };
        const isOnlyFanChildMutation = record => {
          const nodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
          return nodes.length > 0 && nodes.every(isFanArtifact);
        };
        const dynamicSelector = [
          'input', 'textarea', 'select', 'button', 'option', 'optgroup', 'form', 'dialog',
          'a[href]', '[role]', '[aria-live]', '[aria-modal]', '[aria-controls]',
          '[aria-expanded]', '[aria-haspopup]', '[contenteditable]', '[popover]', '[tabindex]'
        ].join(',');
        const looksDynamic = node => {
          const element = elementFor(node);
          if (!element || isFanArtifact(element)) return false;
          try {
            if (element.matches && element.matches(dynamicSelector)) return true;
            if (element.querySelector && element.querySelector(dynamicSelector)) return true;
          } catch (_) {}
          try {
            const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
            if (style && (style.position === 'fixed' || style.position === 'absolute')) {
              const zIndex = Number(style.zIndex);
              if (Number.isFinite(zIndex) && zIndex > 0) return true;
            }
          } catch (_) {}
          return false;
        };
        const presentationMutationLooksDynamic = (record, insideLocalContainer = false) => {
          const element = elementFor(record?.target);
          if (!element || isFanArtifact(element)) return false;
          const tag = String(element.tagName || '').toLowerCase();
          // Typing commonly changes the class/style of the field itself.
          // Frameworks also decorate its parent wrapper as focused/dirty/valid.
          // Neither is proof that the interaction structure changed.
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
          const candidateSelector = [
            'dialog',
            '[role="listbox"]', '[role="option"]', '[role="menu"]', '[role="menuitem"]',
            '[role="tree"]', '[role="treeitem"]', '[role="dialog"]', '[role="alertdialog"]',
            '[aria-live]', '[aria-modal]', '[popover]'
          ].join(',');
          try {
            if (element.matches && element.matches(candidateSelector)) return true;
          } catch (_) {}

          const oldValue = String(record?.oldValue || '');
          const currentValue = String(
            element.getAttribute && element.getAttribute(record?.attributeName || '')
          );
          const hiddenClass = /(?:^|[\\s_-])(?:hidden|hide|invisible|collapsed|d-none|is-hidden)(?:$|[\\s_-])/i;
          const hiddenStyle = /(?:^|;)\\s*(?:display\\s*:\\s*none|visibility\\s*:\\s*hidden|opacity\\s*:\\s*0(?:[;\\s]|$))/i;
          const classHint = /(?:auto.?complete|suggest|result|option|listbox|dropdown|popup|menu)/i;
          const showToken = /(?:^|[\\s_-])(?:show|shown|visible|open|opened|expanded)(?:$|[\\s_-])/i;
          // A form's ordinary focused/dirty/valid/submitted decoration is not a
          // structural change. Some component libraries do use the form itself
          // as an autocomplete results container, so keep that narrow,
          // candidate-named case observable.
          if (
            tag === 'form' &&
            !classHint.test(String(element.id || '') + ' ' + oldValue + ' ' + currentValue)
          ) return false;
          const becamePresented = record?.attributeName === 'style'
            ? hiddenStyle.test(oldValue) && !hiddenStyle.test(currentValue)
            : (
                hiddenClass.test(oldValue) && !hiddenClass.test(currentValue)
              ) || (
                classHint.test(String(element.id || '') + ' ' + oldValue + ' ' + currentValue) &&
                !showToken.test(oldValue) &&
                showToken.test(currentValue)
              );
          if (!becamePresented) return false;
          if (insideLocalContainer) return true;

          // A hidden container becoming visible is structural when it exposes
          // candidate-like semantics, actionable descendants, or meaningful
          // candidate text. Merely decorating a stable field wrapper as
          // focused/dirty/valid never reaches this branch.
          try {
            if (element.querySelector && element.querySelector(
              candidateSelector + ',button,option,a[href],[tabindex],[contenteditable]'
            )) return true;
          } catch (_) {}
          if (String(element.textContent || '').replace(/\\s+/g, ' ').trim()) return true;
          try {
            const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
            if (style && (style.position === 'fixed' || style.position === 'absolute')) {
              const zIndex = Number(style.zIndex);
              if (Number.isFinite(zIndex) && zIndex > 0) return true;
            }
          } catch (_) {}
          return false;
        };

        let localRoot = null;
        let localContainer = null;
        if (anchor) {
          try { localRoot = anchor.getRootNode ? anchor.getRootNode() : anchor.ownerDocument; } catch (_) {}
          try {
            localContainer = (anchor.closest && anchor.closest('form')) ||
              (localRoot && localRoot.nodeType === 11 ? localRoot : anchor.parentElement);
          } catch (_) {
            localContainer = anchor.parentElement || null;
          }
        }
        const contains = (container, node) => {
          if (!container || !node) return false;
          if (container === node) return true;
          try { return Boolean(container.contains && container.contains(node)); } catch (_) { return false; }
        };
        const touchesLocalContainer = record => {
          if (!localContainer) return false;
          if (contains(localContainer, record.target)) return true;
          const nodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
          return nodes.some(node => contains(localContainer, node) || contains(node, localContainer));
        };
        const isRelevant = record => {
          if (isFanArtifact(record.target)) return false;
          if (record.type === 'childList' && isOnlyFanChildMutation(record)) return false;
          if (touchesLocalContainer(record)) {
            if (record.type === 'attributes') {
              if (!attributes.includes(record.attributeName)) return false;
              if (record.attributeName === 'class' || record.attributeName === 'style') {
                return presentationMutationLooksDynamic(record, true);
              }
              return true;
            }
            if (record.type === 'characterData') return looksDynamic(record.target);
            if (record.type === 'childList') {
              const nodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
              const addedMeaningfulElement = Array.from(record.addedNodes || []).some(node => (
                node &&
                node.nodeType === 1 &&
                !isFanArtifact(node) &&
                String(node.textContent || '').replace(/\\s+/g, ' ').trim()
              ));
              return nodes.some(looksDynamic) ||
                addedMeaningfulElement ||
                (elementFor(record.target)?.tagName?.toLowerCase() !== 'form' &&
                  looksDynamic(record.target));
            }
            return false;
          }
          if (record.type === 'attributes') {
            if (!attributes.includes(record.attributeName)) return false;
            if (record.attributeName === 'class' || record.attributeName === 'style') {
              return presentationMutationLooksDynamic(record);
            }
            return looksDynamic(record.target);
          }
          if (record.type === 'characterData') return looksDynamic(record.target);
          if (record.type === 'childList') {
            const nodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
            return nodes.some(looksDynamic);
          }
          return false;
        };

        const state = {
          ok: true,
          changed: false,
          count: 0,
          first: null,
          observer: null,
          roots,
          anchor: anchor || null,
          rootsAvailable() {
            if (this.anchor && this.anchor.isConnected === false) return false;
            return this.roots.every(root => {
              if (!root || typeof root.nodeType !== 'number') return false;
              if (root.nodeType === 9) return Boolean(root.documentElement && root.defaultView);
              return root.isConnected !== false;
            });
          },
          consume(records) {
            for (const record of records || []) {
              if (!isRelevant(record)) continue;
              this.changed = true;
              this.count += 1;
              if (!this.first) {
                const target = elementFor(record.target);
                this.first = {
                  type: String(record.type || ''),
                  attribute: String(record.attributeName || ''),
                  targetTag: target && target.tagName ? target.tagName.toLowerCase() : ''
                };
              }
            }
          }
        };
        try {
          state.observer = new MutationObserver(records => state.consume(records));
          for (const root of roots) {
            state.observer.observe(root, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
              attributeOldValue: true,
              attributeFilter: attributes
            });
          }
        } catch (error) {
          try { state.observer?.disconnect(); } catch (_) {}
          return { ok: false, reason: 'observer-install-failed', error: String(error?.message || error) };
        }
        return state;
      };
    `
  }

  async _installFormSubmitMutationWatch(entry, elements = []) {
    this._formSubmitMutationWatchSequence = Math.max(
      0,
      Number(this._formSubmitMutationWatchSequence) || 0
    ) + 1
    const token = `${this._sessionIdForEntry(entry)}:${Date.now()}:${this._formSubmitMutationWatchSequence}`
    const sessions = this._formSubmitMutationSessions(elements)
    const installedSessions = []
    const installedRoots = []
    const registryKey = JSON.stringify(FORM_SUBMIT_MUTATION_REGISTRY)
    const encodedToken = JSON.stringify(token)
    const stateFactory = this._formSubmitMutationStateFactorySource()
    const expression = `(() => {
      const registryKey = ${registryKey};
      const token = ${encodedToken};
      ${stateFactory}
      if (!document) return { ok: false, reason: 'document-unavailable' };
      let registry = globalThis[registryKey];
      if (!registry || typeof registry !== 'object') {
        registry = Object.create(null);
        globalThis[registryKey] = registry;
      }
      const prior = registry[token];
      if (prior && prior.observer) prior.observer.disconnect();
      const state = __fanCreateFormSubmitMutationState([document], null);
      if (!state?.ok) return state || { ok: false, reason: 'observer-install-failed' };
      registry[token] = state;
      return { ok: true, rootCount: state.roots.length };
    })()`

    const rootFunctionDeclaration = `function(token, registryKey) {
      ${stateFactory}
      if (!this || !this.ownerDocument || typeof this.getRootNode !== 'function') {
        return { ok: false, reason: 'element-root-unavailable' };
      }
      let registry = this[registryKey];
      if (!registry || typeof registry !== 'object') {
        registry = Object.create(null);
        try {
          Object.defineProperty(this, registryKey, {
            value: registry,
            configurable: true,
            enumerable: false,
            writable: false
          });
        } catch (error) {
          return { ok: false, reason: 'element-registry-unavailable', error: String(error?.message || error) };
        }
      }
      const prior = registry[token];
      if (prior && prior.observer) prior.observer.disconnect();
      let root = null;
      try { root = this.getRootNode(); } catch (_) {}
      const state = __fanCreateFormSubmitMutationState([this.ownerDocument, root], this);
      if (!state?.ok) return state || { ok: false, reason: 'observer-install-failed' };
      registry[token] = state;
      return { ok: true, rootCount: state.roots.length };
    }`

    try {
      for (const sessionId of sessions) {
        const result = await entry.client.send('Runtime.evaluate', {
          expression,
          returnByValue: true
        }, sessionId)
        if (result?.result?.value?.ok !== true) {
          throw new Error(String(result?.result?.value?.reason || 'observer-install-failed'))
        }
        installedSessions.push(sessionId)
      }
      for (const element of elements) {
        const backendNodeId = Number(element?.backendNodeId)
        if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) {
          throw new Error(`element ${Number(element?.index) || 0} has no stable backend node`)
        }
        const rawSessionId = element?.sessionId == null ? '' : String(element.sessionId).trim()
        const sessionId = rawSessionId || undefined
        const result = await this._usingResolvedBackendNode(entry, backendNodeId, sessionId, objectId => (
          entry.client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: rootFunctionDeclaration,
            arguments: [{ value: token }, { value: FORM_SUBMIT_MUTATION_REGISTRY }],
            returnByValue: true
          }, sessionId)
        ))
        if (result?.result?.value?.ok !== true) {
          throw new Error(String(result?.result?.value?.reason || 'element-root-observer-install-failed'))
        }
        installedRoots.push({ backendNodeId, sessionId })
      }
    } catch (error) {
      await this._disposeFormSubmitMutationWatch(entry, {
        token,
        sessions: installedSessions,
        roots: installedRoots
      })
      throw this._formSubmitMutationError(
        'Stable form submission could not install its DOM mutation guard.',
        'FORM_SUBMIT_MUTATION_WATCH_UNAVAILABLE',
        { reason: 'mutation-watch-unavailable', cause: String(error?.message || error) }
      )
    }
    return { token, sessions, roots: installedRoots }
  }

  async _readFormSubmitMutationWatch(entry, watch) {
    if (!watch?.token || !Array.isArray(watch.sessions)) return null
    const registryKey = JSON.stringify(FORM_SUBMIT_MUTATION_REGISTRY)
    const encodedToken = JSON.stringify(String(watch.token))
    const expression = `(() => {
      const registry = globalThis[${registryKey}];
      const state = registry && registry[${encodedToken}];
      if (!state || !state.observer || typeof state.consume !== 'function') {
        return { ok: false, reason: 'watch-missing' };
      }
      state.consume(state.observer.takeRecords());
      if (typeof state.rootsAvailable === 'function' && !state.rootsAvailable()) {
        return { ok: false, reason: 'root-unavailable' };
      }
      return { ok: true, changed: Boolean(state.changed), count: Number(state.count) || 0, first: state.first || null };
    })()`
    const states = []
    for (const sessionId of watch.sessions) {
      const result = await entry.client.send('Runtime.evaluate', {
        expression,
        returnByValue: true
      }, sessionId).catch(() => null)
      const value = result?.result?.value
      if (!value?.ok) return null
      states.push({ kind: 'document', sessionId, ...value })
    }
    const roots = Array.isArray(watch.roots) ? watch.roots : []
    const rootFunctionDeclaration = `function(token, registryKey) {
      const registry = this && this[registryKey];
      const state = registry && registry[token];
      if (!state || !state.observer || typeof state.consume !== 'function') {
        return { ok: false, reason: 'watch-missing' };
      }
      state.consume(state.observer.takeRecords());
      if (typeof state.rootsAvailable === 'function' && !state.rootsAvailable()) {
        return { ok: false, reason: 'root-unavailable' };
      }
      return { ok: true, changed: Boolean(state.changed), count: Number(state.count) || 0, first: state.first || null };
    }`
    const rootStates = await Promise.all(roots.map(async root => {
      const result = await this._usingResolvedBackendNode(
        entry,
        root.backendNodeId,
        root.sessionId,
        objectId => entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: rootFunctionDeclaration,
          arguments: [{ value: String(watch.token) }, { value: FORM_SUBMIT_MUTATION_REGISTRY }],
          returnByValue: true
        }, root.sessionId)
      ).catch(() => null)
      const value = result?.result?.value
      return value?.ok ? { kind: 'element-root', ...root, ...value } : null
    }))
    if (rootStates.some(state => !state)) return null
    states.push(...rootStates)
    return states
  }

  async _assertFormSubmitMutationWatch(entry, watch) {
    if (!watch) return
    const states = await this._readFormSubmitMutationWatch(entry, watch)
    if (!states) {
      throw this._formSubmitMutationError(
        'Stable form submission lost its DOM mutation guard before submit.',
        'FORM_SUBMIT_MUTATION_WATCH_UNAVAILABLE',
        { reason: 'mutation-watch-unavailable' }
      )
    }
    const changed = states.find(state => state.changed)
    if (!changed) return
    throw this._formSubmitMutationError(
      'The page structure changed while form fields were being entered; the form was not submitted.',
      'FORM_SUBMIT_DOM_MUTATED',
      {
        reason: 'dom-mutated',
        mutation: changed.first || null,
        mutationCount: changed.count
      }
    )
  }

  async _disposeFormSubmitMutationWatch(entry, watch) {
    if (!watch?.token || !Array.isArray(watch.sessions)) return
    const registryKey = JSON.stringify(FORM_SUBMIT_MUTATION_REGISTRY)
    const encodedToken = JSON.stringify(String(watch.token))
    const expression = `(() => {
      const registry = globalThis[${registryKey}];
      const state = registry && registry[${encodedToken}];
      if (state && state.observer) state.observer.disconnect();
      if (registry) delete registry[${encodedToken}];
      if (registry && Object.keys(registry).length === 0) {
        try { delete globalThis[${registryKey}]; } catch (_) {}
      }
      return { ok: true };
    })()`
    await Promise.all(watch.sessions.map(sessionId => (
      entry.client.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId).catch(() => null)
    )))
    const rootFunctionDeclaration = `function(token, registryKey) {
      const registry = this && this[registryKey];
      const state = registry && registry[token];
      if (state && state.observer) state.observer.disconnect();
      if (registry) delete registry[token];
      if (registry && Object.keys(registry).length === 0) {
        try { delete this[registryKey]; } catch (_) {}
      }
      return { ok: true };
    }`
    const roots = Array.isArray(watch.roots) ? watch.roots : []
    await Promise.all(roots.map(root => (
      this._usingResolvedBackendNode(entry, root.backendNodeId, root.sessionId, objectId => (
        entry.client.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: rootFunctionDeclaration,
          arguments: [{ value: String(watch.token) }, { value: FORM_SUBMIT_MUTATION_REGISTRY }],
          returnByValue: true
        }, root.sessionId)
      )).catch(() => null)
    )))
  }

  _formSubmitControlLease(entry) {
    const state = this._controlStates?.get(this._sessionIdForEntry(entry))
    return state?.active ? state : null
  }

  _assertFormSubmitControlLease(entry, lease, { beforeDispatch = true } = {}) {
    if (!lease) return
    const current = this._controlStates?.get(this._sessionIdForEntry(entry))
    if (current === lease && current?.active) return
    const error = new Error('Stable form submission was cancelled before the submit click.')
    error.code = 'FORM_SUBMIT_CANCELLED'
    error.details = {
      retryable: false,
      replanRequired: true,
      beforeDispatch: Boolean(beforeDispatch),
      dispatchAttempted: false,
      action: 'formSubmit',
      reason: 'browser-control-ended'
    }
    throw error
  }

  async _clickPinnedFormSubmit(
    entry,
    pinned,
    liveElement,
    params,
    controlLease = null,
    mutationWatch = null
  ) {
    const validationError = this._clickValidationError(liveElement)
    if (validationError) throw new Error(validationError)
    this._assertEntryDecisionToken(entry, params, 'formSubmit')
    const sessionId = liveElement.sessionId
    this.eventBus.emit(EVENT_TYPES.ACTION_STARTED, {
      id: entry.id,
      action: 'click',
      index: pinned.index,
      transaction: 'formSubmit'
    })
    try {
      const beforeClick = async (clickPoint = {}) => {
        try {
          this._assertFormSubmitControlLease(entry, controlLease, { beforeDispatch: true })
          this._assertEntryDecisionToken(entry, params, 'formSubmit')
          const inspection = await this._inspectPinnedFormSubmitTarget(entry, pinned.element)
          this._assertEntryDecisionToken(entry, params, 'formSubmit')
          this._assertPinnedFormSubmitTarget(pinned, inspection, { requireAvailable: true })

          // Geometry preflight happens before cursor movement. Re-test the
          // actual point at the irreversible boundary so a late overlay cannot
          // receive the native click. Unlike ordinary browser_click, an
          // indeterminate result is unsafe for this atomic form transaction.
          const x = Number(clickPoint.x)
          const y = Number(clickPoint.y)
          let hit = null
          if (Number.isFinite(x) && Number.isFinite(y)) {
            hit = await this._hitTestBackendNode(
              entry,
              pinned.element,
              x,
              y,
              clickPoint.sessionId ?? sessionId
            )
          }
          if (!hit || typeof hit.occluded !== 'boolean' || (!hit.occluded && !String(hit.hitTag || ''))) {
            throw this._failClosedClickError(pinned.element, 'hit-test-unavailable')
          }
          if (hit.occluded) {
            const error = this._failClosedClickError(pinned.element, 'occluded')
            if (hit.hitTag) error.details.hitTag = String(hit.hitTag)
            throw error
          }

          // Drain the continuously-installed DOM observer after every other
          // asynchronous pre-dispatch check. This is the last renderer round
          // trip before mousePressed and closes the late-suggestion/overlay
          // mutation window without treating ordinary input.value or focus
          // styling as structural changes.
          await this._assertFormSubmitMutationWatch(entry, mutationWatch)

          // All renderer inspections yield to the event loop. Re-check decision
          // and control state synchronously after the last one, immediately
          // before returning to the mousePressed dispatch.
          this._assertEntryDecisionToken(entry, params, 'formSubmit')
          this._assertFormSubmitControlLease(entry, controlLease, { beforeDispatch: true })
        } catch (error) {
          const existingDetails = error?.details && typeof error.details === 'object'
            ? error.details
            : {}
          error.details = {
            retryable: existingDetails.retryable ?? true,
            ...existingDetails,
            replanRequired: true,
            action: 'formSubmit',
            beforeDispatch: true,
            dispatchAttempted: false
          }
          throw error
        }
      }
      const clickParams = {
        ...params,
        allowOccluded: false,
        _fanBeforeClick: beforeClick,
        _fanFailClosedClick: true
      }
      const toggleBefore = await this._readToggleState(entry, liveElement, sessionId).catch(() => null)
      const result = await this._clickResolvedElement(entry, liveElement, sessionId, clickParams, toggleBefore)
      await this._settleAfterClick(entry, clickParams)
      return result
    } catch (error) {
      this.eventBus.emit(EVENT_TYPES.ACTION_FAILED, {
        id: entry.id,
        action: 'click',
        index: pinned.index,
        transaction: 'formSubmit',
        error: error.message
      })
      throw error
    }
  }

  async formSubmit(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    if (!params._fanDecisionToken || typeof params._fanDecisionToken !== 'object' || Array.isArray(params._fanDecisionToken)) {
      throw this._formSubmitError(
        'formSubmit requires the decision token from the observation that supplied its indices.',
        'BROWSER_DECISION_TOKEN_REQUIRED'
      )
    }
    this._assertEntryDecisionToken(entry, params, 'formSubmit')
    const initialToken = this._browserDecisionToken(this._sessionIdForEntry(entry))
    if (!initialToken) {
      throw this._formSubmitError('No active browser decision is available.', 'BROWSER_DECISION_TOKEN_REQUIRED')
    }
    const transactionParams = { ...params, _fanDecisionToken: initialToken }
    const controlLease = this._formSubmitControlLease(entry)
    this._assertFormSubmitControlLease(entry, controlLease)
    const fields = Array.isArray(params.fields) ? params.fields : []
    if (!fields.length || fields.length > 50) {
      throw this._formSubmitError('formSubmit requires between 1 and 50 fields', 'INVALID_FORM_FIELDS')
    }
    if (!params.submit || typeof params.submit !== 'object' || Array.isArray(params.submit)) {
      throw this._formSubmitError('formSubmit requires one indexed submit target')
    }

    const submitIndex = this._formSubmitIndex(params.submit.index, 'formSubmit submit')
    const seen = new Set([submitIndex])
    const resolvedFields = []
    for (const field of fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw this._formSubmitError('Each formSubmit field must be an object', 'INVALID_FORM_FIELDS')
      }
      const index = this._formSubmitIndex(field.index, 'Each formSubmit field')
      if (seen.has(index)) {
        throw this._formSubmitError(`formSubmit index ${index} is duplicated`, 'DUPLICATE_FORM_INDEX', { index })
      }
      seen.add(index)
      const text = String(field.text ?? '')
      if (!text) {
        throw this._formSubmitError(`formSubmit field ${index} requires text`, 'INVALID_FORM_FIELDS', { index })
      }
      const element = await this._elementForAction(entry, index, initialToken, 'formSubmit')
      this._assertOrdinaryFormTextField(element, index)
      this._assertExpectedElement(
        element,
        field.expected || (field.expectedLabel || field.expected_label
          ? { label: field.expectedLabel || field.expected_label }
          : null),
        'fill form field'
      )
      resolvedFields.push({ field, index, text, element })
    }

    const submitElement = entry.selectorMap?.get?.(submitIndex)
    if (!submitElement) {
      const error = new Error(`Submit element index ${submitIndex} is not available in the current browser snapshot.`)
      error.code = 'ELEMENT_NOT_FOUND'
      error.details = {
        retryable: true,
        replanRequired: true,
        action: 'formSubmit',
        index: submitIndex
      }
      throw error
    }
    this._assertStableFormSubmitElement(submitElement, submitIndex)
    const expected = params.submit.expected || null
    this._assertExpectedElement(submitElement, expected, 'submit form')
    const pinnedSubmit = {
      index: submitIndex,
      element: submitElement,
      expected,
      fingerprint: Object.fromEntries(
        Object.entries(this._formSubmitSemanticFingerprint(submitElement))
          .filter(([key]) => ['tag', 'type', 'role', 'name', 'text', 'label'].includes(key))
      )
    }
    this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
    const initialInspection = await this._inspectPinnedFormSubmitTarget(entry, submitElement)
    this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
    const initialLiveSubmitElement = this._assertPinnedFormSubmitTarget(
      pinnedSubmit,
      initialInspection,
      { requireAvailable: true }
    )
    pinnedSubmit.fingerprint = this._formSubmitSemanticFingerprint(initialLiveSubmitElement)

    const fieldResults = []
    let failure = null
    let submitResult = null
    const mutationWatch = await this._installFormSubmitMutationWatch(
      entry,
      [...resolvedFields.map(item => item.element), submitElement]
    )
    try {
      await this._assertFormSubmitMutationWatch(entry, mutationWatch)
      this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
      for (const item of resolvedFields) {
        try {
          this._assertFormSubmitControlLease(entry, controlLease)
          const typed = await this.type(id, {
            index: item.index,
            text: item.text,
            clear: item.field.clear !== false,
            typingMode: item.field.typingMode || item.field.typing_mode,
            delayMs: item.field.delayMs ?? item.field.delay_ms,
            autocompleteWait: false,
            expected: item.field.expected,
            expectedLabel: item.field.expectedLabel || item.field.expected_label,
            _fanDecisionToken: initialToken,
            ...(params._fanProtectedInput === true ? { _fanProtectedInput: true } : {}),
            _resolvedElement: item.element,
            preserveSelectorMap: true
          })
          if (!typed?.readback || typed.readback.skipped === true) {
            throw this._formSubmitError(
              `Could not verify the value written to form field ${item.index}; the form was not submitted.`,
              'FORM_FIELD_READBACK_FAILED',
              { index: item.index, retryable: true, replanRequired: true }
            )
          }
          if (typed.readback.valueMatches !== true) {
            throw this._formSubmitError(
              `The value written to form field ${item.index} did not match the requested text; the form was not submitted.`,
              'FORM_FIELD_READBACK_MISMATCH',
              { index: item.index, retryable: true, replanRequired: true }
            )
          }
          fieldResults.push({
            index: item.index,
            status: 'completed',
            readback: typed?.readback || null,
            typingMode: typed?.typingMode || null
          })
          await this._assertFormSubmitMutationWatch(entry, mutationWatch)
          this._assertFormSubmitControlLease(entry, controlLease)
          this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
        } catch (error) {
          const provenance = this._formSubmitFailureProvenance(error, {
            beforeDispatch: true,
            dispatchAttempted: false
          })
          failure = {
            code: String(error?.code || 'FORM_FIELD_FAILED'),
            message: String(error?.message || error),
            index: item.index,
            ...provenance
          }
          if (!fieldResults.some(result => result.index === item.index)) {
            fieldResults.push({ index: item.index, status: 'failed', errorCode: failure.code })
          }
          break
        }
      }

      submitResult = {
        index: submitIndex,
        status: 'skipped',
        reason: failure?.reason || (failure ? 'field-or-page-state-changed' : 'not-attempted'),
        ...(failure ? {
          beforeDispatch: true,
          dispatchAttempted: false
        } : {})
      }
      if (!failure) {
        let liveSubmitElement = null
        try {
          await this._assertFormSubmitMutationWatch(entry, mutationWatch)
          this._assertFormSubmitControlLease(entry, controlLease)
          this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
          const finalInspection = await this._inspectPinnedFormSubmitTarget(entry, submitElement)
          this._assertEntryDecisionToken(entry, transactionParams, 'formSubmit')
          liveSubmitElement = this._assertPinnedFormSubmitTarget(
            pinnedSubmit,
            finalInspection,
            { requireAvailable: true }
          )
          await this._assertFormSubmitMutationWatch(entry, mutationWatch)
        } catch (error) {
          const provenance = this._formSubmitFailureProvenance(error, {
            beforeDispatch: true,
            dispatchAttempted: false,
            reason: 'page-or-submit-state-changed'
          })
          failure = {
            code: String(error?.code || 'FORM_STATE_CHANGED'),
            message: String(error?.message || error),
            index: submitIndex,
            ...provenance
          }
          submitResult = {
            index: submitIndex,
            status: 'skipped',
            reason: provenance.reason || 'page-or-submit-state-changed',
            errorCode: failure.code,
            ...provenance
          }
        }
        if (!failure) {
          try {
            const clickResult = await this._clickPinnedFormSubmit(
              entry,
              pinnedSubmit,
              liveSubmitElement,
              {
                _fanDecisionToken: initialToken,
                allowOccluded: false
              },
              controlLease,
              mutationWatch
            )
            submitResult = { index: submitIndex, status: 'completed', result: clickResult }
          } catch (error) {
            const provenance = this._formSubmitFailureProvenance(error)
            failure = {
              code: String(error?.code || 'FORM_SUBMIT_FAILED'),
              message: String(error?.message || error),
              index: submitIndex,
              ...provenance
            }
            const skippedBeforeDispatch = (
              provenance.beforeDispatch === true && provenance.dispatchAttempted !== true
            )
            submitResult = skippedBeforeDispatch
              ? {
                  index: submitIndex,
                  status: 'skipped',
                  reason: provenance.reason || 'page-or-submit-state-changed',
                  errorCode: failure.code,
                  ...provenance
                }
              : {
                  index: submitIndex,
                  status: 'failed',
                  reason: provenance.reason || 'submit-failed',
                  errorCode: failure.code,
                  ...provenance
                }
          }
        }
      } else {
        submitResult.errorCode = failure.code
      }
    } finally {
      await this._disposeFormSubmitMutationWatch(entry, mutationWatch)
    }

    const sessionId = this._sessionIdForEntry(entry)
    const beforeObservationToken = this._browserDecisionToken(sessionId)
    const selectorReason = String(
      this.workbenches.get(String(beforeObservationToken?.activeTabId || entry.id))?.selectorMap?.reason ||
      entry.selectorMap?.reason ||
      ''
    )
    let observation = null
    let observationError = null
    try {
      observation = await this.observe(this._activeTabId(sessionId), {})
    } catch (error) {
      observationError = String(error?.message || error)
    }
    const completedCount = fieldResults.filter(result => result.status === 'completed').length
    const submitted = submitResult.status === 'completed'
    const replanRequired = !submitted || Boolean(observationError)
    return {
      status: submitted ? 'completed' : 'replan-required',
      fields: fieldResults,
      submit: submitResult,
      completedCount,
      ...(replanRequired ? { replanRequired: true } : {}),
      ...(failure ? { errorCode: failure.code, error: failure.message } : {}),
      ...(failure?.beforeDispatch !== undefined ? { beforeDispatch: failure.beforeDispatch } : {}),
      ...(failure?.dispatchAttempted !== undefined ? { dispatchAttempted: failure.dispatchAttempted } : {}),
      ...(failure?.reason ? { reason: failure.reason } : {}),
      ...(observation ? { observation } : {}),
      ...(observationError ? { observationError } : {}),
      effect: this._formSubmitEffect(
        initialToken,
        beforeObservationToken,
        selectorReason,
        submitted,
        completedCount,
        submitResult.status === 'skipped' && failure?.index === submitIndex
      )
    }
  }
}

const inputOperationDescriptors = Object.getOwnPropertyDescriptors(InputOperations.prototype)
delete inputOperationDescriptors.constructor

function installInputOperations(Runtime) {
  Object.defineProperties(Runtime.prototype, inputOperationDescriptors)
}

module.exports = { installInputOperations }
