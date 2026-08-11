import { Check, Download, Plus, Trash2, Wifi } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDesktop } from '../../../desktop/use-desktop'
import { SettingGroup, TextField } from '../../../shared/ui/controls'
import type { AppSettings, ProviderSettings } from '../types'
import { primaryProviderKeyDraft } from '../provider-key-draft'
import { copyFor, formatCopy } from '../../../shared/ui-copy'

type ProviderStatus = { tone: 'neutral' | 'success' | 'error'; message: string }
type SettingsUpdater = (update: (current: AppSettings) => AppSettings) => void
export type ProviderKeyTextDrafts = Record<string, string>
type ProviderRequestContext = {
  id: string
  sequence: number
  provider: ProviderSettings
  hasKeyDraft: boolean
  keyDraft: string | undefined
}

function newProvider(): ProviderSettings {
  return {
    id: crypto.randomUUID(),
    name: 'OpenAI Compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyCount: 0,
    availableModels: [],
    enabledModels: [],
  }
}

function redactKeyError(message: string, keys: string[]): string {
  return keys.reduce(
    (current, key) => key.length === 0 ? current : current.split(key).join('***'),
    message,
  )
}

export function ProvidersSection({
  settings,
  onChange,
  keyDrafts,
  onKeyDraftChange,
  onKeyDraftRemove,
  saving,
}: {
  settings: AppSettings
  onChange: SettingsUpdater
  keyDrafts: ProviderKeyTextDrafts
  onKeyDraftChange: (providerId: string, value: string) => void
  onKeyDraftRemove: (providerId: string) => void
  saving: boolean
}) {
  const t = copyFor(settings.language)
  const desktop = useDesktop()
  const [manualModels, setManualModels] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({})
  const requestSequences = useRef<Record<string, number>>({})
  const settingsRef = useRef(settings)
  const keyDraftsRef = useRef(keyDrafts)
  const mountedRef = useRef(true)
  useLayoutEffect(() => {
    settingsRef.current = settings
    keyDraftsRef.current = keyDrafts
  }, [keyDrafts, settings])
  useEffect(() => {
    const sequences = requestSequences.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      Object.keys(sequences).forEach((id) => {
        sequences[id] = (sequences[id] ?? 0) + 1
      })
    }
  }, [])
  const clearStatus = (id: string) => {
    setStatuses((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, id)) return current
      return Object.fromEntries(Object.entries(current).filter(([providerId]) => providerId !== id))
    })
  }
  const invalidateProviderRequests = (id: string) => {
    requestSequences.current[id] = (requestSequences.current[id] ?? 0) + 1
    clearStatus(id)
  }
  const beginProviderRequest = (provider: ProviderSettings): ProviderRequestContext => {
    const id = provider.id
    const request = (requestSequences.current[id] ?? 0) + 1
    requestSequences.current[id] = request
    return {
      id,
      sequence: request,
      provider,
      hasKeyDraft: Object.prototype.hasOwnProperty.call(keyDrafts, id),
      keyDraft: keyDrafts[id],
    }
  }
  const requestIsCurrent = (request: ProviderRequestContext) => {
    if (!mountedRef.current || requestSequences.current[request.id] !== request.sequence) return false
    const currentProvider = settingsRef.current.providers.find((provider) => provider.id === request.id)
    if (currentProvider !== request.provider) return false
    const currentHasKeyDraft = Object.prototype.hasOwnProperty.call(keyDraftsRef.current, request.id)
    return currentHasKeyDraft === request.hasKeyDraft
      && keyDraftsRef.current[request.id] === request.keyDraft
  }
  const updateProvider = (
    id: string,
    patch: Partial<ProviderSettings> | ((current: ProviderSettings) => Partial<ProviderSettings>),
    invalidateRequests = true,
  ) => {
    if (invalidateRequests) invalidateProviderRequests(id)
    onChange((current) => ({
      ...current,
      providers: current.providers.map((provider) => {
        if (provider.id !== id) return provider
        return {
          ...provider,
          ...(typeof patch === 'function' ? patch(provider) : patch),
        }
      }),
    }))
  }
  const setStatus = (id: string, status: ProviderStatus) =>
    setStatuses((current) => ({ ...current, [id]: status }))
  const hasDraftKeys = (id: string) => Object.prototype.hasOwnProperty.call(keyDrafts, id)
  const draftKeys = (id: string) => hasDraftKeys(id)
    ? (keyDrafts[id] ?? '').split(/\r?\n/u).map((key) => key.trim()).filter(Boolean)
    : undefined
  return (
    <div data-screenpilot-provider-settings="true">
      <div className="section-heading">
        <div>
          <h1>{t.providersTitle}</h1>
          <p>{t.providersDescription}</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={saving}
          onClick={() => onChange((current) => ({
            ...current,
            providers: [...current.providers, newProvider()],
          }))}
        >
          <Plus size={15} />{t.add}
        </button>
      </div>
      {settings.providers.length === 0 ? (
        <div className="empty-panel">
          <Wifi size={24} />
          <span>{t.noProviders}</span>
          <small>{t.noProvidersDescription}</small>
        </div>
      ) : null}
      {settings.providers.map((provider) => {
        const status = statuses[provider.id]
        return (
          <SettingGroup title={provider.name || t.unnamedProvider} key={provider.id}>
            <div className="provider-form">
              <label>
                <span>{t.name}</span>
                <TextField
                  value={provider.name}
                  label={t.providerName}
                  disabled={saving}
                  onChange={(name) => updateProvider(provider.id, { name })}
                />
              </label>
              <label>
                <span>Base URL</span>
                <TextField
                  value={provider.baseUrl}
                  label={t.providerBaseUrl}
                  type="url"
                  disabled={saving}
                  onChange={(baseUrl) => updateProvider(provider.id, { baseUrl })}
                />
              </label>
              <label>
                <span>API Keys</span>
                <textarea
                  className="key-field"
                  value={hasDraftKeys(provider.id) ? keyDrafts[provider.id] ?? '' : ''}
                  aria-label={`${provider.name} API Keys`}
                  placeholder={provider.keyCount > 0
                    ? formatCopy(t.savedKeyCount, { count: provider.keyCount })
                    : t.oneKeyPerLine}
                  disabled={saving}
                  onChange={(event) => {
                    invalidateProviderRequests(provider.id)
                    onKeyDraftChange(provider.id, event.target.value)
                  }}
                />
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={async () => {
                    const values = draftKeys(provider.id)
                    const override = primaryProviderKeyDraft(values)
                    const request = beginProviderRequest(provider)
                    try {
                      const models = await desktop.fetchProviderModels(provider, override)
                      if (!requestIsCurrent(request)) return
                      updateProvider(provider.id, (current) => ({
                        availableModels: models,
                        enabledModels: current.enabledModels.filter((model) => models.includes(model)),
                      }), false)
                      setStatus(provider.id, {
                        tone: 'success',
                        message: formatCopy(t.modelsFetched, { count: models.length }),
                      })
                    } catch (error) {
                      if (!requestIsCurrent(request)) return
                      setStatus(provider.id, {
                        tone: 'error',
                        message: redactKeyError(String(error), values ?? []),
                      })
                    }
                  }}
                >
                  <Download size={14} />{t.fetchModels}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={async () => {
                    const values = draftKeys(provider.id)
                    const request = beginProviderRequest(provider)
                    try {
                      const result = await desktop.testProvider(provider, primaryProviderKeyDraft(values))
                      if (!requestIsCurrent(request)) return
                      setStatus(provider.id, {
                        tone: result.success ? 'success' : 'error',
                        message: result.success
                          ? t.connectionSucceeded
                          : redactKeyError(result.error ?? t.connectionFailed, values ?? []),
                      })
                    } catch (error) {
                      if (!requestIsCurrent(request)) return
                      setStatus(provider.id, {
                        tone: 'error',
                        message: redactKeyError(String(error), values ?? []),
                      })
                    }
                  }}
                >
                  <Wifi size={14} />{t.testConnection}
                </button>
                <button
                  type="button"
                  className="icon-button danger-button"
                  aria-label={formatCopy(t.deleteProvider, { name: provider.name })}
                  disabled={saving}
                  onClick={() => {
                    invalidateProviderRequests(provider.id)
                    onKeyDraftRemove(provider.id)
                    onChange((current) => ({
                      ...current,
                      providers: current.providers.filter((item) => item.id !== provider.id),
                    }))
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {status === undefined ? null : (
                <div className="inline-status" data-tone={status.tone} role="status">
                  {status.message}
                </div>
              )}
              <div className="manual-model">
                <TextField
                  value={manualModels[provider.id] ?? ''}
                  label={formatCopy(t.manualModelName, { name: provider.name })}
                  placeholder={t.manualModelPlaceholder}
                  disabled={saving}
                  onChange={(value) =>
                    setManualModels((current) => ({ ...current, [provider.id]: value }))
                  }
                />
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => {
                    const model = (manualModels[provider.id] ?? '').trim()
                    if (model.length === 0) return
                    const availableModels = [...new Set([...provider.availableModels, model])]
                    updateProvider(provider.id, { availableModels })
                    setManualModels((current) => ({ ...current, [provider.id]: '' }))
                  }}
                >
                  {t.addModel}
                </button>
              </div>
              <div className="model-list" aria-label={formatCopy(t.modelList, { name: provider.name })}>
                {provider.availableModels.map((model) => {
                  const enabled = provider.enabledModels.includes(model)
                  return (
                    <button
                      type="button"
                      className="model-chip"
                      data-enabled={enabled}
                      aria-pressed={enabled}
                      key={model}
                      disabled={saving}
                      onClick={() =>
                        updateProvider(provider.id, {
                          enabledModels: enabled
                            ? provider.enabledModels.filter((item) => item !== model)
                            : [...provider.enabledModels, model],
                        })
                      }
                    >
                      {enabled ? <Check size={12} /> : null}
                      {model}
                    </button>
                  )
                })}
              </div>
            </div>
          </SettingGroup>
        )
      })}
    </div>
  )
}
