import { cva, type VariantProps } from 'class-variance-authority'
import { Switch as SwitchPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

// bwa Switch spec: pill track, surface-3 (#E8EBEF) when off / primary when on,
// a flat white knob (always white — the old dark knob read as dated), 3px inset.
const switchVariants = cva(
  'peer inline-flex shrink-0 items-center rounded-full border border-transparent bg-[#E8EBEF] px-[0.1875rem] transition-colors outline-none focus-visible:ring-[0.1875rem] focus-visible:ring-[color-mix(in_srgb,var(--dt-primary)_30%,transparent)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary',
  {
    variants: {
      size: {
        default: 'h-6 w-[2.625rem]',
        xs: 'h-5 w-9'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-white shadow-[0_1px_2px_#1B254021] ring-0 transition-transform data-[state=unchecked]:translate-x-0',
  {
    variants: {
      size: {
        default: 'size-[1.125rem] data-[state=checked]:translate-x-[1.125rem]',
        xs: 'size-4 data-[state=checked]:translate-x-3.5'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

function Switch({
  className,
  size,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & VariantProps<typeof switchVariants>) {
  return (
    <SwitchPrimitive.Root className={cn(switchVariants({ size }), className)} data-slot="switch" {...props}>
      <SwitchPrimitive.Thumb className={switchThumbVariants({ size })} data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
