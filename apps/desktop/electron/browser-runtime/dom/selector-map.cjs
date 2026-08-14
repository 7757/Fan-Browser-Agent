// 页面"真翻新"的 clear 原因(须与 runtime.cjs 的 PAGE_CHANGED_CLEAR_REASONS 保持一致)。
// pageGeneration 只在这些原因下自增,区别于 generation(每次 clear/update 都增、含同页 click/type/scroll)。
// 放在 clear() 内部 = 无论经 runtime._clearSelectorMap 还是 watchdog 直接 clear(导航走的就是直接 clear)
// 都会被统一计入——这正是让 SPA/链接导航也能递增"页面变更代次"的关键。
const PAGE_CHANGED_CLEAR_REASONS = new Set([
  'navigation', 'navigation.started', 'navigation.completed', 'navigation.in-page',
  'dom.documentUpdated', 'back', 'forward', 'reload', 'switch-target', 'close-target',
])

class SelectorMap {
  constructor() {
    this.generation = 0
    // 页面变更代次:仅 PAGE_CHANGED 原因递增。供"页面自上次观察后是否已变化"判定(不被同页操作清空污染)。
    this.pageGeneration = 0
    this.items = new Map()
    this.reason = 'initial'
  }

  update(elements = []) {
    this.items.clear()
    for (const element of elements) {
      const index = Number(element?.index)
      if (Number.isFinite(index)) {
        this.items.set(index, element)
      }
    }
    this.generation += 1
    this.reason = 'updated'
    return this.size
  }

  clear(reason = 'cleared') {
    if (this.items.size) {
      this.items.clear()
      this.generation += 1
    }
    // 页面变更代次独立于 items 是否为空(导航到一个本就空的页面仍是一次"页面翻新")。
    if (PAGE_CHANGED_CLEAR_REASONS.has(reason)) this.pageGeneration += 1
    this.reason = reason
  }

  get(index) {
    const numeric = Number(index)
    if (!Number.isFinite(numeric)) return null
    return this.items.get(numeric) || null
  }

  get size() {
    return this.items.size
  }

  snapshot() {
    return {
      generation: this.generation,
      pageGeneration: this.pageGeneration,
      reason: this.reason,
      size: this.size,
      elements: Array.from(this.items.values())
    }
  }
}

module.exports = { SelectorMap }
