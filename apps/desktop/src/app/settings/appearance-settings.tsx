import type { ReactNode } from 'react'

import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { useTheme } from '@/themes/context'

import { APPEARANCE_TOOLTIPS, LANGUAGE_OPTIONS, MODE_OPTIONS } from './constants'
import { TitleWithInfo } from './primitives'

function SectionHead({
  title,
  description,
  control,
  tooltip
}: {
  title: string
  description: string
  control?: ReactNode
  tooltip?: string
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="text-[length:var(--conversation-text-font-size)] font-medium">
          <TitleWithInfo title={title} tooltip={tooltip} />
        </div>
        <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {description}
        </div>
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  )
}

// Body without the SettingsContent scroll wrapper, so the unified settings
// scroll page can render it inline under the 外观 section header.
export function AppearanceSettingsBody({
  onLanguageChange
}: {
  onLanguageChange?: (language: 'en' | 'zh') => void
} = {}) {
  const { mode, setMode } = useTheme()
  const { language, setLanguage, t } = useI18n()

  return (
    <div className="grid gap-8">
      <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
        {t('以下为仅限桌面端的显示偏好设置。颜色模式控制明亮 / 深色外观。')}
      </p>

      <section>
        <SectionHead
          control={
            <SegmentedControl
              onChange={id => {
                triggerHaptic('crisp')
                setMode(id)
              }}
              options={MODE_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
              value={mode}
            />
          }
          description={t('选择明亮或深色，或让 Fan 跟随系统设置。')}
          title={t('颜色模式')}
          tooltip={t(APPEARANCE_TOOLTIPS.colorMode)}
        />
      </section>

      <section>
        <SectionHead
          control={
            <SegmentedControl
              onChange={id => {
                triggerHaptic('crisp')
                setLanguage(id)
                onLanguageChange?.(id)
              }}
              options={LANGUAGE_OPTIONS.map(option => ({ ...option, label: t(option.label) }))}
              value={language}
            />
          }
          description={t('选择 Fan 桌面界面使用的语言。')}
          title={t('界面语言')}
        />
      </section>
    </div>
  )
}
