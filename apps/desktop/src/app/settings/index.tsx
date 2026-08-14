import { lazy, Suspense } from 'react'

import { useI18n } from '@/i18n'
import { Archive, Brain, FileText, Info, SlidersHorizontal, Wrench, Zap } from '@/lib/icons'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'

// Lazy like desktop-controller's standalone overlays — keeps the heavy views
// out of the settings module graph until their tab is actually opened.
const AgentsView = lazy(() => import('../agents').then(m => ({ default: m.AgentsView })))
const CronView = lazy(() => import('../cron').then(m => ({ default: m.CronView })))
const SkillsView = lazy(() => import('../skills').then(m => ({ default: m.SkillsView })))
const ArtifactsView = lazy(() => import('../artifacts').then(m => ({ default: m.ArtifactsView })))
import { OverlayMain, OverlayNavItem, OverlaySidebar, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'

import { AboutSettings } from './about-settings'
import { ConfigSettings } from './config-settings'
import { SETTINGS_NAV_SECTIONS } from './constants'
import { McpSettings } from './mcp-settings'
import { SessionsSettings } from './sessions-settings'
import type { SettingsPageProps, SettingsView as SettingsViewId } from './types'

const SETTINGS_VIEWS: readonly SettingsViewId[] = [
  ...SETTINGS_NAV_SECTIONS.map(s => `config:${s.id}` as SettingsViewId),
  'mcp',
  'sessions',
  'agents',
  'cron',
  'skills',
  'artifacts',
  'about'
]

export function SettingsView({
  gateway,
  onClose,
  onConfigSaved
}: SettingsPageProps) {
  const { t } = useI18n()
  const [activeView, setActiveView] = useRouteEnumParam('tab', SETTINGS_VIEWS, 'config:chat' as SettingsViewId)
  return (
    <OverlayView closeLabel={t('关闭设置')} onClose={onClose} rootClassName="settings-liquid-shell">
      <OverlaySplitLayout>
        <OverlaySidebar>
          <OverlayNavItem
            active={activeView.startsWith('config:')}
            icon={SlidersHorizontal}
            label={t('偏好')}
            onClick={() => setActiveView('config:chat')}
          />
          <OverlayNavItem
            active={activeView === 'mcp'}
            icon={Wrench}
            label={t('MCP 配置')}
            onClick={() => setActiveView('mcp')}
          />
          <OverlayNavItem
            active={activeView === 'agents'}
            icon={Brain}
            label={t('子代理')}
            onClick={() => setActiveView('agents')}
          />
          <OverlayNavItem
            active={activeView === 'cron'}
            icon={Zap}
            label={t('自动任务')}
            onClick={() => setActiveView('cron')}
          />
          <OverlayNavItem
            active={activeView === 'artifacts'}
            icon={FileText}
            label={t('产物')}
            onClick={() => setActiveView('artifacts')}
          />
          {/* 三组:配置 | 内容/工具 | 关于。 */}
          <div className="my-2 h-px bg-border/30" />
          <OverlayNavItem
            active={activeView === 'sessions'}
            icon={Archive}
            label={t('归档')}
            onClick={() => setActiveView('sessions')}
          />
          <OverlayNavItem
            active={activeView === 'skills'}
            icon={Zap}
            label={t('技能')}
            onClick={() => setActiveView('skills')}
          />
          <div className="my-2 h-px bg-border/30" />
          <OverlayNavItem
            active={activeView === 'about'}
            icon={Info}
            label={t('关于')}
            onClick={() => setActiveView('about')}
          />
        </OverlaySidebar>

        <OverlayMain className="px-0 pb-0 pt-[calc(var(--titlebar-height)+1rem)]">
          {activeView === 'about' ? (
            <AboutSettings />
          ) : activeView.startsWith('config:') ? (
            <ConfigSettings
              activeSectionId={activeView.slice('config:'.length)}
              gateway={gateway}
              onActiveSectionChange={sectionId => setActiveView(`config:${sectionId}` as SettingsViewId)}
              onConfigSaved={onConfigSaved}
            />
          ) : activeView === 'mcp' ? (
            <McpSettings gateway={gateway} onConfigSaved={onConfigSaved} />
          ) : activeView === 'agents' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4 sm:px-6">
              <Suspense fallback={null}>
                <AgentsView embedded />
              </Suspense>
            </div>
          ) : activeView === 'cron' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4 sm:px-6">
              <Suspense fallback={null}>
                <CronView embedded />
              </Suspense>
            </div>
          ) : activeView === 'skills' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4 sm:px-6">
              <Suspense fallback={null}>
                <SkillsView embedded />
              </Suspense>
            </div>
          ) : activeView === 'artifacts' ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4 sm:px-6">
              <Suspense fallback={null}>
                <ArtifactsView embedded />
              </Suspense>
            </div>
          ) : (
            <SessionsSettings />
          )}
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

export { SettingsView as SettingsPage }
