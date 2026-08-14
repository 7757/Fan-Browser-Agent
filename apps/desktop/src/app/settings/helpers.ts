import type { FanConfigRecord, ToolsetInfo } from '@/types/fan'

import { BUILTIN_PERSONALITIES, ENUM_OPTIONS } from './constants'

export const asText = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

export const includesQuery = (v: unknown, q: string) => asText(v).toLowerCase().includes(q)

export const prettyName = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

/** Strip leading emoji from toolset titles (CLI registry prefixes labels with icons). */
export const stripToolsetLabel = (label: string): string =>
  label.replace(/^[\p{Emoji}\p{Extended_Pictographic}\s]+/u, '').trim() || label

export const toolsetDisplayLabel = (toolset: Pick<ToolsetInfo, 'label' | 'name'>): string =>
  stripToolsetLabel(asText(toolset.label || toolset.name))

export const toolNames = (t: ToolsetInfo) => (Array.isArray(t.tools) ? t.tools.map(asText).filter(Boolean) : [])

const POLLUTING_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype'])

function isSafePart(part: string): boolean {
  return part.length > 0 && !POLLUTING_PATH_PARTS.has(part)
}

function configPathParts(path: string): string[] {
  const parts = path.split('.')

  if (!parts.every(isSafePart)) {
    throw new Error(`Unsafe config path: ${path}`)
  }

  return parts
}

function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !key) {
    throw new Error(`Unsafe config key: ${key}`)
  }

  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  })
}

export function getNested(obj: FanConfigRecord, path: string): unknown {
  let cur: unknown = obj

  for (const part of configPathParts(path)) {
    if (cur == null || typeof cur !== 'object') {
      return undefined
    }

    if (!Object.prototype.hasOwnProperty.call(cur, part)) {
      return undefined
    }

    cur = (cur as Record<string, unknown>)[part]
  }

  return cur
}

export function setNested(obj: FanConfigRecord, path: string, value: unknown): FanConfigRecord {
  const clone = structuredClone(obj)
  const parts = configPathParts(path)
  let cur: Record<string, unknown> = clone

  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]

    if (!isSafePart(part)) {
      throw new Error(`Unsafe config path part: ${part}`)
    }

    const existing = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined

    if (existing == null || typeof existing !== 'object') {
      safeSet(cur, part, {})
    }

    cur = cur[part] as Record<string, unknown>
  }

  safeSet(cur, parts[parts.length - 1], value)

  return clone
}

/**
 * Personality is owned by the gateway's dedicated config.set flow because it
 * must keep display.personality and agent.system_prompt in sync. Generic
 * settings saves are partial merges, so omitting both leaves preserves the
 * gateway's authoritative values instead of overwriting the prompt with the
 * stale copy loaded when the settings panel opened.
 */
export function withoutPersonalityConfig(config: FanConfigRecord): FanConfigRecord {
  const next = structuredClone(config)

  for (const [sectionName, key] of [
    ['display', 'personality'],
    ['agent', 'system_prompt']
  ] as const) {
    const section = next[sectionName]

    if (section && typeof section === 'object' && !Array.isArray(section)) {
      delete (section as Record<string, unknown>)[key]
    }
  }

  return next
}

function personalityOptions(config: FanConfigRecord): string[] {
  const custom = getNested(config, 'agent.personalities')

  const customNames =
    custom && typeof custom === 'object' && !Array.isArray(custom) ? Object.keys(custom as Record<string, unknown>) : []

  // A locally configured display.personality_options list wins over the
  // built-in catalog; custom personalities are always appended.
  const curated = getNested(config, 'display.personality_options')

  const base =
    Array.isArray(curated) && curated.length > 0 ? curated.map(String) : BUILTIN_PERSONALITIES

  return [...new Set(['', ...base, ...customNames])]
}

export function enumOptionsFor(
  key: string,
  value: unknown,
  config: FanConfigRecord,
  dynamicOptions?: string[]
): string[] | undefined {
  const opts = dynamicOptions ?? (key === 'display.personality' ? personalityOptions(config) : ENUM_OPTIONS[key])

  if (!opts) {
    return undefined
  }

  const current = asText(value)

  return current && !opts.includes(current) ? [...opts, current] : opts
}
