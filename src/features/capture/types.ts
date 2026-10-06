export type CaptureMode = 'image' | 'record' | 'scan'
export type CaptureSettings = {
  enabled: boolean
  pinsVisible: boolean
  shortcut: string
  nativeOptions: Record<string, boolean | number | string>
  tools: import('./editor/model').CaptureSnapshot['tools']
}
export type CapturePort = { open(mode: CaptureMode): Promise<void> }
