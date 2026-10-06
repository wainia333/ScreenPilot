import { expect, test } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

test('global settings errors are concise rounded rectangles with opt-in details and a right-side close', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 620 })
  await installVisionTauriMock(page, undefined, true, undefined, 0, 0, 0, '', false, {}, 'microsoft', 'main')
  await page.goto('/')
  const diagnostic = 'error sending request for url (https://service.invalid/v1)\n    at provider_connect (client.rs:42)\n' + 'diagnostic detail '.repeat(100)
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('button', { name: '常规', exact: true }).click()
    await page.getByRole('radio', { name: theme, exact: true }).click()
    await page.getByRole('button', { name: 'KaraKeep', exact: true }).click()
    await page.getByRole('textbox', { name: 'Karakeep 实例地址' }).fill('https://service.invalid/')
    await page.evaluate(error => { (window as unknown as { __SCREENPILOT_TEST__: { karakeepTestError: string } }).__SCREENPILOT_TEST__.karakeepTestError = error }, diagnostic)
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    const alert = page.getByRole('alert', { name: '连接失败，请检查网络或服务地址', exact: true })
    await expect(alert.locator('.save-success-toast')).toHaveCSS('border-radius', '10px')
    await expect(alert.locator('.top-notice-message')).toHaveText('连接失败，请检查网络或服务地址')
    await expect(alert.locator('pre')).toBeHidden()
    // Measure controls after the entering toast's translate/scale animation.
    // Sequential boundingBox calls during animation otherwise compare frames.
    await alert.locator('.save-success-toast').evaluate(element => { for (const animation of element.getAnimations()) animation.finish() })
    const message = await alert.locator('.top-notice-message').boundingBox(), close = await alert.getByRole('button', { name: '关闭提示' }).boundingBox(), toggle = await alert.getByRole('button', { name: '详情' }).boundingBox(), content = await alert.locator('.top-notice-content').boundingBox()
    if (!message || !close || !toggle || !content) throw new Error('Notification controls must have visible bounds')
    expect(toggle.x).toBeGreaterThanOrEqual(message.x + message.width)
    expect(Math.abs(toggle.y - message.y)).toBeLessThan(4)
    expect(close.x).toBeGreaterThan(toggle.x + toggle.width)
    expect(Math.abs(close.y + close.height / 2 - content.y - content.height / 2)).toBeLessThan(1)
    await page.screenshot({ path: `.task/notice-global-${theme}.png`, animations: 'disabled' })
    await alert.getByText('详情', { exact: true }).click()
    await expect(alert.locator('pre')).toBeVisible()
    await expect(alert.locator('pre')).toHaveText(`Error: ${diagnostic}`)
    const details = await alert.locator('pre').boundingBox()
    if (!details) throw new Error('Expanded notification details must have visible bounds')
    expect(details.height).toBeLessThanOrEqual(160)
    const expandedClose = await alert.getByRole('button', { name: '关闭提示' }).boundingBox(), expandedContent = await alert.locator('.top-notice-content').boundingBox()
    if (!expandedClose || !expandedContent) throw new Error('Expanded close control must be visible')
    expect(Math.abs(expandedClose.y + expandedClose.height / 2 - expandedContent.y - expandedContent.height / 2)).toBeLessThan(1)
    // Reading diagnostics must not race the previous short success-toast timer.
    await page.waitForTimeout(2700)
    await expect(alert).toBeVisible()
    await alert.getByRole('button', { name: '关闭提示' }).click()
    await expect(alert).toHaveCount(0)
  }
})

test('capture diagnostics expand the native hit region while leaving retry and dismissal usable', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/?capture-lab=1&mode=record&fail-export=1')
  await expect(page.locator('.jt-chrome')).toBeVisible()
  await page.mouse.move(160, 150); await page.mouse.down(); await page.mouse.move(1000, 540); await page.mouse.up()
  await page.getByRole('button', { name: '开始录制', exact: true }).click()
  await page.getByRole('button', { name: '结束录制', exact: true }).click()
  await page.getByRole('button', { name: '另存为', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert.locator('.top-notice-message')).toHaveText('导出失败：权限不足，请检查文件或目录权限')
  await expect(alert.locator('.save-success-toast')).toHaveCSS('border-radius', '10px')
  await expect(alert.getByRole('button', { name: '退出截图' })).toBeVisible()
  await expect(alert.locator('pre')).toBeHidden()
  await alert.getByText('详情', { exact: true }).click()
  await expect(alert.locator('pre')).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const box = document.querySelector('.top-notice-details')?.getBoundingClientRect()
    if (!box) return false
    const actions = (window as unknown as { captureTestActions: { action: string; payload: { value?: { surface?: { x: number; y: number; width: number; height: number }[] } } }[] }).captureTestActions
    return actions.filter(a => a.action === 'interaction').at(-1)?.payload.value?.surface?.some(r => r.x <= box.x && r.y <= box.y && r.x + r.width >= box.right && r.y + r.height >= box.bottom)
  })).toBe(true)
  await page.screenshot({ path: '.task/notice-global-capture-details.png', animations: 'disabled' })
  await alert.getByRole('button', { name: '关闭提示' }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.getByRole('group', { name: '录制回放' })).toBeVisible()
})
