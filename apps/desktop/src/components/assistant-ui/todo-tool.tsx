import { type FC } from 'react'

import { Checkbox } from '@/components/ui/checkbox'
import { ListChecks } from '@/lib/icons'
import { parseTodos, type TodoItem, type TodoStatus } from '@/lib/todos'
import { cn } from '@/lib/utils'

export function todosFromMessageContent(content: unknown): TodoItem[] {
  if (!Array.isArray(content)) {
    return []
  }

  let latest: null | TodoItem[] = null

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue
    }

    const row = part as Record<string, unknown>

    if (row.type !== 'tool-call' || row.toolName !== 'todo') {
      continue
    }

    const parsed = parseTodos(row.result) ?? parseTodos(row.args)

    if (parsed !== null) {
      latest = parsed
    }
  }

  return latest ?? []
}

// Liquid Glass todo checkmark — Pencil b8iff nya7s: 16px pill; done = solid
// accent with a white tick, in-progress = glass fill + accent ring + accent
// dot, pending = glass fill + grey ring.
const Checkmark: FC<{ status: TodoStatus; label: string }> = ({ status, label }) => {
  if (status === 'in_progress') {
    return (
      <span
        aria-label={`进行中: ${label}`}
        className="grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] border-(--lg-accent) bg-(--lg-inset-fill-strong)"
      >
        <span className="size-[5px] rounded-full bg-(--lg-accent)" />
      </span>
    )
  }

  const checked = status === 'completed'

  return (
    <Checkbox
      aria-label={label}
      checked={checked}
      className={cn(
        'pointer-events-none size-4 shrink-0 rounded-full border-[1.5px] border-(--lg-radio-stroke) bg-(--lg-inset-fill-strong) disabled:cursor-default disabled:opacity-100',
        checked &&
          // The indicator glyph is a Codicon icon-FONT (<i class="codicon">),
          // not an svg — size it via font-size.
          'data-[state=checked]:border-(--lg-accent) data-[state=checked]:bg-(--lg-accent) data-[state=checked]:text-white [&_[data-slot=checkbox-indicator]_.codicon]:text-[9px]',
        status === 'cancelled' && 'border-muted-foreground/40'
      )}
      disabled
    />
  )
}

export const HoistedTodoPanel: FC<{ todos: TodoItem[] }> = ({ todos }) => {
  if (!todos.length) {
    return null
  }

  const doneCount = todos.filter(t => t.status === 'completed').length

  return (
    // Liquid Glass todo card — Pencil b8iff nya7s, 1:1: glass card r20,
    // 9/12 header with a blue list-checks chip + 任务清单 + progress pill,
    // hairline divider, 10/14 body with the three-state rows.
    <section className="lg-card mt-1 mb-3 inline-block w-fit max-w-full overflow-hidden align-top" data-slot="aui_todo-hoisted">
      <header className="flex items-center justify-between gap-3 px-3 py-[9px]">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-(--bwa-primary-soft)">
            <ListChecks className="size-[13px] text-(--lg-accent)" />
          </span>
          <span className="truncate text-[12.5px] font-semibold text-(--bwa-text)">任务清单</span>
        </span>
        <span className="shrink-0 rounded-full bg-(--bwa-primary-soft) px-2 py-0.5 font-mono text-[10px] font-normal text-(--lg-accent)">
          {doneCount} / {todos.length}
        </span>
      </header>
      <div className="lg-divider" />
      <ul className="grid min-w-0 gap-0.5 px-3.5 pt-2.5 pb-3">
        {todos.map(todo => {
          const active = todo.status === 'in_progress'

          return (
            <li className="flex min-w-0 items-center gap-2.5 py-[7px]" key={todo.id}>
              <Checkmark label={todo.content} status={todo.status} />
              <span
                className={cn(
                  'min-w-0 wrap-anywhere text-[12.5px] leading-[1.2rem]',
                  todo.status === 'completed' && 'text-(--bwa-text-muted)',
                  active && 'font-semibold text-(--bwa-text)',
                  todo.status !== 'completed' && !active && 'text-(--bwa-text-secondary)',
                  todo.status === 'cancelled' && 'line-through'
                )}
              >
                {todo.content}
              </span>
              {active && <span className="shrink-0 text-[10.5px] font-semibold text-(--lg-accent)">进行中</span>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
