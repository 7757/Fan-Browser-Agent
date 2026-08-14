import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/lib/utils'

// Small status/metadata tag. Pill-shaped per the A2 design (Beta / 待处理 /
// RUNNING chips); tones map to the shared accent/muted/destructive surfaces.
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium leading-none whitespace-nowrap [&_svg]:size-3 [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary',
        muted: 'bg-muted text-muted-foreground',
        warn: 'bg-(--ui-yellow)/10 text-(--ui-yellow)',
        destructive: 'bg-destructive/10 text-destructive',
        outline: 'border border-(--ui-stroke-secondary) text-muted-foreground'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  asChild?: boolean
}

export function Badge({ asChild = false, className, variant, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span'

  return <Comp className={cn(badgeVariants({ variant }), className)} data-slot="badge" {...props} />
}

export { badgeVariants }
