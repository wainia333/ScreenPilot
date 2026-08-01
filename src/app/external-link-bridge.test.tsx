import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../desktop/context'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { MarkdownView } from '../shared/markdown/markdown-view'
import { ExternalLinkBridge } from './external-link-bridge'

class RecordingDesktop extends FakeDesktopPort {
  readonly urls: string[] = []
  rejectNext = false

  override openExternal(url: string): Promise<void> {
    this.urls.push(url)
    if (this.rejectNext) {
      this.rejectNext = false
      return Promise.reject(new Error('browser unavailable'))
    }
    return Promise.resolve()
  }
}

function activate(target: Element, type = 'click', button = 0): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button })
  target.dispatchEvent(event)
  return event
}

describe('ExternalLinkBridge', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('intercepts nested and keyboard link activations without navigating the webview', async () => {
    const desktop = new RecordingDesktop()
    const before = window.location.href
    const view = render(
      <DesktopProvider port={desktop}>
        <ExternalLinkBridge />
        <MarkdownView content="[**文档**](https://example.com/docs?topic=ocr#result)" />
      </DesktopProvider>,
    )
    const label = view.getByText('文档')
    const pointer = activate(label)
    await act(async () => Promise.resolve())
    const keyboard = activate(label)
    await act(async () => Promise.resolve())
    expect(pointer.defaultPrevented).toBe(true)
    expect(keyboard.defaultPrevented).toBe(true)
    expect(desktop.urls).toEqual([
      'https://example.com/docs?topic=ocr#result',
      'https://example.com/docs?topic=ocr#result',
    ])
    expect(window.location.href).toBe(before)
  })

  it('opens middle-clicks externally while leaving right-clicks and ordinary content alone', async () => {
    const desktop = new RecordingDesktop()
    const view = render(
      <DesktopProvider port={desktop}>
        <ExternalLinkBridge />
        <a href="https://example.com/vision">Vision</a>
        <button type="button">普通按钮</button>
      </DesktopProvider>,
    )
    const link = view.getByText('Vision')
    const middle = activate(link, 'auxclick', 1)
    const right = activate(link, 'auxclick', 2)
    activate(view.getByRole('button', { name: '普通按钮' }))
    await act(async () => Promise.resolve())
    expect(middle.defaultPrevented).toBe(true)
    expect(right.defaultPrevented).toBe(false)
    expect(desktop.urls).toEqual(['https://example.com/vision'])
  })

  it('handles a failed browser launch and still opens the next link', async () => {
    const desktop = new RecordingDesktop()
    desktop.rejectNext = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(
      <DesktopProvider port={desktop}>
        <ExternalLinkBridge />
        <a href="https://example.com/retry">重试链接</a>
      </DesktopProvider>,
    )
    activate(view.getByText('重试链接'))
    await act(async () => Promise.resolve())
    activate(view.getByText('重试链接'))
    await act(async () => Promise.resolve())
    expect(error).toHaveBeenCalledOnce()
    expect(desktop.urls).toEqual(['https://example.com/retry', 'https://example.com/retry'])
  })
})
