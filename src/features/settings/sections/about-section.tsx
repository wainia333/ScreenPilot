import { Download, Upload } from 'lucide-react'
import { useState } from 'react'
import { SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { copyFor } from '../../../shared/ui-copy'
import type { InterfaceLanguage } from '../types'

export function AboutSection({
  onExport,
  onImport,
  language,
  disabled = false,
}: {
  onExport: (includeSecrets: boolean) => void
  onImport: () => void
  language: InterfaceLanguage
  disabled?: boolean
}) {
  const t = copyFor(language)
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
      <SettingGroup title={t.configurationManagement}>
        <SettingRow label={t.exportWithApiKeys} description={t.exportWithApiKeysDescription}>
          <Toggle checked={includeSecrets} label={t.exportIncludesApiKeys} onChange={setIncludeSecrets} />
        </SettingRow>
        <div className="about-actions">
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => onExport(includeSecrets)}>
            <Download size={15} />{t.exportConfiguration}
          </button>
          <button type="button" className="secondary-button" disabled={disabled} onClick={onImport}>
            <Upload size={15} />{t.importConfiguration}
          </button>
        </div>
      </SettingGroup>
      <div className="about-footnote">{t.localOnlyFootnote}</div>
    </>
  )
}
