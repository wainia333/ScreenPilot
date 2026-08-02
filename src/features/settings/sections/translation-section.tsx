import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { isValidModelSelection, normalizeAiAvailability } from '../sanitize'

export function TranslationSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const update = (patch: Partial<AppSettings['translation']>) =>
    onChange(normalizeAiAvailability({ ...settings, translation: { ...settings.translation, ...patch } }))
  const hasValidModel = isValidModelSelection(settings.translation.aiModel, settings.providers)
  const canUseAi = settings.translation.aiEnabled && hasValidModel
  const method = settings.translation.method === 'ai' && !canUseAi
    ? DEFAULT_SETTINGS.translation.method
    : settings.translation.method
  const methods = translationMethodOptions.filter((option) => option.value !== 'ai' || canUseAi)
  return (
    <>
      <SettingGroup title="翻译行为">
        <SettingRow label="目标语言">
          <SelectField
            value={settings.translation.targetLanguage}
            label="目标语言"
            options={[
              { value: 'auto', label: '自动判断' },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
              { value: 'ja', label: '日本語' },
              { value: 'ko', label: '한국어' },
            ]}
            onChange={(targetLanguage) => update({ targetLanguage })}
          />
        </SettingRow>
        <SettingRow label="开启大模型翻译">
          <Toggle
            checked={settings.translation.aiEnabled}
            label="开启大模型翻译"
            onChange={(aiEnabled) => update({ aiEnabled })}
          />
        </SettingRow>
        {settings.translation.aiEnabled ? (
          <SettingRow label="AI 模型">
            <ModelField
              value={settings.translation.aiModel}
              providers={settings.providers}
              label="文本翻译 AI 模型"
              onChange={(aiModel) => update({ aiModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="翻译接口">
          <SelectField
            value={method}
            label="翻译接口"
            options={methods}
            onChange={(method) => update({ method })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title="大模型翻译系统提示词"
        titleAction={
          <PromptResetButton
            value={settings.translation.prompt}
            label="大模型翻译系统提示词"
            defaultValue={DEFAULT_SETTINGS.translation.prompt}
            onChange={(prompt) => update({ prompt })}
          />
        }
      >
        <PromptField
          value={settings.translation.prompt}
          label="大模型翻译系统提示词"
          onChange={(prompt) => update({ prompt })}
        />
      </SettingGroup>
    </>
  )
}
