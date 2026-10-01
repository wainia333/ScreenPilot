import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { AdapterCredentials } from '../adapter-credentials'
import type { AdapterCredentialCounts, AdapterCredentialDrafts, AdapterCredentialId } from '../adapter-credential-specs'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings, OcrMethod, ThinkingEffort } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { isValidModelSelection, normalizeAiAvailability } from '../sanitize'
import {
  copyFor,
  translationLanguageOptions,
  translationMethodLabel,
} from '../../../shared/ui-copy'

export function ScreenshotSection({
  settings,
  onChange,
  adapterCredentialDrafts,
  adapterCredentialCounts,
  onAdapterCredentialDraftChange,
  onAdapterCredentialClear,
  saving = false,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
  adapterCredentialDrafts: AdapterCredentialDrafts
  adapterCredentialCounts: AdapterCredentialCounts
  onAdapterCredentialDraftChange: (adapterId: AdapterCredentialId, value: string) => void
  onAdapterCredentialClear: (adapterId: AdapterCredentialId) => void
  saving?: boolean
}) {
  const t = copyFor(settings.language)
  const current = settings.screenshotTranslation
  const update = (patch: Partial<AppSettings['screenshotTranslation']>) =>
    onChange(normalizeAiAvailability({ ...settings, screenshotTranslation: { ...current, ...patch } }))
  const ocrHasValidModel = isValidModelSelection(current.ocrModel, settings.providers)
  const translationHasValidModel = isValidModelSelection(current.translationModel, settings.providers)
  const canUseOcrAi = current.ocrAiEnabled && ocrHasValidModel
  const canUseTranslationAi = current.translationAiEnabled && translationHasValidModel
  const ocrMethod = current.ocrMethod === 'ai' && !canUseOcrAi
    ? DEFAULT_SETTINGS.screenshotTranslation.ocrMethod
    : current.ocrMethod
  const translationMethod = current.translationMethod === 'ai' && !canUseTranslationAi
    ? DEFAULT_SETTINGS.screenshotTranslation.translationMethod
    : current.translationMethod
  const methods = translationMethodOptions
    .filter((option) => option.value !== 'ai' || canUseTranslationAi)
    .map((option) => ({ ...option, label: translationMethodLabel(option.value, settings.language) }))
  return (
    <>
      <SettingGroup title={t.screenshotTranslation}>
        <SettingRow label={t.enableScreenshotTranslation}>
          <Toggle checked={current.enabled} label={t.enableScreenshotTranslation} onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label={t.targetLanguage}>
          <SelectField
            value={current.targetLanguage}
            label={t.screenshotTargetLanguage}
            options={translationLanguageOptions(settings.language)}
            onChange={(targetLanguage) => update({ targetLanguage })}
          />
        </SettingRow>
        <SettingRow label={t.sourceLanguage}>
          <SelectField
            value={current.sourceLanguage}
            label={t.screenshotSourceLanguage}
            options={translationLanguageOptions(settings.language)}
            onChange={(sourceLanguage) => update({ sourceLanguage })}
          />
        </SettingRow>
        <SettingRow label={t.enableAiOcr}>
          <Toggle
            checked={current.ocrAiEnabled}
            label={t.enableAiOcr}
            onChange={(ocrAiEnabled) => update({ ocrAiEnabled })}
          />
        </SettingRow>
        {current.ocrAiEnabled ? (
          <SettingRow label={t.ocrModel}>
            <ModelField
              value={current.ocrModel}
              providers={settings.providers}
              label={t.ocrModel}
              emptyLabel={t.noSelection}
              onChange={(ocrModel) => update({ ocrModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={t.ocrInterface}>
          <SelectField<OcrMethod>
            value={ocrMethod}
            label={t.ocrInterface}
            options={[
              ...(canUseOcrAi ? [{ value: 'ai' as const, label: t.aiVisionOcr }] : []),
              { value: 'baidu', label: t.baiduOcr },
              { value: 'chaoxing', label: t.chaoxingOcr },
            ]}
            onChange={(ocrMethod) => update({ ocrMethod })}
          />
        </SettingRow>
        <SettingRow label={t.enableAiTranslation}>
          <Toggle
            checked={current.translationAiEnabled}
            label={t.enableAiTranslation}
            onChange={(translationAiEnabled) => update({ translationAiEnabled })}
          />
        </SettingRow>
        {current.translationAiEnabled ? (
          <SettingRow label={t.translationModel}>
            <ModelField
              value={current.translationModel}
              providers={settings.providers}
              label={t.screenshotTranslationModel}
              emptyLabel={t.noSelection}
              onChange={(translationModel) => update({ translationModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label={t.translationInterface}>
          <SelectField
            value={translationMethod}
            label={t.screenshotTranslationInterface}
            options={methods}
            onChange={(translationMethod) => update({ translationMethod })}
          />
        </SettingRow>
        <SettingRow label={t.showRecognizedSource}>
          <Toggle checked={current.showSource} label={t.showRecognizedSource} onChange={(showSource) => update({ showSource })} />
        </SettingRow>
        <SettingRow label={t.streamingOutput}>
          <Toggle checked={current.stream} label={t.screenshotStreamingOutput} onChange={(stream) => update({ stream })} />
        </SettingRow>
        <SettingRow label={t.showReasoning}>
          <Toggle checked={current.thinking} label={t.showReasoning} onChange={(thinking) => update({ thinking })} />
        </SettingRow>
        {current.thinking ? (
          <SettingRow label={t.reasoningEffort}>
            <SelectField<ThinkingEffort>
              value={current.thinkingEffort}
              label={t.screenshotReasoningEffort}
              options={[
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'xhigh', label: 'xhigh' },
              ]}
              onChange={(thinkingEffort) => update({ thinkingEffort })}
            />
          </SettingRow>
        ) : null}
      </SettingGroup>
      <SettingGroup
        title={t.ocrPrompt}
        titleAction={
          <PromptResetButton
            value={current.ocrPrompt}
            label={t.ocrPrompt}
            defaultValue={DEFAULT_SETTINGS.screenshotTranslation.ocrPrompt}
            resetLabel={t.resetDefault}
            onChange={(ocrPrompt) => update({ ocrPrompt })}
          />
        }
      >
        <PromptField
          value={current.ocrPrompt}
          label={t.ocrPrompt}
          onChange={(ocrPrompt) => update({ ocrPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title={t.screenshotTranslationPrompt}
        titleAction={
          <PromptResetButton
            value={current.translationPrompt}
            label={t.screenshotTranslationPrompt}
            defaultValue={DEFAULT_SETTINGS.screenshotTranslation.translationPrompt}
            resetLabel={t.resetDefault}
            onChange={(translationPrompt) => update({ translationPrompt })}
          />
        }
      >
        <PromptField
          value={current.translationPrompt}
          label={t.screenshotTranslationPrompt}
          onChange={(translationPrompt) => update({ translationPrompt })}
        />
      </SettingGroup>
      <AdapterCredentials
        language={settings.language}
        drafts={adapterCredentialDrafts}
        configuredCounts={adapterCredentialCounts}
        disabled={saving}
        onDraftChange={onAdapterCredentialDraftChange}
        onClear={onAdapterCredentialClear}
      />
    </>
  )
}
