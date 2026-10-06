import { expect, test, type Page } from '@playwright/test'

const actions = (page: Page) => page.evaluate(() => (window as unknown as { captureTestActions?: { action: string; payload: { image?: string; rect?: { width: number; height: number }; value?: { view?: { zoom: number; rotation: number; flipH: boolean }; opacity?: number; offset?: { x: number; y: number }; surface?: { x: number; y: number; width: number; height: number }[]; regions?: { x: number; y: number; width: number; height: number }[] } } }[] }).captureTestActions ?? [])
async function select(page: Page, query = '') {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/?capture-lab=1${query}`)
  await expect(page.locator('.jt-chrome')).toBeVisible()
  await page.mouse.move(160, 150); await page.mouse.down(); await page.mouse.move(860, 550); await page.mouse.up()
}

for (const ratio of [1, 1.25, 1.5, 2]) test(`single physical-pixel keyboard moves repaint the magnifier without pointer events at DPI ${ratio}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: ratio })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:1420/?capture-lab=1&pixel-grid=1')
  await expect(page.locator('.jt-magnifier canvas')).toBeVisible()
  await page.mouse.move(320, 240)
  const before = await page.locator('.jt-magnifier canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.jt-magnifier-position')).toHaveText(`(${Math.round(320 * ratio) + 1}, ${Math.round(240 * ratio)})`)
  const after = await page.locator('.jt-magnifier canvas').evaluate((c: HTMLCanvasElement) => c.toDataURL())
  expect(after).not.toBe(before)
  for (let n = 0; n < 12; n++) await page.keyboard.press('ArrowDown')
  for (let n = 0; n < 7; n++) await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.jt-magnifier-position')).toHaveText(`(${Math.round(320 * ratio) - 6}, ${Math.round(240 * ratio) + 12})`)
  await context.close()
})

test('long capture preview is inside the native visible surface without blocking desktop scrolling; completion drains the pending stitch', async ({ page }) => {
  await select(page, '&slow-scroll=1')
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  const preview = page.getByRole('region', { name: '长截图实时预览' })
  await expect(preview.getByRole('img')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const box = document.querySelector('.jt-scroll-preview')?.getBoundingClientRect()
    const actions = (window as unknown as { captureTestActions: { action: string; payload: { value?: { surface?: { x: number; y: number; width: number; height: number }[]; regions?: { x: number; y: number; width: number; height: number }[] } } }[] }).captureTestActions
    if (!box) return false
    const value = actions.filter(a => a.action === 'interaction').at(-1)?.payload.value
    return value?.surface?.some(r => r.x <= box.x && r.y <= box.y && r.x + r.width >= box.right && r.y + r.height >= box.bottom)
      && !value.regions?.some(r => r.x <= box.x && r.y <= box.y && r.x + r.width >= box.right && r.y + r.height >= box.bottom)
  })).toBe(true)
  await page.evaluate(() => { (window as unknown as { captureScrollOffset: number }).captureScrollOffset = 180 })
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveCaptureScroll?: () => void }).resolveCaptureScroll)).toBe('function')
  await page.getByRole('button', { name: '完成长截图', exact: true }).click()
  expect((await actions(page)).some(a => a.action === 'scroll_finish')).toBe(false)
  await page.evaluate(() => { (window as unknown as { captureScrollOffset: number; resolveCaptureScroll: () => void }).captureScrollOffset = 360; (window as unknown as { resolveCaptureScroll: () => void }).resolveCaptureScroll() })
  await expect.poll(async () => (await actions(page)).find(a => a.action === 'confirm')?.payload.rect?.height).toBe(760)
  const result = (await actions(page)).find(a => a.action === 'confirm')?.payload.image
  const pixel = await page.evaluate(async image => { if (!image) throw new Error('Missing long capture result'); const img = new Image(); img.src = image; await img.decode(); const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height; const c = canvas.getContext('2d'); if (!c) throw new Error('Missing canvas'); c.drawImage(img, 0, 0); return Array.from(c.getImageData(10, 740, 1, 1).data) }, result)
  expect(pixel).toEqual([740 % 251, (740 * 17) % 253, (740 * 29) % 255, 255])
})

test('long capture pin sends the full stitched pixels and dimensions and updates the adjacent thumbnail', async ({ page }) => {
  await select(page)
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  await expect(page.getByRole('button', { name: '钉住长截图', exact: true }).locator('[data-pin-icon="diagonal"]')).toBeVisible()
  await page.evaluate(() => { (window as unknown as { captureScrollOffset: number }).captureScrollOffset = 360 })
  await expect(page.locator('.jt-scroll-preview > span')).toHaveText('700 × 760')
  await page.screenshot({ path: '.task/capture-scroll-live-preview.png', animations: 'disabled' })
  await page.getByRole('button', { name: '钉住长截图', exact: true }).click()
  await expect.poll(async () => (await actions(page)).find(a => a.action === 'pin')?.payload.rect?.height).toBe(760)
})

for (const horizontal of [false, true]) test(`long preview keeps its ${horizontal ? 'height and left' : 'width and bottom'} fixed, growing ${horizontal ? 'right' : 'up'} with latest pixels at the monitor limit`, async ({ page }) => {
  await select(page, '&long-scroll=1')
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  if (horizontal) await page.getByRole('button', { name: '切换拼接方向' }).click()
  const preview = page.getByRole('region', { name: '长截图实时预览' }), image = preview.getByRole('img')
  await expect(image).toBeVisible()
  await expect(preview.locator('span')).toHaveText('700 × 400')
  const initial = await preview.boundingBox()
  if (!initial) throw new Error('Missing preview')
  let previous = '', previousSize = horizontal ? initial.width : initial.height
  for (const offset of [360, 4000, 12000, 28000]) {
    await page.evaluate(value => { (window as unknown as { captureScrollOffset: number }).captureScrollOffset = value }, offset)
    await expect(preview.locator('span')).toHaveText(horizontal ? `${700 + offset} × 400` : `700 × ${400 + offset}`)
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalHeight > 0)).toBe(true)
    const geometry = await image.evaluate((img: HTMLImageElement) => {
      const box = img.getBoundingClientRect(), parent = img.parentElement?.getBoundingClientRect()
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height,
        parent: parent ? { x: parent.x, y: parent.y, right: parent.right, bottom: parent.bottom, width: parent.width, height: parent.height } : null,
        fit: getComputedStyle(img).objectFit, source: img.currentSrc, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
    })
    expect(geometry.source).not.toBe(previous); previous = geometry.source
    expect(geometry.fit).toBe('contain')
    if (!geometry.parent) throw new Error('Preview viewport must remain mounted')
    expect(geometry.x).toBeGreaterThan(geometry.parent.x); expect(geometry.y).toBeGreaterThan(geometry.parent.y)
    expect(geometry.right).toBeLessThan(geometry.parent.right); expect(geometry.bottom).toBeLessThan(geometry.parent.bottom)
    expect(geometry.parent.bottom).toBeLessThanOrEqual(800)
    expect(geometry.parent.right).toBeLessThanOrEqual(1280)
    expect(geometry.width / geometry.height).toBeCloseTo(geometry.naturalWidth / geometry.naturalHeight, 2)
    if (horizontal) {
      expect(geometry.parent.height).toBe(initial.height); expect(geometry.parent.x).toBe(initial.x)
      expect(geometry.parent.width).toBeGreaterThanOrEqual(previousSize); previousSize = geometry.parent.width
    } else {
      expect(geometry.parent.width).toBe(initial.width); expect(geometry.parent.bottom).toBeCloseTo(initial.y + initial.height, 1)
      expect(geometry.parent.height).toBeGreaterThanOrEqual(previousSize); previousSize = geometry.parent.height
    }
    if (offset >= 4000) expect(geometry.naturalWidth / geometry.naturalHeight).not.toBeCloseTo(horizontal ? (700 + offset) / 400 : 700 / (400 + offset), 2)
  }
  await page.screenshot({ path: `.task/capture-preview-${horizontal ? 'horizontal' : 'vertical'}-fixed-side.png`, animations: 'disabled' })
})

test('pin shows only after canvas and native geometry are ready, even with suspended animation frames', async ({ page }) => {
  await page.addInitScript(() => { window.requestAnimationFrame = () => 12345 })
  await page.goto('/?capture-lab=1&mode=pin&pin-width=480&pin-height=320')
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'ready')).toBe(true)
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'pin_presented')).toBe(true)
  const calls = await actions(page), ready = calls.findIndex(a => a.action === 'ready')
  expect(calls.findIndex(a => a.action === 'pin_resize')).toBeLessThan(ready)
  expect(calls.findIndex(a => a.action === 'pin_interaction')).toBeLessThan(ready)
  expect(calls.findIndex(a => a.action === 'pin_presented')).toBeGreaterThan(ready)
  const painted = await page.locator('.jt-pin-document canvas').first().evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')?.getImageData(0, 0, 1, 1).data ?? []))
  expect(painted).toEqual([39, 86, 108, 255])
  await expect(page.locator('.jt-pin-image')).toHaveCSS('animation-name', 'none')
  await expect(page.locator('.jt-pin-image')).toHaveCSS('transition-duration', '0s')
})

test('long capture save waits for the stitched result; live shape excludes the selection and stays stable while polling', async ({ page }) => {
  await select(page)
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存长截图', exact: true })).toBeVisible()
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'interaction').at(-1)?.payload.value?.surface?.length).toBeGreaterThan(0)
  const shape = (await actions(page)).filter(a => a.action === 'interaction').at(-1)?.payload.value
  const selected = { x: 160, y: 150, width: 700, height: 400 }
  expect(shape?.surface?.every(r => r.x >= selected.x + selected.width || r.x + r.width <= selected.x || r.y >= selected.y + selected.height || r.y + r.height <= selected.y)).toBe(true)
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'ready').length).toBe(1)
  const readyBefore = 1
  await page.evaluate(() => { (window as unknown as { captureScrollOffset: number }).captureScrollOffset = 540 })
  await expect(page.locator('.jt-scroll-preview > span')).toHaveText('700 × 940')
  expect((await actions(page)).filter(a => a.action === 'ready').length).toBe(readyBefore)
  await page.screenshot({ path: '.task/capture-scroll-save-toolbar.png', animations: 'disabled' })
  await page.getByRole('button', { name: '保存长截图', exact: true }).click()
  await expect.poll(async () => (await actions(page)).find(a => a.action === 'save')?.payload.rect?.height).toBe(940)
  const result = (await actions(page)).find(a => a.action === 'save')?.payload.image
  expect(result?.startsWith('data:image/png;base64,')).toBe(true)
})

test('restored pin applies its saved geometry and persists later opacity and zoom changes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?capture-lab=1&mode=pin&pin-width=400&pin-height=300&restore-pin=1')
  await expect(page.locator('.jt-pin-image')).toHaveCSS('width', '225px')
  await expect(page.locator('.jt-pin-image')).toHaveCSS('height', '300px')
  await expect(page.locator('.jt-pin-image')).toHaveCSS('opacity', '0.5')
  await page.mouse.move(100, 100); await page.mouse.wheel(0, -120)
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control')
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'pin_state').at(-1)?.payload.value?.opacity).toBe(0.55)
  const state = (await actions(page)).filter(a => a.action === 'pin_state').at(-1)?.payload.value
  expect(state?.view).toMatchObject({ rotation: 90, flipH: true })
  expect(state?.view?.zoom).toBeCloseTo(0.7875)
  expect(state?.offset).toEqual({ x: 12, y: 12 })
  await page.locator('.jt-pin-input').dblclick({ position: { x: 80, y: 80 } })
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'cancel')).toBe(true)
})

test('long capture establishes a hollow native surface before showing a WebView with suspended animation frames', async ({ page }) => {
  await select(page)
  await page.evaluate(() => { window.requestAnimationFrame = () => 12345 })
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'ready')).toBe(true)
  const calls = await actions(page), ready = calls.findIndex(a => a.action === 'ready')
  const shaped = calls.findIndex(a => a.action === 'interaction' && a.payload.value?.surface && a.payload.value.regions?.length)
  expect(shaped).toBeGreaterThanOrEqual(0)
  expect(shaped).toBeLessThan(ready)
  expect(calls[shaped]?.payload.value?.surface?.some(r => r.x === 160 && r.y === 150 && r.width === 700 && r.height === 400)).toBe(false)
})

for (const key of ['Control+c', 'Enter', 'Control+s']) test(`long capture ${key} uses the complete stitched image`, async ({ page }) => {
  await select(page)
  await page.getByRole('button', { name: '长截图（滚动）', exact: true }).click()
  await page.evaluate(() => { (window as unknown as { captureScrollOffset: number }).captureScrollOffset = 540 })
  await expect(page.locator('.jt-scroll-preview > span')).toHaveText('700 × 940')
  await page.keyboard.press(key)
  const terminal = key === 'Control+s' ? 'save' : 'confirm'
  await expect.poll(async () => (await actions(page)).find(a => a.action === terminal)?.payload.rect?.height).toBe(940)
  const calls = await actions(page)
  expect(calls.findIndex(a => a.action === terminal)).toBeGreaterThan(calls.findIndex(a => a.action === 'scroll_finish'))
})
