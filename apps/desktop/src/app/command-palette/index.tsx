import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { FullWindowOverlayLease } from '@/components/ui/dialog'
import { getFanConfigRecord, listSessions } from '@/fan'
import { sessionTitle } from '@/lib/chat-runtime'
import {
  Archive,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  type IconComponent,
  Info,
  MessageCircle,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sun,
  Wrench,
  Zap
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $commandPaletteOpen, closeCommandPalette, setCommandPaletteOpen } from '@/store/command-palette'
import { type ThemeMode, useTheme } from '@/themes/context'

import { NEW_CHAT_ROUTE, sessionRoute, SETTINGS_ROUTE, SKILLS_ROUTE } from '../routes'
import { FIELD_LABELS, SETTINGS_NAV_SECTIONS } from '../settings/constants'
import { prettyName } from '../settings/helpers'
import { navigateWithOverlayState } from '../shell/hooks/use-overlay-routing'

interface PaletteItem {
  active?: boolean
  icon: IconComponent
  id: string
  /** Keep the palette open after running (live-preview pickers like theme/mode). */
  keepOpen?: boolean
  keywords?: string[]
  label: string
  /** Action to run when selected. Mutually exclusive with `to`. */
  run?: () => void
  /** Open a nested palette page (VS Code-style "choose X → options"). */
  to?: string
}

interface PaletteGroup {
  heading: string
  items: PaletteItem[]
}

/** A nested page reachable from a root item via `to`. */
interface PalettePage {
  groups: PaletteGroup[]
  placeholder: string
  title: string
}

interface SessionEntry {
  id: string
  preview?: string
  title: string
}

type SessionRow = Awaited<ReturnType<typeof listSessions>>['sessions'][number]

const toSessionEntry = (session: SessionRow): SessionEntry => ({
  id: session.id,
  preview: session.preview ?? undefined,
  title: sessionTitle(session)
})

const NON_CONFIG_SETTINGS: ReadonlyArray<{ icon: IconComponent; keywords?: string[]; label: string; tab: string }> = [
  { icon: Wrench, keywords: ['servers', 'tools'], label: 'MCP', tab: 'mcp' },
  { icon: Brain, keywords: ['agents', 'subagents', 'tasks'], label: '子代理', tab: 'agents' },
  { icon: Zap, keywords: ['cron', 'scheduled', 'automation'], label: '自动任务', tab: 'cron' },
  { icon: Wrench, keywords: ['skills', 'toolsets'], label: '技能', tab: 'skills' },
  { icon: FileText, keywords: ['artifacts', 'files', 'outputs'], label: '产物', tab: 'artifacts' },
  { icon: Archive, keywords: ['history', 'archived'], label: '已归档对话', tab: 'sessions' },
  { icon: Info, keywords: ['version', 'about'], label: '关于', tab: 'about' }
]

const THEME_MODES: ReadonlyArray<{ icon: IconComponent; label: string; mode: ThemeMode }> = [
  { icon: Sun, label: '浅色', mode: 'light' },
  { icon: Moon, label: '深色', mode: 'dark' },
  { icon: Monitor, label: '跟随系统', mode: 'system' }
]

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? prettyName(key.split('.').pop() ?? key)
}

export function CommandPalette() {
  const open = useStore($commandPaletteOpen)
  const navigate = useNavigate()
  const location = useLocation()
  const { mode, setMode } = useTheme()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState<string | null>(null)

  // Server-backed sources for the type-to-search groups, fetched lazily while
  // the palette is open. react-query handles caching/dedup/staleness.
  const configQuery = useQuery({
    queryKey: ['command-palette', 'config'],
    queryFn: getFanConfigRecord,
    enabled: open
  })

  const sessionsQuery = useQuery({
    queryKey: ['command-palette', 'sessions'],
    queryFn: () => listSessions(200, 1, 'exclude'),
    enabled: open
  })

  const archivedQuery = useQuery({
    queryKey: ['command-palette', 'archived'],
    queryFn: () => listSessions(200, 0, 'only'),
    enabled: open
  })

  const mcpServers = useMemo(() => {
    const raw = configQuery.data?.mcp_servers

    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.keys(raw as Record<string, unknown>).sort()
      : []
  }, [configQuery.data])

  const sessions = useMemo(() => (sessionsQuery.data?.sessions ?? []).map(toSessionEntry), [sessionsQuery.data])
  const archivedSessions = useMemo(() => (archivedQuery.data?.sessions ?? []).map(toSessionEntry), [archivedQuery.data])

  // Reset the query/sub-page on close so it reopens clean.
  useEffect(() => {
    if (!open) {
      setSearch('')
      setPage(null)
    }
  }, [open])

  // Overlay targets (settings tabs, …) float over the current surface; the
  // helper attaches the background-location state for those and falls through
  // to a plain navigate for everything else.
  const go = useCallback(
    (path: string) => () => navigateWithOverlayState(navigate, location, path),
    [location, navigate]
  )

  const baseGroups = useMemo<PaletteGroup[]>(() => {
    const settingsTab = (tab: string) => `${SETTINGS_ROUTE}?tab=${tab}`

    return [
      {
        heading: '跳转到',
        items: [
          { icon: Plus, id: 'nav-new', keywords: ['chat', 'create'], label: '新建会话', run: go(NEW_CHAT_ROUTE) },
          { icon: Settings, id: 'nav-settings', label: '设置', run: go(SETTINGS_ROUTE) },
          {
            icon: Wrench,
            id: 'nav-skills',
            keywords: ['tools', 'toolsets'],
            label: '技能与工具',
            run: go(SKILLS_ROUTE)
          },
        ]
      },
      {
        heading: '设置',
        items: [
          {
            icon: Settings,
            id: 'set-preferences',
            keywords: ['settings', 'preferences', 'chat', 'search', 'safety'],
            label: '偏好',
            run: go(settingsTab('config:chat'))
          },
          ...NON_CONFIG_SETTINGS.map(entry => ({
            icon: entry.icon,
            id: `set-${entry.tab}`,
            keywords: ['settings', ...(entry.keywords ?? [])],
            label: entry.label,
            run: go(settingsTab(entry.tab))
          }))
        ]
      }
    ]
  }, [go])

  // The long, granular lists (settings fields, API keys, MCP servers, archived
  // chats) only surface once the user types — otherwise they'd bury the
  // navigation entries on an empty palette.
  const searchGroups = useMemo<PaletteGroup[]>(() => {
    if (!search.trim()) {
      return []
    }

    const result: PaletteGroup[] = []

    if (sessions.length > 0) {
      result.push({
        heading: '会话',
        items: sessions.map(session => ({
          icon: MessageCircle,
          id: `session-${session.id}`,
          keywords: ['chat', 'session', ...(session.preview ? [session.preview] : [])],
          label: session.title,
          run: go(sessionRoute(session.id))
        }))
      })
    }

    const fieldItems = SETTINGS_NAV_SECTIONS.flatMap(section =>
      section.keys.map(key => ({
        icon: section.icon,
        id: `field-${key}`,
        keywords: ['settings', key, section.label],
        label: `${section.label}: ${fieldLabel(key)}`,
        run: go(`${SETTINGS_ROUTE}?tab=config:${section.id}&field=${encodeURIComponent(key)}`)
      }))
    )

    result.push({ heading: '设置项', items: fieldItems })

    if (mcpServers.length > 0) {
      result.push({
        heading: 'MCP 服务器',
        items: mcpServers.map(name => ({
          icon: Wrench,
          id: `mcp-${name}`,
          keywords: ['mcp', 'server', 'tool'],
          label: name,
          run: go(`${SETTINGS_ROUTE}?tab=mcp&server=${encodeURIComponent(name)}`)
        }))
      })
    }

    if (archivedSessions.length > 0) {
      result.push({
        heading: '已归档对话',
        items: archivedSessions.map(session => ({
          icon: Archive,
          id: `archived-${session.id}`,
          keywords: ['archived', 'chat', 'session', ...(session.preview ? [session.preview] : [])],
          label: session.title,
          run: go(`${SETTINGS_ROUTE}?tab=sessions&session=${encodeURIComponent(session.id)}`)
        }))
      })
    }

    return result
  }, [archivedSessions, go, mcpServers, search, sessions])

  const groups = useMemo(() => [...baseGroups, ...searchGroups], [baseGroups, searchGroups])

  // Nested palette pages (VS Code-style submenus). Reusable: add an entry here
  // and point a root item at it via `to`.
  const subPages = useMemo<Record<string, PalettePage>>(
    () => ({
      'color-mode': {
        title: '颜色模式',
        placeholder: '选择颜色模式…',
        groups: [
          {
            heading: '颜色模式',
            items: THEME_MODES.map(entry => ({
              active: mode === entry.mode,
              icon: entry.icon,
              id: `mode-${entry.mode}`,
              keepOpen: true,
              keywords: ['appearance', 'brightness', entry.label],
              label: entry.label,
              run: () => setMode(entry.mode)
            }))
          }
        ]
      }
    }),
    [mode, setMode]
  )

  const activePage = page ? subPages[page] : null
  const visibleGroups = activePage ? activePage.groups : groups
  const placeholder = activePage ? activePage.placeholder : '搜索命令和设置…'

  const handleSelect = (item: PaletteItem) => {
    if (item.to) {
      setPage(item.to)
      setSearch('')

      return
    }

    item.run?.()

    if (!item.keepOpen) {
      closeCommandPalette()
    }
  }

  return (
    <DialogPrimitive.Root onOpenChange={setCommandPaletteOpen} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lg-scrim fixed inset-0 z-[200] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="lg-card fixed left-1/2 top-[14vh] z-[210] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[1.25rem] duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=open]:zoom-in-95"
        >
          <FullWindowOverlayLease />
          <DialogPrimitive.Title className="sr-only">命令面板</DialogPrimitive.Title>
          <Command className="bg-transparent" loop>
            {activePage && (
              <button
                className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setPage(null)}
                type="button"
              >
                <ChevronLeft className="size-3.5" />
                <span>返回</span>
                <span className="text-muted-foreground/50">/</span>
                <span className="font-medium text-foreground">{activePage.title}</span>
              </button>
            )}
            <CommandInput
              onKeyDown={event => {
                if (!activePage) {
                  return
                }

                // In a submenu: Esc and empty-input Backspace step back out
                // instead of closing the whole palette.
                if (event.key === 'Escape' || (event.key === 'Backspace' && search === '')) {
                  event.preventDefault()
                  event.stopPropagation()
                  setPage(null)
                }
              }}
              onValueChange={setSearch}
              placeholder={placeholder}
              value={search}
            />
            <CommandList className="max-h-[min(24rem,60vh)]">
              <CommandEmpty>无结果。</CommandEmpty>
              {visibleGroups.map(group => (
                <CommandGroup
                  className="**:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-wider **:[[cmdk-group-heading]]:text-[0.6875rem] **:[[cmdk-group-heading]]:text-muted-foreground/70"
                  heading={group.heading}
                  key={group.heading}
                >
                  {group.items.map(item => {
                    const Icon = item.icon

                    return (
                      <CommandItem
                        className="gap-2.5"
                        key={item.id}
                        keywords={item.keywords}
                        onSelect={() => handleSelect(item)}
                        value={`${item.label} ${item.keywords?.join(' ') ?? ''} ${item.id}`}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.label}</span>
                        {item.to ? (
                          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground/70" />
                        ) : (
                          <Check className={cn('ml-auto size-4 text-foreground', !item.active && 'invisible')} />
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
