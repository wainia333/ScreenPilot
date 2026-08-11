import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { isValidModelSelection, normalizeAiAvailability } from '../sanitize'
import { copyFor, translationLanguageOptions, translationMethodLabel } from '../../../shared/ui-copy'

export function TranslationSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
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
        <SettingRow label={t.translationInterface}>
          <SelectField
            value={method}
            label={t.translationInterface}
            options={methods}
            onChange={(method) => update({ method })}
          />
        </SettingRow>
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
