'use client'

import type { ComponentProps } from 'react'
import { useMemo } from 'react'

import { ExpandableBlock } from '@/components/chat/expandable-block'
import { CopyButton } from '@/components/ui/copy-button'
import { chunkByLines } from '@/lib/text-chunks'
import { cn } from '@/lib/utils'

interface OversizedTextBlockProps {
  className?: string
  collapsible?: boolean
  containerProps?: ComponentProps<'div'> & { 'data-slot'?: string }
  framed?: boolean
  text: string
}

export function OversizedTextBlock({
  className,
  collapsible = true,
  containerProps,
  framed = true,
  text
}: OversizedTextBlockProps) {
  const { className: containerClassName, 'data-slot': dataSlot, ...rootProps } = containerProps ?? {}
  const chunks = useMemo(() => chunkByLines(text, 200), [text])

  const content = chunks.map((chunk, index) => (
    <div
      className="[content-visibility:auto]"
      key={index}
      style={{ containIntrinsicSize: `auto ${chunk.lines * 20}px` }}
    >
      {chunk.text}
    </div>
  ))

  return (
    <div
      {...rootProps}
      className={cn(
        'w-full max-w-none overflow-hidden font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere',
        framed && 'rounded-xl border border-(--lg-divider) bg-white/25 dark:bg-black/10',
        containerClassName,
        className
      )}
      data-oversized-text="true"
      data-slot={dataSlot ?? 'oversized-text-block'}
    >
      {framed && (
        <div className="flex items-center justify-between gap-2 border-b border-(--lg-divider) px-3 py-2 text-[11px] text-(--bwa-text-muted)">
          <span>内容较长，已使用轻量显示</span>
          <CopyButton appearance="inline" label="复制完整内容" showLabel={false} text={text} />
        </div>
      )}
      {collapsible ? (
        <ExpandableBlock className="p-3">{content}</ExpandableBlock>
      ) : (
        <div className="max-h-48 overflow-auto p-3">{content}</div>
      )}
    </div>
  )
}
