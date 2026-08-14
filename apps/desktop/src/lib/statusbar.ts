
import type { UsageStats } from '@/types/fan'

function formatK(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0'
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`
  }

  return `${Math.round(value)}`
}

export function usageContextLabel(usage: UsageStats): string {
  if (usage.context_max) {
    return `${formatK(usage.context_used ?? 0)}/${formatK(usage.context_max)}`
  }

  return usage.total > 0 ? `${formatK(usage.total)} Token` : ''
}
