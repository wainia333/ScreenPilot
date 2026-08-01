import { Check, Download, Plus, Trash2, Wifi } from 'lucide-react'
import { useState } from 'react'
import { useDesktop } from '../../../desktop/use-desktop'
import { SettingGroup, TextField } from '../../../shared/ui/controls'
import type { AppSettings, ProviderSettings } from '../types'

type ProviderStatus = { tone: 'neutral' | 'success' | 'error'; message: string }

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

export function ProvidersSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const desktop = useDesktop()
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [manualModels, setManualModels] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, ProviderStatus>>({})
  const updateProvider = (id: string, patch: Partial<ProviderSettings>) =>
    onChange({
      ...settings,
      providers: settings.providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    })
  const setStatus = (id: string, status: ProviderStatus) =>
    setStatuses((current) => ({ ...current, [id]: status }))
  const keyLines = (id: string) =>
    (keys[id] ?? '')
      .split(/\r?\n/u)
      .map((key) => key.trim())
      .filter(Boolean)
  return (
    <>
      <div className="section-heading">
        <div>
          <h1>模型提供商</h1>
          <p>密钥保存在 Windows 凭据管理器，不写入设置文件。</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => onChange({ ...settings, providers: [...settings.providers, newProvider()] })}
        >
          <Plus size={15} />新增
        </button>
      </div>
      {settings.providers.length === 0 ? (
        <div className="empty-panel">
          <Wifi size={24} />
          <span>尚未添加模型提供商</span>
          <small>添加 OpenAI 兼容端点后，可分别为翻译、Vision 和优化器选择模型。</small>
        </div>
      ) : null}
      {settings.providers.map((provider) => {
        const status = statuses[provider.id]
        return (
          <SettingGroup title={provider.name || '未命名提供商'} key={provider.id}>
            <div className="provider-form">
              <label>
                <span>名称</span>
                <TextField
                  value={provider.name}
                  label="提供商名称"
                  onChange={(name) => updateProvider(provider.id, { name })}
                />
              </label>
              <label>
                <span>Base URL</span>
                <TextField
                  value={provider.baseUrl}
                  label="提供商 Base URL"
                  type="url"
                  onChange={(baseUrl) => updateProvider(provider.id, { baseUrl })}
                />
              </label>
              <label>
                <span>API Keys</span>
                <textarea
                  className="key-field"
                  value={keys[provider.id] ?? ''}
                  aria-label={`${provider.name} API Keys`}
                  placeholder={provider.keyCount > 0 ? `已安全保存 ${provider.keyCount} 个密钥` : '每行一个密钥'}
                  onChange={(event) =>
                    setKeys((current) => ({ ...current, [provider.id]: event.target.value }))
                  }
                />
              </label>
              <div className="provider-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    const values = keyLines(provider.id)
                    await desktop.setProviderKeys(provider.id, values)
                    updateProvider(provider.id, { keyCount: values.length })
                    setKeys((current) => ({ ...current, [provider.id]: '' }))
                    setStatus(provider.id, { tone: 'success', message: `已保存 ${values.length} 个密钥` })
                  }}
                >
                  <Check size={14} />保存密钥
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      const models = await desktop.fetchProviderModels(provider)
                      updateProvider(provider.id, {
                        availableModels: models,
                        enabledModels: provider.enabledModels.filter((model) => models.includes(model)),
                      })
                      setStatus(provider.id, { tone: 'success', message: `获取到 ${models.length} 个模型` })
                    } catch (error) {
                      setStatus(provider.id, { tone: 'error', message: String(error) })
                    }
                  }}
                >
                  <Download size={14} />拉取模型
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    const result = await desktop.testProvider(provider, keyLines(provider.id))
                    setStatus(provider.id, {
                      tone: result.success ? 'success' : 'error',
                      message: result.success ? '连接成功' : (result.error ?? '连接失败'),
                    })
                  }}
                >
                  <Wifi size={14} />测试连接
                </button>
                <button
                  type="button"
                  className="icon-button danger-button"
                  aria-label={`删除 ${provider.name}`}
                  onClick={async () => {
                    await desktop.deleteProviderKeys(provider.id)
                    onChange({
                      ...settings,
                      providers: settings.providers.filter((item) => item.id !== provider.id),
                    })
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
                  label={`${provider.name} 手动模型名`}
                  placeholder="手动添加模型，例如 local:vision"
                  onChange={(value) =>
                    setManualModels((current) => ({ ...current, [provider.id]: value }))
                  }
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    const model = (manualModels[provider.id] ?? '').trim()
                    if (model.length === 0) return
                    const availableModels = [...new Set([...provider.availableModels, model])]
                    updateProvider(provider.id, { availableModels })
                    setManualModels((current) => ({ ...current, [provider.id]: '' }))
                  }}
                >
                  添加
                </button>
              </div>
              <div className="model-list" aria-label={`${provider.name} 模型列表`}>
                {provider.availableModels.map((model) => {
                  const enabled = provider.enabledModels.includes(model)
                  return (
                    <button
                      type="button"
                      className="model-chip"
                      data-enabled={enabled}
                      aria-pressed={enabled}
                      key={model}
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
    </>
  )
}
