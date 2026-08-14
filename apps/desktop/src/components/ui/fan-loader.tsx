import type { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

// Fan's loader: three dots in the brand colour rising in a staggered, gentle
// bounce — an unhurried "thinking" rhythm. Pure CSS, self-contained.
const DOTS = [0, 1, 2]

export function FanLoader({ className, ...props }: Omit<ComponentProps<'span'>, 'children'>) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-primary', className)} role="presentation" {...props}>
      {DOTS.map(i => (
        <span
          className="size-2 rounded-full bg-current [animation:fan-dot_1.2s_ease-in-out_infinite]"
          key={i}
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  )
}
