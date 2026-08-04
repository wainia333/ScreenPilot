import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({
  LogicalSize: vi.fn(function (width: number, height: number) { return { width, height } }),
  getCurrentWindow: vi.fn(),
}))

import { api } from '../../vendor/kivio-screenshot/api/tauri'

describe('Vision request API contract', () => {
  it('serializes requestId with vision_ask arguments', async () => {
    invokeMock.mockResolvedValue({ success: true, requestId: 'vision-7' })
    const messages = [{ role: 'user' as const, content: 'Describe this' }]

    await api.visionAsk('image-1', messages, 'vision-7')

    expect(invokeMock).toHaveBeenCalledWith('vision_ask', {
      imageId: 'image-1',
      messages,
      requestId: 'vision-7',
    })
  })
})
