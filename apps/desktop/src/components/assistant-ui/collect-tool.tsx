'use client'

import { type ToolCallMessagePartProps } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { triggerHaptic } from '@/lib/haptics'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $activeCollectRequests,
  activeCollectAnswers,
  clearCollectRequest,
  type CollectAnswers,
  type CollectContent,
  type CollectField,
  collectFieldValueNames,
  type CollectQuestion,
  findCollectRequestForToolCall,
  nextVisibleCollectQuestionIndex,
  parseCollectContent,
  visibleCollectQuestions
} from '@/store/collect'
import { $gateway } from '@/store/gateway'
import { notifyError } from '@/store/notifications'

import { CollectDatePicker } from './collect-date-picker'

const LEGACY_QUESTION_ID = '__single_collect__'
const QUESTION_ERROR_PREFIX = '__question__:'

const INPUT_CLASS =
  'lg-input w-full px-3 py-2 text-[12.5px] leading-snug text-(--bwa-text) placeholder:text-(--bwa-text-muted) focus:outline-none disabled:opacity-55'

const SENSITIVE_TYPES = new Set([
  'captcha',
  'credit_card',
  'document_number',
  'id_number',
  'otp',
  'passport',
  'secret'
])

const REMEMBERABLE_TYPES = new Set([
  'address',
  'country',
  'date',
  'datetime',
  'email',
  'number',
  'phone',
  'select',
  'text',
  'textarea',
  'time'
])

const TEMPORAL_TYPES = new Set([
  'date',
  'date_range',
  'datetime',
  'datetime_range',
  'time',
  'time_range'
])

const COLLECT_LIFECYCLE_STATUSES = new Set([
  'cancelled',
  'expired',
  'failed',
  'interrupted',
  'skipped',
  'submitted'
])

function temporalBaseType(type: CollectField['type']): 'date' | 'datetime' | 'time' | null {
  if (type === 'date' || type === 'date_range') {return 'date'}

  if (type === 'datetime' || type === 'datetime_range') {return 'datetime'}

  if (type === 'time' || type === 'time_range') {return 'time'}

  return null
}

function temporalInputType(field: CollectField): 'date' | 'datetime-local' | 'time' {
  const base = temporalBaseType(field.type)

  return base === 'datetime' ? 'datetime-local' : base ?? 'date'
}

function temporalDatePart(value: string): string {
  return value.includes('T') ? value.slice(0, value.indexOf('T')) : value
}

function validIsoDate(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!matched) {
    return false
  }

  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
}

function validIsoTime(value: string): boolean {
  const matched = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)

  if (!matched) {
    return false
  }

  const hours = Number(matched[1])
  const minutes = Number(matched[2])
  const seconds = matched[3] === undefined ? 0 : Number(matched[3])

  return hours <= 23 && minutes <= 59 && seconds <= 59
}

function validTemporalValue(base: 'date' | 'datetime' | 'time' | null, value: string): boolean {
  if (base === 'date') {
    return validIsoDate(value)
  }

  if (base === 'time') {
    return validIsoTime(value)
  }

  if (base === 'datetime') {
    const separator = value.indexOf('T')

    return (
      separator > 0 &&
      value.indexOf('T', separator + 1) === -1 &&
      validIsoDate(value.slice(0, separator)) &&
      validIsoTime(value.slice(separator + 1))
    )
  }

  return false
}

function isoDateDayNumber(value: string): number | null {
  if (!validIsoDate(value)) {
    return null
  }

  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0)

  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)

  return Math.floor(date.getTime() / 86_400_000)
}

function isoTimeSeconds(value: string): number | null {
  if (!validIsoTime(value)) {
    return null
  }

  const [hours, minutes, seconds = 0] = value.split(':').map(Number)

  return hours * 3600 + minutes * 60 + seconds
}

function temporalStepValue(
  base: 'date' | 'datetime' | 'time' | null,
  value: string
): number | null {
  if (base === 'date') {
    return isoDateDayNumber(value)
  }

  if (base === 'time') {
    return isoTimeSeconds(value)
  }

  if (base === 'datetime') {
    const separator = value.indexOf('T')
    const day = isoDateDayNumber(value.slice(0, separator))
    const seconds = isoTimeSeconds(value.slice(separator + 1))

    return day === null || seconds === null ? null : day * 86_400 + seconds
  }

  return null
}

function temporalStepMismatch(field: CollectField, value: string): boolean {
  const step = field.step

  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) {
    return false
  }

  const base = temporalBaseType(field.type)
  const numericValue = temporalStepValue(base, value)
  const numericMinimum = field.min ? temporalStepValue(base, field.min) : 0

  if (numericValue === null || numericMinimum === null) {
    return false
  }

  const quotient = (numericValue - numericMinimum) / step

  return Math.abs(quotient - Math.round(quotient)) > 1e-9
}

type SelectionState = Record<string, string[]>
type DraftState = Record<string, string>
type ValueState = Record<string, string>
type SkipState = Record<string, boolean>

interface CollectSubmittedDetail {
  label: string
  value: string
}

function withoutRecordKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  const next = { ...record }

  for (const key of keys) {
    delete next[key]
  }

  return next
}

function vaultKey(field: CollectField): string {
  return `${field.type}:${field.name}`
}

function luhnValid(digits: string): boolean {
  let sum = 0
  let doubleDigit = false

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48

    if (doubleDigit) {
      digit *= 2

      if (digit > 9) {
        digit -= 9
      }
    }

    sum += digit
    doubleDigit = !doubleDigit
  }

  return sum % 10 === 0
}

function cnIdValid(value: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(value)) {
    return false
  }

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const codes = '10X98765432'
  let sum = 0

  for (let index = 0; index < 17; index += 1) {
    sum += (value.charCodeAt(index) - 48) * weights[index]
  }

  return codes[sum % 11] === value[17].toUpperCase()
}

/** Returns a user-facing validation error, or null when valid. */
export function validateCollectField(field: CollectField, raw: string): null | string {
  const value = raw.trim()

  if (!value) {
    return field.required ? (field.type === 'consent' ? '请勾选同意' : '必填') : null
  }

  switch (field.type) {
    case 'date':

    case 'date_range':

    case 'datetime':

    case 'datetime_range':

    case 'time':
    case 'time_range': {
      const base = temporalBaseType(field.type)

      if (!validTemporalValue(base, value)) {
        return base === 'time'
          ? '请选择有效时间'
          : base === 'datetime'
            ? '请选择有效日期时间'
            : '请选择有效日期'
      }

      if (field.min && value < field.min) {return `不得早于 ${field.min}`}

      if (field.max && value > field.max) {return `不得晚于 ${field.max}`}

      if (temporalStepMismatch(field, value)) {
        return base === 'time'
          ? '请选择符合指定步长的时间'
          : base === 'datetime'
            ? '请选择符合指定步长的日期时间'
            : '请选择符合指定步长的日期'
      }

      if (base !== 'time') {
        const date = temporalDatePart(value)

        if (field.disabledDates?.includes(date)) {return '该日期不可选'}
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()

        if (field.disabledWeekdays?.includes(weekday)) {return '该星期日期不可选'}
      }

      return null
    }

    case 'phone': {
      const digits = value.replace(/\D/g, '')

      return /^\+?[\d\s().-]+$/.test(value) && digits.length >= 7 && digits.length <= 15
        ? null
        : '请输入有效的国际电话号码'
    }

    case 'otp':
      return /^[\dA-Za-z-]{4,12}$/.test(value) ? null : '验证码格式不正确'
    case 'credit_card': {
      const digits = value.replace(/[\s-]/g, '')

      return /^\d{13,19}$/.test(digits) && luhnValid(digits) ? null : '卡号无效（未通过校验）'
    }

    case 'id_number':
      if (/^\d{17}[\dXx]$/.test(value)) {
        return cnIdValid(value) ? null : '身份证号无效（校验位不符）'
      }

      return /^[\p{L}\d][\p{L}\d ._/-]{3,39}$/u.test(value) ? null : '证件号码格式不正确'

    case 'passport':
      return /^[A-Za-z0-9][A-Za-z0-9 ._-]{4,19}$/.test(value) ? null : '护照号码格式不正确'

    case 'document_number':
      return /^[\p{L}\d][\p{L}\d ._/-]{2,39}$/u.test(value) ? null : '证件号码格式不正确'

    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : '邮箱格式不正确'

    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value) ? null : '请输入数字'

    case 'select':
      return field.options?.includes(value) ? null : '请选择一个选项'

    case 'consent':
      return value === 'true' ? null : '请勾选同意'

    default:
      return null
  }
}

export function validateCollectFieldValues(
  field: CollectField,
  values: Record<string, string>
): Record<string, string> {
  const errors: Record<string, string> = {}
  const start = values[field.name] ?? ''
  const startError = validateCollectField(field, start)

  if (startError) {errors[field.name] = startError}

  if (field.endName) {
    const end = values[field.endName] ?? ''

    const endError = validateCollectField(
      {
        ...field,
        name: field.endName,
        label: field.endLabel || '结束',
        endName: undefined,
        min: start || field.min
      },
      end
    )

    if (endError) {errors[field.endName] = endError}

    if (Boolean(start.trim()) !== Boolean(end.trim())) {
      if (!start.trim()) {
        errors[field.name] = '请完整填写开始和结束'
      }

      if (!end.trim()) {
        errors[field.endName] = '请完整填写开始和结束'
      }
    }

    if (start.trim() && end.trim() && start > end) {
      errors[field.endName] = '结束时间不得早于开始时间'
    }
  }

  return errors
}

function syntheticQuestion(content: CollectContent): CollectQuestion {
  return {
    allowOther: true,
    choices: content.choices,
    dependsOn: null,
    fields: content.fields,
    id: LEGACY_QUESTION_ID,
    multiple: false,
    question: content.question,
    required: true
  }
}

function combineContent(primary: CollectContent, fallback?: CollectContent): CollectContent {
  return {
    choices: primary.choices ?? fallback?.choices ?? null,
    fields: primary.fields ?? fallback?.fields ?? null,
    question: primary.question || fallback?.question || '',
    questions: primary.questions ?? fallback?.questions ?? null,
    skipLabel: primary.skipLabel ?? fallback?.skipLabel ?? null,
    skippedLabel: primary.skippedLabel ?? fallback?.skippedLabel ?? null,
    submitLabel: primary.submitLabel ?? fallback?.submitLabel ?? null,
    submittedLabel: primary.submittedLabel ?? fallback?.submittedLabel ?? null
  }
}

function buildAnswers(
  questions: CollectQuestion[],
  selections: SelectionState,
  drafts: DraftState,
  values: ValueState,
  skipped: SkipState
): CollectAnswers {
  const answers: CollectAnswers = {}

  for (const question of questions) {
    if (skipped[question.id]) {
      answers[question.id] = { skipped: true }

      continue
    }

    const row: CollectAnswers[string] = {}
    const selected = selections[question.id] ?? []
    const draft = (drafts[question.id] ?? '').trim()

    if (question.choices) {
      const combined = [...selected]

      if (draft) {
        combined.push(draft)
      }

      if (combined.length > 0) {
        row.answer = question.multiple ? combined : combined[0]
      }
    } else if (!question.fields && draft) {
      row.answer = draft
    }

    if (question.fields) {
      const fieldValues: Record<string, string> = {}

      for (const field of question.fields) {
        for (const name of collectFieldValueNames(field)) {
          const value = (values[name] ?? '').trim()

          if (value) {
            fieldValues[name] = value
          }
        }
      }

      if (Object.keys(fieldValues).length > 0) {
        row.values = fieldValues
      }
    }

    if (row.answer !== undefined || row.values) {
      answers[question.id] = row
    }
  }

  return answers
}

function resultRecord(result: unknown): Record<string, unknown> | null {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }

  if (typeof result !== 'string' || !result.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(result)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function displayAnswer(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean).join('、')
  }

  return typeof value === 'string' ? value.trim() : ''
}

function submittedDetails(content: CollectContent, result: unknown): CollectSubmittedDetail[] {
  const record = resultRecord(result)

  if (!record) {
    return []
  }

  const details: CollectSubmittedDetail[] = []
  const seen = new Set<string>()

  const add = (label: string, value: string) => {
    const normalizedLabel = label.trim() || '已提交信息'
    const rawValue = value.trim()
    const normalizedValue = rawValue.startsWith('fan-value://') ? '已填写' : rawValue
    const key = `${normalizedLabel}\u0000${normalizedValue}`

    if (!normalizedValue || seen.has(key)) {
      return
    }

    seen.add(key)
    details.push({ label: normalizedLabel, value: normalizedValue })
  }

  const directAnswer = displayAnswer(record.user_response) || displayAnswer(record.answer)

  if (directAnswer) {
    add(content.question || String(record.question || ''), directAnswer)
  }

  const questions = content.questions ?? (content.question ? [syntheticQuestion(content)] : [])
  const questionsById = new Map(questions.map(question => [question.id, question]))

  const answers =
    record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)
      ? (record.answers as Record<string, unknown>)
      : {}

  for (const [questionId, rawAnswer] of Object.entries(answers)) {
    if (!rawAnswer || typeof rawAnswer !== 'object' || Array.isArray(rawAnswer)) {
      continue
    }

    const answer = rawAnswer as Record<string, unknown>
    const question = questionsById.get(questionId)
    const answerText = displayAnswer(answer.answer)

    if (answerText) {
      add(question?.question || content.question || '已提交信息', answerText)
    }

    const answerValues =
      answer.values && typeof answer.values === 'object' && !Array.isArray(answer.values)
        ? (answer.values as Record<string, unknown>)
        : {}

    for (const field of question?.fields ?? []) {
      if (collectFieldValueNames(field).some(name => String(answerValues[name] ?? '').trim())) {
        add(field.label, field.type === 'consent' ? '已同意' : field.type === 'file' ? '已选择文件' : '已填写')
      }
    }
  }

  const topLevelValues =
    record.values && typeof record.values === 'object' && !Array.isArray(record.values)
      ? (record.values as Record<string, unknown>)
      : {}

  for (const question of questions) {
    for (const field of question.fields ?? []) {
      if (collectFieldValueNames(field).some(name => String(topLevelValues[name] ?? '').trim())) {
        add(field.label, field.type === 'consent' ? '已同意' : field.type === 'file' ? '已选择文件' : '已填写')
      }
    }
  }

  return details
}

export function collectSettledLabel(status: string): string {
  switch (status) {
    case 'skipped':
      return '信息已跳过，未填写'

    case 'interrupted':
      return '信息收集已中断'

    case 'cancelled':
      return '信息收集已取消'

    case 'expired':
      return '信息收集已过期'

    case 'submitted':
      return '信息已提交'

    case 'failed':
      return '信息收集失败'

    default:
      return '信息收集已结束'
  }
}

function CollectSettledState({
  details = [],
  label,
  status,
  slot
}: {
  details?: CollectSubmittedDetail[]
  label?: string | null
  status: string
  slot: string
}) {
  const submitted = status === 'submitted'

  const statusContent = (
    <>
      {submitted && (
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-full bg-(--ui-green) text-white"
        >
          <Check className="size-3.5" />
        </span>
      )}
      <span className="text-[12.5px] font-medium text-(--bwa-text-secondary)">
        {label || collectSettledLabel(status)}
      </span>
    </>
  )

  if (submitted && details.length > 0) {
    return (
      <details className="lg-card group mb-3 mt-2 w-fit max-w-full" data-slot={slot}>
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2.5 px-3 py-2 [&::-webkit-details-marker]:hidden">
          {statusContent}
          <ChevronDown
            aria-hidden
            className="ml-0.5 size-3 shrink-0 text-(--bwa-text-muted) transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="mx-3 border-t border-(--lg-inset-stroke) pb-3 pt-2.5">
          <p className="mb-2 text-[10.5px] font-semibold text-(--bwa-text-muted)">已提交内容</p>
          <dl className="grid gap-2">
            {details.map(detail => (
              <div className="grid gap-0.5" key={`${detail.label}-${detail.value}`}>
                <dt className="text-[10.5px] leading-4 text-(--bwa-text-muted)">{detail.label}</dt>
                <dd className="wrap-anywhere text-[12px] leading-5 text-(--bwa-text)">{detail.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    )
  }

  return (
    <div
      className="lg-card mb-3 mt-2 inline-flex min-h-10 w-fit max-w-full items-center gap-2.5 px-3 py-2"
      data-slot={slot}
    >
      {statusContent}
    </div>
  )
}

export const CollectTool = (props: ToolCallMessagePartProps) => {
  if (props.result !== undefined) {
    const record = resultRecord(props.result)
    const explicitStatus = typeof record?.status === 'string' ? record.status : ''

    const status = COLLECT_LIFECYCLE_STATUSES.has(explicitStatus)
      ? explicitStatus
      : props.isError
        ? 'failed'
        : explicitStatus || 'submitted'

    if (status === 'interrupted') {
      return null
    }

    const content = parseCollectContent(props.args)
    const label = status === 'submitted' ? content.submittedLabel : status === 'skipped' ? content.skippedLabel : null

    return (
      <CollectSettledState
        details={status === 'submitted' ? submittedDetails(content, props.result) : []}
        label={label}
        slot="collect-settled"
        status={status}
      />
    )
  }

  return <CollectToolPending args={props.args} toolCallId={props.toolCallId} />
}

function CollectToolPending({ args, toolCallId }: Pick<ToolCallMessagePartProps, 'args' | 'toolCallId'>) {
  const requests = useStore($activeCollectRequests)
  const gateway = useStore($gateway)
  const fromArgs = useMemo(() => parseCollectContent(args), [args])

  const matchingRequest = useMemo(
    () => findCollectRequestForToolCall(requests, toolCallId, fromArgs.question),
    [fromArgs.question, requests, toolCallId]
  )

  const requestContent = useMemo(
    () => (matchingRequest ? parseCollectContent(matchingRequest) : undefined),
    [matchingRequest]
  )

  const content = useMemo(() => combineContent(fromArgs, requestContent), [fromArgs, requestContent])

  const questions = useMemo(
    () => content.questions ?? (content.question ? [syntheticQuestion(content)] : []),
    [content]
  )

  const allFields = useMemo(() => questions.flatMap(question => question.fields ?? []), [questions])
  const hasQuestionnaireShape = Boolean(content.questions)
  const multiStep = questions.length > 1

  const [selections, setSelections] = useState<SelectionState>({})
  const [drafts, setDrafts] = useState<DraftState>({})
  const [values, setValues] = useState<ValueState>({})
  const [skipped, setSkipped] = useState<SkipState>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [remember, setRemember] = useState<Record<string, boolean>>({})
  const [currentIndex, setCurrentIndex] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [settledStatus, setSettledStatus] = useState<string | null>(null)
  const [settledDetails, setSettledDetails] = useState<CollectSubmittedDetail[]>([])

  const answers = useMemo(
    () => buildAnswers(questions, selections, drafts, values, skipped),
    [drafts, questions, selections, skipped, values]
  )

  const visibleQuestions = useMemo(() => visibleCollectQuestions(questions, answers), [answers, questions])
  const currentQuestion = visibleQuestions[currentIndex]
  const ready = Boolean(matchingRequest?.requestId)

  const matchingRequestKey = matchingRequest?.requestId
    ? `${matchingRequest.sessionId ?? ''}\u0000${matchingRequest.requestId}`
    : null

  const activeRequestKeyRef = useRef<string | null>(matchingRequestKey)
  const settledRequestKeyRef = useRef<string | null>(null)
  const suppressedVaultPrefillNamesRef = useRef(new Set<string>())

  useEffect(() => {
    if (currentIndex >= visibleQuestions.length) {
      setCurrentIndex(Math.max(0, visibleQuestions.length - 1))
    }
  }, [currentIndex, visibleQuestions.length])

  useLayoutEffect(() => {
    const requestKey = matchingRequestKey

    activeRequestKeyRef.current = requestKey
    suppressedVaultPrefillNamesRef.current.clear()
    setSelections({})
    setDrafts({})
    setValues({})
    setSkipped({})
    setErrors({})
    setRevealed({})
    setRemember({})
    setCurrentIndex(0)
    setSubmitting(false)

    if (requestKey) {
      settledRequestKeyRef.current = null
      setSettledStatus(null)
      setSettledDetails([])
    }

    return () => {
      if (activeRequestKeyRef.current === requestKey) {
        activeRequestKeyRef.current = null
      }
    }
  }, [matchingRequestKey])

  // Reusable, low-risk values may be prefilled from the OS-keychain-encrypted
  // local vault. Saving remains explicit: every "记住" box defaults off.
  useEffect(() => {
    const requestKey = matchingRequestKey

    if (!requestKey || settledRequestKeyRef.current === requestKey) {
      return
    }

    const rememberable = allFields.filter(field => REMEMBERABLE_TYPES.has(field.type))

    if (rememberable.length === 0) {
      return
    }

    let alive = true
    void window.fanDesktop?.vault
      ?.get(rememberable.map(vaultKey))
      .then(stored => {
        if (
          !alive ||
          !stored ||
          activeRequestKeyRef.current !== requestKey ||
          settledRequestKeyRef.current === requestKey
        ) {
          return
        }

        setValues(previous => {
          if (
            !alive ||
            activeRequestKeyRef.current !== requestKey ||
            settledRequestKeyRef.current === requestKey
          ) {
            return previous
          }

          const next = { ...previous }

          for (const field of rememberable) {
            if (
              collectFieldValueNames(field).some(name =>
                suppressedVaultPrefillNamesRef.current.has(name)
              )
            ) {
              continue
            }

            const value = stored[vaultKey(field)]

            if (value && !next[field.name]) {
              next[field.name] = value
            }
          }

          return next
        })
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [allFields, matchingRequestKey])

  const clearQuestionError = useCallback((questionId: string) => {
    setSkipped(previous => {
      if (!previous[questionId]) {
        return previous
      }

      const next = { ...previous }
      delete next[questionId]

      return next
    })
    setErrors(previous => {
      const key = `${QUESTION_ERROR_PREFIX}${questionId}`

      if (!previous[key]) {
        return previous
      }

      const next = { ...previous }
      delete next[key]

      return next
    })
  }, [])

  const setValue = useCallback(
    (questionId: string, name: string, value: string) => {
      clearQuestionError(questionId)
      setValues(previous => ({ ...previous, [name]: value }))
      setErrors(previous => {
        if (!previous[name]) {
          return previous
        }

        const next = { ...previous }
        delete next[name]

        return next
      })
    },
    [clearQuestionError]
  )

  const setDraft = useCallback(
    (questionId: string, value: string) => {
      clearQuestionError(questionId)
      setDrafts(previous => ({ ...previous, [questionId]: value }))

      if (value.trim()) {
        const question = questions.find(item => item.id === questionId)

        if (question && !question.multiple) {
          setSelections(previous => ({ ...previous, [questionId]: [] }))
        }
      }
    },
    [clearQuestionError, questions]
  )

  const toggleChoice = useCallback(
    (question: CollectQuestion, choice: string) => {
      clearQuestionError(question.id)
      setSelections(previous => {
        const selected = previous[question.id] ?? []

        const next = question.multiple
          ? selected.includes(choice)
            ? selected.filter(value => value !== choice)
            : [...selected, choice]
          : [choice]

        return { ...previous, [question.id]: next }
      })

      if (!question.multiple) {
        setDrafts(previous => ({ ...previous, [question.id]: '' }))
      }
    },
    [clearQuestionError]
  )

  const pickFile = useCallback(
    async (question: CollectQuestion, field: CollectField) => {
      const paths = await window.fanDesktop?.selectPaths({ multiple: false, title: field.label }).catch(() => [])

      if (paths?.[0]) {
        setValue(question.id, field.name, paths[0])
      }
    },
    [setValue]
  )

  const questionHasInput = useCallback(
    (question: CollectQuestion): boolean => {
      if ((selections[question.id] ?? []).length > 0 || (drafts[question.id] ?? '').trim()) {
        return true
      }

      return (question.fields ?? []).some(field =>
        collectFieldValueNames(field).some(name => (values[name] ?? '').trim())
      )
    },
    [drafts, selections, values]
  )

  const validateQuestion = useCallback(
    (question: CollectQuestion, skippedState: SkipState): Record<string, string> => {
      if (skippedState[question.id] && !question.required) {
        return {}
      }

      const nextErrors: Record<string, string> = {}
      const hasInput = questionHasInput(question)

      if (!question.required && !hasInput) {
        return nextErrors
      }

      for (const field of question.fields ?? []) {
        Object.assign(nextErrors, validateCollectFieldValues(field, values))
      }

      const hasAnswer = (selections[question.id] ?? []).length > 0 || Boolean((drafts[question.id] ?? '').trim())

      if (question.required && (question.choices || !question.fields) && !hasAnswer) {
        nextErrors[`${QUESTION_ERROR_PREFIX}${question.id}`] = '请选择或填写一个答案'
      }

      return nextErrors
    },
    [drafts, questionHasInput, selections, values]
  )

  const persistRememberedValues = useCallback(
    (submittedValues: Record<string, string>) => {
      const entries: Record<string, string> = {}

      for (const field of allFields) {
        const value = submittedValues[field.name]

        if (value && REMEMBERABLE_TYPES.has(field.type) && remember[field.name]) {
          entries[vaultKey(field)] = value
        }
      }

      if (Object.keys(entries).length > 0) {
        void window.fanDesktop?.vault?.set(entries).catch(() => undefined)
      }
    },
    [allFields, remember]
  )

  const respond = useCallback(
    async (result: Record<string, unknown>) => {
      const requestKey = matchingRequestKey

      if (!ready || !matchingRequest || !requestKey) {
        notifyError(new Error('收集请求尚未就绪'), '无法发送收集响应')

        return
      }

      if (!gateway) {
        notifyError(new Error('Fan 网关未连接'), '无法发送收集响应')

        return
      }

      setSubmitting(true)

      try {
        const response = await gateway.request<{ accepted?: boolean; status?: string }>('collect.respond', {
          request_id: matchingRequest.requestId,
          session_id: matchingRequest.sessionId ?? '',
          result: JSON.stringify(result)
        })

        if (
          activeRequestKeyRef.current !== requestKey ||
          settledRequestKeyRef.current === requestKey
        ) {
          return
        }

        const requestedStatus = typeof result.status === 'string' ? result.status : 'submitted'
        const effectiveStatus = response.status || requestedStatus
        const safeDetails = effectiveStatus === 'submitted' ? submittedDetails(content, result) : []

        settledRequestKeyRef.current = requestKey
        setSettledStatus(effectiveStatus)
        setSettledDetails(safeDetails)
        setSelections({})
        setDrafts({})
        setValues({})
        setSkipped({})
        setErrors({})
        setRevealed({})
        setRemember({})
        setCurrentIndex(0)
        setSubmitting(false)
        triggerHaptic('submit')
        clearCollectRequest(matchingRequest.requestId, matchingRequest.sessionId)
      } catch (error) {
        if (
          activeRequestKeyRef.current !== requestKey ||
          settledRequestKeyRef.current === requestKey
        ) {
          return
        }

        notifyError(error, '无法发送收集响应')
        setSubmitting(false)
      }
    },
    [content, gateway, matchingRequest, matchingRequestKey, ready]
  )

  const submitAll = useCallback(
    (skippedOverride: SkipState = skipped) => {
      const currentAnswers = buildAnswers(questions, selections, drafts, values, skippedOverride)
      const activeQuestions = visibleCollectQuestions(questions, currentAnswers)
      const nextErrors: Record<string, string> = {}
      let firstInvalid = -1

      activeQuestions.forEach((question, index) => {
        const questionErrors = validateQuestion(question, skippedOverride)

        if (Object.keys(questionErrors).length > 0 && firstInvalid < 0) {
          firstInvalid = index
        }

        Object.assign(nextErrors, questionErrors)
      })

      if (firstInvalid >= 0) {
        setErrors(nextErrors)
        setCurrentIndex(firstInvalid)

        return
      }

      const activeAnswers = activeCollectAnswers(questions, currentAnswers)

      const allActiveQuestionsSkipped =
        activeQuestions.length > 0 && activeQuestions.every(question => activeAnswers[question.id]?.skipped === true)

      if (allActiveQuestionsSkipped) {
        void respond({ answer: '', answers: {}, skipped: true, status: 'skipped', values: {} })

        return
      }

      const flatValues: Record<string, string> = {}

      for (const row of Object.values(activeAnswers)) {
        Object.assign(flatValues, row.values ?? {})
      }

      const legacyAnswer = activeAnswers[LEGACY_QUESTION_ID]?.answer
      const answer = Array.isArray(legacyAnswer) ? legacyAnswer.join('；') : legacyAnswer ?? ''

      persistRememberedValues(flatValues)
      void respond({
        answer,
        answers: activeAnswers,
        skipped: false,
        status: 'submitted',
        values: flatValues
      })
    },
    [drafts, persistRememberedValues, questions, respond, selections, skipped, validateQuestion, values]
  )

  const goNext = useCallback(() => {
    if (!currentQuestion || submitting) {
      return
    }

    const nextErrors = validateQuestion(currentQuestion, skipped)

    if (Object.keys(nextErrors).length > 0) {
      setErrors(previous => ({ ...previous, ...nextErrors }))

      return
    }

    if (currentIndex >= visibleQuestions.length - 1) {
      submitAll()
    } else {
      setCurrentIndex(index => index + 1)
    }
  }, [currentIndex, currentQuestion, skipped, submitAll, submitting, validateQuestion, visibleQuestions.length])

  const skipCurrent = useCallback(() => {
    if (!currentQuestion || currentQuestion.required || submitting) {
      return
    }

    const nextSkipped = { ...skipped, [currentQuestion.id]: true }
    const nextAnswers = buildAnswers(questions, selections, drafts, values, nextSkipped)
    const nextIndex = nextVisibleCollectQuestionIndex(questions, nextAnswers, currentQuestion.id)
    const fieldNames = (currentQuestion.fields ?? []).flatMap(collectFieldValueNames)

    for (const name of fieldNames) {
      suppressedVaultPrefillNamesRef.current.add(name)
    }

    setSkipped(nextSkipped)
    setSelections(previous => withoutRecordKeys(previous, [currentQuestion.id]))
    setDrafts(previous => withoutRecordKeys(previous, [currentQuestion.id]))
    setValues(previous => withoutRecordKeys(previous, fieldNames))
    setErrors(previous =>
      withoutRecordKeys(previous, [`${QUESTION_ERROR_PREFIX}${currentQuestion.id}`, ...fieldNames])
    )
    setRevealed(previous => withoutRecordKeys(previous, fieldNames))
    setRemember(previous => withoutRecordKeys(previous, fieldNames))

    if (nextIndex === null) {
      submitAll(nextSkipped)
    } else {
      setCurrentIndex(nextIndex)
    }
  }, [currentQuestion, drafts, questions, selections, skipped, submitAll, submitting, values])

  const handleShortcut = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        goNext()
      }
    },
    [goNext]
  )

  if (settledStatus) {
    const label =
      settledStatus === 'submitted'
        ? content.submittedLabel
        : settledStatus === 'skipped'
          ? content.skippedLabel
          : null

    if (settledStatus === 'interrupted') {
      return null
    }

    return (
      <CollectSettledState
        details={settledStatus === 'submitted' ? settledDetails : []}
        label={label}
        slot="collect-inline"
        status={settledStatus}
      />
    )
  }

  if (!currentQuestion) {
    return (
      <div
        aria-live="polite"
        className="lg-card mb-3 mt-2 flex items-center gap-2 px-4 py-3"
        data-slot="collect-inline"
        role="status"
      >
        {!ready && <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-(--bwa-text-muted)" />}
        <span className="text-[12.5px] text-(--bwa-text-muted)">
          {ready ? '表单加载失败' : '正在准备表单…'}
        </span>
      </div>
    )
  }

  const selected = selections[currentQuestion.id] ?? []
  const questionError = errors[`${QUESTION_ERROR_PREFIX}${currentQuestion.id}`]
  const isLast = currentIndex === visibleQuestions.length - 1

  return (
    <div className="lg-card mb-3 mt-2 flex flex-col gap-3 p-4 text-sm" data-slot="collect-inline">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {hasQuestionnaireShape && content.question && content.question !== currentQuestion.question && (
            <p className="mb-1 whitespace-pre-wrap text-[12px] font-semibold leading-5 text-(--bwa-text-secondary)">
              {content.question}
            </p>
          )}
          <p className="whitespace-pre-wrap text-[13px] font-semibold leading-5 text-(--bwa-text)">
            {currentQuestion.question}
          </p>
          {currentQuestion.description && (
            <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-[1.45] text-(--bwa-text-muted)">
              {currentQuestion.description}
            </p>
          )}
        </div>
        {multiStep && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-(--bwa-text-muted)">
            {currentIndex + 1}/{visibleQuestions.length}
          </span>
        )}
      </div>

      {currentQuestion.choices && (
        <div
          aria-label={currentQuestion.question}
          className="flex flex-col gap-1.5"
          role={currentQuestion.multiple ? 'group' : 'radiogroup'}
        >
          {currentQuestion.choices.map((choice, index) => {
            const isSelected = selected.includes(choice)

            return (
              <button
                aria-checked={isSelected}
                className={cn(
                  'flex min-h-9 items-center gap-[9px] rounded-[12px] border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                  isSelected
                    ? 'border-[color:color-mix(in_srgb,var(--lg-accent)_30%,transparent)] bg-(--bwa-primary-soft) shadow-(--lg-inset-highlight)'
                    : 'border-(--lg-inset-stroke) bg-(--lg-inset-fill) shadow-(--lg-inset-highlight) hover:bg-(--lg-inset-fill-strong)'
                )}
                disabled={!ready || submitting}
                key={`${index}-${choice}`}
                onClick={() => toggleChoice(currentQuestion, choice)}
                role={currentQuestion.multiple ? 'checkbox' : 'radio'}
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid size-[16px] shrink-0 place-items-center border-[1.5px]',
                    currentQuestion.multiple ? 'rounded-[5px]' : 'rounded-full',
                    isSelected
                      ? 'border-(--lg-accent) bg-(--lg-accent)'
                      : 'border-(--lg-radio-stroke) bg-(--lg-inset-fill-strong)'
                  )}
                >
                  {isSelected &&
                    (currentQuestion.multiple ? (
                      <Check className="size-2.5 text-white" />
                    ) : (
                      <span className="size-[5px] rounded-full bg-white" />
                    ))}
                </span>
                <span
                  className={cn(
                    'wrap-anywhere text-[12.5px]',
                    isSelected ? 'font-semibold text-(--lg-accent)' : 'font-normal text-(--bwa-text)'
                  )}
                >
                  {choice}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {currentQuestion.fields && (
        <div className="flex flex-col gap-2.5">
          {currentQuestion.fields.map(field => {
            const value = values[field.name] ?? ''
            const error = errors[field.name]
            const endValue = field.endName ? values[field.endName] ?? '' : ''
            const endError = field.endName ? errors[field.endName] : undefined
            const sensitive = SENSITIVE_TYPES.has(field.type)
            const masked = sensitive && !revealed[field.name]
            const rememberable = REMEMBERABLE_TYPES.has(field.type)

            return (
              <div className="flex flex-col gap-[5px]" key={field.name}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold text-(--bwa-text-secondary)">
                    {field.label}
                    {field.required && <span className="ml-0.5 text-(--ui-red)">*</span>}
                  </span>
                  {rememberable && (
                    <label
                      className="flex cursor-pointer items-center gap-1 text-[10.5px] text-(--bwa-text-muted)"
                      title="仅安全保存在本机"
                    >
                      <input
                        checked={remember[field.name] === true}
                        className="size-3 accent-(--lg-accent)"
                        onChange={event =>
                          setRemember(previous => ({ ...previous, [field.name]: event.target.checked }))
                        }
                        type="checkbox"
                      />
                      下次自动填写
                    </label>
                  )}
                </div>

                {field.type === 'select' ? (
                  <div className="relative">
                    <select
                      aria-invalid={error ? true : undefined}
                      aria-label={field.label}
                      className={cn(INPUT_CLASS, 'appearance-none pr-8', !value && 'text-(--bwa-text-muted)')}
                      disabled={submitting || !field.options?.length}
                      onChange={event => setValue(currentQuestion.id, field.name, event.target.value)}
                      value={value}
                    >
                      <option disabled value="">
                        {field.placeholder || '请选择…'}
                      </option>
                      {(field.options ?? []).map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <ChevronDown
                      aria-hidden
                      className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-(--bwa-text-muted)"
                    />
                  </div>
                ) : field.type === 'file' ? (
                  <button
                    aria-invalid={error ? true : undefined}
                    className={cn(INPUT_CLASS, 'flex items-center gap-2 text-left', !value && 'text-(--bwa-text-muted)')}
                    disabled={submitting}
                    onClick={() => void pickFile(currentQuestion, field)}
                    type="button"
                  >
                    <FolderOpen aria-hidden className="size-3.5 shrink-0 text-(--bwa-text-secondary)" />
                    <span className="min-w-0 flex-1 truncate">
                      {value ? value.split(/[\\/]/).pop() : field.placeholder || '选择文件…'}
                    </span>
                  </button>
                ) : field.type === 'consent' ? (
                  <label className="lg-input flex cursor-pointer items-start gap-2 px-3 py-2 text-[12px] leading-5 text-(--bwa-text)">
                    <input
                      checked={value === 'true'}
                      className="mt-0.5 size-3.5 shrink-0 accent-(--lg-accent)"
                      disabled={submitting}
                      onChange={event => setValue(currentQuestion.id, field.name, event.target.checked ? 'true' : '')}
                      type="checkbox"
                    />
                    <span>{field.placeholder || field.label}</span>
                  </label>
                ) : TEMPORAL_TYPES.has(field.type) ? (
                  <div className="flex flex-col gap-1.5">
                    <div className={cn('grid gap-2', field.endName && 'grid-cols-2')}>
                      <div className="flex min-w-0 flex-col gap-1">
                        {field.endName && (
                          <span className="text-[10.5px] text-(--bwa-text-muted)">开始</span>
                        )}
                        {temporalBaseType(field.type) === 'date' ? (
                          <CollectDatePicker
                            ariaInvalid={Boolean(error)}
                            ariaLabel={field.endName ? `${field.label}开始` : field.label}
                            disabled={submitting}
                            disabledDates={field.disabledDates}
                            disabledWeekdays={field.disabledWeekdays}
                            max={field.max}
                            min={field.min}
                            onChange={nextValue =>
                              setValue(currentQuestion.id, field.name, nextValue)
                            }
                            onKeyDown={handleShortcut}
                            placeholder={field.placeholder}
                            step={field.step}
                            value={value}
                          />
                        ) : (
                          <input
                            aria-invalid={error ? true : undefined}
                            aria-label={field.endName ? `${field.label}开始` : field.label}
                            className={INPUT_CLASS}
                            disabled={submitting}
                            max={field.max}
                            min={field.min}
                            onChange={event => setValue(currentQuestion.id, field.name, event.target.value)}
                            onClick={event => event.currentTarget.showPicker?.()}
                            onKeyDown={handleShortcut}
                            step={field.step}
                            type={temporalInputType(field)}
                            value={value}
                          />
                        )}
                        {error && <span className="text-[10.5px] text-(--ui-red)">{error}</span>}
                      </div>
                      {field.endName && (
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="text-[10.5px] text-(--bwa-text-muted)">
                            {field.endLabel || '结束'}
                          </span>
                          {temporalBaseType(field.type) === 'date' ? (
                            <CollectDatePicker
                              ariaInvalid={Boolean(endError)}
                              ariaLabel={field.endLabel || `${field.label}结束`}
                              disabled={submitting}
                              disabledDates={field.disabledDates}
                              disabledWeekdays={field.disabledWeekdays}
                              max={field.max}
                              min={value || field.min}
                              onChange={nextValue =>
                                setValue(currentQuestion.id, field.endName!, nextValue)
                              }
                              onKeyDown={handleShortcut}
                              step={field.step}
                              value={endValue}
                            />
                          ) : (
                            <input
                              aria-invalid={endError ? true : undefined}
                              aria-label={field.endLabel || `${field.label}结束`}
                              className={INPUT_CLASS}
                              disabled={submitting}
                              max={field.max}
                              min={value || field.min}
                              onChange={event => setValue(currentQuestion.id, field.endName!, event.target.value)}
                              onClick={event => event.currentTarget.showPicker?.()}
                              onKeyDown={handleShortcut}
                              step={field.step}
                              type={temporalInputType(field)}
                              value={endValue}
                            />
                          )}
                          {endError && <span className="text-[10.5px] text-(--ui-red)">{endError}</span>}
                        </div>
                      )}
                    </div>
                    {field.timezone && (
                      <span className="text-[10px] text-(--bwa-text-muted)">时区：{field.timezone}</span>
                    )}
                  </div>
                ) : field.type === 'textarea' || field.type === 'address' ? (
                  <textarea
                    aria-invalid={error ? true : undefined}
                    className={cn(INPUT_CLASS, 'min-h-[68px] resize-y')}
                    disabled={submitting}
                    onChange={event => setValue(currentQuestion.id, field.name, event.target.value)}
                    onKeyDown={handleShortcut}
                    placeholder={field.placeholder || field.label}
                    value={value}
                  />
                ) : (
                  <div className="relative">
                    <input
                      aria-invalid={error ? true : undefined}
                      autoComplete={
                        field.type === 'otp'
                          ? 'one-time-code'
                          : field.type === 'credit_card'
                            ? 'cc-number'
                            : sensitive
                              ? 'off'
                              : undefined
                      }
                      className={cn(
                        INPUT_CLASS,
                        sensitive && 'pr-9',
                        (field.type === 'otp' || field.type === 'captcha') && 'font-mono tracking-[0.12em]'
                      )}
                      disabled={submitting}
                      inputMode={
                        field.type === 'phone'
                          ? 'tel'
                          : field.type === 'number' || field.type === 'credit_card' || field.type === 'otp'
                            ? 'decimal'
                            : field.type === 'email'
                              ? 'email'
                              : undefined
                      }
                      onChange={event => setValue(currentQuestion.id, field.name, event.target.value)}
                      onKeyDown={handleShortcut}
                      placeholder={field.placeholder || field.label}
                      type={
                        masked
                          ? 'password'
                          : field.type === 'date'
                            ? 'date'
                            : field.type === 'email'
                              ? 'email'
                              : field.type === 'phone'
                                ? 'tel'
                                : 'text'
                      }
                      value={value}
                    />
                    {sensitive && (
                      <button
                        aria-label={masked ? '显示' : '隐藏'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-(--bwa-text-muted) transition-colors hover:text-(--bwa-text)"
                        onClick={() =>
                          setRevealed(previous => ({ ...previous, [field.name]: !previous[field.name] }))
                        }
                        tabIndex={-1}
                        type="button"
                      >
                        {masked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                      </button>
                    )}
                  </div>
                )}

                {error && !TEMPORAL_TYPES.has(field.type) && (
                  <span className="text-[11px] text-(--ui-red)">{error}</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {((!currentQuestion.fields && !currentQuestion.choices) ||
        (Boolean(currentQuestion.choices) && currentQuestion.allowOther)) && (
          <div className="flex flex-col gap-[5px]">
            {currentQuestion.choices && (
              <span className="text-[11px] font-semibold text-(--bwa-text-secondary)">其他答案</span>
            )}
            <textarea
              className={cn(INPUT_CLASS, 'min-h-[58px] resize-y')}
              disabled={submitting}
              onChange={event => setDraft(currentQuestion.id, event.target.value)}
              onKeyDown={handleShortcut}
              placeholder={currentQuestion.choices ? '如果有其他诉求，可以在这里告诉我' : '请输入你的答案'}
              value={drafts[currentQuestion.id] ?? ''}
            />
          </div>
        )}

      {questionError && <span className="text-[11px] text-(--ui-red)">{questionError}</span>}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-[3px]">
        {multiStep && currentIndex > 0 ? (
          <button
            className="lg-btn text-[11.5px] font-medium text-(--bwa-text-secondary) disabled:cursor-not-allowed disabled:opacity-45"
            disabled={!ready || submitting}
            onClick={() => setCurrentIndex(index => Math.max(0, index - 1))}
            type="button"
          >
            <ChevronLeft aria-hidden className="size-3" />
            上一步
          </button>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {!currentQuestion.required && (
            <button
              className="lg-btn text-[11.5px] font-medium text-(--bwa-text-secondary) disabled:cursor-not-allowed disabled:opacity-55"
              disabled={!ready || submitting}
              onClick={skipCurrent}
              type="button"
            >
              {content.skipLabel || (multiStep ? '跳过本题' : '跳过')}
            </button>
          )}
          <button
            className="lg-btn-primary min-w-[92px] max-w-full whitespace-normal text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!ready || submitting}
            onClick={goNext}
            type="button"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <>
                {isLast
                  ? content.submitLabel || (multiStep ? '提交全部回答' : '提交')
                  : '下一步'}
                {!isLast && <ChevronRight aria-hidden className="size-3" />}
              </>
            )}
          </button>
        </div>
      </div>

      {multiStep && (
        <button
          className="self-center text-[10.5px] text-(--bwa-text-muted) transition-colors hover:text-(--bwa-text-secondary) disabled:opacity-50"
          disabled={!ready || submitting}
          onClick={() =>
            void respond({ answer: '', answers: {}, skipped: true, status: 'skipped', values: {} })
          }
          type="button"
        >
          取消填写
        </button>
      )}
    </div>
  )
}
