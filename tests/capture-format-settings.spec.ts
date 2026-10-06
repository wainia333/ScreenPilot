import { expect, test } from '@playwright/test'

test('format help uses approved copy, fits both themes, supports keyboard and explains conditional quality', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 760 }); await page.goto('/')
  await page.getByRole('button', { name: '截图', exact: true }).click(); await page.getByRole('tab', { name: '保存', exact: true }).click()
  const format = page.getByRole('combobox', { name: '图片格式', exact: true }), help = page.getByRole('button', { name: '图片格式说明', exact: true })
  const expected = [
    'PNG｜无损，完整保留截图像素，支持透明背景。适合文字、软件界面和标注截图，兼容性好。',
    'JPG｜有损，不支持透明背景。适合照片或更注重文件大小的截图。质量 0–100：数值越高，画质通常越好、文件越大。',
    'BMP｜无损，完整保留截图像素。压缩较少，文件通常较大，适合需要位图文件的场景。',
    'WEBP｜当前为无损编码，支持透明背景。文件可能比 PNG 更小，部分旧软件不支持。',
    'PDF｜无损，将截图按原始分辨率放入单页 PDF，适合分享和打印。',
  ]
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
    await help.hover()
    const popup = page.getByRole('tooltip'); await expect(popup).toBeVisible(); await expect(popup.locator('p')).toHaveText(expected)
    const box = await popup.boundingBox(); expect(box).not.toBeNull()
    expect(box?.x).toBeGreaterThanOrEqual(12); expect(box && box.x + box.width).toBeLessThanOrEqual(888)
    expect(box?.y).toBeGreaterThanOrEqual(12); expect(box && box.y + box.height).toBeLessThanOrEqual(748)
    await popup.hover(); await expect(popup).toBeVisible()
    await page.screenshot({ path: `.task/capture-format-help-${theme}.png` })
    await page.mouse.move(5, 5); await expect(popup).toHaveCount(0)
  }
  await help.focus(); await expect(page.getByRole('tooltip')).toBeVisible()
  await expect(help).toHaveAttribute('aria-describedby', await page.getByRole('tooltip').getAttribute('id') ?? '')
  await page.keyboard.press('Escape'); await expect(page.getByRole('tooltip')).toHaveCount(0); await expect(help).toBeFocused()
  await format.focus(); await format.selectOption('PNG'); await expect(page.getByRole('spinbutton', { name: '有损格式质量', exact: true })).toHaveCount(0)
  await format.selectOption('JPG')
  const quality = page.getByRole('spinbutton', { name: '有损格式质量', exact: true })
  await expect(quality).toHaveValue('100'); await expect(quality).toHaveAttribute('min', '0'); await expect(quality).toHaveAttribute('max', '100')
  expect(await quality.evaluate(element => element.closest('.setting-row')?.classList.contains('setting-row--nested'))).toBe(true)
  expect(await quality.evaluate(element => element.closest('.setting-row')?.previousElementSibling?.querySelector('select[aria-label="图片格式"]') instanceof HTMLSelectElement)).toBe(true)
  expect((await quality.boundingBox())?.width).toBe((await format.boundingBox())?.width)
  await quality.fill('0'); await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status', { name: '设置已保存并立即生效', exact: true })).toContainText('保存')
  await page.getByRole('button', { name: '常规', exact: true }).click(); await page.getByRole('button', { name: '截图', exact: true }).click(); await page.getByRole('tab', { name: '保存', exact: true }).click()
  await expect(quality).toHaveValue('0')
  for (const value of ['PDF', 'WEBP', 'BMP', 'PNG']) { await format.selectOption(value); await expect(quality).toHaveCount(0) }
  await format.selectOption('JPG'); await expect(quality).toHaveValue('0')
  await page.setViewportSize({ width: 640, height: 560 }); await help.hover(); await expect(page.getByRole('tooltip')).toBeVisible()
  const box = await page.getByRole('tooltip').boundingBox()
  expect(box && box.x + box.width).toBeLessThanOrEqual(628); expect(box && box.y + box.height).toBeLessThanOrEqual(548)
})
