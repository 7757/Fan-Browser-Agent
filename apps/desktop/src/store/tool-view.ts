import { atom, computed, type ReadableAtom } from 'nanostores'

import { persistBoolean } from '@/lib/storage'

export type ToolViewMode = 'product' | 'technical'

type ToolDisclosureStates = Record<string, boolean>

const TOOL_VIEW_TECHNICAL_STORAGE_KEY = 'fan.desktop.toolView.technical'
const TOOL_DISCLOSURE_STORAGE_KEY = 'fan.desktop.toolDisclosure.v1'
const MAX_DISCLOSURE_STATES = 240
const MAX_DISCLOSURE_ATOM_CACHE = MAX_DISCLOSURE_STATES * 2

export const $toolViewMode = atom<ToolViewMode>(
  'product'
)
export const $toolDisclosureStates = atom<ToolDisclosureStates>(loadToolDisclosureStates())
const disclosureOpenCache = new Map<string, ReadableAtom<boolean | undefined>>()

$toolViewMode.subscribe(mode => persistBoolean(TOOL_VIEW_TECHNICAL_STORAGE_KEY, mode === 'technical'))
$toolDisclosureStates.subscribe(persistToolDisclosureStates)

export function setToolViewMode(mode: ToolViewMode) {
  $toolViewMode.set(mode)
}

export function $toolDisclosureOpen(id: string): ReadableAtom<boolean | undefined> {
  let cached = disclosureOpenCache.get(id)

  if (!cached) {
    cached = computed($toolDisclosureStates, states => states[id])
    disclosureOpenCache.set(id, cached)
  } else {
    // Refresh insertion order so this lookup map behaves as a small LRU.
    // Mounted consumers retain their atom if a later trim removes the entry.
    disclosureOpenCache.delete(id)
    disclosureOpenCache.set(id, cached)
  }

  while (disclosureOpenCache.size > MAX_DISCLOSURE_ATOM_CACHE) {
    const oldest = disclosureOpenCache.keys().next().value

    if (!oldest) {
      break
    }

    disclosureOpenCache.delete(oldest)
  }

  return cached
}

function loadToolDisclosureStates(): ToolDisclosureStates {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(TOOL_DISCLOSURE_STORAGE_KEY)

    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter((entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean')
        .slice(-MAX_DISCLOSURE_STATES)
    )
  } catch {
    return {}
  }
}

function persistToolDisclosureStates(states: ToolDisclosureStates) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const entries = Object.entries(states).slice(-MAX_DISCLOSURE_STATES)

    window.localStorage.setItem(TOOL_DISCLOSURE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Tool disclosure is a local UI preference; ignore storage failures.
  }
}

export function setToolDisclosureOpen(id: string, open: boolean) {
  if (!id) {
    return
  }

  const current = $toolDisclosureStates.get()

  if (current[id] === open) {
    return
  }

  // Persisting was already bounded, but the live atom retained every tool-call
  // id for the lifetime of the renderer. Move the touched id to the end and
  // bound the live state to the same recent working set.
  const next = { ...current }
  delete next[id]
  next[id] = open
  const boundedEntries = Object.entries(next).slice(-MAX_DISCLOSURE_STATES)
  const bounded = Object.fromEntries(boundedEntries)
  const keep = new Set(boundedEntries.map(([key]) => key))

  for (const key of disclosureOpenCache.keys()) {
    if (!keep.has(key) && key !== id) {
      disclosureOpenCache.delete(key)
    }
  }

  $toolDisclosureStates.set(bounded)
}

export function __resetToolDisclosureCacheForTests() {
  disclosureOpenCache.clear()
  $toolDisclosureStates.set({})
}

export function __toolDisclosureCacheSizeForTests() {
  return disclosureOpenCache.size
}
