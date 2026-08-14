import { useStore } from '@nanostores/react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { ModelProviderSettingsCard } from '@/components/model-provider-setup'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  type FanGateway,
  getElevenLabsVoices,
  getFanConfigDefaults,
  getFanConfigRecord,
  getFanConfigSchema,
  saveFanConfig
} from '@/fan'
import { useI18n } from '@/i18n'
import { normalizePersonalityValue } from '@/lib/chat-runtime'
import { setSessionPersonality } from '@/lib/personality-session'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { $activeSessionId } from '@/store/session'
import type { ConfigFieldSchema, FanConfigRecord } from '@/types/fan'

import { AppearanceSettingsBody } from './appearance-settings'
import {
  CONTROL_TEXT,
  EMPTY_SELECT_VALUE,
  FIELD_DESCRIPTIONS,
  FIELD_LABELS,
  FIELD_TOOLTIPS,
  PERSONALITY_LABELS,
  SEARCH_ENGINE_LABELS,
  SETTINGS_NAV_SECTIONS
} from './constants'
import { enumOptionsFor, getNested, prettyName, setNested, withoutPersonalityConfig } from './helpers'
import { ListRow, LoadingState, SectionHeading, SettingsContent, TitleWithInfo } from './primitives'

function ConfigField({
  schemaKey,
  schema,
  value,
  enumOptions,
  optionLabels,
  onChange
}: {
  schemaKey: string
  schema: ConfigFieldSchema
  value: unknown
  enumOptions?: string[]
  optionLabels?: Record<string, string>
  onChange: (value: unknown) => void
}) {
  const { t } = useI18n()
  const label = t(FIELD_LABELS[schemaKey] ?? prettyName(schemaKey.split('.').pop() ?? schemaKey))
  const tooltip = FIELD_TOOLTIPS[schemaKey] ? t(FIELD_TOOLTIPS[schemaKey]) : undefined
  const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const rawDescription = t((FIELD_DESCRIPTIONS[schemaKey] ?? schema.description ?? '').trim())
  const normalizedDesc = normalize(rawDescription)

  const description =
    rawDescription && normalizedDesc !== normalize(label) && normalizedDesc !== normalize(schemaKey)
      ? rawDescription
      : undefined

  const row = (action: ReactNode, wide = false) => (
    <ListRow action={action} description={description} title={<TitleWithInfo title={label} tooltip={tooltip} />} wide={wide} />
  )

  // approvals.mode exposes all three backend tiers (user ruling: aggressive
  // users get the 'off' tier too — we don't restrict them). manual = prompt on
  // every dangerous command, smart = aux-LLM risk triage, off = approve
  // everything. The hardline blocklist (rm -rf /, raw device writes, …) still
  // applies below all of these, including off.
  if (schemaKey === 'approvals.mode') {
    const mode = String(value ?? 'manual')

    return row(
      <SegmentedControl
        onChange={id => onChange(id)}
        options={
          [
            { id: 'manual', label: t('每次确认') },
            { id: 'smart', label: t('智能判断') },
            { id: 'off', label: t('从不确认') }
          ] as const
        }
        value={['manual', 'smart', 'off'].includes(mode) ? mode : 'manual'}
      />
    )
  }

  if (schema.type === 'boolean') {
    return row(
      <div className="flex items-center justify-end">
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
      </div>
    )
  }

  const selectOptions = enumOptions ?? (schema.type === 'select' ? (schema.options ?? []).map(String) : undefined)

  if (selectOptions) {
    return row(
      <Select
        onValueChange={next => onChange(next === EMPTY_SELECT_VALUE ? '' : next)}
        value={String(value ?? '') || EMPTY_SELECT_VALUE}
      >
        <SelectTrigger className={CONTROL_TEXT}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {selectOptions.map(option => (
            <SelectItem key={option || EMPTY_SELECT_VALUE} value={option || EMPTY_SELECT_VALUE}>
              {option
                ? t(optionLabels?.[option] ?? prettyName(option))
                : schemaKey === 'display.personality'
                  ? t('无')
                  : t('（无）')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  if (schema.type === 'number') {
    return row(
      <Input
        className={CONTROL_TEXT}
        onChange={e => {
          const raw = e.target.value
          const n = raw === '' ? 0 : Number(raw)

          if (!Number.isNaN(n)) {
            onChange(n)
          }
        }}
        placeholder={t('未设置')}
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
      />
    )
  }

  if (schema.type === 'list') {
    return row(
      <Input
        className={CONTROL_TEXT}
        onChange={e =>
          onChange(
            e.target.value
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          )
        }
        placeholder={t('逗号分隔的值')}
        value={Array.isArray(value) ? value.join(', ') : String(value ?? '')}
      />
    )
  }

  if (typeof value === 'object' && value !== null) {
    return row(
      <Textarea
        className={cn('min-h-28 resize-y bg-background font-mono', CONTROL_TEXT)}
        onChange={e => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            /* keep last valid */
          }
        }}
        placeholder={t('未设置')}
        spellCheck={false}
        value={JSON.stringify(value, null, 2)}
      />,
      true
    )
  }

  const isLong = schema.type === 'text' || String(value ?? '').length > 100

  return row(
    isLong ? (
      <Textarea
        className={cn('min-h-24 resize-y bg-background', CONTROL_TEXT)}
        onChange={e => onChange(e.target.value)}
        placeholder={t('未设置')}
        value={String(value ?? '')}
      />
    ) : (
      <Input
        className={CONTROL_TEXT}
        onChange={e => onChange(e.target.value)}
        placeholder={t('未设置')}
        value={String(value ?? '')}
      />
    ),
    isLong
  )
}

export function ConfigSettings({
  activeSectionId,
  gateway,
  onActiveSectionChange,
  onConfigSaved
}: {
  activeSectionId: string
  gateway?: FanGateway | null
  /** Called by the scroll-spy as the visible section changes — drives the
   *  sidebar highlight + URL while the user scrolls the unified page. */
  onActiveSectionChange?: (sectionId: string) => void
  onConfigSaved?: () => void
}) {
  const { t } = useI18n()
  const activeSessionId = useStore($activeSessionId)
  const [config, setConfig] = useState<FanConfigRecord | null>(null)
  const [_defaults, setDefaults] = useState<FanConfigRecord | null>(null)
  const [schema, setSchema] = useState<Record<string, ConfigFieldSchema> | null>(null)
  const [elevenLabsVoiceOptions, setElevenLabsVoiceOptions] = useState<string[] | null>(null)
  const [elevenLabsVoiceLabels, setElevenLabsVoiceLabels] = useState<Record<string, string>>({})
  const saveVersionRef = useRef(0)
  const [saveVersion, setSaveVersion] = useState(0)
  const saveOnConfigSavedRef = useRef(onConfigSaved)
  saveOnConfigSavedRef.current = onConfigSaved
  const appliedPersonalityRef = useRef('')
  const personalityRequestVersionRef = useRef(0)
  const personalitySaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const translateRef = useRef(t)
  translateRef.current = t

  // Scroll-spy plumbing for the unified (all-sections) scroll page.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const spyReportedRef = useRef<string | null>(null)
  const suppressSpyUntilRef = useRef(0)
  const firstScrollRef = useRef(true)
  const onActiveSectionChangeRef = useRef(onActiveSectionChange)
  onActiveSectionChangeRef.current = onActiveSectionChange

  useEffect(() => {
    let cancelled = false
    Promise.all([getFanConfigRecord(), getFanConfigDefaults(), getFanConfigSchema()])
      .then(([c, d, s]) => {
        if (cancelled) {
          return
        }

        setConfig(c)
        appliedPersonalityRef.current = normalizePersonalityValue(String(getNested(c, 'display.personality') ?? ''))
        setDefaults(d)
        setSchema(s.fields)
      })
      .catch(err => notifyError(err, translateRef.current('设置加载失败')))

    return () => void (cancelled = true)
  }, [])

  useEffect(() => {
    let cancelled = false

    getElevenLabsVoices()
      .then(result => {
        if (cancelled || !result.available) {
          return
        }

        setElevenLabsVoiceOptions(result.voices.map(voice => voice.voice_id))
        setElevenLabsVoiceLabels(Object.fromEntries(result.voices.map(voice => [voice.voice_id, voice.label])))
      })
      .catch(() => {
        if (!cancelled) {
          setElevenLabsVoiceOptions(null)
          setElevenLabsVoiceLabels({})
        }
      })

    return () => void (cancelled = true)
  }, [])

  useEffect(() => {
    if (!config || saveVersion === 0) {
      return
    }

    const v = saveVersion

    const saveTimer = window.setTimeout(() => {
      void (async () => {
        try {
          await saveFanConfig(withoutPersonalityConfig(config))

          if (saveVersionRef.current === v) {
            saveOnConfigSavedRef.current?.()
          }
        } catch (err) {
          if (saveVersionRef.current === v) {
            notifyError(err, translateRef.current('自动保存失败'))
          }
        }
      })()
    }, 550)

    return () => window.clearTimeout(saveTimer)
  }, [config, saveVersion])

  const updateConfig = (next: FanConfigRecord) => {
    saveVersionRef.current += 1
    setConfig(next)
    setSaveVersion(saveVersionRef.current)
  }

  const updatePersonality = (value: unknown) => {
    if (!config) {
      return
    }

    if (!gateway) {
      notifyError(new Error('Fan gateway unavailable'), t('对话风格保存失败'))

      return
    }

    const requested = normalizePersonalityValue(String(value ?? ''))
    const requestVersion = ++personalityRequestVersionRef.current

    setConfig(setNested(config, 'display.personality', requested))

    const save = async () => {
      const applied = await setSessionPersonality(
        (method, params) => gateway.request(method, params),
        activeSessionId,
        requested
      )

      appliedPersonalityRef.current = applied

      if (personalityRequestVersionRef.current === requestVersion) {
        setConfig(current => (current ? setNested(current, 'display.personality', applied) : current))
        onConfigSaved?.()
      }
    }

    const queued = personalitySaveQueueRef.current.then(save, save)
    personalitySaveQueueRef.current = queued.catch(() => undefined)

    void queued.catch(error => {
      if (personalityRequestVersionRef.current === requestVersion) {
        setConfig(current =>
          current ? setNested(current, 'display.personality', appliedPersonalityRef.current) : current
        )
        notifyError(error, t('对话风格保存失败'))
      }
    })
  }

  const sectionFields = useMemo(() => {
    if (!schema) {
      return new Map<string, [string, ConfigFieldSchema][]>()
    }

    return new Map(
      SETTINGS_NAV_SECTIONS.map(s => [s.id, s.keys.flatMap(k => (schema[k] ? [[k, schema[k]] as [string, ConfigFieldSchema]] : []))])
    )
  }, [schema])

  const ready = Boolean(config && schema)

  // Scroll to a section when it's picked from the sidebar — i.e. activeSectionId
  // changed to something the spy did NOT just report. First mount jumps
  // instantly; later picks scroll smoothly. The spy is briefly suppressed so the
  // in-flight scroll doesn't flicker the highlight through every section.
  useEffect(() => {
    if (!ready || activeSectionId === spyReportedRef.current) {
      return
    }

    const el = document.getElementById(`settings-section-${activeSectionId}`)

    if (!el) {
      return
    }

    suppressSpyUntilRef.current = performance.now() + 700
    el.scrollIntoView({ behavior: firstScrollRef.current ? 'auto' : 'smooth', block: 'start' })
    firstScrollRef.current = false
  }, [activeSectionId, ready])

  // Scroll-spy: report the topmost section in the upper band so the sidebar
  // highlight + URL follow the scroll.
  useEffect(() => {
    const root = scrollRef.current

    if (!ready || !root) {
      return
    }

    const visible = new Map<string, number>()
    let lastReported: null | string = null

    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-section')

          if (!id) {
            continue
          }

          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top)
          } else {
            visible.delete(id)
          }
        }

        // Keep the map current during a programmatic scroll, but don't report.
        if (performance.now() < suppressSpyUntilRef.current) {
          return
        }

        let topId: null | string = null
        let minTop = Infinity

        for (const [id, top] of visible) {
          if (top < minTop) {
            minTop = top
            topId = id
          }
        }

        if (topId && topId !== lastReported) {
          lastReported = topId
          spyReportedRef.current = topId
          onActiveSectionChangeRef.current?.(topId)
        }
      },
      { root, rootMargin: '0px 0px -75% 0px', threshold: 0 }
    )

    for (const section of SETTINGS_NAV_SECTIONS) {
      const el = document.getElementById(`settings-section-${section.id}`)

      if (el) {
        io.observe(el)
      }
    }

    return () => io.disconnect()
  }, [ready])

  // Deep-link target from the command palette (?field=<key>): scroll the row
  // into view and flash it, then drop the param so it doesn't re-fire.
  const [searchParams, setSearchParams] = useSearchParams()
  const targetField = searchParams.get('field')

  useEffect(() => {
    if (!targetField || !config || !schema) {
      return
    }

    const element = document.getElementById(`setting-field-${targetField}`)

    if (!element) {
      return
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element.classList.add('setting-field-highlight')

    const timeout = window.setTimeout(() => element.classList.remove('setting-field-highlight'), 1600)

    setSearchParams(
      previous => {
        const next = new URLSearchParams(previous)
        next.delete('field')

        return next
      },
      { replace: true }
    )

    return () => window.clearTimeout(timeout)
  }, [config, schema, setSearchParams, targetField])

  if (!config || !schema) {
    return <LoadingState label={t('正在加载 Fan 配置…')} />
  }

  return (
    <SettingsContent scrollRef={scrollRef}>
      <section className="scroll-mt-3" id="settings-section-model-provider">
        <SectionHeading icon={SETTINGS_NAV_SECTIONS[0].icon} title={t('模型提供商')} />
        <ModelProviderSettingsCard onConfigured={onConfigSaved} />
      </section>
      <div aria-hidden className="my-4 h-px bg-border/60" />
      {SETTINGS_NAV_SECTIONS.map((s, index) => (
        <section className="scroll-mt-3" data-section={s.id} id={`settings-section-${s.id}`} key={s.id}>
          {index > 0 && <div aria-hidden className="my-4 h-px bg-border/60" />}
          <SectionHeading icon={s.icon} title={t(s.label)} />
          {s.id === 'appearance' ? (
            <AppearanceSettingsBody
              onLanguageChange={language => updateConfig(setNested(config, 'display.language', language))}
            />
          ) : (
            <div className="grid gap-1">
              {(sectionFields.get(s.id) ?? []).map(([key, field]) => (
                <div className="scroll-mt-6 rounded-lg" id={`setting-field-${key}`} key={key}>
                  <ConfigField
                    enumOptions={
                      key === 'tts.elevenlabs.voice_id'
                        ? enumOptionsFor(key, getNested(config, key), config, elevenLabsVoiceOptions ?? undefined)
                        : enumOptionsFor(key, getNested(config, key), config)
                    }
                    onChange={value =>
                      key === 'display.personality'
                        ? updatePersonality(value)
                        : updateConfig(setNested(config, key, value))
                    }
                    optionLabels={
                      key === 'tts.elevenlabs.voice_id'
                        ? elevenLabsVoiceLabels
                        : key === 'display.personality'
                          ? PERSONALITY_LABELS
                          : key === 'browser.search_engine'
                            ? SEARCH_ENGINE_LABELS
                            : undefined
                    }
                    schema={field}
                    schemaKey={key}
                    value={getNested(config, key)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </SettingsContent>
  )
}
