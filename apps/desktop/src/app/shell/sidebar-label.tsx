import type * as React from 'react'

import { cn } from '@/lib/utils'

interface SidebarPanelLabelProps extends React.ComponentProps<'span'> {
  dotClassName?: string
}

export function SidebarPanelLabel({ children, className, dotClassName, ...props }: SidebarPanelLabelProps) {
  void dotClassName

  return (
    <span
      className={cn(
        'flex min-w-0 items-center pl-2 font-mono text-[0.625rem] font-medium uppercase tracking-[0.14em] text-(--ui-text-tertiary)',
        className
      )}
      {...props}
    >
      <span className="min-w-0 truncate leading-none">{children}</span>
    </span>
  )
}
