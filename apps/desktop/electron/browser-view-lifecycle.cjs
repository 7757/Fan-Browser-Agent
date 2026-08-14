'use strict'

class BrowserViewLifecycle {
  constructor({ getContentView, log = () => undefined } = {}) {
    this.getContentView = typeof getContentView === 'function' ? getContentView : () => null
    this.log = typeof log === 'function' ? log : () => undefined
    this.attached = new Set()
    this.visible = new Set()
    this.pending = new Set()
    this.attachedContentViews = new WeakMap()
    this.pendingContentViews = new WeakMap()
    this.disposing = new WeakSet()
    this.disposed = new WeakSet()
    this.destroyListeners = new WeakMap()
  }

  isAttached(view) {
    if (!view) return false
    if (this.disposed.has(view)) return false
    if (this.attached.has(view)) return true
    return this._appearsInNativeTree(this._resolveContentView(), view)
  }

  isVisible(view) {
    return Boolean(view && this.visible.has(view) && this.isAttached(view))
  }

  attach(view, { raise = false } = {}) {
    if (
      !view ||
      this.disposing.has(view) ||
      this.disposed.has(view) ||
      view.webContents?.isDestroyed?.()
    ) return false
    const contentView = this._resolveContentView()
    if (!contentView) return false

    const wasAttached = this.attached.has(view)
    try {
      if (raise || !wasAttached) {
        contentView.addChildView(view)
        this.attachedContentViews.set(view, contentView)
      } else if (!this.attachedContentViews.has(view)) {
        this.attachedContentViews.set(view, contentView)
      }
      this.attached.add(view)
      return true
    } catch (error) {
      this.log(`browser view attach failed: ${error?.message || error}`)
      this.attached.delete(view)
      this.attachedContentViews.delete(view)
      return false
    }
  }

  show(view, options) {
    if (!this.attach(view, options)) return false
    try {
      view.setVisible(true)
      this.visible.add(view)
      return true
    } catch (error) {
      this.log(`browser view show failed: ${error?.message || error}`)
      this.detach(view)
      return false
    }
  }

  prepare(view, options) {
    if (!this.attach(view, options)) return false
    try {
      view.setVisible(false)
      this.visible.delete(view)
      return true
    } catch (error) {
      this.log(`browser view prepare failed: ${error?.message || error}`)
      this.detach(view)
      return false
    }
  }

  detach(view) {
    if (!view) return false
    this.visible.delete(view)
    try {
      view.setVisible(false)
    } catch (error) {
      this.log(`browser view hide failed: ${error?.message || error}`)
    }

    const contentView = this.attachedContentViews.get(view) || this._resolveContentView()
    const wasAttached = this.attached.has(view)
    const appearsInNativeTree = this._appearsInNativeTree(contentView, view)
    if (!wasAttached && !appearsInNativeTree) {
      this.attached.delete(view)
      this.attachedContentViews.delete(view)
      return true
    }
    if (typeof contentView?.removeChildView !== 'function') {
      this.attached.add(view)
      this.log('browser view detach failed: native content view is unavailable')
      return false
    }
    try {
      contentView.removeChildView(view)
      if (contentView.children?.includes?.(view)) {
        this.attached.add(view)
        this.log('browser view detach failed: native view remains attached')
        return false
      }
      this.attached.delete(view)
      this.attachedContentViews.delete(view)
      return true
    } catch (error) {
      this.attached.add(view)
      this.log(`browser view detach failed: ${error?.message || error}`)
      return false
    }
  }

  dispose(view) {
    if (!view) return false
    if (this.disposed.has(view)) return true
    this.disposing.add(view)
    this.pending.add(view)
    if (!this.pendingContentViews.has(view)) {
      const contentView = this.attachedContentViews.get(view) || this._resolveContentView()
      if (contentView) this.pendingContentViews.set(view, contentView)
    }

    this.detach(view)
    const webContents = view.webContents
    if (!webContents) return this._finalizeDispose(view, true)
    if (webContents.isDestroyed?.()) return this._finalizeDispose(view)

    this._watchForDestroyed(view, webContents)

    try {
      webContents.setBackgroundThrottling?.(true)
    } catch (error) {
      this.log(`browser view throttle reset failed: ${error?.message || error}`)
    }
    try {
      webContents.setAudioMuted?.(true)
    } catch (error) {
      this.log(`browser view mute failed: ${error?.message || error}`)
    }
    try {
      webContents.close?.({ waitForBeforeUnload: false })
    } catch (error) {
      this.log(`browser view close failed: ${error?.message || error}`)
    }
    return this._finalizeDispose(view)
  }

  async waitForDisposed(view, timeoutMs = 2500) {
    if (!view || this.disposed.has(view)) return true

    let webContents
    try {
      webContents = view.webContents
    } catch (error) {
      this.log(`browser view destroy wait lookup failed: ${error?.message || error}`)
      return false
    }
    if (!webContents) return this._finalizeDispose(view, true)
    if (webContents.isDestroyed?.()) return this._finalizeDispose(view)

    const boundedTimeoutMs = Math.max(0, Number(timeoutMs) || 0)
    return new Promise(resolve => {
      let settled = false
      let timer = null
      const finish = destroyed => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try {
          webContents.removeListener?.('destroyed', onDestroyed)
        } catch (error) {
          this.log(`browser view destroy wait cleanup failed: ${error?.message || error}`)
        }
        resolve(destroyed ? this._finalizeDispose(view) : false)
      }
      const onDestroyed = () => finish(true)

      try {
        webContents.once?.('destroyed', onDestroyed)
      } catch (error) {
        this.log(`browser view destroy wait listener failed: ${error?.message || error}`)
      }
      if (webContents.isDestroyed?.()) {
        finish(true)
        return
      }
      timer = setTimeout(() => {
        let destroyed = false
        try {
          destroyed = Boolean(webContents.isDestroyed?.())
        } catch {
          destroyed = false
        }
        finish(destroyed)
      }, boundedTimeoutMs)
    })
  }

  pendingViews() {
    return [...this.pending]
  }

  // Host teardown is terminal: retry cleanup, then drop tracking even if Electron
  // rejects native operations or finishes closing WebContents asynchronously.
  releaseHost(host) {
    const hasExplicitHost = arguments.length > 0 && host != null
    const contentView = hasExplicitHost ? this._resolveContentView(host) : null
    const releaseAll = !hasExplicitHost || !contentView
    const trackedViews = new Set([...this.attached, ...this.pending])

    for (const view of trackedViews) {
      if (!releaseAll && !this._belongsToContentView(view, contentView)) continue
      try {
        this.dispose(view)
      } catch (error) {
        this.log(`browser view host release failed: ${error?.message || error}`)
      } finally {
        this._releaseTracking(view)
      }
    }
    return true
  }

  _watchForDestroyed(view, webContents) {
    if (this.destroyListeners.has(view) || typeof webContents.once !== 'function') return
    const onDestroyed = () => {
      this.destroyListeners.delete(view)
      if (this.disposed.has(view)) return
      const contentView = this.attachedContentViews.get(view) || this.pendingContentViews.get(view)
      if (this.attached.has(view) || this._appearsInNativeTree(contentView, view)) this.detach(view)
      this._finalizeDispose(view)
    }
    this.destroyListeners.set(view, { webContents, onDestroyed })
    try {
      webContents.once('destroyed', onDestroyed)
    } catch (error) {
      this.destroyListeners.delete(view)
      this.log(`browser view destroy listener failed: ${error?.message || error}`)
    }
  }

  _finalizeDispose(view, missingWebContents = false) {
    if (this.disposed.has(view)) return true
    const webContents = view?.webContents
    const isDestroyed = missingWebContents || Boolean(webContents?.isDestroyed?.())
    const contentView = this.attachedContentViews.get(view) ||
      this.pendingContentViews.get(view) ||
      this._resolveContentView()
    const appearsInNativeTree = this._appearsInNativeTree(contentView, view)
    if (!isDestroyed || this.attached.has(view) || appearsInNativeTree) return false

    this._releaseTracking(view)
    return true
  }

  _releaseTracking(view) {
    const listener = this.destroyListeners.get(view)
    if (listener) {
      try {
        listener.webContents.removeListener?.('destroyed', listener.onDestroyed)
      } catch (error) {
        this.log(`browser view destroy listener cleanup failed: ${error?.message || error}`)
      }
      this.destroyListeners.delete(view)
    }
    this.attached.delete(view)
    this.visible.delete(view)
    this.pending.delete(view)
    this.attachedContentViews.delete(view)
    this.pendingContentViews.delete(view)
    this.disposing.delete(view)
    this.disposed.add(view)
  }

  _belongsToContentView(view, contentView) {
    const attachedContentView = this.attachedContentViews.get(view)
    const pendingContentView = this.pendingContentViews.get(view)
    if (!attachedContentView && !pendingContentView) return true
    return attachedContentView === contentView || pendingContentView === contentView
  }

  _appearsInNativeTree(contentView, view) {
    try {
      return Boolean(contentView?.children?.includes?.(view))
    } catch (error) {
      this.log(`browser view native tree inspection failed: ${error?.message || error}`)
      return false
    }
  }

  _resolveContentView(host) {
    if (host == null) {
      try {
        return this.getContentView()
      } catch (error) {
        this.log(`browser view host lookup failed: ${error?.message || error}`)
        return null
      }
    }
    try {
      if (host.contentView) return host.contentView
    } catch (error) {
      this.log(`browser view host lookup failed: ${error?.message || error}`)
      return null
    }
    if (typeof host.addChildView === 'function' || typeof host.removeChildView === 'function') return host
    return null
  }
}

module.exports = { BrowserViewLifecycle }
