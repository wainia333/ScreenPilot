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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useDesktop } from '../../desktop/use-desktop'
import { normalizeAiAvailability, sanitizeSettings, validateSettings } from './sanitize'
import { AboutSection } from './sections/about-section'
import { GeneralSection } from './sections/general-section'
import { OptimizerSection } from './sections/optimizer-section'
import { ProvidersSection, type ProviderKeyTextDrafts } from './sections/providers-section'
import { ScreenshotSection } from './sections/screenshot-section'
import { TranslationSection } from './sections/translation-section'
import { VisionSection } from './sections/vision-section'
import type { AppSettings, SettingsExport, SettingsIssue, SettingsSecrets } from './types'
import type { PermissionStatus, ProviderKeyChanges } from '../../desktop/contract'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { copyFor, type UiCopy } from '../../shared/ui-copy'
import { syncDocumentTheme } from '../../shared/theme'
import { ModalDialog } from '../../shared/ui/modal-dialog'

type Section = 'general' | 'translation' | 'screenshot' | 'vision' | 'optimizer' | 'providers' | 'about'
type DialogState = 'none' | 'close' | 'import'

const SAVE_SUCCESS_TOAST_VISIBLE_MS = 3_200
const SAVE_SUCCESS_TOAST_EXIT_MS = 200

type SaveSuccessToast = {
  key: number
  message: string
  phase: 'visible' | 'leaving'
}

const navigation = [
  { id: 'general', label: 'navGeneral', icon: Settings2 },
  { id: 'translation', label: 'navTranslation', icon: Languages },
  { id: 'screenshot', label: 'navScreenshot', icon: ScanText },
  { id: 'vision', label: 'navVision', icon: Aperture },
  { id: 'optimizer', label: 'navOptimizer', icon: Sparkles },
  { id: 'providers', label: 'navProviders', icon: Bot },
  { id: 'about', label: 'navAbout', icon: Info },
] satisfies { id: Section; label: keyof UiCopy; icon: typeof Settings2 }[]

function sameSettings(left: AppSettings | null, right: AppSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameProviderKeyDrafts(left: ProviderKeyTextDrafts, right: ProviderKeyTextDrafts): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeProviderKeys(value: string): string[] {
  return value.split(/\r?\n/u).map((key) => key.trim()).filter(Boolean)
}

function normalizeProviderKeyDrafts(drafts: ProviderKeyTextDrafts): ProviderKeyChanges {
  return Object.fromEntries(
    Object.entries(drafts).map(([providerId, value]) => [providerId, normalizeProviderKeys(value)]),
  )
}

function providerKeyTextDrafts(changes: ProviderKeyChanges): ProviderKeyTextDrafts {
  return Object.fromEntries(
    Object.entries(changes).map(([providerId, keys]) => [providerId, keys.join('\n')]),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return fallback
}

function credentialErrorMessage(error: unknown, changes: ProviderKeyChanges, fallback: string): string {
  return Object.values(changes).reduce(
    (message, keys) => keys.reduce(
      (current, key) => key.length === 0 ? current : current.split(key).join('***'),
      message,
    ),
    errorMessage(error, fallback),
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

function settingsIssueMessage(issue: SettingsIssue | undefined, t: UiCopy): string | undefined {
  if (issue === undefined) return undefined
  if (issue.path.startsWith('shortcuts.')) {
    return issue.code === 'missing' ? t.shortcutMissing : t.shortcutConflict
  }
  if (issue.path.endsWith('.baseUrl')) {
    return issue.code === 'unsafe' ? t.providerHttpsRequired : t.providerUrlInvalid
  }
  if (issue.path === 'general.imageArchivePath') return t.archiveDirectoryRequired
  if (issue.path.startsWith('providers.') && issue.code === 'conflict') return t.duplicateProviderId
  return issue.message
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
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<ProviderKeyTextDrafts>({})
  const [importedSecrets, setImportedSecrets] = useState<SettingsSecrets | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [status, setStatusState] = useState<string | null>(null)
  const [startupNoticePending, setStartupNoticePending] = useState(false)
  const [saveSuccessToast, setSaveSuccessToast] = useState<SaveSuccessToast | null>(null)
  const saveSuccessToastSequence = useRef(0)
  const saveSuccessToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSuccessToastExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<DialogState>('none')
  const [pendingImport, setPendingImport] = useState<SettingsExport | null>(null)
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>()
  const continueEditingRef = useRef<HTMLButtonElement>(null)
  const cancelImportRef = useRef<HTMLButtonElement>(null)
  const language = draft?.language ?? saved?.language ?? 'zh'
  const t = copyFor(language)
  const activeNavigation = navigation.find((item) => item.id === section) ?? {
    id: 'general' as const,
    label: 'navGeneral' as const,
    icon: Settings2,
  }
  const dirty = !sameSettings(saved, draft) || Object.keys(providerKeyDrafts).length > 0 || importedSecrets !== null
  const clearSaveSuccessToastTimer = useCallback(() => {
    if (saveSuccessToastTimer.current !== null) {
      clearTimeout(saveSuccessToastTimer.current)
      saveSuccessToastTimer.current = null
    }
    if (saveSuccessToastExitTimer.current !== null) {
      clearTimeout(saveSuccessToastExitTimer.current)
      saveSuccessToastExitTimer.current = null
    }
  }, [])
  const dismissSaveSuccessToast = useCallback(() => {
    clearSaveSuccessToastTimer()
    setSaveSuccessToast(null)
  }, [clearSaveSuccessToastTimer])
  const setStatus = useCallback((message: string | null) => {
    dismissSaveSuccessToast()
    setStatusState(message)
  }, [dismissSaveSuccessToast])
  const showSaveSuccessToast = useCallback(() => {
    clearSaveSuccessToastTimer()
    setStatusState(null)
    const key = saveSuccessToastSequence.current + 1
    saveSuccessToastSequence.current = key
    setSaveSuccessToast({
      key,
      message: t.settingsSaved,
      phase: 'visible',
    })
    saveSuccessToastTimer.current = setTimeout(() => {
      saveSuccessToastTimer.current = null
      if (saveSuccessToastSequence.current !== key) return
      setSaveSuccessToast((current) => current?.key === key ? { ...current, phase: 'leaving' } : current)
      saveSuccessToastExitTimer.current = setTimeout(() => {
        saveSuccessToastExitTimer.current = null
        if (saveSuccessToastSequence.current === key) setSaveSuccessToast(null)
      }, SAVE_SUCCESS_TOAST_EXIT_MS)
    }, SAVE_SUCCESS_TOAST_VISIBLE_MS)
  }, [clearSaveSuccessToastTimer, t.settingsSaved])
  useEffect(() => () => clearSaveSuccessToastTimer(), [clearSaveSuccessToastTimer])
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
      setImportedSecrets(null)
      setPermissionStatus(permissions)
      if (startupNotice !== null) {
        setStatus(startupNotice)
        setStartupNoticePending(true)
      }
    } catch (error) {
      setLoadingError(String(error))
    }
  }, [desktop, setStatus])
  useEffect(() => {
    queueMicrotask(() => void load())
  }, [load])
  useEffect(() => {
    if (!startupNoticePending) return
    let active = true
    const acknowledge = () => {
      void desktop.acknowledgeStartupNotice().then((acknowledged) => {
        if (active && acknowledged) setStartupNoticePending(false)
      }).catch(() => undefined)
    }
    acknowledge()
    window.addEventListener('focus', acknowledge)
    return () => {
      active = false
      window.removeEventListener('focus', acknowledge)
    }
  }, [desktop, startupNoticePending])
  useEffect(() => {
    if (draft === null) return
    syncDocumentTheme(draft.theme)
    document.documentElement.lang = draft.language === 'zh' ? 'zh-CN' : 'en'
    document.title = `ScreenPilot — ${copyFor(draft.language)[activeNavigation.label]}`
    if ('__TAURI_INTERNALS__' in window) void getCurrentWindow().setTitle(document.title)
  }, [activeNavigation.label, draft])
  const issues = useMemo(() => (draft === null ? [] : validateSettings(draft)), [draft])
  const save = useCallback(async (): Promise<boolean> => {
    if (draft === null || issues.length > 0 || saving) return false
    const keyDraftSnapshot = structuredClone(providerKeyDrafts)
    const importedSecretsSnapshot = importedSecrets === null ? null : structuredClone(importedSecrets)
    const normalizedKeyDraftSnapshot = normalizeProviderKeyDrafts(keyDraftSnapshot)
    const submitted = applyProviderKeyCounts(structuredClone(draft), normalizedKeyDraftSnapshot)
    const changes = providerKeyChanges(saved, submitted, normalizedKeyDraftSnapshot)
    const submittedProviderIds = new Set(submitted.providers.map((provider) => provider.id))
    const providerDeletionIds = saved?.providers
      .filter((provider) => !submittedProviderIds.has(provider.id))
      .map((provider) => provider.id) ?? []
    setSaving(true)
    setStatus(null)
    try {
      const result = await desktop.saveSettings(submitted)
      if (importedSecretsSnapshot !== null || Object.keys(changes).length > 0) {
        try {
          if (importedSecretsSnapshot !== null) {
            const currentProviderIds = new Set(submitted.providers.map((provider) => provider.id))
            const providers = Object.fromEntries(
              Object.entries(normalizedKeyDraftSnapshot).filter(([providerId, keys]) => (
                currentProviderIds.has(providerId) && keys.length > 0
              )),
            )
            await desktop.saveImportedSecrets({
              schemaVersion: 1,
              providers,
              adapters: importedSecretsSnapshot.adapters,
            }, providerDeletionIds)
          } else {
            await desktop.saveProviderKeyChanges(changes)
          }
        } catch (error) {
          let rollbackError: unknown = null
          if (saved !== null) {
            try {
              await desktop.saveSettings(saved)
            } catch (restoreError) {
              rollbackError = restoreError
            }
          }
          const credentialError = credentialErrorMessage(error, changes, t.unknownError)
          const separator = language === 'zh' ? '：' : ': '
          const suffix = rollbackError === null
            ? ''
            : `${language === 'zh' ? '；' : '; '}${t.settingsRollbackFailed}${separator}${credentialErrorMessage(rollbackError, changes, t.unknownError)}`
          setStatus(`${t.saveFailed}${separator}${t.credentialSaveFailed}${separator}${credentialError}${suffix}`)
          return false
        }
      }
      setSaved(result.settings)
      setDraft((current) => {
        if (current === null) return current
        const currentSubmitted = applyProviderKeyCounts(current, normalizedKeyDraftSnapshot)
        return sameSettings(currentSubmitted, submitted)
          ? result.settings
          : mergeSavedProviderKeyCounts(current, result.settings)
      })
      setProviderKeyDrafts((current) => sameProviderKeyDrafts(current, keyDraftSnapshot) ? {} : current)
      setImportedSecrets((current) => (
        JSON.stringify(current) === JSON.stringify(importedSecretsSnapshot) ? null : current
      ))
      showSaveSuccessToast()
      return true
    } catch (error) {
      setStatus(`${t.saveFailed}${language === 'zh' ? '：' : ': '}${String(error)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [desktop, draft, importedSecrets, issues.length, language, providerKeyDrafts, saved, saving, setStatus, showSaveSuccessToast, t])
  const hide = useCallback(() => {
    dismissSaveSuccessToast()
    void desktop.hideWindow()
  }, [desktop, dismissSaveSuccessToast])
  const requestClose = useCallback(() => {
    if (saving) return
    dismissSaveSuccessToast()
    if (dirty) setDialog('close')
    else hide()
  }, [dirty, dismissSaveSuccessToast, hide, saving])
  const restoreDraft = useCallback(() => {
    if (saved === null) return
    setDraft(normalizeAiAvailability(structuredClone(saved)))
    setProviderKeyDrafts({})
    setImportedSecrets(null)
    setStatus(null)
    setPendingImport(null)
    setDialog('none')
  }, [saved, setStatus])
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
      const imported = sanitizeSettings(value.settings)
      setDraft(imported)
      setProviderKeyDrafts(
        value.includesSecrets && value.secrets !== undefined
          ? providerKeyTextDrafts(structuredClone(value.secrets.providers))
          : {},
      )
      setImportedSecrets(value.includesSecrets && value.secrets !== undefined
        ? structuredClone(value.secrets)
        : null)
      setSection('general')
      setStatus(copyFor(imported.language).settingsLoadedPendingSave)
      setPendingImport(null)
      setDialog('none')
    },
    [setStatus],
  )
  if (loadingError !== null) {
    return (
      <main className="load-state" onPointerDown={beginWindowDrag}>
        <img src="/app-mark.png" alt="" />
        <h1>{t.settingsLoadFailed}</h1>
        <p>{loadingError}</p>
        <div>
          <button type="button" className="primary-button" onClick={() => void load()}>
            {t.retry}
          </button>
          <button type="button" className="secondary-button" onClick={hide}>
            {t.close}
          </button>
        </div>
      </main>
    )
  }
  if (draft === null) {
    return <main className="load-state" aria-label={t.settingsLoading} onPointerDown={beginWindowDrag}><div className="spinner" /></main>
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
        onKeyDraftChange={(providerId, value) =>
          setProviderKeyDrafts((current) => ({
            ...current,
            [providerId]: value,
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
        language={draft.language}
        disabled={saving}
        onExport={(includeSecrets) => {
          void desktop.exportSettings(includeSecrets).then((exported) => {
            setStatus(exported ? t.settingsExported : null)
          })
        }}
        onImport={() => {
          void desktop.importSettings().then((value) => {
            if (value === null) return
            if (dirty) {
              dismissSaveSuccessToast()
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
        <nav aria-label={t.settingsSections}>
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
                <span>{t[item.label]}</span>
              </button>
            )
          })}
        </nav>
        <div
          className="settings-permission-state"
          data-administrator={permissionStatus?.administrator ?? false}
          role="status"
          aria-label={t.currentPermission}
        >
          <span />
          {permissionStatus === undefined
            ? t.permissionChecking
            : permissionStatus === null
              ? t.permissionFailed
              : permissionStatus.administrator
                ? t.permissionAdministrator
                : t.permissionStandard}
        </div>
        <div className="settings-save-state" data-dirty={dirty}>
          <span />{dirty ? t.unsavedChanges : t.allChangesSaved}
        </div>
      </aside>
      <section className="settings-main">
        <header className="settings-toolbar" onPointerDown={beginWindowDrag}>
          <h1>{t[activeNavigation.label]}</h1>
          <button
            type="button"
            className="icon-button"
            aria-label={t.closeSettings}
            disabled={saving}
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="settings-scroll">
          {issues.length === 0 ? null : (
            <div className="validation-banner" role="alert">{settingsIssueMessage(issues[0], t)}</div>
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
            {t.cancel}
          </button>
          <button
            type="button"
            className="primary-button settings-footer-button"
            disabled={!dirty || issues.length > 0 || saving}
            onClick={() => void save()}
          >
            {saving ? t.saving : t.save}
          </button>
        </footer>
      </section>
      <div
        className="save-success-toast-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={saveSuccessToast?.message}
      >
        {saveSuccessToast === null ? null : (
          <div
            key={saveSuccessToast.key}
            className={`save-success-toast${saveSuccessToast.phase === 'leaving' ? ' is-leaving' : ''}`}
            data-toast-sequence={saveSuccessToast.key}
            data-toast-phase={saveSuccessToast.phase}
          >
            {saveSuccessToast.message}
          </div>
        )}
      </div>
      {dialog === 'close' ? (
        <ModalDialog
          titleId="close-dialog-title"
          descriptionId="close-dialog-description"
          backdropClassName="unsaved-close-backdrop"
          dialogClassName="unsaved-close-dialog"
          initialFocusRef={continueEditingRef}
          dismissible={!saving}
          onDismiss={() => setDialog('none')}
        >
            <h2 id="close-dialog-title">{t.closeAfterSavingTitle}</h2>
            <p id="close-dialog-description">{t.closeAfterSavingBody}</p>
            <div>
              <button
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={() => void save().then((savedNow) => {
                  if (!savedNow) return
                  setDialog('none')
                  hide()
                })}
              >
                {t.saveAndClose}
              </button>
              <button type="button" className="secondary-button" disabled={saving} onClick={() => { restoreDraft(); hide() }}>
                {t.discardChanges}
              </button>
              <button ref={continueEditingRef} type="button" className="text-button" disabled={saving} onClick={() => setDialog('none')}>
                {t.continueEditing}
              </button>
            </div>
        </ModalDialog>
      ) : null}
      {dialog === 'import' && pendingImport !== null ? (
        <ModalDialog
          titleId="import-dialog-title"
          descriptionId="import-dialog-description"
          initialFocusRef={cancelImportRef}
          dismissible={!saving}
          onDismiss={() => { setPendingImport(null); setDialog('none') }}
        >
            <h2 id="import-dialog-title">{t.importOverwriteTitle}</h2>
            <p id="import-dialog-description">{t.importOverwriteBody}</p>
            <div>
              <button type="button" className="primary-button" disabled={saving} onClick={() => applyImport(pendingImport)}>
                {t.continueImport}
              </button>
              <button ref={cancelImportRef} type="button" className="text-button" disabled={saving} onClick={() => { setPendingImport(null); setDialog('none') }}>
                {t.cancel}
              </button>
            </div>
        </ModalDialog>
      ) : null}
    </main>
  )
}
