import {
  Aperture,
  Camera,
  BookMarked,
  Bot,
  Info,
  Languages,
  ScanText,
  Settings2,
  Sparkles,
  Move,
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
import { CaptureSection, CaptureSettingsNavigation } from './sections/capture-section'
import { TranslationSection } from './sections/translation-section'
import { IntegrationsSection } from './sections/integrations-section'
import { VisionSection } from './sections/vision-section'
import type { AppSettings, SettingsExport, SettingsIssue, SettingsSecrets } from './types'
import type {
  MainNavigationRequest,
  PermissionStatus,
  ProviderKeyChanges,
  SettingsChangedEvent,
  SettingsPatch,
} from '../../desktop/contract'
import { useWindowDrag } from '../../shared/hooks/use-window-drag'
import { copyFor, type UiCopy } from '../../shared/ui-copy'
import { syncDocumentTheme } from '../../shared/theme'
import { ModalDialog } from '../../shared/ui/modal-dialog'
import { TopNotice } from '../../shared/ui/top-notice'
import { AltSnapSection } from './sections/altsnap-section'
import {
  ADAPTER_CREDENTIALS,
  type AdapterCredentialCounts,
  type AdapterCredentialDrafts,
  type AdapterCredentialId,
} from './adapter-credential-specs'

type Section = 'capture' | 'integrations' | 'general' | 'translation' | 'screenshot' | 'vision' | 'optimizer' | 'altsnap' | 'providers' | 'about'
type DialogState = 'none' | 'close' | 'import'
type SettingsOperation = 'directory' | 'export' | 'import'
type StatusTone = 'status' | 'error'

export type SettingsSaveFailureKind = 'validation' | 'persistence' | 'credential' | 'rollback'

export type SettingsSaveFailure = {
  ok: false
  kind: SettingsSaveFailureKind
  message: string
  issues?: SettingsIssue[]
  /** A field or section that should receive focus when returning to the editor. */
  focusPath?: string
}

export type SettingsSaveOutcome = { ok: true } | SettingsSaveFailure

type SettingsPageProps = {
  navigationRequest?: MainNavigationRequest | null
  onNavigationRequestResolved?: (requestId: number) => void
}

const SAVE_SUCCESS_TOAST_VISIBLE_MS = 3_200
const SAVE_SUCCESS_TOAST_EXIT_MS = 200

type SaveSuccessToast = {
  key: number
  message: string
  phase: 'visible' | 'leaving'
  tone: StatusTone
}

const navigation = [
  { id: 'general', label: 'navGeneral', icon: Settings2 },
  { id: 'translation', label: 'navTranslation', icon: Languages },
  { id: 'screenshot', label: 'navScreenshot', icon: ScanText },
  { id: 'capture', label: 'navCapture', icon: Camera },
  { id: 'vision', label: 'navVision', icon: Aperture },
  { id: 'optimizer', label: 'navOptimizer', icon: Sparkles },
  { id: 'altsnap', label: 'navAltSnap', icon: Move },
  { id: 'integrations', label: 'navIntegrations', icon: BookMarked },
  { id: 'providers', label: 'navProviders', icon: Bot },
  { id: 'about', label: 'navAbout', icon: Info },
] satisfies { id: Section; label: keyof UiCopy; icon: typeof Settings2 }[]

function sameSettings(left: AppSettings | null, right: AppSettings | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function diffValue(base: unknown, next: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(next)) return undefined
  if (isRecord(base) && isRecord(next)) {
    const patch: Record<string, unknown> = {}
    new Set([...Object.keys(base), ...Object.keys(next)]).forEach((key) => {
      if (!(key in next)) { patch[key] = null; return }
      const value = diffValue(base[key], next[key])
      if (value !== undefined) patch[key] = value
    })
    return patch
  }
  return structuredClone(next)
}

function settingsPatch(base: AppSettings, next: AppSettings): SettingsPatch {
  const patch = diffValue(base, next)
  return isRecord(patch) ? patch : {}
}

type SettingsMergeResult = {
  settings: AppSettings
  conflict: boolean
}

function mergeSettingsEvent(base: AppSettings, draft: AppSettings, incoming: AppSettings): SettingsMergeResult {
  const merge = (baseValue: unknown, draftValue: unknown, incomingValue: unknown): { value: unknown; conflict: boolean } => {
    if (isRecord(baseValue) && isRecord(draftValue) && isRecord(incomingValue)) {
      const merged: Record<string, unknown> = {}
      let conflict = false
      const keys = new Set([...Object.keys(baseValue), ...Object.keys(draftValue), ...Object.keys(incomingValue)])
      keys.forEach((key) => {
        const child = merge(baseValue[key], draftValue[key], incomingValue[key])
        merged[key] = child.value
        conflict ||= child.conflict
      })
      return { value: merged, conflict }
    }
    const userChanged = JSON.stringify(baseValue) !== JSON.stringify(draftValue)
    if (!userChanged) return { value: structuredClone(incomingValue), conflict: false }
    if (JSON.stringify(incomingValue) === JSON.stringify(baseValue)
      || JSON.stringify(incomingValue) === JSON.stringify(draftValue)) {
      return { value: structuredClone(draftValue), conflict: false }
    }
    return { value: structuredClone(draftValue), conflict: true }
  }
  const result = merge(base, draft, incoming)
  return { settings: result.value as AppSettings, conflict: result.conflict }
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

function sameAdapterCredentialDrafts(left: AdapterCredentialDrafts, right: AdapterCredentialDrafts): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeAdapterCredentialDrafts(drafts: AdapterCredentialDrafts): ProviderKeyChanges {
  return Object.fromEntries(
    Object.entries(drafts).map(([adapterId, value]) => [
      adapterId,
      value.trim().length === 0 ? [] : value.split(/\r?\n/u).map((key) => key.trim()),
    ]),
  )
}

function adapterCredentialDraftsFromSecrets(changes: ProviderKeyChanges): AdapterCredentialDrafts {
  return Object.fromEntries(
    Object.entries(changes).map(([adapterId, keys]) => [adapterId, keys.join('\n')]),
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return fallback
}

function isSettingsConflictError(error: unknown): boolean {
  return errorMessage(error, '').includes('SETTINGS_CONFLICT')
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
  if (issue.path.startsWith('credentials.')) return issue.message
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

function sectionForIssuePath(path: string): Section {
  if (path.startsWith('capture.')) return 'capture'
  if (path.startsWith('karakeep.')) return 'integrations'
  if (path.startsWith('providers.')) return 'providers'
  if (path.startsWith('credentials.')) return 'screenshot'
  if (path.startsWith('shortcuts.') || path.startsWith('altSnap.')) return 'general'
  if (path.startsWith('general.')) return 'general'
  return 'general'
}

function saveFailureHeading(failure: SettingsSaveFailure, t: UiCopy): string {
  if (failure.kind === 'validation') return t.settingsValidationFailed
  if (failure.kind === 'credential') return t.credentialSaveFailed
  if (failure.kind === 'rollback') return t.settingsRollbackFailed
  return t.saveFailed
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

export function SettingsPage({ navigationRequest = null, onNavigationRequestResolved }: SettingsPageProps) {
  const [captureTab, setCaptureTab] = useState('basic')
  const desktop = useDesktop()
  const beginWindowDrag = useWindowDrag()
  const [section, setSection] = useState<Section>('general')
  const [saved, setSaved] = useState<AppSettings | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [settingsRevision, setSettingsRevision] = useState(0)
  const [conflictSnapshot, setConflictSnapshot] = useState<SettingsChangedEvent | null>(null)
  const savedRef = useRef<AppSettings | null>(null)
  const draftRef = useRef<AppSettings | null>(null)
  const settingsRevisionRef = useRef(0)
  const conflictSnapshotRef = useRef<SettingsChangedEvent | null>(null)
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<ProviderKeyTextDrafts>({})
  const [adapterCredentialDrafts, setAdapterCredentialDrafts] = useState<AdapterCredentialDrafts>({})
  const [adapterCredentialCounts, setAdapterCredentialCounts] = useState<AdapterCredentialCounts>({})
  const [integrationKeyDraft, setIntegrationKeyDraft] = useState<string | null>(null)
  const [importedSecrets, setImportedSecrets] = useState<SettingsSecrets | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [status, setStatusState] = useState<string | null>(null)
  const [statusTone, setStatusTone] = useState<StatusTone>('status')
  const [startupNoticePending, setStartupNoticePending] = useState(false)
  const [saveSuccessToast, setSaveSuccessToast] = useState<SaveSuccessToast | null>(null)
  const saveSuccessToastSequence = useRef(0)
  const saveSuccessToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSuccessToastExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saving, setSaving] = useState(false)
  const [settingsOperation, setSettingsOperation] = useState<SettingsOperation | null>(null)
  const settingsOperationRef = useRef<SettingsOperation | null>(null)
  const [dialog, setDialog] = useState<DialogState>('none')
  const [closeSaveFailure, setCloseSaveFailure] = useState<SettingsSaveFailure | null>(null)
  const [focusIssuePath, setFocusIssuePath] = useState<string | null>(null)
  const [pendingImport, setPendingImport] = useState<SettingsExport | null>(null)
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>()
  const navigationRequestRef = useRef<MainNavigationRequest | null>(null)
  const navigationAckRef = useRef<number | null>(null)
  const continueEditingRef = useRef<HTMLButtonElement>(null)
  const closeSaveErrorRef = useRef<HTMLDivElement>(null)
  const saveButtonRef = useRef<HTMLButtonElement>(null)
  const cancelImportRef = useRef<HTMLButtonElement>(null)
  const language = draft?.language ?? saved?.language ?? 'zh'
  const t = copyFor(language)
  const activeNavigation = navigation.find((item) => item.id === section) ?? {
    id: 'general' as const,
    label: 'navGeneral' as const,
    icon: Settings2,
  }
  const dirty = integrationKeyDraft !== null || !sameSettings(saved, draft)
    || Object.keys(providerKeyDrafts).length > 0
    || Object.keys(adapterCredentialDrafts).length > 0
    || importedSecrets !== null
    || pendingImport !== null
  useEffect(() => {
    savedRef.current = saved
    draftRef.current = draft
    settingsRevisionRef.current = settingsRevision
    conflictSnapshotRef.current = conflictSnapshot
  }, [conflictSnapshot, draft, saved, settingsRevision])
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
  const setStatus = useCallback((message: string | null, tone: StatusTone = 'status') => {
    dismissSaveSuccessToast()
    setStatusTone(tone)
    setStatusState(message)
  }, [dismissSaveSuccessToast])
  const showSaveSuccessToast = useCallback((message = t.settingsSaved, tone: StatusTone = 'status') => {
    clearSaveSuccessToastTimer()
    setStatusState(null)
    setStatusTone('status')
    const key = saveSuccessToastSequence.current + 1
    saveSuccessToastSequence.current = key
    setSaveSuccessToast({
      key,
      message,
      phase: 'visible',
      tone,
    })
    // Errors may have expandable diagnostics; keep them until dismissal or a
    // subsequent action instead of hiding them while the user reads details.
    if (tone === 'error') return
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
  useEffect(() => {
    if (closeSaveFailure === null) return
    queueMicrotask(() => closeSaveErrorRef.current?.focus())
  }, [closeSaveFailure])
  useEffect(() => {
    if (focusIssuePath === null) return
    const expectedSection = sectionForIssuePath(focusIssuePath)
    if (expectedSection !== section) return
    queueMicrotask(() => {
      const target = focusIssuePath === '__settings-save__'
        ? saveButtonRef.current
        : Array.from(document.querySelectorAll<HTMLElement>('[data-settings-issue-path]'))
          .find((element) => element.dataset.settingsIssuePath === focusIssuePath) ?? null
      target?.focus()
      setFocusIssuePath(null)
    })
  }, [focusIssuePath, section])
  const load = useCallback(async () => {
    setLoadingError(null)
    try {
      const adapterCounts = await Promise.all(ADAPTER_CREDENTIALS.map(async ({ id }) => {
        const count = await desktop.providerKeyCount(id).catch(() => 0)
        return [id, count] as const
      }))
      const [snapshot, startupNotice, permissions] = await Promise.all([
        desktop.loadSettingsSnapshot(),
        desktop.takeStartupNotice(),
        desktop.permissionStatus().catch(() => null),
      ])
      const normalized = normalizeAiAvailability(snapshot.settings)
      setSaved(normalized)
      setDraft(normalized)
      setSettingsRevision(snapshot.revision)
      setConflictSnapshot(null)
      setProviderKeyDrafts({})
      setAdapterCredentialDrafts({})
      setAdapterCredentialCounts(Object.fromEntries(adapterCounts))
      setImportedSecrets(null)
    setIntegrationKeyDraft(null)
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
    let active = true
    const unlistenPromise = desktop.onSettingsChanged((event) => {
      if (!active) return
      const incoming = normalizeAiAvailability(event.settings)
      const currentSaved = savedRef.current
      const currentDraft = draftRef.current
      if (currentSaved === null || currentDraft === null) return
      const merged = mergeSettingsEvent(currentSaved, currentDraft, incoming)
      if (merged.conflict) {
        const conflict: SettingsChangedEvent = {
          settings: incoming,
          revision: event.revision,
        }
        setConflictSnapshot(conflict)
        setStatus(copyFor(currentDraft.language).settingsConflict, 'error')
        return
      }
      setSaved(incoming)
      setDraft(merged.settings)
      setSettingsRevision(event.revision)
      setConflictSnapshot(null)
    })
    return () => {
      active = false
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined)
    }
  }, [desktop, setStatus])
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
    if ('__TAURI_INTERNALS__' in window) {
      void getCurrentWindow().setTitle(document.title).catch((reason: unknown) => {
        console.error('[settings] failed to set window title', reason)
      })
    }
  }, [activeNavigation.label, draft])
  const issues = useMemo(() => (draft === null ? [] : validateSettings(draft)), [draft])
  const save = useCallback(async (): Promise<SettingsSaveOutcome> => {
    if (draft === null || saved === null) {
      return { ok: false, kind: 'persistence', message: t.settingsLoadFailed }
    }
    if (issues.length > 0) {
      const separator = language === 'zh' ? '；' : '; '
      const message = `${t.settingsValidationFailed}${language === 'zh' ? '：' : ': '}${issues
        .map((issue) => settingsIssueMessage(issue, t) ?? issue.message)
        .join(separator)}`
      setStatus(message, 'error')
      return { ok: false, kind: 'validation', message, issues }
    }
    if (saving || settingsOperationRef.current !== null) {
      return { ok: false, kind: 'persistence', message: t.saving }
    }
    if (conflictSnapshotRef.current !== null) {
      setStatus(t.settingsConflict, 'error')
      return { ok: false, kind: 'persistence', message: t.settingsConflict }
    }
    const keyDraftSnapshot = structuredClone(providerKeyDrafts)
    const adapterCredentialDraftSnapshot = structuredClone(adapterCredentialDrafts)
    const importedSecretsSnapshot = importedSecrets === null ? (integrationKeyDraft === null ? null : { schemaVersion: 1 as const, providers: {}, adapters: {} }) : structuredClone(importedSecrets)
    const integrationSecrets = integrationKeyDraft === null ? importedSecrets?.integrations : { karakeep: [integrationKeyDraft.trim()] }
    const normalizedKeyDraftSnapshot = normalizeProviderKeyDrafts(keyDraftSnapshot)
    const normalizedAdapterCredentialDraftSnapshot = normalizeAdapterCredentialDrafts(adapterCredentialDraftSnapshot)
    const invalidAdapter = ADAPTER_CREDENTIALS.find((adapter) => {
      if (!Object.prototype.hasOwnProperty.call(normalizedAdapterCredentialDraftSnapshot, adapter.id)) return false
      const keys = normalizedAdapterCredentialDraftSnapshot[adapter.id] ?? []
      return keys.length > 0 && (keys.length !== adapter.fields.length || keys.some((key) => key.length === 0))
    })
    if (invalidAdapter !== undefined) {
      const label = language === 'en' ? invalidAdapter.labelEn : invalidAdapter.label
      const message = `${t.credentialRequired}：${label}`
      const issue: SettingsIssue = {
        path: `credentials.${invalidAdapter.id}`,
        code: 'missing',
        message,
      }
      setStatus(message, 'error')
      return { ok: false, kind: 'validation', message, issues: [issue], focusPath: issue.path }
    }
    const submitted = applyProviderKeyCounts(structuredClone(draft), normalizedKeyDraftSnapshot)
    const patch = settingsPatch(saved, submitted)
    const baseRevision = settingsRevisionRef.current
    const changes = providerKeyChanges(saved, submitted, normalizedKeyDraftSnapshot)
    const credentialChanges = { ...changes, ...normalizedAdapterCredentialDraftSnapshot }
    const submittedProviderIds = new Set(submitted.providers.map((provider) => provider.id))
    const providerDeletionIds = saved.providers
      .filter((provider) => !submittedProviderIds.has(provider.id))
      .map((provider) => provider.id)
    setSaving(true)
    setStatus(null)
    try {
      const result = await desktop.saveSettingsPatch(baseRevision, patch)
      const committedRevision = result.revision ?? baseRevision + (Object.keys(patch).length > 0 ? 1 : 0)
      if (importedSecretsSnapshot !== null || Object.keys(changes).length > 0 || Object.keys(normalizedAdapterCredentialDraftSnapshot).length > 0) {
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
              adapters: normalizedAdapterCredentialDraftSnapshot,
              ...(integrationSecrets ? { integrations: integrationSecrets } : {}),
            }, providerDeletionIds)
          } else {
            if (Object.keys(changes).length > 0) await desktop.saveProviderKeyChanges(changes)
            if (Object.keys(normalizedAdapterCredentialDraftSnapshot).length > 0) {
              await desktop.saveAdapterKeyChanges(normalizedAdapterCredentialDraftSnapshot)
            }
          }
        } catch (error) {
          let rollbackError: unknown = null
          const rollbackPatch = settingsPatch(submitted, saved)
          if (Object.keys(rollbackPatch).length > 0) {
            try {
              await desktop.saveSettingsPatch(committedRevision, rollbackPatch)
            } catch (restoreError) {
              rollbackError = restoreError
            }
          }
          const credentialError = credentialErrorMessage(error, credentialChanges, t.unknownError)
          const separator = language === 'zh' ? '：' : ': '
          const suffix = rollbackError === null
            ? ''
            : `${language === 'zh' ? '；' : '; '}${t.settingsRollbackFailed}${separator}${credentialErrorMessage(rollbackError, credentialChanges, t.unknownError)}`
          const message = `${t.saveFailed}${separator}${t.credentialSaveFailed}${separator}${credentialError}${suffix}`
          setStatus(message, 'error')
          const focusPath = Object.keys(normalizedAdapterCredentialDraftSnapshot)[0] === undefined
            ? (Object.keys(changes)[0] === undefined ? undefined : `providers.${Object.keys(changes)[0]}.keys`)
            : `credentials.${Object.keys(normalizedAdapterCredentialDraftSnapshot)[0]}`
          return {
            ok: false,
            kind: rollbackError === null ? 'credential' : 'rollback',
            message,
            ...(focusPath === undefined ? {} : { focusPath }),
          }
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
      setSettingsRevision(committedRevision)
      setConflictSnapshot(null)
      setProviderKeyDrafts((current) => sameProviderKeyDrafts(current, keyDraftSnapshot) ? {} : current)
      setAdapterCredentialCounts((current) => {
        const next = { ...current }
        Object.entries(normalizedAdapterCredentialDraftSnapshot).forEach(([adapterId, keys]) => {
          next[adapterId as AdapterCredentialId] = keys.length
        })
        return next
      })
      setAdapterCredentialDrafts((current) => (
        sameAdapterCredentialDrafts(current, adapterCredentialDraftSnapshot) ? {} : current
      ))
      setImportedSecrets((current) => (
        JSON.stringify(current) === JSON.stringify(importedSecretsSnapshot) ? null : current
      ))
      setIntegrationKeyDraft(null)
      setImportedSecrets(null)
      showSaveSuccessToast()
      return { ok: true }
    } catch (error) {
      setStatus(
        isSettingsConflictError(error)
          ? t.settingsConflict
          : `${t.saveFailed}${language === 'zh' ? '：' : ': '}${String(error)}`,
        'error',
      )
      const message = isSettingsConflictError(error)
        ? t.settingsConflict
        : `${t.saveFailed}${language === 'zh' ? '：' : ': '}${String(error)}`
      return { ok: false, kind: 'persistence', message }
    } finally {
      setSaving(false)
    }
  }, [adapterCredentialDrafts, desktop, draft, importedSecrets, integrationKeyDraft, issues, language, providerKeyDrafts, saved, saving, setStatus, showSaveSuccessToast, t])
  const acknowledgeNavigation = useCallback(async (accepted: boolean) => {
    const request = navigationRequestRef.current
    if (request === null || navigationAckRef.current === request.requestId) return
    navigationAckRef.current = request.requestId
    try {
      await desktop.acknowledgeMainNavigation(request.requestId, accepted)
      onNavigationRequestResolved?.(request.requestId)
      if (navigationRequestRef.current?.requestId === request.requestId) {
        navigationRequestRef.current = null
      }
      if (!accepted) setDialog('none')
    } catch (error) {
      navigationAckRef.current = null
      setStatus(errorMessage(error, t.unknownError), 'error')
    }
  }, [desktop, onNavigationRequestResolved, setStatus, t.unknownError])
  useEffect(() => {
    navigationRequestRef.current = navigationRequest
    if (navigationRequest === null || navigationAckRef.current === navigationRequest.requestId) return
    if (saving || settingsOperationRef.current !== null || dialog !== 'none') return
    let active = true
    const requestId = navigationRequest.requestId
    queueMicrotask(() => {
      if (!active || navigationRequestRef.current?.requestId !== requestId) return
      // Before the initial settings snapshot exists there cannot be an
      // unsaved draft to protect. Do not make a shortcut-triggered route
      // wait for settings/keyring I/O, otherwise the newly revealed main
      // window can remain on its default Settings route indefinitely.
      if (draft === null && saved === null) {
        void acknowledgeNavigation(true)
        return
      }
      // A partially initialized state is not expected, but it is safer to
      // preserve it than to navigate away without a reliable dirty check.
      if (draft === null || saved === null) return
      if (!dirty) {
        void acknowledgeNavigation(true)
        return
      }
      dismissSaveSuccessToast()
      setCloseSaveFailure(null)
      setDialog('close')
    })
    return () => {
      active = false
    }
  }, [acknowledgeNavigation, dirty, dismissSaveSuccessToast, dialog, draft, navigationRequest, saved, saving, settingsOperation])
  const hide = useCallback(async () => {
    dismissSaveSuccessToast()
    try {
      await desktop.hideWindow()
    } catch (error) {
      const message = errorMessage(error, t.unknownError)
      if (loadingError !== null) setLoadingError(message)
      else setStatus(message, 'error')
    }
  }, [desktop, dismissSaveSuccessToast, loadingError, setStatus, t.unknownError])
  const requestClose = useCallback(() => {
    if (saving || settingsOperationRef.current !== null) return
    dismissSaveSuccessToast()
    if (dirty) {
      setCloseSaveFailure(null)
      setDialog('close')
    }
    else void hide()
  }, [dirty, dismissSaveSuccessToast, hide, saving])
  const dismissDecisionDialog = useCallback(() => {
    const isNavigation = navigationRequestRef.current !== null
    setCloseSaveFailure(null)
    setDialog('none')
    if (isNavigation) void acknowledgeNavigation(false)
  }, [acknowledgeNavigation])
  const saveAndResolveNavigationOrHide = useCallback(async () => {
    const result = await save()
    if (!result.ok) {
      setCloseSaveFailure(result)
      return
    }
    setCloseSaveFailure(null)
    setDialog('none')
    if (navigationRequestRef.current !== null) void acknowledgeNavigation(true)
    else void hide()
  }, [acknowledgeNavigation, hide, save])
  const continueEditing = useCallback(() => {
    setCloseSaveFailure(null)
    setDialog('none')
    if (navigationRequestRef.current !== null) void acknowledgeNavigation(false)
  }, [acknowledgeNavigation])
  const returnToEdit = useCallback(() => {
    const failure = closeSaveFailure
    const isNavigation = navigationRequestRef.current !== null
    setCloseSaveFailure(null)
    setDialog('none')
    if (isNavigation) void acknowledgeNavigation(false)
    const focusPath = failure?.focusPath ?? failure?.issues?.[0]?.path ?? '__settings-save__'
    setSection(sectionForIssuePath(focusPath))
    if (focusPath.startsWith('capture.')) setCaptureTab('basic')
    setFocusIssuePath(focusPath)
  }, [acknowledgeNavigation, closeSaveFailure])
  const restoreDraft = useCallback(() => {
    const latest = conflictSnapshotRef.current
    const baseline = latest === null ? saved : latest.settings
    if (baseline === null) return
    const normalized = normalizeAiAvailability(structuredClone(baseline))
    setSaved(normalized)
    setDraft(normalized)
    if (latest !== null) setSettingsRevision(latest.revision)
    setConflictSnapshot(null)
    setProviderKeyDrafts({})
    setAdapterCredentialDrafts({})
    setImportedSecrets(null)
    setIntegrationKeyDraft(null)
    setStatus(null)
    setPendingImport(null)
    setCloseSaveFailure(null)
    setDialog('none')
  }, [saved, setStatus])
  const cancel = useCallback(() => {
    if (saving || settingsOperationRef.current !== null) return
    restoreDraft()
  }, [restoreDraft, saving])
  const discardAndResolveNavigationOrHide = useCallback(() => {
    const isNavigation = navigationRequestRef.current !== null
    restoreDraft()
    if (isNavigation) void acknowledgeNavigation(true)
    else void hide()
  }, [acknowledgeNavigation, hide, restoreDraft])
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
      setAdapterCredentialDrafts(
        value.includesSecrets && value.secrets !== undefined
          ? adapterCredentialDraftsFromSecrets(structuredClone(value.secrets.adapters))
          : {},
      )
      setImportedSecrets(value.includesSecrets && value.secrets !== undefined
        ? structuredClone(value.secrets)
        : null)
      setIntegrationKeyDraft(null)
      setSection('general')
      setStatus(copyFor(imported.language).settingsLoadedPendingSave)
      setPendingImport(null)
      setDialog('none')
    },
    [setStatus],
  )
  const startSettingsOperation = useCallback((operation: SettingsOperation): boolean => {
    if (saving || settingsOperationRef.current !== null) return false
    settingsOperationRef.current = operation
    setSettingsOperation(operation)
    setStatus(null)
    return true
  }, [saving, setStatus])
  const finishSettingsOperation = useCallback((operation: SettingsOperation) => {
    if (settingsOperationRef.current !== operation) return
    settingsOperationRef.current = null
    setSettingsOperation(null)
  }, [])
  const showOperationFailure = useCallback((label: string, error: unknown) => {
    const separator = language === 'zh' ? '：' : ': '
    setStatus(`${label}${separator}${errorMessage(error, t.unknownError)}`, 'error')
  }, [language, setStatus, t.unknownError])
  const pickDirectory = useCallback(async () => {
    if (!startSettingsOperation('directory')) return
    try {
      const imageArchivePath = await desktop.pickDirectory()
      if (imageArchivePath !== null) {
        setDraft((current) => current === null ? current : ({
          ...current,
          general: { ...current.general, imageArchivePath },
        }))
      }
    } catch (error) {
      showOperationFailure(t.directoryPickFailed, error)
    } finally {
      finishSettingsOperation('directory')
    }
  }, [desktop, finishSettingsOperation, showOperationFailure, startSettingsOperation, t.directoryPickFailed])
  const exportSettings = useCallback(async (includeSecrets: boolean) => {
    if (!startSettingsOperation('export')) return
    try {
      const exported = await desktop.exportSettings(includeSecrets)
      if (exported) setStatus(t.settingsExported)
    } catch (error) {
      showOperationFailure(t.settingsExportFailed, error)
    } finally {
      finishSettingsOperation('export')
    }
  }, [desktop, finishSettingsOperation, setStatus, showOperationFailure, startSettingsOperation, t.settingsExportFailed, t.settingsExported])
  const importSettings = useCallback(async () => {
    if (!startSettingsOperation('import')) return
    try {
      const value = await desktop.importSettings()
      if (value === null) return
      if (dirty) {
        dismissSaveSuccessToast()
        setPendingImport(value)
        setDialog('import')
      } else {
        applyImport(value)
      }
    } catch (error) {
      showOperationFailure(t.settingsImportFailed, error)
    } finally {
      finishSettingsOperation('import')
    }
  }, [applyImport, desktop, dirty, dismissSaveSuccessToast, finishSettingsOperation, showOperationFailure, startSettingsOperation, t.settingsImportFailed])
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
          <button type="button" className="secondary-button" onClick={() => void hide()}>
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
    integrations: <IntegrationsSection config={draft.karakeep} onChange={karakeep => setDraft({ ...draft, karakeep })} keyDraft={integrationKeyDraft} onKeyChange={setIntegrationKeyDraft} saving={saving} language={language} onTestResult={(message, failed) => showSaveSuccessToast(message, failed ? 'error' : 'status')} />,
    general: (
      <GeneralSection
        settings={draft}
        onChange={setDraft}
        onPickDirectory={() => void pickDirectory()}
        pickDirectoryDisabled={saving || settingsOperation !== null}
        pickingDirectory={settingsOperation === 'directory'}
      />
    ),
    translation: (
      <TranslationSection
        settings={draft}
        onChange={(next) => setDraft(normalizeAiAvailability(next))}
        onOpenCredentials={() => setSection('screenshot')}
      />
    ),
    capture: <CaptureSection settings={draft} onChange={setDraft} tab={captureTab} saving={saving} />,
    screenshot: (
      <ScreenshotSection
        settings={draft}
        onChange={(next) => setDraft(normalizeAiAvailability(next))}
        adapterCredentialDrafts={adapterCredentialDrafts}
        adapterCredentialCounts={adapterCredentialCounts}
        onAdapterCredentialDraftChange={(adapterId, value) =>
          setAdapterCredentialDrafts((current) => ({ ...current, [adapterId]: value }))
        }
        onAdapterCredentialClear={(adapterId) =>
          setAdapterCredentialDrafts((current) => {
            if ((adapterCredentialCounts[adapterId] ?? 0) > 0) return { ...current, [adapterId]: '' }
            if (!Object.prototype.hasOwnProperty.call(current, adapterId)) return current
            return Object.fromEntries(Object.entries(current).filter(([id]) => id !== adapterId))
          })
        }
        saving={saving}
      />
    ),
    vision: <VisionSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    optimizer: <OptimizerSection settings={draft} onChange={(next) => setDraft(normalizeAiAvailability(next))} />,
    altsnap: <AltSnapSection settings={draft} onChange={setDraft} />,
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
        onTestResult={(message, failed) => showSaveSuccessToast(message, failed ? 'error' : 'status')}
      />
    ),
    about: (
      <AboutSection
        language={draft.language}
        disabled={saving || settingsOperation !== null}
        operation={settingsOperation === 'export' || settingsOperation === 'import' ? settingsOperation : null}
        onExport={(includeSecrets) => void exportSettings(includeSecrets)}
        onImport={() => void importSettings()}
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
            disabled={saving || settingsOperation !== null}
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>
        {section === 'capture' && <CaptureSettingsNavigation value={captureTab} onChange={setCaptureTab} language={draft.language} />}
        <div className="settings-scroll">
          {content[section]}
        </div>
        <footer className="settings-footer">
          <button
            type="button"
            className="secondary-button settings-footer-button"
            disabled={!dirty || saving || settingsOperation !== null}
            onClick={cancel}
          >
            {t.cancel}
          </button>
          <button
            ref={saveButtonRef}
            type="button"
            className="primary-button settings-footer-button"
            disabled={!dirty || issues.length > 0 || saving || settingsOperation !== null}
            onClick={() => void save()}
          >
            {saving ? t.saving : t.save}
          </button>
        </footer>
      </section>
      <TopNotice message={saveSuccessToast?.message ?? status ?? (issues[0] ? settingsIssueMessage(issues[0], t) : null)}
        language={language}
        tone={saveSuccessToast?.tone ?? (status ? statusTone : issues.length ? 'error' : 'status')}
        sequence={saveSuccessToast?.key} phase={saveSuccessToast?.phase}
        onDismiss={status ? () => setStatus(null) : saveSuccessToast?.tone === 'error' ? dismissSaveSuccessToast : undefined} />
      {dialog === 'close' ? (
        <ModalDialog
          titleId="close-dialog-title"
          descriptionId={closeSaveFailure === null
            ? 'close-dialog-description'
            : 'close-dialog-description close-dialog-error'}
          backdropClassName="unsaved-close-backdrop"
          dialogClassName="unsaved-close-dialog"
          initialFocusRef={continueEditingRef}
          dismissible={!saving}
          onDismiss={dismissDecisionDialog}
        >
            <h2 id="close-dialog-title">{navigationRequest === null ? t.closeAfterSavingTitle : t.navigateAfterSavingTitle}</h2>
            <p id="close-dialog-description">{navigationRequest === null ? t.closeAfterSavingBody : t.navigateAfterSavingBody}</p>
            {closeSaveFailure === null ? null : (
              <div
                ref={closeSaveErrorRef}
                id="close-dialog-error"
                className="close-dialog-error"
                role="alert"
                aria-live="assertive"
                tabIndex={-1}
              >
                <strong>{saveFailureHeading(closeSaveFailure, t)}</strong>
                {closeSaveFailure.issues === undefined ? (
                  <p>{closeSaveFailure.message}</p>
                ) : (
                  <>
                    <p>{t.settingsValidationFailed}</p>
                    <ul>
                      {closeSaveFailure.issues.map((issue) => (
                        <li key={`${issue.path}-${issue.code}`}>
                          {settingsIssueMessage(issue, t) ?? issue.message}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button type="button" className="text-button" onClick={returnToEdit}>
                  {t.returnToEdit}
                </button>
              </div>
            )}
            <div>
              <button
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={() => void saveAndResolveNavigationOrHide()}
              >
                {navigationRequest === null ? t.saveAndClose : t.saveAndNavigate}
              </button>
              <button type="button" className="secondary-button" disabled={saving} onClick={discardAndResolveNavigationOrHide}>
                {t.discardChanges}
              </button>
              <button ref={continueEditingRef} type="button" className="text-button" disabled={saving} onClick={continueEditing}>
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
