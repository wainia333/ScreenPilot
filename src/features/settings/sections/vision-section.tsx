import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import type { AppSettings, MessageOrder, ThinkingEffort } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'

export function VisionSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const current = settings.vision
  const update = (patch: Partial<AppSettings['vision']>) =>
    onChange({ ...settings, vision: { ...current, ...patch } })
  return (
    <>
      <SettingGroup title="Vision 问答">
        <SettingRow label="启用 Vision">
          <Toggle checked={current.enabled} label="启用 Vision" onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label="回答语言">
          <SelectField
            value={current.responseLanguage}
            label="Vision 回答语言"
            options={[
              { value: 'auto', label: '跟随问题' },
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
            label="Vision 模型"
            onChange={(model) => update({ model })}
          />
        </SettingRow>
        <SettingRow label="流式输出">
          <Toggle checked={current.stream} label="Vision 流式输出" onChange={(stream) => update({ stream })} />
        </SettingRow>
        <SettingRow label="显示思考过程/摘要">
          <Toggle checked={current.thinking} label="Vision 显示思考过程/摘要" onChange={(thinking) => update({ thinking })} />
        </SettingRow>
        {current.thinking ? (
          <SettingRow label="思考强度">
            <SelectField<ThinkingEffort>
              value={current.thinkingEffort}
              label="Vision 思考强度"
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
        <SettingRow label="联网搜索">
          <Toggle checked={current.webSearch} label="联网搜索" onChange={(webSearch) => update({ webSearch })} />
        </SettingRow>
        <SettingRow label="消息顺序">
          <SelectField<MessageOrder>
            value={current.messageOrder}
            label="消息顺序"
            options={[
              { value: 'asc', label: '旧消息在上' },
              { value: 'desc', label: '新消息在上' },
            ]}
            onChange={(messageOrder) => update({ messageOrder })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup
        title="系统提示词"
        titleAction={
          <PromptResetButton
            value={current.systemPrompt}
            label="Vision 系统提示词"
            defaultValue={DEFAULT_SETTINGS.vision.systemPrompt}
            onChange={(systemPrompt) => update({ systemPrompt })}
          />
        }
      >
        <PromptField
          value={current.systemPrompt}
          label="Vision 系统提示词"
          onChange={(systemPrompt) => update({ systemPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title="问答提示词"
        titleAction={
          <PromptResetButton
            value={current.questionPrompt}
            label="Vision 问答提示词"
            defaultValue={DEFAULT_SETTINGS.vision.questionPrompt}
            onChange={(questionPrompt) => update({ questionPrompt })}
          />
        }
      >
        <PromptField
          value={current.questionPrompt}
          label="Vision 问答提示词"
          onChange={(questionPrompt) => update({ questionPrompt })}
        />
      </SettingGroup>
    </>
  )
}
