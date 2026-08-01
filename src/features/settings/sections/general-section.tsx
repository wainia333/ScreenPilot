import { FolderOpen } from 'lucide-react'
import { SettingGroup, SettingRow, Segmented, SelectField, Toggle } from '../../../shared/ui/controls'
import { ShortcutRecorder } from '../shortcut-recorder'
import type { AppSettings, InterfaceLanguage, ThemeMode } from '../types'
import type { PermissionStatus } from '../../../desktop/contract'

export function GeneralSection({
  settings,
  onChange,
  onPickDirectory,
  permissionStatus,
}: {
  settings: AppSettings
  onChange: (settings: AppSettings) => void
  onPickDirectory: () => void
  permissionStatus: PermissionStatus | null | undefined
}) {
  const updateGeneral = (patch: Partial<AppSettings['general']>) =>
    onChange({ ...settings, general: { ...settings.general, ...patch } })
  const updateShortcut = (key: keyof AppSettings['shortcuts'], value: string) =>
    onChange({ ...settings, shortcuts: { ...settings.shortcuts, [key]: value } })
  return (
    <>
      <SettingGroup title="外观与语言">
        <SettingRow label="主题">
          <Segmented<ThemeMode>
            value={settings.theme}
            label="主题"
            options={[
              { value: 'system', label: '系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
            onChange={(theme) => onChange({ ...settings, theme })}
          />
        </SettingRow>
        <SettingRow label="界面语言">
          <Segmented<InterfaceLanguage>
            value={settings.language}
            label="界面语言"
            options={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            onChange={(language) => onChange({ ...settings, language })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="运行行为">
        <SettingRow label="当前权限" description="显示 ScreenPilot 当前进程的实际 Windows 权限">
          <span
            className="permission-status"
            data-administrator={permissionStatus?.administrator ?? false}
            role="status"
          >
            {permissionStatus === undefined
              ? '正在检测权限'
              : permissionStatus === null
              ? '权限检测失败'
              : permissionStatus.administrator
                ? '管理员身份'
                : '标准用户身份'}
          </span>
        </SettingRow>
        <SettingRow label="自动重试">
          <Toggle
            checked={settings.retry.enabled}
            label="自动重试"
            onChange={(enabled) => onChange({ ...settings, retry: { ...settings.retry, enabled } })}
          />
        </SettingRow>
        <SettingRow label="重试次数">
          <SelectField
            value={String(settings.retry.attempts)}
            label="重试次数"
            options={[1, 2, 3, 4, 5].map((attempt) => ({ value: String(attempt), label: String(attempt) }))}
            onChange={(attempts) =>
              onChange({ ...settings, retry: { ...settings.retry, attempts: Number(attempts) } })
            }
          />
        </SettingRow>
        <SettingRow label="自动上屏" description="提交后等待约 600ms，再粘贴回原应用">
          <Toggle
            checked={settings.general.autoPaste}
            label="自动上屏"
            onChange={(autoPaste) => updateGeneral({ autoPaste })}
          />
        </SettingRow>
        <SettingRow label="开机启动">
          <Toggle
            checked={settings.general.launchAtStartup}
            label="开机启动"
            onChange={(launchAtStartup) => updateGeneral({ launchAtStartup })}
          />
        </SettingRow>
        <SettingRow label="管理员开机启动" description="保存时 Windows 会请求 UAC 确认">
          <Toggle
            checked={settings.general.launchAtStartupAsAdministrator}
            label="管理员开机启动"
            onChange={(launchAtStartupAsAdministrator) =>
              updateGeneral({ launchAtStartupAsAdministrator })
            }
          />
        </SettingRow>
        <SettingRow label="截图自动归档">
          <Toggle
            checked={settings.general.imageArchiveEnabled}
            label="截图自动归档"
            onChange={(imageArchiveEnabled) => updateGeneral({ imageArchiveEnabled })}
          />
        </SettingRow>
        {settings.general.imageArchiveEnabled ? (
          <SettingRow label="归档目录">
            <button type="button" className="path-button" onClick={onPickDirectory}>
              <FolderOpen size={15} />
              <span>{settings.general.imageArchivePath || '选择目录'}</span>
            </button>
          </SettingRow>
        ) : null}
      </SettingGroup>
      <SettingGroup title="全局快捷键">
        <SettingRow label="文本翻译">
          <ShortcutRecorder
            value={settings.shortcuts.translator}
            label="录制文本翻译快捷键"
            onChange={(value) => updateShortcut('translator', value)}
          />
        </SettingRow>
        <SettingRow label="Vision">
          <ShortcutRecorder
            value={settings.shortcuts.vision}
            label="录制 Vision 快捷键"
            onChange={(value) => updateShortcut('vision', value)}
          />
        </SettingRow>
        <SettingRow label="截图翻译">
          <ShortcutRecorder
            value={settings.shortcuts.screenshotTranslation}
            label="录制截图翻译快捷键"
            onChange={(value) => updateShortcut('screenshotTranslation', value)}
          />
        </SettingRow>
        <SettingRow label="提示词优化">
          <ShortcutRecorder
            value={settings.shortcuts.promptOptimizer}
            label="录制提示词优化快捷键"
            onChange={(value) => updateShortcut('promptOptimizer', value)}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
