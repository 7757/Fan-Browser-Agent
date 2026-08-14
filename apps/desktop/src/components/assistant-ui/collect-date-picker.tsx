'use client'

import { type KeyboardEventHandler, useMemo, useState } from 'react'

import { Calendar, ChevronLeft, ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../ui/popover'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

interface DateParts {
  day: number
  month: number
  year: number
}

export interface CollectDatePickerProps {
  ariaInvalid?: boolean
  ariaLabel: string
  disabled?: boolean
  disabledDates?: string[]
  disabledWeekdays?: number[]
  max?: string
  min?: string
  onChange: (value: string) => void
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  placeholder?: string
  step?: number
  value: string
}

interface CollectDateConstraints {
  disabledDates?: readonly string[]
  disabledWeekdays?: readonly number[]
  max?: string
  min?: string
  step?: number
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toIsoDate(parts: DateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${pad(parts.month + 1)}-${pad(parts.day)}`
}

function localDate(parts: DateParts): Date {
  const date = new Date(0)

  date.setHours(0, 0, 0, 0)
  date.setFullYear(parts.year, parts.month, parts.day)

  return date
}

function parseIsoDate(value?: string): DateParts | null {
  const matched = DATE_PATTERN.exec(value ?? '')

  if (!matched) {
    return null
  }

  const year = Number(matched[1])
  const month = Number(matched[2]) - 1
  const day = Number(matched[3])
  const date = localDate({ day, month, year })

  return year > 0 && date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? { day, month, year }
    : null
}

export function isValidCollectIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null
}

function todayParts(): DateParts {
  const date = new Date()

  return { day: date.getDate(), month: date.getMonth(), year: date.getFullYear() }
}

function compareDates(left: DateParts, right: DateParts): number {
  return toIsoDate(left).localeCompare(toIsoDate(right))
}

function dayNumber(parts: DateParts): number {
  const date = new Date(0)

  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(parts.year, parts.month, parts.day)

  return Math.floor(date.getTime() / 86_400_000)
}

function datePartsDisabled(
  day: DateParts,
  { disabledDates, disabledWeekdays, max, min, step }: CollectDateConstraints
): boolean {
  const minimum = parseIsoDate(min)
  const maximum = parseIsoDate(max)
  const isoDate = toIsoDate(day)
  const stepBase = minimum ?? { day: 1, month: 0, year: 1970 }
  const stepOffset = dayNumber(day) - dayNumber(stepBase)

  const stepMismatch =
    typeof step === 'number' &&
    Number.isFinite(step) &&
    step > 0 &&
    Math.abs(stepOffset / step - Math.round(stepOffset / step)) > 1e-9

  return (
    day.year < 1 ||
    day.year > 9999 ||
    (minimum ? compareDates(day, minimum) < 0 : false) ||
    (maximum ? compareDates(day, maximum) > 0 : false) ||
    stepMismatch ||
    (disabledDates?.includes(isoDate) ?? false) ||
    (disabledWeekdays?.includes(localDate(day).getDay()) ?? false)
  )
}

export function isCollectDateDisabled(value: string, constraints: CollectDateConstraints): boolean {
  const day = parseIsoDate(value)

  return day === null || datePartsDisabled(day, constraints)
}

function initialMonth(value: string, min?: string, max?: string): DateParts {
  const selected = parseIsoDate(value)
  const minimum = parseIsoDate(min)
  const maximum = parseIsoDate(max)

  if (
    selected &&
    (!minimum || compareDates(selected, minimum) >= 0) &&
    (!maximum || compareDates(selected, maximum) <= 0)
  ) {
    return { ...selected, day: 1 }
  }

  const today = todayParts()

  if (minimum && compareDates(today, minimum) < 0) {
    return { ...minimum, day: 1 }
  }

  if (maximum && compareDates(today, maximum) > 0) {
    return { ...maximum, day: 1 }
  }

  return { ...today, day: 1 }
}

function shiftMonth(month: DateParts, amount: number): DateParts {
  const date = localDate({ day: 1, month: month.month + amount, year: month.year })

  return { day: 1, month: date.getMonth(), year: date.getFullYear() }
}

function monthDays(month: DateParts): DateParts[] {
  const firstWeekday = localDate({ ...month, day: 1 }).getDay()

  return Array.from({ length: 42 }, (_, index) => {
    const date = localDate({
      day: 1 - firstWeekday + index,
      month: month.month,
      year: month.year
    })

    return { day: date.getDate(), month: date.getMonth(), year: date.getFullYear() }
  })
}

export function CollectDatePicker({
  ariaInvalid,
  ariaLabel,
  disabled = false,
  disabledDates,
  disabledWeekdays,
  max,
  min,
  onChange,
  onKeyDown,
  placeholder = '年 / 月 / 日',
  step,
  value
}: CollectDatePickerProps) {
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(() => initialMonth(value, min, max))
  const selected = parseIsoDate(value)
  const minimum = parseIsoDate(min)
  const maximum = parseIsoDate(max)
  const today = todayParts()
  const days = useMemo(() => monthDays(visibleMonth), [visibleMonth])

  const constraints = useMemo(
    () => ({ disabledDates, disabledWeekdays, max, min, step }),
    [disabledDates, disabledWeekdays, max, min, step]
  )

  const selectDay = (day: DateParts) => {
    if (disabled || datePartsDisabled(day, constraints)) {
      return
    }

    onChange(toIsoDate(day))
    setVisibleMonth({ ...day, day: 1 })
    setOpen(false)
  }

  const changeOpen = (nextOpen: boolean) => {
    if (disabled) {
      setOpen(false)

      return
    }

    if (nextOpen) {
      setVisibleMonth(initialMonth(value, min, max))
    }

    setOpen(nextOpen)
  }

  const previousMonth = shiftMonth(visibleMonth, -1)
  const nextMonth = shiftMonth(visibleMonth, 1)

  const previousDisabled =
    (visibleMonth.year === 1 && visibleMonth.month === 0) ||
    (minimum !== null &&
      (previousMonth.year < minimum.year ||
        (previousMonth.year === minimum.year && previousMonth.month < minimum.month)))

  const nextDisabled =
    (visibleMonth.year === 9999 && visibleMonth.month === 11) ||
    (maximum !== null &&
      (nextMonth.year > maximum.year || (nextMonth.year === maximum.year && nextMonth.month > maximum.month)))

  const todayDisabled = datePartsDisabled(today, constraints)

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <PopoverAnchor asChild>
        <div aria-invalid={ariaInvalid || undefined} className="lg-input flex min-h-9 w-full items-center px-3">
          <input
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-invalid={ariaInvalid || undefined}
            aria-label={ariaLabel}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-2 text-[12.5px] leading-snug text-(--bwa-text) placeholder:text-(--bwa-text-muted) disabled:opacity-55"
            disabled={disabled}
            inputMode="numeric"
            onChange={event => onChange(event.target.value)}
            onClick={() => changeOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            value={value}
          />
          <PopoverTrigger asChild>
            <button
              aria-label={`选择${ariaLabel}`}
              className="ml-2 grid size-6 shrink-0 place-items-center rounded-md text-(--bwa-text-muted) transition-colors hover:bg-(--lg-item-active) hover:text-(--bwa-text)"
              disabled={disabled}
              type="button"
            >
              <Calendar aria-hidden className="size-3.5" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>

      <PopoverContent
        align="start"
        aria-label={`${ariaLabel}日历`}
        className="w-[min(17.5rem,calc(100vw-1rem))] p-3"
        onOpenAutoFocus={event => event.preventDefault()}
      >
        <div className="mb-2.5 flex items-center justify-between">
          <span className="px-1 text-[12.5px] font-semibold text-(--bwa-text)">
            {visibleMonth.year}年 {visibleMonth.month + 1}月
          </span>
          <div className="flex items-center gap-1">
            <button
              aria-label="上个月"
              className="lg-icon-btn size-7 text-(--bwa-text-secondary) disabled:cursor-not-allowed disabled:opacity-35"
              disabled={disabled || previousDisabled}
              onClick={() => setVisibleMonth(previousMonth)}
              type="button"
            >
              <ChevronLeft aria-hidden className="size-3.5" />
            </button>
            <button
              aria-label="下个月"
              className="lg-icon-btn size-7 text-(--bwa-text-secondary) disabled:cursor-not-allowed disabled:opacity-35"
              disabled={disabled || nextDisabled}
              onClick={() => setVisibleMonth(nextMonth)}
              type="button"
            >
              <ChevronRight aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map(weekday => (
            <span
              aria-hidden
              className="grid h-6 place-items-center text-[10.5px] font-medium text-(--bwa-text-muted)"
              key={weekday}
            >
              {weekday}
            </span>
          ))}
          {days.map(day => {
            const isoDate = toIsoDate(day)
            const isDisabled = datePartsDisabled(day, constraints)
            const isSelected = selected ? compareDates(day, selected) === 0 : false
            const isToday = compareDates(day, today) === 0
            const outsideMonth = day.month !== visibleMonth.month

            return (
              <button
                aria-current={isToday ? 'date' : undefined}
                aria-label={`${day.year}年${day.month + 1}月${day.day}日`}
                aria-pressed={isSelected}
                className={cn(
                  'grid size-7 place-items-center rounded-lg text-[11.5px] transition-colors',
                  isSelected
                    ? 'bg-(--lg-accent) font-semibold text-white shadow-[0_3px_8px_color-mix(in_srgb,var(--lg-accent)_25%,transparent)]'
                    : isToday
                      ? 'border border-[color:color-mix(in_srgb,var(--lg-accent)_35%,transparent)] font-semibold text-(--lg-accent)'
                      : outsideMonth
                        ? 'text-(--bwa-text-muted) opacity-45'
                        : 'text-(--bwa-text) hover:bg-(--lg-item-active)',
                  isDisabled && 'cursor-not-allowed opacity-25 hover:bg-transparent'
                )}
                disabled={disabled || isDisabled}
                key={isoDate}
                onClick={() => selectDay(day)}
                type="button"
              >
                {day.day}
              </button>
            )
          })}
        </div>

        <div className="mt-2.5 flex items-center justify-between border-t border-(--lg-inset-stroke) pt-2.5">
          <button
            className="text-[11px] font-medium text-(--bwa-text-muted) transition-colors hover:text-(--bwa-text)"
            disabled={!value || disabled}
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            type="button"
          >
            清除
          </button>
          <button
            className="text-[11px] font-semibold text-(--lg-accent) transition-opacity disabled:cursor-not-allowed disabled:opacity-35"
            disabled={todayDisabled || disabled}
            onClick={() => selectDay(today)}
            type="button"
          >
            今天
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
