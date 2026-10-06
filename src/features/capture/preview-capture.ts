import type { CapturePort } from './types'
export class PreviewCapturePort implements CapturePort {
  open(): Promise<void> {
    return Promise.reject(new Error('请在 ScreenPilot 桌面程序中使用截图 / Capture requires the desktop application'))
  }
}
