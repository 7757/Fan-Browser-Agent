import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createCronJob,
  type CronJob,
  type CronJobUpdates,
  deleteCronJob,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from '@/fan'
import { AlertTriangle, Clock } from '@/lib/icons'
import { userFacingErrorMessage } from '@/lib/user-facing-error'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { OverlayView } from '../overlays/overlay-view'

import { CronJobActionsMenu, CronJobActionsTrigger } from './cron-job-actions-menu'

const SCHEDULE_OPTIONS: ReadonlyArray<ScheduleOption> = [
  {
    expr: '0 9 * * *',
    hint: '每天上午 9:00',
    label: '每天',
    value: 'daily'
  },
  {
    expr: '0 9 * * 1-5',
    hint: '周一至周五上午 9:00',
    label: '工作日',
    value: 'weekdays'
  },
  {
    expr: '0 9 * * 1',
    hint: '每周一上午 9:00',
    label: '每周',
    value: 'weekly'
  },
  {
    expr: '0 9 1 * *',
    hint: '每月第一天上午 9:00',
    label: '每月',
    value: 'monthly'
  },
  {
    expr: '0 * * * *',
    hint: '每小时整点',
    label: '每小时',
    value: 'hourly'
  },
  {
    expr: '*/15 * * * *',
    hint: '每 15 分钟',
    label: '每 15 分钟',
    value: 'every-15-minutes'
  },
  {
    hint: 'Cron 表达式或间隔写法',
    label: '自定义',
    value: 'custom'
  }
]

const STATE_VARIANT: Record<string, BadgeProps['variant']> = {
  enabled: 'default',
  scheduled: 'default',
  running: 'default',
  paused: 'warn',
  disabled: 'muted',
  error: 'destructive',
  completed: 'muted'
}

const STATE_LABEL: Record<string, string> = {
  enabled: '已启用',
  scheduled: '已计划',
  running: '运行中',
  paused: '已暂停',
  disabled: '已禁用',
  error: '出错',
  completed: '已完成'
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

const truncate = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max)}…` : value)

function jobName(job: CronJob): string {
  return asText(job.name).trim()
}

function jobPrompt(job: CronJob): string {
  return asText(job.prompt)
}

function jobTitle(job: CronJob): string {
  const name = jobName(job)

  if (name) {
    return name
  }

  const prompt = jobPrompt(job)

  if (prompt) {
    return truncate(prompt, 60)
  }

  const script = asText(job.script)

  if (script) {
    return truncate(script, 60)
  }

  return job.id || '定时任务'
}

function jobScheduleDisplay(job: CronJob): string {
  return asText(job.schedule_display) || asText(job.schedule?.display) || asText(job.schedule?.expr) || '—'
}

function jobScheduleExpr(job: CronJob): string {
  return asText(job.schedule?.expr) || asText(job.schedule_display) || ''
}

function jobState(job: CronJob): string {
  return asText(job.state) || (job.enabled === false ? 'disabled' : 'scheduled')
}

function cronParts(expr: string): null | string[] {
  const parts = expr.trim().replace(/\s+/g, ' ').split(' ')

  return parts.length === 5 ? parts : null
}

function dayName(value: string): string {
  const names: Record<string, string> = {
    '0': '周日',
    '1': '周一',
    '2': '周二',
    '3': '周三',
    '4': '周四',
    '5': '周五',
    '6': '周六',
    '7': '周日'
  }

  return names[value] ?? `第 ${value} 天`
}

function formatCronTime(minute: string, hour: string): string {
  const numericHour = Number(hour)
  const numericMinute = Number(minute)

  if (!Number.isInteger(numericHour) || !Number.isInteger(numericMinute)) {
    return `${hour}:${minute}`
  }

  return new Date(2000, 0, 1, numericHour, numericMinute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function isIntegerToken(value: string): boolean {
  return /^\d+$/.test(value)
}

function scheduleOptionForExpr(expr: string): ScheduleOption {
  const normalized = expr.trim().replace(/\s+/g, ' ')
  const exactMatch = SCHEDULE_OPTIONS.find(option => option.expr === normalized)

  if (exactMatch) {
    return exactMatch
  }

  const parts = cronParts(normalized)

  if (!parts) {
    return SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1]
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && isIntegerToken(minute) && isIntegerToken(hour)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'daily') ?? SCHEDULE_OPTIONS[0]
  }

  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5' && isIntegerToken(minute) && isIntegerToken(hour)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'weekdays') ?? SCHEDULE_OPTIONS[0]
  }

  if (
    dayOfMonth === '*' &&
    month === '*' &&
    isIntegerToken(dayOfWeek) &&
    isIntegerToken(minute) &&
    isIntegerToken(hour)
  ) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'weekly') ?? SCHEDULE_OPTIONS[0]
  }

  if (
    month === '*' &&
    dayOfWeek === '*' &&
    isIntegerToken(dayOfMonth) &&
    isIntegerToken(minute) &&
    isIntegerToken(hour)
  ) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'monthly') ?? SCHEDULE_OPTIONS[0]
  }

  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && isIntegerToken(minute)) {
    return SCHEDULE_OPTIONS.find(option => option.value === 'hourly') ?? SCHEDULE_OPTIONS[0]
  }

  if (normalized === '*/15 * * * *') {
    return SCHEDULE_OPTIONS.find(option => option.value === 'every-15-minutes') ?? SCHEDULE_OPTIONS[0]
  }

  return SCHEDULE_OPTIONS[SCHEDULE_OPTIONS.length - 1]
}

function scheduleSummary(option: ScheduleOption, expr: string): string {
  const parts = cronParts(expr)

  if (!parts) {
    return option.hint
  }

  const [minute, hour, dayOfMonth, , dayOfWeek] = parts

  if (option.value === 'daily') {
    return `每天 ${formatCronTime(minute, hour)}`
  }

  if (option.value === 'weekdays') {
    return `工作日 ${formatCronTime(minute, hour)}`
  }

  if (option.value === 'weekly') {
    return `每${dayName(dayOfWeek)} ${formatCronTime(minute, hour)}`
  }

  if (option.value === 'monthly') {
    return `每月 ${dayOfMonth} 日 ${formatCronTime(minute, hour)}`
  }

  if (option.value === 'hourly') {
    return minute === '0' ? '每小时整点' : `每小时第 :${minute.padStart(2, '0')} 分`
  }

  return option.hint
}

function formatTime(iso?: null | string): string {
  if (!iso) {
    return '—'
  }

  const date = new Date(iso)

  if (Number.isNaN(date.valueOf())) {
    return iso
  }

  return date.toLocaleString()
}

function matchesQuery(job: CronJob, q: string): boolean {
  if (!q) {
    return true
  }

  const needle = q.toLowerCase()

  return [jobTitle(job), jobPrompt(job), jobScheduleDisplay(job), jobScheduleExpr(job)].some(value =>
    value.toLowerCase().includes(needle)
  )
}

interface CronViewProps {
  /** Renders inside another shell (the Settings panel) — no OverlayView. */
  embedded?: boolean
  onClose?: () => void
}

export function CronView({ embedded = false, onClose }: CronViewProps) {
  const [jobs, setJobs] = useState<CronJob[] | null>(null)
  const [query, setQuery] = useState('')
  const [busyJobId, setBusyJobId] = useState<null | string>(null)

  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' })
  const [pendingDelete, setPendingDelete] = useState<CronJob | null>(null)

  const refresh = useCallback(async () => {
    try {
      const result = await getCronJobs()
      setJobs(result)
    } catch (err) {
      notifyError(err, '定时任务加载失败')
    }
  }, [])

  useRefreshHotkey(refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibleJobs = useMemo(() => {
    if (!jobs) {
      return []
    }

    return jobs.filter(job => matchesQuery(job, query.trim())).sort((a, b) => jobTitle(a).localeCompare(jobTitle(b)))
  }, [jobs, query])

  const enabledCount = jobs?.filter(job => job.enabled).length ?? 0
  const totalCount = jobs?.length ?? 0

  async function handlePauseResume(job: CronJob) {
    setBusyJobId(job.id)

    try {
      const isPaused = jobState(job) === 'paused'
      const updated = isPaused ? await resumeCronJob(job.id) : await pauseCronJob(job.id)
      setJobs(current => (current ? current.map(row => (row.id === job.id ? updated : row)) : current))
      notify({
        kind: 'success',
        title: isPaused ? '定时任务已恢复' : '定时任务已暂停',
        message: truncate(jobTitle(job), 60)
      })
    } catch (err) {
      notifyError(err, '更新定时任务失败')
    } finally {
      setBusyJobId(null)
    }
  }

  async function handleTrigger(job: CronJob) {
    setBusyJobId(job.id)

    try {
      const updated = await triggerCronJob(job.id)
      setJobs(current => (current ? current.map(row => (row.id === job.id ? updated : row)) : current))
      notify({ kind: 'success', title: '定时任务已触发', message: truncate(jobTitle(job), 60) })
    } catch (err) {
      notifyError(err, '触发定时任务失败')
    } finally {
      setBusyJobId(null)
    }
  }

  async function handleEditorSave(values: EditorValues) {
    if (editor.mode === 'create') {
      const created = await createCronJob({
        prompt: values.prompt,
        schedule: values.schedule,
        name: values.name || undefined
      })

      setJobs(current => (current ? [...current, created] : [created]))
      notify({ kind: 'success', title: '定时任务已创建', message: truncate(jobTitle(created), 60) })
    } else if (editor.mode === 'edit') {
      const scriptOnlyJob = Boolean(editor.job.no_agent && asText(editor.job.script).trim())
      const updates: CronJobUpdates = {
        schedule: values.schedule,
        name: values.name
      }
      // An empty prompt is valid for a no-agent script job. Omit it instead
      // of clearing the persisted value while editing its schedule.
      if (!scriptOnlyJob || values.prompt.trim()) {
        updates.prompt = values.prompt
      }
      const updated = await updateCronJob(editor.job.id, updates)

      setJobs(current => (current ? current.map(row => (row.id === updated.id ? updated : row)) : current))
      notify({ kind: 'success', title: '定时任务已更新', message: truncate(jobTitle(updated), 60) })
    }

    setEditor({ mode: 'closed' })
  }

  const mainContent = (
    <>
      <div className={cn('flex min-h-0 flex-1 flex-col', !embedded && 'pt-[calc(var(--titlebar-height)+0.5rem)]')}>
        {totalCount > 0 && (
          <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 pb-2">
            <SearchField
              containerClassName="max-w-[60vw]"
              onChange={setQuery}
              placeholder="搜索定时任务…"
              value={query}
            />
          </div>
        )}
        {!jobs ? (
          <PageLoader label="加载中..." />
        ) : visibleJobs.length === 0 ? (
          // Empty state owns the primary "create" CTA — we used to also have
          // one in the filters bar but it was redundant. Only show the button
          // when there are zero jobs total; the search-empty case ("No
          // matches") just asks the user to broaden their query.
          <EmptyState
            actionLabel={totalCount === 0 ? '创建第一个定时任务' : undefined}
            description={
              totalCount === 0
                ? '设置一个按 Cron 表达式自动运行的提示词，Fan 将执行并将结果发送到你指定的目标。'
                : '请尝试更宽泛的搜索词。'
            }
            onAction={totalCount === 0 ? () => setEditor({ mode: 'create' }) : undefined}
            title={totalCount === 0 ? '暂无定时任务' : '无匹配结果'}
          />
        ) : (
          <div className="mx-auto w-full max-w-4xl min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* Inline header replaces the old top-bar "New cron" button. We
                still need a single, always-visible affordance to add a job
                when the list is non-empty (rows themselves only expose
                edit/pause/trigger/delete). */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                {enabledCount}/{totalCount} 已启用
              </span>
              <Button onClick={() => setEditor({ mode: 'create' })} size="sm">
                <Codicon name="add" />
                新建定时任务
              </Button>
            </div>
            <div>
              {visibleJobs.map(job => (
                <CronJobRow
                  busy={busyJobId === job.id}
                  job={job}
                  key={job.id}
                  onDelete={() => setPendingDelete(job)}
                  onEdit={() => setEditor({ mode: 'edit', job })}
                  onPauseResume={() => void handlePauseResume(job)}
                  onTrigger={() => void handleTrigger(job)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <CronEditorDialog editor={editor} onClose={() => setEditor({ mode: 'closed' })} onSave={handleEditorSave} />

      <ConfirmDialog
        busyLabel="删除中…"
        confirmLabel="删除"
        description={
          pendingDelete ? (
            <>
              将永久删除{' '}
              <span className="font-medium text-foreground">{truncate(jobTitle(pendingDelete), 60)}</span>，
              任务将立即停止触发。
            </>
          ) : null
        }
        destructive
        doneLabel="已删除"
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) {
            return
          }

          await deleteCronJob(pendingDelete.id)
          setJobs(current => (current ? current.filter(row => row.id !== pendingDelete.id) : current))
        }}
        open={pendingDelete !== null}
        title="删除定时任务？"
      />
    </>
  )

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{mainContent}</div>
  }

  return (
    <OverlayView closeLabel="关闭定时任务" onClose={onClose ?? (() => undefined)}>
      {mainContent}
    </OverlayView>
  )
}

function CronJobRow({
  busy,
  job,
  onDelete,
  onEdit,
  onPauseResume,
  onTrigger
}: {
  busy: boolean
  job: CronJob
  onDelete: () => void
  onEdit: () => void
  onPauseResume: () => void
  onTrigger: () => void
}) {
  const state = jobState(job)
  const isPaused = state === 'paused'
  const hasName = Boolean(jobName(job))
  const prompt = jobPrompt(job)
  return (
    <div className="grid gap-3 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <button
        className="min-w-0 rounded-md text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={onEdit}
        type="button"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{jobTitle(job)}</span>
          <Badge variant={STATE_VARIANT[state] ?? 'muted'}>{STATE_LABEL[state] ?? state}</Badge>
        </div>
        {hasName && prompt && <p className="mt-1 truncate text-xs text-muted-foreground">{truncate(prompt, 120)}</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.68rem] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-mono">
            <Clock className="size-3" />
            {jobScheduleDisplay(job)}
          </span>
          <span>上次: {formatTime(job.last_run_at)}</span>
          <span>下次: {formatTime(job.next_run_at)}</span>
        </div>
        {job.last_error && (
          <p className="mt-1 inline-flex items-start gap-1 text-[0.68rem] text-destructive">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            <span className="line-clamp-2">{job.last_error}</span>
          </p>
        )}
      </button>

      <div className="flex shrink-0 items-center">
        <CronJobActionsMenu
          busy={busy}
          isPaused={isPaused}
          onDelete={onDelete}
          onEdit={onEdit}
          onPauseResume={onPauseResume}
          onTrigger={onTrigger}
          title={jobTitle(job)}
        >
          <CronJobActionsTrigger
            className="text-muted-foreground hover:text-foreground"
            onClick={event => event.stopPropagation()}
            title={jobTitle(job)}
          />
        </CronJobActionsMenu>
      </div>
    </div>
  )
}

function EmptyState({
  actionLabel,
  description,
  onAction,
  title
}: {
  actionLabel?: string
  description: string
  onAction?: () => void
  title: string
}) {
  return (
    <div className="grid h-full place-items-center px-6 py-12 text-center">
      <div className="max-w-sm space-y-2">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
        {actionLabel && onAction && (
          <Button className="mt-2" onClick={onAction} size="sm">
            <Codicon name="add" />
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

function CronEditorDialog({
  editor,
  onClose,
  onSave
}: {
  editor: EditorState
  onClose: () => void
  onSave: (values: EditorValues) => Promise<void>
}) {
  const open = editor.mode !== 'closed'
  const isEdit = editor.mode === 'edit'
  const initial = isEdit ? editor.job : null
  const scriptOnlyJob = Boolean(initial?.no_agent && asText(initial.script).trim())

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('')
  const [schedulePreset, setSchedulePreset] = useState('daily')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    setName(initial ? jobName(initial) : '')
    setPrompt(initial ? jobPrompt(initial) : '')
    setSchedule(initial ? jobScheduleExpr(initial) : (SCHEDULE_OPTIONS[0].expr ?? ''))
    setSchedulePreset(initial ? scheduleOptionForExpr(jobScheduleExpr(initial)).value : 'daily')
    setError(null)
    setSaving(false)
  }, [initial, open])

  const selectedScheduleOption =
    SCHEDULE_OPTIONS.find(candidate => candidate.value === schedulePreset) ?? SCHEDULE_OPTIONS[0]

  function handleSchedulePresetChange(nextPreset: string) {
    setSchedulePreset(nextPreset)
    setError(null)

    const option = SCHEDULE_OPTIONS.find(candidate => candidate.value === nextPreset)

    if (option?.expr) {
      setSchedule(option.expr)
    } else if (scheduleOptionForExpr(schedule).value !== 'custom') {
      setSchedule('')
    }
  }

  const scheduleHint = scheduleSummary(selectedScheduleOption, schedule)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedPrompt = prompt.trim()
    const trimmedSchedule = schedule.trim()

    if (!trimmedSchedule || (!scriptOnlyJob && !trimmedPrompt)) {
      setError(!trimmedSchedule ? '计划时间不能为空。' : '提示词不能为空。')

      return
    }

    setSaving(true)
    setError(null)

    try {
      await onSave({
        name: name.trim(),
        prompt: trimmedPrompt,
        schedule: trimmedSchedule
      })
    } catch (err) {
      console.error('[cron] Cron job save failed', err)
      setError(userFacingErrorMessage(err, '保存定时任务失败，请重试。'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog onOpenChange={value => !value && !saving && onClose()} open={open}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '更新计划或提示词，更改将在下次运行时生效。'
              : '设置一个自动运行的提示词。支持 Cron 表达式或间隔写法，例如 every 15m。'}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-4" onSubmit={handleSubmit}>
          <Field htmlFor="cron-name" label="名称" optional>
            <Input
              autoFocus
              id="cron-name"
              onChange={event => setName(event.target.value)}
              placeholder="早间简报"
              value={name}
            />
          </Field>

          <Field htmlFor="cron-prompt" label="提示词" optional={scriptOnlyJob}>
            <Textarea
              className="min-h-24 font-mono"
              id="cron-prompt"
              onChange={event => setPrompt(event.target.value)}
              placeholder="整理当前项目的待办事项并生成本地简报..."
              value={prompt}
            />
            {scriptOnlyJob && <FieldHint>这是脚本任务；无需填写提示词，脚本输出会保存到本地运行记录。</FieldHint>}
          </Field>

          <div className="grid items-start gap-4">
            <Field htmlFor="cron-frequency" label="频率">
              <Select onValueChange={handleSchedulePresetChange} value={schedulePreset}>
                <SelectTrigger id="cron-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHEDULE_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

          </div>

          {schedulePreset === 'custom' ? (
            <Field htmlFor="cron-schedule" label="自定义计划">
              <Input
                className="font-mono"
                id="cron-schedule"
                onChange={event => setSchedule(event.target.value)}
                placeholder="0 9 * * * 或 every 15m"
                value={schedule}
              />
              <FieldHint>填写 Cron 表达式（如 0 9 * * *），或间隔写法 every 30m、every 2h。</FieldHint>
            </Field>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">{scheduleHint}</span>
                <span className="font-mono text-muted-foreground">{schedule}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button disabled={saving} onClick={onClose} type="button" variant="outline">
              取消
            </Button>
            <Button disabled={saving} type="submit">
              {saving ? '保存中...' : isEdit ? '保存更改' : '创建定时任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  children,
  htmlFor,
  label,
  optional
}: {
  children: React.ReactNode
  htmlFor: string
  label: string
  optional?: boolean
}) {
  return (
    <div className="grid gap-1.5">
      <label className="flex items-baseline gap-2 text-xs font-medium text-foreground" htmlFor={htmlFor}>
        {label}
        {optional && <span className="text-[0.65rem] font-normal text-muted-foreground">可选</span>}
      </label>
      {children}
    </div>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.66rem] leading-4 text-muted-foreground">{children}</p>
}

type EditorState = { mode: 'closed' } | { mode: 'create' } | { job: CronJob; mode: 'edit' }

interface EditorValues {
  name: string
  prompt: string
  schedule: string
}

interface ScheduleOption {
  expr?: string
  hint: string
  label: string
  value: string
}
