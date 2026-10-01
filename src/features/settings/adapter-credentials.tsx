import { Trash2 } from 'lucide-react'
import { SettingGroup, TextField } from '../../shared/ui/controls'
import { copyFor, formatCopy } from '../../shared/ui-copy'
import type { InterfaceLanguage } from './types'
import { ADAPTER_CREDENTIALS, type AdapterCredentialCounts, type AdapterCredentialDrafts, type AdapterCredentialId } from './adapter-credential-specs'

function splitDraft(value: string | undefined, fieldCount: number): string[] {
  const fields = (value ?? '').split(/\r?\n/u)
  return Array.from({ length: fieldCount }, (_, index) => fields[index] ?? '')
}

export function AdapterCredentials({
  language = 'zh',
  drafts,
  configuredCounts,
  disabled = false,
  onDraftChange,
  onClear,
}: {
  language?: InterfaceLanguage
  drafts: AdapterCredentialDrafts
  configuredCounts: AdapterCredentialCounts
  disabled?: boolean
  onDraftChange: (adapterId: AdapterCredentialId, value: string) => void
  onClear: (adapterId: AdapterCredentialId) => void
}) {
  const t = copyFor(language)
  return (
    <SettingGroup title={t.credentialGroup}>
      <div className="adapter-credentials">
        {ADAPTER_CREDENTIALS.map((adapter) => {
          const adapterLabel = language === 'en' ? adapter.labelEn : adapter.label
          const hasDraft = Object.prototype.hasOwnProperty.call(drafts, adapter.id)
          const values = splitDraft(drafts[adapter.id], adapter.fields.length)
          const configuredCount = configuredCounts[adapter.id] ?? 0
          const clearDisabled = disabled || (!hasDraft && configuredCount === 0)
          return (
            <section key={adapter.id} data-settings-issue-path={`credentials.${adapter.id}`} tabIndex={-1}>
              <strong>{adapterLabel}</strong>
              <div>
                {adapter.fields.map((field, index) => (
                  <TextField
                    key={field}
                    className="connection-input"
                    value={hasDraft ? values[index] ?? '' : ''}
                    label={`${adapterLabel} ${field}`}
                    type="password"
                    placeholder={configuredCount > 0 ? formatCopy(t.savedKeyCount, { count: configuredCount }) : field}
                    disabled={disabled}
                    onChange={(value) => {
                      const next = [...values]
                      next[index] = value
                      onDraftChange(adapter.id, next.join('\n'))
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`${t.clearCredentials}${language === 'zh' ? '：' : ': '}${adapterLabel}`}
                  data-screenpilot-credential-clear="true"
                  disabled={clearDisabled}
                  onClick={() => onClear(adapter.id)}
                >
                  <Trash2 size={14} />{t.clearCredentials}
                </button>
              </div>
              <span
                className="adapter-credential-state"
                data-configured={configuredCount > 0}
                data-screenpilot-credential-state={adapter.id}
              >
                {hasDraft && values.every((value) => value.trim().length === 0)
                  ? t.credentialClearPending
                  : configuredCount > 0
                    ? formatCopy(t.savedKeyCount, { count: configuredCount })
                    : t.credentialNotConfigured}
              </span>
            </section>
          )
        })}
      </div>
    </SettingGroup>
  )
}
