import * as React from 'react'

import { cn } from '@/lib/utils'

// Count chip beside a TextTab label (VGEJT gEeSL): a mono number on a full-
// round pill. Inactive = surface-2 fill + muted ink; active (read from the
// parent tab's data-active via the group) = translucent-white fill + primary
// ink so it sits on the tab's blue-8% bed.
function TextTabMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-muted px-[0.4375rem] py-0.5 font-mono text-[0.65625rem] font-medium text-muted-foreground',
        'group-data-[active=true]/tab:bg-white/70 group-data-[active=true]/tab:text-primary',
        className
      )}
      {...props}
    />
  )
}

interface TextTabProps extends React.ComponentProps<'button'> {
  active?: boolean
}

// Page-level filter pill (VGEJT ymMHl): 13px label + count chip on a full-round
// pill. Active = blue-8% bed + primary semibold label; inactive = secondary
// label with a muted hover. Shared by the artifacts + skills page headers.
function TextTab({ active = false, children, className, type = 'button', ...props }: TextTabProps) {
  return (
    <button
      className={cn(
        'group/tab inline-flex items-center gap-[0.4375rem] rounded-full py-2 pr-[0.6875rem] pl-[0.8125rem] text-[0.8125rem] font-medium text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50',
        active &&
          'bg-[color-mix(in_srgb,var(--dt-primary)_8%,transparent)] font-semibold text-primary hover:bg-[color-mix(in_srgb,var(--dt-primary)_12%,transparent)] hover:text-primary',
        className
      )}
      data-active={active}
      type={type}
      {...props}
    >
      {children}
    </button>
  )
}

export { TextTab, TextTabMeta }
