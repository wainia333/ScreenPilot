import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import type { AppSettings, ThinkingEffort } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { copyFor } from '../../../shared/ui-copy'

export function OptimizerSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const t = copyFor(settings.language)
  const current = settings.promptOptimizer
  const update = (patch: Partial<AppSettings['promptOptimizer']>) =>
    onChange({ ...settings, promptOptimizer: { ...current, ...patch } })
  return (
    <>
      <SettingGroup title={t.promptOptimization}>
        <SettingRow label={t.enableOptimizer}>
          <Toggle checked={current.enabled} label={t.enablePromptOptimizer} onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label={t.outputLanguage}>
          <SelectField
            value={current.responseLanguage}
            label={t.optimizerOutputLanguage}
            options={[
              { value: 'auto', label: t.followInput },
              { value: 'zh-CN', label: t.simplifiedChinese },
              { value: 'en', label: t.english },
            ]}
            onChange={(responseLanguage) => update({ responseLanguage })}
          />
        </SettingRow>
        <SettingRow label={t.model}>
          <ModelField
            value={current.model}
            providers={settings.providers}
            label={t.optimizerModel}
            emptyLabel={t.noSelection}
            onChange={(model) => update({ model })}
          />
        </SettingRow>
        <SettingRow label={t.reasoningEffort}>
          <SelectField<ThinkingEffort>
            value={current.thinkingEffort}
            label={t.optimizerReasoningEffort}
            options={[
              { value: 'low', label: 'low' },
              { value: 'medium', label: 'medium' },
              { value: 'high', label: 'high' },
              { value: 'xhigh', label: 'xhigh' },
              { value: 'max', label: 'max' },
            ]}
            onChange={(thinkingEffort) => update({ thinkingEffort })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title={t.systemPrompt}
        titleAction={
          <PromptResetButton
            value={current.systemPrompt}
            label={t.optimizerSystemPrompt}
            defaultValue={DEFAULT_SETTINGS.promptOptimizer.systemPrompt}
            resetLabel={t.resetDefault}
            onChange={(systemPrompt) => update({ systemPrompt })}
          />
        }
      >
        <PromptField
          value={current.systemPrompt}
          label={t.optimizerSystemPrompt}
          onChange={(systemPrompt) => update({ systemPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title={t.optimizationPrompt}
        titleAction={
          <PromptResetButton
            value={current.optimizePrompt}
            label={t.optimizationPrompt}
            defaultValue={DEFAULT_SETTINGS.promptOptimizer.optimizePrompt}
            resetLabel={t.resetDefault}
            onChange={(optimizePrompt) => update({ optimizePrompt })}
          />
        }
      >
        <PromptField
          value={current.optimizePrompt}
          label={t.optimizationPrompt}
          onChange={(optimizePrompt) => update({ optimizePrompt })}
        />
      </SettingGroup>
    </>
  )
}
