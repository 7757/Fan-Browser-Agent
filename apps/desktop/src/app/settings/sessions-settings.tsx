import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { deleteSession, listSessions, setSessionArchived } from '@/fan'
import { useI18n } from '@/i18n'
import { sessionTitle } from '@/lib/chat-runtime'
import { triggerHaptic } from '@/lib/haptics'
import { Archive, ArchiveOff, FolderOpen, Loader2, Trash2 } from '@/lib/icons'
import { playDeleteSound } from '@/lib/sound'
import { notify, notifyError } from '@/store/notifications'
import { applyConfiguredDefaultProjectDir, setSessions } from '@/store/session'
import type { SessionInfo } from '@/types/fan'

import { EmptyState, ListRow, LoadingState, SectionHeading, SettingsContent } from './primitives'
import { useDeepLinkHighlight } from './use-deep-link-highlight'

const ARCHIVED_FETCH_LIMIT = 200

function workspaceLabel(cwd: null | string | undefined): string {
  const path = cwd?.trim()

  if (!path) {
    return ''
  }

  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ?? path
  )
}

export function SessionsSettings() {
  const { language, t } = useI18n()
  const [sessions, setLocalSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<{ id: string; type: 'delete' | 'restore' } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)

    try {
      const result = await listSessions(ARCHIVED_FETCH_LIMIT, 0, 'only')
      setLocalSessions(result.sessions)
    } catch (err) {
      notifyError(err, t('无法加载已归档的会话'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const unarchive = useCallback(async (session: SessionInfo) => {
    setBusyAction({ id: session.id, type: 'restore' })

    try {
      await setSessionArchived(session.id, false)
      setLocalSessions(prev => prev.filter(s => s.id !== session.id))
      // Surface it again in the sidebar without waiting for a full refresh.
      setSessions(prev => [{ ...session, archived: false }, ...prev.filter(s => s.id !== session.id)])
      triggerHaptic('selection')
    } catch (err) {
      notifyError(err, t('取消归档失败'))
    } finally {
      setBusyAction(null)
    }
  }, [t])

  const remove = useCallback(async (session: SessionInfo) => {
    setBusyAction({ id: session.id, type: 'delete' })

    try {
      await deleteSession(session.id)
      // Final deletion must also purge the session's browser partition (cookies/
      // logins on disk). Archived sessions keep theirs by design — but THIS is
      // the permanent-delete path, and it previously left them behind forever.
      void window.fanDesktop?.browser?.destroy?.(session.id, { reapPartition: true })
      setLocalSessions(prev => prev.filter(s => s.id !== session.id))
      playDeleteSound()
      triggerHaptic('warning')
    } catch (err) {
      notifyError(err, t('永久删除失败'))
    } finally {
      setBusyAction(null)
    }
  }, [t])

  useDeepLinkHighlight({
    elementId: id => `archived-session-${id}`,
    param: 'session',
    ready: id => !loading && sessions.some(session => session.id === id)
  })

  if (loading) {
    return <LoadingState label={t('正在加载已归档会话…')} />
  }

  return (
    <SettingsContent>
      <DefaultProjectDirSetting />

      <section className="archive-settings-section">
        <div className="archive-settings-section__header">
          <SectionHeading
            icon={Archive}
            meta={sessions.length ? String(sessions.length) : undefined}
            title={t('已归档的会话')}
          />
          <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {t('已归档的聊天会从侧栏隐藏，但保留所有消息。在侧栏中按住 Ctrl/⌘ 点击聊天可将其归档。')}
          </p>
        </div>

        {sessions.length === 0 ? (
          <EmptyState description={t('归档聊天后将在此显示。')} title={t('暂无归档')} />
        ) : (
          <div className="archive-session-list">
            {sessions.map(session => {
              const label = workspaceLabel(session.cwd)
              const busy = busyAction?.id === session.id
              const deleting = busy && busyAction.type === 'delete'
              const restoring = busy && busyAction.type === 'restore'

              return (
                <article
                  aria-busy={busy || undefined}
                  className="archive-session-row scroll-mt-6"
                  id={`archived-session-${session.id}`}
                  key={session.id}
                >
                  <ListRow
                    action={
                      <div className="archive-session-row__actions">
                        <Button
                          disabled={busyAction !== null}
                          onClick={() => void unarchive(session)}
                          size="sm"
                          type="button"
                          variant="textStrong"
                        >
                          {restoring ? <Loader2 className="size-3.5 animate-spin" /> : <ArchiveOff className="size-3.5" />}
                          <span>{t('恢复')}</span>
                        </Button>
                        <Tip label={t('永久删除')}>
                          <Button
                            aria-label={t('永久删除')}
                            className="text-muted-foreground hover:text-destructive"
                            disabled={busyAction !== null}
                            onClick={() => void remove(session)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                          </Button>
                        </Tip>
                      </div>
                    }
                    description={session.preview ? <span className="line-clamp-2">{session.preview}</span> : undefined}
                    hint={
                      language === 'en'
                        ? `${label ? `${label} · ` : ''}${session.message_count} ${session.message_count === 1 ? 'message' : 'messages'}`
                        : label
                          ? `${label} · ${session.message_count} 条消息`
                          : `${session.message_count} 条消息`
                    }
                    title={sessionTitle(session)}
                  />
                </article>
              )
            })}
          </div>
        )}
      </section>
    </SettingsContent>
  )
}

// Lets the user pin the default cwd for new sessions. Without this, packaged
// builds on Windows used to spawn sessions in the install dir (`win-unpacked`
// / Program Files), which buried any files Fan wrote there.
function DefaultProjectDirSetting() {
  const { language, t } = useI18n()
  const [dir, setDir] = useState<null | string>(null)
  const [fallback, setFallback] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The bridge is only present when running inside Electron. In a Vitest
    // / Storybook / non-Electron context `window.fanDesktop` is
    // undefined, so guard the WHOLE call chain rather than chaining
    // `?.settings.getDefaultProjectDir().then(...)` (the latter would
    // short-circuit to `undefined.then(...)` and throw at runtime).
    const settings = window.fanDesktop?.settings

    if (!settings) {
      return
    }

    let alive = true

    void settings.getDefaultProjectDir().then(result => {
      if (!alive) {
        return
      }

      setDir(result.dir)
      setFallback(result.defaultLabel)
    })

    return () => {
      alive = false
    }
  }, [])

  const choose = useCallback(async () => {
    const settings = window.fanDesktop?.settings

    if (!settings) {
      return
    }

    setBusy(true)

    try {
      const picked = await settings.pickDefaultProjectDir()

      if (picked.canceled || !picked.dir) {
        return
      }

      const result = await settings.setDefaultProjectDir(picked.dir)
      setDir(result.dir)
      // Apply immediately so a new chat picks it up without an app restart.
      applyConfiguredDefaultProjectDir(result.dir)
      notify({ durationMs: 2_000, kind: 'success', message: t('默认项目目录已更新') })
    } catch (err) {
      notifyError(err, t('无法更新默认目录'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const clear = useCallback(async () => {
    const settings = window.fanDesktop?.settings

    if (!settings) {
      return
    }

    setBusy(true)

    try {
      await settings.setDefaultProjectDir(null)
      setDir(null)
      applyConfiguredDefaultProjectDir(null)
    } catch (err) {
      notifyError(err, t('无法清除默认目录'))
    } finally {
      setBusy(false)
    }
  }, [t])

  return (
    <section className="archive-project-card">
      <SectionHeading icon={FolderOpen} title={t('默认项目目录')} />
      <p className="archive-project-card__description text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {t('新会话会从此目录开始；也可以在创建时另行选择。')}
      </p>
      <ListRow
        action={
          <div className="archive-project-card__actions">
            <Button disabled={busy} onClick={() => void choose()} size="sm" type="button" variant="textStrong">
              <FolderOpen className="size-3.5" />
              <span>{t(dir ? '更改' : '选择')}</span>
            </Button>
            {dir && (
              <Button disabled={busy} onClick={() => void clear()} size="sm" type="button" variant="text">
                {t('清除')}
              </Button>
            )}
          </div>
        }
        description={
          dir
            ? t('后续新会话将使用此目录。')
            : language === 'en'
              ? `Not set; ${fallback || t('你的主目录')} will be used.`
              : `未设置；将使用 ${fallback || '你的主目录'}。`
        }
        title={dir ? <span className="archive-project-card__path" title={dir}>{dir}</span> : t('尚未选择目录')}
      />
    </section>
  )
}
