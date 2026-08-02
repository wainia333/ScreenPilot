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
import { normalizeAiAvailability, sanitizeSettings, validateSettings } from './sanitize'
import { AboutSection } from './sections/about-section'
import { GeneralSection } from './sections/general-section'
import { OptimizerSection } from './sections/optimizer-section'
import { ProvidersSection } from './sections/providers-section'
import { ScreenshotSection } from './sections/screenshot-section'
import { TranslationSection } from './sections/translation-section'
import { VisionSection } from './sections/vision-section'
import type { AppSettings, SettingsExport } from './types'
import type { PermissionStatus, ProviderKeyChanges } from '../../desktop/contract'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'

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

function sameProviderKeyDrafts(left: ProviderKeyChanges, right: ProviderKeyChanges): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeProviderKeys(keys: string[]): string[] {
  return keys.map((key) => key.trim()).filter(Boolean)
}

function normalizeProviderKeyDrafts(drafts: ProviderKeyChanges): ProviderKeyChanges {
  return Object.fromEntries(
    Object.entries(drafts).map(([providerId, keys]) => [providerId, normalizeProviderKeys(keys)]),
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}

function credentialErrorMessage(error: unknown, changes: ProviderKeyChanges): string {
  return Object.values(changes).reduce(
    (message, keys) => keys.reduce(
      (current, key) => key.length === 0 ? current : current.split(key).join('***'),
      message,
    ),
    errorMessage(error),
  )
}

function providerKeyChanges(
  saved: AppSettings | null,
  draft: AppSettings,
  keyDrafts: ProviderKeyChanges,
): ProviderKeyChanges {
  const changes: ProviderKeyChanges = {}
  const currentIds = new Set(draft.providers.map((provider) => provider.id))
  Object.entries(keyDrafts).forEach(([providerId, keys]) => {
    if (currentIds.has(providerId)) changes[providerId] = [...keys]
  })
  saved?.providers.forEach((provider) => {
    if (!currentIds.has(provider.id)) changes[provider.id] = []
  })
  return changes
}

function applyProviderKeyCounts(settings: AppSettings, keyDrafts: ProviderKeyChanges): AppSettings {
  return {
    ...settings,
    providers: settings.providers.map((provider) => (
      Object.prototype.hasOwnProperty.call(keyDrafts, provider.id)
        ? { ...provider, keyCount: keyDrafts[provider.id]?.length ?? 0 }
        : provider
    )),
  }
}

function mergeSavedProviderKeyCounts(current: AppSettings, saved: AppSettings): AppSettings {
  const savedProviders = new Map(saved.providers.map((provider) => [provider.id, provider.keyCount]))
  return {
    ...current,
    providers: current.providers.map((provider) => (
      savedProviders.has(provider.id)
        ? { ...provider, keyCount: savedProviders.get(provider.id) ?? provider.keyCount }
        : provider
    )),
  }
}

export function SettingsPage() {
  const desktop = useDesktop()
  const beginWindowDrag = useWindowDrag()
  const [section, setSection] = useState<Section>('general')
  const [saved, setSaved] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<ProviderKeyChanges>({})
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<DialogState>('none')
  const [pendingImport, setPendingImport] = useState<SettingsExport | null>(null)
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>()
  const dirty = !sameSettings(saved, draft) || Object.keys(providerKeyDrafts).length > 0
  const load = useCallback(async () => {
    setLoadingError(null)
    try {
      const [settings, startupNotice, permissions] = await Promise.all([
        desktop.loadSettings(),
        desktop.takeStartupNotice(),
        desktop.permissionStatus().catch(() => null),
      ])
      const normalized = normalizeAiAvailability(settings)
      setSaved(normalized)
      setDraft(normalized)
      setProviderKeyDrafts({})
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
    const keyDraftSnapshot = structuredClone(providerKeyDrafts)
    const submitted = applyProviderKeyCounts(structuredClone(draft), keyDraftSnapshot)
    const changes = providerKeyChanges(saved, submitted, keyDraftSnapshot)
    setSaving(true)
    setStatus(null)
    try {
      const result = await desktop.saveSettings(submitted)
      if (Object.keys(changes).length > 0) {
        try {
          await desktop.saveProviderKeyChanges(changes)
        } catch (error) {
          let rollbackError: unknown = null
          if (saved !== null) {
            try {
              await desktop.saveSettings(saved)
            } catch (restoreError) {
              rollbackError = restoreError
            }
          }
          const credentialError = credentialErrorMessage(error, changes)
          const suffix = rollbackError === null ? '' : `；设置回滚失败：${credentialErrorMessage(rollbackError, changes)}`
          setStatus(`保存失败：凭据保存失败：${credentialError}${suffix}`)
          return false
        }
      }
      setSaved(result.settings)
      setDraft((current) => {
        if (current === null) return current
        const currentSubmitted = applyProviderKeyCounts(current, keyDraftSnapshot)
        return sameSettings(currentSubmitted, submitted)
          ? result.settings
          : mergeSavedProviderKeyCounts(current, result.settings)
      })
      setProviderKeyDrafts((current) => sameProviderKeyDrafts(current, keyDraftSnapshot) ? {} : current)
      setStatus('设置已保存并立即生效')
      return true
    } catch (error) {
      setStatus(`保存失败：${String(error)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [desktop, draft, issues.length, providerKeyDrafts, saved, saving])
  const hide = useCallback(() => {
    void desktop.hideWindow()
  }, [desktop])
  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) setDialog('close')
    else hide()
  }, [dirty, hide, saving])
  const restoreDraft = useCallback(() => {
    if (saved === null) return
    setDraft(normalizeAiAvailability(structuredClone(saved)))
    setProviderKeyDrafts({})
    setStatus(null)
    setPendingImport(null)
    setDialog('none')
  }, [saved])
  const cancel = useCallback(() => {
    if (saving) return
    restoreDraft()
  }, [restoreDraft, saving])
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
    (value: SettingsExport) => {
      setDraft(sanitizeSettings(value.settings))
      setProviderKeyDrafts(
        value.includesSecrets
          ? normalizeProviderKeyDrafts(structuredClone(value.secrets ?? {}))
          : {},
      )
      setSection('general')
      setStatus('配置已载入，保存后才会应用')
      setPendingImport(null)
      setDialog('none')
    },
    [],
  )
  if (loadingError !== null) {
    return (
      <main className="load-state" onPointerDown={beginWindowDrag}>
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
    return <main className="load-state" aria-label="正在加载设置" onPointerDown={beginWindowDrag}><div className="spinner" /></main>
  }
  const content = {
    general: (
      <GeneralSection
        settings={draft}
        onChange={setDraft}
        onPickDirectory={() => {
          void desktop.pickDirectory().then((imageArchivePath) => {
            if (imageArchivePath !== null) {
              setDraft((current) => current === null ? current : ({
                ...current,
                general: { ...current.general, imageArchivePath },
              }))
            }
          })
        }}
      />
    ),
    translation: <TranslationSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    screenshot: <ScreenshotSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    vision: <VisionSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    optimizer: <OptimizerSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    providers: (
      <ProvidersSection
        settings={draft}
        onChange={(update) => setDraft((current) => current === null ? current : normalizeAiAvailability(update(current)))}
        keyDrafts={providerKeyDrafts}
        onKeyDraftChange={(providerId, keys) =>
          setProviderKeyDrafts((current) => ({
            ...current,
            [providerId]: normalizeProviderKeys(keys),
          }))
        }
        onKeyDraftRemove={(providerId) =>
          setProviderKeyDrafts((current) => {
            if (!Object.prototype.hasOwnProperty.call(current, providerId)) return current
            return Object.fromEntries(
              Object.entries(current).filter(([id]) => id !== providerId),
            )
          })
        }
        saving={saving}
      />
    ),
    about: (
      <AboutSection
        disabled={saving}
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
              applyImport(value)
            }
          })
        }}
      />
    ),
  } satisfies Record<Section, React.ReactNode>
  return (
    <main className="settings-window">
      <aside className="settings-sidebar">
        <div className="settings-brand" onPointerDown={beginWindowDrag}>
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
        <header className="settings-toolbar" onPointerDown={beginWindowDrag}>
          <h1>{navigation.find((item) => item.id === section)?.label}</h1>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭设置"
            disabled={saving}
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
            className="secondary-button settings-footer-button"
            disabled={!dirty || saving}
            onClick={cancel}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button settings-footer-button"
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
                disabled={saving}
                onClick={() => void save().then((savedNow) => savedNow && hide())}
              >
                保存并关闭
              </button>
              <button type="button" className="secondary-button" disabled={saving} onClick={() => { restoreDraft(); hide() }}>
                放弃更改
              </button>
              <button type="button" className="text-button" disabled={saving} onClick={() => setDialog('none')}>
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
              <button type="button" className="primary-button" disabled={saving} onClick={() => applyImport(pendingImport)}>
                继续导入
              </button>
              <button type="button" className="text-button" disabled={saving} onClick={() => { setPendingImport(null); setDialog('none') }}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
