import { useStore } from '@nanostores/react'
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogAction,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { saveModelProvider } from '@/fan'
import { useI18n } from '@/i18n'
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $modelProviderSetup,
  applySavedModelProvider,
  modelProviderErrorMessage,
  refreshModelProviders
} from '@/store/model-provider-setup'
import type { ModelProviderInfo, ModelProviderSaveResponse, ModelProvidersResponse } from '@/types/fan'

function orderedProviders(response: ModelProvidersResponse | null): ModelProviderInfo[] {
  return [...(response?.providers ?? [])].sort((left, right) => Number(right.recommended) - Number(left.recommended))
}

function ProviderPicker({
  onChange,
  providers,
  value
}: {
  onChange: (providerId: string) => void
  providers: ModelProviderInfo[]
  value: string
}) {
  const { t } = useI18n()

  return (
    <div aria-label={t('模型提供商')} className="grid gap-2 sm:grid-cols-2" role="radiogroup">
      {providers.map(provider => {
        const selected = provider.id === value

        return (
          <button
            aria-checked={selected}
            className={cn(
              'relative grid min-h-20 gap-1 rounded-xl border px-3.5 py-3 text-left transition',
              selected
                ? 'border-primary/55 bg-primary/8 shadow-[0_0_0_1px_color-mix(in_srgb,var(--dt-primary)_18%,transparent)]'
                : 'border-border/60 bg-background/50 hover:border-border hover:bg-muted/35'
            )}
            key={provider.id}
            onClick={() => onChange(provider.id)}
            role="radio"
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{provider.name}</span>
              {provider.recommended ? (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[0.62rem] font-medium text-primary">
                  {t('推荐')}
                </span>
              ) : null}
              {provider.configured ? <CheckCircle2 className="ml-auto size-3.5 shrink-0 text-emerald-500" /> : null}
            </span>
            <span className="line-clamp-2 text-[0.7rem] leading-4 text-(--ui-text-tertiary)">
              {provider.description ||
                (provider.auth_type === 'none' ? t('无需 API Key') : t('使用你自己的 API Key'))}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function ProviderConfigForm({
  allowCancel = false,
  onCancel,
  onSaved,
  response
}: {
  allowCancel?: boolean
  onCancel?: () => void
  onSaved?: (result: ModelProviderSaveResponse) => void
  response: ModelProvidersResponse
}) {
  const { t } = useI18n()
  const apiKeyId = useId()
  const baseUrlId = useId()
  const errorId = useId()
  const providers = useMemo(() => orderedProviders(response), [response])
  const initialProvider =
    providers.find(provider => provider.id === response.configured_provider) ?? providers[0] ?? null
  const [providerId, setProviderId] = useState(initialProvider?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initialProvider?.base_url ?? '')
  const [model, setModel] = useState(
    initialProvider?.id === response.configured_provider
      ? response.configured_model || initialProvider.default_model
      : initialProvider?.default_model ?? ''
  )
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [saving, setSaving] = useState(false)

  const provider = providers.find(item => item.id === providerId) ?? null
  const needsApiKey = Boolean(provider && provider.auth_type !== 'none')
  const needsBaseUrl = Boolean(provider && (provider.requires_base_url || provider.auth_type === 'custom'))
  // OpenAI-compatible custom endpoints may be local and intentionally have no
  // authentication. Keep the field available, but only require keys for the
  // built-in hosted providers.
  const keyRequired = Boolean(provider && needsApiKey && provider.auth_type !== 'custom' && !provider.configured)
  const baseUrlRequired = Boolean(needsBaseUrl && provider?.requires_base_url)
  const modelRequired = Boolean(provider && provider.models.length === 0)
  const canSave = Boolean(
    provider &&
      (!keyRequired || apiKey.trim()) &&
      (!baseUrlRequired || baseUrl.trim()) &&
      (!modelRequired || model.trim()) &&
      !saving
  )

  const chooseProvider = (nextId: string) => {
    const next = providers.find(item => item.id === nextId)

    if (!next) {
      return
    }

    setProviderId(next.id)
    setApiKey('')
    setBaseUrl(next.base_url ?? '')
    setModel(next.id === response.configured_provider ? response.configured_model || next.default_model : next.default_model)
    setError(null)
    setRevealed(false)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!provider || !canSave) {
      return
    }

    setError(null)
    setSaving(true)

    try {
      const result = await saveModelProvider({
        provider: provider.id,
        ...(needsApiKey && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        ...(needsBaseUrl && baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {})
      })

      if (!result.ok || !result.verified || !result.configured_provider) {
        throw new Error(t('模型提供商未能保存，请检查配置后重试。'))
      }

      applySavedModelProvider(result)
      setApiKey('')
      onSaved?.(result)
    } catch (caught) {
      setError(modelProviderErrorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  if (providers.length === 0) {
    return (
      <div className="grid gap-3">
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('本机后端没有返回可用的模型提供商。')}</span>
        </div>
        <DialogFooter>
          <DialogAction onClick={() => void refreshModelProviders().catch(() => undefined)} type="button">
            <RefreshCw />
            {t('重新加载')}
          </DialogAction>
        </DialogFooter>
      </div>
    )
  }

  return (
    <form className="grid gap-4" onSubmit={event => void submit(event)}>
      <ProviderPicker onChange={chooseProvider} providers={providers} value={providerId} />

      {provider ? (
        <div className="grid gap-3 rounded-xl border border-border/55 bg-background/35 p-3.5">
          {needsApiKey ? (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor={apiKeyId}>
                {provider.env_var || t('API Key')}
              </label>
              <div className="relative">
                <Input
                  aria-describedby={error ? errorId : undefined}
                  aria-invalid={Boolean(error)}
                  autoComplete="off"
                  className="h-9 w-full pr-10 font-mono"
                  disabled={saving}
                  id={apiKeyId}
                  onChange={event => {
                    setApiKey(event.target.value)
                    setError(null)
                  }}
                  placeholder={
                    provider.configured && provider.masked_key
                      ? t(`留空继续使用 ${provider.masked_key}`)
                      : provider.auth_type === 'custom'
                        ? t('可选，本地端点通常无需 Key')
                        : 'sk-…'
                  }
                  spellCheck={false}
                  type={revealed ? 'text' : 'password'}
                  value={apiKey}
                />
                <Button
                  aria-label={revealed ? t('隐藏 Key') : t('显示 Key')}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
                  disabled={saving}
                  onClick={() => setRevealed(value => !value)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  {revealed ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              <p className="text-[0.68rem] leading-4 text-(--ui-text-tertiary)">
                {t('凭据由本机后端保存；完整 Key 不会返回到界面。')}
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-(--ui-text-secondary)">
              <CheckCircle2 className="size-4 text-emerald-500" />
              {t('此提供商无需 API Key。')}
            </div>
          )}

          {needsBaseUrl ? (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor={baseUrlId}>
                {t('Base URL')}
              </label>
              <Input
                disabled={saving}
                id={baseUrlId}
                inputMode="url"
                onChange={event => {
                  setBaseUrl(event.target.value)
                  setError(null)
                }}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                type="url"
                value={baseUrl}
              />
            </div>
          ) : null}

          {provider.models.length > 0 ? (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-foreground">{t('默认模型')}</label>
              <Select disabled={saving} onValueChange={setModel} value={model || provider.default_model}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {provider.models.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label || option.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor={`${baseUrlId}-model`}>
                {t('模型 ID')}
              </label>
              <Input
                disabled={saving}
                id={`${baseUrlId}-model`}
                onChange={event => {
                  setModel(event.target.value)
                  setError(null)
                }}
                placeholder="model-name"
                spellCheck={false}
                value={model}
              />
              <p className="text-[0.68rem] leading-4 text-(--ui-text-tertiary)">
                {t('填写该 OpenAI 兼容端点公开的模型标识。')}
              </p>
            </div>
          )}

          {error ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
              id={errorId}
              role="alert"
            >
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        {allowCancel ? (
          <DialogAction disabled={saving} onClick={onCancel} tone="ghost" type="button">
            {t('取消')}
          </DialogAction>
        ) : null}
        <DialogAction disabled={!canSave} type="submit">
          {saving ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {saving ? t('正在验证…') : t('验证并保存')}
        </DialogAction>
      </DialogFooter>
    </form>
  )
}

function ProviderReadFailure() {
  const { t } = useI18n()
  const state = useStore($modelProviderSetup)

  return (
    <div className="grid gap-3">
      <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>{state.error ?? t('无法读取本机模型提供商配置。')}</span>
      </div>
      <DialogFooter>
        <DialogAction onClick={() => void refreshModelProviders().catch(() => undefined)} type="button">
          <RefreshCw />
          {t('重试')}
        </DialogAction>
      </DialogFooter>
    </div>
  )
}

export function ModelProviderSetupOverlay({
  onConfigured,
  visible
}: {
  onConfigured?: () => void
  visible: boolean
}) {
  const { t } = useI18n()
  const state = useStore($modelProviderSetup)

  useEffect(() => {
    if (visible && state.phase === 'idle') {
      void refreshModelProviders().catch(() => undefined)
    }
  }, [state.phase, visible])

  if (!visible || state.response?.configured_provider) {
    return null
  }

  const loading = state.phase === 'idle' || state.phase === 'loading'

  return (
    <Dialog open>
      <DialogContent
        aria-describedby="model-provider-setup-description"
        className="z-[1260] max-w-[38rem]"
        onEscapeKeyDown={event => event.preventDefault()}
        onInteractOutside={event => event.preventDefault()}
        overlayClassName="z-[1250]"
        showCloseButton={false}
      >
        <DialogHeader className="gap-2">
          <div className="mb-1 grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </div>
          <DialogTitle>{t('选择模型提供商')}</DialogTitle>
          <DialogDescription id="model-provider-setup-description">
            {t('选择提供商并验证凭据后即可开始使用。')}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-(--ui-text-secondary)" role="status">
            <Loader2 className="size-4 animate-spin text-primary" />
            {t('正在读取本机模型配置…')}
          </div>
        ) : state.phase === 'error' || !state.response ? (
          <ProviderReadFailure />
        ) : (
          <ProviderConfigForm onSaved={() => onConfigured?.()} response={state.response} />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ModelProviderSettingsCard({ onConfigured }: { onConfigured?: () => void }) {
  const { t } = useI18n()
  const state = useStore($modelProviderSetup)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (state.phase === 'idle') {
      void refreshModelProviders().catch(() => undefined)
    }
  }, [state.phase])

  const response = state.response
  const provider = response?.providers.find(item => item.id === response.configured_provider) ?? null
  const configured = Boolean(response?.configured_provider)
  const modelLabel =
    provider?.models.find(option => option.id === response?.configured_model)?.label ?? response?.configured_model

  return (
    <>
      <div className="rounded-xl border border-border/60 bg-card/35 px-4">
        <div className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[length:var(--conversation-text-font-size)] font-medium">
              <span>{provider?.name || t('模型提供商')}</span>
              {configured ? (
                <span className="inline-flex items-center gap-1 text-[0.7rem] font-normal text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  {t('已配置')}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-5 text-(--ui-text-tertiary)">
              {state.phase === 'loading' || state.phase === 'idle'
                ? t('正在读取本机配置…')
                : state.phase === 'error'
                  ? state.error
                  : configured
                    ? provider?.masked_key || (provider?.auth_type === 'none' ? t('无需 API Key') : t('凭据已保存到本机'))
                    : t('尚未选择模型提供商')}
            </div>
            {configured && (modelLabel || provider?.base_url) ? (
              <div className="mt-1 truncate font-mono text-[0.68rem] text-muted-foreground/55">
                {[modelLabel, provider?.base_url].filter(Boolean).join(' · ')}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {state.phase === 'error' && !response ? (
              <Button
                onClick={() => void refreshModelProviders().catch(() => undefined)}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw />
                {t('重试')}
              </Button>
            ) : (
              <Button
                disabled={state.phase === 'loading' || state.phase === 'idle' || !response}
                onClick={() => setEditing(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                <KeyRound />
                {configured ? t('切换或更新') : t('配置提供商')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog onOpenChange={setEditing} open={editing}>
        <DialogContent className="max-w-[38rem]">
          <DialogHeader>
            <DialogTitle>{configured ? t('切换模型提供商') : t('配置模型提供商')}</DialogTitle>
            <DialogDescription>
              {t('选择提供商、模型和本机凭据。验证成功后会用于新会话。')}
            </DialogDescription>
          </DialogHeader>
          {response ? (
            <ProviderConfigForm
              allowCancel
              onCancel={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                onConfigured?.()
              }}
              response={response}
            />
          ) : (
            <ProviderReadFailure />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
