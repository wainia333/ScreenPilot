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
    const bounds = element.getBoundingClientRect()
    const clippingAncestors: { element: string; containsSelect: boolean }[] = []
    let ancestor = element.parentElement
    while (ancestor !== null) {
      const ancestorStyle = getComputedStyle(ancestor)
      const isViewportRoot = ancestor === document.body || ancestor === document.documentElement || ancestor.id === 'root'
      if (!isViewportRoot && [ancestorStyle.overflowX, ancestorStyle.overflowY].some((value) => (
        value === 'auto' || value === 'clip' || value === 'hidden' || value === 'scroll'
      ))) {
        const ancestorBounds = ancestor.getBoundingClientRect()
        clippingAncestors.push({
          element: ancestor.className,
          containsSelect: bounds.left >= ancestorBounds.left - 0.5
            && bounds.top >= ancestorBounds.top - 0.5
            && bounds.right <= ancestorBounds.right + 0.5
            && bounds.bottom <= ancestorBounds.bottom + 0.5,
        })
      }
      ancestor = ancestor.parentElement
    }
    return {
      borderColor: computed.borderTopColor,
      boxShadow: computed.boxShadow,
      outlineStyle: computed.outlineStyle,
      clippingAncestors,
    }
  })
  expect(style.outlineStyle).toBe('none')
  expect(style.boxShadow).toContain('1px inset')
  expect(style.clippingAncestors.every((ancestor) => ancestor.containsSelect), JSON.stringify(style.clippingAncestors)).toBe(true)
  expect(`${style.borderColor} ${style.boxShadow}`).not.toMatch(
    /rgb(?:a)?\(\s*(?:177\s*,\s*60\s*,\s*56|185\s*,\s*86\s*,\s*61|223\s*,\s*128\s*,\s*101|239\s*,\s*127\s*,\s*121)/u,
  )
}

async function settingsNavigationIndicator(button: Locator) {
  return button.evaluate((element) => {
    const computed = getComputedStyle(element, '::after')
    const buttonComputed = getComputedStyle(element)
    const accentProbe = document.createElement('span')
    accentProbe.style.color = 'var(--sp-accent)'
    document.body.append(accentProbe)
    const accentColor = getComputedStyle(accentProbe).color
    accentProbe.remove()
    const matrix = computed.transform === 'none'
      ? new DOMMatrixReadOnly()
      : new DOMMatrixReadOnly(computed.transform)
    const bounds = element.getBoundingClientRect()
    const icon = element.querySelector('svg')
    const iconBounds = icon?.getBoundingClientRect()
    return {
      accentColor,
      backgroundColor: computed.backgroundColor,
      buttonHeight: bounds.height,
      buttonWidth: bounds.width,
      content: computed.content,
      height: Number.parseFloat(computed.height),
      iconLeft: iconBounds === undefined ? Number.POSITIVE_INFINITY : iconBounds.left - bounds.left,
      labelLeft: (() => {
        const label = element.querySelector('span')
        const labelBounds = label?.getBoundingClientRect()
        return labelBounds === undefined ? Number.POSITIVE_INFINITY : labelBounds.left - bounds.left
      })(),
      left: Number.parseFloat(computed.left),
      opacity: Number(computed.opacity),
      paddingLeft: Number.parseFloat(buttonComputed.paddingLeft),
      top: Number.parseFloat(computed.top),
      translateX: matrix.e,
      scaleY: matrix.d,
      animationDuration: computed.animationDuration,
      animationName: computed.animationName,
      animationTimingFunction: computed.animationTimingFunction,
      transformOriginX: Number.parseFloat(computed.transformOrigin),
      transformOriginY: Number.parseFloat(computed.transformOrigin.split(' ')[1] ?? '0'),
      width: Number.parseFloat(computed.width),
    }
  })
}

async function settingsNavigationKeyframes(page: Page) {
  return page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        continue
      }
      for (const rule of Array.from(rules)) {
        if (!('name' in rule) || !('cssRules' in rule)) continue
        const keyframes = rule as CSSKeyframesRule
        if (keyframes.name !== 'screenpilot-settings-sidebar-indicator-pop') continue
        return Array.from(keyframes.cssRules).map((frame) => {
          const keyframe = frame as CSSKeyframeRule
          return {
            left: keyframe.style.left,
            offset: keyframe.keyText,
            opacity: keyframe.style.opacity,
            transform: keyframe.style.transform,
          }
        })
      }
    }
    return []
  })
}

test('settings supports seven sections, unsaved close choices and accessible layout', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 620 })
  await page.goto('/')
  await expect(page.getByRole('navigation', { name: '设置分区' })).toBeVisible()
  const permissionStatus = page.getByRole('status', { name: '当前运行权限' })
  await expect(permissionStatus).toHaveText('权限：普通用户')
  await expect(permissionStatus.locator('xpath=following-sibling::*[1]')).toContainText('所有更改已保存')
  const permissionDot = permissionStatus.locator('span')
  const savedDot = page.locator('.settings-save-state span')
  await expect(permissionStatus).toHaveCSS('font-size', '11px')
  await expect(permissionDot).toHaveCSS('background-color', 'rgb(154, 107, 32)')
  await expect(savedDot).toHaveCSS('background-color', 'rgb(52, 118, 86)')
  await expectEdgeSafeFrame(page.locator('.settings-window'))
  await expect(page.locator('.settings-footer').getByRole('button', { name: '保存' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(7)
  const settingsFooter = page.locator('.settings-footer')
  const cancelSettings = settingsFooter.getByRole('button', { name: '取消' })
  await expect(cancelSettings).toBeVisible()
  await expect(cancelSettings).toBeDisabled()
  await page.getByRole('button', { name: 'OCR', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'OCR', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'OCR 接口' })).toHaveValue('chaoxing')
  await expect(page.getByRole('combobox', { name: 'OCR 模型' })).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'AI 视觉 OCR' })).toHaveCount(0)
  await page.getByRole('switch', { name: '开启大模型 OCR' }).click()
  await expect(page.getByRole('combobox', { name: 'OCR 模型' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'AI 视觉 OCR' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: '截图翻译接口' })).toHaveValue('microsoft')
  await expect(page.getByRole('combobox', { name: '截图翻译模型' })).toHaveCount(0)
  await page.getByRole('switch', { name: '开启大模型翻译' }).click()
  await expect(page.getByRole('combobox', { name: '截图翻译模型' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'AI', exact: true })).toHaveCount(0)
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
  await page.getByRole('button', { name: '翻译', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '翻译接口' })).toHaveValue('microsoft')
  await expect(page.getByRole('combobox', { name: '文本翻译 AI 模型' })).toHaveCount(0)
  await page.getByRole('switch', { name: '开启大模型翻译' }).click()
  await expect(page.getByRole('combobox', { name: '文本翻译 AI 模型' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'AI', exact: true })).toHaveCount(0)
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

test('settings cancel restores the loaded draft without closing the page', async ({ page }) => {
  await page.goto('/')
  const footer = page.locator('.settings-footer')
  const cancel = footer.getByRole('button', { name: '取消' })
  await expect(cancel).toBeDisabled()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await expect(cancel).toBeEnabled()
  await cancel.click()
  await expect(page.getByRole('radio', { name: '系统', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.settings-save-state')).toHaveAttribute('data-dirty', 'false')
  await expect(cancel).toBeDisabled()
  await expect(page.getByRole('heading', { name: '常规', exact: true })).toBeVisible()
})

test('settings footer actions keep matching dimensions across disabled and enabled states', async ({ page }) => {
  await page.goto('/')
  const footer = page.locator('.settings-footer')
  const cancel = footer.getByRole('button', { name: '取消' })
  const measure = async () => footer.evaluate((element) => {
    const [cancelElement, saveElement] = Array.from(element.querySelectorAll('button'))
    if (cancelElement === undefined || saveElement === undefined) throw new Error('settings footer buttons missing')
    const read = (button: HTMLButtonElement) => {
      const computed = getComputedStyle(button)
      const bounds = button.getBoundingClientRect()
      return {
        width: bounds.width,
        height: bounds.height,
        minWidth: computed.minWidth,
        paddingTop: computed.paddingTop,
        paddingRight: computed.paddingRight,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        fontSize: computed.fontSize,
      }
    }
    return { cancel: read(cancelElement), save: read(saveElement) }
  })
  const disabled = await measure()
  expect(disabled.cancel).toEqual(disabled.save)
  await expect(cancel).toBeDisabled()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await expect(cancel).toBeEnabled()
  const enabled = await measure()
  expect(enabled.cancel).toEqual(enabled.save)
  expect(enabled.cancel).toEqual(disabled.cancel)
})

test('settings cancel hover preserves disabled colors and changes only when enabled', async ({ page }) => {
  await page.goto('/')
  const footer = page.locator('.settings-footer')
  const cancel = footer.getByRole('button', { name: '取消' })
  const save = footer.getByRole('button', { name: '保存' })
  const readStyle = async (button: Locator) => button.evaluate((element) => {
    const computed = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return {
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderTopColor,
      color: computed.color,
      cursor: computed.cursor,
      opacity: computed.opacity,
      width: bounds.width,
      height: bounds.height,
    }
  })
  const assertDisabledHover = async () => {
    await expect(cancel).toBeDisabled()
    const before = await readStyle(cancel)
    await cancel.hover()
    const after = await readStyle(cancel)
    expect(after).toEqual(before)
    expect(after.cursor).toBe('not-allowed')
    const saveStyle = await readStyle(save)
    expect({ width: after.width, height: after.height }).toEqual({ width: saveStyle.width, height: saveStyle.height })
  }

  await assertDisabledHover()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await save.click()
  await assertDisabledHover()

  await page.getByRole('switch', { name: '自动上屏' }).click()
  await expect(cancel).toBeEnabled()
  const darkEnabledBefore = await readStyle(cancel)
  await cancel.hover()
  const darkEnabledAfter = await readStyle(cancel)
  expect(darkEnabledAfter.backgroundColor).not.toBe(darkEnabledBefore.backgroundColor)
  expect(darkEnabledAfter.width).toBe(darkEnabledBefore.width)
  expect(darkEnabledAfter.height).toBe(darkEnabledBefore.height)

  await page.getByRole('radio', { name: '系统', exact: true }).click()
  await expect(cancel).toBeEnabled()
  const enabledBefore = await readStyle(cancel)
  await cancel.hover()
  const enabledAfter = await readStyle(cancel)
  expect(enabledAfter.width).toBe(enabledBefore.width)
  expect(enabledAfter.height).toBe(enabledBefore.height)
  expect(enabledAfter.backgroundColor).not.toBe(enabledBefore.backgroundColor)
})

test('provider key drafts use the global footer save and cancel actions', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '模型提供商', exact: true }).click()
  const footer = page.locator('.settings-footer')
  const save = footer.getByRole('button', { name: '保存' })
  const cancel = footer.getByRole('button', { name: '取消' })
  await expect(page.getByRole('button', { name: /保存密钥|保存秘钥/u })).toHaveCount(0)
  await page.getByRole('button', { name: '新增' }).click()
  const firstKeys = page.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
  await firstKeys.fill('browser-secret')
  await expect(save).toBeEnabled()
  await expect(cancel).toBeEnabled()
  await cancel.click()
  await expect(page.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })).toHaveCount(0)
  await expect(save).toBeDisabled()

  await page.getByRole('button', { name: '新增' }).click()
  const keys = page.getByRole('textbox', { name: 'OpenAI Compatible API Keys' })
  await keys.fill('browser-secret-one')
  await save.click()
  await expect(save).toBeDisabled()
  await expect(page.locator('.settings-save-state')).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByText('设置已保存并立即生效')).toBeVisible()
  await keys.fill('browser-secret-two')
  await save.click()
  await expect(save).toBeDisabled()
  await expect(page.locator('.settings-save-state')).toHaveAttribute('data-dirty', 'false')
  await keys.fill('browser-secret-discarded')
  await cancel.click()
  await expect(keys).toHaveValue('')
  await expect(save).toBeDisabled()
  expect(pageErrors).toEqual([])
})

test('prompt reset controls stay beside original titles without overlap', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 620 })
  await page.goto('/')
  const expectedPromptGroups = { 翻译: 1, OCR: 2, Vision: 2, 提示词优化: 2 }
  for (const [section, expectedCount] of Object.entries(expectedPromptGroups)) {
    await page.getByRole('button', { name: section, exact: true }).click()
    const groups = page.locator('.setting-group:has(textarea.prompt-field)')
    await expect(groups).toHaveCount(expectedCount)
    for (const group of await groups.all()) {
      const geometry = await group.evaluate((element) => {
        const box = (candidate: Element | null) => {
          if (candidate === null) return undefined
          const rect = candidate.getBoundingClientRect()
          return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top }
        }
        const textarea = element.querySelector('textarea.prompt-field')
        const heading = element.querySelector('.setting-group__heading')
        const title = heading?.querySelector('h2') ?? null
        const reset = heading?.querySelector('.prompt-reset-button') ?? null
        return {
          shell: box(element),
          heading: box(heading),
          title: box(title),
          reset: box(reset),
          textarea: box(textarea),
          promptShells: element.querySelectorAll('.prompt-field-shell').length,
          promptLabels: element.querySelectorAll('.prompt-field-label').length,
          minHeight: textarea === null ? '' : getComputedStyle(textarea).minHeight,
          height: textarea === null ? 0 : textarea.getBoundingClientRect().height,
          textareaScrollWidth: textarea === null ? 0 : textarea.scrollWidth,
          textareaClientWidth: textarea === null ? 0 : textarea.clientWidth,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }
      })
      if (geometry.shell === undefined || geometry.heading === undefined || geometry.title === undefined || geometry.reset === undefined || geometry.textarea === undefined) {
        throw new Error('prompt field geometry is missing')
      }
      expect(geometry.promptShells).toBe(0)
      expect(geometry.promptLabels).toBe(0)
      expect(geometry.title.right).toBeLessThanOrEqual(geometry.reset.left + 0.5)
      expect(geometry.reset.left).toBeGreaterThanOrEqual(geometry.heading.left)
      expect(geometry.reset.right).toBeLessThanOrEqual(geometry.heading.right + 0.5)
      expect(geometry.textarea.top).toBeGreaterThanOrEqual(geometry.heading.bottom - 0.5)
      expect(geometry.textarea.left).toBeGreaterThanOrEqual(geometry.shell.left)
      expect(geometry.textarea.right).toBeLessThanOrEqual(geometry.shell.right + 0.5)
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
      expect(geometry.textareaScrollWidth).toBeLessThanOrEqual(geometry.textareaClientWidth + 1)
      expect(geometry.minHeight).toBe('150px')
      expect(geometry.height).toBe(150)
    }
  }
})

test('settings navigation indicator pops in from the left as a contained solid arc', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: '设置分区' })
  const general = navigation.getByRole('button', { name: '常规', exact: true })
  const translation = navigation.getByRole('button', { name: '翻译', exact: true })
  const inactive = await settingsNavigationIndicator(translation)
  expect(inactive.content).toBe('""')
  expect(inactive.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(inactive.backgroundColor).not.toBe(inactive.accentColor)
  expect(inactive.paddingLeft).toBe(16)
  expect(inactive.iconLeft).toBeGreaterThanOrEqual(16)
  expect(inactive.labelLeft - inactive.iconLeft).toBeGreaterThanOrEqual(25)
  expect(inactive.height).toBeGreaterThanOrEqual(14)
  expect(inactive.height).toBeLessThanOrEqual(20)
  expect(inactive.width).toBe(4)
  expect(inactive.opacity).toBe(0)
  expect(inactive.animationName).toBe('none')
  expect(inactive.left).toBe(4)
  expect(inactive.translateX).toBe(0)
  expect(inactive.scaleY).toBeLessThan(1)
  expect(inactive.left).toBeGreaterThanOrEqual(0)
  expect(inactive.top).toBeGreaterThanOrEqual(0)
  expect(inactive.left + inactive.width).toBeLessThanOrEqual(inactive.iconLeft - 1)
  expect(inactive.width).toBeLessThan(inactive.buttonWidth)
  expect(inactive.top + inactive.height).toBeLessThanOrEqual(inactive.buttonHeight)
  expect(inactive.transformOriginX).toBeCloseTo(inactive.width / 2, 1)
  expect(inactive.transformOriginY).toBeCloseTo(inactive.height / 2, 1)
  const keyframes = await settingsNavigationKeyframes(page)
  expect(keyframes).toHaveLength(4)
  expect(keyframes.find((frame) => frame.offset === '42%')?.left).toBe('7px')
  expect(keyframes.find((frame) => frame.offset === '100%')?.left).toBe('4px')
  expect(keyframes.map((frame) => frame.transform)).toEqual(expect.arrayContaining(['scaleY(0.76)', 'scaleY(1.06)', 'scaleY(0.98)', 'scaleY(1)']))
  await translation.click()
  await expect(translation).toHaveAttribute('aria-current', 'page')
  await expect(general).not.toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await settingsNavigationIndicator(translation)).opacity).toBe(1)
  await expect.poll(async () => (await settingsNavigationIndicator(translation)).scaleY).toBe(1)
  await expect.poll(async () => (await settingsNavigationIndicator(translation)).translateX).toBe(0)
  const active = await settingsNavigationIndicator(translation)
  expect(active.animationName).toBe('screenpilot-settings-sidebar-indicator-pop')
  expect(active.left).toBe(4)
  expect(active.left + active.width).toBeLessThanOrEqual(active.iconLeft - 4)
  expect(7 + active.width).toBeLessThanOrEqual(active.iconLeft - 4)
  expect(active.left + active.width).toBeLessThanOrEqual(active.buttonWidth)
  expect(7 + active.width).toBeLessThanOrEqual(active.buttonWidth)
  expect(active.buttonWidth).toBe(inactive.buttonWidth)
  await expect.poll(async () => (await settingsNavigationIndicator(general)).opacity).toBe(0)
  await expect.poll(async () => (await settingsNavigationIndicator(general)).left).toBe(4)
})

test('settings navigation indicator shortens motion when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const translation = page.getByRole('navigation', { name: '设置分区' }).getByRole('button', { name: '翻译', exact: true })
  const reduced = await settingsNavigationIndicator(translation)
  expect(Number.parseFloat(reduced.animationDuration)).toBeLessThan(0.001)
  await translation.click()
  await expect.poll(async () => (await settingsNavigationIndicator(translation)).opacity).toBe(1)
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

test('Vision markdown links open externally without navigating the app webview', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)
  await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { answerText: string }
    }).__SCREENPILOT_TEST__
    state.answerText = '请查看 [**外部文档**](https://example.com/vision?source=screenpilot#answer)。'
  })
  await page.mouse.move(100, 140)
  await page.mouse.down()
  await page.mouse.move(560, 430, { steps: 8 })
  await page.mouse.up()
  await page.getByPlaceholder('问点什么...').fill('Provide a link.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()
  const link = page.getByRole('link', { name: '外部文档' })
  await expect(link).toBeVisible()
  const before = page.url()
  await link.click()
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { externalUrls: string[] }
    }).__SCREENPILOT_TEST__
    return state.externalUrls
  })).toEqual(['https://example.com/vision?source=screenpilot#answer'])
  expect(page.url()).toBe(before)
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
  const targetLanguageLabel = page.getByText('目标语言', { exact: true })
  const translationEngine = page.locator('select[data-screenpilot-translation-method="true"]')
  await expect(targetLanguageLabel).toBeVisible()
  await expect(translationEngine).toBeVisible()
  const translatedHeading = page.locator('[data-screenpilot-translated-heading="true"]')
  const geometry = await translatedHeading.evaluate((heading) => {
    const label = heading.querySelector('.screenpilot-target-language-control label')
    const language = heading.querySelector('#screenpilot-target-language')
    const engine = heading.querySelector('select[data-screenpilot-translation-method="true"]')
    if (!(label instanceof HTMLElement) || !(language instanceof HTMLElement) || !(engine instanceof HTMLElement)) return null
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }
    return {
      translatedHeadingBox: rect(heading),
      targetLanguageLabelBox: rect(label),
      targetLanguageBox: rect(language),
      translationEngineBox: rect(engine),
    }
  })
  expect(geometry).not.toBeNull()
  if (geometry === null) throw new Error('OCR translation controls geometry is missing')
  const { translatedHeadingBox, targetLanguageLabelBox, targetLanguageBox, translationEngineBox } = geometry
  const centerY = (box: { y: number; height: number }) => box.y + box.height / 2
  expect(Math.abs(centerY(targetLanguageLabelBox) - centerY(targetLanguageBox))).toBeLessThanOrEqual(1)
  expect(Math.abs(centerY(targetLanguageBox) - centerY(translationEngineBox))).toBeLessThanOrEqual(1)
  expect(targetLanguageLabelBox.x).toBeGreaterThan(translatedHeadingBox.x + translatedHeadingBox.width * 0.25)
  expect(targetLanguageBox.x).toBeGreaterThan(targetLanguageLabelBox.x + targetLanguageLabelBox.width)
  expect(translationEngineBox.x).toBeGreaterThan(targetLanguageBox.x + targetLanguageBox.width)
  expect(Math.abs(translatedHeadingBox.x + translatedHeadingBox.width - translationEngineBox.x - translationEngineBox.width)).toBeLessThanOrEqual(1)
  expect(targetLanguageBox.width).toBeCloseTo(translationEngineBox.width, 0)
  expect(targetLanguageBox.height).toBeCloseTo(translationEngineBox.height, 0)
  const screenshotSelects = page.getByRole('combobox')
  await expect(screenshotSelects).toHaveCount(3)
  for (let index = 0; index < await screenshotSelects.count(); index += 1) {
    const select = screenshotSelects.nth(index)
    const style = await select.evaluate((element) => {
      const computed = getComputedStyle(element)
      const bounds = element.getBoundingClientRect()
      return {
        fontSize: computed.fontSize,
        width: bounds.width,
        height: bounds.height,
      }
    })
    expect(style.fontSize).toBe('11.5px')
    expect(style.width).toBeCloseTo(100, 0)
    expect(style.height).toBeCloseTo(24, 0)
    await expectNeutralSelectFocus(select)
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

test('chat card fills a floating window after native edge resize', async ({ page }) => {
    await installVisionTauriMock(page, undefined, false)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/?window=vision#vision?mode=chat')
    await waitForVisionSelection(page)
    await page.mouse.move(120, 160)
    await page.mouse.down()
    await page.mouse.move(620, 460, { steps: 8 })
    await page.mouse.up()

    await page.getByPlaceholder('问点什么...').fill('What is visible?')
    await page.locator('button:has(svg.lucide-arrow-up)').click()
    await expect(page.getByText(/synthetic ScreenPilot visual test/)).toBeVisible()

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

    const card = page.locator('[data-screenpilot-floating-answer-card="true"]')
    await expect(card).toBeVisible()
    const initialBox = await card.boundingBox()
    expect(initialBox).not.toBeNull()

    const minimumHeight = 244
    await page.setViewportSize({ width, height: minimumHeight })
    await expect.poll(async () => card.evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBe(minimumHeight)
    const minimumBox = await card.boundingBox()
    if (minimumBox === null) throw new Error('chat minimum resize geometry is missing')
    expect(minimumBox.height).toBeGreaterThanOrEqual(176)

    const resizedHeight = initialHeight + 160
    await page.setViewportSize({ width, height: resizedHeight })
    if (initialBox === null) throw new Error('chat initial resize geometry is missing')
    await expect.poll(async () => card.evaluate((element) => Math.round(element.getBoundingClientRect().bottom))).toBe(resizedHeight)
    const resizedBox = await card.boundingBox()
    if (resizedBox === null) throw new Error('chat resized geometry is missing')
    expect(resizedBox.height).toBeGreaterThan(initialBox.height + 100)
})

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
  expect(initialFloatingSequence.every((rect) => rect.height <= 400)).toBe(true)
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
  expect(contentDrivenBox.height).toBeLessThan(400)
  const shortSourceGeometry = await page.locator('.ocr-editable, .ocr-markdown').first().evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(shortSourceGeometry.scrollHeight).toBeLessThanOrEqual(shortSourceGeometry.clientHeight + 1)

})

test('long OCR source scrolls independently without pushing translation below the card', async ({ page }) => {
  const longSource = Array.from({ length: 60 }, (_, index) => `OCR line ${String(index + 1)} with enough text to wrap inside the source pane.`).join('\n')
  const longTranslation = Array.from({ length: 20 }, (_, index) => `译文第 ${String(index + 1)} 行，用于验证多行翻译结果会先撑高窗口。`).join('\n')
  await installVisionTauriMock(page, longSource, false, longTranslation)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=translate')
  await waitForVisionSelection(page)
  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByText('OCR line 1 with enough text to wrap inside the source pane.')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { height: number } | null }
  }).__SCREENPILOT_TEST__.floatingRect?.height ?? 0)).toBeGreaterThan(224)
  const measuredRect = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
  }).__SCREENPILOT_TEST__.floatingRect)
  if (measuredRect === null) throw new Error('OCR measured floating geometry is missing')
  expect(measuredRect.height).toBeLessThanOrEqual(400)
  await page.setViewportSize({ width: Math.round(measuredRect.width), height: Math.round(measuredRect.height) })
  await expect.poll(async () => page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { height: number } | null }
  }).__SCREENPILOT_TEST__.floatingRect?.height ?? 0)).toBe(400)
  const cappedRect = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
  }).__SCREENPILOT_TEST__.floatingRect)
  if (cappedRect === null) throw new Error('OCR capped floating geometry is missing')
  await page.setViewportSize({ width: Math.round(cappedRect.width), height: Math.round(cappedRect.height) })
  await expect(page.locator('html')).toHaveAttribute('data-screenpilot-floating-translate-window', 'true')
  const measuredHeight = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRect: { height: number } | null }
  }).__SCREENPILOT_TEST__.floatingRect?.height ?? 0)
  expect(measuredHeight).toBeLessThanOrEqual(400)
  const floatingSequence = await page.evaluate(() => (window as typeof window & {
    __SCREENPILOT_TEST__: { floatingRects: { height: number }[] }
  }).__SCREENPILOT_TEST__.floatingRects.slice())
  expect(floatingSequence.length).toBeGreaterThanOrEqual(2)
  expect(floatingSequence[0]?.height).toBeLessThanOrEqual(224)
  expect(floatingSequence.every((rect) => rect.height <= 400)).toBe(true)
  expect(Math.max(...floatingSequence.map((rect) => rect.height))).toBe(400)
  const source = page.locator('[data-screenpilot-ocr-source="true"]')
  await expect(source).toBeVisible()
  const geometry = await source.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  const translationBody = page.locator('[data-screenpilot-translation-body="true"]')
  const bodyGeometry = await translationBody.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(bodyGeometry.scrollHeight).toBeGreaterThan(bodyGeometry.clientHeight)
  await expect(page.getByText('译文第 20 行，用于验证多行翻译结果会先撑高窗口。')).toBeAttached()
  const translatedHeading = page.locator('[data-screenpilot-translated-heading="true"]')
  await expect(translatedHeading).toBeVisible()
  const headingBox = await translatedHeading.boundingBox()
  const cardBox = await page.locator('[data-screenpilot-window-frame="true"]', { has: translatedHeading }).boundingBox()
  expect(headingBox).not.toBeNull()
  expect(cardBox).not.toBeNull()
  if (headingBox === null || cardBox === null) throw new Error('Translation card geometry is missing')
  expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height)
})
