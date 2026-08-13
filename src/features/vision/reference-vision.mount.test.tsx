import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(
    event: string,
    listener: (event: { payload: unknown }) => void,
  ) => Promise<() => void>>(),
  setTitle: vi.fn<(title: string) => Promise<void>>(),
  unlisten: vi.fn<() => void>(),
}))

const vendorApi = vi.hoisted(() => {
  const originalStartDragging = vi.fn<() => Promise<void>>(() => Promise.resolve())
  return {
    api: { startDragging: originalStartDragging },
    originalStartDragging,
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriMocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauriMocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: tauriMocks.setTitle }),
}))

vi.mock('../../vendor/kivio-screenshot/api/tauri', () => ({ api: vendorApi.api }))
vi.mock('../../vendor/kivio-screenshot/Vision', async () => {
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
                <div data-screenpilot-target-result-slot="true"></div>
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
  })

  it('loads settings, adapts the explicit Vision DOM, resets overrides, and disposes effects', async () => {
    const view = render(<ReferenceVisionAdapter />)

    await waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith('vision_runtime_settings_load')
      expect(tauriMocks.listen).toHaveBeenCalledWith(
        'vision-translate-stream',
        expect.any(Function),
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
        payload: { imageId: 'capture-1', kind: 'original', delta: 'Captured source' },
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
      patch: { sourceLanguage: 'ja', targetLanguage: 'en' },
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
})
