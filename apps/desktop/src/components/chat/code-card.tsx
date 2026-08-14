import * as React from 'react'

import { Codicon, type CodiconProps } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

/**
 * Liquid Glass card shell for fenced code (and any equivalent: diffs, raw
 * payloads, etc.) — Pencil b8iff diUi0 (Code Output Card), 1:1 material:
 * glass gradient r20, 9/12 header with a neutral 22px icon chip and mono
 * language subtitle, hairline divider, 12/14 mono body.
 */
function CodeCard({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      // lg-card-static: every fenced code block in a markdown-heavy transcript
      // pays for its own backdrop blur otherwise — material without the filter.
      className={cn(
        'lg-card lg-card-static min-w-0 max-w-full overflow-hidden text-[length:var(--conversation-tool-font-size)] text-(--bwa-text-secondary)',
        className
      )}
      data-slot="code-card"
      {...props}
    />
  )
}

function CodeCardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center justify-between gap-2 border-b border-(--lg-divider) px-3 py-[9px]', className)}
      data-slot="code-card-header"
      {...props}
    />
  )
}

function CodeCardTitle({ className, children, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('flex min-w-0 items-center gap-2 truncate text-[12.5px] font-semibold leading-(--conversation-line-height) text-(--bwa-text)', className)}
      data-slot="code-card-title"
      {...props}
    >
      {children}
    </span>
  )
}

function CodeCardIcon({ className, ...props }: CodiconProps) {
  return (
    <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-[#22325C14] dark:bg-white/10">
      <Codicon
        className={cn('shrink-0 text-[0.8125rem] leading-none text-(--bwa-text-secondary)', className)}
        data-slot="code-card-icon"
        {...props}
      />
    </span>
  )
}

function CodeCardSubtitle({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('font-mono text-[11px] font-normal text-(--bwa-text-muted)', className)}
      data-slot="code-card-subtitle"
      {...props}
    />
  )
}

function CodeCardBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // [&_pre]:text-[12px] must be stated on the pre itself: styles.css's
        // `.aui-md :where(pre)` sets the conversation font size DIRECTLY on
        // pre, which beats inheritance from this wrapper.
        'px-3.5 py-3 font-mono text-[12px] leading-relaxed text-(--bwa-text) [&_pre]:m-0 [&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:p-0 [&_pre]:font-mono [&_pre]:text-[12px] [&_pre]:leading-relaxed',
        className
      )}
      data-slot="code-card-body"
      {...props}
    />
  )
}

export { CodeCard, CodeCardBody, CodeCardHeader, CodeCardIcon, CodeCardSubtitle, CodeCardTitle }
