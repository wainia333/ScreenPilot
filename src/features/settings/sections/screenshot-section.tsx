import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { ModelField } from '../model-options'
import { AdapterCredentials } from '../adapter-credentials'
import { translationMethodOptions } from '../translation-methods'
import type { AppSettings, OcrMethod, ThinkingEffort } from '../types'
import { DEFAULT_SETTINGS } from '../defaults'
import { isValidModelSelection, normalizeAiAvailability } from '../sanitize'

export function ScreenshotSection({
  settings,
  onChange,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
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
  const methods = translationMethodOptions.filter((option) => option.value !== 'ai' || canUseTranslationAi)
  return (
    <>
      <SettingGroup title="截图翻译">
        <SettingRow label="启用截图翻译">
          <Toggle checked={current.enabled} label="启用截图翻译" onChange={(enabled) => update({ enabled })} />
        </SettingRow>
        <SettingRow label="目标语言">
          <SelectField
            value={current.targetLanguage}
            label="截图翻译目标语言"
            options={[
              { value: 'auto', label: '自动' },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
              { value: 'ja', label: '日本語' },
              { value: 'ko', label: '한국어' },
            ]}
            onChange={(targetLanguage) => update({ targetLanguage })}
          />
        </SettingRow>
        <SettingRow label="源语言">
          <SelectField
            value={current.sourceLanguage}
            label="截图翻译源语言"
            options={[
              { value: 'auto', label: '自动' },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
              { value: 'ja', label: '日本語' },
              { value: 'ko', label: '한국어' },
            ]}
            onChange={(sourceLanguage) => update({ sourceLanguage })}
          />
        </SettingRow>
        <SettingRow label="开启大模型 OCR">
          <Toggle
            checked={current.ocrAiEnabled}
            label="开启大模型 OCR"
            onChange={(ocrAiEnabled) => update({ ocrAiEnabled })}
          />
        </SettingRow>
        {current.ocrAiEnabled ? (
          <SettingRow label="OCR 模型">
            <ModelField
              value={current.ocrModel}
              providers={settings.providers}
              label="OCR 模型"
              onChange={(ocrModel) => update({ ocrModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="OCR 接口">
          <SelectField<OcrMethod>
            value={ocrMethod}
            label="OCR 接口"
            options={[
              ...(canUseOcrAi ? [{ value: 'ai' as const, label: 'AI 视觉 OCR' }] : []),
              { value: 'baidu', label: '百度 OCR' },
              { value: 'chaoxing', label: '学习通 OCR' },
              { value: 'system', label: '系统 OCR' },
            ]}
            onChange={(ocrMethod) => update({ ocrMethod })}
          />
        </SettingRow>
        <SettingRow label="开启大模型翻译">
          <Toggle
            checked={current.translationAiEnabled}
            label="开启大模型翻译"
            onChange={(translationAiEnabled) => update({ translationAiEnabled })}
          />
        </SettingRow>
        {current.translationAiEnabled ? (
          <SettingRow label="翻译模型">
            <ModelField
              value={current.translationModel}
              providers={settings.providers}
              label="截图翻译模型"
              onChange={(translationModel) => update({ translationModel })}
            />
          </SettingRow>
        ) : null}
        <SettingRow label="翻译接口">
          <SelectField
            value={translationMethod}
            label="截图翻译接口"
            options={methods}
            onChange={(translationMethod) => update({ translationMethod })}
          />
        </SettingRow>
        <SettingRow label="显示识别原文">
          <Toggle checked={current.showSource} label="显示识别原文" onChange={(showSource) => update({ showSource })} />
        </SettingRow>
        <SettingRow label="流式输出">
          <Toggle checked={current.stream} label="截图翻译流式输出" onChange={(stream) => update({ stream })} />
        </SettingRow>
        <SettingRow label="显示思考过程">
          <Toggle checked={current.thinking} label="显示思考过程" onChange={(thinking) => update({ thinking })} />
        </SettingRow>
        {current.thinking ? (
          <SettingRow label="思考强度">
            <SelectField<ThinkingEffort>
              value={current.thinkingEffort}
              label="截图翻译思考强度"
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
        title="OCR 提示词"
        titleAction={
          <PromptResetButton
            value={current.ocrPrompt}
            label="OCR 提示词"
            defaultValue={DEFAULT_SETTINGS.screenshotTranslation.ocrPrompt}
            onChange={(ocrPrompt) => update({ ocrPrompt })}
          />
        }
      >
        <PromptField
          value={current.ocrPrompt}
          label="OCR 提示词"
          onChange={(ocrPrompt) => update({ ocrPrompt })}
        />
      </SettingGroup>
      <SettingGroup
        title="截图翻译提示词"
        titleAction={
          <PromptResetButton
            value={current.translationPrompt}
            label="截图翻译提示词"
            defaultValue={DEFAULT_SETTINGS.screenshotTranslation.translationPrompt}
            onChange={(translationPrompt) => update({ translationPrompt })}
          />
        }
      >
        <PromptField
          value={current.translationPrompt}
          label="截图翻译提示词"
          onChange={(translationPrompt) => update({ translationPrompt })}
        />
      </SettingGroup>
      <AdapterCredentials />
    </>
  )
}
