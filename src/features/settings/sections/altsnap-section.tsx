import { SettingGroup, SettingRow, Toggle } from '../../../shared/ui/controls'
import { copyFor } from '../../../shared/ui-copy'
import { ShortcutRecorder } from '../shortcut-recorder'
import { displayShortcut } from '../shortcuts'
import type { AppSettings } from '../types'

export function AltSnapSection({ settings, onChange }: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
}) {
  const t = copyFor(settings.language)
  const update = (patch: Partial<AppSettings['altSnap']>) =>
    onChange({ ...settings, altSnap: { ...settings.altSnap, ...patch } })
  const shortcut = displayShortcut(settings.altSnap.shortcut)
  return (
    <SettingGroup title="AltSnap">
      <SettingRow label={t.altSnapEnabled}>
        <Toggle checked={settings.altSnap.enabled} label={t.altSnapEnabled} onChange={(enabled) => update({ enabled })} />
      </SettingRow>
      <SettingRow label={t.altSnapShortcut}>
        <ShortcutRecorder value={settings.altSnap.shortcut} label={t.altSnapShortcut}
          recordingLabel={t.pressShortcut} allowModifierOnly onChange={(value) => update({ shortcut: value })} />
      </SettingRow>
      <SettingRow label={t.altSnapMove}><kbd>{shortcut} + {t.altSnapLeftDrag}</kbd></SettingRow>
      <SettingRow label={t.altSnapResize}><kbd>{shortcut} + {t.altSnapRightDrag}</kbd></SettingRow>
      <ul className="altsnap-hints">
        {t.altSnapHint.split('|').map((hint) => <li key={hint}>{hint}</li>)}
      </ul>
    </SettingGroup>
  )
}
