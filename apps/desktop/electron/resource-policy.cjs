'use strict'

const GIB = 1024 ** 3

function defaultLiveViewBudget(totalBytes) {
  const totalGB = Number(totalBytes) / GIB
  if (!Number.isFinite(totalGB) || totalGB <= 0) return 6
  if (totalGB <= 10) return 4
  if (totalGB <= 20) return 6
  if (totalGB <= 40) return 8
  return 10
}

function defaultMemoryBudgetMB(totalBytes) {
  const totalMB = Number(totalBytes) / 1024 ** 2
  if (!Number.isFinite(totalMB) || totalMB <= 0) return 3072
  return Math.max(1024, Math.min(3072, Math.round(totalMB / 4)))
}

module.exports = { defaultLiveViewBudget, defaultMemoryBudgetMB }
