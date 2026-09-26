import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings, TranslationMethod } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { isValidModelSelection, normalizeAiAvailability } from '../sanitize'
import {
  copyFor,
  formatCopy,
  translationLanguageOptions,
  translationMethodLabel,
  translationServiceDestination,
} from '../../../shared/ui-copy'

export function TranslationSection({
  settings,
  onChange,
  onOpenCredentials,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
  onOpenCredentials?: () => void
}) {
  const t = copyFor(settings.language)
  const update = (patch: Partial<AppSettings['translation']>) =>
    onChange(normalizeAiAvailability({ ...settings, translation: { ...settings.translation, ...patch } }))
  const hasValidModel = isValidModelSelection(settings.translation.aiModel, settings.providers)
  const canUseAi = settings.translation.aiEnabled && hasValidModel
  const method = settings.translation.method === 'ai' && !canUseAi
    ? DEFAULT_SETTINGS.translation.method
    : settings.translation.method
  const methods = translationMethodOptions
    .filter((option) => option.value !== 'ai' || canUseAi)
    .map((option) => ({ ...option, label: translationMethodLabel(option.value, settings.language) }))
  const usesAdapterCredentials = new Set<TranslationMethod>(['baidu', 'tencent', 'caiyun2']).has(settings.translation.method)
  const destination = translationServiceDestination(settings, method, settings.translation.aiModel) ?? t.noSelection
  const dataFlowDescription = method === 'ai'
    ? formatCopy(t.aiTextTranslationDataFlow, { destination })
    : formatCopy(t.textTranslationDataFlow, { destination })
  return (
    <>
      <SettingGroup title={t.translationBehavior}>
        <SettingRow label={t.sourceLanguage}>
          <SelectField
            value={settings.translation.sourceLanguage}
            label={t.sourceLanguage}
            options={translationLanguageOptions(settings.language, 'detect')}
            onChange={(sourceLanguage) => update({ sourceLanguage })}
          />
        </SettingRow>
        <SettingRow label={t.targetLanguage}>
          <SelectField
            value={settings.translation.targetLanguage}
            label={t.targetLanguage}
            options={translationLanguageOptions(settings.language, 'detect')}
            onChange={(targetLanguage) => update({ targetLanguage })}
          />
        </SettingRow>
        <SettingRow label={t.enableAiTranslation}>
          <Toggle
            checked={settings.translation.aiEnabled}
            label={t.enableAiTranslation}
            onChange={(aiEnabled) => update({ aiEnabled })}
          />
        </SettingRow>
        {settings.translation.aiEnabled ? (
          <SettingRow label={t.aiModel}>
            <ModelField
              value={settings.translation.aiModel}
              providers={settings.providers}
              label={t.textTranslationAiModel}
              emptyLabel={t.noSelection}
              onChange={(aiModel) => update({ aiModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={t.translationInterface} description={dataFlowDescription}>
          <SelectField
            value={method}
            label={t.translationInterface}
            options={methods}
            onChange={(method) => update({ method })}
          />
        </SettingRow>
        {usesAdapterCredentials && onOpenCredentials === undefined ? null : usesAdapterCredentials ? (
          <SettingRow label={t.credentialGroup} description={t.configureCredentials}>
            <button type="button" className="secondary-button" onClick={onOpenCredentials}>
              {t.configureCredentials}
            </button>
          </SettingRow>
        ) : null}
      </SettingGroup>
      <SettingGroup
        title={t.aiTranslationSystemPrompt}
        titleAction={
          <PromptResetButton
            value={settings.translation.prompt}
            label={t.aiTranslationSystemPrompt}
            defaultValue={DEFAULT_SETTINGS.translation.prompt}
            resetLabel={t.resetDefault}
            onChange={(prompt) => update({ prompt })}
          />
        }
      >
        <PromptField
          value={settings.translation.prompt}
          label={t.aiTranslationSystemPrompt}
          onChange={(prompt) => update({ prompt })}
        />
      </SettingGroup>
    </>
  )
}
