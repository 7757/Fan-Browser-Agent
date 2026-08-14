import { Dialog as DialogPrimitive } from 'radix-ui'
import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { acquireFullWindowOverlay } from '@/store/native-overlay'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'lg-scrim fixed inset-0 z-[120] pointer-events-auto data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  )
}

function FullWindowOverlayLease() {
  React.useLayoutEffect(() => acquireFullWindowOverlay(), [])

  return null
}

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = true,
  style,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  overlayClassName?: string
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          // Cap height at 85vh and let long content scroll inside the dialog
          // instead of overflowing off-screen (long cron titles, tool detail
          // dumps, etc.). Individual dialogs can still override via className.
          'lg-card fixed top-1/2 z-[130] pointer-events-auto grid max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-3.5 overflow-y-auto rounded-[1.25rem] p-5 text-[length:var(--conversation-text-font-size)] text-foreground duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          'left-1/2',
          className
        )}
        data-slot="dialog-content"
        style={style}
        {...props}
      >
        {/* Radix only renders Content children while the dialog is present, so
            a closed Dialog does not accidentally hold the browser hidden. */}
        <FullWindowOverlayLease />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild data-slot="dialog-close-button">
            <Button
              aria-label="关闭"
              className="lg-icon-btn absolute right-2.5 top-2.5 text-(--ui-text-tertiary) hover:text-foreground"
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="close" size="1rem" />
              <span className="sr-only">关闭</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col gap-1 text-center sm:text-left', className)}
      data-slot="dialog-header"
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      data-slot="dialog-footer"
      {...props}
    />
  )
}

// Canonical dialog footer button: compact for the footer (16×8 / 13px, ~32px
// tall — the full 16×11/14px spec button read as oversized in a confirm box),
// with hover-brighten + active-darken press feedback. The `hover:bg-{color}`
// cancels the Button variant's `/90` hover-darken (tailwind-merge keeps the
// last), so solid actions brighten on hover and darken on press.
// `has-[>svg]:px-4` keeps the padding when the label swaps to a status icon.
// Literal radius (10px) so the global --radius-scalar can't collapse rounded-md
// to a near-square ~2px.
const DIALOG_ACTION_BASE = 'rounded-[0.625rem] px-4 py-2 text-[0.8125rem] leading-4 has-[>svg]:px-4'

const DIALOG_ACTION_TONE = {
  destructive: 'hover:bg-destructive hover:brightness-105 active:brightness-95',
  ghost: 'active:bg-(--ui-control-active-background)',
  primary: 'hover:bg-primary hover:brightness-105 active:brightness-95'
} as const

const DIALOG_ACTION_VARIANT = {
  destructive: 'destructive',
  ghost: 'ghost',
  primary: 'default'
} as const

function DialogAction({
  className,
  tone = 'primary',
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'variant'> & { tone?: keyof typeof DIALOG_ACTION_TONE }) {
  return (
    <Button
      {...props}
      className={cn(DIALOG_ACTION_BASE, DIALOG_ACTION_TONE[tone], className)}
      data-slot="dialog-action"
      variant={DIALOG_ACTION_VARIANT[tone]}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn('text-[0.9375rem] font-semibold tracking-tight text-foreground', className)}
      data-slot="dialog-title"
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn(
        'text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-secondary)',
        className
      )}
      data-slot="dialog-description"
      {...props}
    />
  )
}

export {
  Dialog,
  DialogAction,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  FullWindowOverlayLease
}
