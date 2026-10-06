import { expect, test } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

const previewBadge = '[data-screenpilot-browser-preview="true"]'

test('browser preview identifies its demo boundary and rejects native export', async ({ page }) => {
  await page.goto('/?window=main')

  const badge = page.locator(previewBadge)
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('浏览器预览')
  await expect(badge).toContainText('Demo')
  await expect(badge).toHaveCSS('pointer-events', 'none')

  await expect(page.getByRole('button', { name: '关于' })).toBeVisible()
  await page.getByRole('button', { name: '关于' }).click()
  await page.getByRole('button', { name: '导出配置' }).click()
  await expect(page.getByRole('alert')).toContainText('浏览器预览不支持')
})

test('a Tauri runtime does not render the browser preview badge', async ({ page }) => {
  await installVisionTauriMock(page, undefined, true, undefined, 0, 0, 0, '', false, {}, 'microsoft', 'main')
  await page.goto('/?window=main')

  await expect(page.locator(previewBadge)).toHaveCount(0)
})
