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
  operation = null,
}: {
  onExport: (includeSecrets: boolean) => void
  onImport: () => void
  language: InterfaceLanguage
  disabled?: boolean
  operation?: 'export' | 'import' | null
}) {
  const t = copyFor(language)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  return (
    <>
      <div className="about-identity">
        <img src="/app-mark.png" alt="ScreenPilot" />
        <div>
          <h1>ScreenPilot</h1>
          <p>Version 0.1.5 · Wainia</p>
        </div>
      </div>
      <SettingGroup title={t.configurationManagement}>
        <SettingRow label={t.exportWithApiKeys} description={t.exportWithApiKeysDescription}>
          <Toggle checked={includeSecrets} label={t.exportIncludesApiKeys} onChange={setIncludeSecrets} />
        </SettingRow>
        <div className="about-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || operation !== null}
            aria-busy={operation === 'export'}
            onClick={() => onExport(includeSecrets)}
          >
            <Download size={15} />{t.exportConfiguration}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || operation !== null}
            aria-busy={operation === 'import'}
            onClick={onImport}
          >
            <Upload size={15} />{t.importConfiguration}
          </button>
        </div>
      </SettingGroup>
      <div className="about-footnote">{t.localOnlyFootnote}</div>
      <section className="about-credits" aria-labelledby="about-credits-heading">
        <h2 id="about-credits-heading">{language === 'zh' ? '致谢' : 'Acknowledgements'}</h2>
        <p>此项目在开发过程中参考了一些非常优秀的项目：</p>
        <ul>
          <li><a href="https://github.com/ZMGID/kivio">https://github.com/ZMGID/kivio</a></li>
          <li><a href="https://github.com/RamonUnch/AltSnap">https://github.com/RamonUnch/AltSnap</a></li>
        </ul>
      </section>
    </>
  )
}
