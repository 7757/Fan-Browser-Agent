'use client'

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface ExpandableBlockProps {
  children: ReactNode
  className?: string
}

export function ExpandableBlock({ children, className }: ExpandableBlockProps) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const element = innerRef.current

    if (!element) {
      return
    }

    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1)
    measure()

    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(measure)
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative">
      <div
        className={cn('overflow-auto', expanded ? 'max-h-[60dvh]' : 'max-h-48', className)}
        ref={innerRef}
      >
        {children}
      </div>
      {overflowing && (
        <button
          aria-expanded={expanded}
          aria-label={expanded ? '收起内容' : '展开内容'}
          className="absolute inset-x-0 bottom-0 flex h-8 cursor-pointer items-end justify-center bg-linear-to-t from-(--ui-chat-surface-background) to-transparent pb-1 text-(--bwa-text-muted) transition-colors hover:text-(--bwa-text)"
          onClick={() => setExpanded(value => !value)}
          type="button"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </button>
      )}
    </div>
  )
}
