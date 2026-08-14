import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { Clipboard, FileText, FolderOpen, type IconComponent, ImageIcon, MessageSquareText } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { GHOST_ICON_BTN } from './controls'
import type { ChatBarState } from './types'

const PROMPT_SNIPPETS: readonly PromptSnippet[] = [
  {
    description: '审查当前改动是否存在回归、遗漏的边界情况和缺失的测试。',
    label: '代码审查',
    text: '请帮我审查这部分，找出 bug、回归问题和缺失的测试。'
  },
  {
    description: '在动代码之前先梳理实现方案，让 diff 保持聚焦。',
    label: '实现计划',
    text: '请在动代码之前，先给出一份简洁的实现计划。'
  },
  {
    description: '逐步讲解所选代码的工作原理，并指出关键文件。',
    label: '解释代码',
    text: '请讲解这部分是如何工作的，并指出关键文件。'
  }
]

export function ContextMenu({
  state,
  onInsertText,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages
}: ContextMenuProps) {
  const { t } = useI18n()
  // Prompt snippets used to be a Radix submenu. That submenu didn't open
  // reliably when the parent menu was positioned at the bottom of the
  // window (composer "+" anchor), so we promoted it to a real Dialog —
  // easier to grow with search / descriptions, and no positioning math.
  const [snippetsOpen, setSnippetsOpen] = useState(false)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={state.tools.label}
            className={cn(
              GHOST_ICON_BTN,
              'data-[state=open]:bg-white/60 data-[state=open]:text-[#1A1D21]'
            )}
            disabled={!state.tools.enabled}
            size="icon"
            title={state.tools.label}
            type="button"
            variant="ghost"
          >
            <Codicon name="attach" size="1.0625rem" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="composer-glass-menu w-60 p-1" side="top" sideOffset={10}>
          <DropdownMenuLabel className="px-3 pt-1.5 pb-1 text-[0.7rem] font-medium text-[#8A919E]">
            {t('附件')}
          </DropdownMenuLabel>
          <ContextMenuItem disabled={!onPickFiles} icon={FileText} onSelect={onPickFiles}>
            {t('选择文件')}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickFolders} icon={FolderOpen} onSelect={onPickFolders}>
            {t('选择文件夹')}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickImages} icon={ImageIcon} onSelect={onPickImages}>
            {t('选择图片')}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!onPasteClipboardImage}
            icon={Clipboard}
            onSelect={onPasteClipboardImage ? () => void onPasteClipboardImage() : undefined}
          >
            {t('粘贴图片')}
          </ContextMenuItem>
          <DropdownMenuSeparator className="mx-[-0.25rem] my-1 bg-[#D8DEE8]/80" />

          <ContextMenuItem icon={MessageSquareText} onSelect={() => setSnippetsOpen(true)}>
            {t('提示词片段…')}
          </ContextMenuItem>

          <DropdownMenuSeparator className="mx-[-0.25rem] my-1 bg-[#D8DEE8]/80" />

          <div className="px-3 py-1 text-[0.7rem] text-[#8A919E]">
            提示：输入{' '}
            <kbd className="rounded bg-white/55 px-1 py-px font-mono text-[0.65rem] text-[#8A919E]">@</kbd>{' '}
            可内联引用文件。
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptSnippetsDialog
        onInsertText={onInsertText}
        onOpenChange={setSnippetsOpen}
        open={snippetsOpen}
        snippets={PROMPT_SNIPPETS}
        t={t}
      />
    </>
  )
}

function PromptSnippetsDialog({ onInsertText, onOpenChange, open, snippets, t }: PromptSnippetsDialogProps & {
  t: (source: string) => string
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>{t('提示词片段')}</DialogTitle>
          <DialogDescription>{t('选择一条起始提示词插入到输入框。')}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1">
          {snippets.map(snippet => (
            <li key={snippet.label}>
              <button
                className="group/snippet flex w-full items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) focus-visible:border-(--ui-stroke-tertiary) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none"
                onClick={() => {
                  onInsertText(snippet.text)
                  onOpenChange(false)
                }}
                type="button"
              >
                <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-(--ui-text-tertiary) group-hover/snippet:text-foreground" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-sm font-medium text-foreground">{snippet.label}</span>
                  <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {snippet.description}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

function ContextMenuItem({ children, disabled, icon: Icon, onSelect }: ContextMenuItemProps) {
  return (
    <DropdownMenuItem className="composer-glass-menu-item" disabled={disabled} onSelect={onSelect}>
      <Icon className="size-4.5 text-[#7D848F]" />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}

interface ContextMenuItemProps {
  children: string
  disabled?: boolean
  icon: IconComponent
  onSelect?: () => void
}

interface ContextMenuProps {
  onInsertText: (text: string) => void
  onOpenUrlDialog: () => void
  onPasteClipboardImage?: (opts?: { silent?: boolean }) => Promise<boolean> | void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
  state: ChatBarState
}

interface PromptSnippet {
  description: string
  label: string
  text: string
}

interface PromptSnippetsDialogProps {
  onInsertText: (text: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
  snippets: readonly PromptSnippet[]
}
