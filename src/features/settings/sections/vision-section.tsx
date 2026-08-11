import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import type { AppSettings, MessageOrder, ThinkingEffort } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { copyFor } from '../../../shared/ui-copy'

export function VisionSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const t = copyFor(settings.language)
  const current = settings.vision
  const update = (patch: Partial<AppSettings['vision']>) =>
    onChange({ ...settings, vision: { ...current, ...patch } })
  return (
    <>
      <SettingGroup title={t.visionQa}>
        <SettingRow label={t.enableVision}>
          <Toggle checked={current.enabled} label={t.enableVision} onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label={t.responseLanguage}>
          <SelectField
            value={current.responseLanguage}
            label={t.visionResponseLanguage}
            options={[
              { value: 'auto', label: t.followQuestion },
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
            label={t.visionModel}
            emptyLabel={t.noSelection}
            onChange={(model) => update({ model })}
          />
        </SettingRow>
        <SettingRow label={t.streamingOutput}>
          <Toggle checked={current.stream} label={t.visionStreamingOutput} onChange={(stream) => update({ stream })} />
        </SettingRow>
        <SettingRow label={t.visionReasoning}>
          <Toggle checked={current.thinking} label={t.visionReasoningLabel} onChange={(thinking) => update({ thinking })} />
        </SettingRow>
        {current.thinking ? (
          <SettingRow label={t.reasoningEffort}>
            <SelectField<ThinkingEffort>
              value={current.thinkingEffort}
              label={t.visionReasoningEffort}
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
        ) : null}
        <SettingRow label={t.webSearch}>
          <Toggle checked={current.webSearch} label={t.webSearch} onChange={(webSearch) => update({ webSearch })} />
        </SettingRow>
        <SettingRow label={t.messageOrder}>
          <SelectField<MessageOrder>
            value={current.messageOrder}
            label={t.messageOrder}
            options={[
              { value: 'asc', label: t.oldMessagesFirst },
              { value: 'desc', label: t.newMessagesFirst },
            ]}
            onChange={(messageOrder) => update({ messageOrder })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title={t.systemPrompt}
        titleAction={
          <PromptResetButton
            value={current.systemPrompt}
            label={t.visionSystemPrompt}
            defaultValue={DEFAULT_SETTINGS.vision.systemPrompt}
            resetLabel={t.resetDefault}
            onChange={(systemPrompt) => update({ systemPrompt })}
          />
        }
      >
        <PromptField
          value={current.systemPrompt}
          label={t.visionSystemPrompt}
          onChange={(systemPrompt) => update({ systemPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title={t.questionPrompt}
        titleAction={
          <PromptResetButton
            value={current.questionPrompt}
            label={t.visionQuestionPrompt}
            defaultValue={DEFAULT_SETTINGS.vision.questionPrompt}
            resetLabel={t.resetDefault}
            onChange={(questionPrompt) => update({ questionPrompt })}
          />
        }
      >
        <PromptField
          value={current.questionPrompt}
          label={t.visionQuestionPrompt}
          onChange={(questionPrompt) => update({ questionPrompt })}
        />
      </SettingGroup>
    </>
  )
}
