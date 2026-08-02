import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import type { AppSettings } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'

export function OptimizerSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const current = settings.promptOptimizer
  const update = (patch: Partial<AppSettings['promptOptimizer']>) =>
    onChange({ ...settings, promptOptimizer: { ...current, ...patch } })
  return (
    <>
      <SettingGroup title="提示词优化">
        <SettingRow label="启用优化器">
          <Toggle checked={current.enabled} label="启用提示词优化器" onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label="输出语言">
          <SelectField
            value={current.responseLanguage}
            label="优化器输出语言"
            options={[
              { value: 'auto', label: '跟随原文' },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
            onChange={(responseLanguage) => update({ responseLanguage })}
          />
        </SettingRow>
        <SettingRow label="模型">
          <ModelField
            value={current.model}
            providers={settings.providers}
            label="提示词优化模型"
            onChange={(model) => update({ model })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title="系统提示词"
        titleAction={
          <PromptResetButton
            value={current.systemPrompt}
            label="优化器系统提示词"
            defaultValue={DEFAULT_SETTINGS.promptOptimizer.systemPrompt}
            onChange={(systemPrompt) => update({ systemPrompt })}
          />
        }
      >
        <PromptField
          value={current.systemPrompt}
          label="优化器系统提示词"
          onChange={(systemPrompt) => update({ systemPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title="优化提示词"
        titleAction={
          <PromptResetButton
            value={current.optimizePrompt}
            label="优化提示词"
            defaultValue={DEFAULT_SETTINGS.promptOptimizer.optimizePrompt}
            onChange={(optimizePrompt) => update({ optimizePrompt })}
          />
        }
      >
        <PromptField
          value={current.optimizePrompt}
          label="优化提示词"
          onChange={(optimizePrompt) => update({ optimizePrompt })}
        />
      </SettingGroup>
    </>
  )
}
