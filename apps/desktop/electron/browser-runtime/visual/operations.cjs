'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')

class VisualOperations {
  async highlight(id, params = {}) {
    const entry = this.getWorkbench(id)
    await this._prepare(entry)
    this._assertEntryDecisionToken(entry, params, 'highlight')
    if (params.clear === true) {
      await this._removeHighlightOverlays(entry)
      return { highlighted: 0, cleared: true }
    }
    let elements = []
    if (params.index != null) {
      elements = [await this._elementForAction(entry, params.index, params._fanDecisionToken, 'highlight')]
    } else {
      if (!entry.selectorMap.size) await this.observe(entry.id)
      //limit 省略=全部(视觉模型才能看到高 index 的控件,
      // 如底部发送键);仅当调用方显式传 limit>0 才截取。删掉旧的 Math.min(200) 硬上限。
      const _all = entry.selectorMap.snapshot().elements
      const _lim = Number(params.limit) > 0 ? Number(params.limit) : _all.length
      elements = _all.slice(0, Math.max(1, _lim))
    }
    const result = await this._highlightElements(entry, elements, params)
    return result
  }

  async _highlightElements(entry, elements = [], params = {}) {
    const items = elements
      .filter(element => element && element.rect)
      .map(element => ({
        index: element.index,
        text: String(element.text || element.tag || '').slice(0, 80),
        left: Number(element.rect.left ?? element.rect.x ?? 0),
        top: Number(element.rect.top ?? element.rect.y ?? 0),
        width: Math.max(8, Number(element.rect.width || 0)),
        height: Math.max(8, Number(element.rect.height || 0))
      }))
    const sessionId = elements.find(element => element?.sessionId)?.sessionId
    await entry.client.send('Runtime.evaluate', {
      expression: `(() => {
        const existing = document.getElementById('__fan_browser_runtime_highlights');
        if (existing) existing.remove();
        if (${params.clear === true ? 'true' : 'false'}) return { highlighted: 0, cleared: true };
        const items = ${JSON.stringify(items)};
        const container = document.createElement('div');
        container.id = '__fan_browser_runtime_highlights';
        // SHC-2:用 absolute(文档相对)而非 fixed(视口相对)。box 的 left/top 是文档绝对坐标
        // (增强快照 DOMSnapshot bounds 含 scroll),fixed 在 scroll>0 时会整体错位;absolute 自洽。
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.width = '100%';
        container.style.height = '100%';
        container.style.pointerEvents = 'none';
        container.style.zIndex = '2147483647';
        container.style.fontFamily = 'Inter, system-ui, sans-serif';
        const color = ${JSON.stringify(params.color || '#0ea5e9')};
        for (const item of items) {
          const box = document.createElement('div');
          box.style.position = 'absolute';
          box.style.left = item.left + 'px';
          box.style.top = item.top + 'px';
          box.style.width = item.width + 'px';
          box.style.height = item.height + 'px';
          box.style.border = '2px solid ' + color;
          box.style.borderRadius = '4px';
          box.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.9), 0 4px 14px rgba(0,0,0,0.18)';
          box.style.background = 'transparent';
          const label = document.createElement('div');
          label.textContent = String(item.index);
          label.style.position = 'absolute';
          label.style.left = '-2px';
          label.style.top = '-22px';
          label.style.minWidth = '18px';
          label.style.height = '18px';
          label.style.padding = '0 5px';
          label.style.borderRadius = '4px';
          label.style.background = color;
          label.style.color = '#fff';
          label.style.fontSize = '12px';
          label.style.lineHeight = '18px';
          label.style.fontWeight = '700';
          label.style.boxSizing = 'border-box';
          box.appendChild(label);
          container.appendChild(box);
        }
        // SHC-2:挂到 body(absolute 定位上下文,与 BU 一致);无 body 时回落 documentElement。
        (document.body || document.documentElement).appendChild(container);
        return { highlighted: items.length, cleared: false };
      })()`,
      returnByValue: true
    }, sessionId)
    return { highlighted: items.length, cleared: Boolean(params.clear) }
  }

  async _removeHighlightOverlays(entry, sessionId = undefined) {
    if (!entry.client?.send) return
    const sessionIds = new Set([undefined])
    if (sessionId) sessionIds.add(sessionId)
    let attachedTargets = []
    try {
      attachedTargets =
        typeof entry.targetManager?.attachedTargets === 'function' ? entry.targetManager.attachedTargets() : []
    } catch {
      attachedTargets = []
    }
    for (const target of attachedTargets) {
      if (target?.sessionId) sessionIds.add(target.sessionId)
    }
    const expression = `(() => {
      const existing = document.getElementById('__fan_browser_runtime_highlights');
      if (existing) existing.remove();
      return true;
    })()`
    await Promise.all(
      Array.from(sessionIds).map(targetSessionId =>
        entry.client
          .send('Runtime.evaluate', { expression, returnByValue: true }, targetSessionId)
          .catch(() => undefined)
      )
    )
  }

  async _setHighlightOverlaysHidden(entry, hidden, sessionId = undefined) {
    if (!entry.client?.send) return
    const sessionIds = new Set([undefined])
    if (sessionId) sessionIds.add(sessionId)
    let attachedTargets = []
    try {
      attachedTargets =
        typeof entry.targetManager?.attachedTargets === 'function' ? entry.targetManager.attachedTargets() : []
    } catch {
      attachedTargets = []
    }
    for (const target of attachedTargets) {
      if (target?.sessionId) sessionIds.add(target.sessionId)
    }
    const expression = `(() => {
      const existing = document.getElementById('__fan_browser_runtime_highlights');
      if (!existing) return true;
      const depthAttribute = 'data-fan-screenshot-hide-depth';
      const valueAttribute = 'data-fan-screenshot-visibility-value';
      const priorityAttribute = 'data-fan-screenshot-visibility-priority';
      const hidden = ${hidden ? 'true' : 'false'};
      const depth = Math.max(0, Number(existing.getAttribute(depthAttribute)) || 0);
      if (hidden) {
        if (depth === 0) {
          existing.setAttribute(valueAttribute, existing.style.getPropertyValue('visibility'));
          existing.setAttribute(priorityAttribute, existing.style.getPropertyPriority('visibility'));
          existing.style.setProperty('visibility', 'hidden', 'important');
        }
        existing.setAttribute(depthAttribute, String(depth + 1));
        return true;
      }
      if (depth > 1) {
        existing.setAttribute(depthAttribute, String(depth - 1));
        return true;
      }
      if (depth === 1) {
        const previousValue = existing.getAttribute(valueAttribute) || '';
        const previousPriority = existing.getAttribute(priorityAttribute) || '';
        if (previousValue) existing.style.setProperty('visibility', previousValue, previousPriority);
        else existing.style.removeProperty('visibility');
        existing.removeAttribute(depthAttribute);
        existing.removeAttribute(valueAttribute);
        existing.removeAttribute(priorityAttribute);
      }
      return true;
    })()`
    await Promise.all(
      Array.from(sessionIds).map(targetSessionId =>
        entry.client
          .send('Runtime.evaluate', { expression, returnByValue: true }, targetSessionId)
          .catch(() => undefined)
      )
    )
  }

  // ---- authoritative control state + human-like operation visuals --------
  _controlSessionId(id) {
    return String(id ?? 'main').split('#')[0] || 'main'
  }

  _controlRevision(id) {
    return Number(this._controlRevisions.get(this._controlSessionId(id))) || 0
  }

  _nextControlRevision(id) {
    const sid = this._controlSessionId(id)
    const revision = this._controlRevision(sid) + 1
    this._controlRevisions.set(sid, revision)
    return revision
  }

  _controlSnapshotFromState(state, extra = {}) {
    if (!state) return null
    return {
      id: state.sessionId,
      sessionId: state.sessionId,
      workbenchId: state.workbenchId,
      controlId: state.controlId,
      revision: state.revision,
      active: state.active,
      toolName: state.toolName,
      toolCallId: state.toolCallId,
      targetUrl: state.targetUrl,
      initialUrl: state.initialUrl,
      activeTabId: state.activeTabId,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      stoppedAt: state.stoppedAt,
      ...extra
    }
  }

  _emptyControlSnapshot(id, extra = {}) {
    const sid = this._controlSessionId(id)
    return {
      id: sid,
      sessionId: sid,
      workbenchId: sid,
      controlId: null,
      revision: this._controlRevision(sid),
      active: false,
      toolName: null,
      toolCallId: null,
      targetUrl: null,
      initialUrl: null,
      activeTabId: this._activeTabId(sid) || null,
      startedAt: null,
      updatedAt: null,
      stoppedAt: null,
      ...extra
    }
  }

  controlState(id) {
    const sid = this._controlSessionId(id)
    return this._controlSnapshotFromState(this._controlStates.get(sid)) || this._emptyControlSnapshot(sid)
  }

  _isControlActive(id) {
    return this._controlStates.get(this._controlSessionId(id))?.active === true
  }

  _isOperatingVisualHeld(id) {
    return this._operatingVisualHolds.has(this._controlSessionId(id))
  }

  _holdOperatingVisual(id, controlId) {
    const sid = this._controlSessionId(id)
    const exactControlId = String(controlId || '').trim()
    if (!exactControlId) return false
    this._operatingVisualHolds.set(sid, {
      controlId: exactControlId,
      heldAt: Date.now()
    })
    return true
  }

  _releaseOperatingVisualHold(id, controlId, { force = false } = {}) {
    const sid = this._controlSessionId(id)
    const hold = this._operatingVisualHolds.get(sid)
    if (!hold) return false
    const exactControlId = String(controlId || '').trim()
    if (!force && (!exactControlId || hold.controlId !== exactControlId)) return false
    this._operatingVisualHolds.delete(sid)
    return true
  }

  async _clearOperatingVisualHoldForEnd(id, controlId, input = {}, workbenchId = null) {
    if (input._fanPreserveOperatingVisual === true) return false
    const sid = this._controlSessionId(id)
    const released = this._releaseOperatingVisualHold(sid, controlId, {
      force: input.force === true
    })
    if (!released) return false
    this._notifyOperatingState(sid, workbenchId || this._activeTabId(sid) || sid)
    const visualCleanup = this._queueOperatingReconcile(sid).catch(error => {
      this.log?.(`held control visual cleanup failed for ${sid}: ${error?.message || error}`)
    })
    if (input._fanDeferVisualCleanup === true) {
      void visualCleanup
    } else {
      await visualCleanup
    }
    return true
  }

  _controlCurrentUrl(sessionId, activeTabId = null) {
    const sid = this._controlSessionId(sessionId)
    const tabId = String(activeTabId || this._activeTabId(sid) || sid)
    const entry = this.workbenches.get(tabId)
    const webContents = entry && !entry.webContents?.isDestroyed?.() ? entry.webContents : null
    const liveUrl = webContents?.getURL?.()
    if (liveUrl) return String(liveUrl)
    return String(this.sessionTabs.get(sid)?.tabMeta?.[tabId]?.url || '')
  }

  _clearControlIntervention(id) {
    const sid = this._controlSessionId(id)
    this._interventions.delete(sid)
    for (const entry of this.workbenches.values()) {
      if (this._sessionIdForEntry(entry) === sid) entry.interventionPending = false
    }
  }

  _emitControlState(state, extra = {}) {
    return this.eventBus.emit(EVENT_TYPES.CONTROL_STATE, this._controlSnapshotFromState(state, extra))
  }

  async beginControl(id, params = {}) {
    const sid = this._controlSessionId(id)
    const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
    const controlId = typeof input.controlId === 'string' ? input.controlId.trim() : ''
    if (!controlId) {
      const error = new Error('beginControl requires a non-empty controlId')
      error.code = 'CONTROL_ID_REQUIRED'
      throw error
    }
    const previous = this._controlStates.get(sid) || null
    if (previous && !previous.active && previous.controlId === controlId) {
      return this._controlSnapshotFromState(previous, {
        accepted: false,
        idempotent: true,
        stale: true
      })
    }

    const sameControl = Boolean(previous?.active && previous.controlId === controlId)
    if (!sameControl) {
      // A newer browser tool takes over the presentation lifetime atomically:
      // drop a handoff hold without publishing an idle gap, then let the new
      // active lease reconcile the already-visible frame.
      this._releaseOperatingVisualHold(sid, '', { force: true })
    }
    const now = Date.now()
    const activeTabId = String(this._activeTabId(sid) || sid)
    const currentUrl = this._controlCurrentUrl(sid, activeTabId)
    const rawToolName = input.toolName
    const rawToolCallId = input.toolCallId
    const rawTargetUrl = input.targetUrl
    const rawInitialUrl = input.initialUrl
    const toolName = rawToolName == null ? (sameControl ? previous.toolName : null) : String(rawToolName)
    const toolCallId = rawToolCallId == null ? (sameControl ? previous.toolCallId : null) : String(rawToolCallId)
    const newToolStep = !sameControl || toolName !== previous.toolName || toolCallId !== previous.toolCallId
    const next = {
      sessionId: sid,
      workbenchId: sid,
      controlId,
      revision: this._nextControlRevision(sid),
      active: true,
      toolName,
      toolCallId,
      targetUrl:
        rawTargetUrl == null
          ? (newToolStep ? null : previous.targetUrl)
          : String(rawTargetUrl),
      initialUrl:
        rawInitialUrl == null
          ? (newToolStep ? currentUrl || null : previous.initialUrl)
          : String(rawInitialUrl),
      activeTabId,
      startedAt: sameControl ? previous.startedAt : now,
      updatedAt: now,
      stoppedAt: null
    }

    // Logical ownership protects the runtime immediately, but renderer-visible
    // control state is published only after the current page has armed its
    // control frame. That keeps “控制中”, “跟随中” and the page effect on one
    // acknowledgement boundary instead of letting the labels race ahead.
    this._controlStates.set(sid, next)
    let takeoverReady = false
    try {
      const takeoverEntry = this.workbenches.get(activeTabId) || this.getWorkbench(activeTabId)
      takeoverReady = await this._armInterventionWatch(takeoverEntry)
    } catch (error) {
      this.log?.(
        `[browser-takeover-arm:${sid}:control] beginControl failed ` +
        `error=${error?.message || String(error)}`
      )
    }
    if (!takeoverReady) {
      const failedAt = Date.now()
      const stopped = {
        ...next,
        revision: this._nextControlRevision(sid),
        active: false,
        updatedAt: failedAt,
        stoppedAt: failedAt
      }
      this._controlStates.set(sid, stopped)
      this._notifyOperatingState(sid, activeTabId)
      return this._controlSnapshotFromState(stopped, {
        accepted: false,
        started: false,
        stale: false,
        visualReady: false,
        takeoverReady: false,
        reason: 'intervention-watch-unavailable'
      })
    }
    this._notifyOperatingState(sid, activeTabId)
    const visualReady = await this._queueOperatingReconcile(sid).catch(error => {
      this.log?.(`control visual reconcile failed for ${sid}: ${error?.message || error}`)
      return false
    })

    // endControl or a newer tool step may have won while the visual was arming.
    // Never publish this older active projection after that newer state.
    const current = this._controlStates.get(sid)
    if (current !== next || !current.active) {
      return this._controlSnapshotFromState(current || next, {
        accepted: false,
        started: false,
        stale: true,
        visualReady: false
      })
    }

    let event = null
    if (visualReady) {
      event = this._emitControlState(next, {
        reason: String(input.reason || (sameControl ? 'control-refreshed' : 'control-began')),
        visualReady: true
      })
    }

    return this._controlSnapshotFromState(next, {
      accepted: true,
      started: !sameControl,
      updated: sameControl,
      visualReady: Boolean(visualReady),
      takeoverReady: true,
      eventId: event?.id || null
    })
  }

  async endControl(id, params = {}) {
    const sid = this._controlSessionId(id)
    const input = params && typeof params === 'object' && !Array.isArray(params) ? params : {}
    const force = input.force === true
    const controlId = typeof input.controlId === 'string' ? input.controlId.trim() : ''
    if (!force && !controlId) {
      const error = new Error('endControl requires controlId')
      error.code = 'CONTROL_ID_REQUIRED'
      throw error
    }
    let current = this._controlStates.get(sid)
    if (!current) {
      await this._clearOperatingVisualHoldForEnd(sid, controlId, input, sid)
      return this._emptyControlSnapshot(sid, {
        requestedControlId: controlId || null,
        ended: false,
        idempotent: true,
        stale: false,
        forced: force
      })
    }
    if (!force && current.controlId !== controlId) {
      return this._controlSnapshotFromState(current, {
        requestedControlId: controlId,
        ended: false,
        idempotent: false,
        stale: true
      })
    }
    if (!current.active) {
      // programHandoff deliberately leaves the intervention latch behind while
      // releasing the native control lease. A later ordinary endControl from
      // Stop is therefore idempotent at the control layer but still owns the
      // latch cleanup. Only the exact same control ID may clear it; stale or
      // malformed end requests must leave a newer takeover untouched.
      if (
        controlId &&
        current.controlId === controlId &&
        input._fanPreserveIntervention !== true
      ) {
        this._clearControlIntervention(sid)
      }
      await this._clearOperatingVisualHoldForEnd(
        sid,
        controlId,
        input,
        current.activeTabId
      )
      return this._controlSnapshotFromState(current, {
        ended: false,
        idempotent: true,
        stale: false,
        forced: force
      })
    }

    if (input._fanDrainInterventionEvents === true) {
      // A trusted page event calls the Runtime binding synchronously in the
      // renderer, but Electron can deliver the corresponding bindingCalled
      // notification on a later host turn. A no-op command on each armed CDP
      // session is the lease boundary: protocol messages already emitted on
      // that session are dispatched before the command response resolves.
      const interventionEventsDrained = await this._drainInterventionEvents(sid)

      // beginControl/endControl or a tab transition may have won while the
      // protocol barriers were in flight. Only the exact lease requested by
      // this caller may be retired.
      const afterDrain = this._controlStates.get(sid)
      if (!afterDrain) {
        await this._clearOperatingVisualHoldForEnd(sid, controlId, input, sid)
        return this._emptyControlSnapshot(sid, {
          requestedControlId: controlId || null,
          ended: false,
          idempotent: true,
          stale: false,
          forced: force
        })
      }
      if (!force && afterDrain.controlId !== controlId) {
        return this._controlSnapshotFromState(afterDrain, {
          requestedControlId: controlId,
          ended: false,
          idempotent: false,
          stale: true
        })
      }
      if (!afterDrain.active) {
        if (
          controlId &&
          afterDrain.controlId === controlId &&
          input._fanPreserveIntervention !== true
        ) {
          this._clearControlIntervention(sid)
        }
        await this._clearOperatingVisualHoldForEnd(
          sid,
          controlId,
          input,
          afterDrain.activeTabId
        )
        return this._controlSnapshotFromState(afterDrain, {
          ended: false,
          idempotent: true,
          stale: false,
          forced: force
        })
      }
      if (
        !interventionEventsDrained &&
        !this._sessionInterventionPending(sid)
      ) {
        // A timed-out/rejected protocol barrier cannot prove that every trusted
        // input notification emitted before this lease boundary was delivered.
        // Do not retain Agent ownership indefinitely, but fail closed at the
        // effect-admission layer before retiring the exact lease. The final
        // program result then becomes needs_human and Continue must establish a
        // fresh observation/lease; a real event that arrived during the drain
        // already owns the latch and keeps its more precise metadata.
        const currentTabId = String(
          this._activeTabId(sid) ||
          afterDrain.activeTabId ||
          sid
        )
        const anchorTabId = String(afterDrain.activeTabId || currentTabId)
        this._latchIntervention(sid, {
          kind: 'control-boundary-unconfirmed',
          inputKind: 'protocol-drain',
          workbenchId: sid,
          currentTabId,
          anchorTabId,
          agentAnchorTabId: anchorTabId,
          userTabId: currentTabId,
          reason: 'intervention-event-drain-failed'
        })
      }
      current = afterDrain
    }

    if (input._fanPreserveOperatingVisual === true) {
      this._holdOperatingVisual(sid, controlId)
    } else {
      this._releaseOperatingVisualHold(sid, controlId, { force })
    }
    const now = Date.now()
    const stopped = {
      ...current,
      revision: this._nextControlRevision(sid),
      active: false,
      updatedAt: now,
      stoppedAt: now
    }
    this._controlStates.set(sid, stopped)
    this._notifyOperatingState(sid, stopped.activeTabId)
    // Program handoff ends the Agent lease but must keep the takeover identity
    // and first anchor alive until Continue/Stop explicitly acknowledges it.
    // Ordinary endControl callers retain the existing clear-on-end behavior.
    if (input._fanPreserveIntervention !== true) {
      this._clearControlIntervention(sid)
    } else {
      const intervention = this._interventions.get(sid)
      if (intervention?.interventionId) {
        this.log?.(
          `[browser-takeover:${intervention.interventionId}] control-released ` +
          `session=${sid} anchor=${intervention.agentAnchorTabId || intervention.anchorTabId || ''}`
        )
      }
    }
    const visualCleanup = this._queueOperatingReconcile(sid).catch(error => {
      this.log?.(`control visual cleanup failed for ${sid}: ${error?.message || error}`)
    })
    // Program handoff is a control-plane safety boundary. The authoritative
    // inactive state above must not wait on a cosmetic CDP frame cleanup that
    // can be delayed by a wedged renderer. Normal callers may still await the
    // visual acknowledgement; the host can explicitly defer it.
    if (input._fanDeferVisualCleanup === true) {
      void visualCleanup
    } else {
      await visualCleanup
    }

    const currentAfterCleanup = this._controlStates.get(sid)
    let event = null
    if (currentAfterCleanup === stopped) {
      event = this._emitControlState(stopped, {
        reason: String(input.reason || 'control-ended'),
        visualReady: false
      })
    }

    return this._controlSnapshotFromState(stopped, {
      ended: true,
      idempotent: false,
      stale: false,
      forced: force,
      eventId: event?.id || null
    })
  }

  _refreshControlActiveTab(id, reason = 'active-tab-changed') {
    const sid = this._controlSessionId(id)
    const current = this._controlStates.get(sid)
    if (!current?.active) return this.controlState(sid)
    const activeTabId = String(this._activeTabId(sid) || sid)
    if (activeTabId === current.activeTabId) {
      void this._queueOperatingReconcile(sid).catch(() => undefined)
      return this._controlSnapshotFromState(current)
    }
    const updated = {
      ...current,
      activeTabId,
      revision: this._nextControlRevision(sid),
      updatedAt: Date.now()
    }
    this._controlStates.set(sid, updated)
    void this._queueOperatingReconcile(sid)
      .then(visualReady => {
        if (!visualReady || this._controlStates.get(sid) !== updated) return
        this._emitControlState(updated, { reason, visualReady: true })
      })
      .catch(error => {
        this.log?.(`control visual tab switch failed for ${sid}: ${error?.message || error}`)
      })
    return this._controlSnapshotFromState(updated, { eventId: null, visualReady: false })
  }

  _deleteControlState(id, reason = 'session-deleted') {
    const sid = this._controlSessionId(id)
    const current = this._controlStates.get(sid) || null
    const revision = this._nextControlRevision(sid)
    this._controlStates.delete(sid)
    this._releaseOperatingVisualHold(sid, '', { force: true })
    this._notifyOperatingState(sid, current?.activeTabId)
    this._clearControlIntervention(sid)
    if (current?.active) {
      const now = Date.now()
      const stopped = {
        ...current,
        revision,
        active: false,
        updatedAt: now,
        stoppedAt: now
      }
      this._emitControlState(stopped, { reason })
    }
    void this._queueOperatingReconcile(sid).catch(() => undefined)
    return current ? this._controlSnapshotFromState(current) : null
  }

  // The operating frame is browser-tool-level, not per micro-action, so it does
  // not flicker. This queue reconciles page-injected visuals with logical control
  // plus the human-handoff hold; entry._operating only records what was applied
  // to a concrete page.
  _queueOperatingReconcile(id) {
    const sid = this._controlSessionId(id)
    const previous = this._operatingTransitions.get(sid) || Promise.resolve()
    const transition = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.operatingVisuals) return false
        const activeId = this._activeTabId(sid)
        const desired = this._isControlActive(sid) || this._isOperatingVisualHeld(sid)
        const group = this.sessionTabs.get(sid)
        const tabIds = new Set(group?.tabs?.length ? group.tabs.map(String) : [sid])
        let activeVisualReady = !desired

        for (const [entryId, entry] of this.workbenches) {
          if (entry.sessionId === sid) tabIds.add(String(entryId))
        }

        for (const tabId of tabIds) {
          const entry = this.workbenches.get(tabId)
          if (!entry) continue
          const shouldShow = desired && tabId === activeId
          if (shouldShow || entry._operating || entry._operatingFrameScript) {
            const applied = await this._applyOperatingFrame(entry, shouldShow)
            if (shouldShow) activeVisualReady = applied === true
            if (
              !shouldShow &&
              applied === false &&
              !this._isControlActive(sid) &&
              !this._isOperatingVisualHeld(sid)
            ) {
              await new Promise(resolve => setTimeout(resolve, 100))
              if (
                this.workbenches.get(tabId) === entry &&
                !this._isControlActive(sid) &&
                !this._isOperatingVisualHeld(sid)
              ) {
                await this._applyOperatingFrame(entry, false)
              }
            }
          }
        }
        return activeVisualReady
      })

    this._operatingTransitions.set(sid, transition)
    const release = () => {
      if (this._operatingTransitions.get(sid) === transition) {
        this._operatingTransitions.delete(sid)
      }
    }
    void transition.then(release, release)
    return transition
  }

  // Inject (on) or remove (off) the breathing "agent is operating" frame on ONE tab.
  // The frame is page-injected (wiped on every navigation), so an on-new-document
  // script re-applies it after each nav while operating; `entry._operating` lets the
  // load path (_waitForLoad) re-apply too. Ensures the debugger + Page domain are
  // ready first (this can fire at turn start before any action has attached).
  async _applyOperatingFrame(entry, on) {
    if (!this.operatingVisuals || !entry?.client) return true
    const entryIsCurrent = () => (
      !entry.retired && this.workbenches.get(String(entry.id)) === entry
    )
    if (!entryIsCurrent()) return false
    const cleanupExpression = `(() => { const f=document.getElementById('__fan_operating_frame'); if(f) f.remove(); const s=document.getElementById('__fan_op_style'); if(s) s.remove(); const c=document.getElementById('__fan_cursor'); if(c) c.remove(); try { delete window.__fanAgentActingUntil; } catch (_) {} return true; })()`
    entry._operating = Boolean(on)
    try {
      await entry.client.attach()
      if (!entryIsCurrent()) return false
    } catch {
      if (!entryIsCurrent()) return false
      if (
        !on &&
        entry.webContents &&
        !entry.webContents.isDestroyed?.() &&
        typeof entry.webContents.executeJavaScript === 'function'
      ) {
        await entry.webContents.executeJavaScript(cleanupExpression, true).catch(() => undefined)
        if (!entryIsCurrent()) return false
      }
      return false
    }
    await entry.client.send('Page.enable').catch(() => undefined)
    if (!entryIsCurrent()) return false
    if (on) {
      try {
        await this._armInterventionWatch(entry)
      } catch (error) {
        this.log?.(
          `[browser-takeover-arm:${entry.id}:control] control activation rejected ` +
          `error=${error?.message || String(error)}`
        )
        return false
      }
      if (!entry._operatingFrameScript) {
        const added = await entry.client
          .send('Page.addScriptToEvaluateOnNewDocument', { source: this._operatingFrameCreateJs() })
          .catch(() => null)
        if (!entryIsCurrent()) return false
        entry._operatingFrameScript = added?.identifier || null
      }
      await entry.client
        .send('Runtime.evaluate', { expression: this._operatingFrameCreateJs(), returnByValue: true })
        .catch(() => undefined)
      if (!entryIsCurrent()) return false
      return true
    } else {
      let scriptRemoved = true
      if (entry._operatingFrameScript) {
        scriptRemoved = await entry.client
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry._operatingFrameScript })
          .then(() => true)
          .catch(() => false)
        if (!entryIsCurrent()) return false
        if (scriptRemoved) entry._operatingFrameScript = null
      }
      let currentPageCleaned = await entry.client
        .send('Runtime.evaluate', {
          // Also remove the agent cursor (__fan_cursor): _cursorTo injects it
          // on-demand and NOTHING else ever removes it, so without this it stays
          // stuck on the page (opacity 1, last position) after the turn ends —
          // the "operating effect lingers" bug. The focus ring self-removes (~1.7s).
          expression: cleanupExpression,
          returnByValue: true
        })
        .then(() => true)
        .catch(() => false)
      if (!entryIsCurrent()) return false
      if (
        !currentPageCleaned &&
        entry.webContents &&
        !entry.webContents.isDestroyed?.() &&
        typeof entry.webContents.executeJavaScript === 'function'
      ) {
        currentPageCleaned = await entry.webContents
          .executeJavaScript(cleanupExpression, true)
          .then(() => true)
          .catch(() => false)
        if (!entryIsCurrent()) return false
      }
      return scriptRemoved && currentPageCleaned
    }
  }

  // Agent takeover visual, 1:1 from the Nwqo5 design board. A single
  // pointer-events-none fixed overlay injected into the controlled page that
  // holds ONLY the neon aura: the status capsule ("Agent 正在操作" / step /
  // action feed) was cut from the design, so the only persistent signal is the
  // breathing edge glow. The agent's intent is shown by the live cursor +
  // focus ring + ripple (see _cursorTo), not a capsule.
  //
  // There is NO persistent border line (it read too 板正/square). Rounded
  // corners + only-moving-light define the frame. Layers, bottom to top:
  // (1) FOG (雾化) — a rounded, clipped pocket of big blurred corner blooms +
  // colored edge glows; (2) beam (循环光束) — one pre-painted, multi-band light
  // texture travelling clockwise around the four edges. Only the mover's
  // transform + opacity animate; its gradients never repaint per frame. Only
  // the edges are lit; content stays untouched.
  // Motion is LOCKED to one period (3.4s): the fog BREATHES 40->100% opacity in
  // lockstep with the beam's full revolution — one swell per loop, so the haze
  // 'goes with' the light. reduce-motion stills everything.
  // Colors are the design's literal values (#RRGGBBAA hex).
  _operatingFrameCreateJs() {
    return `(() => {
      const make = () => {
        try {
          if (window.top !== window.self) return;
          const ID='__fan_operating_frame';
          if(document.getElementById(ID)) return;
          const root = document.documentElement || document.body;
          if(!root){ document.addEventListener('DOMContentLoaded', make, {once:true}); return; }
          if(!document.getElementById('__fan_op_style')){
            const s=document.createElement('style'); s.id='__fan_op_style';
            s.textContent='@keyframes __fan_op_breathe{0%,100%{opacity:.4}50%{opacity:1}}'
              +'@keyframes __fan_op_beam_top{0%{opacity:1;transform:translate3d(-100%,0,0)}24%{opacity:1}27%,100%{opacity:0;transform:translate3d(100vw,0,0)}}'
              +'@keyframes __fan_op_beam_right{0%,23%{opacity:0;transform:translate3d(0,-100%,0)}25%,49%{opacity:1}52%,100%{opacity:0;transform:translate3d(0,100vh,0)}}'
              +'@keyframes __fan_op_beam_bottom{0%,48%{opacity:0;transform:translate3d(100%,0,0)}50%,74%{opacity:1}77%,100%{opacity:0;transform:translate3d(-100vw,0,0)}}'
              +'@keyframes __fan_op_beam_left{0%,73%{opacity:0;transform:translate3d(0,100%,0)}75%,98%{opacity:1}100%{opacity:0;transform:translate3d(0,-100vh,0)}}'
              +'@media (prefers-reduced-motion:reduce){#'+ID+' *{animation:none!important}}';
            (document.head||root).appendChild(s);
          }
          // RAD: corners are rounded (no more 板正 square); LOOP: the single
          // shared period so the haze BREATHES in lockstep with the beam — one
          // swell per revolution, the fog 'going with' the light the user asked
          // for. There is NO persistent border line anymore: only the moving
          // beam + its travelling glow + breathing haze define the frame.
          const RAD='10px', LOOP='3.4s';
          const f=document.createElement('div'); f.id=ID;
          f.style.cssText='position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
          // Fog (雾化): a rounded, clipped pocket of soft corner blooms + colored
          // edge glows; the whole pocket breathes on LOOP, synced to the beam.
          const fog=document.createElement('div');
          // The original visual recipe stays intact. Only the full pocket's
          // opacity animates; contain + will-change make that compositing
          // boundary explicit so the static gradients/filters can be cached.
          fog.style.cssText='position:absolute;inset:0;border-radius:'+RAD+';overflow:hidden;contain:paint;will-change:opacity;animation:__fan_op_breathe '+LOOP+' ease-in-out infinite;';
          const bloom=(css)=>{const d=document.createElement('div');d.style.cssText='position:absolute;border-radius:50%;filter:blur(58px);'+css;fog.appendChild(d);};
          bloom('top:-170px;left:-150px;width:440px;height:440px;background:radial-gradient(closest-side,#2D6BF05C,transparent);');
          bloom('top:-170px;right:-150px;width:440px;height:440px;background:radial-gradient(closest-side,#7458F052,transparent);');
          bloom('bottom:-190px;left:-150px;width:470px;height:470px;background:radial-gradient(closest-side,#7458F045,transparent);');
          bloom('bottom:-190px;right:-150px;width:470px;height:470px;background:radial-gradient(closest-side,#00B7E052,transparent);');
          const edge=(css)=>{const d=document.createElement('div');d.style.cssText='position:absolute;filter:blur(4px);'+css;fog.appendChild(d);};
          edge('top:0;left:0;right:0;height:150px;background:linear-gradient(to bottom,#2D6BF06E,#5E63F226 55%,transparent);');
          edge('bottom:0;left:0;right:0;height:150px;background:linear-gradient(to top,#00B7E063,#00B7E024 55%,transparent);');
          edge('top:0;bottom:0;left:0;width:170px;background:linear-gradient(to right,#7458F063,#7458F026 55%,transparent);');
          edge('top:0;bottom:0;right:0;width:170px;background:linear-gradient(to left,#2D6BF063,#2D6BF026 55%,transparent);');
          f.appendChild(fog);
          // Beam (循环光束): four small edge movers share one visual texture and
          // one 3.4s timeline. The texture is painted once; steady-state motion is
          // compositor-only transform/opacity, with a brief cross-fade at corners.
          const beamLayer=document.createElement('div');
          beamLayer.setAttribute('data-fan-layer','operating-beam');
          beamLayer.style.cssText='position:absolute;inset:0;border-radius:'+RAD+';overflow:hidden;contain:paint;pointer-events:none;';
          const beamGradients=(direction)=>[
            'linear-gradient('+direction+',transparent 0%,#7FD8FF00 34%,#7FD8FF8F 70%,#DFF8FFFF 91%,#FFFFFF 97%,transparent 100%)',
            'linear-gradient('+direction+',transparent 0%,#2D6BF020 20%,#7458F04D 52%,#6FD2FFB0 82%,#DFF8FFF2 95%,transparent 100%)',
            'linear-gradient('+direction+',transparent 0%,#2D6BF014 25%,#7458F033 54%,#00B7E06B 78%,#CFF4FFB8 93%,transparent 100%)'
          ].join(',');
          const addBeam=(edge,direction,horizontal)=>{
            const beam=document.createElement('div');
            beam.setAttribute('data-fan-beam-edge',edge);
            beam.style.cssText='position:absolute;opacity:0;pointer-events:none;will-change:transform,opacity;contain:paint;background-repeat:no-repeat;background-position:center;border-radius:999px;';
            beam.style.backgroundImage=beamGradients(direction);
            beam.style.backgroundSize=horizontal?'100% 1.5px,100% 7px,100% 24px':'1.5px 100%,7px 100%,24px 100%';
            if(edge==='top') beam.style.cssText+='left:0;top:-18px;width:clamp(260px,42vw,560px);height:36px;animation:__fan_op_beam_top '+LOOP+' linear infinite;';
            if(edge==='right') beam.style.cssText+='right:-18px;top:0;width:36px;height:clamp(260px,42vh,560px);animation:__fan_op_beam_right '+LOOP+' linear infinite;';
            if(edge==='bottom') beam.style.cssText+='right:0;bottom:-18px;width:clamp(260px,42vw,560px);height:36px;animation:__fan_op_beam_bottom '+LOOP+' linear infinite;';
            if(edge==='left') beam.style.cssText+='left:-18px;bottom:0;width:36px;height:clamp(260px,42vh,560px);animation:__fan_op_beam_left '+LOOP+' linear infinite;';
            beamLayer.appendChild(beam);
          };
          addBeam('top','to right',true);
          addBeam('right','to bottom',false);
          addBeam('bottom','to left',true);
          addBeam('left','to top',false);
          f.appendChild(beamLayer);
          root.appendChild(f);
        } catch(_) {}
      };
      make();
      return true;
    })()`
  }

  // Glide the virtual cursor to (x,y); optionally play a click pulse + ripple.
  // Awaits the glide so the REAL input dispatch lands after the user sees the
  // pointer arrive — that is the point of the effect.
  //
  // The cursor's last position is kept on the runtime entry (entry._cursorX/Y),
  // NOT on the cursor DOM node. A browsing turn navigates constantly and every
  // navigation wipes page-injected DOM, so a DOM-stored position made every
  // move look "fresh" → the cursor teleported to each click point with no
  // visible glide (the bug). Seeding the start from the entry lets the cursor
  // re-appear at its last spot after a navigation and actually glide to the
  // new target, so the user sees the pointer travel like the operating frame.
  async _cursorTo(entry, x, y, sessionId, { click = false, focus = false, w = 0, h = 0 } = {}) {
    if (!this.operatingVisuals || !entry?.client?.send) return
    const tx = Number(x) || 0
    const ty = Number(y) || 0
    // First move of a workbench: no prior position → start at the target so it
    // fades in place rather than flying in from (0,0). Every later move glides.
    const px = Number.isFinite(entry._cursorX) ? entry._cursorX : tx
    const py = Number.isFinite(entry._cursorY) ? entry._cursorY : ty
    const glide = this.cursorGlideMs
    const gmax = this.cursorGlideMaxMs
    const fade = this.cursorFadeMs
    const focusMs = this.cursorFocusPulseMs
    const ease = JSON.stringify(this.cursorEasing)
    await entry.client
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const X=${tx}, Y=${ty}, PX=${px}, PY=${py}, GBASE=${glide}, GMAX=${gmax}, FADE=${fade}, FOCUS=${focusMs}, EASE=${ease}, W=${Number(w) || 0}, H=${Number(h) || 0};
            // position:fixed lives in the VISUAL viewport; map the layout-space
            // click point into it so the cosmetic cursor overlaps the real
            // (unchanged) click point under pinch-zoom. Identity at 100% zoom.
            const vv=window.visualViewport, ox=vv?vv.offsetLeft:0, oy=vv?vv.offsetTop:0, sc=vv?vv.scale:1;
            const cx=(X-ox)*sc, cy=(Y-oy)*sc, pcx=(PX-ox)*sc, pcy=(PY-oy)*sc;
            const ID='__fan_cursor';
            let c=document.getElementById(ID); const fresh=!c;
            if(!c){
              c=document.createElement('div'); c.id=ID;
              // Agent cursor: a 38px liquid-glass mouse-pointer-2. The offset
              // indigo depth plate, translucent blue/violet body, bright rim and
              // clipped specular streak give it volume without adding a label or
              // obscuring the page beneath it. Tip hotspot ~(4,4) in the 24 viewBox
              // → ~6.4/7.4px at 38px; the negative margin aligns the tip to the
              // translate origin so the cosmetic cursor overlaps the real click point.
              c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform,opacity;opacity:0;';
              c.innerHTML='<svg width="38" height="38" viewBox="0 0 24 24" aria-hidden="true" style="display:block;overflow:visible;margin:-7px 0 0 -6px;filter:drop-shadow(0 5px 7px rgba(23,48,133,.32)) drop-shadow(0 1px 2px rgba(255,255,255,.38))">'
                +'<defs>'
                  +'<linearGradient id="__fan_cursor_glass" x1="3.6" y1="3.6" x2="17.8" y2="19.8" gradientUnits="userSpaceOnUse">'
                    +'<stop offset="0" stop-color="#F4FDFF" stop-opacity=".96"/>'
                    +'<stop offset=".22" stop-color="#9FDBFF" stop-opacity=".78"/>'
                    +'<stop offset=".56" stop-color="#4B78F3" stop-opacity=".82"/>'
                    +'<stop offset=".82" stop-color="#685CEB" stop-opacity=".88"/>'
                    +'<stop offset="1" stop-color="#3A35A5" stop-opacity=".94"/>'
                  +'</linearGradient>'
                  +'<radialGradient id="__fan_cursor_glow" cx="0" cy="0" r="1" gradientTransform="translate(8 6.4) rotate(50) scale(9 6.2)" gradientUnits="userSpaceOnUse">'
                    +'<stop stop-color="#FFFFFF" stop-opacity=".95"/>'
                    +'<stop offset=".38" stop-color="#D8F7FF" stop-opacity=".48"/>'
                    +'<stop offset="1" stop-color="#6EDCFF" stop-opacity="0"/>'
                  +'</radialGradient>'
                  +'<linearGradient id="__fan_cursor_rim" x1="4" y1="4" x2="16.4" y2="20.2" gradientUnits="userSpaceOnUse">'
                    +'<stop stop-color="#FFFFFF" stop-opacity=".96"/>'
                    +'<stop offset=".42" stop-color="#B9EEFF" stop-opacity=".72"/>'
                    +'<stop offset=".72" stop-color="#8197FF" stop-opacity=".5"/>'
                    +'<stop offset="1" stop-color="#352E99" stop-opacity=".78"/>'
                  +'</linearGradient>'
                  +'<clipPath id="__fan_cursor_clip"><path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/></clipPath>'
                +'</defs>'
                +'<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" transform="translate(.9 1.15)" fill="#192C82" fill-opacity=".76" stroke="#17256D" stroke-opacity=".66" stroke-width=".8" stroke-linejoin="round"/>'
                +'<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" fill="url(#__fan_cursor_glass)" stroke="url(#__fan_cursor_rim)" stroke-width=".78" stroke-linejoin="round"/>'
                +'<g clip-path="url(#__fan_cursor_clip)">'
                  +'<ellipse cx="8.1" cy="6.5" rx="6.9" ry="4.5" transform="rotate(24 8.1 6.5)" fill="url(#__fan_cursor_glow)"/>'
                  +'<path d="M5.25 5.35C8.3 6.15 11.1 7.12 13.55 8.2" fill="none" stroke="#FFFFFF" stroke-opacity=".88" stroke-width=".92" stroke-linecap="round"/>'
                  +'<path d="M12.25 12.65C13.9 12.02 15.6 11.55 18.5 10.85" fill="none" stroke="#9CF3FF" stroke-opacity=".58" stroke-width="1.05" stroke-linecap="round"/>'
                  +'<path d="M11.65 14.55C11.98 16.1 11.98 17.35 11.55 19.05" fill="none" stroke="#B8A8FF" stroke-opacity=".46" stroke-width="1.15" stroke-linecap="round"/>'
                +'</g>'
                +'<path d="M5.05 5.02L19.35 10.84" fill="none" stroke="#FFFFFF" stroke-opacity=".35" stroke-width=".35" stroke-linecap="round"/>'
              +'</svg>';
              document.documentElement.appendChild(c);
            }
            // Start point: the cursor's current on-page spot if it survived, else
            // the runtime-remembered last position (survives navigation).
            const sx=(c.__fx!=null)?c.__fx:pcx, sy=(c.__fy!=null)?c.__fy:pcy;
            const D=Math.hypot(cx-sx, cy-sy);
            // Distance-aware glide (Fitts's law); a same-spot move stays at the base.
            const G = D>1 ? Math.round(Math.max(180, Math.min(GMAX, 120+90*Math.log2(2*D/40+1)))) : GBASE;
            c.style.transition='none';
            c.style.transform='translate('+sx+'px,'+sy+'px)'+(fresh?' scale(.85)':'');
            c.style.opacity='1';
            void c.offsetWidth;
            c.style.transition='transform '+G+'ms '+EASE;
            c.style.transform='translate('+cx+'px,'+cy+'px)';
            if(fresh){
              c.animate([{opacity:0},{opacity:1}],{duration:FADE,easing:'ease-out',fill:'forwards'});
            }
            c.__fx=cx; c.__fy=cy;
            const fanEnsureTrueFocusStyle=()=>{
              if(document.getElementById('__fan_true_focus_style')) return;
              const s=document.createElement('style');
              s.id='__fan_true_focus_style';
              s.textContent='.__fan_true_focus_frame{position:fixed;top:0;left:0;z-index:2147483646;pointer-events:none;box-sizing:content-box;border:0;opacity:0;transform:translate3d(0,0,0) scale(.985);transition:opacity .16s ease-out,transform .18s ease-out,width .18s ease-out,height .18s ease-out;}'
                +'.__fan_true_focus_corner{position:absolute;width:1rem;height:1rem;border:3px solid var(--fan-true-focus-border,#2D6BF0);filter:drop-shadow(0 0 4px var(--fan-true-focus-glow,rgba(45,107,240,.55)));border-radius:3px;transition:transform .18s ease-out;box-sizing:border-box;}'
                +'.__fan_true_focus_top_left{top:-10px;left:-10px;border-right:0;border-bottom:0;}'
                +'.__fan_true_focus_top_right{top:-10px;right:-10px;border-left:0;border-bottom:0;}'
                +'.__fan_true_focus_bottom_left{bottom:-10px;left:-10px;border-right:0;border-top:0;}'
                +'.__fan_true_focus_bottom_right{bottom:-10px;right:-10px;border-left:0;border-top:0;}'
                +'@media (prefers-reduced-motion:reduce){.__fan_true_focus_frame,.__fan_true_focus_corner{transition:none!important;}}';
              (document.head||document.documentElement).appendChild(s);
            };
            const fanCreateTrueFocusFrame=(opts={})=>{
              fanEnsureTrueFocusStyle();
              if(opts.id){
                const old=document.getElementById(opts.id);
                if(old){ if(old.__fanRaf){ try{cancelAnimationFrame(old.__fanRaf)}catch(e){} } old.remove(); }
              }
              const wrap=document.createElement('div');
              if(opts.id) wrap.id=opts.id;
              wrap.className='__fan_true_focus_frame';
              wrap.style.setProperty('--fan-true-focus-border',opts.borderColor||'#2D6BF0');
              wrap.style.setProperty('--fan-true-focus-glow',opts.glowColor||'rgba(45,107,240,.55)');
              const names=['top_left','top_right','bottom_left','bottom_right'];
              const start=Number(opts.start ?? 7);
              const finals=[
                {sx:-start,sy:-start,fx:0,fy:0},
                {sx:start,sy:-start,fx:0,fy:0},
                {sx:-start,sy:start,fx:0,fy:0},
                {sx:start,sy:start,fx:0,fy:0}
              ];
              const corners=names.map((name,i)=>{
                const b=document.createElement('span');
                b.className='__fan_true_focus_corner __fan_true_focus_'+name;
                b.style.transform='translate('+finals[i].sx+'px,'+finals[i].sy+'px)';
                wrap.appendChild(b);
                return b;
              });
              document.documentElement.appendChild(wrap);
              const place=()=>{
                let L,T,Wd,Ht;
                const target=opts.trackActive ? document.activeElement : opts.target;
                const r=target&&target!==document.body&&target!==document.documentElement&&target.tagName!=='IFRAME'&&typeof target.getBoundingClientRect==='function'?target.getBoundingClientRect():null;
                if(r&&(r.width>0||r.height>0)){
                  const v=window.visualViewport, vox=v?v.offsetLeft:0, voy=v?v.offsetTop:0, vsc=v?v.scale:1;
                  L=(r.left-vox)*vsc; T=(r.top-voy)*vsc; Wd=r.width*vsc; Ht=r.height*vsc;
                } else {
                  Wd=(W>0?W*sc:60); Ht=(H>0?H*sc:30); L=cx-Wd/2; T=cy-Ht/2;
                }
                wrap.style.left=L+'px'; wrap.style.top=T+'px'; wrap.style.width=Wd+'px'; wrap.style.height=Ht+'px';
                const cs=Math.max(Number(opts.cornerMin ?? 10),Math.min(Number(opts.cornerMax ?? 18),Math.min(Wd,Ht)*0.35));
                corners.forEach(b=>{ b.style.width=cs+'px'; b.style.height=cs+'px'; });
              };
              place();
              requestAnimationFrame(()=>{
                wrap.style.opacity='1';
                wrap.style.transform='translate3d(0,0,0) scale(1)';
                corners.forEach((b,i)=>{ b.style.transform='translate('+finals[i].fx+'px,'+finals[i].fy+'px)'; });
              });
              return {wrap,place};
            };
            if(${click ? 'true' : 'false'}){
              // click 一闪即逝的瞬时反馈:光标 squish(纯光标反馈,不是框)+ 四对角框。
              // 这一整段逐字节沿用原实现,渲染零变更;持久焦点环单独走下面的 focus 块。
              setTimeout(()=>{
                c.animate([{transform:'translate('+cx+'px,'+cy+'px) scale(1)'},{transform:'translate('+cx+'px,'+cy+'px) scale(.82)'},{transform:'translate('+cx+'px,'+cy+'px) scale(1)'}],{duration:220,easing:'ease-out'});
              }, G);
              // TrueFocus-style frame: .focus-frame + four .corner equivalents.
              // ~1s 后淡出(DUR=1000 一次性自灭 + raf 1700ms 上限)。click 用 caller 矩形
              // (调用点传 W/H,无则回落 60×30 居中盒),逐帧 place() 跟住 bounds——
              // 这是相对 静态坐标的增益(reflow/自动补全后框跟着动)。
              setTimeout(()=>{
                const DUR=1000;
                const frame=fanCreateTrueFocusFrame({cornerMax:20,start:10});
                let raf; const t0=Date.now();
                const loop=()=>{ frame.place(); if(Date.now()-t0<1700){ raf=requestAnimationFrame(loop); } };
                raf=requestAnimationFrame(loop);
                setTimeout(()=>{ if(raf)cancelAnimationFrame(raf); frame.wrap.style.transition='opacity .3s ease-out'; frame.wrap.style.opacity='0'; setTimeout(()=>frame.wrap.remove(),300); }, DUR);
              }, G);
            }
            if(${focus ? 'true' : 'false'}){
              // TYPE/focus 持久焦点环(persist):稳定 id __fan_focus_ring、先移除同 id 杜绝叠加、
              // 【同步创建,不进 setTimeout(G)】——保证 _cursorTo 返回(return true)时环已在 DOM,
              // 这样 type() 的 finally 调 _removeFocusRing 一定能命中清除(根除"finally 早于 wrap
              // 创建 → 建出无主残留环"的 race)。不自动淡出、raf 无 1700ms 上限:只要 #__fan_focus_ring
              // 还在页面就逐帧 place() 跟住 activeElement(回落 W/H 居中盒);被 _removeFocusRing 抹掉
              // id 后下一帧存在性检查失败即自停。视觉语言参考 React Bits TrueFocus:只画四个
              // 发光 L 形角标,不画完整矩形边框,并使用 Fan 主题蓝。
              (()=>{
                const frame=fanCreateTrueFocusFrame({id:'__fan_focus_ring',trackActive:true,cornerMax:18,start:7});
                const loop=()=>{
                  if(!document.getElementById('__fan_focus_ring')) return;
                  frame.place();
                  frame.wrap.__fanRaf=requestAnimationFrame(loop);
                };
                frame.wrap.__fanRaf=requestAnimationFrame(loop);
              })();
            }
            return true;
          })()`,
          returnByValue: true
        },
        sessionId
      )
      .catch(() => undefined)
    entry._cursorX = tx
    entry._cursorY = ty
    // Wait out the glide so the REAL input dispatch lands after the cursor is
    // seen to arrive. Budget tracks the actual travel distance.
    const dist = Math.hypot(tx - px, ty - py)
    const waitG = dist > 1 ? Math.round(Math.max(180, Math.min(gmax, 120 + 90 * Math.log2((2 * dist) / 40 + 1)))) : glide
    await new Promise(resolve => setTimeout(resolve, click ? waitG + 70 : Math.min(waitG, 200)))
  }

  // 移除 TYPE/focus 的持久焦点环(__fan_focus_ring):取消 raf 句柄 + 先抹掉 id(让持久 raf
  // loop 的存在性检查下一帧失败而自停,即便 cancelAnimationFrame 漏掉也双保险)+ 淡出后移除节点。
  // !operatingVisuals 时 _cursorTo 根本不画环,这里直接 return 省一次往返;命中失败/超时也安全
  // (catch 吞掉)。由 type() 的 finally 调用,出错/兜底/超时都必清除,绝不残留。
  async _removeFocusRing(entry, sessionId = undefined) {
    if (!this.operatingVisuals || !entry?.client?.send) return
    await entry.client
      .send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const w = document.getElementById('__fan_focus_ring');
            if (!w) return false;
            if (w.__fanRaf) { try { cancelAnimationFrame(w.__fanRaf); } catch(e){} w.__fanRaf = 0; }
            w.removeAttribute('id');
            w.style.transition = 'opacity .3s ease-out';
            w.style.opacity = '0';
            setTimeout(() => w.remove(), 300);
            return true;
          })()`,
          returnByValue: true
        },
        sessionId
      )
      .catch(() => undefined)
  }

  // Resolve a workbench's last REAL pointer position, seeding it on first use
  // from the viewport center (layout metrics if available, else the configured
  // default) so the very first move still starts from a plausible spot rather
  // than (0,0). Returns {x,y}.
  async _lastMousePoint(entry, sessionId = undefined) {
    if (Number.isFinite(entry._lastMouseX) && Number.isFinite(entry._lastMouseY)) {
      return { x: entry._lastMouseX, y: entry._lastMouseY }
    }
    let cx = this.mouseTrajectoryDefaultX
    let cy = this.mouseTrajectoryDefaultY
    try {
      const layout = await entry.client.send('Page.getLayoutMetrics', {}, sessionId).catch(() => null)
      const vp = layout?.cssVisualViewport || layout?.layoutViewport || layout?.visualViewport || null
      const w = Number(vp?.clientWidth)
      const h = Number(vp?.clientHeight)
      if (Number.isFinite(w) && w > 0) cx = w / 2
      if (Number.isFinite(h) && h > 0) cy = h / 2
    } catch {
      // Fall back to the configured default center.
    }
    entry._lastMouseX = cx
    entry._lastMouseY = cy
    return { x: cx, y: cy }
  }

  // Dispatch a stream of REAL CDP mouseMoved events walking from the workbench's
  // last pointer position to (x,y), so page scripts / anti-bot heuristics see the
  // pointer travel — not just teleport to the click point. Mirrors _cursorTo's
  // cosmetic glide: same Fitts's-law time budget, spread across distance-aware
  // steps, with deterministic (seeded, no Math.random) perpendicular jitter so
  // the path is a gentle arc rather than a ruler-straight line. Always leaves
  // entry._lastMouseX/Y at the destination. No-op (and still updates the cached
  // position) when the trajectory is disabled, so callers can fire-and-forget.
  async _humanMouseTrajectory(entry, x, y, sessionId = undefined, button = undefined, decisionGuard = null) {
    const destX = Math.max(0, Number(x) || 0)
    const destY = Math.max(0, Number(y) || 0)
    if (decisionGuard) decisionGuard()
    if (!this.mouseTrajectory || !entry?.client?.send) {
      entry._lastMouseX = destX
      entry._lastMouseY = destY
      return
    }
    const start = await this._lastMousePoint(entry, sessionId)
    if (decisionGuard) decisionGuard()
    const dx = destX - start.x
    const dy = destY - start.y
    const dist = Math.hypot(dx, dy)
    // Same Fitts's-law budget _cursorTo uses for its visual glide, so the real
    // pointer and the painted cursor land together.
    const total = Math.max(180, Math.min(this.cursorGlideMaxMs, 120 + 90 * Math.log2((2 * dist) / 40 + 1)))
    // Step count scales with distance (longer travel => more samples), clamped.
    const steps = Math.max(
      this.mouseTrajectoryMinSteps,
      Math.min(this.mouseTrajectoryMaxSteps, Math.round(this.mouseTrajectoryMinSteps + dist / 90))
    )
    // Perpendicular unit vector for the arc bow; amplitude scales with distance
    // but is capped so big jumps don't fling the pointer off-path.
    const nx = dist > 0 ? -dy / dist : 0
    const ny = dist > 0 ? dx / dist : 0
    const bow = Math.min(24, dist * 0.06)
    const perStep = total / steps
    for (let i = 1; i <= steps; i += 1) {
      if (decisionGuard) decisionGuard()
      const t = i / steps
      // Minimum-jerk ease (matches the symmetric ease-in-out of the visual glide).
      const e = t * t * t * (t * (t * 6 - 15) + 10)
      // Bell-shaped bow that returns to 0 at both ends, plus tiny seeded jitter.
      const arc = bow * Math.sin(Math.PI * t)
      const j = (this._seededJitter(i * 2654 + 7) - 0.5) * 2
      const px = start.x + dx * e + nx * (arc + j)
      const py = start.y + dy * e + ny * (arc + j)
      const move = { type: 'mouseMoved', x: Math.max(0, px), y: Math.max(0, py) }
      if (button) move.button = button
      await entry.client.send('Input.dispatchMouseEvent', move, sessionId).catch(() => undefined)
      if (i < steps && perStep > 0) await this._sleep(perStep)
    }
    entry._lastMouseX = destX
    entry._lastMouseY = destY
  }

  _interventionWatchSource() {
    return `(() => {
      const VERSION = 3;
      if (window.__fanInterventionWatchVersion === VERSION) {
        return { installed: true, version: VERSION, idempotent: true };
      }
      if (typeof window.__fanUserIntervened !== 'function') {
        throw new Error('fan takeover binding is unavailable');
      }
      const state = {
        scrollInitiatorAt: 0,
        scrollInitiatorKind: ''
      };
      const report = (event, inputKind, extra) => {
        try {
          if (!event || event.isTrusted !== true) return;
          const payload = Object.assign({
            trusted: true,
            eventType: String(event.type || ''),
            inputKind,
            timestamp: Date.now(),
            topFrame: window.top === window.self
          }, extra || {});
          window.__fanUserIntervened(JSON.stringify(payload));
        } catch (_) {}
      };
      const rememberScrollInitiator = kind => {
        state.scrollInitiatorAt = Date.now();
        state.scrollInitiatorKind = kind;
      };
      const onPointer = event => report(event, 'pointer', {
        x: Number(event.clientX) || 0,
        y: Number(event.clientY) || 0,
        button: Number(event.button) || 0,
        buttons: Number(event.buttons) || 0,
        pointerType: String(event.pointerType || 'mouse')
      });
      const onPointerMove = event => {
        const buttons = Number(event.buttons) || 0;
        // Chromium can emit a trusted pointermove when a BrowserView is
        // revealed, moved under a stationary cursor, or driven through CDP.
        // Hover alone is therefore not reliable evidence that the user took
        // control. Pointerdown already catches clicks; keep move detection only
        // for an active drag where a physical button is held.
        if (buttons <= 0) return;
        report(event, 'pointer-move', {
          x: Number(event.clientX) || 0,
          y: Number(event.clientY) || 0,
          buttons,
          pointerType: String(event.pointerType || 'mouse')
        });
      };
      const onKey = event => {
        const key = String(event.key || '');
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) {
          rememberScrollInitiator('keyboard');
        }
        report(event, 'keyboard', {
          key,
          code: String(event.code || ''),
          repeat: event.repeat === true,
          altKey: event.altKey === true,
          ctrlKey: event.ctrlKey === true,
          metaKey: event.metaKey === true,
          shiftKey: event.shiftKey === true
        });
      };
      const onInput = event => report(event, 'input', {
        data: event.data == null ? null : String(event.data),
        inputType: String(event.inputType || ''),
        composing: event.isComposing === true
      });
      const onWheel = event => {
        rememberScrollInitiator('wheel');
        report(event, 'wheel', {
          x: Number(event.clientX) || 0,
          y: Number(event.clientY) || 0,
          deltaX: Number(event.deltaX) || 0,
          deltaY: Number(event.deltaY) || 0,
          deltaMode: Number(event.deltaMode) || 0
        });
      };
      const onTouch = event => {
        rememberScrollInitiator('touch');
        const touch = event.touches && event.touches[0];
        report(event, 'touch', {
          x: touch ? Number(touch.clientX) || 0 : 0,
          y: touch ? Number(touch.clientY) || 0 : 0,
          touchCount: event.touches ? Number(event.touches.length) || 0 : 0
        });
      };
      const onScroll = event => {
        const age = Date.now() - state.scrollInitiatorAt;
        // Programmatic scroll events can be browser-generated and therefore
        // trusted. Only project a scroll that directly follows a trusted wheel,
        // touch gesture, or scroll key; scrollbar drags are already caught by
        // pointerdown.
        if (age < 0 || age > 750 || !state.scrollInitiatorKind) return;
        report(event, 'scroll', { initiatorKind: state.scrollInitiatorKind });
      };
      document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
      document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
      document.addEventListener('keydown', onKey, { capture: true });
      document.addEventListener('input', onInput, { capture: true });
      document.addEventListener('wheel', onWheel, { capture: true, passive: true });
      document.addEventListener('touchstart', onTouch, { capture: true, passive: true });
      document.addEventListener('scroll', onScroll, { capture: true, passive: true });
      window.__fanInterventionWatchVersion = VERSION;
      return { installed: true, version: VERSION, idempotent: false };
    })()`
  }

  _interventionTargetKey(sessionId = undefined) {
    return sessionId == null || sessionId === '' ? 'main' : String(sessionId)
  }

  async _refreshInterventionContext(entry, sessionId = undefined, contextId = undefined) {
    if (!entry?.client?.send) return false
    const numericContextId = Number(contextId)
    const result = await entry.client.send(
      'Runtime.evaluate',
      {
        expression: this._interventionWatchSource(),
        ...(Number.isFinite(numericContextId) ? { contextId: numericContextId } : {}),
        returnByValue: true
      },
      sessionId
    )
    const value = result?.result?.value
    if (result?.exceptionDetails || value?.installed !== true) {
      const reason = result?.exceptionDetails?.text ||
        'document did not acknowledge takeover-listener installation'
      throw new Error(reason)
    }
    return true
  }

  async _armInterventionTarget(entry, sessionId = undefined) {
    const key = this._interventionTargetKey(sessionId)
    if (entry._interventionArmedSessions?.has(key)) return true
    const source = this._interventionWatchSource()
    const correlationId = `${String(entry.id)}:${key}`
    let lastError = null

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let scriptIdentifier = null
      let markedArming = false
      try {
        await entry.client.send('Runtime.enable', {}, sessionId)
        await entry.client
          .send('Runtime.addBinding', { name: '__fanUserIntervened' }, sessionId)
          .catch(error => {
            // A prior partial attempt may already have installed the binding.
            // CDP implementations differ on whether duplicate addBinding is
            // idempotent or reports an "already exists" error.
            if (/already|exist|duplicate/i.test(String(error?.message || error))) return undefined
            throw error
          })
        if (!entry._interventionArmingSessions) {
          entry._interventionArmingSessions = new Set()
        }
        entry._interventionArmingSessions.add(key)
        markedArming = true
        let pageDomainAvailable = true
        try {
          await entry.client.send('Page.enable', {}, sessionId)
        } catch (error) {
          if (!/Page\.enable.*(?:wasn't found|not found)|(?:wasn't found|not found).*Page\.enable/i.test(
            String(error?.message || error)
          )) {
            throw error
          }
          // Chromium exposes OOPIFs as attached Runtime targets without a Page
          // domain. The binding and current-context listener are still valid;
          // Runtime.executionContextCreated refreshes the listener after future
          // document changes on this target.
          pageDomainAvailable = false
        }
        if (pageDomainAvailable) {
          const added = await entry.client.send(
            'Page.addScriptToEvaluateOnNewDocument',
            { source },
            sessionId
          )
          scriptIdentifier = added?.identifier || null
        }
        await this._refreshInterventionContext(entry, sessionId)

        // addScriptToEvaluateOnNewDocument covers every future frame. Install
        // the listener into already-existing reachable child frames as well;
        // OOPIF roots are handled through their attached target sessions.
        const frameTreeResult = pageDomainAvailable
          ? await entry.client
              .send('Page.getFrameTree', {}, sessionId)
              .catch(() => null)
          : null
        const childFrameIds = []
        const collectFrames = node => {
          for (const child of Array.isArray(node?.childFrames) ? node.childFrames : []) {
            const frameId = child?.frame?.id
            if (frameId) childFrameIds.push(String(frameId))
            collectFrames(child)
          }
        }
        collectFrames(frameTreeResult?.frameTree)
        const attachedTargetIds = new Set(
          typeof entry.targetManager?.attachedTargets === 'function'
            ? entry.targetManager.attachedTargets()
                .map(target => target?.targetId)
                .filter(Boolean)
                .map(String)
            : []
        )
        for (const frameId of childFrameIds) {
          if (attachedTargetIds.has(frameId)) continue
          const world = await entry.client.send(
            'Page.createIsolatedWorld',
            {
              frameId,
              worldName: '__fan_takeover_watch_v2',
              grantUniveralAccess: false
            },
            sessionId
          )
          const contextId = Number(world?.executionContextId)
          if (!Number.isFinite(contextId)) {
            throw new Error(`takeover listener world unavailable for frame ${frameId}`)
          }
          const childCurrent = await entry.client.send(
            'Runtime.evaluate',
            { expression: source, contextId, returnByValue: true },
            sessionId
          )
          if (
            childCurrent?.exceptionDetails ||
            childCurrent?.result?.value?.installed !== true
          ) {
            throw new Error(`takeover listener install failed for frame ${frameId}`)
          }
        }

        if (!entry._interventionArmedSessions) entry._interventionArmedSessions = new Set()
        if (!entry._interventionWatchScripts) entry._interventionWatchScripts = new Map()
        entry._interventionArmedSessions.add(key)
        if (scriptIdentifier) entry._interventionWatchScripts.set(key, scriptIdentifier)
        entry._interventionArmed = entry._interventionArmedSessions.has('main')
        entry._interventionArmingSessions.delete(key)
        markedArming = false
        this.log?.(
          `[browser-takeover-arm:${correlationId}] armed attempt=${attempt} ` +
          `workbench=${entry.id} target=${key} ` +
          `mode=${pageDomainAvailable ? 'page+runtime' : 'runtime-only'}`
        )
        return true
      } catch (error) {
        lastError = error
        if (markedArming) entry._interventionArmingSessions?.delete(key)
        if (scriptIdentifier) {
          await entry.client
            .send(
              'Page.removeScriptToEvaluateOnNewDocument',
              { identifier: scriptIdentifier },
              sessionId
            )
            .catch(() => undefined)
        }
        this.log?.(
          `[browser-takeover-arm:${correlationId}] failed attempt=${attempt}/3 ` +
          `error=${error?.message || String(error)}`
        )
        if (attempt < 3) await this._sleep(40 * attempt)
      }
    }

    const error = new Error(
      `Human-input takeover watch could not be armed for ${entry.id} (${key}): ` +
      `${lastError?.message || 'unknown error'}`
    )
    error.code = 'INTERVENTION_WATCH_ARM_FAILED'
    error.details = { workbenchId: String(entry.id), targetSessionId: key, attempts: 3 }
    throw error
  }

  // Install the binding, future-document script, and current-document listener
  // as one acknowledgement boundary. `_interventionArmed` is set only after all
  // three steps succeed. Target sessions are tracked separately so newly
  // attached OOPIFs can be armed without reinstalling the main target.
  async _armInterventionWatch(entry, { sessionIds = null } = {}) {
    if (!entry || !entry?.client?.send) return false
    if (!this._isControlActive(entry.sessionId) && !entry._interventionArmed) return false
    if (entry._interventionArmPromise && !Array.isArray(sessionIds)) {
      return entry._interventionArmPromise
    }
    if (!Array.isArray(sessionIds) && typeof entry.targetManager?.start === 'function') {
      await entry.targetManager.start().catch(() => false)
    }
    const requested = new Set(
      Array.isArray(sessionIds)
        ? sessionIds
        : [
            undefined,
            ...(typeof entry.targetManager?.attachedTargets === 'function'
              ? entry.targetManager.attachedTargets().map(target => target?.sessionId).filter(Boolean)
              : [])
          ]
    )
    const arm = async () => {
      for (const targetSessionId of requested) {
        const key = this._interventionTargetKey(targetSessionId)
        if (!entry._interventionArmTargetPromises) {
          entry._interventionArmTargetPromises = new Map()
        }
        let targetPromise = entry._interventionArmTargetPromises.get(key)
        if (!targetPromise) {
          targetPromise = this._armInterventionTarget(entry, targetSessionId)
          entry._interventionArmTargetPromises.set(key, targetPromise)
        }
        try {
          await targetPromise
        } finally {
          if (entry._interventionArmTargetPromises.get(key) === targetPromise) {
            entry._interventionArmTargetPromises.delete(key)
          }
        }
      }
      return true
    }
    if (Array.isArray(sessionIds)) return arm()
    entry._interventionArmPromise = arm()
    try {
      return await entry._interventionArmPromise
    } finally {
      entry._interventionArmPromise = null
    }
  }

  async _drainInterventionEvents(sessionId) {
    const sid = this._controlSessionId(sessionId)
    const drains = []

    for (const entry of this.workbenches.values()) {
      if (
        this._sessionIdForEntry(entry) !== sid ||
        !entry?.client?.send ||
        entry.retired ||
        entry.webContents?.isDestroyed?.()
      ) {
        continue
      }

      const armed = entry._interventionArmedSessions
      const targets = []
      if (armed?.has('main') || entry._interventionArmed === true) {
        targets.push(undefined)
      }
      if (typeof entry.targetManager?.attachedTargets === 'function') {
        for (const target of entry.targetManager.attachedTargets()) {
          const targetSessionId = target?.sessionId == null
            ? ''
            : String(target.sessionId)
          if (
            targetSessionId &&
            armed?.has(this._interventionTargetKey(targetSessionId))
          ) {
            targets.push(targetSessionId)
          }
        }
      }

      for (const targetSessionId of new Set(targets)) {
        drains.push({
          entryId: String(entry.id || ''),
          targetSessionId: this._interventionTargetKey(targetSessionId),
          promise: entry.client.send(
            'Runtime.evaluate',
            {
              expression: 'void 0',
              returnByValue: false,
              silent: true
            },
            targetSessionId,
            1000
          )
        })
      }
    }

    if (!drains.length) return true
    const results = await Promise.allSettled(drains.map(item => item.promise))
    let complete = true
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      complete = false
      const item = drains[index]
      this.log?.(
        `[browser-takeover-drain:${sid}:${item.targetSessionId}] failed ` +
        `workbench=${item.entryId} error=${result.reason?.message || result.reason}`
      )
    })
    return complete
  }

  _agentInputClaimsForDispatch(entry, method, params = {}, sessionId = undefined) {
    if (!entry || !this._isControlActive(entry.sessionId)) return []
    const targetSessionId = this._interventionTargetKey(sessionId)
    if (!entry._interventionArmedSessions?.has(targetSessionId)) return []
    const now = Date.now()
    const sequence = Math.max(0, Number(entry._agentInputSequence) || 0) + 1
    entry._agentInputSequence = sequence
    const dispatchId = `${entry.id}:${sequence}`
    const base = {
      dispatchId,
      targetSessionId,
      createdAt: now,
      expiresAt: now + 750,
      remaining: 1
    }
    const claims = []
    const push = (eventType, inputKind, details = {}) => {
      claims.push({ ...base, eventType, inputKind, ...details })
    }
    const cdpMethod = String(method || '')
    if (cdpMethod === 'Input.dispatchMouseEvent') {
      const type = String(params.type || '')
      if (type === 'mouseMoved') {
        push('pointermove', 'pointer-move', {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          pointerType: 'mouse'
        })
      } else if (type === 'mousePressed') {
        const buttonMap = { left: 0, middle: 1, right: 2, back: 3, forward: 4 }
        push('pointerdown', 'pointer', {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          button: buttonMap[String(params.button || 'left')] ?? 0,
          pointerType: 'mouse'
        })
      } else if (type === 'mouseWheel') {
        push('wheel', 'wheel', {
          x: Number(params.x) || 0,
          y: Number(params.y) || 0,
          deltaX: Number(params.deltaX) || 0,
          deltaY: Number(params.deltaY) || 0
        })
        push('scroll', 'scroll', { remaining: 32 })
      }
    } else if (cdpMethod === 'Input.dispatchKeyEvent') {
      const type = String(params.type || '')
      if (type === 'keyDown' || type === 'rawKeyDown') {
        const key = String(params.key || '')
        const isUnmappedUnicodeKey = Number(params.windowsVirtualKeyCode) === 0 &&
          Array.from(key).some(character => (character.codePointAt(0) ?? 0) > 0x7f)
        // Chromium normalizes a CDP CJK keyDown differently at the DOM boundary
        // (commonly an empty/Unidentified key or code), so exact key/code
        // comparison makes the Agent's own first Chinese character look like a
        // human takeover. For only these unmapped Unicode keys, ownership is
        // still narrowly scoped by target session, event type, dispatch order,
        // one-event cardinality and the short claim lifetime.
        push(
          'keydown',
          'keyboard',
          isUnmappedUnicodeKey ? {} : { key, code: String(params.code || '') }
        )
        if (key === 'Backspace') push('input', 'input', { inputType: 'deleteContentBackward' })
        if (key === 'Delete') push('input', 'input', { inputType: 'deleteContentForward' })
        if (key === 'Enter') push('input', 'input', { inputTypePrefix: 'insert' })
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(key)) {
          push('scroll', 'scroll', { remaining: 16 })
        }
      } else if (type === 'char') {
        push('input', 'input', { data: params.text == null ? null : String(params.text) })
      }
    } else if (cdpMethod === 'Input.insertText') {
      push('input', 'input', { data: params.text == null ? null : String(params.text) })
    } else if (cdpMethod === 'DOM.setFileInputFiles') {
      // Chromium emits a trusted `input` event after CDP assigns files. Without
      // an ownership claim, a successful fan.upload() is indistinguishable from
      // the user choosing a file and falsely trips browser takeover.
      push('input', 'input')
    } else if (cdpMethod === 'Input.dispatchTouchEvent' && String(params.type || '') === 'touchStart') {
      const point = Array.isArray(params.touchPoints) ? params.touchPoints[0] : null
      push('touchstart', 'touch', {
        x: Number(point?.x) || 0,
        y: Number(point?.y) || 0
      })
      push('pointerdown', 'pointer', {
        x: Number(point?.x) || 0,
        y: Number(point?.y) || 0,
        pointerType: 'touch'
      })
      push('scroll', 'scroll', { remaining: 32 })
    } else if (cdpMethod === 'Input.synthesizeScrollGesture') {
      // Chromium materializes a synthesized scroll gesture as trusted DOM
      // `wheel` events before the resulting `scroll` events. Claim both. The
      // coordinate match keeps the ownership narrow to this exact Agent
      // gesture; otherwise fan.scroll() is reported back as user takeover.
      push('wheel', 'wheel', {
        x: Number(params.x) || 0,
        y: Number(params.y) || 0,
        remaining: 64,
        expiresAt: now + 1500
      })
      push('scroll', 'scroll', { remaining: 64, expiresAt: now + 1500 })
    }
    // A native click on checkbox/radio controls (and the exact JavaScript
    // fallback for those controls) emits a trusted DOM `input` in addition to
    // pointerdown. Associate only that declared derived event with this exact
    // dispatch; a broad post-click suppression window could swallow a real
    // user's keystroke.
    if (params?._fanExpectedInputEvent === true) {
      // Native checkbox/radio activation reports an empty inputType. Requiring
      // that shape prevents the claim from matching a concurrent typed edit.
      push('input', 'input', { inputType: '' })
    }
    return claims
  }

  _beginAgentInputDispatch(entry, method, params = {}, sessionId = undefined) {
    const claims = this._agentInputClaimsForDispatch(entry, method, params, sessionId)
    if (!claims.length) return null
    const now = Date.now()
    const retained = Array.isArray(entry._agentInputClaims)
      ? entry._agentInputClaims.filter(claim => Number(claim?.expiresAt) >= now)
      : []
    retained.push(...claims)
    entry._agentInputClaims = retained.slice(-96)
    return { dispatchId: claims[0].dispatchId, claims }
  }

  _finishAgentInputDispatch(entry, ownership, error = null) {
    if (!entry || !ownership?.dispatchId || !Array.isArray(entry._agentInputClaims)) return
    const now = Date.now()
    if (error) {
      entry._agentInputClaims = entry._agentInputClaims.filter(
        claim => claim.dispatchId !== ownership.dispatchId
      )
      return
    }
    entry._agentInputClaims = entry._agentInputClaims
      .filter(claim => Number(claim?.expiresAt) >= now)
      .map(claim => (
        claim.dispatchId === ownership.dispatchId
          ? { ...claim, completedAt: now, expiresAt: Math.min(Number(claim.expiresAt), now + 400) }
          : claim
      ))
  }

  _consumeAgentInputDispatch(entry, info = {}, targetSessionId = undefined) {
    if (!entry || !Array.isArray(entry._agentInputClaims)) return null
    const now = Date.now()
    const targetKey = this._interventionTargetKey(targetSessionId)
    const sameTargetNestedFrameEvent = (
      info.topFrame === false &&
      targetKey === 'main'
    )
    const closeNumber = (left, right, tolerance = 1.5) => (
      Number.isFinite(Number(left)) &&
      Number.isFinite(Number(right)) &&
      Math.abs(Number(left) - Number(right)) <= tolerance
    )
    const matches = claim => {
      if (claim.targetSessionId !== targetKey) return false
      if (claim.eventType !== String(info.eventType || '')) return false
      if (claim.inputKind !== String(info.inputKind || '')) return false
      for (const key of ['x', 'y', 'deltaX', 'deltaY']) {
        // A same-process child reports clientX/clientY in its own viewport,
        // while CDP mouse input sent through the main target uses root
        // coordinates. OOPIF input has its own target-local session and keeps
        // exact coordinates; only skip the incompatible same-target pair.
        if (sameTargetNestedFrameEvent && (key === 'x' || key === 'y')) continue
        if (claim[key] != null && !closeNumber(claim[key], info[key])) return false
      }
      for (const key of ['button', 'pointerType', 'key', 'code', 'data', 'inputType']) {
        if (claim[key] != null && String(claim[key]) !== String(info[key] ?? '')) return false
      }
      if (
        claim.inputTypePrefix &&
        !String(info.inputType || '').startsWith(String(claim.inputTypePrefix))
      ) return false
      return true
    }

    let matched = null
    const next = []
    for (const claim of entry._agentInputClaims) {
      if (Number(claim?.expiresAt) < now) continue
      if (!matched && matches(claim)) {
        matched = claim
        const remaining = Math.max(0, Number(claim.remaining) || 1) - 1
        if (remaining > 0) next.push({ ...claim, remaining })
        continue
      }
      next.push(claim)
    }
    entry._agentInputClaims = next
    return matched
  }

  // Kept for the existing click/input call sites. Agent ownership is now
  // established automatically around the exact CDP Input.* dispatch by the
  // workbench client wrapper, so there is no page-global suppression window.
  async _markActingOn() {
    return false
  }
}

function installVisualOperations(Runtime) {
  for (const name of Object.getOwnPropertyNames(VisualOperations.prototype)) {
    if (name === 'constructor') continue
    Object.defineProperty(
      Runtime.prototype,
      name,
      Object.getOwnPropertyDescriptor(VisualOperations.prototype, name)
    )
  }
}

module.exports = { installVisualOperations }
