import type { ReactNode, RefObject } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { type IconComponent, Info } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_INSET_X } from '../layout-constants'

export function SettingsContent({
  children,
  scrollRef
}: {
  children: ReactNode
  /** Optional handle on the scroll container (for scroll-spy roots). */
  scrollRef?: RefObject<HTMLDivElement | null>
}) {
  return (
    <section className="min-h-0 overflow-hidden">
      <div className={cn('h-full min-h-0 overflow-y-auto pb-20', PAGE_INSET_X)} ref={scrollRef}>
        <div className="mx-auto w-full max-w-4xl">{children}</div>
      </div>
    </section>
  )
}

export function Pill({ tone = 'muted', children }: { tone?: 'muted' | 'primary'; children: ReactNode }) {
  return <Badge variant={tone === 'primary' ? 'default' : 'muted'}>{children}</Badge>
}

export function SectionHeading({ icon: Icon, title, meta }: { icon: IconComponent; title: string; meta?: string }) {
  return (
    <div className="mb-2.5 flex items-center gap-2 pt-2 text-[length:var(--conversation-text-font-size)] font-medium">
      <Icon className="size-4 text-muted-foreground" />
      <span>{title}</span>
      {meta && <Pill>{meta}</Pill>}
    </div>
  )
}

export function TitleWithInfo({ title, tooltip }: { title: ReactNode; tooltip?: ReactNode }) {
  const { t } = useI18n()

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0">{title}</span>
      {tooltip ? (
        <Tip className="max-w-64 whitespace-normal leading-snug" label={tooltip} side="top">
          <button
            aria-label={`${typeof title === 'string' ? title : t('设置项')}${t('说明')}`}
            className="grid size-4 shrink-0 place-items-center rounded-full text-(--ui-text-tertiary) transition hover:text-(--theme-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)/30"
            type="button"
          >
            <Info aria-hidden className="size-3.5" />
          </button>
        </Tip>
      ) : null}
    </span>
  )
}

export function ListRow({
  title,
  description,
  hint,
  action,
  below,
  wide = false
}: {
  title: ReactNode
  description?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  below?: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className={cn(
        'grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] sm:items-center',
        wide && 'sm:grid-cols-1 sm:items-start'
      )}
    >
      <div className="min-w-0">
        <div className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{title}</div>
        {description && (
          <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {description}
          </div>
        )}
        {hint && <div className="mt-1 block font-mono text-[0.68rem] text-muted-foreground/45">{hint}</div>}
        {below}
      </div>
      {action && <div className={cn('min-w-0', !wide && 'sm:justify-self-end')}>{action}</div>}
    </div>
  )
}

export function LoadingState({ label }: { label: string }) {
  return <PageLoader label={label} />
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="grid min-h-48 place-items-center text-center">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}
