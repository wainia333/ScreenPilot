import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type WindowCapability = {
  windows: string[]
  permissions: string[]
}

type TauriConfig = {
  app: {
    windows: { label: string; create: boolean; resizable: boolean; visible: boolean; width: number; height: number }[]
  }
}

describe('Tauri window configuration', () => {
  it('grants the independent translator window the interactive window permissions', () => {
    const path = resolve(process.cwd(), 'src-tauri/capabilities/default.json')
    const capability = JSON.parse(readFileSync(path, 'utf8')) as WindowCapability
    expect(capability.windows).toContain('translator')
    expect(capability.permissions).toContain('core:window:allow-hide')
    expect(capability.permissions).toContain('core:window:allow-start-dragging')
  })

  it('creates the isolated translator window on demand and keeps it resizable', () => {
    const path = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as TauriConfig
    const translator = config.app.windows.find((window) => window.label === 'translator')
    expect(translator).toMatchObject({ create: false, resizable: true, visible: false })
  })

  it('uses the enlarged settings window size', () => {
    const path = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(path, 'utf8')) as TauriConfig
    const settings = config.app.windows.find((window) => window.label === 'main')
    expect(settings).toMatchObject({ width: 844, height: 620 })
  })
})
