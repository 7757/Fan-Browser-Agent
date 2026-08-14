import type { ReactNode } from 'react'

import { SearchField } from '@/components/ui/search-field'
import { cn } from '@/lib/utils'

interface PageSearchShellProps extends React.ComponentProps<'section'> {
  children: ReactNode
  /** Primary tabs shown on the top row, beside the search. */
  tabs?: ReactNode
  /** Secondary filters shown full-width on their own row below (expands). */
  filters?: ReactNode
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchValue: string
  /** Hide the search field when there's nothing to search (empty dataset). */
  searchHidden?: boolean
}

export function PageSearchShell({
  children,
  className,
  tabs,
  filters,
  onSearchChange,
  searchPlaceholder,
  searchValue,
  searchHidden = false,
  ...props
}: PageSearchShellProps) {
  return (
    <section
      {...props}
      className={cn(
        // Floating glass page (matches the workspace panels): outer padding
        // clears the window-chrome band, the glass panel holds the page.
        'flex h-full min-w-0 flex-col overflow-hidden bg-transparent px-4 pb-4 pt-11',
        className
      )}
    >
      <div className="glass-panel flex min-h-0 flex-1 flex-col overflow-hidden">
      {/*
        Header lives in the page body, below the window chrome (the shell floats
        traffic lights over the top titlebar-height strip, which the `pt` clears
        and leaves draggable). Top row: primary tabs + search. Second row:
        secondary filters, full-width so they expand. Interactive bits opt out
        of the drag region.
      */}
      {/*
        IMPORTANT: do NOT put `-webkit-app-region: drag` on this header. It spans
        full width over the band where the floating titlebar icon clusters live,
        and an overlapping OS drag region eats their clicks at the compositor
        level (pointer-events / no-drag carve-outs across separate stacking
        contexts don't reliably fix it on macOS). The shell already supplies a
        draggable titlebar strip that is `calc()`'d around the icon clusters
        (see app-shell.tsx), so window dragging still works here.
      */}
      <div className="shrink-0">
        {(tabs || !searchHidden) && (
          <>
            {/* VGEJT Top Bar (ckGEL): 62px tall, pill tabs left + a 240px
                rounded search box right, space-between, then a hairline. */}
            <div className="flex h-[3.875rem] items-center justify-between gap-3 px-[1.375rem]">
              {tabs ? <div className="flex min-w-0 flex-wrap items-center gap-1.5">{tabs}</div> : <span />}
              {!searchHidden && (
                <SearchField
                  containerClassName="h-9 w-60 shrink-0 gap-2 rounded-[0.5rem] border-b-0 bg-muted px-3 transition-shadow focus-within:border-transparent focus-within:ring-1 focus-within:ring-(--ui-stroke-secondary)"
                  iconClassName="size-[0.9375rem] text-muted-foreground"
                  inputClassName="h-9 text-[0.8125rem] placeholder:text-muted-foreground"
                  onChange={onSearchChange}
                  placeholder={searchPlaceholder}
                  value={searchValue}
                />
              )}
            </div>
            <div aria-hidden className="h-px bg-border" />
          </>
        )}
        {filters ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-[1.375rem] py-2">{filters}</div> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-transparent">{children}</div>
      </div>
    </section>
  )
}
