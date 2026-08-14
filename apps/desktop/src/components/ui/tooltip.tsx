import { Tooltip as TooltipPrimitive } from 'radix-ui'
import * as React from 'react'

import { cn } from '@/lib/utils'

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        className={cn(
          'liquid-tooltip z-[200] w-fit px-2.5 py-1.5 text-xs font-medium leading-none text-foreground select-none',
          'data-[state=delayed-open]:animate-in data-[state=instant-open]:animate-in fade-in-0 zoom-in-95 duration-100',
          className
        )}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

interface TipProps extends Omit<React.ComponentProps<typeof TooltipPrimitive.Content>, 'content'> {
  label: React.ReactNode
  children: React.ReactNode
  delayDuration?: number
}

// Drop-in replacement for native `title=`: wrap any single element. Instant,
// position-aware, themed. Self-contained (carries its own Provider) so it works
// anywhere without a provider ancestor. Renders the child untouched when label
// is falsy.
function Tip({ label, children, delayDuration = 0, ...props }: TipProps) {
  if (!label) {
    return <>{children}</>
  }

  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger
          asChild
          // Radix keeps a tooltip open while its trigger is FOCUSED (keyboard
          // a11y). A mouse click leaves the trigger focused, so the tip stayed
          // stuck on screen after clicking (e.g. the "全部对话" pill). Blur on a
          // MOUSE click only — detail>0 is a pointer click; keyboard activation
          // (Enter/Space) reports detail 0 and keeps focus, so nav a11y is intact.
          // Fixes every Tip-wrapped button at once instead of per-button blur.
          onClick={event => {
            if (event.detail > 0) {
              event.currentTarget.blur()
            }
          }}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent {...props}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
