import { expect, test, type Page } from '@playwright/test'

type Call = { action: string; payload: { image?: string; value?: { dx?: number; dy?: number; visual?: { state: { view: { zoom: number }; offset: { x: number; y: number } }; focused: boolean } } } }
const calls = (page: Page) => page.evaluate(() => (window as unknown as { captureTestActions?: Call[] }).captureTestActions ?? [])
async function open(page: Page, query = '', retainedFrame = true) {
  await page.goto(`/?capture-lab=1&mode=pin&pin-width=480&pin-height=320${retainedFrame ? '&selection-frame=1' : ''}${query}`)
  await expect.poll(async () => (await calls(page)).some(c => c.action === 'pin_presented')).toBe(true)
}
async function position(page: Page, ratio: number) {
  const box = await page.locator('.jt-pin-image').boundingBox(); if (!box) throw new Error('Pin not visible')
  const shifts = (await calls(page)).filter(c => c.action === 'pin_resize' || c.action === 'pin_view').reduce((p, c) => ({ x: p.x + (c.payload.value?.dx ?? 0), y: p.y + (c.payload.value?.dy ?? 0) }), { x: 0, y: 0 })
  return { x: box.x * ratio + shifts.x, y: box.y * ratio + shifts.y, width: box.width * ratio, height: box.height * ratio }
}

for (const retainedFrame of [false, true]) test(`pins always have a continuous theme rim, including ${retainedFrame ? 'retained' : 'unframed'} pins, and turn grey when inactive`, async ({ page }) => {
  await open(page, '', retainedFrame)
  const frame = page.locator('.jt-pin-frame')
  const pixels = () => frame.evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d'); if (!ctx) throw new Error('Missing pin frame')
    const pixel = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data)
    return { rim: Array.from({ length: 12 }, (_, i) => pixel(50, 11 - i)), interior: pixel(50, 12), left: pixel(9, 50), right: pixel(c.width - 10, 50) }
  })
  const active = await pixels(); expect(active.interior[3]).toBe(0)
  let previous = 255
  for (const pixel of active.rim) {
    const alpha = pixel[3] ?? 0
    if (alpha > 40) for (const [i, value] of [51, 136, 255].entries()) expect(Math.abs((pixel[i] ?? 0) - value)).toBeLessThanOrEqual(3)
    expect(alpha).toBeLessThanOrEqual(previous); if (alpha) expect(alpha).toBeLessThan(previous); previous = alpha
  }
  expect(active.rim[0]?.[3]).toBe(148); expect(active.rim[2]?.[3]).toBe(101)
  expect(active.rim[5]?.[3]).toBeLessThan(30); expect(active.rim.slice(7).every(pixel => pixel[3] === 0)).toBe(true)
  expect(active.left).toEqual(active.right)
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) await expect(page.locator(`[data-pin-edge="${edge}"]`)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect.poll(async () => (await pixels()).rim[0]?.slice(0, 3).every((v, i) => Math.abs(v - ([137, 145, 158][i] ?? 0)) <= 2)).toBe(true)
  const inactive = await pixels()
  for (const pixel of inactive.rim) if ((pixel[3] ?? 0) > 40) for (const [i, value] of [137, 145, 158].entries()) expect(Math.abs((pixel[i] ?? 0) - value)).toBeLessThanOrEqual(3)
  expect(inactive.rim.map(pixel => pixel[3])).toEqual(active.rim.map(pixel => pixel[3]))
  await page.screenshot({ path: `.task/pin-always-border-${retainedFrame ? 'retained' : 'unframed'}-inactive.png` })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(async () => (await pixels()).rim).toEqual(active.rim)
  await page.mouse.move(250, 230)
  await page.screenshot({ path: `.task/pin-always-border-${retainedFrame ? 'retained' : 'unframed'}-active.png` })
  await expect(frame).toHaveCSS('animation-name', 'none'); await expect(frame).toHaveCSS('transition-duration', '0s')
})

for (const ratio of [1, 1.25, 1.5, 2]) test(`all edge resize cursors and opposite anchors preserve the image ratio at DPI ${ratio}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: ratio })
  const page = await context.newPage()
  try {
    for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      await open(page)
      const target = page.locator(`[data-pin-edge="${edge}"]`)
      const cursor = ['n', 's'].includes(edge) ? 'ns-resize' : ['e', 'w'].includes(edge) ? 'ew-resize' : ['ne', 'sw'].includes(edge) ? 'nesw-resize' : 'nwse-resize'
      await expect(target).toHaveCSS('cursor', cursor)
      const before = await position(page, ratio), box = await target.boundingBox(); if (!box) throw new Error('Resize target missing')
      const dx = edge.includes('e') ? 48 : edge.includes('w') ? -48 : 0, dy = edge.includes('s') ? 32 : edge.includes('n') ? -32 : 0
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + dx / ratio, box.y + box.height / 2 + dy / ratio, { steps: 4 }); await page.mouse.up()
      await expect.poll(async () => (await position(page, ratio)).width).toBeCloseTo(528, 0)
      const opposite = { x: edge.includes('w') ? 1 : edge.includes('e') ? 0 : 0.5, y: edge.includes('n') ? 1 : edge.includes('s') ? 0 : 0.5 }
      await expect.poll(async () => { const p = await position(page, ratio); return Math.abs(p.x + p.width * opposite.x - (before.x + before.width * opposite.x)) }).toBeLessThanOrEqual(1)
      await expect.poll(async () => { const p = await position(page, ratio); return Math.abs(p.y + p.height * opposite.y - (before.y + before.height * opposite.y)) }).toBeLessThanOrEqual(1)
      const after = await position(page, ratio); expect(after.width / after.height).toBeCloseTo(1.5, 2)
    }
  } finally { await context.close() }
})

test('native wheel updates reuse source pixels, coalesce while IPC is busy, and settle at the latest scale', async ({ page }) => {
  await open(page, '&native-pixels=1&hold-pin-pixels=1')
  await expect.poll(async () => (await calls(page)).some(c => c.action === 'pin_view' && !!c.payload.image)).toBe(true)
  const before = (await calls(page)).length
  await page.locator('.jt-pin-image').hover(); await page.mouse.wheel(0, -120)
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { resolveCapturePinPixels?: () => void }).resolveCapturePinPixels)).toBe('function')
  for (let i = 0; i < 9; i++) await page.mouse.wheel(0, -120)
  await expect.poll(async () => (await page.locator('.jt-pin-image').boundingBox())?.width ?? 0).toBeCloseTo(480 * 1.05 ** 10, 0)
  const pending = (await calls(page)).slice(before).filter(c => c.action === 'pin_view'); expect(pending).toHaveLength(1)
  expect(pending[0]?.payload.image).toBeUndefined()
  await page.evaluate(() => { (window as unknown as { resolveCapturePinPixels: () => void }).resolveCapturePinPixels() })
  await expect.poll(async () => (await calls(page)).filter(c => c.action === 'pin_view').at(-1)?.payload.value?.visual?.state.view.zoom).toBeCloseTo(1.05 ** 10, 5)
  const frames = (await calls(page)).slice(before).filter(c => c.action === 'pin_view')
  expect(frames.length).toBeLessThanOrEqual(3); expect(frames.every(c => c.payload.image === undefined)).toBe(true)
})

test('Esc and double-click close preferences work independently and never disable the explicit close menu', async ({ page }) => {
  for (const esc of [true, false]) for (const doubleClick of [true, false]) {
    const query = `${esc ? '' : '&no-escape-close=1'}${doubleClick ? '' : '&no-double-click-close=1'}`
    await open(page, query)
    await page.keyboard.press('Escape')
    expect((await calls(page)).some(c => c.action === 'cancel')).toBe(esc)
    await open(page, query)
    await page.locator('.jt-pin-input').dblclick({ position: { x: 100, y: 100 } })
    expect((await calls(page)).some(c => c.action === 'cancel')).toBe(doubleClick)
  }
  await open(page, '&no-escape-close=1&no-double-click-close=1')
  await page.locator('.jt-pin-input').click({ button: 'right', position: { x: 100, y: 100 } })
  const menu = page.getByRole('menu', { name: '钉图菜单' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '关闭钉图' }).locator('kbd')).toHaveCount(0)
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0)
  expect((await calls(page)).some(c => c.action === 'cancel')).toBe(false)
  await page.locator('.jt-pin-input').click({ button: 'right', position: { x: 100, y: 100 } })
  await page.getByRole('menuitem', { name: '关闭钉图' }).click()
  await expect.poll(async () => (await calls(page)).some(c => c.action === 'cancel')).toBe(true)
})

for (const ratio of [1, 1.25, 1.5, 2]) test(`capture selection edges show the correct resize cursor and resize from non-midpoint positions at DPI ${ratio}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: ratio }), page = await context.newPage()
  try {
    await page.goto('/?capture-lab=1')
    const chrome = page.locator('.jt-chrome')
    await expect(chrome).toBeVisible()
    await page.mouse.move(250, 180); await page.mouse.down(); await page.mouse.move(830, 510); await page.mouse.up()
    await expect(page.getByRole('toolbar', { name: '截图工具条' })).toBeVisible()
    const points = [
      { x: 250, y: 180, cursor: 'nwse-resize' }, { x: 440, y: 180, cursor: 'ns-resize' },
      { x: 830, y: 180, cursor: 'nesw-resize' }, { x: 830, y: 310, cursor: 'ew-resize' },
      { x: 830, y: 510, cursor: 'nwse-resize' }, { x: 440, y: 510, cursor: 'ns-resize' },
      { x: 250, y: 510, cursor: 'nesw-resize' }, { x: 250, y: 310, cursor: 'ew-resize' },
    ]
    for (const p of points) { await page.mouse.move(p.x, p.y); await expect(chrome).toHaveCSS('cursor', p.cursor) }
    await page.mouse.move(440, 180); await page.mouse.down(); await page.mouse.move(440, 160); await page.mouse.up()
    await expect(page.locator('.jt-selection-info').first()).toContainText(`${Math.round(580 * ratio)} × ${Math.round(350 * ratio)}`)
    await page.mouse.move(440, 160); await expect(chrome).toHaveCSS('cursor', 'ns-resize')
    await page.mouse.move(60, 60); await expect(chrome).toHaveCSS('cursor', 'crosshair')
  } finally { await context.close() }
})
