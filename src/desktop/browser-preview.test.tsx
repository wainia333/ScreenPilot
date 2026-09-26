import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserPreviewBadge } from '../app/browser-preview-badge'
import { BrowserPreviewDesktopPort, FakeDesktopPort } from './fake-desktop'

describe('browser preview desktop port', () => {
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  })

  it('keeps the injectable FakeDesktopPort success behavior for tests', async () => {
    const fake = new FakeDesktopPort()

    await expect(fake.exportSettings(false)).resolves.toBe(true)
    await expect(fake.commitText('demo', false)).resolves.toBeUndefined()
    await expect(fake.hideWindow()).resolves.toBeUndefined()
    await expect(fake.openExternal('https://example.com')).resolves.toBeUndefined()
  })

  it('rejects native side effects in the browser preview with an explicit error', async () => {
    const preview = new BrowserPreviewDesktopPort()
    const operations = [
      preview.exportSettings(false),
      preview.importSettings(),
      preview.pickDirectory(),
      preview.saveProviderKeyChanges({ provider: ['key'] }),
      preview.saveAdapterKeyChanges({ adapter: ['key'] }),
      preview.saveImportedSecrets({ schemaVersion: 1, providers: {}, adapters: {} }, []),
      preview.setProviderKeys('provider', ['key']),
      preview.providerKeyCount('provider'),
      preview.deleteProviderKeys('provider'),
      preview.commitText('demo', false),
      preview.takeTranslatorSelection(),
      preview.hideWindow(),
      preview.resizeWindow(640, 480),
      preview.startDragging(),
      preview.openExternal('https://example.com'),
      preview.permissionStatus(),
    ]

    await expect(Promise.all(operations)).rejects.toThrow('浏览器预览不支持')
    await expect(preview.openExternal('https://example.com')).rejects.toThrow('浏览器预览不支持')
  })
})

describe('browser preview badge', () => {
  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  })

  it('identifies the browser preview without taking pointer input', () => {
    render(<BrowserPreviewBadge />)
    const badge = screen.getByRole('status', { name: /浏览器预览 Demo/u })
    expect(badge).toBeVisible()
    expect(badge).toHaveAttribute('data-screenpilot-browser-preview', 'true')
  })

  it('does not render in a Tauri runtime', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    render(<BrowserPreviewBadge />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
