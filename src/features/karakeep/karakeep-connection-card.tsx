import { useEffect, useRef, useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { PromptField, PromptResetButton, SelectField, SettingGroup, SettingRow, Toggle } from '../../shared/ui/controls'
import { DEFAULT_KARAKEEP_SYSTEM_PROMPT } from '../settings/defaults'
import { copyFor } from '../../shared/ui-copy'
import type { KarakeepConfig } from './types'
import './karakeep.css'

export function KarakeepConnectionCard({ config, onChange, keyDraft, onKeyChange, saving, language, onTestResult }: {
  config: KarakeepConfig; onChange: (config: KarakeepConfig) => void; keyDraft: string | null
  onKeyChange: (key: string | null) => void; saving: boolean; language: 'zh' | 'en'
  onTestResult: (message: string, failed?: boolean) => void
}) {
  const desktop = useDesktop()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [testing, setTesting] = useState(false)
  const sequence = useRef(0)
  const en = language === 'en'
  const t = copyFor(language)
  const promptLabel = en ? 'KaraKeep system prompt' : 'KaraKeep 系统提示词'
  useEffect(() => {
    let active = true
    void desktop.karakeepConfigured().then(value => { if (active) setConfigured(value) }).catch(() => { if (active) setConfigured(null) })
    return () => { active = false }
  }, [desktop, saving])
  useEffect(() => { sequence.current += 1 }, [config.baseUrl, keyDraft])
  useEffect(() => () => { sequence.current += 1 }, [])
  const invalidate = () => { sequence.current += 1; setTesting(false) }
  const update = (patch: Partial<KarakeepConfig>) => { invalidate(); onChange({ ...config, ...patch }) }
  const test = async () => {
    const token = ++sequence.current
    setTesting(true)
    try {
      const result = await desktop.testKarakeep(config.baseUrl, keyDraft ?? undefined)
      if (sequence.current === token) onTestResult(result.connected ? (en ? 'Read-only API connection succeeded' : '只读API连接成功') : result.message, !result.connected)
    } catch (error) {
      if (sequence.current === token) onTestResult(String(error), true)
    } finally { if (sequence.current === token) setTesting(false) }
  }
  return <div className="karakeep-settings"><SettingGroup title="KaraKeep">
    <SettingRow label={en ? 'Enable saved library' : '启用收藏库'}>
      <Toggle checked={config.enabled} label={en ? 'Enable Karakeep' : '启用 Karakeep'} onChange={enabled => update({ enabled })} />
    </SettingRow>
    <SettingRow label={en ? 'Instance URL' : '实例地址'}>
      <input className="connection-input" aria-label={en ? 'Karakeep instance URL' : 'Karakeep 实例地址'} type="url" placeholder="https://saved.example.com/" value={config.baseUrl} disabled={saving} onChange={e => update({ baseUrl: e.target.value, instanceId: '' })} />
    </SettingRow>
    <SettingRow label="API Key">
      <input className="connection-input" aria-label="Karakeep API Key" type="password" autoComplete="new-password" value={keyDraft ?? ''} disabled={saving} placeholder={configured ? '************' : ''} onChange={e => { invalidate(); onKeyChange(e.target.value || null) }} />
    </SettingRow>
    <SettingRow label={en ? 'Call policy' : '调用策略'}>
      <SelectField value={config.visionPolicy} label={en ? 'Call policy' : '调用策略'} options={[{ value: 'auto', label: en ? 'Automatic' : '自动' }, { value: 'off', label: en ? 'Off' : '关闭' }, { value: 'only', label: en ? 'Saved library only' : '仅收藏' }]} onChange={visionPolicy => update({ visionPolicy })} />
    </SettingRow>
    <SettingRow label={en ? 'Connection' : '连接'}>
      <button className="secondary-button" type="button" disabled={testing || saving || !config.baseUrl.trim()} onClick={() => void test()}>{testing ? (en ? 'Testing…' : '正在测试…') : (en ? 'Test connection' : '测试连接')}</button>
    </SettingRow>
  </SettingGroup>
    <SettingGroup title={t.systemPrompt} titleAction={
      <PromptResetButton value={config.systemPrompt} label={promptLabel} defaultValue={DEFAULT_KARAKEEP_SYSTEM_PROMPT} resetLabel={t.resetDefault} onChange={systemPrompt => update({ systemPrompt })} />
    }>
      <PromptField value={config.systemPrompt} label={promptLabel} onChange={systemPrompt => update({ systemPrompt })} />
    </SettingGroup>
  </div>
}
