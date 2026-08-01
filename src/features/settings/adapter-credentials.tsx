import { Check } from 'lucide-react'
import { useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { SettingGroup, TextField } from '../../shared/ui/controls'

const adapters = [
  { id: 'adapter-baidu-ocr', label: '百度 OCR', fields: ['API Key', 'Secret Key'] },
  { id: 'adapter-baidu-translation', label: '百度翻译', fields: ['App ID', 'Secret'] },
  { id: 'adapter-tencent-translation', label: '腾讯翻译', fields: ['Secret ID', 'Secret Key'] },
  { id: 'adapter-caiyun-translation', label: '彩云小译 2', fields: ['Token'] },
] as const

export function AdapterCredentials() {
  const desktop = useDesktop()
  const [values, setValues] = useState<Record<string, string[]>>({})
  const [status, setStatus] = useState<string | null>(null)
  return (
    <SettingGroup title="接口凭据">
      <div className="adapter-credentials">
        {adapters.map((adapter) => (
          <section key={adapter.id}>
            <strong>{adapter.label}</strong>
            <div>
              {adapter.fields.map((field, index) => (
                <TextField
                  key={field}
                  value={values[adapter.id]?.[index] ?? ''}
                  label={`${adapter.label} ${field}`}
                  type="password"
                  placeholder={field}
                  onChange={(value) => {
                    const next = [...(values[adapter.id] ?? [])]
                    next[index] = value
                    setValues((current) => ({ ...current, [adapter.id]: next }))
                  }}
                />
              ))}
              <button
                type="button"
                className="secondary-button"
                onClick={async () => {
                  const keys = values[adapter.id] ?? []
                  await desktop.setProviderKeys(adapter.id, keys)
                  setValues((current) => ({ ...current, [adapter.id]: [] }))
                  setStatus(`${adapter.label}凭据已安全保存`)
                }}
              >
                <Check size={14} />保存
              </button>
            </div>
          </section>
        ))}
        {status === null ? null : <div className="inline-status" data-tone="success" role="status">{status}</div>}
      </div>
    </SettingGroup>
  )
}
