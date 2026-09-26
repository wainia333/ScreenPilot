import { FolderOpen } from 'lucide-react'
import { SettingGroup, SettingRow, Segmented, SelectField, Toggle } from '../../../shared/ui/controls'
import { ShortcutRecorder } from '../shortcut-recorder'
import type { AppSettings, InterfaceLanguage, ThemeMode } from '../types'
import { copyFor } from '../../../shared/ui-copy'

export function GeneralSection({
  settings,
  onChange,
  onPickDirectory,
  pickDirectoryDisabled = false,
  pickingDirectory = false,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
  onPickDirectory: () => void
  pickDirectoryDisabled?: boolean
  pickingDirectory?: boolean
}) {
  const t = copyFor(settings.language)
  const updateGeneral = (patch: Partial<AppSettings['general']>) =>
    onChange({ ...settings, general: { ...settings.general, ...patch } })
  const updateShortcut = (key: keyof AppSettings['shortcuts'], value: string) =>
    onChange({ ...settings, shortcuts: { ...settings.shortcuts, [key]: value } })
  return (
    <>
      <SettingGroup title={t.appearanceAndLanguage}>
        <SettingRow label={t.theme}>
          <Segmented<ThemeMode>
            value={settings.theme}
            label={t.theme}
            options={[
              { value: 'system', label: t.themeSystem },
              { value: 'light', label: t.themeLight },
              { value: 'dark', label: t.themeDark },
            ]}
            onChange={(theme) => onChange({ ...settings, theme })}
          />
        </SettingRow>
        <SettingRow label={t.interfaceLanguage}>
          <Segmented<InterfaceLanguage>
            value={settings.language}
            label={t.interfaceLanguage}
            options={[
              { value: 'zh', label: t.chinese },
              { value: 'en', label: t.english },
            ]}
            onChange={(language) => onChange({ ...settings, language })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={t.runtimeBehavior}>
        <SettingRow label={t.automaticRetry}>
          <Toggle
            checked={settings.retry.enabled}
            label={t.automaticRetry}
            onChange={(enabled) => onChange({ ...settings, retry: { ...settings.retry, enabled } })}
          />
        </SettingRow>
        <SettingRow label={t.retryAttempts}>
          <SelectField
            value={String(settings.retry.attempts)}
            label={t.retryAttempts}
            options={[1, 2, 3, 4, 5].map((attempt) => ({ value: String(attempt), label: String(attempt) }))}
            onChange={(attempts) =>
              onChange({ ...settings, retry: { ...settings.retry, attempts: Number(attempts) } })
            }
          />
        </SettingRow>
        <SettingRow label={t.autoPaste} description={t.autoPasteDescription}>
          <Toggle
            checked={settings.general.autoPaste}
            label={t.autoPaste}
            onChange={(autoPaste) => updateGeneral({ autoPaste })}
          />
        </SettingRow>
        <SettingRow label={t.launchAtStartup}>
          <Toggle
            checked={settings.general.launchAtStartup}
            label={t.launchAtStartup}
            onChange={(launchAtStartup) => updateGeneral({ launchAtStartup })}
          />
        </SettingRow>
        {settings.general.launchAtStartup ? (
          <SettingRow
            nested
            label={t.launchAsAdministrator}
            description={t.launchAsAdministratorDescription}
          >
            <Toggle
              checked={settings.general.launchAtStartupAsAdministrator}
              label={t.launchAsAdministrator}
              onChange={(launchAtStartupAsAdministrator) =>
                updateGeneral({ launchAtStartupAsAdministrator })
              }
            />
          </SettingRow>
        ) : null}
        <SettingRow label={t.screenshotArchive} description={t.archiveDataFlowDescription}>
          <Toggle
            checked={settings.general.imageArchiveEnabled}
            label={t.screenshotArchive}
            onChange={(imageArchiveEnabled) => updateGeneral({ imageArchiveEnabled })}
          />
        </SettingRow>
        {settings.general.imageArchiveEnabled ? (
          <SettingRow label={t.archiveDirectory}>
            <button
              type="button"
              className="path-button"
              data-settings-issue-path="general.imageArchivePath"
              disabled={pickDirectoryDisabled}
              aria-busy={pickingDirectory}
              onClick={onPickDirectory}
            >
              <FolderOpen size={15} />
              <span>{settings.general.imageArchivePath || t.chooseDirectory}</span>
            </button>
          </SettingRow>
        ) : null}
      </SettingGroup>
      <SettingGroup title={t.globalShortcuts}>
        <SettingRow label={t.textTranslation}>
          <ShortcutRecorder
            value={settings.shortcuts.translator}
            label={t.recordTextTranslationShortcut}
            recordingLabel={t.pressShortcut}
            issuePath="shortcuts.translator"
            onChange={(value) => updateShortcut('translator', value)}
          />
        </SettingRow>
        <SettingRow label="Vision">
          <ShortcutRecorder
            value={settings.shortcuts.vision}
            label={t.recordVisionShortcut}
            recordingLabel={t.pressShortcut}
            issuePath="shortcuts.vision"
            onChange={(value) => updateShortcut('vision', value)}
          />
        </SettingRow>
        <SettingRow label={t.screenshotTranslation}>
          <ShortcutRecorder
            value={settings.shortcuts.screenshotTranslation}
            label={t.recordScreenshotShortcut}
            recordingLabel={t.pressShortcut}
            issuePath="shortcuts.screenshotTranslation"
            onChange={(value) => updateShortcut('screenshotTranslation', value)}
          />
        </SettingRow>
        <SettingRow label={t.promptOptimization}>
          <ShortcutRecorder
            value={settings.shortcuts.promptOptimizer}
            label={t.recordOptimizerShortcut}
            recordingLabel={t.pressShortcut}
            issuePath="shortcuts.promptOptimizer"
            onChange={(value) => updateShortcut('promptOptimizer', value)}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
