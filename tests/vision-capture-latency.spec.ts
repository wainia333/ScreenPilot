import { expect, test, type Page } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

type CaptureTestState = {
  showCount: number
  deferVisionFlights: boolean
  deferCaptureEncoding: boolean
  pendingCaptureEncodingCount: number
  captureEncodingFailuresRemaining: number
  listenerFailuresRemaining: Record<string, number>
  deferImageReads: boolean
  pendingVisionFlightCount: number
  completedVisionFlightCount: number
  pendingImageReadCount: number
  imageReadRequests: { imageId: string; pendingFlights: number; completedFlights: number }[]
  deletedTemporaryImageIds: string[]
  resolveNextVisionFlight: () => boolean
  resolveNextCaptureEncoding: () => boolean
  resolveNextImageRead: () => boolean
  closeVisionSurface: () => void
}

async function captureState(page: Page) {
  return page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    return {
      showCount: state.showCount,
      pendingFlights: state.pendingVisionFlightCount,
      completedFlights: state.completedVisionFlightCount,
      pendingReads: state.pendingImageReadCount,
      pendingEncodings: state.pendingCaptureEncodingCount,
      reads: state.imageReadRequests,
      deleted: state.deletedTemporaryImageIds,
    }
  })
}

async function startVision(page: Page) {
  await installVisionTauriMock(page, undefined, false)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?window=vision#vision?mode=chat')
  await expect.poll(async () => (await captureState(page)).showCount, { timeout: 20_000 }).toBe(1)
  await expect(page.locator('[data-screenpilot-vision-root="true"]')).toHaveCSS('cursor', 'crosshair')
}

async function captureLargeRegion(page: Page) {
  await page.mouse.move(30, 30)
  await page.mouse.down()
  await page.mouse.move(1210, 770, { steps: 4 })
  await page.mouse.up()
}

test('Vision lands and accepts a question before a large screenshot preview finishes loading', async ({ page }) => {
  await startVision(page)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferVisionFlights = true
    state.deferCaptureEncoding = true
    state.deferImageReads = true
  })
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).pendingFlights).toBe(1)
  expect((await captureState(page)).pendingEncodings).toBe(1)
  expect((await captureState(page)).reads).toEqual([])
  const prompt = page.locator('[data-screenpilot-vision-prompt="true"]')
  await expect(prompt).toBeVisible()
  await prompt.fill('Inspect this large screenshot.')

  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextVisionFlight())).toBe(true)
  await expect.poll(async () => (await captureState(page)).completedFlights).toBe(1)
  expect((await captureState(page)).reads).toEqual([])
  await expect(page.locator('[data-screenpilot-vision-send="true"]')).toBeDisabled()
  await expect(prompt).toHaveValue('Inspect this large screenshot.')
  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextCaptureEncoding())).toBe(true)
  await expect.poll(async () => (await captureState(page)).pendingReads).toBe(1)
  expect((await captureState(page)).reads).toEqual([
    { imageId: 'capture-1', pendingFlights: 0, completedFlights: 1 },
  ])
  await expect(prompt).toHaveValue('Inspect this large screenshot.')
  await prompt.press('Enter')
  const log = page.getByRole('log')
  await expect(log).toContainText('Inspect this large screenshot.')
  await expect(log).toHaveAttribute('aria-busy', 'false')
  await expect(log.locator('[data-screenpilot-message-screenshot="true"]')).toHaveCount(0)

  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextImageRead())).toBe(true)
  await expect(log.locator('[data-screenpilot-message-screenshot="true"]')).toBeVisible()
  await expect(page.locator('[data-screenpilot-prompt-bar="true"] [data-screenpilot-screenshot-preview="true"]')).toHaveCount(0)
})

test('Vision skips preview reads when a capture flight is closed before landing', async ({ page }) => {
  await startVision(page)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferVisionFlights = true
    state.deferCaptureEncoding = true
  })
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).pendingFlights).toBe(1)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.closeVisionSurface()
    state.resolveNextVisionFlight()
    state.resolveNextCaptureEncoding()
  })
  await expect.poll(async () => (await captureState(page)).deleted).toContain('capture-1')
  expect((await captureState(page)).reads).toEqual([])
  await expect(page.locator('[data-screenpilot-screenshot-preview="true"]')).toHaveCount(0)
})

test('Vision discards a late preview after resetting into a new screenshot session', async ({ page }) => {
  await startVision(page)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferImageReads = true
  })
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).pendingReads).toBe(1)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('vision:reset')))
  await expect.poll(async () => (await captureState(page)).showCount).toBe(2)
  await expect(page.locator('[data-screenpilot-vision-root="true"]')).toHaveCSS('cursor', 'crosshair')
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).pendingReads).toBe(2)

  await page.evaluate(async () => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.resolveNextImageRead()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
  })
  await expect(page.locator('[data-screenpilot-screenshot-preview="true"]')).toHaveCount(0)
  expect((await captureState(page)).pendingReads).toBe(1)
  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextImageRead())).toBe(true)
  await expect(page.locator('[data-screenpilot-screenshot-preview="true"]')).toBeVisible()
  expect((await captureState(page)).reads.map(request => request.imageId)).toEqual(['capture-1', 'capture-2'])
})

test('Vision recovers when encoding fails after the narrow bar has already landed', async ({ page }) => {
  await startVision(page)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferCaptureEncoding = true
    state.captureEncodingFailuresRemaining = 1
  })
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).completedFlights).toBe(1)
  await expect(page.getByRole('status', { name: '正在准备截图' })).toBeVisible()
  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextCaptureEncoding())).toBe(true)
  await expect(page.locator('[data-screenpilot-vision-root="true"]')).toHaveCSS('cursor', 'crosshair')
  await expect(page.getByRole('status', { name: '正在准备截图' })).toHaveCount(0)
  expect((await captureState(page)).reads).toEqual([])

  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferCaptureEncoding = false
  })
  await captureLargeRegion(page)
  await expect(page.locator('[data-screenpilot-screenshot-preview="true"]')).toBeVisible()
})

test('Vision falls back to the completed capture if the early-ready listener cannot start', async ({ page }) => {
  await startVision(page)
  await page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }).__SCREENPILOT_TEST__
    state.deferCaptureEncoding = true
    state.listenerFailuresRemaining['vision-capture-ready'] = 1
  })
  await captureLargeRegion(page)
  await expect.poll(async () => (await captureState(page)).pendingEncodings).toBe(1)
  expect((await captureState(page)).completedFlights).toBe(0)
  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: CaptureTestState }
  ).__SCREENPILOT_TEST__.resolveNextCaptureEncoding())).toBe(true)
  await expect(page.locator('[data-screenpilot-screenshot-preview="true"]')).toBeVisible()
  expect((await captureState(page)).reads).toEqual([
    { imageId: 'capture-1', pendingFlights: 0, completedFlights: 1 },
  ])
})
