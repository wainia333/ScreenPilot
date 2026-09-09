import { expect, test, type Page } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

const screenshotSelector = '[data-screenpilot-message-screenshot="true"]'
const thumbnailSelector = '[data-screenpilot-screenshot-preview="true"]'
const defaultIconSelector = 'img[src="/emojione--leaf-fluttering-in-wind.svg"]'

async function waitForSelection(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: { showCount: number } }
  ).__SCREENPILOT_TEST__.showCount)).toBeGreaterThanOrEqual(1)
  await expect(page.locator('[data-screenpilot-vision-root="true"]')).toHaveCSS('cursor', 'crosshair')
}

for (const messageOrder of ['asc', 'desc'] as const) {
  test('Vision moves the capture above its first question in ' + messageOrder + ' order', async ({ page }, testInfo) => {
    await installVisionTauriMock(page, undefined, messageOrder === 'asc', undefined, 1000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/?window=vision&visionMessageOrder=' + messageOrder + '#vision?mode=chat')
    await waitForSelection(page)
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+Enter')

    const promptBar = page.locator('[data-screenpilot-prompt-bar="true"]')
    const thumbnail = promptBar.locator(thumbnailSelector)
    await expect(thumbnail).toBeVisible()
    await expect(promptBar.getByText('Synthetic', { exact: true })).toBeVisible()
    const screenshotSource = await thumbnail.getAttribute('src')
    if (screenshotSource === null) throw new Error('Captured image source is missing')
    const imageId = await page.evaluate(() => (
      window as typeof window & { __SCREENPILOT_TEST__: { temporaryImageIds: string[] } }
    ).__SCREENPILOT_TEST__.temporaryImageIds.at(-1))
    expect(imageId).toBeTruthy()

    const prompt = page.locator('[data-screenpilot-vision-prompt="true"]')
    const question = 'Explain the captured window.'
    await prompt.fill(question)
    await prompt.press('Enter')

    const log = page.getByRole('log')
    const firstQuestion = log.locator('[data-screenpilot-message-shell="true"][data-screenpilot-message-index="0"]')
    const screenshot = firstQuestion.locator(screenshotSelector)
    await expect(log).toHaveAttribute('aria-busy', 'true')
    await expect(screenshot).toBeVisible()
    await expect(screenshot).toHaveAttribute('src', screenshotSource)
    await expect(screenshot).toHaveAttribute('alt', '截图预览')
    await expect(thumbnail).toHaveCount(0)
    await expect(promptBar.getByText('Synthetic', { exact: true })).toHaveCount(0)
    await expect(promptBar.locator(defaultIconSelector)).toBeVisible()
    await expect(log.locator('[data-screenpilot-message-shell="true"]').first()).toHaveAttribute(
      'data-screenpilot-message-index', messageOrder === 'asc' ? '0' : '1',
    )
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __SCREENPILOT_TEST__: { activeVisionImageId: string } }
    ).__SCREENPILOT_TEST__.activeVisionImageId)).toBe(imageId)

    await screenshot.scrollIntoViewIfNeeded()
    const screenshotBounds = await screenshot.boundingBox()
    const questionBounds = await firstQuestion.getByText(question, { exact: true }).boundingBox()
    if (screenshotBounds === null || questionBounds === null) throw new Error('Screenshot message geometry is missing')
    expect(screenshotBounds.y + screenshotBounds.height).toBeLessThanOrEqual(questionBounds.y)
    expect(questionBounds.y - screenshotBounds.y - screenshotBounds.height).toBeLessThanOrEqual(9)
    expect(Math.abs(screenshotBounds.x + screenshotBounds.width - questionBounds.x - questionBounds.width)).toBeLessThanOrEqual(1)
    expect(screenshotBounds.height).toBeLessThanOrEqual(192)

    await expect(log).toHaveAttribute('aria-busy', 'false')
    await firstQuestion.screenshot({
      path: testInfo.outputPath('capture-question.png'),
      animations: 'disabled',
    })
    await prompt.fill('What else do you notice?')
    await prompt.press('Enter')
    const followUp = log.locator('[data-screenpilot-message-shell="true"][data-screenpilot-message-index="2"]')
    await expect(followUp).toContainText('What else do you notice?')
    await expect(log.locator(screenshotSelector)).toHaveCount(1)
    await expect(screenshot).toHaveAttribute('src', screenshotSource)
    await expect(followUp.locator(screenshotSelector)).toHaveCount(0)
    await expect(log).toHaveAttribute('aria-busy', 'false')
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __SCREENPILOT_TEST__: { activeVisionImageId: string } }
    ).__SCREENPILOT_TEST__.activeVisionImageId)).toBe(imageId)

    await firstQuestion.hover()
    await firstQuestion.locator('[data-screenpilot-message-action="edit"]').click()
    await expect(screenshot).toBeVisible()
    await firstQuestion.getByRole('textbox').fill('Explain the captured window in detail.')
    await firstQuestion.locator('[data-screenpilot-message-editor-action="save"]').click()
    const historyTrigger = page.locator('[data-screenpilot-vision-history-trigger="true"]')
    await expect(historyTrigger).toContainText('1')

    await page.reload()
    await waitForSelection(page)
    await historyTrigger.click()
    await page.locator('[data-screenpilot-vision-history-dialog="true"]')
      .getByRole('button', { name: /Explain the captured window in detail/u }).click()
    await expect(firstQuestion).toContainText('Explain the captured window in detail.')
    await expect(screenshot).toHaveAttribute('src', screenshotSource)
    await expect(log.locator(screenshotSelector)).toHaveCount(1)
    await expect(thumbnail).toHaveCount(0)
    await expect(promptBar.locator(defaultIconSelector)).toBeVisible()

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('vision:reset')))
    await expect(log).toHaveCount(0)
    await waitForSelection(page)
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+Enter')
    await expect(thumbnail).toBeVisible()
    await expect(promptBar.locator(defaultIconSelector)).toHaveCount(0)
    await expect(page.locator(screenshotSelector)).toHaveCount(0)
  })
}

test('Vision moves the screenshot when sending the default image-analysis question', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForSelection(page)
  await page.keyboard.press('Alt+r')
  await page.keyboard.press('Alt+Enter')
  const promptBar = page.locator('[data-screenpilot-prompt-bar="true"]')
  await expect(promptBar.locator(thumbnailSelector)).toBeVisible()
  await page.locator('[data-screenpilot-vision-send="true"]').click()
  const firstQuestion = page.getByRole('log').locator('[data-screenpilot-message-shell="true"][data-screenpilot-message-index="0"]')
  await expect(firstQuestion).toContainText('请分析这张截图。')
  await expect(firstQuestion.locator(screenshotSelector)).toBeVisible()
  await expect(promptBar.locator(thumbnailSelector)).toHaveCount(0)
  await expect(promptBar.locator(defaultIconSelector)).toBeVisible()
})

test('Vision keeps text-only conversations free of screenshot previews', async ({ page }) => {
  await installVisionTauriMock(page, undefined, false)
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForSelection(page)
  const prompt = page.locator('[data-screenpilot-vision-prompt="true"]')
  await prompt.fill('Answer without a screenshot.')
  await prompt.press('Enter')
  await expect(page.getByRole('log')).toContainText('Answer without a screenshot.')
  await expect(page.getByRole('log')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator(screenshotSelector)).toHaveCount(0)
  const promptBar = page.locator('[data-screenpilot-prompt-bar="true"]')
  await expect(promptBar.locator(thumbnailSelector)).toHaveCount(0)
  await expect(promptBar.locator(defaultIconSelector)).toBeVisible()
  expect(await page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: { activeVisionImageId: string } }
  ).__SCREENPILOT_TEST__.activeVisionImageId)).toBe('')
})
