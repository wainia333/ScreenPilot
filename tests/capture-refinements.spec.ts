import { expect, test, type Page } from '@playwright/test'

type Action = { action: string; payload: { id?: string; image?: string; pinImage?: string; value?: { dx?: number; dy?: number }; preferences?: { options: Record<string, number> } } }
const actions = (page: Page) => page.evaluate(() => (window as unknown as { captureTestActions: Action[] }).captureTestActions)
async function select(page: Page) {
  await expect(page.locator('.jt-chrome')).toBeVisible()
  await page.mouse.move(140, 100); await page.mouse.down(); await page.mouse.move(700, 400); await page.mouse.up()
}
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/?capture-lab=1') })

test('wheel adjusts magnifier in quarter steps, clamps and saves without changing drawing wheel controls', async ({ page }) => {
  await expect(page.locator('.jt-magnifier-zoom')).toHaveText('4.0x')
  await page.mouse.move(500, 250); await page.mouse.wheel(0, -120)
  await expect(page.locator('.jt-magnifier-zoom')).toHaveText('4.25x')
  await page.mouse.wheel(0, 120); await expect(page.locator('.jt-magnifier-zoom')).toHaveText('4.0x')
  await page.locator('.jt-chrome').evaluate(canvas => { for (let i = 0; i < 50; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })) })
  await expect(page.locator('.jt-magnifier-zoom')).toHaveText('10.0x')
  await select(page); await page.keyboard.press('p')
  await page.mouse.move(300, 250); await page.mouse.wheel(0, -120)
  await expect(page.getByRole('spinbutton', { name: '线宽', exact: true })).toHaveValue('13')
  await page.keyboard.press('s'); await page.mouse.wheel(0, 120)
  await expect(page.locator('.jt-magnifier-zoom')).toHaveText('9.75x')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await actions(page)).find(a => a.action === 'cancel')?.payload.preferences?.options.magnifier_zoom).toBe(9.75)
})

test('refresh replaces the captured background while retaining annotations; failures keep the old image', async ({ page }) => {
  await select(page); await page.keyboard.press('p')
  await page.mouse.move(220, 210); await page.mouse.down(); await page.mouse.move(400, 210); await page.mouse.up()
  await expect(page.locator('[data-tool="pin"] [data-pin-icon="diagonal"]')).toBeVisible()
  await page.getByRole('button', { name: '刷新背景', exact: true }).click()
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'ready').length).toBe(1)
  const pixel = (x: number, y: number) => page.locator('.jt-document').evaluate((element: HTMLCanvasElement, p) => Array.from(element.getContext('2d')?.getImageData(p.x, p.y, 1, 1).data ?? []), { x, y })
  expect(await pixel(500, 300)).toEqual([74, 157, 130, 255])
  expect(await pixel(300, 210)).toEqual([255, 0, 0, 255])
  await expect(page.locator('.jt-selection-info')).toContainText('560 × 300')
  await page.screenshot({ path: 'release/tauri-capture-preview/refreshed-background.png' })
  await page.goto('/?capture-lab=1&fail-refresh=1'); await select(page)
  const before = await pixel(500, 300)
  await page.getByRole('button', { name: '刷新背景', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('捕获后端不可用')
  expect(await pixel(500, 300)).toEqual(before)
  expect((await actions(page)).some(a => a.action === 'ready')).toBe(true)
})

test('cancel during a pending background refresh never reopens the session', async ({ page }) => {
  await page.goto('/?capture-lab=1&slow-refresh=1'); await select(page)
  await page.getByRole('button', { name: '刷新背景', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'cancel')).toBe(true)
  await page.evaluate(() => (window as unknown as { resolveCaptureRefresh: () => void }).resolveCaptureRefresh())
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect((await actions(page)).some(a => a.action === 'ready')).toBe(false)
})

test('background refresh recovers when a hidden WebView suspends animation frames', async ({ page }) => {
  await select(page)
  await page.getByRole('button', { name: '刷新背景', exact: true }).evaluate((element: HTMLButtonElement) => {
    window.requestAnimationFrame = () => 0
    element.click()
  })
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'ready').length).toBe(1)
  const pixel = await page.locator('.jt-document').evaluate((element: HTMLCanvasElement) => Array.from(element.getContext('2d')?.getImageData(500, 300, 1, 1).data ?? []))
  expect(pixel).toEqual([74, 157, 130, 255])
})

test('pin sends composed copy/save pixels and a separate editable backing image', async ({ page }) => {
  await select(page); await page.keyboard.press('p')
  await page.mouse.move(220, 210); await page.mouse.down(); await page.mouse.move(400, 210); await page.mouse.up()
  await page.getByRole('button', { name: '钉图', exact: true }).click()
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'pin')).toBe(true)
  const payload = (await actions(page)).find(a => a.action === 'pin')?.payload
  const samples = await page.evaluate(async payload => {
    const sample = async (src?: string) => { const image = new Image(); image.src = src ?? ''; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const c = canvas.getContext('2d'); c?.drawImage(image, 0, 0); return { dimensions: [image.width, image.height], pixel: Array.from(c?.getImageData(160, 110, 1, 1).data ?? []) } }
    return [await sample(payload?.image), await sample(payload?.pinImage)]
  }, payload)
  expect(samples[0]?.dimensions).toEqual([560, 300]); expect(samples[1]?.dimensions).toEqual([560, 300])
  expect(samples[0]?.pixel).toEqual([255, 0, 0, 255]); expect(samples[1]?.pixel).not.toEqual(samples[0]?.pixel)
  expect((await actions(page)).some(a => a.action === 'dismiss')).toBe(false)
})

test('pin preparation retains selected pixels throughout encoding and waiting for the replacement', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?capture-lab=1&slow-pin=1')
  await expect(page.locator('.jt-chrome')).toBeVisible()
  await page.mouse.move(160, 150); await page.mouse.down(); await page.mouse.move(720, 450); await page.mouse.up()
  const before = await page.locator('.jt-document').evaluate((c: HTMLCanvasElement) => c.toDataURL())
  await page.getByRole('button', { name: '钉图', exact: true }).click()
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveCapturePin?: () => void }).resolveCapturePin)).toBe('function')
  expect((await actions(page)).some(a => a.action === 'dismiss')).toBe(false)
  expect(await page.locator('.jt-document').evaluate((c: HTMLCanvasElement) => c.toDataURL())).toBe(before)
  await expect(page.locator('.jt-toolbar, .jt-selection-info, .jt-magnifier')).toHaveCount(0)
  await expect(page.locator('.jt-physical-stage')).toHaveCSS('clip-path', 'inset(147px 557px 347px 157px)')
  await expect(page.locator('.jt-document-clip')).toHaveCSS('clip-path', 'inset(150px 560px 350px 160px)')
  const calls = await actions(page)
  expect(calls.findIndex(a => a.action === 'pin_prepare')).toBeLessThan(calls.findIndex(a => a.action === 'pin'))
  const retained = await page.locator('.jt-chrome').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); return { border: Array.from(ctx.getImageData(200, 149, 1, 1).data), interior: ctx.getImageData(200, 200, 1, 1).data[3], outside: ctx.getImageData(100, 100, 1, 1).data[3] }
  })
  expect(retained.border).toEqual([51, 136, 255, 255]); expect(retained.interior).toBe(0); expect(retained.outside).toBe(0)
  await page.evaluate(() => { (window as unknown as { resolveCapturePin: () => void }).resolveCapturePin() })
})

for (const dpr of [1, 1.25, 1.5, 2]) test(`pin border stays one physical pixel with a soft shadow at DPI ${dpr}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  await page.goto('/?capture-lab=1&mode=pin&pin-width=560&pin-height=300&selection-frame=1')
  const frame = page.locator('.jt-pin-frame'), picture = page.locator('.jt-pin-image')
  await expect(frame).toBeVisible()
  await expect(picture).toHaveCSS('box-shadow', 'none')
  await expect(picture).toHaveCSS('outline-style', 'none')
  const bounds = await frame.boundingBox(), imageBounds = await picture.boundingBox()
  expect(bounds && imageBounds && (imageBounds.x - bounds.x) * dpr).toBeCloseTo(12,1)
  expect(bounds?.width && bounds.width * dpr).toBeCloseTo(584,1)
  const border = await frame.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')?.getImageData(43,11,1,1).data ?? []))
  expect(border).toEqual([51,136,255,255])
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'pin_presented')).toBe(true)
  await page.keyboard.press('Space')
  await expect(frame).toBeVisible()
  expect(await frame.evaluate((c: HTMLCanvasElement) => Array.from(c.getContext('2d')?.getImageData(43,11,1,1).data ?? []))).toEqual(border)
  await context.close()
})

for (const dpr of [1, 1.25, 1.5, 2]) test(`pin zoom anchors upper-left, spacious menu and double-click close at DPI ${dpr}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr })
  const page = await context.newPage()
  await page.goto('/?capture-lab=1&mode=pin&pin-width=480&pin-height=320')
  const picture = page.locator('.jt-pin-image'); await expect(picture).toBeVisible()
  await page.keyboard.press('Space')
  await expect(page.getByRole('toolbar', { name: '截图工具条' })).toBeVisible()
  const position = async () => {
    const box = await picture.boundingBox(); if (!box) throw new Error('Missing pin')
    const delta = (await actions(page)).filter(a => a.action === 'pin_resize').reduce((p, a) => ({ x: p.x + (a.payload.value?.dx ?? 0), y: p.y + (a.payload.value?.dy ?? 0) }), { x: 0, y: 0 })
    return { x: box.x * dpr + delta.x, y: box.y * dpr + delta.y, width: box.width }
  }
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'pin_resize').length).toBeGreaterThan(0)
  const before = await position(); const box = await picture.boundingBox(); if (!box) throw new Error('Missing pin')
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.65)
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120)
  await expect.poll(async () => (await position()).width).toBeGreaterThan(before.width * 1.15)
  await expect.poll(async () => Math.abs((await position()).x - before.x)).toBeLessThanOrEqual(1)
  await expect.poll(async () => Math.abs((await position()).y - before.y)).toBeLessThanOrEqual(1)
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => Math.abs((await position()).x - before.x)).toBeLessThanOrEqual(1)
  const input = page.locator('.jt-pin-input'); await input.click({ button: 'right', position: { x: 50, y: 60 } })
  const menu = page.getByRole('menu', { name: '钉图菜单' }); await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS('border-radius', '9px')
  const rightEdges = await menu.locator('kbd').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().right))
  expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1)
  const menuBox = await menu.boundingBox(); expect(menuBox?.width).toBeGreaterThan(200)
  expect(menuBox && menuBox.x + menuBox.width).toBeLessThanOrEqual(1280)
  if (dpr === 1) await page.screenshot({ path: 'release/tauri-capture-preview/pin-menu.png' })
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
  await input.dblclick({ position: { x: 50, y: 60 } })
  await expect.poll(async () => (await actions(page)).filter(a => a.action === 'cancel').length).toBe(1)
  await context.close()
})

test('toolbar vector number icon stays clear and contained across resolutions and all scale options', async ({ browser }) => {
  test.setTimeout(120_000)
  for (const [width, dpr] of [[800, 1], [1280, 1.25], [1920, 2]] as const) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: dpr })
    const page = await context.newPage()
    for (const scale of [0, 80, 90, 100, 110, 125, 150, 175, 200]) {
      await page.goto(`/?capture-lab=1&scale=${scale}`); await select(page)
      const toolbar = page.getByRole('toolbar', { name: '截图工具条' }), number = toolbar.getByRole('button', { name: '序号（Shift + 滚轮调整数字）' })
      await expect(number).toBeVisible()
      const geometry = await number.evaluate(element => { const button = element.getBoundingClientRect(), image = element.querySelector('img')?.getBoundingClientRect(); return { button: { x: button.x, right: button.right }, image: image ? { x: image.x, right: image.right } : null } })
      expect(geometry.image?.x).toBeGreaterThan(geometry.button.x); expect(geometry.image?.right).toBeLessThan(geometry.button.right)
      const bounds = await toolbar.boundingBox(); expect(bounds?.x).toBeGreaterThanOrEqual(0); expect(bounds && bounds.x + bounds.width).toBeLessThanOrEqual(width)
      const svg = await number.locator('img').evaluate(async (img: HTMLImageElement) => (await fetch(img.src)).text())
      expect(svg).not.toContain('<text'); expect(svg).toMatch(/viewBox=['"]0 0 24 24['"]/u)
      if (width === 1280 && scale === 100) await page.screenshot({ path: 'release/tauri-capture-preview/refined-toolbar.png' })
    }
    await context.close()
  }
})

test('playback shapes the native surface and export cancellation stays interactive at the top', async ({ page }) => {
  await page.goto('/?capture-lab=1&mode=record&slow-export=1'); await select(page)
  await page.getByRole('button', { name: '开始录制', exact: true }).click()
  await page.getByRole('button', { name: '结束录制', exact: true }).click()
  await expect(page.getByRole('group', { name: '录制回放' })).toBeVisible()
  const regions = () => page.evaluate(() => {
    type R = { x: number; y: number; width: number; height: number }
    const a = (window as unknown as { captureTestActions: { action: string; payload: { value?: { regions: R[]; surface: R[] | null; passthrough: boolean } } }[] }).captureTestActions
    return a.filter(a => a.action === 'interaction').at(-1)?.payload.value
  })
  await expect.poll(async () => (await regions())?.passthrough).toBe(false)
  const shape = (await regions())?.surface
  expect(shape).toBeTruthy()
  expect(shape?.some(r => r.x === 0 && r.y === 0 && r.width === 1280 && r.height === 800)).toBe(false)
  await page.getByRole('button', { name: '复制 GIF', exact: true }).click()
  const cancel = page.getByRole('button', { name: '取消导出', exact: true })
  await expect(cancel).toBeVisible()
  // Compare the final toast position, not a transient entrance-animation frame.
  await cancel.evaluate(async element => { await Promise.all(element.closest('.save-success-toast')?.getAnimations().map(animation => animation.finished) ?? []) })
  const box = await cancel.boundingBox(); if (!box) throw new Error('Missing cancellation control')
  await expect.poll(async () => (await regions())?.regions.some(r => r.x <= box.x && r.y <= box.y && r.x + r.width >= box.x + box.width && r.y + r.height >= box.y + box.height)).toBe(true)
  await cancel.click()
  await expect(page.getByRole('button', { name: '另存为', exact: true })).toBeEnabled()
  expect((await actions(page)).some(a => a.action === 'cancel_export')).toBe(true)
  expect((await actions(page)).some(a => a.action === 'record_overlay')).toBe(false)
  await page.getByRole('button', { name: '关闭回放', exact: true }).click()
  await expect.poll(async () => (await actions(page)).some(a => a.action === 'cancel')).toBe(true)
})

test('empty recordings show a recoverable error instead of a black playback surface', async ({ page }) => {
  await page.goto('/?capture-lab=1&mode=record&empty-recording=1'); await select(page)
  await page.getByRole('button', { name: '开始录制', exact: true }).click()
  await page.getByRole('button', { name: '结束录制', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('没有捕获到录制画面')
  await expect(page.getByRole('button', { name: '开始录制', exact: true })).toBeEnabled()
  await expect(page.getByRole('group', { name: '录制回放' })).toHaveCount(0)
})
