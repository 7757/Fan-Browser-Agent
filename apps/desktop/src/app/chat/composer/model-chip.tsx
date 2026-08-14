import { useStore } from '@nanostores/react'
import { Check, ChevronDown, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  fetchAvailableModels,
  resolveComposerModel,
  setSessionModel
} from '@/lib/model-session'
import { displayModelName } from '@/lib/model-status-label'
import { usageContextLabel } from '@/lib/statusbar'
import { cn } from '@/lib/utils'
import { $gateway } from '@/store/gateway'
import {
  $activeSessionId,
  $availableModels,
  $currentModel,
  $currentUsage,
  $pendingModel,
  setCurrentModel,
  setPendingModel
} from '@/store/session'

// In-composer model chip + switcher popover, modelled on the Pencil "Model
// Switcher" (badwork.pen h6hSoG). It switches the active brain LLM; a selected
// vision model receives images natively, while text models use the server's
// vision-capable auxiliary model. The options come from the gateway `models.list`
// RPC; selecting one calls config.set (per-session,
// same scope as the YOLO flag). The popover wears the project's frosted-glass
// material (.glass-panel) rather than the opaque float-recipe — a deliberate
// per-request deviation (semi-transparent fill + 22px backdrop blur + soft glass
// shadow, 16px).

export function ModelChip() {
  const gateway = useStore($gateway)
  const sessionId = useStore($activeSessionId)
  const model = useStore($currentModel)
  const pendingModel = useStore($pendingModel)
  const usage = useStore($currentUsage)
  const models = useStore($availableModels)

  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  // Load the selectable brain models once the gateway is up; the helper no-ops
  // after the (static) list is cached.
  useEffect(() => {
    if (!gateway) {
      return
    }

    fetchAvailableModels((method, params) => gateway.request(method, params), sessionId).catch(() => {
      // Non-fatal: the chip falls back to the current model until the list loads.
    })
  }, [gateway, sessionId])

  const contextLabel = usageContextLabel(usage)

  const contextPercent = usage.context_max
    ? Math.max(0, Math.min(100, Math.round(usage.context_percent ?? 0)))
    : null

  // On a fresh chat the global model is '' (use-default), so $currentModel stays
  // empty until the first turn populates it — which used to hide this chip until
  // a message was sent. Fall back to the default brain (first selectable; also
  // seeded into $currentModel by fetchAvailableModels) so the switcher shows and
  // is pickable beforehand. Only truly hide when there's neither a current model
  // nor a loaded list yet.
  const effectiveModel = resolveComposerModel(sessionId, pendingModel, model, models)

  // NEVER fully unmount. When the model isn't known yet (models.list still in
  // flight, or it transiently failed during a gateway restart) we keep a neutral
  // placeholder chip instead of returning null. Unmounting made the switcher
  // vanish on every gateway hiccup and only reappear after the first turn
  // populated $currentModel — confusing. Staying mounted also means opening it
  // re-runs fetchAvailableModels (handleOpenChange) and self-heals.

  // Always surface the current model so the popover reflects reality even when
  // the active model isn't one of the selectable brains (an older global default
  // like qwen3-vl-plus, or a resumed session) — it shows up highlighted, while
  // switching still targets the gateway-validated list. Prefer the registry label
  // (correct casing, e.g. "DeepSeek") and fall back to the derived name.
  const fallbackRow = effectiveModel
    ? { id: effectiveModel, label: displayModelName(effectiveModel) }
    : null
  const inList = models.some((m) => m.id === effectiveModel)
  const rows =
    models.length > 0 ? (inList || !fallbackRow ? models : [fallbackRow, ...models]) : fallbackRow ? [fallbackRow] : []
  const currentLabel = effectiveModel
    ? (rows.find((m) => m.id === effectiveModel)?.label ?? displayModelName(effectiveModel))
    : '模型'
  const handleSelect = async (next: string) => {
    if (!gateway || !next || next === effectiveModel || switching) {
      setOpen(false)

      return
    }

    // Draft (no session yet): the gateway can't bind a model without a session id.
    // Stash the pick optimistically + as pending so the create flow replays it via
    // setSessionModel once the session is born (and so the chip reflects it now).
    if (!sessionId) {
      setCurrentModel(next)
      setPendingModel(next)
      setOpen(false)

      return
    }

    setSwitching(true)

    try {
      await setSessionModel((method, params) => gateway.request(method, params), sessionId, next)
    } catch {
      // Gateway rejected (e.g. unknown id) — leave the current model as-is.
    } finally {
      setSwitching(false)
      setOpen(false)
    }
  }

  const handleRefresh = async () => {
    if (!gateway || refreshing) {
      return
    }

    setRefreshing(true)
    setRefreshError('')

    try {
      await fetchAvailableModels((method, params) => gateway.request(method, params), sessionId, { refresh: true })
    } catch {
      // The helper only publishes a fully validated replacement.  Keep the
      // existing rows/current model visible and let the user retry in place.
      setRefreshError('刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  // Also (re)fetch when the popover opens: the on-mount fetch can fire before the
  // gateway socket is ready (unlike on-demand calls such as the YOLO toggle), and
  // it never retries once deps settle. Opening guarantees the socket is up, and
  // fetchAvailableModels no-ops once the list is cached — a cheap, reliable retry.
  const handleOpenChange = (next: boolean) => {
    setOpen(next)

    if (next && gateway) {
      fetchAvailableModels((method, params) => gateway.request(method, params), sessionId).catch(() => {})
    }
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        {/* Chip (design oUesi): surface-2 pill, blue dot + mono name + chevron. */}
        <button
          aria-label="模型与上下文"
          className="composer-glass-pill flex min-w-0 shrink items-center gap-[0.375rem] rounded-full py-[0.375rem] pr-2.5 pl-2.5 transition hover:bg-white/55 data-[state=open]:bg-white/60"
          type="button"
        >
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-primary" />
          {/* Width-capped + truncated so the chip stays compact on one row; the
              full name + id are in the popover below. */}
          <span className="max-w-[4.4rem] truncate font-mono text-[0.71875rem] font-medium tracking-[0.01em] text-[#1A1D21]">
            {currentLabel}
          </span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" strokeWidth={2.25} />
        </button>
      </PopoverTrigger>
      {/* `glass-panel` flips the float-recipe (opaque white) to frosted glass:
          semi-transparent fill + 22px backdrop blur + glass shadow + 16px radius
          (wins over the [data-slot='popover-content'] recipe by source order). */}
      <PopoverContent
        align="end"
        // The chip sits ~54px left of the composer's right edge (send 36 + gap 6
        // + surface pad 12). Shift the end-aligned popover right by that so its
        // right edge meets the composer card's right edge, per the design.
        alignOffset={-54}
        className="glass-panel w-[264px] overflow-hidden p-0"
        side="top"
        sideOffset={60}
        // Shrink the panel to 85% WITHOUT moving where it floats: `zoom` scales
        // the real layout box, so Radix re-anchors the smaller box's bottom+right
        // edges to the trigger (float height + position unchanged). Unlike a
        // static `transform: scale`, it doesn't fight the open/close zoom-95
        // animation (which already drives `transform`). `sideOffset`/`alignOffset`
        // act on the popper wrapper in screen px, so the gap is untouched.
        style={{ zoom: 0.85 }}
      >
        {/* Header — label + selectable-model count. */}
        <div className="flex items-center justify-between px-4 pt-[13px] pb-[7px]">
          <span className="text-[0.6875rem] font-semibold tracking-[0.05em] text-(--ui-text-tertiary)">模型</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.625rem] text-(--ui-text-tertiary)">{rows.length}</span>
            <button
              aria-label={refreshing ? '正在刷新模型' : '刷新模型'}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[0.6875rem] font-medium text-(--ui-text-tertiary) transition hover:bg-black/[0.05] hover:text-foreground disabled:cursor-default disabled:opacity-60 dark:hover:bg-white/10"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
              type="button"
            >
              <RefreshCw aria-hidden className={cn('size-3', refreshing && 'animate-spin')} />
              {refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
        </div>

        {refreshError && (
          <div className="mx-4 mb-1.5 text-[0.6875rem] leading-4 text-destructive" role="alert">
            {refreshError}
          </div>
        )}

        {/* Selectable brain models — click to switch (per-session). */}
        <div
          aria-busy={refreshing}
          aria-live="polite"
          className="relative flex flex-col gap-0.5 px-2 pb-1.5"
        >
          {refreshing ? (
            <div className="absolute inset-0 z-10 grid place-items-center bg-white/55 backdrop-blur-[2px] dark:bg-black/35">
              <div className="flex items-center gap-2 rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-[0.6875rem] font-medium text-(--ui-text-secondary) shadow-sm dark:border-white/15 dark:bg-black/45">
                <RefreshCw aria-hidden className="size-3.5 animate-spin text-(--theme-primary)" />
                <span>正在更新模型</span>
              </div>
            </div>
          ) : null}
          {rows.length === 0 && (
            <div className="px-2.5 py-2 text-[0.8125rem] text-(--ui-text-tertiary)">加载中…</div>
          )}
          {rows.map((m) => {
            const selected = m.id === effectiveModel

            return (
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-[0.625rem] px-2.5 py-2 text-left transition disabled:opacity-100',
                  selected
                    ? 'bg-[color-mix(in_srgb,var(--theme-primary)_8%,transparent)]'
                    : 'hover:bg-(--ui-row-hover-background)'
                )}
                disabled={switching || refreshing}
                key={m.id}
                onClick={() => void handleSelect(m.id)}
                type="button"
              >
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-[0.4375rem]',
                    selected
                      ? 'bg-[color-mix(in_srgb,var(--theme-primary)_12%,transparent)]'
                      : 'bg-black/[0.05] dark:bg-white/10'
                  )}
                >
                  <Sparkles
                    className={cn('size-[0.8125rem]', selected ? 'text-(--theme-primary)' : 'text-(--ui-text-tertiary)')}
                  />
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span
                    className={cn(
                      'truncate text-[0.8125rem] font-semibold',
                      selected ? 'text-(--theme-primary)' : 'text-foreground'
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="truncate font-mono text-[0.65625rem] text-(--ui-text-tertiary)">{m.id}</span>
                </span>
                <span className="flex-1" />
                {selected && <Check aria-hidden className="size-[0.9375rem] shrink-0 text-(--theme-primary)" />}
              </button>
            )
          })}
        </div>

        <div className="h-px bg-border" />

        {/* Context usage. */}
        <div className="flex flex-col gap-[9px] px-4 pt-3 pb-[14px]">
          <div className="flex items-center justify-between">
            <span className="text-[0.75rem] font-medium text-(--ui-text-secondary)">上下文</span>
            {contextPercent !== null && (
              <span className="font-mono text-xs text-(--ui-text-secondary)">{contextPercent}%</span>
            )}
          </div>
          {contextLabel ? (
            <>
              <span className="font-mono text-[0.78125rem] text-foreground">{contextLabel}</span>
              {contextPercent !== null && (
                <div className="h-1.5 overflow-hidden rounded-full bg-[#e6eaf0] dark:bg-(--ui-bg-quaternary)">
                  <div
                    className={cn('h-full rounded-full bg-primary', contextPercent >= 85 && 'bg-(--ui-yellow)')}
                    style={{ width: `${contextPercent}%` }}
                  />
                </div>
              )}
            </>
          ) : (
            <span className="text-[0.71875rem] text-(--ui-text-quaternary)">本会话暂无用量数据</span>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
