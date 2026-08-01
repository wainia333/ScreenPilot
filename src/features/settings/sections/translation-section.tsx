import { PromptField, SelectField, SettingGroup, SettingRow } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings } from '../types'

export function TranslationSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const update = (patch: Partial<AppSettings['translation']>) =>
    onChange({ ...settings, translation: { ...settings.translation, ...patch } })
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
        <SettingRow label="翻译接口">
          <SelectField
            value={settings.translation.method}
            label="翻译接口"
            options={translationMethodOptions}
            onChange={(method) => update({ method })}
          />
        </SettingRow>
        {settings.translation.method === 'ai' ? (
          <SettingRow label="AI 模型">
            <ModelField
              value={settings.translation.aiModel}
              providers={settings.providers}
              label="文本翻译 AI 模型"
              onChange={(aiModel) => update({ aiModel })}
            />
          </SettingRow>
        ) : null}
      </SettingGroup>
      <SettingGroup title="大模型翻译系统提示词">
        <PromptField
          value={settings.translation.prompt}
          label="大模型翻译系统提示词"
          onChange={(prompt) => update({ prompt })}
        />
      </SettingGroup>
    </>
  )
}
