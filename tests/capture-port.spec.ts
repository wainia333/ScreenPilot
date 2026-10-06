import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1280, height: 800 }); await page.goto('/?capture-lab=1'); await expect(page.locator('.jt-chrome')).toBeVisible() })

test('Esc sends changed preferences with cancellation without any preceding disk save', async ({ page }) => {
  await page.mouse.move(500, 300)
  await page.keyboard.press('PageUp')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.map(v => v.action))).toContain('cancel')
  const actions = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string; payload: { preferences?: { options: Record<string, number>; tools: Record<string, unknown> } } }[] }).captureTestActions)
  expect(actions.some(v => ['tools', 'options'].includes(v.action))).toBe(false)
  expect(actions.find(v => v.action === 'cancel')?.payload.preferences?.options.magnifier_zoom).toBe(4.25)
  expect(actions.find(v => v.action === 'cancel')?.payload.preferences?.tools).not.toHaveProperty('lastRegion')
})

test('withdraws before encoding and resumes the same scene with a top error on failure', async ({ page }) => {
  await page.goto('/?capture-lab=1&fail-save=1'); await expect(page.locator('.jt-chrome')).toBeVisible()
  await page.mouse.move(160, 120); await page.mouse.down(); await page.mouse.move(1000, 540); await page.mouse.up()
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the original canvas as this.
    const original = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const w = window as unknown as { captureTestActions: { action: string; payload: unknown }[] }
      w.captureTestActions.push({ action: 'encode', payload: {} })
      return original.apply(this, args)
    }
  })
  await page.keyboard.press('Enter')
  const error = page.getByRole('alert'); await expect(error).toContainText('磁盘写入失败')
  expect((await error.boundingBox())?.y).toBe(18)
  await expect(page.getByRole('toolbar', { name: '截图工具条' })).toBeVisible()
  const actions = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.map(v => v.action))
  expect(actions.indexOf('dismiss')).toBeLessThan(actions.indexOf('encode'))
  expect(actions.indexOf('encode')).toBeLessThan(actions.indexOf('confirm'))
  expect(actions.at(-1)).toBe('ready')
  await page.screenshot({ path: 'release/tauri-capture-preview/top-error.png' })
  await page.getByRole('button', { name: '关闭提示' }).click(); await expect(error).toHaveCount(0)
})

test('larger magnifier stays inside each screen edge', async ({ page }) => {
  const magnifier = page.locator('.jt-magnifier')
  for (const [x, y] of [[1, 1], [1279, 1], [1, 799], [1279, 799]] as const) {
    await page.mouse.move(x, y); await expect(magnifier).toBeVisible()
    await expect.poll(async () => { const b = await magnifier.boundingBox(); return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1280 && b.y + b.height <= 800 }).toBe(true)
  }
  expect((await magnifier.boundingBox())?.width).toBeGreaterThanOrEqual(224)
  await expect(magnifier.locator('canvas')).toHaveAttribute('width', '224')
  await page.screenshot({ path: 'release/tauri-capture-preview/magnifier.png' })
})
test('selection, adjacent toolbar, original tools, annotated copy and no extra editor', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message))
  await expect(page.getByRole('toolbar', { name: '截图工具条' })).toHaveCount(0)
  await page.mouse.move(160, 120); await page.mouse.down(); await page.mouse.move(1000, 540, { steps: 18 }); await page.mouse.up()
  const toolbar = page.getByRole('toolbar', { name: '截图工具条' }); await expect(toolbar).toBeVisible()
  expect((await toolbar.boundingBox())?.y).toBe(550)
  await expect(page.locator('.jt-selection-info')).toContainText('840 × 420')
  await expect(page.getByRole('button', { name: /OCR|翻译|剪贴板历史/u })).toHaveCount(0)
  await page.screenshot({ path: 'release/tauri-capture-preview/selection.png' })
  await page.getByRole('button', { name: '形状（矩形 / 椭圆）', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '矩形（Shift 正方形）', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '线宽', exact: true })).toHaveValue('9')
  await page.mouse.move(260, 260); await page.mouse.down(); await page.mouse.move(700, 380, { steps: 10 }); await page.mouse.up()
  await page.keyboard.press('Control+z'); await expect(page.getByRole('button', { name: '重做 Ctrl+Y' })).toBeEnabled()
  await page.keyboard.press('Control+y'); await page.keyboard.press('t')
  await page.mouse.click(310, 200); await page.getByRole('textbox', { name: '标注文字' }).fill('原位标注 · Tauri / Rust / React')
  await expect(page.getByRole('textbox', { name: '标注文字' })).toHaveCSS('outline-style', 'none')
  await expect(page.getByRole('textbox', { name: '标注文字' })).toHaveCSS('box-shadow', 'none')
  await page.keyboard.press('Control+Enter')
  await page.screenshot({ path: 'release/tauri-capture-preview/annotation.png' })
  await page.keyboard.press('Enter')
  const image = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string; payload: { image?: string } }[] }).captureTestActions.find(v => v.action === 'confirm')?.payload.image)
  expect(image).toMatch(/^data:image\/png;base64,/u)
  const dimensions = await page.evaluate(async value => { const image = new Image(); image.src = value ?? ''; await image.decode(); return [image.width, image.height] }, image)
  expect(dimensions).toEqual([840, 420]); expect(failures).toEqual([])
})
test('smart window selection, more tools, drag toolbar, right-click closes', async ({ page }) => {
  await page.mouse.move(200, 200); await page.mouse.click(200, 200)
  await expect(page.locator('.jt-selection-info')).toContainText('1080 × 640')
  await page.getByRole('button', { name: '更多工具' }).click()
  await expect(page.getByRole('button', { name: '扫描二维码 / 条形码' })).toBeVisible()
  await page.getByRole('button', { name: '聚光灯', exact: true }).click()
  await page.keyboard.press('s')
  const grip = page.locator('.jt-grip'), before = await grip.boundingBox(); expect(before).not.toBeNull()
  if (!before) return
  await page.mouse.move(before.x + 6, before.y + 20); await page.mouse.down(); await page.mouse.move(before.x + 96, before.y + 80, { steps: 6 }); await page.mouse.up()
  expect((await grip.boundingBox())?.x).toBeGreaterThan(before.x)
  await page.mouse.click(500, 400, { button: 'right' })
  expect(await page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.some(v => v.action === 'cancel'))).toBe(true)
})
test('record controls remain beside selection and desktop is transparent', async ({ page }) => {
  await page.mouse.move(220, 130); await page.mouse.down(); await page.mouse.move(990, 500); await page.mouse.up()
  await page.getByRole('button', { name: 'GIF / 视频录制' }).click()
  await expect(page.getByRole('toolbar', { name: '录制工具条' })).toBeVisible()
  await expect(page.getByRole('button', { name: '开始录制' })).toBeVisible()
  const alpha = await page.locator('.jt-document').evaluate((element: HTMLCanvasElement) => element.getContext('2d')?.getImageData(400, 300, 1, 1).data[3])
  expect(alpha).toBe(0)
  await page.screenshot({ path: 'release/tauri-capture-preview/recording.png' })
})

test('recording region moves before recording; playback trim, cursor and copy reach export', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message))
  await page.mouse.move(220, 130); await page.mouse.down(); await page.mouse.move(990, 500); await page.mouse.up()
  await page.getByRole('button', { name: 'GIF / 视频录制' }).click()
  const grip = page.getByRole('button', { name: '移动录制区域' }), bounds = await grip.boundingBox(); expect(bounds).not.toBeNull()
  if (!bounds) return
  await page.mouse.move(bounds.x + 10, bounds.y + 10); await page.mouse.down(); await page.mouse.move(bounds.x + 40, bounds.y + 30, { steps: 8 }); await page.mouse.up()
  await page.getByRole('button', { name: '开始录制' }).click(); await expect(grip).toBeDisabled()
  const startAction = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string; payload: { rect: { x: number; y: number } } }[] }).captureTestActions.find(v => v.action === 'record_start'))
  expect(startAction?.payload.rect.x).toBe(250); expect(startAction?.payload.rect.y).toBe(150)
  await page.getByRole('button', { name: '结束录制' }).click(); await expect(page.getByRole('group', { name: '录制回放' })).toBeVisible()
  const start = page.getByRole('slider', { name: '起始帧' }), end = page.getByRole('slider', { name: '结束帧' })
  const startBounds = await start.boundingBox(); if (!startBounds) throw new Error('Missing trim handle')
  await page.mouse.move(startBounds.x + 5, startBounds.y + 10); await page.mouse.down(); await page.mouse.move(startBounds.x + 85, startBounds.y + 10, { steps: 8 }); await page.mouse.up()
  expect(Number(await start.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
  await end.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await expect(end).toHaveAttribute('aria-valuenow', '27')
  await page.getByRole('button', { name: '显示鼠标光标' }).click(); await expect(page.getByRole('button', { name: '显示鼠标光标' })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: '播放速度' }).click(); await page.getByRole('menuitemradio', { name: '1.5x', exact: true }).click()
  await page.screenshot({ path: 'release/tauri-capture-preview/playback.png' })
  await page.getByRole('button', { name: '复制 GIF' }).click(); await expect(page.getByRole('status')).toContainText('已复制 GIF')
  const exported = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string; payload: Record<string, unknown> }[] }).captureTestActions.find(v => v.action === 'export')?.payload)
  expect(exported).toMatchObject({ format: 'gif', copy: true, showCursor: false, speed: 1.5, end: 27, width: 770, height: 370 })
  expect(exported?.start).toBeGreaterThan(0); expect(failures).toEqual([])
})

test('pin thumbnail crops original pixels, restores size, and supports custom right-drag regions', async ({ page }) => {
  await page.goto('/?capture-lab=1&mode=pin'); const picture = page.locator('.jt-pin-image'); await expect(picture).toBeVisible()
  await page.mouse.move(412, 312); await page.keyboard.press('r')
  await expect(picture).toHaveCSS('width', '100px'); await expect(picture).toHaveCSS('height', '100px')
  const document = page.locator('.jt-pin-document'); await expect(document).toHaveCSS('left', '-350px'); await expect(document).toHaveCSS('top', '-250px')
  await page.keyboard.press('r'); await expect(picture).toHaveCSS('width', '1280px')
  await page.mouse.move(212, 212); await page.mouse.down({ button: 'right' }); await page.mouse.move(472, 352, { steps: 8 }); await page.mouse.up({ button: 'right' })
  await expect(picture).toHaveCSS('width', '260px'); await expect(picture).toHaveCSS('height', '140px')
  await expect(page.locator('.jt-pin-menu')).toHaveCount(0)
  await page.keyboard.press('r'); await expect(picture).toHaveCSS('width', '1280px')
  await page.keyboard.press('Space'); await expect(page.getByRole('toolbar', { name: '截图工具条' })).toHaveCount(1)
})

test('original arrow previews and held steppers commit preferences with completion after withdrawal', async ({ page }) => {
  await page.mouse.move(160, 100); await page.mouse.down(); await page.mouse.move(1000, 400); await page.mouse.up()
  await page.getByRole('button', { name: '箭头', exact: true }).click()
  await page.getByRole('combobox', { name: '箭头样式' }).click()
  await expect(page.getByRole('option')).toHaveCount(9)
  await page.getByRole('option', { name: '工字双箭头', exact: true }).click()
  const up = page.getByRole('button', { name: '增加线宽', exact: true }); await up.hover(); await page.mouse.down(); await page.waitForTimeout(450); await page.mouse.up()
  expect(Number(await page.getByRole('spinbutton', { name: '线宽', exact: true }).inputValue())).toBeGreaterThan(10)
  await page.getByRole('button', { name: '圆角', exact: true }).click(); await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { captureTestActions: { action: string }[] }).captureTestActions.some(v => v.action === 'confirm'))).toBe(true)
  const actions = await page.evaluate(() => (window as unknown as { captureTestActions: { action: string; payload: { preferences?: { options: unknown; tools: { arrow?: { width: number; arrow: string } } } } }[] }).captureTestActions)
  const preferences = actions.find(v => v.action === 'confirm')?.payload.preferences
  expect(preferences?.options).toEqual({ screenshot_rounded_enabled: true })
  expect(preferences?.tools.arrow?.arrow).toBe('bar_arrow')
  expect(preferences?.tools.arrow?.width).toBeGreaterThan(10)
  expect(actions.findIndex(v => v.action === 'dismiss')).toBeLessThan(actions.findIndex(v => v.action === 'confirm'))
})

test('native MP4 decodes with correct color, orientation, duration and even-padded dimensions', async ({ page }) => {
  const bytes = await readFile('.task/capture-media/native-odd.mp4')
  await page.route('**/native-codec-fixture.mp4', route => route.fulfill({ contentType: 'video/mp4', body: bytes }))
  const result = await page.evaluate(async () => {
    const video = document.createElement('video'); video.muted = true; video.src = '/native-codec-fixture.mp4'; document.body.append(video)
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error(video.error?.message ?? 'Cannot decode H.264')) })
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight
    const context = c.getContext('2d'); if (!context) throw new Error('Missing canvas'); context.drawImage(video, 0, 0)
    return { width: c.width, height: c.height, duration: video.duration, top: [...context.getImageData(40, 20, 1, 1).data], bottom: [...context.getImageData(40, 100, 1, 1).data] }
  })
  expect([result.width, result.height]).toEqual([162, 122]); expect(result.duration).toBeCloseTo(2, 1)
  expect(result.top[0]).toBeGreaterThan(190); expect(result.top[2]).toBeLessThan(60)
  expect(result.bottom[2]).toBeGreaterThan(190); expect(result.bottom[0]).toBeLessThan(60)
})
