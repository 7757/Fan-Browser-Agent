import type { ComponentProps } from 'react'

import { FanLoader } from '@/components/ui/fan-loader'
import { cn } from '@/lib/utils'

interface PageLoaderProps extends Omit<ComponentProps<'div'>, 'children'> {
  label?: string
}

// The app-wide loading affordance. Uses FanLoader (the brand three-dot bounce
// the embedded browser shows) so every loading surface — settings/overlay
// fallback, artifacts, cron, skills, previews — reads as one consistent mark.
export function PageLoader({
  'aria-label': ariaLabel,
  className,
  label = '加载中',
  role = 'status',
  ...props
}: PageLoaderProps) {
  return (
    <div
      {...props}
      aria-label={ariaLabel ?? label}
      className={cn('grid h-full place-items-center', className)}
      role={role}
    >
      <FanLoader aria-hidden="true" />
    </div>
  )
}
