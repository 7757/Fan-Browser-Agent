import { atom, computed } from 'nanostores'

import { $activeSessionId } from './session'

// Unified info-collection prompt. Requests are parked per session so a
// background turn can wait without losing its form when the user switches
// conversations or reloads the renderer.

export type CollectFieldType =
  | 'address'
  | 'captcha'
  | 'consent'
  | 'country'
  | 'credit_card'
  | 'date'
  | 'date_range'
  | 'datetime'
  | 'datetime_range'
  | 'document_number'
  | 'email'
  | 'file'
  | 'id_number'
  | 'number'
  | 'otp'
  | 'passport'
  | 'phone'
  | 'secret'
  | 'select'
  | 'text'
  | 'textarea'
  | 'time'
  | 'time_range'

export interface CollectField {
  name: string
  label: string
  type: CollectFieldType
  required: boolean
  placeholder?: string
  options?: string[]
  endName?: string
  endLabel?: string
  min?: string
  max?: string
  step?: number
  timezone?: string
  disabledDates?: string[]
  disabledWeekdays?: number[]
}

export type CollectConditionOperator = 'equals' | 'includes' | 'not_empty' | 'not_equals'

export interface CollectCondition {
  operator: CollectConditionOperator
  questionId: string
  value?: string
}

export interface CollectQuestion {
  allowOther: boolean
  choices: string[] | null
  dependsOn: CollectCondition | null
  description?: string
  fields: CollectField[] | null
  id: string
  multiple: boolean
  question: string
  required: boolean
}

export interface CollectQuestionAnswer {
  answer?: string | string[]
  skipped?: boolean
  values?: Record<string, string>
}

export type CollectAnswers = Record<string, CollectQuestionAnswer>

export interface CollectContent {
  choices: string[] | null
  fields: CollectField[] | null
  question: string
  questions: CollectQuestion[] | null
  skipLabel: string | null
  skippedLabel: string | null
  submitLabel: string | null
  submittedLabel: string | null
}

export interface CollectRequest {
  requestId: string
  toolCallId?: string | null
  question: string
  choices: string[] | null
  fields: CollectField[] | null
  questions: CollectQuestion[] | null
  sessionId: string | null
  skipLabel: string | null
  skippedLabel: string | null
  submitLabel: string | null
  submittedLabel: string | null
}

const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

const $collectRequests = atom<Record<string, CollectRequest[]>>({})

export const $activeCollectRequests = computed(
  [$collectRequests, $activeSessionId],
  (requests, activeId) => requests[keyFor(activeId)] ?? []
)

export const $collectRequest = computed($activeCollectRequests, requests => requests[0] ?? null)

export function findCollectRequestForToolCall(
  requests: readonly CollectRequest[],
  toolCallId: string | undefined,
  question: string
): CollectRequest | null {
  const exact = toolCallId
    ? requests.find(request => request.toolCallId === toolCallId)
    : undefined

  if (exact) {
    return exact
  }

  // Older gateways did not publish tool_call_id. Falling back is safe only
  // when both sides lack an id and there is exactly one request; otherwise
  // repeated questions could make concurrent cards share the queue head.
  if (toolCallId || requests.length !== 1 || requests[0]?.toolCallId) {
    return null
  }

  const [legacy] = requests

  return question && legacy.question && question !== legacy.question ? null : legacy
}

export function setCollectRequest(request: CollectRequest): void {
  const key = keyFor(request.sessionId)
  const requests = $collectRequests.get()
  const queue = requests[key] ?? []

  if (queue.some(item => item.requestId === request.requestId)) {
    return
  }

  $collectRequests.set({ ...requests, [key]: [...queue, request] })
}

export function clearCollectRequest(requestId?: string, sessionId?: string | null): void {
  const requests = $collectRequests.get()

  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const queue = requests[key] ?? []
    const remaining = requestId ? queue.filter(item => item.requestId !== requestId) : []
    const next = { ...requests }

    if (remaining.length) {
      next[key] = remaining
    } else {
      delete next[key]
    }

    $collectRequests.set(next)

    return
  }

  if (!requestId) {
    $collectRequests.set({})

    return
  }

  const next = Object.fromEntries(
    Object.entries(requests)
      .map(([key, queue]) => [key, queue.filter(item => item.requestId !== requestId)] as const)
      .filter(([, queue]) => queue.length)
  )

  $collectRequests.set(next)
}

export function hasCollectRequest(sessionId: string | null | undefined): boolean {
  return ($collectRequests.get()[keyFor(sessionId)]?.length ?? 0) > 0
}

const FIELD_TYPES: readonly CollectFieldType[] = [
  'address',
  'captcha',
  'consent',
  'country',
  'credit_card',
  'date',
  'date_range',
  'datetime',
  'datetime_range',
  'document_number',
  'email',
  'file',
  'id_number',
  'number',
  'otp',
  'passport',
  'phone',
  'secret',
  'select',
  'text',
  'textarea',
  'time',
  'time_range'
]

const RANGE_FIELD_TYPES: readonly CollectFieldType[] = ['date_range', 'datetime_range', 'time_range']

const CONDITION_OPERATORS: readonly CollectConditionOperator[] = ['equals', 'includes', 'not_empty', 'not_equals']

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const items = value.map(nonEmptyString).filter(Boolean)

  return items.length > 0 ? items : null
}

function weekdayList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const days = Array.from(
    new Set(
      value
        .map(day => Number(day))
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    )
  )

  return days.length > 0 ? days : undefined
}

export function collectFieldValueNames(field: CollectField): string[] {
  return field.endName ? [field.name, field.endName] : [field.name]
}

/** Sanitize the raw gateway payload's `fields` array into typed CollectFields. */
export function parseCollectFields(raw: unknown): CollectField[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const fields: CollectField[] = []

  for (const item of raw) {
    const row = record(item)

    if (!row) {
      continue
    }

    const name = nonEmptyString(row.name)

    if (!name) {
      continue
    }

    const type = FIELD_TYPES.includes(row.type as CollectFieldType) ? (row.type as CollectFieldType) : 'text'
    const options = stringList(row.options) ?? undefined

    const endName = RANGE_FIELD_TYPES.includes(type)
      ? nonEmptyString(row.end_name ?? row.endName)
      : ''

    const stepValue = Number(row.step)
    const disabledDates = stringList(row.disabled_dates ?? row.disabledDates) ?? undefined
    const disabledWeekdays = weekdayList(row.disabled_weekdays ?? row.disabledWeekdays)

    fields.push({
      name,
      label: nonEmptyString(row.label) || name,
      type,
      required: row.required !== false,
      ...(nonEmptyString(row.placeholder) ? { placeholder: nonEmptyString(row.placeholder) } : {}),
      ...(options && options.length > 0 ? { options } : {}),
      ...(endName ? { endName } : {}),
      ...(endName && nonEmptyString(row.end_label ?? row.endLabel)
        ? { endLabel: nonEmptyString(row.end_label ?? row.endLabel) }
        : {}),
      ...(nonEmptyString(row.min) ? { min: nonEmptyString(row.min) } : {}),
      ...(nonEmptyString(row.max) ? { max: nonEmptyString(row.max) } : {}),
      ...(Number.isFinite(stepValue) && stepValue > 0 ? { step: stepValue } : {}),
      ...(nonEmptyString(row.timezone) ? { timezone: nonEmptyString(row.timezone) } : {}),
      ...(disabledDates ? { disabledDates } : {}),
      ...(disabledWeekdays ? { disabledWeekdays } : {})
    })
  }

  return fields.length > 0 ? fields : null
}

/** Sanitize the gateway/tool payload's sequential questionnaire definition. */
export function parseCollectQuestions(raw: unknown): CollectQuestion[] | null {
  if (!Array.isArray(raw)) {
    return null
  }

  const questions: CollectQuestion[] = []
  const knownIds = new Set<string>()

  for (const item of raw) {
    const row = record(item)

    if (!row) {
      continue
    }

    const id = nonEmptyString(row.id)
    const question = nonEmptyString(row.question) || nonEmptyString(row.label)

    if (!id || !question || knownIds.has(id)) {
      continue
    }

    let dependsOn: CollectCondition | null = null
    const rawCondition = record(row.depends_on ?? row.dependsOn)

    if (rawCondition) {
      const questionId = nonEmptyString(rawCondition.question_id ?? rawCondition.questionId)
      const operator = nonEmptyString(rawCondition.operator) as CollectConditionOperator
      const value = nonEmptyString(rawCondition.value)

      // Conditions are intentionally limited to earlier steps. Ignoring an
      // invalid/future condition here would expose fields the model intended
      // to hide, so drop the malformed question instead.
      if (!knownIds.has(questionId) || !CONDITION_OPERATORS.includes(operator)) {
        continue
      }

      if (operator !== 'not_empty' && !value) {
        continue
      }

      dependsOn = {
        operator,
        questionId,
        ...(value ? { value } : {})
      }
    }

    questions.push({
      // Finite choices are closed unless the caller explicitly allows a
      // free-text value outside the declared set.
      allowOther: row.allow_other === true || row.allowOther === true,
      choices: stringList(row.choices),
      dependsOn,
      ...(nonEmptyString(row.description) ? { description: nonEmptyString(row.description) } : {}),
      fields: parseCollectFields(row.fields),
      id,
      multiple: row.multiple === true,
      question,
      required: row.required !== false
    })
    knownIds.add(id)
  }

  return questions.length > 0 ? questions : null
}

export function parseCollectContent(raw: unknown): CollectContent {
  const row = record(raw) ?? {}

  return {
    choices: stringList(row.choices),
    fields: parseCollectFields(row.fields),
    question: nonEmptyString(row.question),
    questions: parseCollectQuestions(row.questions),
    skipLabel: nonEmptyString(row.skip_label ?? row.skipLabel) || null,
    skippedLabel: nonEmptyString(row.skipped_label ?? row.skippedLabel) || null,
    submitLabel: nonEmptyString(row.submit_label ?? row.submitLabel) || null,
    submittedLabel: nonEmptyString(row.submitted_label ?? row.submittedLabel) || null
  }
}

export function collectConditionMatches(condition: CollectCondition, answers: CollectAnswers): boolean {
  const previous = answers[condition.questionId]
  const rawAnswer = previous?.answer
  const answerValues = Array.isArray(rawAnswer) ? rawAnswer : rawAnswer ? [rawAnswer] : []
  const values = answerValues.map(value => value.trim()).filter(Boolean)
  const expected = condition.value ?? ''

  switch (condition.operator) {
    case 'not_empty':
      return values.length > 0 || Object.values(previous?.values ?? {}).some(value => value.trim().length > 0)

    case 'includes':
      return values.includes(expected)

    case 'not_equals':
      return values.length > 0 && !values.includes(expected)

    default:
      return values.includes(expected)
  }
}

export function visibleCollectQuestions(questions: CollectQuestion[], answers: CollectAnswers): CollectQuestion[] {
  const visible: CollectQuestion[] = []
  const visibleIds = new Set<string>()

  for (const question of questions) {
    const condition = question.dependsOn

    if (
      condition &&
      (!visibleIds.has(condition.questionId) || !collectConditionMatches(condition, answers))
    ) {
      continue
    }

    visible.push(question)
    visibleIds.add(question.id)
  }

  return visible
}

/** Return the next visible step after `currentQuestionId`, or null when done. */
export function nextVisibleCollectQuestionIndex(
  questions: CollectQuestion[],
  answers: CollectAnswers,
  currentQuestionId: string
): number | null {
  const visible = visibleCollectQuestions(questions, answers)
  const currentIndex = visible.findIndex(question => question.id === currentQuestionId)

  return currentIndex >= 0 && currentIndex < visible.length - 1 ? currentIndex + 1 : null
}

export function activeCollectAnswers(questions: CollectQuestion[], answers: CollectAnswers): CollectAnswers {
  const activeIds = new Set(visibleCollectQuestions(questions, answers).map(question => question.id))

  return Object.fromEntries(Object.entries(answers).filter(([questionId]) => activeIds.has(questionId)))
}
