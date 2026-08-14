import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'

import { COMPLETION_DRAWER_CLASS } from './completion-drawer'

const COMMON_COMMANDS: [string, string][] = [
  ['/help', '完整命令列表 + 快捷键'],
  ['/clear', '新建会话'],
  ['/resume', '继续之前的会话'],
  ['/details', '控制转录详细程度'],
  ['/copy', '复制所选内容或最后一条助手消息'],
  ['/quit', '退出 Fan']
]

const HOTKEYS: [string, string][] = [
  ['@', '引用文件、文件夹、URL、git'],
  ['/', '斜杠命令面板'],
  ['?', '此快速帮助（按删除键关闭）'],
  ['Enter', '发送 · Shift+Enter 换行'],
  ['Cmd/Ctrl+L', '重绘'],
  ['Esc', '关闭弹出层 · 取消运行'],
  ['↑ / ↓', '切换弹出层 / 历史记录']
]

export function HelpHint() {
  const { t } = useI18n()

  return (
    <div className={COMPLETION_DRAWER_CLASS} data-slot="composer-completion-drawer" data-state="open" role="dialog">
      <Section title={t('常用命令')}>
        {COMMON_COMMANDS.map(([key, desc]) => (
          <Row description={t(desc)} key={key} keyLabel={key} mono />
        ))}
      </Section>

      <Section title={t('快捷键')}>
        {HOTKEYS.map(([key, desc]) => (
          <Row description={t(desc)} key={key} keyLabel={key} />
        ))}
      </Section>

      <p className="px-2.5 py-1 text-xs text-muted-foreground/80">
        <span className="font-mono text-foreground/80">/help</span>{' '}
        {t('打开完整面板 · 退格键关闭')}
      </p>
    </div>
  )
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="grid gap-0.5 pt-0.5">
      <p className="px-2.5 pb-0.5 pt-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground/75">
        {title}
      </p>
      {children}
    </div>
  )
}

function Row({ description, keyLabel, mono = false }: { description: string; keyLabel: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 rounded-md px-2.5 py-1 text-xs">
      <span
        className={
          mono ? 'shrink-0 truncate font-mono font-medium text-foreground/85' : 'shrink-0 truncate text-foreground/85'
        }
      >
        {keyLabel}
      </span>
      <span className="min-w-0 truncate text-muted-foreground/80">{description}</span>
    </div>
  )
}
