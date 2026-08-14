import type { ReactNode } from 'react'

import type { IconComponent } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { PAGE_INSET_X } from '../layout-constants'

interface OverlaySplitLayoutProps {
  children: ReactNode
  className?: string
}

interface OverlaySidebarProps {
  children: ReactNode
  className?: string
}

interface OverlayMainProps {
  children: ReactNode
  className?: string
}

interface OverlayNavItemProps {
  active: boolean
  icon: IconComponent
  label: string
  // Renders as an indented child of another nav item: smaller icon and a
  // lighter active state so it never competes with the boxed parent item.
  nested?: boolean
  onClick: () => void
  trailing?: ReactNode
}

export function OverlaySplitLayout({ children, className }: OverlaySplitLayoutProps) {
  return (
    <div
      className={cn(
        'grid h-full min-h-0 flex-1 grid-cols-[13rem_minmax(0,1fr)] overflow-hidden bg-transparent max-[47.5rem]:grid-cols-1',
        className
      )}
      data-slot="overlay-split-layout"
    >
      {children}
    </div>
  )
}

export function OverlaySidebar({ children, className }: OverlaySidebarProps) {
  return (
    <aside
      className={cn(
        // pt clears the floating titlebar/header; the bg itself fills from the
        // card's top edge so there's no surface-colored gap above the sidebar.
        'flex min-h-0 flex-col gap-1 overflow-y-auto border-r border-(--ui-stroke-quaternary) bg-transparent px-2.5 pb-3 pt-[calc(var(--titlebar-height)+1rem)]',
        className
      )}
      data-slot="overlay-sidebar"
    >
      {children}
    </aside>
  )
}

export function OverlayMain({ children, className }: OverlayMainProps) {
  return (
    <main
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent pb-3 pt-[calc(var(--titlebar-height)+1rem)]',
        PAGE_INSET_X,
        className
      )}
      data-slot="overlay-main"
    >
      {children}
    </main>
  )
}

export function OverlayNavItem({ active, icon: Icon, label, nested, onClick, trailing }: OverlayNavItemProps) {
  return (
    <button
      className={cn(
        // Match the main sidebar's expanded nav rows (vlcAT): 38px-ish height,
        // 10px round, muted hover, and a blue-8% active that deepens to 12% on
        // hover — so the settings menu hovers/selects exactly like the app rail.
        'flex h-9 w-full items-center justify-start gap-[0.6875rem] rounded-[0.625rem] border border-transparent px-[0.6875rem] text-left text-sm font-medium transition-colors duration-100 ease-out',
        nested
          ? active
            ? 'bg-muted text-foreground'
            : 'text-(--ui-text-tertiary) hover:bg-muted hover:text-foreground'
          : active
            ? 'bg-[color-mix(in_srgb,var(--dt-primary)_8%,transparent)] font-semibold text-primary hover:bg-[color-mix(in_srgb,var(--dt-primary)_12%,transparent)] hover:text-primary'
            : 'text-(--ui-text-secondary) hover:bg-muted hover:text-foreground'
      )}
      data-active={active ? '' : undefined}
      data-slot="overlay-nav-item"
      onClick={onClick}
      type="button"
    >
      <Icon
        className={cn('shrink-0', nested ? 'size-3.5' : 'size-4', active ? 'text-primary' : 'text-muted-foreground/80')}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  )
}
