import { defaultTauriApi, type TauriApi } from '../../desktop/tauri-api'
import type { CaptureMode, CapturePort } from './types'
export class NativeCapturePort implements CapturePort {
  constructor(private readonly api: TauriApi = defaultTauriApi) {}
  open(mode: CaptureMode): Promise<void> { return this.api.invoke('capture_open', { mode }) }
}
