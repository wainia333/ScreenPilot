import { Check, Download, Plus, Trash2, Wifi } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDesktop } from '../../../desktop/use-desktop'
import { SelectField, SettingGroup, TextField } from '../../../shared/ui/controls'
import type { AppSettings, ProviderProtocol, ProviderSettings } from '../types'
import { primaryProviderKeyDraft } from '../provider-key-draft'
import { copyFor, formatCopy } from '../../../shared/ui-copy'

type ProviderStatus = { tone: 'neutral' | 'success' | 'error'; message: string }
type SettingsUpdater = (update: (current: AppSettings) => AppSettings) => void
export type ProviderKeyTextDrafts = Record<string, string>
type ProviderOperation = 'models' | 'connection'
type ProviderPendingState = Partial<Record<ProviderOperation, true>>
type ProviderRequestContext = {
  id: string
  operation: ProviderOperation
  sequence: number
  provider: ProviderSettings
  hasKeyDraft: boolean
  keyDraft: string | undefined
}

export const PROVIDER_MODEL_REQUEST_TIMEOUT_MS = 15_000

class ProviderRequestTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRequestTimeout'
  }
}

function withProviderRequestTimeout<T>(request: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new ProviderRequestTimeout(message)), PROVIDER_MODEL_REQUEST_TIMEOUT_MS)
    request.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function withoutProviderPending(
  pending: Record<string, ProviderPendingState>,
  id: string,
): Record<string, ProviderPendingState> {
  const { [id]: removed, ...rest } = pending
  void removed
  return rest
}

function withoutOperationPending(
  pending: ProviderPendingState,
  operation: ProviderOperation,
): ProviderPendingState {
  if (operation === 'models') {
    const { models, ...rest } = pending
    void models
    return rest
  }
  const { connection, ...rest } = pending
  void connection
  return rest
}

function newProvider(): ProviderSettings {
  return {
    id: crypto.randomUUID(),
    name: 'OpenAI Compatible',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'responses',
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
  const [pendingOperations, setPendingOperations] = useState<Record<string, ProviderPendingState>>({})
  const requestSequences = useRef<Record<string, Record<ProviderOperation, number>>>({})
  const pendingOperationsRef = useRef<Record<string, ProviderPendingState>>({})
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
        const current = sequences[id] ?? { models: 0, connection: 0 }
        sequences[id] = {
          models: current.models + 1,
          connection: current.connection + 1,
        }
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
    const current = requestSequences.current[id] ?? { models: 0, connection: 0 }
    requestSequences.current[id] = {
      models: current.models + 1,
      connection: current.connection + 1,
    }
    pendingOperationsRef.current = withoutProviderPending(pendingOperationsRef.current, id)
    setPendingOperations((currentPending) => {
      if (!Object.prototype.hasOwnProperty.call(currentPending, id)) return currentPending
      return withoutProviderPending(currentPending, id)
    })
    clearStatus(id)
  }
  const invalidateProviderOperation = (request: ProviderRequestContext) => {
    const current = requestSequences.current[request.id] ?? { models: 0, connection: 0 }
    requestSequences.current[request.id] = {
      ...current,
      [request.operation]: current[request.operation] + 1,
    }
    setProviderPending(request.id, request.operation, false)
  }
  const setProviderPending = (id: string, operation: ProviderOperation, pending: boolean) => {
    const current = pendingOperationsRef.current[id] ?? {}
    const next = pending ? { ...current, [operation]: true } : withoutOperationPending(current, operation)
    pendingOperationsRef.current = Object.keys(next).length === 0
      ? withoutProviderPending(pendingOperationsRef.current, id)
      : { ...pendingOperationsRef.current, [id]: next }
    setPendingOperations((currentPending) => {
      const nextPending = { ...currentPending }
      const nextProvider = { ...(currentPending[id] ?? {}) }
      const updatedProvider = pending
        ? { ...nextProvider, [operation]: true }
        : withoutOperationPending(nextProvider, operation)
      return Object.keys(updatedProvider).length === 0
        ? withoutProviderPending(nextPending, id)
        : { ...nextPending, [id]: updatedProvider }
    })
  }
  const finishProviderRequest = (request: ProviderRequestContext) => {
    const current = requestSequences.current[request.id]
    if (current?.[request.operation] !== request.sequence) return
    setProviderPending(request.id, request.operation, false)
  }
  const beginProviderRequest = (provider: ProviderSettings, operation: ProviderOperation): ProviderRequestContext | null => {
    const id = provider.id
    if (pendingOperationsRef.current[id]?.[operation] === true) return null
    const current = requestSequences.current[id] ?? { models: 0, connection: 0 }
    const request = current[operation] + 1
    requestSequences.current[id] = { ...current, [operation]: request }
    setProviderPending(id, operation, true)
    return {
      id,
      operation,
      sequence: request,
      provider,
      hasKeyDraft: Object.prototype.hasOwnProperty.call(keyDrafts, id),
      keyDraft: keyDrafts[id],
    }
  }
  const requestIsCurrent = (request: ProviderRequestContext) => {
    if (!mountedRef.current || requestSequences.current[request.id]?.[request.operation] !== request.sequence) return false
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
        const modelsPending = pendingOperations[provider.id]?.models === true
        const connectionPending = pendingOperations[provider.id]?.connection === true
        return (
          <SettingGroup title={provider.name || t.unnamedProvider} key={provider.id}>
            <div
              className="provider-form"
              data-settings-provider-id={provider.id}
              data-settings-issue-path={`providers.${provider.id}`}
              tabIndex={-1}
            >
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
                  issuePath={`providers.${provider.id}.baseUrl`}
                  disabled={saving}
                  onChange={(baseUrl) => updateProvider(provider.id, { baseUrl })}
                />
              </label>
              <label>
                <span>{t.providerProtocol}</span>
                <SelectField<ProviderProtocol>
                  value={provider.protocol ?? 'responses'}
                  label={t.providerProtocol}
                  options={[
                    { value: 'responses', label: t.responsesProtocol },
                    { value: 'chatCompletions', label: t.chatCompletionsProtocol },
                  ]}
                  onChange={(protocol) => updateProvider(provider.id, { protocol })}
                />
              </label>
              <label>
                <span>API Keys</span>
                <textarea
                  className="key-field"
                  value={hasDraftKeys(provider.id) ? keyDrafts[provider.id] ?? '' : ''}
                  data-settings-issue-path={`providers.${provider.id}.keys`}
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
                  disabled={saving || modelsPending}
                  aria-busy={modelsPending}
                  onClick={async () => {
                    const values = draftKeys(provider.id)
                    const override = primaryProviderKeyDraft(values)
                    const request = beginProviderRequest(provider, 'models')
                    if (request === null) return
                    try {
                      const models = await withProviderRequestTimeout(
                        desktop.fetchProviderModels(provider, override),
                        t.providerRequestTimeout,
                      )
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
                      if (error instanceof ProviderRequestTimeout) {
                        invalidateProviderOperation(request)
                        setStatus(provider.id, {
                          tone: 'error',
                          message: error.message,
                        })
                        return
                      }
                      setStatus(provider.id, {
                        tone: 'error',
                        message: redactKeyError(String(error), values ?? []),
                      })
                    } finally {
                      finishProviderRequest(request)
                    }
                  }}
                >
                  <Download size={14} />{modelsPending ? t.fetchingModels : t.fetchModels}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving || connectionPending}
                  aria-busy={connectionPending}
                  onClick={async () => {
                    const values = draftKeys(provider.id)
                    const request = beginProviderRequest(provider, 'connection')
                    if (request === null) return
                    try {
                      const result = await withProviderRequestTimeout(
                        desktop.testProvider(provider, primaryProviderKeyDraft(values)),
                        t.providerRequestTimeout,
                      )
                      if (!requestIsCurrent(request)) return
                      setStatus(provider.id, {
                        tone: result.success ? 'success' : 'error',
                        message: result.success
                          ? t.connectionSucceeded
                          : redactKeyError(result.error ?? t.connectionFailed, values ?? []),
                      })
                    } catch (error) {
                      if (!requestIsCurrent(request)) return
                      if (error instanceof ProviderRequestTimeout) {
                        invalidateProviderOperation(request)
                        setStatus(provider.id, {
                          tone: 'error',
                          message: error.message,
                        })
                        return
                      }
                      setStatus(provider.id, {
                        tone: 'error',
                        message: redactKeyError(String(error), values ?? []),
                      })
                    } finally {
                      finishProviderRequest(request)
                    }
                  }}
                >
                  <Wifi size={14} />{connectionPending ? t.testingConnection : t.testConnection}
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
