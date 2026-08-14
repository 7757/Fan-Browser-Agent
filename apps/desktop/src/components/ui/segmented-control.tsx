import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SegmentedControlOption<T extends string> {
  id: T
  label: string
  icon?: IconComponent
}

interface SegmentedControlProps<T extends string> {
  options: readonly SegmentedControlOption<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
}

/**
 * Grouped one-row toggle used for small mutually-exclusive choices
 * (color mode, tool-call display, usage period, etc.). Flat by design —
 * no per-option borders, just a tinted track with a raised active pill.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, className }: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        // bwa Segmented spec: surface-2 track + hairline, raised white active pill.
        'inline-grid w-fit auto-cols-fr grid-flow-col gap-[0.1875rem] rounded-[0.5rem] border border-border bg-muted p-[0.1875rem]',
        className
      )}
    >
      {options.map(({ id, label, icon: Icon }) => {
        const active = value === id

        return (
          <button
            aria-pressed={active}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-[0.375rem] px-3 py-1 text-[0.8125rem] transition-colors',
              active
                ? 'bg-white font-semibold text-foreground shadow-[0_1px_2px_#1B254021]'
                : 'font-medium text-(--ui-text-secondary) hover:text-foreground'
            )}
            key={id}
            onClick={() => onChange(id)}
            type="button"
          >
            {Icon && <Icon className="size-3" />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
