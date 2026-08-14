const EVENT_TYPES = Object.freeze({
  RUNTIME_STARTED: 'runtime.started',
  RUNTIME_STOPPED: 'runtime.stopped',
  WORKBENCH_REGISTERED: 'workbench.registered',
  WORKBENCH_UNREGISTERED: 'workbench.unregistered',
  CDP_ATTACHED: 'cdp.attached',
  CDP_DETACHED: 'cdp.detached',
  CDP_MESSAGE: 'cdp.message',
  NAVIGATION_STARTED: 'navigation.started',
  NAVIGATION_COMPLETED: 'navigation.completed',
  NAVIGATION_FAILED: 'navigation.failed',
  NETWORK_REQUEST_STARTED: 'network.request.started',
  NETWORK_REQUEST_FINISHED: 'network.request.finished',
  NETWORK_REQUEST_FAILED: 'network.request.failed',
  SECURITY_STATE_CHANGED: 'security.state.changed',
  PERMISSION_REQUESTED: 'permission.requested',
  PERMISSION_RESOLVED: 'permission.resolved',
  CAPTCHA_DETECTED: 'captcha.detected',
  CAPTCHA_CLEARED: 'captcha.cleared',
  ABOUT_BLANK_DETECTED: 'aboutblank.detected',
  STORAGE_STATE_CAPTURED: 'storage.state.captured',
  STORAGE_STATE_APPLIED: 'storage.state.applied',
  STORAGE_STATE_SAVED: 'storage.state.saved',
  STORAGE_STATE_LOADED: 'storage.state.loaded',
  HAR_SAVED: 'har.saved',
  SCREENCAST_STARTED: 'screencast.started',
  SCREENCAST_FRAME: 'screencast.frame',
  SCREENCAST_STOPPED: 'screencast.stopped',
  DOM_OBSERVED: 'dom.observed',
  DOWNLOAD_STARTED: 'download.started',
  DOWNLOAD_UPDATED: 'download.updated',
  POPUP_REQUESTED: 'popup.requested',
  POPUP_HANDLED: 'popup.handled',
  TAB_OPEN_REQUESTED: 'tab.open_requested',
  TAB_CREATED: 'tab.created',
  TAB_CLOSED: 'tab.closed',
  TAB_ACTIVATED: 'tab.activated',
  SELECTOR_INVALIDATED: 'selector.invalidated',
  OBSERVE_REQUIRED: 'observe.required',
  BROWSER_CONTEXT_UPDATED: 'browser.context.updated',
  DIALOG_OPENED: 'dialog.opened',
  DIALOG_CLOSED: 'dialog.closed',
  RENDER_PROCESS_GONE: 'render-process.gone',
  RENDER_PROCESS_UNRESPONSIVE: 'render-process.unresponsive',
  RENDER_PROCESS_RESPONSIVE: 'render-process.responsive',
  ACTION_STARTED: 'action.started',
  ACTION_COMPLETED: 'action.completed',
  ACTION_FAILED: 'action.failed',
  CONTROL_STATE: 'control.state',
  USER_INTERVENED: 'user.intervened'
})

// EVT-09:事件名重叠是日后追踪/重命名的噩梦。移植 events.py 的
// _check_event_names_dont_overlap(适配我方字符串常量模型):断言所有事件名唯一、
// 且任一名都不是另一名的子串,使全仓库 grep/sed 重命名始终安全。模块加载即校验、
// 违规 fail-fast。不要随手删。
;(function _checkEventNamesDontOverlap() {
  const values = Object.values(EVENT_TYPES)
  const seen = new Set()
  for (const v of values) {
    if (seen.has(v)) throw new Error(`Duplicate event name "${v}" in EVENT_TYPES`)
    seen.add(v)
  }
  for (const a of values) {
    for (const b of values) {
      if (a !== b && b.includes(a)) {
        throw new Error(`Event name "${a}" is a substring of "${b}"; event names must be unique to keep grep/sed refactoring safe`)
      }
    }
  }
})()

module.exports = { EVENT_TYPES }
