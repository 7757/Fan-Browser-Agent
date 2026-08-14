'use strict'

// Layout intent may never hide a page while the runtime owns it. Lifecycle
// teardown and full-window overlays remain allowed: they either move away from
// the session or immediately cover the native surface with another product
// surface, and blocking them would leave WebContentsView above all DOM.
function canHideBrowserSurface({ operating = false, reason = 'layout' } = {}) {
  return !operating || reason === 'lifecycle' || reason === 'overlay'
}

module.exports = { canHideBrowserSurface }
