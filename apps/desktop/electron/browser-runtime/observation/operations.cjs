'use strict'

const { EVENT_TYPES } = require('../events/event-types.cjs')
const { buildObserveExpression, buildPageMetadataExpression } = require('../dom/dom-service.cjs')
const {
  buildDomDocumentElements,
  buildEnhancedSnapshotState,
  buildSnapshotElements,
  mergeObservedElements,
  snapshotBelongsToTarget,
  snapshotCaptureParams
} = require('../dom/snapshot-service.cjs')
const { buildAccessibilitySummary, mergeAccessibility } = require('../dom/accessibility-service.cjs')
const {
  detectPagination,
  formatElementsText,
  formatSupplementalElementsText,
  formatTargetFrameBlock,
  haystackForElement,
  isDisabledElement,
  remapTargetFrameText,
  serializedBackendNodeLineIndexes,
  stitchTargetFramesIntoDomText,
  targetFrameHeaderAttrs
} = require('../dom/observation-format.cjs')
const pipelineLog = require('../pipeline-log.cjs')

// CDP BackendNodeId is a protocol `integer` (signed 32-bit). Model-facing
// synthetic ids live above that range so selector-only and attached-target
// elements can never overwrite a main-document backend id in SelectorMap.
const SYNTHETIC_SELECTOR_INDEX_BASE = 0x80000000
const STALE_OBSERVATION = Symbol('stale-observation')

class ObservationOperations {
  // Derive PDF state from watchdog evidence rather than a URL suffix. This is
  // observation metadata and has no reason to live in the action runtime.
  _pdfViewerInfo(entry, url) {
    const value = String(url || '')
    const watchdog = entry?.watchdog
    const isChromeViewer =
      /^chrome-extension:\/\/.*pdf/i.test(value) || (/^chrome:\/\//i.test(value) && /pdf/i.test(value))
    const downloadedRaw = watchdog?.downloadedUrlPaths?.get?.(value)
    const downloadedPath = downloadedRaw && /\.pdf$/i.test(String(downloadedRaw)) ? downloadedRaw : undefined
    let pdfMime = watchdog?.pdfViewerCache?.get?.(value) === true
    if (!pdfMime && Array.isArray(watchdog?.downloads)) {
      pdfMime = watchdog.downloads.some(record => {
        const download = record?.download || {}
        return download.url === value && String(download.mimeType || '').toLowerCase() === 'application/pdf'
      })
    }

    const isPdfViewer = Boolean(isChromeViewer || downloadedPath || pdfMime)
    let pdfDownloadPath = isPdfViewer ? downloadedPath : undefined
    if (isPdfViewer && !pdfDownloadPath && Array.isArray(watchdog?.downloads)) {
      for (let index = watchdog.downloads.length - 1; index >= 0; index -= 1) {
        const download = watchdog.downloads[index]?.download || {}
        const isPdf =
          String(download.mimeType || '').toLowerCase() === 'application/pdf' ||
          String(download.fileType || '').toLowerCase() === 'pdf'
        const savePath = download.savePath || download.path || ''
        if (isPdf && savePath) {
          pdfDownloadPath = savePath
          break
        }
      }
    }
    return { isPdfViewer, pdfDownloadPath }
  }

  async _detectJsClickListenerBackendIds(entry, sessionId = undefined) {
    const objectGroup = `fan-browser-listeners-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const result = await entry.client.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          if (typeof getEventListeners !== 'function') return [];
          // 穿透 shadow DOM 收集元素:shadow 里
          // 通过 addEventListener 绑定点击的控件此前完全检测不到。保留 10000 上限(与上游一致)。
          const allElements = [];
          const walk = root => {
            if (allElements.length > 10000) return;
            const list = root.querySelectorAll ? root.querySelectorAll('*') : [];
            for (const el of list) {
              allElements.push(el);
              if (el.shadowRoot) walk(el.shadowRoot);
              if (allElements.length > 10000) return;
            }
          };
          walk(document);
          if (allElements.length > 10000) return [];
          const elements = [];
          for (const el of allElements) {
            try {
              // only assigns actionable nodes that have geometry.
              // Skip non-rendered nodes and SVG paint primitives before the
              // expensive DevTools getEventListeners call; neither can become
              // an independent indexed action target in our serializer.
              if (el.ownerSVGElement) continue;
              const tag = String(el.tagName || '').toLowerCase();
              if (['html','body','head','meta','link','style','script','title'].includes(tag)) continue;
              const rect = el.getBoundingClientRect();
              if (!rect || rect.width <= 0 || rect.height <= 0) continue;
              const listeners = getEventListeners(el);
              if (listeners.click || listeners.mousedown || listeners.mouseup || listeners.pointerdown || listeners.pointerup) {
                elements.push(el);
              }
            } catch (_) {}
          }
          return elements;
        })()`,
        includeCommandLineAPI: true,
        objectGroup,
        returnByValue: false
      },
      sessionId
    )
    const objectId = result?.result?.objectId
    if (!objectId) return new Set()
    try {
      const props = await entry.client.send(
        'Runtime.getProperties',
        { objectId, ownProperties: true },
        sessionId
      )
      const objectIds = []
      for (const prop of props?.result || []) {
        const name = String(prop?.name || '')
        if (!/^\d+$/.test(name)) continue
        const childObjectId = prop?.value?.objectId
        if (childObjectId) objectIds.push(childObjectId)
      }
      const backendIds = []
      const boundedObjectIds = objectIds.slice(0, 500)
      // Avoid a 500-promise/CDP burst. Small batches retain the exact same
      // listener coverage while bounding transient allocations and debugger
      // queue pressure on pages with delegated click handlers everywhere.
      for (let offset = 0; offset < boundedObjectIds.length; offset += 32) {
        const batch = boundedObjectIds.slice(offset, offset + 32)
        const describedBatch = await Promise.all(
          batch.map(async childObjectId => {
            try {
              const described = await entry.client.send('DOM.describeNode', { objectId: childObjectId }, sessionId)
              const backendNodeId = Number(described?.node?.backendNodeId)
              return Number.isFinite(backendNodeId) ? backendNodeId : null
            } catch {
              return null
            }
          })
        )
        backendIds.push(...describedBatch)
      }
      return new Set(backendIds.filter(Number.isFinite))
    } finally {
      let groupReleased = false
      try {
        await entry.client.send('Runtime.releaseObjectGroup', { objectGroup }, sessionId)
        groupReleased = true
      } catch {
        // Older/debugger-limited targets can reject releaseObjectGroup.
      }
      if (!groupReleased) {
        await entry.client.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined)
      }
    }
  }

  async _captureDomDocument(entry, sessionId = undefined) {
    await entry.client.send('DOM.enable', {}, sessionId).catch(() => undefined)
    return entry.client.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId)
  }

  _frameIdsFromFrameTree(frameTreeNode = null) {
    const ids = []
    const visit = node => {
      const frameId = String(node?.frame?.id || '')
      if (frameId) ids.push(frameId)
      for (const child of node?.childFrames || []) visit(child)
    }
    visit(frameTreeNode)
    return ids
  }

  async _captureAccessibility(entry, sessionId = undefined) {
    await entry.client.send('Accessibility.enable', {}, sessionId).catch(() => undefined)
    let frameIds = []
    try {
      await entry.client.send('Page.enable', {}, sessionId).catch(() => undefined)
      const frameTreeResult = await entry.client.send('Page.getFrameTree', {}, sessionId)
      frameIds = this._frameIdsFromFrameTree(frameTreeResult?.frameTree)
    } catch {
      frameIds = []
    }

    // AX 抓取是辅助信号(observe 阶段 3 本就容忍 accessibilityError):给它 10s 独立超时,
    // 防繁忙页面上一个挂死的 getFullAXTree 吃满 observe 的整个 60s 动作预算
    // (真机 bug:bing 搜索页 settled=false 时 observe 超时 60s,browser_search 共烧 68s)。
    const AX_TIMEOUT_MS = 10000
    if (frameIds.length) {
      const results = await Promise.allSettled(
        frameIds.map(frameId => entry.client.send('Accessibility.getFullAXTree', { frameId }, sessionId, AX_TIMEOUT_MS))
      )
      const nodes = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          nodes.push(...(result.value?.nodes || []))
          continue
        }
        if (index === 0) throw result.reason
      }
      if (nodes.length) return buildAccessibilitySummary({ nodes })
    }

    const axTree = await entry.client.send('Accessibility.getFullAXTree', {}, sessionId, AX_TIMEOUT_MS)
    return buildAccessibilitySummary(axTree)
  }

  async _collectFrameTreeFromSession(entry, { frames, targetId = '', sessionId = undefined, target = null } = {}) {
    const targetType = String(target?.type || '').toLowerCase()
    const targetUrl = String(target?.url || '')
    await entry.client.send('Page.enable', {}, sessionId).catch(() => undefined)
    const result = await entry.client.send('Page.getFrameTree', {}, sessionId)
    const walk = (node = {}, parentFrameId = '') => {
      const frame = node.frame || {}
      const frameId = String(frame.id || '')
      if (!frameId) return
      const childFrames = Array.isArray(node.childFrames) ? node.childFrames : []
      const childFrameIds = childFrames.map(child => String(child?.frame?.id || '')).filter(Boolean)
      const actualParentFrameId = String(frame.parentId || parentFrameId || '')
      const crossOriginType = String(frame.crossOriginIsolatedContextType || '')
      const frameInfo = {
        ...frame,
        frameId,
        frameTargetId: targetId,
        targetId,
        sessionId: sessionId || '',
        targetType,
        targetUrl,
        parentFrameId: actualParentFrameId,
        childFrameIds,
        isCrossOrigin: targetType === 'iframe' || (crossOriginType && crossOriginType !== 'NotIsolated')
      }

      const existing = frames.get(frameId)
      if (existing) {
        const mergedChildIds = new Set([...(existing.childFrameIds || []), ...childFrameIds])
        existing.childFrameIds = Array.from(mergedChildIds)
        existing.parentFrameId = existing.parentFrameId || actualParentFrameId
        existing.isCrossOrigin = Boolean(existing.isCrossOrigin || frameInfo.isCrossOrigin)
        if (targetType === 'iframe' || (!existing.sessionId && sessionId)) {
          existing.frameTargetId = targetId || existing.frameTargetId
          existing.targetId = targetId || existing.targetId
          existing.sessionId = sessionId || existing.sessionId
          existing.targetType = targetType || existing.targetType
          existing.targetUrl = targetUrl || existing.targetUrl
        }
      } else {
        frames.set(frameId, frameInfo)
      }

      for (const child of childFrames) walk(child, frameId)
    }
    walk(result?.frameTree || {})
  }

  async _populateFrameOwnerMetadata(entry, frames) {
    for (const frame of frames.values()) {
      const parentFrameId = String(frame.parentFrameId || '')
      if (!parentFrameId) continue
      const parent = frames.get(parentFrameId)
      if (!parent) continue
      frame.parentTargetId = parent.frameTargetId || ''
      frame.parentSessionId = parent.sessionId || ''
      try {
        const parentSessionId = parent.sessionId || undefined
        await entry.client.send('DOM.enable', {}, parentSessionId).catch(() => undefined)
        const owner = await entry.client.send('DOM.getFrameOwner', { frameId: frame.frameId || frame.id }, parentSessionId)
        if (owner?.backendNodeId != null) {
          frame.backendNodeId = owner.backendNodeId
          frame.frameOwnerBackendNodeId = owner.backendNodeId
        }
        if (owner?.nodeId != null) {
          frame.nodeId = owner.nodeId
          frame.frameOwnerNodeId = owner.nodeId
        }
      } catch {
        frame.frameOwnerUnavailable = true
      }
    }
  }

  async _collectFrameMetadata(entry) {
    const frames = new Map()
    const attachedTargets =
      typeof entry.targetManager?.attachedTargets === 'function' ? entry.targetManager.attachedTargets() : []

    try {
      await this._collectFrameTreeFromSession(entry, {
        frames,
        targetId: '',
        sessionId: undefined,
        target: { type: 'page', url: entry.webContents?.getURL?.() || '' }
      })
    } catch (error) {
      this.log?.(`browser-runtime frame tree collection failed for main target: ${error.message}`)
    }

    for (const item of attachedTargets) {
      if (!item?.sessionId) continue
      try {
        await this._collectFrameTreeFromSession(entry, {
          frames,
          targetId: item.targetId || '',
          sessionId: item.sessionId,
          target: item.target || null
        })
      } catch (error) {
        this.log?.(`browser-runtime frame tree collection failed for target ${item.targetId || item.sessionId}: ${error.message}`)
      }
    }

    await this._populateFrameOwnerMetadata(entry, frames)
    const frameList = Array.from(frames.values())
    const byFrameId = {}
    const byTargetId = {}
    for (const frame of frameList) {
      if (frame.frameId) byFrameId[frame.frameId] = frame
      if (frame.frameTargetId && !byTargetId[frame.frameTargetId]) byTargetId[frame.frameTargetId] = frame
      if (frame.targetId && !byTargetId[frame.targetId]) byTargetId[frame.targetId] = frame
    }
    return { frames: frameList, byFrameId, byTargetId }
  }

  _frameForTarget(item, frameMetadata) {
    if (!item || !frameMetadata) return null
    const targetId = String(item.targetId || '')
    const targetUrl = String(item.target?.url || '')
    if (targetId && frameMetadata.byTargetId?.[targetId]) return frameMetadata.byTargetId[targetId]
    const frames = Array.isArray(frameMetadata.frames) ? frameMetadata.frames : []
    if (targetId) {
      const exact = frames.find(frame => frame.frameTargetId === targetId || frame.targetId === targetId)
      if (exact) return exact
    }
    if (targetUrl) {
      return frames.find(frame => frame.targetUrl === targetUrl || frame.url === targetUrl) || null
    }
    return null
  }

  async _frameOwnerInteractionState(entry, frame = {}) {
    const backendNodeId = Number(
      frame.frameOwnerBackendNodeId ??
      frame.backendNodeId
    )
    if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0) {
      return { known: false, visible: false, explicitlyPassive: false }
    }
    const parentSessionId = frame.parentSessionId || undefined
    let objectId = ''
    try {
      const resolved = await entry.client.send(
        'DOM.resolveNode',
        { backendNodeId },
        parentSessionId
      )
      objectId = String(resolved?.object?.objectId || '')
      if (!objectId) {
        return { known: false, visible: false, explicitlyPassive: false }
      }
      const evaluated = await entry.client.send(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function () {
            if (!this || this.nodeType !== Node.ELEMENT_NODE) {
              return { known: false, visible: false, explicitlyPassive: false };
            }
            let opacity = 1;
            let cursor = this;
            const hintParts = [];
            while (cursor && cursor.nodeType === Node.ELEMENT_NODE) {
              const style = window.getComputedStyle(cursor);
              hintParts.push(
                cursor.getAttribute('src') || '',
                cursor.getAttribute('title') || '',
                cursor.id || '',
                typeof cursor.className === 'string' ? cursor.className : ''
              );
              if (
                !style ||
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                cursor.hidden === true ||
                cursor.getAttribute('aria-hidden') === 'true'
              ) {
                return { known: true, visible: false, explicitlyPassive: false };
              }
              const ownOpacity = Number(style.opacity);
              if (Number.isFinite(ownOpacity)) opacity *= ownOpacity;
              cursor = cursor.parentElement;
            }
            const rect = this.getBoundingClientRect();
            const style = window.getComputedStyle(this);
            const visible = Boolean(
              opacity > 0.05 &&
              style.pointerEvents !== 'none' &&
              rect.width > 8 &&
              rect.height > 8 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < window.innerHeight &&
              rect.left < window.innerWidth
            );
            const hint = hintParts.filter(Boolean).join(' ');
            const explicitlyPassive =
              /(?:[?&]size=invisible\\b|grecaptcha-badge|rc-anchor-invisible|invisible[-_ ]?recaptcha)/i.test(hint);
            return { known: true, visible, explicitlyPassive };
          }`,
          returnByValue: true,
          awaitPromise: false
        },
        parentSessionId
      )
      const state = evaluated?.result?.value
      if (!state || typeof state !== 'object') {
        return { known: false, visible: false, explicitlyPassive: false }
      }
      return {
        known: state.known === true,
        visible: state.visible === true,
        explicitlyPassive: state.explicitlyPassive === true
      }
    } catch {
      return { known: false, visible: false, explicitlyPassive: false }
    } finally {
      if (objectId) {
        await entry.client.send(
          'Runtime.releaseObject',
          { objectId },
          parentSessionId
        ).catch(() => undefined)
      }
    }
  }

  _compactFrameMetadata(frame = {}) {
    const keys = [
      'frameId',
      'id',
      'url',
      'securityOrigin',
      'mimeType',
      'frameTargetId',
      'targetId',
      'sessionId',
      'targetType',
      'targetUrl',
      'parentFrameId',
      'parentTargetId',
      'parentSessionId',
      'childFrameIds',
      'isCrossOrigin',
      'backendNodeId',
      'nodeId',
      'frameOwnerBackendNodeId',
      'frameOwnerNodeId',
      'frameOwnerUnavailable'
    ]
    const compact = {}
    for (const key of keys) {
      if (frame[key] != null && frame[key] !== '') compact[key] = frame[key]
    }
    return compact
  }

  _syntheticSelectorIdentity(element = {}) {
    const scope = String(element.sessionId || element.frameId || element.targetId || 'main')
    const backendNodeId = Number(element.backendNodeId)
    if (element.source === 'target-session' && Number.isFinite(backendNodeId)) {
      return `target:${scope}:backend:${backendNodeId}`
    }
    const pathValue = Array.isArray(element.path) && element.path.length
      ? element.path
      : { selector: element.selector || '', framePath: element.framePath || [] }
    const rect = element.rect || {}
    const geometry = [rect.left ?? rect.x, rect.top ?? rect.y, rect.width, rect.height]
      .map(value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : '')
      .join(',')
    return `${element.source || 'in-page'}:${scope}:selector:${JSON.stringify(pathValue)}:${geometry}`
  }

  _assignStableSelectorIndexes(state, elements = []) {
    if (!state) return elements
    if (!(state.syntheticSelectorIndexes instanceof Map)) state.syntheticSelectorIndexes = new Map()
    const registry = state.syntheticSelectorIndexes
    const reserved = new Set()
    for (const element of elements) {
      // Preserve the key written into window.__fanBrowserRuntimeSelectorMap
      // before replacing a model-facing index with a BackendNodeId. Fallback
      // observations do not all pass through DomService, so doing this only in
      // the serializer leaves some selector actions pointing at the wrong key.
      if (element?.selector && element.selectorIndex == null && Number.isFinite(Number(element.index))) {
        element.selectorIndex = Number(element.index)
      }
      const backendNodeId = Number(element?.backendNodeId)
      if (element?.source !== 'target-session' && Number.isSafeInteger(backendNodeId) && backendNodeId >= 0) {
        element.index = backendNodeId
        reserved.add(backendNodeId)
      }
    }

    let nextIndex = Math.max(
      SYNTHETIC_SELECTOR_INDEX_BASE,
      Number(state.nextSyntheticSelectorIndex) || SYNTHETIC_SELECTOR_INDEX_BASE
    )
    const assigned = new Set(reserved)
    const liveIdentities = new Set()
    const identityCounts = new Map()
    const allocate = () => {
      while (assigned.has(nextIndex) && nextIndex < Number.MAX_SAFE_INTEGER) nextIndex += 1
      const allocated = nextIndex
      nextIndex += 1
      return allocated
    }

    for (const element of elements) {
      if (!element) continue
      const backendNodeId = Number(element.backendNodeId)
      const needsSynthetic = element.source === 'target-session' || !Number.isSafeInteger(backendNodeId) || backendNodeId < 0
      if (!needsSynthetic) continue

      const baseIdentity = this._syntheticSelectorIdentity(element)
      const occurrence = (identityCounts.get(baseIdentity) || 0) + 1
      identityCounts.set(baseIdentity, occurrence)
      const identity = occurrence === 1 ? baseIdentity : `${baseIdentity}:duplicate:${occurrence}`
      liveIdentities.add(identity)
      let index = Number(registry.get(identity))
      if (!Number.isSafeInteger(index) || index < SYNTHETIC_SELECTOR_INDEX_BASE || assigned.has(index)) {
        index = allocate()
        registry.set(identity, index)
      }
      element.index = index
      assigned.add(index)
    }

    for (const identity of registry.keys()) {
      if (!liveIdentities.has(identity)) registry.delete(identity)
    }
    state.nextSyntheticSelectorIndex = nextIndex
    return elements
  }

  async _observeAttachedTargets(
    entry,
    {
      maxElements = 0,
      startIndex = 1,
      frameMetadata = null,
      includeAccessibility = true,
      includeSnapshot = true,
      includeDomDocument = true,
      includeJsListeners = true,
      publishSelectorMap = true,
      targetFilter = null
    } = {}
  ) {
    const remaining = Math.max(0, Number(maxElements) || 0)
    if (!remaining || typeof entry.targetManager.attachedTargets !== 'function') return { elements: [], observations: [] }
    const elements = []
    const observations = []
    const attachedTargets = entry.targetManager.attachedTargets()
    for (const item of attachedTargets) {
      if (elements.length >= remaining) break
      if (typeof targetFilter === 'function' && !targetFilter(item)) continue
      const sessionId = item.sessionId
      if (!sessionId) continue
      try {
        await entry.client.send('Runtime.enable', {}, sessionId).catch(() => undefined)
        await entry.client.send('DOM.enable', {}, sessionId).catch(() => undefined)
        let jsClickListenerBackendIds = new Set()
        if (includeJsListeners) {
          jsClickListenerBackendIds = await this._detectJsClickListenerBackendIds(entry, sessionId).catch(() => new Set())
        }
        let accessibility = null
        if (includeAccessibility) {
          accessibility = await this._captureAccessibility(entry, sessionId).catch(() => null)
        }
        const collectTargetInPageElementsInitially = !includeSnapshot
        const result = await entry.client.send(
          'Runtime.evaluate',
          {
            expression: collectTargetInPageElementsInitially
              ? buildObserveExpression({
                  maxElements: remaining - elements.length,
                  publishSelectorMap
                })
              : buildPageMetadataExpression(),
            returnByValue: true,
            awaitPromise: true
          },
          sessionId
        )
        const value = result?.result?.value || {}
        const targetDpr = Number(value.devicePixelRatio) > 0 ? Number(value.devicePixelRatio) : 1
        let targetElements = Array.isArray(value.elements) ? value.elements : []
        let targetEnhancedDom = null
        if (includeSnapshot) {
          const snapshot = await entry.client
            .send('DOMSnapshot.captureSnapshot', snapshotCaptureParams(), sessionId)
            .catch(() => null)
          if (snapshot && snapshotBelongsToTarget(snapshot, value.url || item.target?.url || '')) {
            const enhanced = buildEnhancedSnapshotState(snapshot, {
              maxElements: remaining - elements.length,
              accessibility,
              jsClickListenerBackendIds,
              devicePixelRatio: targetDpr
            })
            targetEnhancedDom = enhanced
            if (enhanced.elements.length) targetElements = mergeObservedElements(enhanced.elements, targetElements, remaining - elements.length)
            else {
              const parsed = buildSnapshotElements(snapshot, {
                startIndex: 1,
                maxElements: remaining - elements.length,
                jsClickListenerBackendIds,
                devicePixelRatio: targetDpr
              })
              targetElements = mergeObservedElements(parsed.elements, targetElements, remaining - elements.length)
            }
          }
        }
        if (!collectTargetInPageElementsInitially && targetElements.length === 0) {
          const fallback = await entry.client
            .send(
              'Runtime.evaluate',
              {
                expression: buildObserveExpression({
                  maxElements: remaining - elements.length,
                  publishSelectorMap
                }),
                returnByValue: true,
                awaitPromise: true
              },
              sessionId
            )
            .catch(() => null)
          const fallbackValue = fallback?.result?.value || {}
          const fallbackElements = Array.isArray(fallbackValue.elements) ? fallbackValue.elements : []
          targetElements = mergeObservedElements(targetElements, fallbackElements, remaining - elements.length)
          if (!value.text && fallbackValue.text) value.text = fallbackValue.text
          if (!value.pageText && fallbackValue.pageText) value.pageText = fallbackValue.pageText
        }
        const needsTargetDomDocument =
          !targetEnhancedDom ||
          Number(targetEnhancedDom.stats?.shadowOpenCount || 0) > 0 ||
          Number(targetEnhancedDom.stats?.shadowClosedCount || 0) > 0 ||
          Number(targetEnhancedDom.stats?.noLayoutFileInputCount || 0) > 0
        if (includeDomDocument && needsTargetDomDocument) {
          const domDocument = await this._captureDomDocument(entry, sessionId).catch(() => null)
          if (domDocument) {
            const domElements = buildDomDocumentElements(domDocument, {
              startIndex: 1,
              maxElements: remaining - elements.length,
              accessibility,
              jsClickListenerBackendIds,
              source: 'dom-document'
            })
            targetElements = mergeObservedElements(targetElements, domElements.elements, remaining - elements.length)
          }
        }
        if (accessibility) targetElements = mergeAccessibility(targetElements, accessibility)
        const frame = this._frameForTarget(item, frameMetadata)
        const targetUrl = String(item.target?.url || value.url || '')
        const captchaProviderTarget = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|geetest/i
          .test(targetUrl)
        const frameOwnerState = captchaProviderTarget
          ? await this._frameOwnerInteractionState(entry, frame || {})
          : { known: false, visible: false, explicitlyPassive: false }
        const targetMetadata = {
          sessionId,
          targetId: item.targetId || '',
          targetType: item.target?.type || '',
          targetUrl,
          frameId: frame?.frameId || frame?.id || '',
          parentFrameId: frame?.parentFrameId || '',
          parentTargetId: frame?.parentTargetId || '',
          parentSessionId: frame?.parentSessionId || '',
          frameOwnerBackendNodeId: frame?.frameOwnerBackendNodeId || frame?.backendNodeId || null,
          frameOwnerNodeId: frame?.frameOwnerNodeId || frame?.nodeId || null,
          frameOwnerUnavailable: Boolean(frame?.frameOwnerUnavailable),
          frameOwnerVisibilityKnown: frameOwnerState.known,
          frameOwnerVisible: frameOwnerState.visible,
          frameOwnerExplicitlyPassive: frameOwnerState.explicitlyPassive
        }
        const enhancedText = String(targetEnhancedDom?.text || '')
        const enhancedBrowserUseText = String(targetEnhancedDom?.browserUseText || '')
        const selectorText = String(value.text || '')
        observations.push({
          ...targetMetadata,
          text: enhancedText || selectorText,
          browserUseText: enhancedBrowserUseText || selectorText,
          textIndexKind: enhancedText ? 'backendNodeId' : (selectorText ? 'selectorIndex' : 'none'),
          browserUseTextIndexKind: enhancedBrowserUseText ? 'backendNodeId' : (selectorText ? 'selectorIndex' : 'none'),
          pageText: String(value.pageText || '')
        })
        for (const element of targetElements) {
          elements.push({
            ...element,
            selectorIndex: element.selectorIndex ?? (
              element.backendNodeId == null || element.backendNodeId === '' ? element.index : undefined
            ),
            index: Number(startIndex) + elements.length,
            ...targetMetadata,
            source: 'target-session'
          })
          if (elements.length >= remaining) break
        }
      } catch (error) {
        this.eventBus.emit(EVENT_TYPES.DOM_OBSERVED, {
          id: entry.id,
          targetId: item.targetId || '',
          sessionId,
          targetObserveError: error.message
        })
      }
    }
    return { elements, observations }
  }

  _observationLease(entry) {
    return Object.freeze({
      documentRevision: this._documentStateSnapshot(entry).revision,
      pageGeneration: Number(entry?.selectorMap?.pageGeneration) || 0,
      viewEpoch: Math.max(0, Number(entry?.viewEpoch) || 0)
    })
  }

  _bindOverlayCloseCandidates(overlay, elements = []) {
    if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return null
    const rawCandidates = Array.isArray(overlay.closeCandidates)
      ? overlay.closeCandidates.slice(0, 8)
      : []
    const indexes = []
    for (const candidate of rawCandidates) {
      const rect = candidate?.rect
      if (!rect || typeof rect !== 'object') continue
      const x = Number(rect.x)
      const y = Number(rect.y)
      const width = Number(rect.width)
      const height = Number(rect.height)
      if (![x, y, width, height].every(Number.isFinite)) continue
      const matches = elements.filter(element => {
        if (!element || element.disabled === true) return false
        const capabilities = element.capabilities || {}
        if (capabilities.clickable !== true && capabilities.typeable !== true) return false
        const actual = element.rect || {}
        const ax = Number(actual.x ?? actual.left)
        const ay = Number(actual.y ?? actual.top)
        const aw = Number(actual.width)
        const ah = Number(actual.height)
        if (![ax, ay, aw, ah].every(Number.isFinite)) return false
        const geometryMatches = (
          Math.abs(ax - x) <= 6 &&
          Math.abs(ay - y) <= 6 &&
          Math.abs(aw - width) <= 8 &&
          Math.abs(ah - height) <= 8
        )
        if (!geometryMatches) return false
        const candidateId = String(candidate.id || '').trim()
        const elementId = String(element.id || element.attributes?.id || '').trim()
        if (candidateId && elementId && candidateId !== elementId) return false
        const candidateLabel = String(candidate.label || '').replace(/\s+/g, ' ').trim()
        const elementLabel = String(
          element.name ||
          element.text ||
          element.label ||
          element.attributes?.['aria-label'] ||
          element.attributes?.title ||
          ''
        ).replace(/\s+/g, ' ').trim()
        return !candidateLabel || !elementLabel || candidateLabel === elementLabel
      })
      if (matches.length === 1 && Number.isSafeInteger(Number(matches[0].index))) {
        indexes.push(Number(matches[0].index))
      }
    }
    return {
      ...overlay,
      closeCandidateIndexes: [...new Set(indexes)]
    }
  }

  _observationLeaseMatches(entry, lease) {
    if (!entry || !lease || this.workbenches.get(String(entry.id)) !== entry) return false
    const current = this._observationLease(entry)
    return (
      current.documentRevision === lease.documentRevision &&
      current.pageGeneration === lease.pageGeneration &&
      current.viewEpoch === lease.viewEpoch
    )
  }

  _staleDocumentError(entry, lease, attempts) {
    const currentEntry = this.workbenches.get(String(entry?.id || '')) || entry
    const error = new Error('The document changed while it was being observed; no selector indices were published.')
    error.code = 'STALE_DOCUMENT'
    error.details = {
      retryable: true,
      replanRequired: true,
      attempts,
      expected: lease || null,
      current: currentEntry ? this._observationLease(currentEntry) : null
    }
    return error
  }

  async observe(id, params = {}) {
    let entry = this.getWorkbench(id)
    let lastLease = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this._prepare(entry)
      const lease = this._observationLease(entry)
      lastLease = lease
      try {
        const value = await this._observeOnce(entry, params, lease)
        if (value !== STALE_OBSERVATION) return value
      } catch (error) {
        if (this._observationLeaseMatches(entry, lease)) throw error
        if (attempt === 2) throw this._staleDocumentError(entry, lease, attempt)
      }
      if (attempt === 1) entry = this.getWorkbench(id)
    }
    throw this._staleDocumentError(entry, lastLease, 2)
  }

  async _observeOnce(entry, params = {}, lease) {
    const sessionId = this._sessionIdForEntry(entry)
    const storedDomState = entry.domState
    const storedDomRevision = storedDomState?.documentRevision
    const previousDomState = storedDomState && (
      storedDomRevision == null
        ? lease.documentRevision === 0
        : Number(storedDomRevision) === lease.documentRevision
    ) ? storedDomState : null
    let nextDomState = previousDomState ? { ...previousDomState } : null
    const reuseSyntheticIndexes =
      Number(entry.syntheticSelectorDocumentRevision) === lease.documentRevision
    const selectorIndexState = {
      syntheticSelectorIndexes: new Map(
        reuseSyntheticIndexes && entry.syntheticSelectorIndexes instanceof Map
          ? entry.syntheticSelectorIndexes
          : []
      ),
      nextSyntheticSelectorIndex: reuseSyntheticIndexes
        ? Number(entry.nextSyntheticSelectorIndex) || SYNTHETIC_SELECTOR_INDEX_BASE
        : SYNTHETIC_SELECTOR_INDEX_BASE
    }
    // 删 cap:可交互元素【不设数量上限】。的 serializer 把 selector_map 收全部、
    // 从无元素数 cap;原本默认 300 / 封顶 1000 是臆造魔法数,且把 maxElements 当参数交给 agent → agent 传 30
    // 把输入框/发送键截没(文心一言实测根因)。现默认不限量(MAX_SAFE_INTEGER=实际无限);仅当内部调用方
    // 显式传正整数时才尊重(如轻量 captcha 轮询的 300)。agent 面向的 maxElements 参数已撤。
    const maxElements = Number(params.maxElements) > 0 ? Number(params.maxElements) : Number.MAX_SAFE_INTEGER
    // 阶段 1(注入 JS 遍历)给 20s 独立超时并容错:失败时记录 evaluateError、以空 value 继续——
    // 阶段 4 的 CDP 快照路(Path B)独立可用,纯 CDP 观察依然能出可用的 DOM,
    // 好过让单个挂死的 evaluate 吃满 60s 动作预算后整个 observe 报废。
    let inPageEvaluateError = null
    const collectInPageElementsInitially = params.includeSnapshot === false
    const result = await entry.client.send('Runtime.evaluate', {
      expression: collectInPageElementsInitially
        ? buildObserveExpression({ maxElements })
        : buildPageMetadataExpression(),
      returnByValue: true,
      awaitPromise: true
    }, undefined, 20000).catch(error => {
      inPageEvaluateError = error?.message || String(error)
      return null
    })
    const value = result?.result?.value || {}
    const latchedNavigationFailure = entry.mainFrameNavigationFailure
    if (latchedNavigationFailure && typeof latchedNavigationFailure === 'object') {
      const numericErrorCode = Number(latchedNavigationFailure.networkErrorCode)
      value.navigationFailure = {
        ...(Number.isFinite(numericErrorCode) ? { networkErrorCode: numericErrorCode } : {}),
        errorDescription: String(latchedNavigationFailure.errorDescription || 'Navigation failed'),
        validatedUrl: String(latchedNavigationFailure.validatedUrl || '')
      }
    }
    // DOMSnapshot bounds 是设备像素;用页面回传的 DPR 把快照几何归一到 CSS 像素(见 snapshot-service rectFromBounds)
    const dpr = Number(value.devicePixelRatio) > 0 ? Number(value.devicePixelRatio) : 1
    let elements = Array.isArray(value.elements) ? value.elements : []
    try {  // ── DOM 流水线日志:阶段 1(注入页面跑 JS 直接遍历 DOM 并序列化)──
      pipelineLog.begin(entry.id, value.url)
      pipelineLog.stage(1, collectInPageElementsInitially
        ? '注入页面跑 JS,遍历活动 DOM 并序列化 (buildObserveExpression@dom-service)'
        : '读取页面轻量元数据 (buildPageMetadataExpression@dom-service)',
        { maxElements: maxElements === Number.MAX_SAFE_INTEGER ? '无上限' : maxElements, metadataOnly: !collectInPageElementsInitially },
        { 交互元素: elements.length, 文本字符: (value.text || '').length, viewport: value.viewport, devicePixelRatio: dpr })
      pipelineLog.sample('一个交互元素长啥样 (value.elements[0])', elements[0])
      pipelineLog.sample('页面文本前 300 字符 (value.text)', value.text || '', 300)
    } catch (e) { void e }
    let snapshotStats = null
    let snapshotError = null
    let enhancedDom = null
    let accessibilityStats = null
    let accessibilityError = null
    let accessibility = null
    let jsClickListenerBackendIds = new Set()
    let jsClickListenerError = null
    let domDocumentState = null
    let domDocumentError = null
    if (params.includeJsListeners !== false && params.include_js_listeners !== false) {
      try {
        jsClickListenerBackendIds = await this._detectJsClickListenerBackendIds(entry)
      } catch (error) {
        jsClickListenerError = error.message
      }
    }
    try {  // 阶段 2:JS 点击监听检测(带 onclick 监听器的元素也算可交互)
      pipelineLog.stage(2, 'JS 点击监听检测 (_detectJsClickListenerBackendIds)', undefined,
        { 带监听器的backendNodeId数: jsClickListenerBackendIds.size, 错误: jsClickListenerError })
    } catch (e) { void e }
    if (params.includeAccessibility !== false) {
      try {
        accessibility = await this._captureAccessibility(entry)
        accessibilityStats = accessibility.stats
      } catch (error) {
        accessibilityError = error.message
      }
    }
    try {  // 阶段 3:无障碍树(Accessibility.getFullAXTree)——role / name 等语义信息来源
      pipelineLog.stage(3, '抓无障碍树 (Accessibility.getFullAXTree → _captureAccessibility)', undefined,
        { 统计: accessibilityStats, 错误: accessibilityError })
    } catch (e) { void e }
    // 上一帧游标:必须在下面用本帧 enhanced 状态覆盖 nextDomState 之前捕获,
    // 供 dom-document 补充路(file input / shadow 表单控件,无 layout、不在本帧
    // enhanced 发号集)做 isNew 比对,否则它们每帧都被误判为新并打 `*`。
    if (params.includeSnapshot !== false) {
      try {
        // 快照路同样给 20s 独立超时(失败进已有的 snapshotError 容错分支),防单命令吃满动作预算。
        const snapshot = await entry.client.send('DOMSnapshot.captureSnapshot', snapshotCaptureParams(), undefined, 20000)
        enhancedDom = buildEnhancedSnapshotState(snapshot, {
          maxElements,
          previousState: previousDomState,
          accessibility,
          jsClickListenerBackendIds,
          devicePixelRatio: dpr
        })
        if (enhancedDom.elements.length) {
          elements = mergeObservedElements(enhancedDom.elements, elements, maxElements)
          nextDomState = enhancedDom.state
          snapshotStats = enhancedDom.stats
        } else {
          const parsed = buildSnapshotElements(snapshot, {
            startIndex: elements.length + 1,
            maxElements,
            jsClickListenerBackendIds,
            devicePixelRatio: dpr
          })
          elements = mergeObservedElements(parsed.elements, elements, maxElements)
          snapshotStats = parsed.stats
        }
        try {  // 阶段 4+5:CDP 原始快照 → Node 解析/交互检测 → 合并进总表
          const _docs = (snapshot && snapshot.documents) || []
          const _nodes = _docs.reduce((a, d) => a + ((d.nodes && d.nodes.nodeName) ? d.nodes.nodeName.length : 0), 0)
          pipelineLog.stage(4, 'CDP 快照 captureSnapshot → Node 解析+交互检测 (buildEnhancedSnapshotState@snapshot-service)',
            { 原始快照: { 文档数: _docs.length, 节点总数: _nodes, 字符串池: ((snapshot && snapshot.strings) || []).length } },
            { 该路解析出的交互元素: (enhancedDom && enhancedDom.elements ? enhancedDom.elements.length : 0), stats: snapshotStats })
          pipelineLog.stage(5, '合并进总元素表 (mergeObservedElements)', undefined, { 合并后元素总数: elements.length })
          pipelineLog.sample('CDP 路解析出的一个元素 (enhancedDom.elements[0])', enhancedDom && enhancedDom.elements && enhancedDom.elements[0])
        } catch (e) { void e }
      } catch (error) {
        snapshotError = error.message
      }
    }
    // The enhanced snapshot is authoritative and normally supplies every
    // model-facing element. Only pay for the live-DOM traversal when that path
    // failed (or produced no actionable elements). This preserves the exact
    // fallback behavior without scanning the page twice on healthy observes.
    if (!collectInPageElementsInitially && (inPageEvaluateError || elements.length === 0)) {
      try {
        const fallbackResult = await entry.client.send(
          'Runtime.evaluate',
          {
            expression: buildObserveExpression({ maxElements }),
            returnByValue: true,
            awaitPromise: true
          },
          undefined,
          20000
        )
        const fallbackValue = fallbackResult?.result?.value || {}
        const fallbackElements = Array.isArray(fallbackValue.elements) ? fallbackValue.elements : []
        elements = mergeObservedElements(elements, fallbackElements, maxElements)
        for (const key of ['url', 'title', 'readyState', 'devicePixelRatio', 'viewport', 'pageText', 'overlay']) {
          if (value[key] == null && fallbackValue[key] != null) value[key] = fallbackValue[key]
        }
        if (!value.text && fallbackValue.text) value.text = fallbackValue.text
        inPageEvaluateError = null
      } catch (error) {
        inPageEvaluateError = error?.message || String(error)
      }
    }
    const needsDomDocumentSupplement =
      !enhancedDom ||
      Number(snapshotStats?.shadowOpenCount || 0) > 0 ||
      Number(snapshotStats?.shadowClosedCount || 0) > 0 ||
      Number(snapshotStats?.noLayoutFileInputCount || 0) > 0
    if (
      params.includeDomDocument !== false &&
      params.include_dom_document !== false &&
      needsDomDocumentSupplement
    ) {
      try {
        const domDocument = await this._captureDomDocument(entry)
        domDocumentState = buildDomDocumentElements(domDocument, {
          startIndex: elements.length + 1,
          maxElements,
          previousState: previousDomState,
          accessibility,
          jsClickListenerBackendIds,
          // Skip anything the layout snapshot already saw (so this supplement only
          // adds elements that had no layout box at all, e.g. shadow content —
          // never re-adds nodes the snapshot dropped as hidden/occluded).
          excludeBackendNodeIds: enhancedDom?.seenBackendNodeIds || null
        })
        if (domDocumentState.elements.length) {
          elements = mergeObservedElements(elements, domDocumentState.elements, maxElements)
        }
      } catch (error) {
        domDocumentError = error.message
      }
    }
    try {  // 阶段 6:DOM.getDocument(pierce) 兜底补充(shadow/iframe 里没布局盒的元素)
      pipelineLog.stage(6, 'DOM.getDocument 兜底补充 (buildDomDocumentElements@snapshot-service)', undefined,
        { 需要补充: needsDomDocumentSupplement, 补充后元素总数: elements.length, 错误: domDocumentError })
    } catch (e) { void e }
    const _beforeAx = elements.length
    if (accessibility) elements = mergeAccessibility(elements, accessibility)
    try {  // 阶段 7:把无障碍信息(role / name)并入元素
      pipelineLog.stage(7, '并入无障碍信息 (mergeAccessibility)', { 入_元素数: _beforeAx }, { 出_元素数: elements.length })
    } catch (e) { void e }
    let frameMetadata = null
    let frameMetadataError = null
    let targetObservations = []
    if (params.includeTargets !== false) {
      try {
        frameMetadata = await this._collectFrameMetadata(entry)
      } catch (error) {
        frameMetadataError = error.message
      }
      const targetObservation = await this._observeAttachedTargets(entry, {
        maxElements: Math.max(0, maxElements - elements.length),
        startIndex: elements.length + 1,
        frameMetadata,
        includeAccessibility: params.includeAccessibility !== false,
        includeSnapshot: params.includeSnapshot !== false,
        includeDomDocument: params.includeDomDocument !== false && params.include_dom_document !== false,
        includeJsListeners: params.includeJsListeners !== false && params.include_js_listeners !== false
      })
      targetObservations = targetObservation.observations || []
      elements = elements.concat(targetObservation.elements || []).slice(0, maxElements)
    }
    // Keep main-document BackendNodeIds intact, but assign collision-free,
    // observation-stable synthetic ids to selector-only and attached-target
    // elements. selectorIndex retains the page-injected map's local key.
    this._assignStableSelectorIndexes(selectorIndexState, elements)
    value.elements = elements
    value.overlay = this._bindOverlayCloseCandidates(value.overlay, elements)
    // SHC/300:截断必告警不再静默丢控件)。omittedInteractiveCount 来自增强快照里
    // "几何门都过了、纯被 maxElements 上限砍掉"的真实计数;另以 elements 是否填满上限作兜底标志。
    {
      const omitted = Number(enhancedDom?.stats?.truncatedInteractiveCount || 0)
      const capped = elements.length >= maxElements
      if (omitted > 0 || capped) {
        value.truncated = true
        value.omittedInteractiveCount = omitted
        value.maxElements = maxElements
        value.truncationHint = `Reached the element limit of ${maxElements}${omitted > 0 ? `; approximately ${omitted}+ interactive controls were omitted` : ''}. Scroll to locate the target, narrow the scope, or increase maxElements.`
      }
    }
    value.pagination = this._detectPagination(elements)
    value.flatText = this._formatElementsText(elements)
    if (enhancedDom?.text) {
      // Supplement the enhanced tree ONLY with elements from other authoritative
      // sources (cross-origin target frames, the no-layout DOM-document fill) —
      // identified by an explicit `source`. The in-page fallback path is
      // sourceless and, when the enhanced snapshot succeeded, purely redundant:
      // its matched elements already dedupe into the tree, while its UNMATCHED
      // ones are exactly the nodes enhanced deliberately dropped (occluded /
      // hidden), which must not leak back in as supplemental noise.
      const extras = elements.filter(element => element.source && element.source !== 'enhanced-snapshot')
      value.domTreeText = enhancedDom.text
      value.browserUseDomTreeText = enhancedDom.browserUseText || ''
      const hasTargetSupplements = extras.length || targetObservations.length
      const stitched = hasTargetSupplements
        ? this._stitchTargetFramesIntoDomText(enhancedDom.text, enhancedDom.root, extras, { targetObservations })
        : { text: enhancedDom.text, remaining: [], remainingTargetObservations: [], inlinedTargetFrameCount: 0 }
      const browserUseStitched = hasTargetSupplements
        ? this._stitchTargetFramesIntoDomText(enhancedDom.browserUseText || '', enhancedDom.root, extras, {
            format: 'browser_use',
            targetObservations
          })
        : { text: enhancedDom.browserUseText || '', remaining: [], remainingTargetObservations: [], inlinedTargetFrameCount: 0 }
      value.browserUseText = [
        browserUseStitched.text,
        browserUseStitched.remaining.length || browserUseStitched.remainingTargetObservations?.length
          ? this._formatSupplementalElementsText(browserUseStitched.remaining, {
              format: 'browser_use',
              targetObservations: browserUseStitched.remainingTargetObservations
            })
          : ''
      ].filter(Boolean).join('\n')
      value.text = [
        stitched.text,
        stitched.remaining.length || stitched.remainingTargetObservations?.length
          ? this._formatSupplementalElementsText(stitched.remaining, {
              targetObservations: stitched.remainingTargetObservations
            })
          : ''
      ]
        .filter(Boolean)
        .join('\n')
      value.inlinedTargetFrameCount = stitched.inlinedTargetFrameCount
      value.inlinedBrowserUseTargetFrameCount = browserUseStitched.inlinedTargetFrameCount
    } else {
      const ordinary = elements.filter(element => element.source !== 'target-session')
      value.text = [
        this._formatElementsText(ordinary),
        targetObservations.length
          ? this._formatSupplementalElementsText(elements.filter(element => element.source === 'target-session'), { targetObservations })
          : this._formatElementsText(elements.filter(element => element.source === 'target-session'))
      ].filter(Boolean).join('\n')
      value.browserUseText = value.text
    }
    if (String(params.domFormat || params.dom_format || '').toLowerCase() === 'browser_use' && value.browserUseText) {
      value.text = value.browserUseText
    }
    // Page stats below consume pendingNetworkRequests. Populate it before text
    // serialization; doing this near the return path made every completed
    // readyState look idle even while fetches were still in flight.
    const pendingLimitValue = Number(params.pendingNetworkLimit ?? params.pending_network_limit ?? 20)
    const pendingLimit = Math.max(0, Math.min(100, Number.isFinite(pendingLimitValue) ? pendingLimitValue : 20))
    value.pendingNetworkRequests =
      params.includePendingNetworkRequests === false || params.include_pending_network_requests === false
        ? []
        : entry.watchdog?.pendingNetworkRequests?.(pendingLimit) || []
    // Top-level page-scroll markers: the per-element scroll hints don't convey
    // where the page as a whole sits, so the model can't tell "is this the whole
    // page or is there more below?". Wrap the agent-facing text with a page
    // head/foot derived from the viewport (scroll position vs scrollHeight), so
    // it knows when to browser_scroll for more. Mirrors page scroll info.
    const vp = value.viewport || {}
    const vh = Number(vp.height) || 0
    // <page_stats>:式页面计数概览,逐字对齐其阈值/字段顺序/文案(prompts.py 229-242)。
    // 计数全部取自增强快照遍历 snapshotStats(value.snapshot):links/interactive/iframes/
    // shadow(open|closed)/images/total elements/textChars。interactive 复用 interactiveCount(已发号者)。
    const buildPageStatsLine = () => {
      const s = snapshotStats || {}
      const links = Number(s.linkCount || 0)
      // The enhanced snapshot covers the main target only. `elements` is the
      // final selector map after DOM-document supplements and OOPIF targets.
      const interactive = elements.length
      const iframes = Number(s.iframeCount || 0)
      const shadowOpen = Number(s.shadowOpenCount || 0)
      const shadowClosed = Number(s.shadowClosedCount || 0)
      const images = Number(s.imageCount || 0)
      const total = Number(s.totalElements || 0)
      const occluded = Number(s.ignoredByPaintOrderCount || 0)
      // 加载态改用【真实信号】,不再用 textChars/total 字符比例猜——那条会把"弹窗遮挡导致可交互元素少"的
      // 正常页误判成 skeleton(文心一言实测误报)。真信号:document.readyState != complete,或仍有网络在途。
      const readyState = String(value.readyState || '')
      const pending = Array.isArray(value.pendingNetworkRequests) ? value.pendingNetworkRequests.length : 0
      const loading = (readyState && readyState !== 'complete') || pending > 0
      let out = '<page_stats>'
      const loadingDetails = `(readyState=${readyState || '?'}${pending ? `, ${pending} request(s) in flight` : ''})`
      const navigationFailure = value.navigationFailure
      if (navigationFailure) {
        const code = navigationFailure.networkErrorCode == null
          ? ''
          : ` (${navigationFailure.networkErrorCode})`
        const url = navigationFailure.validatedUrl ? ` at ${navigationFailure.validatedUrl}` : ''
        out += `Navigation failed: ${navigationFailure.errorDescription}${code}${url} - `
      } else if (total < 10 && loading) out += `Page nearly empty and still loading ${loadingDetails} - `
      else if (total < 10) out += 'Page appears empty (SPA not loaded?) - '
      else if (loading) out += `Page still loading ${loadingDetails} - `
      out += `${links} links, ${interactive} interactive, `
      out += `${iframes} iframes`
      if (shadowOpen > 0 || shadowClosed > 0) out += `, ${shadowOpen} shadow(open), ${shadowClosed} shadow(closed)`
      if (images > 0) out += `, ${images} images`
      out += `, ${total} total elements`
      // Paint-order occlusion only means another rendered node covers this
      // element. It is not evidence that a modal exists (ordinary nested
      // controls produce this too), so keep the wording deliberately neutral.
      if (occluded > 0) out += `, ${occluded} occluded(non-interactable)`
      out += '</page_stats>'
      return out
    }
    // <page_info>:式滚动位置(prompts.py 256-267)。pages_above=scrollY/viewport_height,
    // pages_below=(scrollHeight-scrollY-viewport_height)/viewport_height;一位小数(.toFixed(1));
    // pages_below 严格 >0.2 才追加下滚提示(em-dash 前后各一空格,逐字对齐)。仅有视口时给。
    const buildPageInfoLine = () => {
      // pixels_above/below 在 是测得的非负量;这里夹 Math.max(0,…) 防短页/取整产生的负值(-0.0),
      // 与首尾标记 round1 的 Math.max(0,…) 同口径。
      const pagesAbove = vh > 0 ? Math.max(0, Number(vp.scrollY || 0)) / vh : 0
      const pagesBelow = vh > 0 ? Math.max(0, Number(vp.scrollHeight || 0) - Number(vp.scrollY || 0) - vh) / vh : 0
      let out = '<page_info>'
      out += `${pagesAbove.toFixed(1)} pages above, ${pagesBelow.toFixed(1)} pages below`
      if (pagesBelow > 0.2) out += ' — scroll down to reveal more content'
      out += '</page_info>'
      return out
    }
    // <overlay>:只在页面内的可见性/几何探针确认打开浮层后输出。AX 树会长期保留
    // 已隐藏的 cookie preference/dialog 节点，不能单独作为"当前有弹窗"的证据。
    // 这是研究点名的 #1 失败模式——AX 树/DOM 序列化不表达 z-order/遮挡,模型只能从"一堆没编号的文本"瞎猜。
    // 非 ARIA 自定义浮层也必须由页面内的可见性/几何探针确认；page_stats
    // 的 occluded 计数只报告不可交互事实，绝不再推导成弹窗。
    const buildOverlayLine = () => {
      let accessibilityDialogName = ''
      try {
        const byId = accessibility && accessibility.byBackendNodeId
        if (byId && typeof byId.values === 'function') {
          for (const item of byId.values()) {
            if (item && !item.ignored && (item.role === 'dialog' || item.role === 'alertdialog')) {
              accessibilityDialogName = String(item.name || '').trim()
              break
            }
          }
        }
      } catch (e) { void e }
      const overlay = value.overlay && typeof value.overlay === 'object'
        ? value.overlay
        : null
      if (!overlay) return ''
      const semanticDialog = overlay.semantic === true
      const name = (
        String(overlay.name || '').trim() ||
        (semanticDialog ? accessibilityDialogName : '') ||
        'custom overlay'
      )
      const occluded = Number((snapshotStats || {}).ignoredByPaintOrderCount || 0)
      const candidateIndexes = Array.isArray(overlay?.closeCandidateIndexes)
        ? overlay.closeCandidateIndexes.filter(Number.isSafeInteger).slice(0, 8)
        : []
      const candidateHint = candidateIndexes.length
        ? ` The only visible Close or Skip candidate to try first in the current snapshot is: ${candidateIndexes.map(index => `[${index}]`).join(', ')}.`
        : ''
      // Whether the floating surface blocks the task comes from the verified
      // overlay itself. A separate paint-order count cannot promote a harmless
      // tooltip/toast into a blocking modal.
      const blocksMainContent = (
        overlay.occludesMainContent === true ||
        overlay.bodyScrollLocked === true
      )
      const body = blocksMainContent
        ? `An open dialog or popup is present${occluded > 0 ? ` and obscures approximately ${occluded} other page elements that are not currently clickable` : ''}. Operate within it or close it first, then confirm the overlay disappeared before continuing.${candidateHint}`
        : `A dialog or floating panel is present but does not obscure the main page content. Operate within it or close it as needed.${candidateHint}`
      const occAttr = occluded > 0 ? ` occluding="${occluded}"` : ''
      const kindAttr = semanticDialog ? ' kind="semantic-dialog"' : ' kind="visual-overlay"'
      return `<overlay name=${JSON.stringify(name)}${kindAttr}${occAttr}>${body}</overlay>`
    }
    // <page_stats> 恒输出(对齐 prompts.py:229):即使空页(SPA 未加载)也给,
    // buildPageStatsLine 在 total<10 时自带 "Page appears empty (SPA not loaded?) - " 文案。
    // 故门控从"value.text 非空"提到此处:空页/非空页都前置 statsLine。
    // page_info 仅在有视口时给无 viewport 优雅省略)。
    // 首尾 [Start/End of page] 仅在有视口且有文本时包。
    // 配套:electron_browser_tool.py 的 _OBS_MARKER_RE 必须把 <page_stats>/<page_info> 计入忽略标记,
    // 否则空页这两行非空文本会被"仍在加载"判定当成"有内容"(见该文件 :242-246),提示会退化失效。
    if (typeof value.text === 'string') {
      const statsLine = buildPageStatsLine()
      const overlayLine = buildOverlayLine()  // 有打开的弹窗时置顶,让模型先看到"先处理弹窗"
      const hasText = value.text.length > 0
      if (vh > 0 && hasText) {
        // 首尾页面标记按既有行为保留(round1 屏数 + ↑↓ 提示 / [Start|End of page]),page_stats/page_info 前置其上。
        const round1 = n => Math.round(Math.max(0, n) * 10) / 10
        const above = round1(Number(vp.scrollY || 0) / vh)
        const below = round1((Number(vp.scrollHeight || 0) - Number(vp.scrollY || 0) - vh) / vh)
        const head = vp.hasMoreAbove ? `[↑ ~${above} screen(s) above — browser_scroll up to reveal]` : '[Start of page]'
        const foot = vp.hasMoreBelow ? `[↓ ~${below} screen(s) below — browser_scroll down to reveal]` : '[End of page]'
        const prefix = [overlayLine, statsLine, buildPageInfoLine()].filter(Boolean).join('\n')
        value.text = `${prefix}\n${head}\n${value.text}\n${foot}`
        if (typeof value.browserUseText === 'string' && value.browserUseText.length) {
          value.browserUseText = `${prefix}\n${head}\n${value.browserUseText}\n${foot}`
        }
      } else {
        // 空页 或 无视口:有视口时仍给 page_info(只依赖视口),无视口则省略;均不包首尾标记。
        const prefix = [overlayLine, statsLine, vh > 0 ? buildPageInfoLine() : ''].filter(Boolean).join('\n')
        value.text = hasText ? `${prefix}\n${value.text}` : prefix
        if (typeof value.browserUseText === 'string') {
          value.browserUseText = value.browserUseText.length ? `${prefix}\n${value.browserUseText}` : prefix
        }
      }
    }
    try {  // 阶段 8:序列化成文本 + 首尾页面标记;final = 最终回传 Python / 发给 LLM 的 dom
      pipelineLog.stage(8, '序列化成 DOM 文本 + 首尾页面滚动标记 (serializeBrowserUseNode + page head/foot)',
        { 元素总数: elements.length }, { browserUseText字符: (value.browserUseText || '').length })
      pipelineLog.final(value.browserUseText || value.text)
    } catch (e) { void e }
    if (frameMetadata) {
      value.frames = {
        count: frameMetadata.frames.length,
        frames: frameMetadata.frames.map(frame => this._compactFrameMetadata(frame))
      }
    }
    if (frameMetadataError) value.frameMetadataError = frameMetadataError
    if (snapshotStats) value.snapshot = snapshotStats
    if (snapshotError) value.snapshotError = snapshotError
    if (accessibilityStats) value.accessibility = accessibilityStats
    if (accessibilityError) value.accessibilityError = accessibilityError
    if (jsClickListenerBackendIds.size || jsClickListenerError) {
      value.jsClickListeners = {
        count: jsClickListenerBackendIds.size,
        backendNodeIds: Array.from(jsClickListenerBackendIds).slice(0, 200),
        error: jsClickListenerError || undefined
      }
    }
    if (domDocumentState?.stats) value.domDocument = domDocumentState.stats
    if (domDocumentError) value.domDocumentError = domDocumentError
    if (inPageEvaluateError) {
      // 阶段 1 失败的降级路:如实上报错误,并用 webContents 回填 url/title(evaluate 挂了拿不到)。
      value.evaluateError = inPageEvaluateError
      try {
        if (!value.url && !entry.webContents.isDestroyed()) value.url = entry.webContents.getURL()
        if (!value.title && !entry.webContents.isDestroyed()) value.title = entry.webContents.getTitle()
      } catch { /* 回填尽力而为 */ }
    }
    if (params.includeRecentEvents || params.include_recent_events) {
      const eventLimitValue = Number(params.recentEventLimit ?? params.recent_event_limit ?? 10)
      const eventLimit = Math.max(1, Math.min(100, Number.isFinite(eventLimitValue) ? eventLimitValue : 10))
      value.recentEvents = this._projectEventsForAgent(this.eventBus.getHistory(eventLimit))
      value.recent_events = JSON.stringify(value.recentEvents)
    }
    value.tabs = this._tabsSummary(entry)
    const pdfInfo = this._pdfViewerInfo(entry, value.url)
    value.isPdfViewer = pdfInfo.isPdfViewer
    value.pdfDownloadPath = pdfInfo.pdfDownloadPath
    if (nextDomState) {
      nextDomState.backendNodeIds = elements.map(element => Number(element.backendNodeId)).filter(Number.isFinite)
      nextDomState.elementCount = elements.length
      nextDomState.documentRevision = lease.documentRevision
    }

    // No persistent selector or DOM state is touched before this point. The
    // comparison and all publications below are synchronous, so a CDP commit or
    // broad page invalidation cannot interleave and expose a mixed generation.
    if (!this._observationLeaseMatches(entry, lease)) return STALE_OBSERVATION
    entry.syntheticSelectorIndexes = selectorIndexState.syntheticSelectorIndexes
    entry.syntheticSelectorDocumentRevision = lease.documentRevision
    entry.nextSyntheticSelectorIndex = selectorIndexState.nextSyntheticSelectorIndex
    entry.selectorMap.update(elements)
    entry.domState = nextDomState
    const mutationTrace = entry.domMutationTrace || {}
    const documentState = this._documentStateSnapshot(entry)
    const publishedAt = Date.now()
    entry.lastObservationTrace = Object.freeze({
      traceId: `${entry.id}:${entry.selectorMap.generation}:${publishedAt.toString(36)}`,
      publishedAt,
      documentRevision: lease.documentRevision,
      pageGeneration: lease.pageGeneration,
      selectorGeneration: entry.selectorMap.generation,
      viewEpoch: lease.viewEpoch,
      frameId: String(documentState.frameId || ''),
      loaderId: String(documentState.loaderId || ''),
      mutationRevision: Math.max(0, Number(mutationTrace.revision) || 0),
      elementCount: entry.selectorMap.size
    })
    try {
      this.log(
        `[browser-index-trace] ${JSON.stringify({
          phase: 'observation-published',
          tabId: String(entry.id || ''),
          ...entry.lastObservationTrace,
          readyState: typeof value.readyState === 'string' ? value.readyState : null,
          networkIdle: typeof value.networkIdle === 'boolean' ? value.networkIdle : null,
          networkIdleTimedOut: typeof value.networkIdleTimedOut === 'boolean' ? value.networkIdleTimedOut : null,
          settled: typeof value.settled === 'boolean' ? value.settled : null,
          pendingRequests: Number.isFinite(Number(value.pendingRequests)) ? Number(value.pendingRequests) : null
        })}`
      )
    } catch {
      // Diagnostics must never make an otherwise-valid observation fail.
    }
    // CAPTCHA identity is document-scoped, so publish the successful lease on
    // the value before detection constructs its challenge metadata.
    value.documentRevision = lease.documentRevision
    value.document_revision = lease.documentRevision
    value.captcha = this._detectCaptcha(entry, value, elements, {
      targetObservations
    }) || { detected: false }
    // Expose which selector-map generation these indices belong to, so action
    // results / debugging can correlate an index back to its observation.
    value.selectorGeneration = entry.selectorMap.generation
    value.selector_generation = entry.selectorMap.generation
    value.browserContext = this._clearObserveRequirement(sessionId, entry.id, 'dom.observed', {
      selectorGeneration: entry.selectorMap.generation
    })
    // PDF 视图 + 已落地本地路径(只读 watchdog 内存态);成功租约对应的文档/页面代次。
    value.observationGeneration = lease.pageGeneration
    this.eventBus.emit(EVENT_TYPES.DOM_OBSERVED, {
      id: entry.id,
      sessionId,
      tabId: entry.id,
      count: entry.selectorMap.size,
      selectorGeneration: entry.selectorMap.generation,
      context: value.browserContext,
      pagination: value.pagination,
      captcha: value.captcha.detected ? value.captcha : null,
      snapshot: snapshotStats,
      snapshotError,
      frames: frameMetadata ? { count: frameMetadata.frames.length } : null,
      frameMetadataError,
      accessibility: accessibilityStats,
      accessibilityError
    })
    return value
  }

  _formatElementsText(elements = []) {
    return formatElementsText(elements)
  }

  _formatSupplementalElementsText(elements = [], options = {}) {
    return formatSupplementalElementsText(elements, options, {
      formatElementsText: value => this._formatElementsText(value),
      formatTargetFrameBlock: (value, indent, frameOptions) => this._formatTargetFrameBlock(value, indent, frameOptions)
    })
  }

  _targetFrameHeaderAttrs(element = {}) {
    return targetFrameHeaderAttrs(element)
  }

  _remapTargetFrameText(text = '', elements = [], indexKind = 'backendNodeId') {
    return remapTargetFrameText(text, elements, indexKind)
  }

  _formatTargetFrameBlock(elements = [], indent = '', options = {}) {
    return formatTargetFrameBlock(elements, indent, options, {
      targetFrameHeaderAttrs: element => this._targetFrameHeaderAttrs(element),
      remapTargetFrameText: (text, value, indexKind) => this._remapTargetFrameText(text, value, indexKind),
      formatElementsText: value => this._formatElementsText(value)
    })
  }

  _serializedBackendNodeLineIndexes(root, options = {}) {
    return serializedBackendNodeLineIndexes(root, options)
  }

  _stitchTargetFramesIntoDomText(domText = '', root = null, elements = [], options = {}) {
    return stitchTargetFramesIntoDomText(domText, root, elements, options, {
      serializedBackendNodeLineIndexes: (value, indexOptions) => this._serializedBackendNodeLineIndexes(value, indexOptions),
      formatTargetFrameBlock: (value, indent, frameOptions) => this._formatTargetFrameBlock(value, indent, frameOptions)
    })
  }

  _haystackForElement(element = {}) {
    return haystackForElement(element)
  }

  _isDisabledElement(element = {}) {
    return isDisabledElement(element)
  }

  _detectPagination(elements = []) {
    return detectPagination(elements, {
      haystackForElement: element => this._haystackForElement(element),
      isDisabledElement: element => this._isDisabledElement(element)
    })
  }

  _detectCaptcha(entry, value = {}, elements = [], options = {}) {
    const matches = []
    // Two classes drive two different flows (browser_agent.md #11):
    //  - behavioral: slider / puzzle / checkbox challenges only a human can
    //    perform → block the agent (verification.request → user takeover).
    //  - transcribable: text/image/SMS codes the user reads into a collect
    //    card and the agent types back → must NOT pause the agent. A bare
    //    "验证码" mention (every Chinese SMS-login form) used to hard-pause
    //    every observe — the "一遇验证码就停机" complaint. Behavioral
    //    patterns are listed first so a page matching both classes counts as
    //    behavioral (inspect() keeps the first hit per source).
    // Provider scripts, invisible risk checks and corner badges are routinely
    // mounted on otherwise usable pages. Their names prove only that a CAPTCHA
    // service is present, not that a challenge is currently asking the user to
    // act. Keep provider identity separate from active challenge evidence so a
    // passive reCAPTCHA badge (for example on a successful UPS result page)
    // cannot pause the browser task.
    const providerPatterns = [
      ['recaptcha', /recaptcha|google\.com\/recaptcha|gstatic\.com\/recaptcha/i],
      ['hcaptcha', /hcaptcha/i],
      ['turnstile', /turnstile|challenges\.cloudflare\.com/i]
    ]
    const providerTargetPattern =
      /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|geetest/i
    const behavioralPatterns = [
      ['human-verification', /verify you are human|human verification|are you a human|i(?:'|’)m not a robot|i am human|checking your browser|人机验证|人機驗證/i],
      ['security-check', /(?:complete|finish|perform|pass|required|please.{0,40})\s+(?:the\s+|this\s+|a\s+)?security check|security check\s+(?:is\s+)?required/i],
      ['geetest', /geetest|滑块验证|拖动滑块|拖拽滑块/i]
    ]
    const visualChallengePattern = /select all (?:images|squares)|click (?:each|all|verify)|press and hold|pick the (?:image|object)|请选择所有|选择所有图片/i
    const transcribablePatterns = [
      ['captcha', /\bcaptcha\b/i],
      ['verification-code', /验证码|驗證碼|图形验证|圖形驗證|安全验证|安全驗證/i]
    ]
    const transcribableInputPattern =
      /captcha|verification(?:\s+|-)?code|one(?:\s+|-)?time(?:\s+|-)?code|\botp\b|验证码|驗證碼|校验码|校驗碼|图形验证|圖形驗證|短信码|簡訊碼/i
    // A login-mode label such as “验证码登录” is not an active challenge.
    // Require a current, enabled text-like input whose own semantics identify
    // it as the code destination before publishing a transcribable CAPTCHA.
    const hasTranscribableInput = elements.slice(0, 500).some(element => {
      if (!element || element.disabled === true || element.hidden === true) return false
      const attributes = element.attributes || {}
      const tag = String(element.tag || attributes.tag || '').toLowerCase()
      const role = String(element.role || attributes.role || '').toLowerCase()
      const type = String(element.type || attributes.type || '').toLowerCase()
      const inputLike = (
        tag === 'input' ||
        tag === 'textarea' ||
        role === 'textbox' ||
        ['text', 'tel', 'number'].includes(type)
      )
      return (
        inputLike &&
        !['password', 'hidden'].includes(type) &&
        transcribableInputPattern.test(this._haystackForElement(element))
      )
    })
    const compact = input => String(input || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    // A completed challenge can leave its title and instructions mounted (for
    // example, a slider that changes only its handle and status text). Treat a
    // strong terminal success message as authoritative for behavioral captchas;
    // otherwise the static "拖动滑块" copy keeps the verification gate alive and
    // the next observation opens an identical request again. The Chinese guard
    // excludes instructional phrases such as "验证成功后…".
    const completionPatterns = [
      /(?:验证|驗證|校验|校驗)(?:已经|已經|已)?(?:通过|通過|成功|完成)(?!后|後|才|即可|会|會|将|將)/i,
      /\b(?:verification|captcha|challenge)\s+(?:passed|completed?|successful|succeeded)\b/i,
      /\b(?:successfully\s+verified|you(?:'re| are)\s+verified)\b/i
    ]
    const completionText = compact(value.pageText)
    const verificationCompleted = completionPatterns.some(pattern => pattern.test(completionText))
    const providerMatches = []
    const inspect = (source, text, meta = {}) => {
      const body = compact(text)
      if (!body) return
      const { element = null, ...matchMeta } = meta
      if (source === 'title' && /^security check$/i.test(body)) {
        matches.push({
          source,
          pattern: 'security-check-title',
          kind: 'behavioral',
          text: body,
          ...matchMeta
        })
        return
      }
      const challengeSurface = Boolean(
        value.overlay ||
        source === 'targetText' ||
        element?.source === 'target-session'
      )
      if (challengeSurface && visualChallengePattern.test(body)) {
        matches.push({
          source,
          pattern: 'visual-challenge',
          kind: 'behavioral',
          text: body,
          ...matchMeta
        })
        return
      }
      for (const [name, pattern] of behavioralPatterns) {
        if (!pattern.test(body)) continue
        matches.push({ source, pattern: name, kind: 'behavioral', text: body, ...matchMeta })
        return
      }
      for (const [name, pattern] of providerPatterns) {
        if (!pattern.test(body)) continue
        const providerMatch = { source, pattern: name, text: body, ...matchMeta }
        providerMatches.push(providerMatch)
        const attributes = element?.attributes || {}
        const role = String(element?.role || attributes.role || '').toLowerCase()
        const type = String(element?.type || attributes.type || '').toLowerCase()
        const checked = String(
          element?.checked ??
          attributes['aria-checked'] ??
          attributes.checked ??
          ''
        ).toLowerCase()
        const providerContext = [
          element?.documentUrl,
          element?.targetUrl,
          element?.selector,
          attributes.id,
          attributes.class
        ].filter(Boolean).join(' ')
        const explicitlyPassive = (
          element?.frameOwnerExplicitlyPassive === true ||
          /(?:[?&]size=invisible\b|grecaptcha-badge|rc-anchor-invisible|invisible[-_ ]?recaptcha)/i
            .test(providerContext)
        )
        const attachedTarget = element?.source === 'target-session'
        const frameVisibilityAllowsControl = (
          !attachedTarget ||
          element?.frameOwnerVisible === true
        )
        const visibleChallengeFrame = Boolean(
          attachedTarget &&
          element?.frameOwnerVisible === true &&
          /(?:\/bframe\b|challenge|captcha-delivery)/i.test(
            String(element?.targetUrl || element?.documentUrl || '')
          )
        )
        // A visible, unchecked provider checkbox is an actual user-facing
        // challenge. Provider branding, Privacy/Terms links and invisible badge
        // frames are not.
        if (
          element &&
          (
            (
              (role === 'checkbox' || type === 'checkbox') &&
              checked !== 'true' &&
              frameVisibilityAllowsControl
            ) ||
            visibleChallengeFrame
          ) &&
          element.disabled !== true &&
          !explicitlyPassive
        ) {
          matches.push({
            ...providerMatch,
            pattern: visibleChallengeFrame
              ? `${name}-challenge-frame`
              : `${name}-checkbox`,
            kind: 'behavioral'
          })
        }
        return
      }
      for (const [name, pattern] of transcribablePatterns) {
        if (!pattern.test(body)) continue
        if (!hasTranscribableInput) continue
        matches.push({ source, pattern: name, kind: 'transcribable', text: body, ...matchMeta })
        return
      }
    }

    inspect('url', value.url)
    inspect('title', value.title)
    inspect('pageText', value.pageText)
    for (const element of elements.slice(0, 500)) {
      inspect('element', this._haystackForElement(element), {
        index: element.index,
        tag: element.tag || '',
        targetSessionId: element.sessionId || '',
        targetUrl: element.targetUrl || element.documentUrl || '',
        element
      })
    }
    for (const target of (options.targetObservations || []).slice(0, 20)) {
      if (target?.frameOwnerExplicitlyPassive === true) continue
      const targetUrl = String(target?.targetUrl || '')
      // Provider iframe text is useful only when its embedding iframe is
      // positively visible. If owner metadata is unavailable, treating the
      // frame's permanently mounted "I'm not a robot" copy as active would
      // recreate the false takeover caused by invisible reCAPTCHA badges.
      if (
        providerTargetPattern.test(targetUrl) &&
        target?.frameOwnerVisible !== true
      ) continue
      if (
        target?.frameOwnerVisibilityKnown === true &&
        target?.frameOwnerVisible !== true
      ) continue
      inspect('targetText', target?.pageText, {
        tag: 'iframe',
        targetSessionId: target?.sessionId || '',
        targetUrl
      })
    }

    const behavioral = matches.some(match => match.kind === 'behavioral')
    const sessionId = String(entry.sessionId || entry.id || '')
    const eventScope = {
      id: sessionId,
      workbenchId: sessionId,
      sessionId,
      tabId: String(entry.id || '')
    }
    const emitCleared = clearedChallenge => {
      if (!clearedChallenge?.detected) return
      this.eventBus.emit(EVENT_TYPES.CAPTCHA_CLEARED, {
        ...eventScope,
        url: value.url || '',
        title: value.title || '',
        challengeId: clearedChallenge.challengeId || '',
        documentRevision: clearedChallenge.documentRevision ?? null
      })
    }
    if (!matches.length || (behavioral && verificationCompleted)) {
      const ignoredProviderSignature = providerMatches
        .slice(0, 8)
        .map(match => `${match.source}:${match.pattern}:${match.index || ''}`)
        .join('|')
      if (
        !matches.length &&
        ignoredProviderSignature &&
        entry.lastIgnoredCaptchaProviderSignature !== ignoredProviderSignature
      ) {
        this.log?.(
          `browser-runtime ignored passive captcha provider marker ` +
          `session=${sessionId || '-'} evidence=${providerMatches
            .slice(0, 8)
            .map(match => `${match.source}:${match.pattern}`)
            .join(',')}`
        )
      }
      entry.lastIgnoredCaptchaProviderSignature = ignoredProviderSignature || null
      const clearedChallenge = entry.captchaState
      emitCleared(clearedChallenge)
      entry.lastCaptchaSignature = null
      entry.lastCaptchaDocumentRevision = null
      entry.captchaState = { detected: false }
      return null
    }
    entry.lastIgnoredCaptchaProviderSignature = null

    const signature = matches
      .slice(0, 8)
      .map(match => `${match.source}:${match.pattern}:${match.index || ''}:${match.text}`)
      .join('|')
    const documentRevision = Math.max(
      0,
      Number(value.documentRevision ?? value.document_revision) || 0
    )
    const kind = behavioral ? 'behavioral' : 'transcribable'
    const previousChallenge = entry.captchaState
    const sameDocument = Boolean(
      previousChallenge?.detected &&
      Number(previousChallenge.documentRevision) === documentRevision
    )
    const crossedDocument = Boolean(previousChallenge?.detected && !sameDocument)
    // Challenge identity is document-scoped. A matching captcha signature in a
    // newly committed document must first resolve the previous verification
    // request, then publish a fresh challenge id for the new document.
    if (crossedDocument) emitCleared(previousChallenge)
    // If a behavioral gate becomes merely transcribable, the human-only block
    // has ended even though captcha-looking text remains. Resolve that episode
    // before publishing the new non-blocking classification.
    if (
      !crossedDocument &&
      previousChallenge?.detected &&
      previousChallenge.kind === 'behavioral' &&
      kind !== 'behavioral'
    ) {
      emitCleared(previousChallenge)
    }
    const sameEpisode = Boolean(
      sameDocument &&
      previousChallenge.kind === kind &&
      previousChallenge.challengeId
    )
    let challengeId = sameEpisode ? previousChallenge.challengeId : ''
    if (!challengeId) {
      this.captchaChallengeSequence = Math.max(0, Number(this.captchaChallengeSequence) || 0) + 1
      challengeId = `${this.captchaChallengeEpoch}:${this.captchaChallengeSequence.toString(36)}`
    }
    const detectionChanged =
      !sameEpisode ||
      entry.lastCaptchaSignature !== signature ||
      Number(entry.lastCaptchaDocumentRevision) !== documentRevision
    const detection = {
      detected: true,
      kind,
      url: value.url || '',
      title: value.title || '',
      challengeId,
      challengeStartedDocumentRevision: sameEpisode
        ? previousChallenge.challengeStartedDocumentRevision
        : documentRevision,
      documentRevision,
      matches: matches.slice(0, 10),
      // Only behavioral challenges pause the agent (the Python guard keys off
      // this flag); transcribable codes go through the collect flow instead.
      requiresUserInput: behavioral
    }
    entry.captchaState = detection
    // While a BEHAVIORAL captcha is up the agent is blocked at the Python layer
    // and stops observing, so nothing would re-run detection to notice it
    // clear. Arm an independent poll that re-observes until CAPTCHA_CLEARED
    // fires — that is what auto-resumes the agent (session-browser →
    // verification.respond). Transcribable codes never block, so no watch.
    if (behavioral) this._armCaptchaClearWatch(entry)
    if (detectionChanged && (options.emitDetected !== false || crossedDocument)) {
      this.log?.(
        `browser-runtime captcha detected session=${sessionId || '-'} ` +
        `kind=${kind} evidence=${matches
          .slice(0, 8)
          .map(match => `${match.source}:${match.pattern}`)
          .join(',')}`
      )
      this.eventBus.emit(EVENT_TYPES.CAPTCHA_DETECTED, {
        ...eventScope,
        ...detection
      })
      entry.lastCaptchaSignature = signature
      entry.lastCaptchaDocumentRevision = documentRevision
    }
    return detection
  }

  // Refresh only the human-verification state. Unlike observe(), this probe
  // deliberately does not publish model-facing DOM state: selectorMap,
  // synthetic selector ids, domState and decision generations must remain tied
  // to the observation that produced the model's pending action. This matters
  // most on challenge pages where the model may already hold an indexed link
  // that safely navigates away while the human-completion watcher is polling.
  async _pollCaptchaState(entry) {
    if (!entry || this.workbenches.get(String(entry.id)) !== entry) {
      return entry?.captchaState || { detected: false }
    }
    const activeChallenge = entry.captchaState
    if (!activeChallenge?.detected || activeChallenge.kind !== 'behavioral') {
      return activeChallenge || { detected: false }
    }
    const challengeId = String(activeChallenge.challengeId || '')
    const lease = this._observationLease(entry)
    const result = await entry.client.send(
      'Runtime.evaluate',
      {
        expression: buildObserveExpression({ maxElements: 300, publishSelectorMap: false }),
        returnByValue: true,
        awaitPromise: true
      },
      undefined,
      20000
    )
    const value = result?.result?.value
    if (!value || typeof value !== 'object' || !this._observationLeaseMatches(entry, lease)) {
      return entry.captchaState || { detected: false }
    }
    const attachedTargets = typeof entry.targetManager?.attachedTargets === 'function'
      ? entry.targetManager.attachedTargets()
      : []
    const providerTargetPattern = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|geetest/i
    const attachedSessionIds = new Set(
      attachedTargets
        .map(item => String(item?.sessionId || ''))
        .filter(Boolean)
    )
    const providerTargetSessions = new Set(
      attachedTargets
        .filter(item => providerTargetPattern.test(String(item?.target?.url || '')))
        .map(item => String(item?.sessionId || ''))
        .filter(Boolean)
    )
    const activeTargetSessions = new Set()
    for (const match of activeChallenge.matches || []) {
      const targetSessionId = String(match?.targetSessionId || '')
      // A solved challenge commonly destroys its iframe target. Only a target
      // that is still attached can be required to answer this poll; retaining
      // a detached session id would keep the human-verification gate forever.
      if (targetSessionId && attachedSessionIds.has(targetSessionId)) {
        activeTargetSessions.add(targetSessionId)
      }
    }
    const relevantTargetSessions = [
      ...activeTargetSessions,
      ...[...providerTargetSessions].filter(
        sessionId => !activeTargetSessions.has(sessionId)
      )
    ]
    let targetElements = []
    let targetObservations = []
    if (relevantTargetSessions.length) {
      let frameMetadata = null
      try {
        frameMetadata = await this._collectFrameMetadata(entry)
      } catch {
        frameMetadata = null
      }
      // Probe each relevant target independently. A shared element budget can
      // let the first provider frame consume the whole allowance and make a
      // later active frame look missing forever.
      for (const targetSessionId of relevantTargetSessions) {
        const targetProbe = await this._observeAttachedTargets(entry, {
          maxElements: 120,
          startIndex: 1 + targetElements.length,
          frameMetadata,
          includeAccessibility: false,
          includeSnapshot: false,
          includeDomDocument: false,
          includeJsListeners: false,
          publishSelectorMap: false,
          targetFilter: item => (
            String(item?.sessionId || '') === targetSessionId
          )
        })
        const observedTargets = targetProbe.observations || []
        targetElements = targetElements.concat(targetProbe.elements || [])
        targetObservations = targetObservations.concat(observedTargets)
        const activeTargetObservation = observedTargets.find(
          target => String(target?.sessionId || '') === targetSessionId
        )
        // Failure to inspect a still-attached frame that supplied the active
        // challenge is inconclusive, so preserve the gate for the next tick.
        // Provider owner visibility must also be known: a transient frame-tree
        // or owner-resolution failure otherwise filters the checkbox/text and
        // falsely clears an unfinished challenge. Unrelated provider frames
        // are candidates only and cannot block clear.
        if (
          activeTargetSessions.has(targetSessionId) &&
          (
            !activeTargetObservation ||
            (
              providerTargetSessions.has(targetSessionId) &&
              activeTargetObservation.frameOwnerVisibilityKnown !== true
            )
          )
        ) {
          return entry.captchaState || { detected: false }
        }
      }
    }
    if (!this._observationLeaseMatches(entry, lease)) {
      return entry.captchaState || { detected: false }
    }
    const currentChallenge = entry.captchaState
    if (
      !currentChallenge?.detected ||
      currentChallenge.kind !== 'behavioral' ||
      (challengeId && String(currentChallenge.challengeId || '') !== challengeId)
    ) {
      return currentChallenge || { detected: false }
    }
    value.documentRevision = lease.documentRevision
    value.document_revision = lease.documentRevision
    const elements = (Array.isArray(value.elements) ? value.elements : [])
      .concat(targetElements)
    this._detectCaptcha(entry, value, elements, {
      emitDetected: false,
      targetObservations
    })
    return entry.captchaState || { detected: false }
  }

  // Background watcher armed when a captcha is detected: probes only captcha
  // state on an interval so _detectCaptcha can emit CAPTCHA_CLEARED without
  // rebuilding the selector state owned by a pending model decision. Self-stops
  // when the captcha clears or becomes transcribable, the workbench is gone, or
  // the 5-minute polling ceiling is hit. Idempotent via captchaWatchActive.
  _armCaptchaClearWatch(entry) {
    if (!entry || entry.captchaWatchActive) return
    entry.captchaWatchActive = true
    const startedAt = Date.now()
    const maxMs = 5 * 60 * 1000
    const pollMs = 1500
    const tick = async () => {
      if (
        this.workbenches.get(entry.id) !== entry ||
        !entry.captchaState?.detected ||
        entry.captchaState?.kind !== 'behavioral' ||
        Date.now() - startedAt > maxMs
      ) {
        entry.captchaWatchActive = false
        return
      }
      await this._pollCaptchaState(entry).catch(() => undefined)
      if (!entry.captchaState?.detected || entry.captchaState?.kind !== 'behavioral') {
        entry.captchaWatchActive = false
        return
      }
      setTimeout(tick, pollMs)
    }
    setTimeout(tick, pollMs)
  }
}

function installObservationOperations(Runtime) {
  for (const name of Object.getOwnPropertyNames(ObservationOperations.prototype)) {
    if (name === 'constructor') continue
    Object.defineProperty(
      Runtime.prototype,
      name,
      Object.getOwnPropertyDescriptor(ObservationOperations.prototype, name)
    )
  }
}

module.exports = { SYNTHETIC_SELECTOR_INDEX_BASE, installObservationOperations }
