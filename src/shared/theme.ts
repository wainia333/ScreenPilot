export type DocumentTheme = 'system' | 'light' | 'dark'

type ThemeBinding = {
  mode: DocumentTheme
  media: MediaQueryList | null
  dispose: () => void
}

const bindings = new WeakMap<Document, ThemeBinding>()

function resolvedDark(binding: ThemeBinding): boolean {
  return binding.mode === 'dark' || (binding.mode === 'system' && binding.media?.matches === true)
}

function applyResolvedTheme(documentTarget: Document, binding: ThemeBinding) {
  const dark = resolvedDark(binding)
  const root = documentTarget.documentElement
  root.dataset.theme = binding.mode
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
}

function createBinding(documentTarget: Document): ThemeBinding {
  const view = documentTarget.defaultView
  const media = typeof view?.matchMedia === 'function'
    ? view.matchMedia('(prefers-color-scheme: dark)')
    : null
  const binding: ThemeBinding = { mode: 'system', media, dispose: () => undefined }
  const onPreferenceChange = () => {
    if (binding.mode === 'system') applyResolvedTheme(documentTarget, binding)
  }
  if (media !== null) {
    media.addEventListener('change', onPreferenceChange)
    binding.dispose = () => media.removeEventListener('change', onPreferenceChange)
  }
  return binding
}

/**
 * Applies the persisted theme contract to every styling surface used by the app:
 * repository CSS (`data-theme`), the vendor Tailwind bundle (`.dark`) and native
 * form controls (`color-scheme`). A single media listener per Document keeps the
 * resolved system theme current without leaving stale page-level listeners behind.
 */
export function syncDocumentTheme(
  mode: DocumentTheme,
  documentTarget: Document = document,
): 'light' | 'dark' {
  const binding = bindings.get(documentTarget) ?? createBinding(documentTarget)
  bindings.set(documentTarget, binding)
  binding.mode = mode
  applyResolvedTheme(documentTarget, binding)
  return resolvedDark(binding) ? 'dark' : 'light'
}

export function disposeDocumentThemeSync(documentTarget: Document = document) {
  const binding = bindings.get(documentTarget)
  binding?.dispose()
  bindings.delete(documentTarget)
}
