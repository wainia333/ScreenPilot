import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  label: 'vision',
  listen: vi.fn().mockResolvedValue(() => undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: mocks.label }),
  LogicalSize: vi.fn(),
}))

import { defaultTauriApi } from './tauri-api'
import { api } from '../vendor/kivio-screenshot/api/tauri'

describe('native event window isolation', () => {
  beforeEach(() => mocks.listen.mockClear())

  it.each(['vision', 'ocr'])('scopes route and reset listeners to %s', async (label) => {
    mocks.label = label
    const handler = vi.fn()
    for (const event of ['screenpilot:route', 'screenpilot:reset']) {
      await defaultTauriApi.listen(event, handler)
      expect(mocks.listen).toHaveBeenCalledWith(event, handler, { target: label })
    }
  })

  it.each(['vision', 'ocr'])('scopes streams and close notifications to %s', async (label) => {
    mocks.label = label
    await api.onVisionClosing(vi.fn())
    await api.onVisionStream(vi.fn())
    await api.onVisionTranslateStream(vi.fn())
    for (const event of ['screenpilot:vision-closing', 'vision-stream', 'vision-translate-stream']) {
      expect(mocks.listen).toHaveBeenCalledWith(event, expect.any(Function), { target: label })
    }
  })
})
