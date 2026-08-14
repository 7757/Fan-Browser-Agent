import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { TextTab, TextTabMeta } from '@/components/ui/text-tab'
import { getSkills, getToolsets, toggleSkill, toggleToolset } from '@/fan'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/fan'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import { asText, includesQuery, prettyName, toolNames, toolsetDisplayLabel } from '../settings/helpers'
import { ToolsetConfigPanel } from '../settings/toolset-config-panel'

const SKILLS_MODES = ['skills', 'toolsets'] as const
type SkillsMode = (typeof SKILLS_MODES)[number]

const BUNDLED_SKILL_NAMES = new Set([
  'browser-anti-bot-etiquette',
  'browser-dropdown-selection',
  'browser-element-inspection',
  'browser-file-upload',
  'browser-form-filling',
  'browser-iframe-shadow-dom',
  'browser-pdf-handling',
  'browser-scroll-recovery',
  'fan-agent',
  'fan-agent-skill-authoring',
  'html-artifact',
  'plan',
  'spike',
  'systematic-debugging',
  'test-driven-development'
])

const KNOWN_OFFICIAL_SKILL_NAMES = new Set(['hello-fan'])

function categoryFor(skill: SkillInfo): string {
  return asText(skill.category) || 'general'
}

function skillOriginMeta(skill: SkillInfo): { label: string; className: string } {
  if (skill.created_by === 'agent') {
    return { label: '沉淀', className: 'bg-(--ui-accent)/10 text-(--ui-accent)' }
  }

  switch (skill.origin) {
    case 'agent':
      return { label: '沉淀', className: 'bg-(--ui-accent)/10 text-(--ui-accent)' }
    case 'local':
      return { label: '沉淀', className: 'bg-(--ui-accent)/10 text-(--ui-accent)' }
    case 'bundled':
      return { label: '系统', className: 'bg-muted text-muted-foreground' }
    default:
      if (KNOWN_OFFICIAL_SKILL_NAMES.has(skill.name)) {
        return { label: '官方', className: 'bg-(--ui-accent)/10 text-(--ui-accent)' }
      }
      return BUNDLED_SKILL_NAMES.has(skill.name)
        ? { label: '系统', className: 'bg-muted text-muted-foreground' }
        : { label: '沉淀', className: 'bg-(--ui-accent)/10 text-(--ui-accent)' }
  }
}

function filteredSkills(skills: SkillInfo[], query: string, category: string | null): SkillInfo[] {
  const q = query.trim().toLowerCase()

  return skills
    .filter(skill => {
      if (category && categoryFor(skill) !== category) {
        return false
      }

      if (!q) {
        return true
      }

      return includesQuery(skill.name, q) || includesQuery(skill.description, q) || includesQuery(skill.category, q)
    })
    .sort((a, b) => asText(a.name).localeCompare(asText(b.name)))
}

function filteredToolsets(toolsets: ToolsetInfo[], query: string): ToolsetInfo[] {
  const q = query.trim().toLowerCase()

  return toolsets
    .filter(toolset => {
      if (!q) {
        return true
      }

      const label = toolsetDisplayLabel(toolset)

      return (
        includesQuery(toolset.name, q) ||
        includesQuery(label, q) ||
        includesQuery(toolset.label, q) ||
        includesQuery(toolset.description, q) ||
        toolNames(toolset).some(name => includesQuery(name, q))
      )
    })
    .sort((a, b) => toolsetDisplayLabel(a).localeCompare(toolsetDisplayLabel(b)))
}

type SkillsViewProps = React.ComponentProps<'section'> & {
  /** Renders inside the Settings overlay — drops the full-page top inset. */
  embedded?: boolean
}

export function SkillsView({ className, embedded = false, ...props }: SkillsViewProps) {
  // Distinct from the settings `?tab=` param so the two don't fight when this
  // view is embedded inside the settings overlay.
  const [mode, setMode] = useRouteEnumParam('skillsTab', SKILLS_MODES, 'skills')

  const [query, setQuery] = useState('')
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [toolsets, setToolsets] = useState<ToolsetInfo[] | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [savingSkill, setSavingSkill] = useState<string | null>(null)
  const [savingToolset, setSavingToolset] = useState<string | null>(null)
  const [expandedToolset, setExpandedToolset] = useState<string | null>(null)

  const refreshCapabilities = useCallback(async () => {
    try {
      const [nextSkills, nextToolsets] = await Promise.all([getSkills(), getToolsets()])
      setSkills(nextSkills)
      setToolsets(nextToolsets)
    } catch (err) {
      notifyError(err, '技能加载失败')
    }
  }, [])

  useRefreshHotkey(refreshCapabilities)

  const refreshToolsets = useCallback(() => {
    getToolsets()
      .then(setToolsets)
      .catch(err => notifyError(err, '工具集刷新失败'))
  }, [])

  useEffect(() => {
    void refreshCapabilities()
  }, [refreshCapabilities])

  const categories = useMemo(() => {
    if (!skills) {
      return []
    }

    const counts = new Map<string, number>()

    for (const skill of skills) {
      const key = categoryFor(skill)
      counts.set(key, (counts.get(key) || 0) + 1)
    }

    return Array.from(counts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, count }))
  }, [skills])

  const visibleSkills = useMemo(
    () => (skills ? filteredSkills(skills, query, mode === 'skills' ? activeCategory : null) : []),
    [activeCategory, mode, query, skills]
  )

  const visibleToolsets = useMemo(() => (toolsets ? filteredToolsets(toolsets, query) : []), [query, toolsets])

  const skillGroups = useMemo(() => {
    const groups = new Map<string, SkillInfo[]>()

    for (const skill of visibleSkills) {
      const key = categoryFor(skill)
      groups.set(key, [...(groups.get(key) || []), skill])
    }

    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [visibleSkills])

  const totalSkills = skills?.length || 0
  const enabledToolsets = toolsets?.filter(toolset => toolset.enabled).length || 0

  async function handleToggleSkill(skill: SkillInfo, enabled: boolean) {
    setSavingSkill(skill.name)

    try {
      await toggleSkill(skill.name, enabled)
      setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)
      notify({
        kind: 'success',
        title: enabled ? '技能已启用' : '技能已禁用',
        message: `${skill.name} 将在新建会话中生效。`
      })
    } catch (err) {
      notifyError(err, `更新 ${skill.name} 失败`)
    } finally {
      setSavingSkill(null)
    }
  }

  async function handleToggleToolset(toolset: ToolsetInfo, enabled: boolean) {
    setSavingToolset(toolset.name)

    try {
      await toggleToolset(toolset.name, enabled)
      setToolsets(
        current =>
          current?.map(row => (row.name === toolset.name ? { ...row, enabled, available: enabled } : row)) ?? current
      )
      notify({
        kind: 'success',
        title: enabled ? '工具集已启用' : '工具集已禁用',
        message: `${toolsetDisplayLabel(toolset)} 将在新建会话中生效。`
      })
    } catch (err) {
      notifyError(err, `更新 ${toolsetDisplayLabel(toolset)} 失败`)
    } finally {
      setSavingToolset(null)
    }
  }

  return (
    <PageSearchShell
      {...props}
      className={cn(embedded && 'pt-0', className)}
      filters={
        mode === 'skills' && categories.length > 0 ? (
          <>
            <TextTab active={activeCategory === null} onClick={() => setActiveCategory(null)}>
              全部 <TextTabMeta>{totalSkills}</TextTabMeta>
            </TextTab>
            {categories.map(category => (
              <TextTab
                active={activeCategory === category.key}
                key={category.key}
                onClick={() => setActiveCategory(activeCategory === category.key ? null : category.key)}
              >
                {prettyName(category.key)} <TextTabMeta>{category.count}</TextTabMeta>
              </TextTab>
            ))}
          </>
        ) : undefined
      }
      onSearchChange={setQuery}
      searchHidden={mode === 'skills' ? (skills?.length ?? 0) === 0 : (toolsets?.length ?? 0) === 0}
      searchPlaceholder={mode === 'skills' ? '搜索技能...' : '搜索工具集...'}
      searchValue={query}
      tabs={
        <>
          <TextTab active={mode === 'skills'} onClick={() => setMode('skills')}>
            已安装
          </TextTab>
          <TextTab active={mode === 'toolsets'} onClick={() => setMode('toolsets')}>
            工具集
          </TextTab>
        </>
      }
    >
      {!skills || !toolsets ? (
        <PageLoader label="加载中..." />
      ) : mode === 'skills' ? (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          {visibleSkills.length === 0 ? (
            <EmptyState description="请尝试更宽泛的搜索词或不同分类。" title="未找到技能" />
          ) : (
            <div className="space-y-4">
              {skillGroups.map(([category, list]) => (
                <div className="space-y-1.5" key={category}>
                  {activeCategory === null && (
                    <div className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {prettyName(category)}
                    </div>
                  )}
                  <div>
                    {list.map(skill => (
                      <div
                        className="grid gap-3 px-0 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                        key={skill.name}
                      >
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="truncate text-sm font-medium">{skill.name}</div>
                            <Badge className={skillOriginMeta(skill).className}>{skillOriginMeta(skill).label}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {asText(skill.description) || '暂无描述。'}
                          </p>
                        </div>
                        <Switch
                          checked={skill.enabled}
                          disabled={savingSkill === skill.name}
                          onCheckedChange={checked => void handleToggleSkill(skill, checked)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
          {visibleToolsets.length === 0 ? (
            <EmptyState description="请尝试更宽泛的搜索词。" title="未找到工具集" />
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">
                {enabledToolsets}/{toolsets.length} 个工具集已启用
              </div>
              <div>
                {visibleToolsets.map(toolset => {
                  const tools = toolNames(toolset)
                  const label = toolsetDisplayLabel(toolset)
                  const expanded = expandedToolset === toolset.name

                  return (
                    <div className="px-0 py-2.5" key={toolset.name}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium">{label}</div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            aria-expanded={expanded}
                            aria-label={`配置 ${label}`}
                            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() =>
                              setExpandedToolset(current => (current === toolset.name ? null : toolset.name))
                            }
                            type="button"
                          >
                            <StatusPill active={toolset.configured}>
                              {toolset.configured ? '已配置' : '需要密钥'}
                            </StatusPill>
                          </button>
                          <Switch
                            aria-label={`切换 ${label} 工具集`}
                            checked={toolset.enabled}
                            disabled={savingToolset === toolset.name}
                            onCheckedChange={checked => void handleToggleToolset(toolset, checked)}
                          />
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {asText(toolset.description) || '暂无描述。'}
                      </p>
                      {tools.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {tools.map(name => (
                            <span
                              className="rounded-full bg-(--ui-bg-quaternary) px-2 py-0.5 font-mono text-[0.65rem] text-(--ui-text-tertiary)"
                              key={name}
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                      {expanded && <ToolsetConfigPanel onConfiguredChange={refreshToolsets} toolset={toolset.name} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </PageSearchShell>
  )
}

function StatusPill({ active, children }: { active: boolean; children: string }) {
  return (
    <Badge
      className={
        active ? 'bg-(--ui-bg-tertiary) text-(--ui-text-secondary)' : 'bg-(--ui-bg-quinary) text-(--ui-text-tertiary)'
      }
    >
      {children}
    </Badge>
  )
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="grid min-h-52 place-items-center text-center">
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{description}</div>
        {action}
      </div>
    </div>
  )
}
