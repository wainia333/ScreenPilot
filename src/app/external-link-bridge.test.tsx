import { act, cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider } from '../desktop/context'
import { FakeDesktopPort } from '../desktop/fake-desktop'
import { MarkdownView } from '../shared/markdown/markdown-view'
import { ExternalLinkBridge } from './external-link-bridge'

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

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
    if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    if (originalExecCommandDescriptor === undefined) Reflect.deleteProperty(document, 'execCommand')
    else Object.defineProperty(document, 'execCommand', originalExecCommandDescriptor)
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

  it('announces a code-block clipboard failure without leaking a rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    const view = render(<MarkdownView content={'```ts\nconst value = 1\n```'} />)
    view.getByRole('button', { name: '复制代码' }).click()
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('复制失败'))
  })

  it('keeps code-block copy feedback active through StrictMode effect replay', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    const view = render(
      <StrictMode>
        <MarkdownView content={'```ts\nconst value = 1\n```'} />
      </StrictMode>,
    )
    view.getByRole('button', { name: '复制代码' }).click()
    await waitFor(() => expect(view.getByRole('button', { name: '复制代码' }).querySelector('.lucide-check')).not.toBeNull())
  })
})
