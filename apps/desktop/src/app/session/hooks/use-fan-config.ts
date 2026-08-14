import { type MutableRefObject, useCallback } from 'react'

import { getFanConfig, getFanConfigDefaults } from '@/fan'
import { BUILTIN_PERSONALITIES, normalizePersonalityValue, personalityNamesFromConfig } from '@/lib/chat-runtime'
import {
  $currentCwd,
  setAvailablePersonalities,
  setCurrentCwd,
  setCurrentFastMode,
  setCurrentPersonality,
  setCurrentServiceTier,
  setIntroPersonality
} from '@/store/session'

const FAST_TIERS = new Set(['fast', 'priority', 'on'])

interface FanConfigOptions {
  activeSessionIdRef: MutableRefObject<string | null>
  refreshProjectBranch: (cwd: string) => Promise<void>
}

export function useFanConfig({ activeSessionIdRef, refreshProjectBranch }: FanConfigOptions) {
  const refreshFanConfig = useCallback(async () => {
    try {
      const [config, defaults] = await Promise.all([getFanConfig(), getFanConfigDefaults().catch(() => ({}))])

      const personality = normalizePersonalityValue(
        typeof config.display?.personality === 'string' ? config.display.personality : ''
      )

      setIntroPersonality(personality)
      // Active sessions keep their per-session value; standalone falls back to config.
      setCurrentPersonality(prev => (activeSessionIdRef.current ? prev || personality : personality))
      setAvailablePersonalities([
        ...new Set([
          'none',
          ...BUILTIN_PERSONALITIES,
          ...personalityNamesFromConfig(defaults),
          ...personalityNamesFromConfig(config)
        ])
      ])

      const cwd = (config.terminal?.cwd ?? '').trim()

      if (cwd && cwd !== '.') {
        setCurrentCwd(prev => prev || cwd)
        void refreshProjectBranch($currentCwd.get() || cwd)
      }

      const tier = (config.agent?.service_tier ?? '').trim()

      setCurrentServiceTier(prev => (activeSessionIdRef.current ? prev : tier))
      setCurrentFastMode(prev => (activeSessionIdRef.current ? prev : FAST_TIERS.has(tier.toLowerCase())))
    } catch {
      // Config is nice-to-have; chat still works without it.
    }
  }, [activeSessionIdRef, refreshProjectBranch])

  return { refreshFanConfig }
}
