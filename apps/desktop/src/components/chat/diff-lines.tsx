import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Per-line classed renderer for unified diffs. Lives outside `CodeCard` so
 * tool-result panels (already nested inside a tool card) don't double-shell;
 * for markdown ` ```diff ` fences the standard `CodeCard` + Shiki path runs
 * instead and gives equivalent coloring.
 */
interface DiffLineKind {
  className?: string
  match: (line: string) => boolean
}

const DIFF_LINE_KINDS: DiffLineKind[] = [
  {
    className: 'text-(--ui-green)',
    match: line => line.startsWith('+') && !line.startsWith('+++')
  },
  { className: 'text-(--ui-red)', match: line => line.startsWith('-') && !line.startsWith('---') },
  { className: 'text-(--ui-blue)', match: line => line.startsWith('@@') },
  {
    className: 'text-muted-foreground/70',
    match: line => line.startsWith('---') || line.startsWith('+++') || / → /.test(line.slice(0, 60))
  }
]

function classifyLine(line: string): string | undefined {
  return DIFF_LINE_KINDS.find(kind => kind.match(line))?.className
}

interface DiffLinesProps extends Omit<React.ComponentProps<'pre'>, 'children'> {
  text: string
}

export function DiffLines({ className, text, ...props }: DiffLinesProps) {
  return (
    // Liquid Glass diff surface — Pencil b8iff fSNjT: tinted inset area on the
    // glass card (r12, faint navy, top highlight), 11.5px mono lines with
    // muted body text; +/− lines keep the semantic accent colors.
    <pre
      className={cn(
        'mt-2 max-h-96 max-w-full min-w-0 overflow-auto rounded-[12px] bg-[#22325C0A] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-(--bwa-text-secondary) shadow-(--lg-inset-highlight) dark:bg-white/[0.04]',
        className
      )}
      data-slot="diff-lines"
      {...props}
    >
      {text.split('\n').map((line, index) => (
        <span className={cn('block min-w-max whitespace-pre', classifyLine(line))} key={`${index}-${line}`}>
          {line || ' '}
        </span>
      ))}
    </pre>
  )
}
