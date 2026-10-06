import { expect, test, type Page } from '@playwright/test'

test('pin keeps the latest annotation state while a native layout upload is pending', async ({ page }) => {
  await page.goto('http://127.0.0.1:1420/?capture-lab=1&mode=pin&pin-width=317&pin-height=255&selection-frame=1&native-pixels=1&hold-pin-pixels=1')
  await expect.poll(() => page.evaluate(() => (window as unknown as { captureTestActions?: { action: string }[] }).captureTestActions?.some(a => a.action === 'pin_presented'))).toBe(true)
  await page.keyboard.press('Space')
  await expect(page.locator('button[data-tool="pen"]')).toBeVisible()
  await page.mouse.move(60, 80); await page.keyboard.down('Control'); await page.mouse.wheel(0, 60); await page.keyboard.up('Control')
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveCapturePinPixels?: () => void }).resolveCapturePinPixels)).toBe('function')
  await page.locator('button[data-tool="pen"]').click()
  const area = await page.locator('.jt-pin-input').boundingBox()
  if (!area) throw new Error('Missing pin input')
  await page.mouse.move(area.x + 40, area.y + 120); await page.mouse.down(); await page.mouse.move(area.x + 100, area.y + 120); await page.mouse.up()
  await page.evaluate(() => (window as unknown as { resolveCapturePinPixels: () => void }).resolveCapturePinPixels())
  await expect.poll(() => page.evaluate(() => {
    const actions = (window as unknown as { captureTestActions: { action: string; payload: { value?: { marks?: unknown[] } } }[] }).captureTestActions
    return actions.filter(a => a.action === 'pin_state').at(-1)?.payload.value?.marks?.length
  })).toBe(1)
})

const packets = (page: Page) => page.evaluate(() => ((window as unknown as { captureTestActions?: { action: string; payload: { image?: string; rect?: { x: number; y: number; width: number; height: number } } }[] }).captureTestActions ?? []).filter(a => a.action === 'pin_pixels'))

for (const ratio of [1, 1.25, 1.5, 2]) test(`native pin supplies exact physical image and border pixels at DPI ${ratio}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: ratio }), page = await context.newPage()
  await page.goto('http://127.0.0.1:1420/?capture-lab=1&mode=pin&pin-width=317&pin-height=255&selection-frame=1&pixel-grid=1&native-pixels=1')
  await expect.poll(() => packets(page).then(p => p.length)).toBe(1)
  const first = (await packets(page))[0]
  if (!first) throw new Error('Missing native pixel packet')
  const packet = first.payload
  expect(packet.rect).toEqual({ x: 9, y: 9, width: 323, height: 261 })
  const differences = await page.evaluate(async encoded => {
    const doc = document.querySelector<HTMLCanvasElement>('.jt-pin-document canvas'), frame = document.querySelector<HTMLCanvasElement>('.jt-pin-frame')
    if (!doc || !frame || !encoded) throw new Error('Missing selection raster')
    const image = new Image(); image.src = encoded; await image.decode()
    const output = document.createElement('canvas'); output.width = image.width; output.height = image.height
    const c = output.getContext('2d'), documentContext = doc.getContext('2d'), frameContext = frame.getContext('2d')
    if (!c || !documentContext || !frameContext) throw new Error('Missing raster context')
    c.drawImage(image, 0, 0)
    const content = documentContext.getImageData(2, 2, 313, 251).data, raster = c.getImageData(5, 5, 313, 251).data
    let changed = 0; for (let i = 0; i < content.length; i++) if (content[i] !== raster[i]) changed++
    const border = frameContext.getImageData(3, 0, 317, 2).data, actualBorder = c.getImageData(3, 0, 317, 2).data
    let changedBorder = 0; for (let i = 0; i < border.length; i++) if (border[i] !== actualBorder[i]) changedBorder++
    return { changed, changedBorder }
  }, packet.image)
  expect(differences).toEqual({ changed: 0, changedBorder: 0 })
  await expect(page.locator('.jt-pin-document canvas').first()).toHaveCSS('visibility', 'hidden')
  await expect.poll(() => page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.some(a => a.action === 'pin_presented'))).toBe(true)
  await page.mouse.move(70, 70)
  expect(await packets(page)).toHaveLength(1)
  await page.keyboard.press('r')
  await expect.poll(() => packets(page).then(p => p.at(-1)?.payload.rect?.width)).toBe(106)
  await page.keyboard.press('r')
  await expect.poll(() => packets(page).then(p => p.at(-1)?.payload.rect?.width)).toBe(323)
  await page.locator('.jt-pin-input').dblclick({ position: { x: 60, y: 60 } })
  await expect.poll(() => page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.some(a => a.action === 'cancel'))).toBe(true)
  await context.close()
})
