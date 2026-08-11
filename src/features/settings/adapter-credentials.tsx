import { Check } from 'lucide-react'
import { useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { SettingGroup, TextField } from '../../shared/ui/controls'
import { copyFor } from '../../shared/ui-copy'
import type { InterfaceLanguage } from './types'

const adapters = [
  { id: 'adapter-baidu-ocr', label: '百度 OCR', labelEn: 'Baidu OCR', fields: ['API Key', 'Secret Key'] },
  { id: 'adapter-baidu-translation', label: '百度翻译', labelEn: 'Baidu Translate', fields: ['App ID', 'Secret'] },
  { id: 'adapter-tencent-translation', label: '腾讯翻译', labelEn: 'Tencent Translate', fields: ['Secret ID', 'Secret Key'] },
  { id: 'adapter-caiyun-translation', label: '彩云小译 2', labelEn: 'Caiyun 2', fields: ['Token'] },
] as const

export function AdapterCredentials({ language = 'zh' }: { language?: InterfaceLanguage }) {
  const desktop = useDesktop()
  const t = copyFor(language)
  const [values, setValues] = useState<Record<string, string[]>>({})
  const [savingAdapterId, setSavingAdapterId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)
  return (
    <SettingGroup title={t.credentialGroup}>
      <div className="adapter-credentials">
        {adapters.map((adapter) => {
          const adapterLabel = language === 'en' ? adapter.labelEn : adapter.label
          const keys = adapter.fields.map((_, index) => values[adapter.id]?.[index]?.trim() ?? '')
          const hasAnyValue = keys.some((value) => value.length > 0)
          return (
            <section key={adapter.id}>
              <strong>{adapterLabel}</strong>
              <div>
                {adapter.fields.map((field, index) => (
                  <TextField
                    key={field}
                    value={values[adapter.id]?.[index] ?? ''}
                    label={`${adapterLabel} ${field}`}
                    type="password"
                    placeholder={field}
                    disabled={savingAdapterId !== null}
                    onChange={(value) => {
                      const next = [...(values[adapter.id] ?? [])]
                      next[index] = value
                      setValues((current) => ({ ...current, [adapter.id]: next }))
                      setStatus(null)
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!hasAnyValue || savingAdapterId !== null}
                  onClick={async () => {
                    if (keys.some((value) => value.length === 0)) {
                      setStatus({
                        message: language === 'zh'
                          ? `请完整填写 ${adapterLabel} 的全部凭据字段`
                          : `Complete every ${adapterLabel} credential field`,
                        tone: 'error',
                      })
                      return
                    }
                    setSavingAdapterId(adapter.id)
                    setStatus(null)
                    try {
                      await desktop.setProviderKeys(adapter.id, keys)
                      setValues((current) => ({ ...current, [adapter.id]: [] }))
                      setStatus({ message: `${adapterLabel} ${t.credentialSaved}`, tone: 'success' })
                    } catch {
                      setStatus({
                        message: language === 'zh'
                          ? `${adapterLabel} 凭据保存失败，请重试`
                          : `${adapterLabel} credential save failed; retry`,
                        tone: 'error',
                      })
                    } finally {
                      setSavingAdapterId(null)
                    }
                  }}
                >
                  <Check size={14} />{t.save}
                </button>
              </div>
            </section>
          )
        })}
        {status === null ? null : <div className="inline-status" data-tone={status.tone} role="status">{status.message}</div>}
      </div>
    </SettingGroup>
  )
}
