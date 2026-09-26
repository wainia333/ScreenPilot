import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(
    event: string,
    listener: (event: { payload: unknown }) => void,
    options?: { target: string },
  ) => Promise<() => void>>(),
  setTitle: vi.fn<(title: string) => Promise<void>>(),
  unlisten: vi.fn<() => void>(),
}))

const vendorApi = vi.hoisted(() => {
  const originalStartDragging = vi.fn<() => Promise<void>>(() => Promise.resolve())
  const synthesizeSpeech = vi.fn<() => Promise<{ success: boolean; data?: string }>>(() => Promise.resolve({
    success: true,
    data: 'data:audio/wav;base64,AA==',
  }))
  return {
    api: { startDragging: originalStartDragging, synthesizeSpeech },
    originalStartDragging,
    synthesizeSpeech,
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'vision', setTitle: tauriMocks.setTitle }),
}))

vi.mock('../../vendor/screenshot/api/tauri', () => ({ api: vendorApi.api }))
vi.mock('../../vendor/screenshot/Vision', async () => {
  const { createElement } = await import('react')
  return {
    default: function VisionContractSurface() {
      return createElement('div', {
        'data-screenpilot-vision-root': 'true',
        dangerouslySetInnerHTML: {
          __html: `
            <button type="button" data-screenpilot-vision-send="true"></button>
            <section data-screenpilot-prompt-panel="true" data-screenpilot-answer-visible="false">
              <div data-screenpilot-prompt-bar="true" data-screenpilot-vision-image="false">
                <input data-screenpilot-vision-prompt="true" />
              </div>
              <div data-screenpilot-vision-prompt-preview="true"></div>
              <div data-screenpilot-answer-panel="true"></div>
            </section>
            <article data-screenpilot-translation-card="true">
              <header data-screenpilot-translation-header="true"></header>
              <div data-screenpilot-translation-body="true">
                <select data-screenpilot-translation-method="true">
                  <option value="microsoft">Microsoft</option>
                  <option value="ai">AI</option>
                </select>
                <div data-screenpilot-ocr-container="true">
                  <h2 data-screenpilot-original-heading="true">
                    <span data-screenpilot-source-language-slot="true"></span>
                  </h2>
                </div>
                <h2 data-screenpilot-translated-heading="true">
                  <span data-screenpilot-target-language-slot="true"></span>
                </h2>
                <div data-screenpilot-target-result-slot="true">
                  <div data-screenpilot-native-translation-result="true" data-screenpilot-translation-text="Previously translated">Previously translated</div>
                </div>
              </div>
            </article>
          `,
        },
      })
    },
  }
})

const runtimeSettings = {
  settingsLanguage: 'en',
  theme: 'dark',
  screenshotTranslation: {
    sourceLanguage: 'ja',
    targetLanguage: 'ko',
    ocrAiEnabled: true,
    translationAiEnabled: true,
    providerId: 'ocr-provider',
    model: 'ocr-model',
    translateProviderId: 'translation-provider',
    translateModel: 'translation-model',
  },
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

function commandCalls(command: string): number {
  return tauriMocks.invoke.mock.calls.filter(([calledCommand]) => calledCommand === command).length
}

describe('ReferenceVisionAdapter mount contract', () => {
  let ReferenceVisionAdapter: ComponentType
  let translateStreamListener: ((event: { payload: unknown }) => void) | undefined

  beforeAll(async () => {
    const adapterModule: unknown = await import('./reference-' + 'vision')
    if (
      typeof adapterModule !== 'object'
      || adapterModule === null
      || !('default' in adapterModule)
      || typeof adapterModule.default !== 'function'
    ) throw new Error('ReferenceVisionAdapter module is invalid')
    ReferenceVisionAdapter = adapterModule.default as ComponentType
  })

  afterAll(() => {
    vi.resetModules()
  })

  beforeEach(() => {
    translateStreamListener = undefined
    tauriMocks.invoke.mockReset()
    tauriMocks.listen.mockReset()
    tauriMocks.setTitle.mockReset()
    tauriMocks.unlisten.mockReset()
    vendorApi.originalStartDragging.mockClear()
    vendorApi.synthesizeSpeech.mockClear()
    vendorApi.api.startDragging = vendorApi.originalStartDragging

    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    tauriMocks.setTitle.mockResolvedValue()
    tauriMocks.listen.mockImplementation((event, listener) => {
      if (event === 'vision-translate-stream') {
        translateStreamListener = listener
      }
      return Promise.resolve(tauriMocks.unlisten)
    })
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') {
        return Promise.resolve({ success: true, translated: 'Translated override' })
      }
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    document.documentElement.removeAttribute('data-screenpilot-floating-translate-window')
    document.documentElement.removeAttribute('data-screenpilot-floating-translate-pending')
    document.documentElement.classList.remove('dark')
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.removeProperty('color-scheme')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
  })

  it('loads settings, adapts the explicit Vision DOM, resets overrides, and disposes effects', async () => {
    const view = render(<ReferenceVisionAdapter />)

    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith('vision_runtime_settings_load')
      expect(tauriMocks.listen).toHaveBeenCalledWith(
        'vision-translate-stream',
        expect.any(Function),
        { target: 'vision' },
      )
    })

    const sourceLanguage = await screen.findByRole('combobox', { name: 'Source language' })
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })
    expect(sourceLanguage).toHaveValue('ja')
    expect(targetLanguage).toHaveValue('ko')
    expect(sourceLanguage.closest('[data-screenpilot-source-language-slot="true"]')).not.toBeNull()
    expect(targetLanguage.closest('[data-screenpilot-target-language-slot="true"]')).not.toBeNull()

    expect(document.documentElement).toHaveAttribute('lang', 'en')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(document.title).toBe('ScreenPilot — Vision')
    expect(tauriMocks.setTitle).toHaveBeenCalledWith('ScreenPilot — Vision')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
      expect(document.querySelector('[data-screenpilot-prompt-bar="true"]'))
        .toHaveAttribute('data-screenpilot-window-frame', 'true')
      expect(document.querySelector('[data-screenpilot-translation-card="true"]'))
        .toHaveAttribute('data-screenpilot-window-frame', 'true')
      expect(document.querySelector('[data-screenpilot-translation-card="true"]'))
        .toHaveAttribute('data-screenpilot-ocr-card', 'true')
    })

    expect(vendorApi.api.startDragging).not.toBe(vendorApi.originalStartDragging)
    await act(async () => vendorApi.api.startDragging())
    expect(tauriMocks.invoke).toHaveBeenCalledWith('vision_start_safe_drag', {})

    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 2, kind: 'original', delta: 'Captured source' },
      })
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Stale source' },
      })
    })
    fireEvent.change(targetLanguage, { target: { value: 'en' } })

    expect(await screen.findByText('Translated override')).toBeInTheDocument()
    expect(tauriMocks.invoke).toHaveBeenCalledWith('vision_translate_text', {
      text: 'Captured source',
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    })
    expect(tauriMocks.invoke).toHaveBeenCalledWith('screenshot_translation_settings_update', {
      patch: { targetLanguage: 'en' },
    })
    expect(document.querySelector('[data-screenpilot-translation-body="true"]'))
      .toHaveAttribute('data-screenpilot-translation-override', 'true')

    const settingsLoadsBeforeSessionReset = commandCalls('vision_runtime_settings_load')
    await act(async () => {
      window.dispatchEvent(new Event('screenpilot:vision-session-reset'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.queryByText('Translated override')).not.toBeInTheDocument()
      expect(document.querySelector('[data-screenpilot-translation-body="true"]'))
        .not.toHaveAttribute('data-screenpilot-translation-override')
    })
    expect(commandCalls('vision_runtime_settings_load')).toBe(settingsLoadsBeforeSessionReset)

    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-2', kind: 'original', delta: 'Second captured source' },
      })
    })
    fireEvent.change(targetLanguage, { target: { value: 'ko' } })
    expect(await screen.findByText('Translated override')).toBeInTheDocument()

    await act(async () => {
      window.dispatchEvent(new Event('vision:reset'))
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.queryByText('Translated override')).not.toBeInTheDocument()
      expect(document.querySelector('[data-screenpilot-translation-body="true"]'))
        .not.toHaveAttribute('data-screenpilot-translation-override')
      expect(commandCalls('vision_runtime_settings_load')).toBe(2)
    })

    const settingsLoadsBeforeUnmount = commandCalls('vision_runtime_settings_load')
    view.unmount()

    expect(tauriMocks.unlisten).toHaveBeenCalledOnce()
    expect(vendorApi.api.startDragging).toBe(vendorApi.originalStartDragging)
    expect(document.querySelector('[data-screenpilot-target-language="true"]')).toBeNull()
    expect(document.querySelector('[data-screenpilot-source-language="true"]')).toBeNull()
    expect(document.querySelector('[data-screenpilot-target-result="true"]')).toBeNull()
    expect(document.documentElement)
      .not.toHaveAttribute('data-screenpilot-floating-translate-window')
    expect(document.documentElement)
      .not.toHaveAttribute('data-screenpilot-floating-translate-pending')

    await act(async () => {
      window.dispatchEvent(new Event('vision:reset'))
      await Promise.resolve()
    })
    expect(commandCalls('vision_runtime_settings_load')).toBe(settingsLoadsBeforeUnmount)
  })

  it('keeps override Markdown, copy, speech, and keyboard actions bound to the displayed result', async () => {
    const markdown = '- translated item\n\n$$x^2 + y^2$$\n\n```ts\nconst answer = 42\n```'
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    class FakeAudio {
      ended = false
      onended: (() => void) | null = null
      onpause: (() => void) | null = null
      onerror: (() => void) | null = null
      play(): Promise<void> {
        queueMicrotask(() => {
          this.ended = true
          this.onended?.()
        })
        return Promise.resolve()
      }
      pause(): void {
        this.onpause?.()
      }
    }
    vi.stubGlobal('Audio', FakeAudio)
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') return Promise.resolve({ success: true, translated: markdown })
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })
    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Captured source' },
      })
    })

    fireEvent.change(targetLanguage, { target: { value: 'en' } })
    expect(await screen.findByText('translated item')).toBeInTheDocument()
    expect(document.querySelector('.katex')).not.toBeNull()
    expect(document.querySelector('pre code')).toHaveTextContent('const answer = 42')

    const heading = document.querySelector('[data-screenpilot-translated-heading="true"]')
    if (!(heading instanceof HTMLElement)) throw new Error('Translated heading is missing')
    const copy = within(heading).getByRole('button', { name: 'Copy' })
    const speak = within(heading).getByRole('button', { name: 'Speak' })
    expect(copy).toHaveAttribute('data-screenpilot-copy-target', 'translated-override')
    expect(copy).not.toHaveAttribute('tabindex', '-1')
    copy.focus()
    expect(document.activeElement).toBe(copy)

    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
    fireEvent.click(speak)
    await waitFor(() => expect(vendorApi.synthesizeSpeech).toHaveBeenCalledWith(markdown))
  })

  it('marks the previous result when a source or target translation retry fails', async () => {
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') return Promise.resolve({ success: false, error: 'synthetic translation failure' })
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const sourceLanguage = await screen.findByRole('combobox', { name: 'Source language' })
    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Captured source' },
      })
    })

    fireEvent.change(sourceLanguage, { target: { value: 'en' } })
    expect(await screen.findByText('synthetic translation failure')).toBeInTheDocument()
    expect(screen.getByText('Previous translation (current translation failed)')).toBeInTheDocument()
    const overrideResult = document.querySelector('[data-screenpilot-translation-override-result="true"]')
    if (!(overrideResult instanceof HTMLElement)) throw new Error('Override result is missing')
    expect(within(overrideResult).getByText('Previously translated')).toBeInTheDocument()
    const heading = document.querySelector('[data-screenpilot-translated-heading="true"]')
    if (!(heading instanceof HTMLElement)) throw new Error('Translated heading is missing')
    expect(within(heading).getByRole('button', { name: 'Copy' })).toBeEnabled()
    expect(overrideResult).toHaveAttribute('data-screenpilot-translation-stale', 'true')
  })

  it('rolls a language choice back when persistence fails even if translation succeeds', async () => {
    const settingsPatches: unknown[] = []
    tauriMocks.invoke.mockImplementation((command, args) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') return Promise.resolve({ success: true, translated: 'Translated override' })
      if (command === 'screenshot_translation_settings_update') {
        settingsPatches.push((args as { patch?: unknown } | undefined)?.patch)
        return Promise.reject(new Error('synthetic language save failure'))
      }
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })
    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Captured source' },
      })
    })

    fireEvent.change(targetLanguage, { target: { value: 'en' } })
    expect(targetLanguage).toHaveValue('en')
    await waitFor(() => expect(targetLanguage).toHaveValue('ko'))
    expect(settingsPatches).toEqual([{ targetLanguage: 'en' }])
    expect(await screen.findByText('Translated override')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Language settings could not be saved')
  })

  it('keeps a successful language save while reporting a translation failure separately', async () => {
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') {
        return Promise.resolve({ success: false, error: 'synthetic translation failure' })
      }
      if (command === 'screenshot_translation_settings_update') return Promise.resolve(undefined)
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })
    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Captured source' },
      })
    })
    fireEvent.change(targetLanguage, { target: { value: 'en' } })

    await waitFor(() => expect(targetLanguage).toHaveValue('en'))
    expect(await screen.findByText('synthetic translation failure')).toBeInTheDocument()
    expect(screen.queryByText('Language settings could not be saved')).not.toBeInTheDocument()
  })

  it('serializes cross-field language saves as deduplicated single-field patches', async () => {
    const settingsPatches: unknown[] = []
    const saveResolvers: (() => void)[] = []
    tauriMocks.invoke.mockImplementation((command, args) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') return Promise.resolve({ success: true, translated: 'Translated override' })
      if (command === 'screenshot_translation_settings_update') {
        settingsPatches.push((args as { patch?: unknown } | undefined)?.patch)
        return new Promise<void>((resolve) => {
          saveResolvers.push(resolve)
        })
      }
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const sourceLanguage = await screen.findByRole('combobox', { name: 'Source language' })
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })

    fireEvent.change(sourceLanguage, { target: { value: 'en' } })
    await waitFor(() => expect(settingsPatches).toHaveLength(1))
    fireEvent.change(targetLanguage, { target: { value: 'en' } })
    await Promise.resolve()
    expect(settingsPatches).toEqual([{ sourceLanguage: 'en' }])

    saveResolvers.shift()?.()
    await waitFor(() => expect(settingsPatches).toHaveLength(2))
    expect(settingsPatches).toEqual([{ sourceLanguage: 'en' }, { targetLanguage: 'en' }])
    saveResolvers.shift()?.()
    await waitFor(() => {
      expect(sourceLanguage).toHaveValue('en')
      expect(targetLanguage).toHaveValue('en')
    })
  })

  it('ignores a late translation response from an older language selection', async () => {
    const translationResolvers: ((result: unknown) => void)[] = []
    tauriMocks.invoke.mockImplementation((command) => {
      if (command === 'vision_runtime_settings_load') return Promise.resolve(runtimeSettings)
      if (command === 'vision_translate_text') {
        return new Promise((resolve) => translationResolvers.push(resolve))
      }
      if (command === 'screenshot_translation_settings_update') return Promise.resolve(undefined)
      if (command === 'vision_set_floating') return Promise.resolve(false)
      return Promise.resolve(undefined)
    })
    render(<ReferenceVisionAdapter />)
    const targetLanguage = await screen.findByRole('combobox', { name: 'Target language' })
    if (translateStreamListener === undefined) throw new Error('Vision stream listener was not installed')
    act(() => {
      translateStreamListener?.({
        payload: { imageId: 'capture-1', generation: 1, kind: 'original', delta: 'Captured source' },
      })
    })
    fireEvent.change(targetLanguage, { target: { value: 'en' } })
    await waitFor(() => expect(translationResolvers).toHaveLength(1))
    const headingWhileLoading = document.querySelector('[data-screenpilot-translated-heading="true"]')
    if (!(headingWhileLoading instanceof HTMLElement)) throw new Error('Translated heading is missing')
    expect(within(headingWhileLoading).getByRole('button', { name: 'Copy' })).toBeDisabled()
    fireEvent.change(targetLanguage, { target: { value: 'zh-CN' } })
    await waitFor(() => expect(translationResolvers).toHaveLength(2))

    translationResolvers[0]?.({ success: true, translated: 'old response' })
    translationResolvers[1]?.({ success: true, translated: 'latest response' })
    expect(await screen.findByText('latest response')).toBeInTheDocument()
    expect(screen.queryByText('old response')).not.toBeInTheDocument()
    expect(targetLanguage).toHaveValue('zh-CN')
  })
})
