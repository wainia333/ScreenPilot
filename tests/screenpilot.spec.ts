import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

async function expectAccessible(page: Page) {
  const result = await new AxeBuilder({ page }).analyze()
  expect(result.violations).toEqual([])
}

async function waitForVisionSelection(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: { showCount: number } }
  ).__SCREENPILOT_TEST__.showCount)).toBeGreaterThanOrEqual(2)
  await expect(page.locator('main > div.fixed.inset-0.select-none')).toHaveCSS('cursor', 'crosshair')
}

async function expectEdgeSafeFrame(frame: Locator) {
  const style = await frame.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      borderStyle: computed.borderTopStyle,
      borderWidth: computed.borderTopWidth,
      boxShadow: computed.boxShadow,
    }
  })
  expect(style.borderStyle).toBe('solid')
  expect(style.borderWidth).toBe('1px')
  expect(style.boxShadow).toContain('inset')
}

async function expectNeutralSelectFocus(select: Locator) {
  await select.focus()
  const style = await select.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      borderColor: computed.borderTopColor,
      boxShadow: computed.boxShadow,
      outlineStyle: computed.outlineStyle,
    }
  })
  expect(style.outlineStyle).toBe('none')
  expect(style.boxShadow).not.toBe('none')
  expect(`${style.borderColor} ${style.boxShadow}`).not.toMatch(
    /rgb(?:a)?\(\s*(?:177\s*,\s*60\s*,\s*56|185\s*,\s*86\s*,\s*61|223\s*,\s*128\s*,\s*101|239\s*,\s*127\s*,\s*121)/u,
  )
}

test('settings supports seven sections, unsaved close choices and accessible layout', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 620 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '设置分区' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('标准用户身份')
  await expectEdgeSafeFrame(page.locator('.settings-window'))
  await expect(page.locator('.settings-footer').getByRole('button', { name: '保存' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(7)
  await page.getByRole('button', { name: 'OCR', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'OCR', exact: true })).toBeVisible()
  const credentialRows = page.locator('.adapter-credentials > section')
  await expect(credentialRows).toHaveCount(4)
  for (const row of await credentialRows.all()) {
    const button = row.getByRole('button', { name: '保存' })
    const rowBox = await row.boundingBox()
    const buttonBox = await button.boundingBox()
    if (rowBox === null || buttonBox === null) throw new Error('OCR credential row geometry is missing')
    expect(buttonBox.y + buttonBox.height / 2).toBeGreaterThan(rowBox.y + rowBox.height * 0.25)
    expect(buttonBox.y + buttonBox.height / 2).toBeLessThan(rowBox.y + rowBox.height * 0.75)
  }
  await page.getByRole('button', { name: '常规', exact: true }).click()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await page.getByRole('button', { name: '关闭设置' }).click()
  const dialog = page.getByRole('dialog', { name: '保存更改后关闭？' })
  await expect(dialog.getByRole('button', { name: '保存并关闭' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '放弃更改' })).toBeVisible()
  await dialog.getByRole('button', { name: '继续编辑' }).click()
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('settings-dark.png')
})

test('select controls do not show a red focus outline when opened', async ({ page }) => {
  await page.goto('/')
  for (const section of ['常规', '翻译', 'OCR', 'Vision', '提示词优化']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    const selects = page.getByRole('combobox')
    await expect(selects).not.toHaveCount(0)
    for (let index = 0; index < await selects.count(); index += 1) {
      await expectNeutralSelectFocus(selects.nth(index))
    }
  }

  await page.goto('/?route=translator')
  const translatorSelects = page.getByRole('combobox')
  await expect(translatorSelects).toHaveCount(2)
  for (let index = 0; index < await translatorSelects.count(); index += 1) {
    await expectNeutralSelectFocus(translatorSelects.nth(index))
  }
})

test('translator debounces, commits and restores its history', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 400 })
  await page.goto('/?route=translator')
  await expectEdgeSafeFrame(page.locator('.translator-window'))
  const card = page.locator('.translator-window.ocr-result-card.screenpilot-jelly-pop')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-screenpilot-ocr-card', 'true')
  await expect(card.locator('.ocr-result-header')).toBeVisible()
  await expect(card.locator('.ocr-result-body')).toBeVisible()
  await expect(card.locator('.ocr-result-divider')).toBeVisible()
  await expect(card.locator('.translator-divider')).toHaveCount(0)
  await card.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(async (animation) => animation.finished))
  })
  const input = page.getByRole('textbox', { name: '原文' })
  const inputBox = await input.boundingBox()
  expect(inputBox).not.toBeNull()
  if (inputBox === null) throw new Error('Translator input geometry is missing')
  const sourceSection = card.locator('.ocr-result-source')
  const outputSection = card.locator('.ocr-result-output')
  const divider = page.getByRole('separator', { name: '调整原文和译文高度' })
  const initialSourceBox = await sourceSection.boundingBox()
  const initialOutputBox = await outputSection.boundingBox()
  expect(initialSourceBox).not.toBeNull()
  expect(initialOutputBox).not.toBeNull()
  if (initialSourceBox === null || initialOutputBox === null) throw new Error('Translator split geometry is missing')
  const goldenRatio = (1 + Math.sqrt(5)) / 2
  expect(initialOutputBox.height / initialSourceBox.height).toBeCloseTo(goldenRatio, 2)
  const dividerBox = await divider.boundingBox()
  expect(dividerBox).not.toBeNull()
  if (dividerBox === null) throw new Error('Translator divider geometry is missing')
  await divider.hover()
  await page.mouse.down()
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 45, { steps: 4 })
  await page.mouse.up()
  const resizedSourceBox = await sourceSection.boundingBox()
  const resizedOutputBox = await outputSection.boundingBox()
  expect(resizedSourceBox).not.toBeNull()
  expect(resizedOutputBox).not.toBeNull()
  if (resizedSourceBox === null || resizedOutputBox === null) throw new Error('Resized translator split geometry is missing')
  expect(resizedSourceBox.height).toBeGreaterThan(initialSourceBox.height + 20)
  expect(resizedOutputBox.height).toBeLessThan(initialOutputBox.height - 20)
  const savedRatio = await page.evaluate(() => Number(localStorage.getItem('screenpilot:translator-ocr-golden-split')))
  expect(savedRatio).toBeGreaterThan((3 - Math.sqrt(5)) / 2)
  expect(savedRatio).toBeLessThanOrEqual(0.76)
  await input.fill('A concise synthetic translation sample.')
  const output = page.getByRole('textbox', { name: '译文' })
  await expect(output).toHaveValue('译文：A concise synthetic translation sample.', { timeout: 2_000 })
  await output.fill('Edited translation result.')
  await expect(output).toHaveValue('Edited translation result.')
  const targetLanguage = page.getByRole('combobox', { name: '目标语言' })
  await expect(targetLanguage).toHaveValue('auto')
  await targetLanguage.selectOption('ja')
  await expect(targetLanguage).toHaveValue('ja')
  await page.getByRole('button', { name: '翻译历史' }).click()
  await expect(page.getByRole('complementary', { name: '翻译历史' })).toContainText('A concise synthetic translation sample.')
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('translator-result.png')
})

test('prompt optimizer requests only on demand and keeps editable output', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 450 })
  await page.goto('/?route=prompt-optimizer')
  await expectEdgeSafeFrame(page.locator('.optimizer-window'))
  const card = page.locator('.optimizer-window.ocr-result-card.screenpilot-jelly-pop')
  await expect(card).toHaveAttribute('data-screenpilot-ocr-card', 'true')
  await expect(card.locator('.ocr-result-header')).toBeVisible()
  await expect(card.locator('.ocr-result-body')).toBeVisible()
  await expect(card.locator('.ocr-result-divider')).toBeVisible()
  await expect(card.locator('.translator-divider')).toHaveCount(0)
  await card.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(async (animation) => animation.finished))
  })
  const sourceSection = card.locator('.ocr-result-source')
  const outputSection = card.locator('.ocr-result-output')
  const divider = page.getByRole('separator', { name: '调整原始提示词和优化结果高度' })
  const initialSourceBox = await sourceSection.boundingBox()
  const initialOutputBox = await outputSection.boundingBox()
  expect(initialSourceBox).not.toBeNull()
  expect(initialOutputBox).not.toBeNull()
  if (initialSourceBox === null || initialOutputBox === null) throw new Error('Optimizer split geometry is missing')
  expect(initialOutputBox.height / initialSourceBox.height).toBeCloseTo((1 + Math.sqrt(5)) / 2, 2)
  const dividerBox = await divider.boundingBox()
  expect(dividerBox).not.toBeNull()
  if (dividerBox === null) throw new Error('Optimizer divider geometry is missing')
  await divider.hover()
  await page.mouse.down()
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 40, { steps: 4 })
  await page.mouse.up()
  const resizedSourceBox = await sourceSection.boundingBox()
  const resizedOutputBox = await outputSection.boundingBox()
  expect(resizedSourceBox).not.toBeNull()
  expect(resizedOutputBox).not.toBeNull()
  if (resizedSourceBox === null || resizedOutputBox === null) throw new Error('Resized optimizer split geometry is missing')
  expect(resizedSourceBox.height).toBeGreaterThan(initialSourceBox.height + 20)
  expect(resizedOutputBox.height).toBeLessThan(initialOutputBox.height - 20)
  const savedRatio = await page.evaluate(() => Number(localStorage.getItem('screenpilot:optimizer-golden-split-v2')))
  expect(savedRatio).toBeGreaterThan((3 - Math.sqrt(5)) / 2)
  const input = page.getByRole('textbox', { name: '原始提示词' })
  await input.fill('Summarize the supplied material.')
  await expect(page.getByRole('textbox', { name: '优化结果' })).toHaveValue('')
  await page.getByRole('button', { name: '优化', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '优化结果' })).toContainText('明确目标、约束和输出格式')
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('optimizer-result.png')
})

test('vision captures, annotates and answers without stale stream pollution', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)
  await expect(page.getByPlaceholder('问点什么...')).toBeVisible()
  await expectEdgeSafeFrame(page.locator('[data-screenpilot-window-frame="true"]'))
  const promptFrame = await page.getByPlaceholder('问点什么...').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
    }
  })
  expect(promptFrame.outlineStyle).toBe('none')
  expect(promptFrame.boxShadow).toBe('none')
  await page.mouse.move(100, 140)
  await page.mouse.down()
  await page.mouse.move(560, 430, { steps: 8 })
  await expect(page.getByText(/460 x 290/)).toBeVisible()
  await page.mouse.up()
  const readyPromptPanel = page.locator('[data-screenpilot-ready-prompt-panel="true"]').first()
  await expect(readyPromptPanel).toBeVisible()
  const promptBar = page.locator('[data-screenpilot-prompt-bar="true"]').first()
  const promptBox = await promptBar.boundingBox()
  expect(promptBox).not.toBeNull()
  if (promptBox === null) throw new Error('Vision prompt bar geometry is missing')
  await page.mouse.move(promptBox.x + 18, promptBox.y + promptBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(promptBox.x + 76, promptBox.y + promptBox.height / 2 + 16, { steps: 4 })
  await expect.poll(async () => readyPromptPanel.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await page.mouse.up()
  await page.getByTitle('画箭头').click()
  const annotation = page.locator('div[style*="touch-action: none"]')
  const bounds = await annotation.boundingBox()
  expect(bounds).not.toBeNull()
  if (bounds === null) throw new Error('Annotation surface is missing')
  await page.mouse.move(bounds.x + 40, bounds.y + 50)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 180, bounds.y + 130)
  await page.mouse.up()
  await expect(annotation.locator('line')).toHaveCount(1)
  await page.getByPlaceholder('问点什么...').fill('What is visible?')
  await page.locator('button:has(svg.lucide-arrow-up)').click()
  await expect(page.getByText(/synthetic ScreenPilot visual test/)).toBeVisible()
  await page.getByTitle('历史').click()
  await expect(page.getByRole('button', { name: /What is visible/ })).toBeVisible()
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('vision-answer.png')
})

test('screenshot translation keeps editable source and nonblank thumbnail history', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=translate')
  await waitForVisionSelection(page)
  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await expect(page.getByText(/500 x 300/)).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText(/ScreenPilot 视觉测试/)).toBeVisible()
  await expectEdgeSafeFrame(page.locator('[data-screenpilot-window-frame="true"]', { has: page.getByText(/ScreenPilot 视觉测试/) }))
  const targetLanguage = page.getByRole('combobox', { name: '目标语言' })
  await expect(targetLanguage).toHaveValue('auto')
  const screenshotSelects = page.getByRole('combobox')
  await expect(screenshotSelects).toHaveCount(3)
  for (let index = 0; index < await screenshotSelects.count(); index += 1) {
    await expectNeutralSelectFocus(screenshotSelects.nth(index))
  }
  await targetLanguage.selectOption('en')
  await expect(page.getByText(/编辑后译文\(en\)：ScreenPilot Visual Test/)).toBeVisible()
  const languageRequest = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: {
        translationRequests: { text: string; targetLanguage: string }[]
      }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.at(-1)
  })
  expect(languageRequest?.targetLanguage).toBe('en')
  const source = page.locator('.ocr-editable')
  await source.fill('Edited synthetic OCR source')
  await expect(page.getByText('编辑后译文(en)：Edited synthetic OCR source')).toBeVisible({ timeout: 2_000 })
  const thumbnail = page.locator('img[alt="snap"]')
  await expect(thumbnail).toBeVisible()
  const coloredPixels = await thumbnail.evaluate((element) => {
    const image = element as HTMLImageElement
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null) return 0
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] !== pixels[index + 1] || pixels[index + 1] !== pixels[index + 2]) count += 1
    }
    return count
  })
  expect(coloredPixels).toBeGreaterThan(20)
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('screenshot-translation.png')
})

for (const mode of ['chat', 'translate'] as const) {
  test(`${mode} card fills a floating window after native edge resize`, async ({ page }) => {
    await installVisionTauriMock(page, undefined, false)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/?window=vision#vision?mode=${mode}`)
    await waitForVisionSelection(page)
    await page.mouse.move(120, 160)
    await page.mouse.down()
    await page.mouse.move(620, 460, { steps: 8 })
    await page.mouse.up()

    if (mode === 'chat') {
      await page.getByPlaceholder('问点什么...').fill('What is visible?')
      await page.locator('button:has(svg.lucide-arrow-up)').click()
      await expect(page.getByText(/synthetic ScreenPilot visual test/)).toBeVisible()
    } else {
      await expect(page.getByText('ScreenPilot Visual Test')).toBeVisible()
    }

    await expect.poll(async () => page.evaluate(() => (
      window as typeof window & {
        __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
      }
    ).__SCREENPILOT_TEST__.floatingRect)).not.toBeNull()
    const floatingRect = await page.evaluate(() => (
      window as typeof window & {
        __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } }
      }
    ).__SCREENPILOT_TEST__.floatingRect)
    const width = Math.round(floatingRect.width)
    const initialHeight = Math.round(floatingRect.height)
    await page.setViewportSize({ width, height: initialHeight })

    const card = mode === 'chat'
      ? page.locator('[data-screenpilot-floating-answer-card="true"]')
      : page.locator('[data-screenpilot-floating-translate-card="true"]', { has: page.getByText('ScreenPilot Visual Test') })
    await expect(card).toBeVisible()
    const initialBox = await card.boundingBox()
    expect(initialBox).not.toBeNull()

    const resizedHeight = initialHeight + 160
    await page.setViewportSize({ width, height: resizedHeight })
    if (initialBox === null) throw new Error(`${mode} initial resize geometry is missing`)
    await expect.poll(async () => card.evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBe(resizedHeight)
    const resizedBox = await card.boundingBox()
    if (resizedBox === null) throw new Error(`${mode} resized geometry is missing`)
    expect(resizedBox.height).toBeGreaterThan(initialBox.height + 100)
  })
}

test('OCR floating window follows measured text height without viewport resize feedback', async ({ page }) => {
  await installVisionTauriMock(page, 'Short OCR text.', false)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=translate')
  await waitForVisionSelection(page)
  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByText('Short OCR text.')).toBeVisible()

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRect: { height: number } | null }
    }).__SCREENPILOT_TEST__
    return state.floatingRect?.height ?? 0
  })).toBeGreaterThan(96)
  await expect(page.locator('html')).not.toHaveAttribute('data-screenpilot-floating-translate-pending', 'true')
  const initialRect = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } }
  }).__SCREENPILOT_TEST__.floatingRect)
  const initialFloatingSequence = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
  }).__SCREENPILOT_TEST__.floatingRects.slice())
  expect(initialFloatingSequence.length).toBeGreaterThanOrEqual(2)
  const provisionalRect = initialFloatingSequence.at(0)
  if (provisionalRect === undefined) throw new Error('OCR provisional floating geometry is missing')
  expect(provisionalRect.height).toBeLessThanOrEqual(224)
  expect(provisionalRect.height).toBeGreaterThanOrEqual(96)
  await page.setViewportSize({
    width: Math.round(initialRect.width),
    height: Math.round(initialRect.height),
  })
  await expect(page.locator('html')).toHaveAttribute('data-screenpilot-floating-translate-window', 'true')
  await expect(page.locator('[data-screenpilot-window-frame="true"]', { has: page.getByText('Short OCR text.') })).toHaveCSS('opacity', '1')

  const card = page.locator('[data-screenpilot-floating-translate-card="true"]', { has: page.getByText('Short OCR text.') })
  const contentDrivenBox = await card.boundingBox()
  expect(contentDrivenBox).not.toBeNull()
  if (contentDrivenBox === null) throw new Error('OCR card geometry is missing')

  await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }).__SCREENPILOT_TEST__
    state.floatingRects.length = 0
  })
  await page.setViewportSize({ width: Math.round(initialRect.width), height: Math.round(initialRect.height) + 160 })
  await page.waitForTimeout(250)
  await expect(page.locator('html')).toHaveAttribute('data-screenpilot-floating-translate-window', 'true')
  const resizedViewportBox = await card.boundingBox()
  expect(resizedViewportBox).not.toBeNull()
  if (resizedViewportBox === null) throw new Error('Resized OCR card geometry is missing')
  expect(resizedViewportBox.height).toBeGreaterThan(contentDrivenBox.height + 140)
  expect(Math.round(resizedViewportBox.height)).toBe(Math.round(initialRect.height) + 160)
  const resizeFeedbackCount = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
  }).__SCREENPILOT_TEST__.floatingRects.length)
  expect(resizeFeedbackCount).toBeLessThanOrEqual(1)
})

test('long OCR source scrolls independently without pushing translation below the card', async ({ page }) => {
  const longSource = Array.from({ length: 60 }, (_, index) => `OCR line ${String(index + 1)} with enough text to wrap inside the source pane.`).join('\n')
  await installVisionTauriMock(page, longSource)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=translate')
  await waitForVisionSelection(page)
  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByText('OCR line 1 with enough text to wrap inside the source pane.')).toBeVisible()
  const source = page.locator('[data-screenpilot-ocr-source="true"]')
  await expect(source).toBeVisible()
  const geometry = await source.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  const translatedHeading = page.locator('[data-screenpilot-translated-heading="true"]')
  await expect(translatedHeading).toBeVisible()
  const headingBox = await translatedHeading.boundingBox()
  const cardBox = await page.locator('[data-screenpilot-window-frame="true"]', { has: translatedHeading }).boundingBox()
  expect(headingBox).not.toBeNull()
  expect(cardBox).not.toBeNull()
  if (headingBox === null || cardBox === null) throw new Error('Translation card geometry is missing')
  expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height)
})
