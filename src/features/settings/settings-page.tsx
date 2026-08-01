import {
  Aperture,
  Bot,
  Info,
  Languages,
  ScanText,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDesktop } from '../../desktop/use-desktop'
import { validateSettings } from './sanitize'
import { AboutSection } from './sections/about-section'
import { GeneralSection } from './sections/general-section'
import { OptimizerSection } from './sections/optimizer-section'
import { ProvidersSection } from './sections/providers-section'
import { ScreenshotSection } from './sections/screenshot-section'
import { TranslationSection } from './sections/translation-section'
import { VisionSection } from './sections/vision-section'
import type { AppSettings, SettingsExport } from './types'
import type { PermissionStatus } from '../../desktop/contract'

type Section = 'general' | 'translation' | 'screenshot' | 'vision' | 'optimizer' | 'providers' | 'about'
type DialogState = 'none' | 'close' | 'import'

const navigation = [
  { id: 'general', label: '常规', icon: Settings2 },
  { id: 'translation', label: '翻译', icon: Languages },
  { id: 'screenshot', label: 'OCR', icon: ScanText },
  { id: 'vision', label: 'Vision', icon: Aperture },
  { id: 'optimizer', label: '提示词优化', icon: Sparkles },
  { id: 'providers', label: '模型提供商', icon: Bot },
  { id: 'about', label: '关于', icon: Info },
] satisfies { id: Section; label: string; icon: typeof Settings2 }[]

function sameSettings(left: AppSettings | null, right: AppSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function SettingsPage() {
  const desktop = useDesktop()
  const [section, setSection] = useState<Section>('general')
  const [saved, setSaved] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<DialogState>('none')
  const [pendingImport, setPendingImport] = useState<SettingsExport | null>(null)
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>()
  const dirty = !sameSettings(saved, draft)
  const load = useCallback(async () => {
    setLoadingError(null)
    try {
      const [settings, startupNotice, permissions] = await Promise.all([
        desktop.loadSettings(),
        desktop.takeStartupNotice(),
        desktop.permissionStatus().catch(() => null),
      ])
      setSaved(settings)
      setDraft(settings)
      setPermissionStatus(permissions)
      if (startupNotice !== null) setStatus(startupNotice)
    } catch (error) {
      setLoadingError(String(error))
    }
  }, [desktop])
  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])
  useEffect(() => {
    if (draft === null) return
    document.documentElement.dataset.theme = draft.theme
    document.documentElement.lang = draft.language === 'zh' ? 'zh-CN' : 'en'
  }, [draft])
  const issues = useMemo(() => (draft === null ? [] : validateSettings(draft)), [draft])
  const save = useCallback(async (): Promise<boolean> => {
    if (draft === null || issues.length > 0 || saving) return false
    setSaving(true)
    setStatus(null)
    try {
      const result = await desktop.saveSettings(draft)
      setSaved(result.settings)
      setDraft(result.settings)
      setStatus('设置已保存并立即生效')
      return true
    } catch (error) {
      setStatus(`保存失败：${String(error)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [desktop, draft, issues.length, saving])
  const hide = useCallback(() => {
    void desktop.hideWindow()
  }, [desktop])
  const requestClose = useCallback(() => {
    if (dirty) setDialog('close')
    else hide()
  }, [dirty, hide])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dialog !== 'none') return
      event.preventDefault()
      requestClose()
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [dialog, requestClose])
  const applyImport = useCallback(
    async (value: SettingsExport) => {
      if (value.includesSecrets && value.secrets !== undefined) {
        await Promise.all(
          Object.entries(value.secrets).map(([providerId, keys]) => desktop.setProviderKeys(providerId, keys)),
        )
      }
      setDraft(value.settings)
      setSection('general')
      setStatus('配置已载入，保存后才会应用')
      setPendingImport(null)
      setDialog('none')
    },
    [desktop],
  )
  if (loadingError !== null) {
    return (
      <main className="load-state">
        <img src="/app-mark.png" alt="" />
        <h1>无法加载设置</h1>
        <p>{loadingError}</p>
        <div>
          <button type="button" className="primary-button" onClick={() => void load()}>
            重试
          </button>
          <button type="button" className="secondary-button" onClick={hide}>
            关闭
          </button>
        </div>
      </main>
    )
  }
  if (draft === null) {
    return <main className="load-state" aria-label="正在加载设置"><div className="spinner" /></main>
  }
  const content = {
    general: (
      <GeneralSection
        settings={draft}
        onChange={setDraft}
        onPickDirectory={() => {
          void desktop.pickDirectory().then((imageArchivePath) => {
            if (imageArchivePath !== null) {
              setDraft({ ...draft, general: { ...draft.general, imageArchivePath } })
            }
          })
        }}
      />
    ),
    translation: <TranslationSection settings={draft} onChange={setDraft} />,
    screenshot: <ScreenshotSection settings={draft} onChange={setDraft} />,
    vision: <VisionSection settings={draft} onChange={setDraft} />,
    optimizer: <OptimizerSection settings={draft} onChange={setDraft} />,
    providers: <ProvidersSection settings={draft} onChange={setDraft} />,
    about: (
      <AboutSection
        onExport={(includeSecrets) => {
          void desktop.exportSettings(includeSecrets).then((exported) => {
            setStatus(exported ? '配置已导出' : null)
          })
        }}
        onImport={() => {
          void desktop.importSettings().then((value) => {
            if (value === null) return
            if (dirty) {
              setPendingImport(value)
              setDialog('import')
            } else {
              void applyImport(value)
            }
          })
        }}
      />
    ),
  } satisfies Record<Section, React.ReactNode>
  return (
    <main className="settings-window">
      <aside className="settings-sidebar">
        <div className="settings-brand" onPointerDown={() => void desktop.startDragging()}>
          <img src="/app-mark.png" alt="" />
          <span>ScreenPilot</span>
        </div>
        <nav aria-label="设置分区">
          {navigation.map((item) => {
            const Icon = item.icon
            return (
              <button
                type="button"
                data-active={section === item.id}
                aria-current={section === item.id ? 'page' : undefined}
                key={item.id}
                onClick={() => setSection(item.id)}
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div
          className="settings-permission-state"
          data-administrator={permissionStatus?.administrator ?? false}
          role="status"
          aria-label="当前运行权限"
        >
          <span />
          {permissionStatus === undefined
            ? '权限：检测中'
            : permissionStatus === null
              ? '权限：检测失败'
              : permissionStatus.administrator
                ? '权限：管理员'
                : '权限：普通用户'}
        </div>
        <div className="settings-save-state" data-dirty={dirty}>
          <span />{dirty ? '有未保存更改' : '所有更改已保存'}
        </div>
      </aside>
      <section className="settings-main">
        <header className="settings-toolbar" onPointerDown={() => void desktop.startDragging()}>
          <h1>{navigation.find((item) => item.id === section)?.label}</h1>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭设置"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="settings-scroll">
          {issues.length === 0 ? null : (
            <div className="validation-banner" role="alert">{issues[0]?.message}</div>
          )}
          {status === null ? null : <div className="status-banner" role="status">{status}</div>}
          {content[section]}
        </div>
        <footer className="settings-footer">
          <button
            type="button"
            className="primary-button"
            disabled={!dirty || issues.length > 0 || saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </section>
      {dialog === 'close' ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
            <h2 id="close-dialog-title">保存更改后关闭？</h2>
            <p>未保存的设置不会生效。</p>
            <div>
              <button
                type="button"
                className="primary-button"
                onClick={() => void save().then((savedNow) => savedNow && hide())}
              >
                保存并关闭
              </button>
              <button type="button" className="secondary-button" onClick={() => { setDraft(saved); hide() }}>
                放弃更改
              </button>
              <button type="button" className="text-button" onClick={() => setDialog('none')}>
                继续编辑
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog === 'import' && pendingImport !== null ? (
        <div className="dialog-backdrop" role="presentation">
          <div className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
            <h2 id="import-dialog-title">覆盖当前未保存内容？</h2>
            <p>导入会替换当前编辑中的设置，但仍需点击保存才会应用。</p>
            <div>
              <button type="button" className="primary-button" onClick={() => void applyImport(pendingImport)}>
                继续导入
              </button>
              <button type="button" className="text-button" onClick={() => { setPendingImport(null); setDialog('none') }}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
