import { describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({
  LogicalSize: vi.fn(function (width: number, height: number) { return { width, height } }),
  getCurrentWindow: vi.fn(),
}))

import { api } from '../../vendor/screenshot/api/tauri'

describe('Vision request API contract', () => {
  it('sends structured historical IDs for text-only followups', async () => {
    invokeMock.mockResolvedValue({ success: true, requestId: 'vision-8', sources: [] })
    const knowledge = { mode: 'only' as const, includeWeb: false, references: [{ instanceId: 'https://saved.example/', bookmarkId: 'compose' }] }
    await api.visionAsk('', [{ role: 'user', content: '根据第一篇，整理步骤' }], 'vision-8', knowledge)
    expect(invokeMock).toHaveBeenCalledWith('vision_ask', { imageId: '', messages: [{ role: 'user', content: '根据第一篇，整理步骤' }], requestId: 'vision-8', knowledge })
  })
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
