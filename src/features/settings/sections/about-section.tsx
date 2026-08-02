import { Download, Upload } from 'lucide-react'
import { useState } from 'react'
import { SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'

export function AboutSection({
  onExport,
  onImport,
  disabled = false,
}: {
  onExport: (includeSecrets: boolean) => void
  onImport: () => void
  disabled?: boolean
}) {
  const [includeSecrets, setIncludeSecrets] = useState(false)
  return (
    <>
      <div className="about-identity">
        <img src="/app-mark.png" alt="ScreenPilot" />
        <div>
          <h1>ScreenPilot</h1>
          <p>Version 0.1.0 · Wainia</p>
        </div>
      </div>
      <SettingGroup title="配置管理">
        <SettingRow label="导出时包含 API Key" description="默认关闭；开启后导出文件将包含敏感信息">
          <Toggle checked={includeSecrets} label="导出包含 API Key" onChange={setIncludeSecrets} />
        </SettingRow>
        <div className="about-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => onExport(includeSecrets)}>
            <Download size={15} />导出配置
          </button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={onImport}>
            <Upload size={15} />导入配置
          </button>
        </div>
      </SettingGroup>
      <div className="about-footnote">ScreenPilot 在本机处理设置与历史元数据，不提供账号或云端同步。</div>
    </>
  )
}
