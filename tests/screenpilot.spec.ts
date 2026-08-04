import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { installVisionTauriMock } from './tauri-mock'

async function expectAccessible(page: Page, excludedSelectors: readonly string[] = []) {
  let builder = new AxeBuilder({ page })
  for (const selector of excludedSelectors) builder = builder.exclude(selector)
  const result = await builder.analyze()
  expect(result.violations).toEqual([])
}

async function waitForVisionSelection(page: Page) {
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & { __SCREENPILOT_TEST__: { showCount: number } }
  ).__SCREENPILOT_TEST__.showCount), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  await expect(page.locator('main > div.fixed.inset-0.select-none')).toHaveCSS('cursor', 'crosshair')
}

async function expectSettledViewportBottom(card: Locator, targetBottom: number) {
  await expect.poll(() => card.evaluate((element, target) => {
    const rect = element.getBoundingClientRect()
    const activeGeometryAnimation = element.getAnimations().some((animation) => (
      animation.playState !== 'finished'
    ))
    return !activeGeometryAnimation && Math.round(rect.bottom) === target
  }, targetBottom)).toBe(true)
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

async function frostedFrameStyle(frame: Locator) {
  return frame.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      backgroundImage: computed.backgroundImage,
      backdropFilter: computed.backdropFilter,
    }
  })
}

const VISION_FROSTED_TRANSPARENCY = {
  backgroundImage: 'linear-gradient(rgba(255, 255, 255, 0.98) 0%, rgba(250, 250, 252, 0.94) 100%)',
  backdropFilter: 'saturate(1.8) blur(30px)',
}

async function expectFrostedTransparency(frame: Locator) {
  await expect.poll(() => frostedFrameStyle(frame)).toEqual(VISION_FROSTED_TRANSPARENCY)
}

async function transparentAnswerActionsStyle(frame: Locator) {
  return frame.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage,
      borderTopStyle: computed.borderTopStyle,
      borderTopWidth: computed.borderTopWidth,
      borderBottomStyle: computed.borderBottomStyle,
      borderBottomWidth: computed.borderBottomWidth,
      boxShadow: computed.boxShadow,
      backdropFilter: computed.backdropFilter,
    }
  })
}

const TRANSPARENT_ANSWER_ACTIONS = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderTopStyle: 'none',
  borderTopWidth: '0px',
  borderBottomStyle: 'none',
  borderBottomWidth: '0px',
  boxShadow: 'none',
  backdropFilter: 'none',
}

async function expectTransparentAnswerActions(frame: Locator) {
  await expect.poll(() => transparentAnswerActionsStyle(frame)).toEqual(TRANSPARENT_ANSWER_ACTIONS)
}

async function expectAnswerActionsLeftAligned(panel: Locator) {
  await expect.poll(async () => panel.evaluate((element) => {
    const actions = element.querySelector<HTMLElement>('[data-screenpilot-answer-actions="true"]')
    const firstButton = actions?.querySelector<HTMLElement>(':scope > button')
    if (actions === null || firstButton === null || firstButton === undefined) return false
    const panelRect = element.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    const buttonRect = firstButton.getBoundingClientRect()
    const buttonAtActionsStart = Math.abs(buttonRect.left - actionsRect.left) <= 1
    const nearPanelLeft = buttonRect.left >= panelRect.left - 1
      && buttonRect.left - panelRect.left <= 20
    return buttonAtActionsStart && nearPanelLeft
  })).toBe(true)
}

async function expectHistoryCountBadge(button: Locator) {
  const badge = button.locator('.history-count-badge')
  await expect(badge).toHaveText(/^[0-9]+$/u)
  await expect(badge).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(badge).toHaveCSS('border-width', '0px')
  await expect(badge).toHaveCSS('border-style', 'none')
  await expect(badge).toHaveCSS('border-radius', '0px')
  await expect(badge).toHaveCSS('box-shadow', 'none')

  const geometry = await button.evaluate((element) => {
    const buttonBounds = element.getBoundingClientRect()
    const icon = element.querySelector('svg')?.getBoundingClientRect()
    const count = element.querySelector('.history-count-badge')?.getBoundingClientRect()
    const badgeStyle = element.querySelector('.history-count-badge')
    if (icon === undefined || count === undefined || badgeStyle === null) return null
    return {
      buttonLeft: buttonBounds.left,
      buttonRight: buttonBounds.right,
      buttonTop: buttonBounds.top,
      iconBottom: icon.bottom,
      iconColor: getComputedStyle(element.querySelector('svg') as SVGElement).color,
      iconLeft: icon.left,
      iconRight: icon.right,
      iconTop: icon.top,
      badgeBottom: count.bottom,
      badgeColor: getComputedStyle(badgeStyle).color,
      badgeLeft: count.left,
      badgeRight: count.right,
      badgeTop: count.top,
    }
  })
  expect(geometry).not.toBeNull()
  if (geometry === null) throw new Error('History count badge geometry is missing')

  expect(geometry.iconLeft - geometry.buttonLeft).toBeCloseTo(6, 1)
  const horizontalGap = geometry.badgeLeft - geometry.iconRight
  expect(horizontalGap).toBeGreaterThanOrEqual(0)
  expect(horizontalGap).toBeLessThanOrEqual(1.5)
  expect(geometry.badgeRight).toBeCloseTo(geometry.buttonRight - 2, 1)
  expect(geometry.badgeTop).toBeGreaterThanOrEqual(geometry.iconTop - 6)
  expect(geometry.badgeTop).toBeLessThanOrEqual(geometry.iconTop + 1)
  expect(geometry.badgeBottom).toBeGreaterThanOrEqual(geometry.iconTop)
  expect(geometry.badgeBottom).toBeLessThanOrEqual(geometry.iconTop + 6)
  expect(geometry.badgeTop).toBeCloseTo(geometry.buttonTop + 2, 1)
  expect(geometry.badgeColor).toBe(geometry.iconColor)
}

async function referenceHistoryPopoverStyle(popover: Locator) {
  return popover.evaluate((element) => {
    const computed = getComputedStyle(element)
    const list = element.querySelector<HTMLElement>('.history-menu-list')
    const input = element.querySelector<HTMLElement>('.history-menu-input')
    const output = element.querySelector<HTMLElement>('.history-menu-output')
    const meta = element.querySelector<HTMLElement>('.history-menu-meta')
    const clear = element.querySelector<HTMLElement>('.history-menu-clear')
    return {
      width: element.getBoundingClientRect().width,
      borderRadius: computed.borderRadius,
      overflow: computed.overflow,
      backgroundColor: computed.backgroundColor,
      borderColor: computed.borderTopColor,
      fontFamily: computed.fontFamily,
      animationName: computed.animationName,
      animationDuration: computed.animationDuration,
      animationTimingFunction: computed.animationTimingFunction,
      listMaxHeight: list === null ? '' : getComputedStyle(list).maxHeight,
      listOverflowX: list === null ? '' : getComputedStyle(list).overflowX,
      listOverflowY: list === null ? '' : getComputedStyle(list).overflowY,
      listClientWidth: list?.clientWidth ?? 0,
      listScrollWidth: list?.scrollWidth ?? 0,
      listClientHeight: list?.clientHeight ?? 0,
      listScrollHeight: list?.scrollHeight ?? 0,
      inputFontSize: input === null ? '' : getComputedStyle(input).fontSize,
      inputLineHeight: input === null ? '' : getComputedStyle(input).lineHeight,
      outputFontSize: output === null ? '' : getComputedStyle(output).fontSize,
      outputLineHeight: output === null ? '' : getComputedStyle(output).lineHeight,
      metaFontSize: meta === null ? '' : getComputedStyle(meta).fontSize,
      metaLineHeight: meta === null ? '' : getComputedStyle(meta).lineHeight,
      clearHeight: clear?.getBoundingClientRect().height ?? 0,
      clearFontSize: clear === null ? '' : getComputedStyle(clear).fontSize,
      portalParent: element.parentElement === document.body,
      insideWindowFrame: element.closest('[data-screenpilot-window-frame="true"]') !== null,
    }
  })
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

const RED_FOCUS_PAINT = /rgb(?:a)?\(\s*(?:177\s*,\s*60\s*,\s*56|185\s*,\s*86\s*,\s*61|223\s*,\s*128\s*,\s*101|239\s*,\s*127\s*,\s*121)/u

async function expectNoRedFocusPaint(control: Locator) {
  const style = await control.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      outline: computed.outline,
      border: computed.border,
      boxShadow: computed.boxShadow,
    }
  })
  expect(`${style.outline} ${style.border} ${style.boxShadow}`).not.toMatch(RED_FOCUS_PAINT)
  return style
}

async function focusPaintStyle(control: Locator) {
  return control.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      borderRadius: computed.borderRadius,
      outlineStyle: computed.outlineStyle,
      outlineWidth: computed.outlineWidth,
      outlineColor: computed.outlineColor,
      outlineOffset: computed.outlineOffset,
      border: computed.border,
      boxShadow: computed.boxShadow,
    }
  })
}

async function expectOutlineFitsClippingAncestors(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const computed = getComputedStyle(element)
    const outlineWidth = Number.parseFloat(computed.outlineWidth)
    const outlineOffset = Number.parseFloat(computed.outlineOffset)
    const extent = outlineWidth + outlineOffset
    const bounds = element.getBoundingClientRect()
    const expanded = {
      bottom: bounds.bottom + extent,
      left: bounds.left - extent,
      right: bounds.right + extent,
      top: bounds.top - extent,
    }
    const clippingAncestors: { element: string; containsOutline: boolean }[] = []
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
          containsOutline: expanded.left >= ancestorBounds.left - 0.5
            && expanded.top >= ancestorBounds.top - 0.5
            && expanded.right <= ancestorBounds.right + 0.5
            && expanded.bottom <= ancestorBounds.bottom + 0.5,
        })
      }
      ancestor = ancestor.parentElement
    }
    return { clippingAncestors, extent }
  })
  expect(geometry.extent).toBe(2)
  expect(geometry.clippingAncestors.length).toBeGreaterThan(0)
  expect(
    geometry.clippingAncestors.every((ancestor) => ancestor.containsOutline),
    JSON.stringify(geometry.clippingAncestors),
  ).toBe(true)
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
  const settingsNavigation = page.getByRole('navigation', { name: '设置分区' })
  const settingsToolbar = page.locator('.settings-toolbar')
  const settingsBrand = page.locator('.settings-brand')
  const closeSettings = page.getByRole('button', { name: '关闭设置' })
  await expect(settingsNavigation).toBeVisible()
  await expect(settingsBrand).toHaveCSS('cursor', 'move')
  await expect(settingsToolbar).toHaveCSS('cursor', 'move')
  await expect(settingsToolbar.getByRole('heading', { name: '常规' })).toHaveCSS('cursor', 'move')
  await expect(closeSettings).toHaveCSS('cursor', 'pointer')
  await expect(settingsNavigation.getByRole('button', { name: '常规', exact: true })).toHaveCSS('cursor', 'pointer')
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
  await closeSettings.click()
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

test('thinking effort controls use lowercase values and persist without legacy labels', async ({ page }) => {
  await page.goto('/')

  const fullEfforts = ['low', 'medium', 'high', 'xhigh', 'max']
  const screenshotEfforts = ['low', 'medium', 'high', 'xhigh']
  const assertOptions = async (select: Locator, values: string[]) => {
    await expect(select).toHaveValue('medium')
    const options = await select.locator('option').evaluateAll((elements) => elements.map((element) => ({
      label: element.textContent,
      value: (element as HTMLOptionElement).value,
    })))
    expect(options).toEqual(values.map((value) => ({ label: value, value })))
    expect(options.some((option) => /[低中高极]/u.test(option.label))).toBe(false)
    expect(options.some((option) => option.label === 'MAX' || option.value === 'MAX')).toBe(false)
  }

  await page.getByRole('button', { name: 'Vision', exact: true }).click()
  const vision = page.getByRole('combobox', { name: 'Vision 思考强度', exact: true })
  await assertOptions(vision, fullEfforts)
  await vision.selectOption('max')
  await expect(vision).toHaveValue('max')

  await page.getByRole('button', { name: 'OCR', exact: true }).click()
  await page.getByRole('switch', { name: '显示思考过程', exact: true }).click()
  const screenshot = page.getByRole('combobox', { name: '截图翻译思考强度', exact: true })
  await assertOptions(screenshot, screenshotEfforts)
  await screenshot.selectOption('xhigh')
  await expect(screenshot).toHaveValue('xhigh')

  await page.getByRole('button', { name: '提示词优化', exact: true }).click()
  const optimizer = page.getByRole('combobox', { name: '提示词优化思考强度', exact: true })
  await assertOptions(optimizer, fullEfforts)
  await optimizer.selectOption('max')
  await expect(optimizer).toHaveValue('max')

  const save = page.locator('.settings-footer').getByRole('button', { name: '保存', exact: true })
  await save.click()
  await expect(save).toBeDisabled()
  await expect(page.locator('.settings-save-state')).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByText('设置已保存并立即生效')).toBeVisible()
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

test('settings save success uses a floating replayable toast without shifting content', async ({ page }) => {
  await page.clock.install()
  await page.setViewportSize({ width: 680, height: 520 })
  await page.goto('/')

  const scroll = page.locator('.settings-scroll')
  const before = await scroll.boundingBox()
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()

  const region = page.locator('.save-success-toast-region')
  const toast = region.locator('.save-success-toast')
  await expect(toast).toBeVisible()
  await expect(toast).toHaveAttribute('data-toast-phase', 'visible')
  await expect(region).toHaveAttribute('aria-live', 'polite')
  await expect(region).toHaveAttribute('aria-label', '设置已保存并立即生效')
  const bounceSamples = await toast.evaluate((element) => {
    const animation = element.getAnimations().find((candidate) => (
      (candidate as Animation & { animationName?: string }).animationName
        === 'screenpilot-settings-save-toast-in'
    ))
    if (animation === undefined) return null
    const timing = animation.effect?.getComputedTiming()
    const duration = typeof timing?.duration === 'number' ? timing.duration : 380
    animation.pause()
    const sample = (time: number) => {
      animation.currentTime = time
      const transform = getComputedStyle(element).transform
      const matrix = transform === 'none' ? new DOMMatrix() : new DOMMatrix(transform)
      return { y: matrix.m42, scale: matrix.a }
    }
    return {
      start: sample(0),
      middle: sample(duration * 0.42),
      end: sample(duration),
    }
  })
  expect(bounceSamples).not.toBeNull()
  expect(bounceSamples?.start.y).toBeLessThan(-5)
  expect(bounceSamples?.start.scale).toBeLessThan(0.98)
  expect(bounceSamples?.middle.y).toBeGreaterThan(0)
  expect(bounceSamples?.middle.scale).toBeGreaterThan(1)
  expect(bounceSamples?.end.y).toBeCloseTo(0, 0)
  expect(bounceSamples?.end.scale).toBeCloseTo(1, 1)
  const geometry = await page.evaluate(() => {
    const settingsWindow = document.querySelector<HTMLElement>('.settings-window')
    const main = document.querySelector<HTMLElement>('.settings-main')
    const scroll = document.querySelector<HTMLElement>('.settings-scroll')
    const region = document.querySelector<HTMLElement>('.save-success-toast-region')
    const toast = document.querySelector<HTMLElement>('.save-success-toast')
    if (settingsWindow === null || main === null || scroll === null || region === null || toast === null) return null
    const settingsWindowRect = settingsWindow.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    const regionRect = region.getBoundingClientRect()
    const toastStyle = getComputedStyle(toast)
    return {
      centered: Math.abs((regionRect.left + regionRect.width / 2) - (settingsWindowRect.left + settingsWindowRect.width / 2)) < 1,
      centeredInMain: Math.abs((regionRect.left + regionRect.width / 2) - (mainRect.left + mainRect.width / 2)) < 1,
      directChild: region.parentElement === settingsWindow,
      top: regionRect.top - settingsWindowRect.top,
      topStyle: getComputedStyle(region).top,
      regionWidth: regionRect.width,
      toastWidth: toastStyle.width,
      textAlign: toastStyle.textAlign,
      pointerEvents: toastStyle.pointerEvents,
      animationName: toastStyle.animationName,
      scrollTop: scrollRect.top,
      scrollHeight: scrollRect.height,
    }
  })
  expect(geometry).toEqual(expect.objectContaining({
    centered: true,
    centeredInMain: false,
    directChild: true,
    top: 19,
    topStyle: '18px',
    regionWidth: 320,
    toastWidth: '320px',
    textAlign: 'center',
    pointerEvents: 'none',
    animationName: 'screenpilot-settings-save-toast-in',
  }))
  expect(geometry?.scrollTop).toBe(before?.y)
  expect(geometry?.scrollHeight).toBe(before?.height)

  await page.setViewportSize({ width: 300, height: 520 })
  const narrowGeometry = await page.evaluate(() => {
    const settingsWindow = document.querySelector<HTMLElement>('.settings-window')
    const region = document.querySelector<HTMLElement>('.save-success-toast-region')
    const toast = document.querySelector<HTMLElement>('.save-success-toast')
    if (settingsWindow === null || region === null || toast === null) return null
    const windowRect = settingsWindow.getBoundingClientRect()
    const regionRect = region.getBoundingClientRect()
    const toastStyle = getComputedStyle(toast)
    const textRange = document.createRange()
    textRange.selectNodeContents(toast)
    const textRect = textRange.getBoundingClientRect()
    return {
      centered: Math.abs((regionRect.left + regionRect.width / 2) - (windowRect.left + windowRect.width / 2)) < 1,
      fitsWindow: regionRect.left >= windowRect.left
        && regionRect.right <= windowRect.right
        && regionRect.width <= windowRect.width - 31,
      textCentered: Math.abs((textRect.left + textRect.width / 2) - (toast.getBoundingClientRect().left + toast.getBoundingClientRect().width / 2)) < 1,
      regionWidth: regionRect.width,
      textAlign: toastStyle.textAlign,
    }
  })
  expect(narrowGeometry).toEqual(expect.objectContaining({
    centered: true,
    fitsWindow: true,
    textCentered: true,
    textAlign: 'center',
  }))
  expect(narrowGeometry?.regionWidth).toBeLessThan(320)
  await page.setViewportSize({ width: 680, height: 520 })

  await page.clock.fastForward(3_200)
  await expect(toast).toHaveAttribute('data-toast-phase', 'leaving')
  await page.clock.fastForward(200)
  await expect(toast).toHaveCount(0)

  await page.getByRole('radio', { name: '浅色', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(toast).toHaveAttribute('data-toast-sequence', '2')
  await page.getByRole('radio', { name: '深色', exact: true }).click()
  await page.getByRole('button', { name: '关闭设置', exact: true }).click()
  await expect(page.locator('.decision-dialog')).toBeVisible()
  await expect(toast).toHaveCount(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(toast).toHaveAttribute('data-toast-sequence', '3')
  await expect.poll(() => toast.evaluate((element) => getComputedStyle(element).animationDuration)).toMatch(/^(?:0|0\.01)s$/u)
})

test('provider model lists stay bounded while retaining model actions', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 620 })
  await page.goto('/')
  await page.getByRole('button', { name: '模型提供商', exact: true }).click()
  await page.getByRole('button', { name: '新增', exact: true }).click()

  const modelList = page.locator('.model-list[aria-label="OpenAI Compatible 模型列表"]')
  const modelInput = page.getByRole('textbox', { name: 'OpenAI Compatible 手动模型名' })
  const addModel = page.getByRole('button', { name: '添加', exact: true })

  for (let index = 1; index <= 3; index += 1) {
    await modelInput.fill(`compact-model-${index}`)
    await addModel.click()
  }

  const compactMetrics = await modelList.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      clientHeight: element.clientHeight,
      maxHeight: style.maxHeight,
      overflowY: style.overflowY,
      scrollHeight: element.scrollHeight,
    }
  })
  expect(compactMetrics.maxHeight).toBe('180px')
  expect(compactMetrics.overflowY).toBe('auto')
  expect(compactMetrics.scrollHeight).toBe(compactMetrics.clientHeight)

  for (let index = 4; index <= 36; index += 1) {
    await modelInput.fill(`scroll-model-${index}`)
    await addModel.click()
  }

  const boundedMetrics = await modelList.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(boundedMetrics.scrollHeight).toBeGreaterThan(boundedMetrics.clientHeight)
  expect(boundedMetrics.clientHeight).toBeLessThanOrEqual(180)

  const finalModel = modelList.getByRole('button', { name: 'scroll-model-36', exact: true })
  await modelList.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => modelList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  const finalModelVisibility = await finalModel.evaluate((element) => {
    const list = element.closest('.model-list')
    if (!(list instanceof HTMLElement)) return false
    const listBounds = list.getBoundingClientRect()
    const modelBounds = element.getBoundingClientRect()
    return modelBounds.top >= listBounds.top
      && modelBounds.bottom <= listBounds.bottom
  })
  expect(finalModelVisibility).toBe(true)
  await finalModel.click()
  await expect(finalModel).toHaveAttribute('aria-pressed', 'true')
})

test('provider add controls stay on one line at supported and stress widths', async ({ page }) => {
  for (const width of [760, 680, 507, 380]) {
    await page.setViewportSize({ width, height: 620 })
    await page.goto('/')
    await page.getByRole('button', { name: '模型提供商', exact: true }).click()
    await page.getByRole('button', { name: '新增', exact: true }).click()

    const providerSettings = page.locator('[data-screenpilot-provider-settings="true"]')
    const addProvider = providerSettings.locator('.section-heading > .secondary-button')
    const manualModel = providerSettings.locator('.manual-model').first()
    const addModel = manualModel.getByRole('button', { name: '添加', exact: true })

    const metrics = await manualModel.evaluate((element) => {
      const input = element.querySelector('.text-field')
      const button = element.querySelector('button')
      if (!(input instanceof HTMLElement) || !(button instanceof HTMLElement)) return null
      const inputRect = input.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()
      const rowRect = element.getBoundingClientRect()
      const buttonStyle = getComputedStyle(button)
      const textNode = Array.from(button.childNodes).find((node) => (
        node.nodeType === Node.TEXT_NODE && node.textContent?.trim().length
      ))
      if (textNode === undefined) return null
      const textRange = document.createRange()
      textRange.selectNodeContents(textNode)
      const textRect = textRange.getBoundingClientRect()
      return {
        inputTop: inputRect.top,
        inputBottom: inputRect.bottom,
        buttonTop: buttonRect.top,
        buttonBottom: buttonRect.bottom,
        rowTop: rowRect.top,
        rowBottom: rowRect.bottom,
        rowOverflowing: element.scrollWidth > element.clientWidth,
        buttonFits: button.scrollWidth <= button.clientWidth,
        buttonWhiteSpace: buttonStyle.whiteSpace,
        textInsideButton: textRect.top >= buttonRect.top
          && textRect.bottom <= buttonRect.bottom
          && textRect.left >= buttonRect.left
          && textRect.right <= buttonRect.right,
        textLineCount: textRange.getClientRects().length,
        textHeight: textRect.height,
      }
    })
    expect(metrics).not.toBeNull()
    expect(metrics?.buttonTop).toBeCloseTo(metrics?.inputTop ?? 0, 0)
    expect(metrics?.buttonTop).toBeGreaterThanOrEqual(metrics?.rowTop ?? 0)
    expect(metrics?.buttonBottom).toBeLessThanOrEqual(metrics?.rowBottom ?? 0)
    expect(metrics?.rowOverflowing).toBe(false)
    expect(metrics?.buttonFits).toBe(true)
    expect(metrics?.buttonWhiteSpace).toBe('nowrap')
    expect(metrics?.textInsideButton).toBe(true)
    expect(metrics?.textLineCount).toBe(1)
    expect(metrics?.textHeight).toBeLessThanOrEqual(30)

    await expect(addProvider).toHaveCSS('white-space', 'nowrap')
    await expect(addModel).toHaveCSS('white-space', 'nowrap')
    await expect(addModel).toBeVisible()

    const actionMetrics = await providerSettings.locator('.provider-actions > .secondary-button').evaluateAll((buttons) => (
      buttons.map((button) => {
        const bounds = button.getBoundingClientRect()
        const textNode = Array.from(button.childNodes).find((node) => (
          node.nodeType === Node.TEXT_NODE && node.textContent?.trim().length
        ))
        if (textNode === undefined) return null
        const textRange = document.createRange()
        textRange.selectNodeContents(textNode)
        const textBounds = textRange.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          whiteSpace: style.whiteSpace,
          textInside: textBounds.top >= bounds.top
            && textBounds.bottom <= bounds.bottom
            && textBounds.left >= bounds.left
            && textBounds.right <= bounds.right,
          textLineCount: textRange.getClientRects().length,
          textHeight: textBounds.height,
        }
      })
    ))
    expect(actionMetrics).toHaveLength(2)
    for (const action of actionMetrics) {
      if (action === null) throw new Error('provider action text is missing')
      expect(action.whiteSpace).toBe('nowrap')
      expect(action.textInside).toBe(true)
      expect(action.textLineCount).toBe(1)
      expect(action.textHeight).toBeLessThanOrEqual(30)
    }
    const deleteMetrics = await providerSettings.locator('.provider-actions > .icon-button').evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      const actions = button.parentElement?.getBoundingClientRect()
      if (actions === undefined) return null
      const overlapsTextButton = Array.from(button.parentElement?.querySelectorAll('.secondary-button') ?? [])
        .some((candidate) => {
          const candidateBounds = candidate.getBoundingClientRect()
          return bounds.left < candidateBounds.right
            && bounds.right > candidateBounds.left
            && bounds.top < candidateBounds.bottom
            && bounds.bottom > candidateBounds.top
        })
      return {
        width: bounds.width,
        height: bounds.height,
        insideActions: bounds.left >= actions.left
          && bounds.right <= actions.right
          && bounds.top >= actions.top
          && bounds.bottom <= actions.bottom,
        overlapsTextButton,
      }
    })
    expect(deleteMetrics).toEqual({
      width: 30,
      height: 30,
      insideActions: true,
      overlapsTextButton: false,
    })
  }
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
  await expect(translatorSelects).toHaveCount(3)
  for (let index = 0; index < await translatorSelects.count(); index += 1) {
    await expectNeutralSelectFocus(translatorSelects.nth(index))
  }
})

test('pointer-focused settings and Vision optimizer controls stay free of red focus paint', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })

    await page.goto('/')
    await page.getByRole('button', { name: '模型提供商', exact: true }).click()
    await page.getByRole('button', { name: '新增', exact: true }).click()
    const providerName = page.getByRole('textbox', { name: '提供商名称' })
    await providerName.click()
    const providerFocus = await focusPaintStyle(providerName)
    expect(providerFocus.outlineStyle).toBe('solid')
    expect(providerFocus.outlineWidth).toBe('1px')
    expect(providerFocus.outlineOffset).toBe('1px')
    expect(providerFocus.outlineColor).toMatch(/(?:0\.46|46%)/u)
    expect(`${providerFocus.outlineColor} ${providerFocus.border} ${providerFocus.boxShadow}`).not.toMatch(RED_FOCUS_PAINT)

    await page.getByRole('button', { name: '提示词优化', exact: true }).click()
    const settingsPrompt = page.getByRole('textbox', { name: '优化提示词' })
    await settingsPrompt.click()
    await expectNoRedFocusPaint(settingsPrompt)

    await page.goto('/?route=prompt-optimizer')
    const optimizerPrompt = page.getByRole('textbox', { name: '原始提示词' })
    await optimizerPrompt.click()
    await expectNoRedFocusPaint(optimizerPrompt)

    // Keyboard navigation still receives a visible, theme-neutral indicator.
    await page.keyboard.press('Tab')
    const keyboardStyle = await page.evaluate(() => {
      const element = document.activeElement
      if (!(element instanceof HTMLElement)) return null
      const computed = getComputedStyle(element)
      return {
        focusVisible: element.matches(':focus-visible'),
        outline: computed.outline,
        border: computed.border,
        boxShadow: computed.boxShadow,
      }
    })
    expect(keyboardStyle).not.toBeNull()
    if (keyboardStyle === null) throw new Error('Keyboard-focused optimizer control is missing')
    expect(keyboardStyle.focusVisible).toBe(true)
    expect(keyboardStyle.outline).toMatch(/solid 2px/u)
    expect(`${keyboardStyle.outline} ${keyboardStyle.border} ${keyboardStyle.boxShadow}`).not.toMatch(RED_FOCUS_PAINT)
  }
})

test('settings prompt fields match the provider focus frame in both themes', async ({ page }) => {
  const promptFields = [
    { section: '翻译', label: '大模型翻译系统提示词' },
    { section: 'OCR', label: 'OCR 提示词' },
    { section: 'OCR', label: '截图翻译提示词' },
    { section: 'Vision', label: 'Vision 系统提示词' },
    { section: 'Vision', label: 'Vision 问答提示词' },
    { section: '提示词优化', label: '优化器系统提示词' },
    { section: '提示词优化', label: '优化提示词' },
  ] as const

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto('/')
    await page.getByRole('button', { name: '模型提供商', exact: true }).click()
    await page.getByRole('button', { name: '新增', exact: true }).click()

    const providerName = page.getByRole('textbox', { name: '提供商名称' })
    await providerName.click()
    const providerFocus = await focusPaintStyle(providerName)
    const expectedFocus = {
      borderRadius: providerFocus.borderRadius,
      outlineStyle: providerFocus.outlineStyle,
      outlineWidth: providerFocus.outlineWidth,
      outlineColor: providerFocus.outlineColor,
      outlineOffset: providerFocus.outlineOffset,
      boxShadow: providerFocus.boxShadow,
    }
    expect({
      borderRadius: '8px',
      outlineStyle: 'solid',
      outlineWidth: '1px',
      outlineOffset: '1px',
      boxShadow: 'none',
    }).toEqual({
      borderRadius: expectedFocus.borderRadius,
      outlineStyle: expectedFocus.outlineStyle,
      outlineWidth: expectedFocus.outlineWidth,
      outlineOffset: expectedFocus.outlineOffset,
      boxShadow: expectedFocus.boxShadow,
    })
    expect(expectedFocus.outlineColor).toMatch(/(?:0\.46|46%)/u)

    for (const field of promptFields) {
      await page.getByRole('button', { name: field.section, exact: true }).click()
      const prompt = page.getByRole('textbox', { name: field.label })
      await prompt.click()
      const promptFrame = prompt.locator('..')
      const pointerFocus = await focusPaintStyle(promptFrame)
      expect({
        borderRadius: pointerFocus.borderRadius,
        outlineStyle: pointerFocus.outlineStyle,
        outlineWidth: pointerFocus.outlineWidth,
        outlineColor: pointerFocus.outlineColor,
        outlineOffset: pointerFocus.outlineOffset,
        boxShadow: pointerFocus.boxShadow,
      }).toEqual(expectedFocus)
      await expectOutlineFitsClippingAncestors(promptFrame)
      const pointerChildFocus = await focusPaintStyle(prompt)
      expect(pointerChildFocus.outlineStyle).toBe('none')
      expect(pointerChildFocus.outlineWidth).toBe('0px')
      expect(pointerChildFocus.outlineOffset).toBe('0px')
      expect(pointerChildFocus.boxShadow).toBe('none')

      // Move away and back with Tab so the keyboard focus-visible path is
      // covered independently from Chromium's pointer focus behavior.
      await prompt.focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => prompt.evaluate((element) => document.activeElement === element && element.matches(':focus-visible'))).toBe(true)
      const keyboardFocus = await focusPaintStyle(promptFrame)
      expect({
        borderRadius: keyboardFocus.borderRadius,
        outlineStyle: keyboardFocus.outlineStyle,
        outlineWidth: keyboardFocus.outlineWidth,
        outlineColor: keyboardFocus.outlineColor,
        outlineOffset: keyboardFocus.outlineOffset,
        boxShadow: keyboardFocus.boxShadow,
      }).toEqual(expectedFocus)
      await expectOutlineFitsClippingAncestors(promptFrame)
      const keyboardChildFocus = await focusPaintStyle(prompt)
      expect(keyboardChildFocus.outlineStyle).toBe('none')
      expect(keyboardChildFocus.outlineWidth).toBe('0px')
      expect(keyboardChildFocus.outlineOffset).toBe('0px')
      expect(keyboardChildFocus.boxShadow).toBe('none')
    }
  }
})

test('translator debounces, commits and restores its history', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 400 })
  await page.goto('/?route=translator')
  await expectEdgeSafeFrame(page.locator('.translator-window'))
  const card = page.locator('.translator-window.ocr-result-card.screenpilot-jelly-pop')
  await expect(card).toBeVisible()
  await expectFrostedTransparency(card)
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
  const sourceLanguage = page.getByRole('combobox', { name: '源语言' })
  const targetLanguage = page.getByRole('combobox', { name: '目标语言' })
  await expect(sourceLanguage).toHaveValue('auto')
  await expect(targetLanguage).toHaveValue('auto')
  const sourceLanguageStyle = await sourceLanguage.evaluate((element) => {
    const computed = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return { fontSize: computed.fontSize, width: bounds.width, height: bounds.height }
  })
  const targetLanguageStyle = await targetLanguage.evaluate((element) => {
    const computed = getComputedStyle(element)
    const bounds = element.getBoundingClientRect()
    return { fontSize: computed.fontSize, width: bounds.width, height: bounds.height }
  })
  expect(sourceLanguageStyle).toEqual(targetLanguageStyle)
  await sourceLanguage.selectOption('en')
  await expect(sourceLanguage).toHaveValue('en')
  await expect(output).toHaveValue('译文：A concise synthetic translation sample.', { timeout: 2_000 })
  await targetLanguage.selectOption('ja')
  await expect(targetLanguage).toHaveValue('ja')
  await expect(page).toHaveScreenshot('translator-source-language-controls.png')
  const translatorHistoryButton = page.getByRole('button', { name: '翻译历史' })
  await expect(translatorHistoryButton.locator('.history-count-badge')).toHaveText('1')
  await expect(translatorHistoryButton).toHaveClass(/history-button-count-1/u)
  await expect(translatorHistoryButton).toHaveCSS('width', '30px')
  await expectHistoryCountBadge(translatorHistoryButton)
  await translatorHistoryButton.click()
  await expect(page.getByRole('complementary', { name: '翻译历史' })).toContainText('A concise synthetic translation sample.')
  await expectAccessible(page, ['.history-menu-meta'])
  await expect(page).toHaveScreenshot('translator-result.png')
})

test('prompt optimizer requests only on demand and keeps editable output', async ({ page }) => {
  await page.setViewportSize({ width: 680, height: 450 })
  await page.goto('/?route=prompt-optimizer')
  await expectEdgeSafeFrame(page.locator('.optimizer-window'))
  const card = page.locator('.optimizer-window.ocr-result-card.screenpilot-jelly-pop')
  await expect(card).toHaveAttribute('data-screenpilot-ocr-card', 'true')
  await expectFrostedTransparency(card)
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
  const optimizerHistoryButton = page.getByRole('button', { name: '优化历史' })
  await expect(optimizerHistoryButton.locator('.history-count-badge')).toHaveText('1')
  await expect(optimizerHistoryButton).toHaveClass(/history-button-count-1/u)
  await expect(optimizerHistoryButton).toHaveCSS('width', '30px')
  await expectHistoryCountBadge(optimizerHistoryButton)
  await optimizerHistoryButton.click()
  const optimizerHistory = page.getByRole('complementary', { name: '优化历史' })
  await expect(optimizerHistory).toContainText('Summarize the supplied material.')
  await expect(optimizerHistory).toBeVisible()
  await optimizerHistory.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map(async (animation) => animation.finished))
  })
  await expect(page).toHaveScreenshot('optimizer-result.png')
  await expectAccessible(page, ['.history-menu-meta'])
})

test('translation and prompt optimization keep their original history triggers and match the reference popover', async ({ page }) => {
  test.setTimeout(60_000)
  const longSource = `Reference history source ${'很长的原始内容'.repeat(40)}`
  const longOutput = `Reference history output ${'很长的处理结果'.repeat(40)}`
  const entries = Array.from({ length: 20 }, (_, index) => ({
    id: `history-${String(index)}`,
    input: `${longSource} ${String(index + 1)}`,
    output: `${longOutput} ${String(index + 1)}`,
    method: 'microsoft',
    updatedAt: Date.now() - index * 60_000,
  }))
  const routes = [
    { route: 'translator', key: 'screenpilot:translator-history', button: '翻译历史' },
    { route: 'prompt-optimizer', key: 'screenpilot:optimizer-history', button: '优化历史' },
  ] as const

  for (const route of routes) {
    await page.setViewportSize({ width: 680, height: 300 })
    await page.goto(`/?route=${route.route}`)
    await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: route.key,
      value: entries.map((entry) => route.route === 'translator' ? entry : {
        id: entry.id,
        input: entry.input,
        output: entry.output,
        updatedAt: entry.updatedAt,
      }),
    })
    await page.reload()
    await page.locator('[data-screenpilot-window-frame="true"]').evaluate(async (element) => {
      await Promise.all(element.getAnimations().map(async (animation) => animation.finished))
    })
    const trigger = page.getByRole('button', { name: route.button })
    await expect(trigger).toHaveClass(/ocr-header-button/u)
    await expect(trigger).toHaveClass(/history-button/u)
    await expect(trigger).toHaveClass(/history-button-count-2/u)
    await expect(trigger).toHaveCSS('width', '35px')
    await expect(trigger).toHaveCSS('height', '28px')
    await expect(trigger.locator('svg')).toHaveCSS('width', '16px')
    await expect(trigger.locator('svg')).toHaveCSS('height', '16px')
    await expect(trigger.locator('.history-count-badge')).toHaveText('20')
    await expectHistoryCountBadge(trigger)
    await expect(page.locator('.ocr-result-header-actions').getByRole('button', { name: route.button })).toHaveCount(1)
    await expect(page.locator('.ocr-result-section-heading').getByRole('button', { name: route.button })).toHaveCount(0)
    await trigger.click()
    const popover = page.getByRole('complementary', { name: route.button })
    await expect(popover).toBeVisible()
    const popoverStyle = await referenceHistoryPopoverStyle(popover)
    expect(popoverStyle.width).toBe(340)
    expect(popoverStyle.borderRadius).toBe('12px')
    expect(popoverStyle.overflow).toBe('hidden')
    expect(popoverStyle.backgroundColor).toBe('rgb(255, 255, 255)')
    expect(popoverStyle.borderColor).toBe('rgba(0, 0, 0, 0.06)')
    expect(popoverStyle.fontFamily).toContain('system-ui')
    expect(popoverStyle.animationName).toBe('history-menu-in')
    expect(popoverStyle.animationDuration).toBe('0.15s')
    expect(popoverStyle.animationTimingFunction).toBe('cubic-bezier(0.22, 1, 0.36, 1)')
    expect(popoverStyle.listMaxHeight).toBe('210px')
    expect(popoverStyle.listOverflowX).toBe('hidden')
    expect(popoverStyle.listOverflowY).toBe('auto')
    expect(popoverStyle.listClientHeight).toBe(210)
    expect(popoverStyle.listScrollWidth).toBeLessThanOrEqual(popoverStyle.listClientWidth + 1)
    expect(popoverStyle.inputFontSize).toBe('11.5px')
    expect(popoverStyle.inputLineHeight).toBe('14.375px')
    expect(popoverStyle.metaFontSize).toBe('9.5px')
    expect(popoverStyle.metaLineHeight).toBe('11.875px')
    expect(popoverStyle.clearHeight).toBe(26)
    expect(popoverStyle.clearFontSize).toBe('11.5px')
    expect(popoverStyle.portalParent).toBe(true)
    expect(popoverStyle.insideWindowFrame).toBe(false)
    expect(popoverStyle.listScrollHeight).toBeGreaterThan(popoverStyle.listClientHeight)
    if (route.route === 'translator') {
      expect(popoverStyle.outputFontSize).toBe('11px')
      expect(popoverStyle.outputLineHeight).toBe('13.75px')
      await expect(popover.locator('.history-menu-output')).toHaveCount(20)
    } else {
      expect(popoverStyle.outputFontSize).toBe('')
      expect(popoverStyle.outputLineHeight).toBe('')
      await expect(popover.locator('.history-menu-output')).toHaveCount(0)
      await expect(popover).not.toContainText(longOutput)
    }
    const source = popover.locator('.history-menu-input').first()
    const sourceOverflow = await source.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        overflow: computed.overflow,
        textOverflow: computed.textOverflow,
        whiteSpace: computed.whiteSpace,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }
    })
    expect(sourceOverflow.overflow).toBe('hidden')
    expect(sourceOverflow.textOverflow).toBe('ellipsis')
    expect(sourceOverflow.whiteSpace).toBe('nowrap')
    expect(sourceOverflow.scrollWidth).toBeGreaterThan(sourceOverflow.clientWidth)
    const popoverBox = await popover.boundingBox()
    const triggerBox = await trigger.boundingBox()
    expect(popoverBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()
    if (popoverBox === null || triggerBox === null) throw new Error('History menu geometry is missing')
    expect(popoverBox.x).toBeGreaterThanOrEqual(0)
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(680)
    expect(Math.abs(popoverBox.y - (triggerBox.y + triggerBox.height + 6))).toBeLessThanOrEqual(0.6)
    expect(popoverBox.x + popoverBox.width).toBeCloseTo(triggerBox.x + triggerBox.width, 0)
    const firstItem = popover.locator('.history-menu-item').first()
    const deleteButton = firstItem.getByRole('button', { name: '删除历史' })
    const itemGeometry = await firstItem.evaluate((element) => {
      const popoverElement = element.closest<HTMLElement>('.history-menu-popover')
      const restoreElement = element.querySelector<HTMLElement>('.history-menu-restore')
      const inputElement = element.querySelector<HTMLElement>('.history-menu-input')
      const deleteElement = element.querySelector<HTMLElement>('.history-menu-delete')
      if (popoverElement === null || restoreElement === null || inputElement === null || deleteElement === null) return null
      const popoverBounds = popoverElement.getBoundingClientRect()
      const itemBounds = element.getBoundingClientRect()
      const restoreBounds = restoreElement.getBoundingClientRect()
      const inputBounds = inputElement.getBoundingClientRect()
      const deleteBounds = deleteElement.getBoundingClientRect()
      const deleteStyle = getComputedStyle(deleteElement)
      return {
        gap: getComputedStyle(element).columnGap,
        popoverRight: popoverBounds.right,
        itemRight: itemBounds.right,
        restoreRight: restoreBounds.right,
        inputRight: inputBounds.right,
        deleteLeft: deleteBounds.left,
        deleteRight: deleteBounds.right,
        deleteWidth: deleteBounds.width,
        deleteFlexShrink: deleteStyle.flexShrink,
        deleteFlexBasis: deleteStyle.flexBasis,
        deleteMinWidth: deleteStyle.minWidth,
      }
    })
    expect(itemGeometry).not.toBeNull()
    if (itemGeometry === null) throw new Error('History item geometry is missing')
    expect(itemGeometry.gap).toBe('12px')
    expect(itemGeometry.deleteLeft - itemGeometry.restoreRight).toBeGreaterThanOrEqual(12)
    expect(itemGeometry.deleteLeft - itemGeometry.inputRight).toBeGreaterThanOrEqual(12)
    expect(itemGeometry.deleteRight).toBeLessThanOrEqual(itemGeometry.itemRight + 0.5)
    expect(itemGeometry.itemRight).toBeLessThanOrEqual(itemGeometry.popoverRight)
    expect(itemGeometry.deleteWidth).toBe(24)
    expect(itemGeometry.deleteFlexShrink).toBe('0')
    expect(itemGeometry.deleteFlexBasis).toBe('24px')
    expect(itemGeometry.deleteMinWidth).toBe('24px')
    await deleteButton.hover()
    await expect(deleteButton).toHaveCSS('color', 'rgb(244, 63, 94)')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-screenpilot-window-frame="true"]')).toBeVisible()
    const focusAfterEscape = await trigger.evaluate((element) => {
      const computed = getComputedStyle(element)
      const outlineVisible = computed.outlineStyle !== 'none'
        && Number.parseFloat(computed.outlineWidth) > 0
        && computed.outlineColor !== 'rgba(0, 0, 0, 0)'
      return {
        active: document.activeElement === element,
        outlineVisible,
        boxShadow: computed.boxShadow,
      }
    })
    expect(focusAfterEscape.active).toBe(false)
    expect(focusAfterEscape.outlineVisible).toBe(false)
    expect(focusAfterEscape.boxShadow).toBe('none')
  }
})

test('history menus use the reference light, dark and system theme colors', async ({ page }) => {
  const entries = [{
    id: 'theme-history',
    input: 'Theme source',
    output: 'Theme output',
    method: 'microsoft',
    updatedAt: Date.now(),
  }]
  await page.addInitScript((value) => localStorage.setItem('screenpilot:translator-history', JSON.stringify(value)), entries)
  const cases = [
    { theme: 'light', scheme: 'light', surface: 'rgb(255, 255, 255)', input: 'rgb(38, 38, 38)', meta: 'rgb(163, 163, 163)' },
    { theme: 'dark', scheme: 'light', surface: 'rgb(23, 23, 23)', input: 'rgb(229, 229, 229)', meta: 'rgb(115, 115, 115)' },
    { theme: 'system', scheme: 'light', surface: 'rgb(255, 255, 255)', input: 'rgb(38, 38, 38)', meta: 'rgb(163, 163, 163)' },
    { theme: 'system', scheme: 'dark', surface: 'rgb(23, 23, 23)', input: 'rgb(229, 229, 229)', meta: 'rgb(115, 115, 115)' },
  ] as const
  for (const current of cases) {
    await page.emulateMedia({ colorScheme: current.scheme })
    await page.goto('/?route=translator')
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, current.theme)
    const trigger = page.getByRole('button', { name: '翻译历史' })
    await trigger.click()
    const popover = page.getByRole('complementary', { name: '翻译历史' })
    await expect(popover).toHaveCSS('background-color', current.surface)
    await expect(popover.locator('.history-menu-input')).toHaveCSS('color', current.input)
    await expect(popover.locator('.history-menu-meta')).toHaveCSS('color', current.meta)
  }
})

test('Vision keeps the end of long prompts visible before and after capture', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)

  const expectLongPromptEndVisible = async (value: string) => {
    const prompt = page.getByPlaceholder('问点什么...')
    await prompt.fill('')
    await prompt.pressSequentially(value)
    await prompt.evaluate((element) => {
      const input = element as HTMLInputElement
      const maximumScroll = Math.max(0, input.scrollWidth - input.clientWidth)
      input.scrollLeft = Math.max(0, maximumScroll - 48)
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: input.value.slice(-3),
        inputType: 'insertCompositionText',
      }))
      input.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: input.value.slice(-3),
      }))
    })
    await expect.poll(() => prompt.evaluate((element) => {
      const input = element as HTMLInputElement
      return input.scrollWidth - input.clientWidth - input.scrollLeft
    })).toBeLessThanOrEqual(1)
    const metrics = await prompt.evaluate((element) => {
      const input = element as HTMLInputElement
      const inputRect = input.getBoundingClientRect()
      const barRect = input.parentElement?.getBoundingClientRect()
      const historyRect = input.nextElementSibling?.getBoundingClientRect()
      const lastControlRect = input.parentElement?.lastElementChild?.getBoundingClientRect()
      const style = getComputedStyle(input)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (context !== null) context.font = style.font
      const textWidth = context?.measureText(input.value).width ?? 0
      const paddingLeft = Number.parseFloat(style.paddingLeft)
      const paddingRight = Number.parseFloat(style.paddingRight)
      return {
        selectionStart: input.selectionStart,
        valueLength: input.value.length,
        scrollLeft: input.scrollLeft,
        scrollWidth: input.scrollWidth,
        clientWidth: input.clientWidth,
        inputRight: inputRect.right,
        barRight: barRect?.right ?? 0,
        historyLeft: historyRect?.left ?? 0,
        lastControlRight: lastControlRect?.right ?? 0,
        paddingLeft,
        paddingRight,
        textWidth,
        visibleTextEnd: paddingLeft + textWidth - input.scrollLeft,
        visibleTextLimit: input.clientWidth - paddingRight,
      }
    })
    expect(metrics.selectionStart).toBe(metrics.valueLength)
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
    expect(metrics.scrollLeft).toBeGreaterThan(0)
    expect(metrics.scrollWidth - metrics.scrollLeft).toBeLessThanOrEqual(metrics.clientWidth + 2)
    expect(metrics.visibleTextEnd).toBeLessThanOrEqual(metrics.clientWidth - 4)
    expect(metrics.inputRight).toBeLessThanOrEqual(metrics.historyLeft)
    expect(metrics.lastControlRight).toBeLessThanOrEqual(metrics.barRight + 1)
    await page.getByTitle('历史').click({ trial: true })

    const middleState = await prompt.evaluate((element) => {
      const input = element as HTMLInputElement
      const position = Math.floor(input.value.length / 2)
      input.setSelectionRange(position, position)
      input.scrollLeft = Math.floor(Math.max(0, input.scrollWidth - input.clientWidth) / 2)
      const scrollLeft = input.scrollLeft
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
      return { position, scrollLeft }
    })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    const middleResult = await prompt.evaluate((element) => {
      const input = element as HTMLInputElement
      return { selectionStart: input.selectionStart, scrollLeft: input.scrollLeft }
    })
    expect(middleResult.selectionStart).toBe(middleState.position)
    expect(Math.abs(middleResult.scrollLeft - middleState.scrollLeft)).toBeLessThanOrEqual(1)
  }

  await expectLongPromptEndVisible(`${'这是一段用于验证 Vision 输入框横向滚动行为的长文本。'.repeat(18)}截图前末尾`)
  await page.mouse.move(100, 140)
  await page.mouse.down()
  await page.mouse.move(560, 430, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('[data-screenpilot-vision-image="true"]')).toBeVisible()
  await expectLongPromptEndVisible(`${'这是一段用于验证截图后 Vision 输入框末尾文字仍然完整可见的长文本。'.repeat(18)}截图后末尾`)
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
  const answerPanel = page.locator('[data-screenpilot-answer-panel="true"]')
  const answerActions = page.locator('[data-screenpilot-answer-actions="true"]')
  await expect(answerPanel).toBeVisible()
  await expect(answerActions).toBeVisible()
  await expectTransparentAnswerActions(answerActions)
  await expectAnswerActionsLeftAligned(answerPanel)
  await expect.poll(async () => answerPanel.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const actions = element.querySelector<HTMLElement>('[data-screenpilot-answer-actions="true"]')?.getBoundingClientRect()
    if (actions === undefined) return false
    const settled = element.getAnimations().length === 0
    return settled && Math.abs(panel.bottom - actions.bottom) <= 1
  })).toBe(true)
  const answerPanelBox = await answerPanel.boundingBox()
  const answerActionsBox = await answerActions.boundingBox()
  expect(answerPanelBox).not.toBeNull()
  expect(answerActionsBox).not.toBeNull()
  if (answerPanelBox === null || answerActionsBox === null) throw new Error('Vision answer action geometry is missing')
  expect(Math.abs(answerPanelBox.y + answerPanelBox.height - (answerActionsBox.y + answerActionsBox.height))).toBeLessThanOrEqual(1)
  await page.getByTitle('历史').click()
  await expect(page.getByRole('button', { name: /What is visible/ })).toBeVisible()
  await expectAccessible(page)
  await expect(page).toHaveScreenshot('vision-answer.png')
})

test('Vision and OCR selection ants keep a continuous phase at animation loop boundaries', async ({ page }) => {
  test.setTimeout(60_000)

  for (const mode of ['chat', 'translate'] as const) {
    await installVisionTauriMock(page)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/?window=vision#vision?mode=${mode}`)
    await waitForVisionSelection(page)

    await page.mouse.move(900, 140)
    const ants = page.locator('rect.sharex-selection-dash[stroke="white"]')
    await expect(ants).toHaveCount(1)
    await expect(ants).toBeVisible()

    const samples = await ants.evaluate((element) => {
      const animation = element.getAnimations().find((candidate) => candidate instanceof CSSAnimation)
      if (animation === undefined) throw new Error('Selection dash animation is missing')
      const duration = Number(animation.effect?.getComputedTiming().duration)
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('Selection dash duration is invalid')
      const animationStyle = getComputedStyle(element)
      const dashPattern = (element.getAttribute('stroke-dasharray') ?? '')
        .trim()
        .split(/\s+/u)
        .map(Number)
      const period = dashPattern.reduce((total, length) => total + length, 0)
      if (!Number.isFinite(period) || period <= 0) throw new Error('Selection dash pattern is invalid')

      animation.pause()
      const sample = (time: number) => {
        animation.currentTime = time
        void element.getBoundingClientRect()
        return Number.parseFloat(getComputedStyle(element).strokeDashoffset)
      }
      const before = sample(duration - 0.5)
      const after = sample(duration + 0.5)
      const beforeSecond = sample(duration * 2 - 0.5)
      const afterSecond = sample(duration * 2 + 0.5)
      const middleBefore = sample(duration / 2 - 0.5)
      const middleAfter = sample(duration / 2 + 0.5)
      const normalizedPhase = (offset: number) => ((offset % period) + period) % period
      const circularDistance = (a: number, b: number) => {
        const distance = Math.abs(a - b)
        return Math.min(distance, period - distance)
      }

      return {
        before,
        after,
        beforeSecond,
        afterSecond,
        animationDuration: duration,
        animationIterationCount: animationStyle.animationIterationCount,
        animationName: animationStyle.animationName,
        animationTimingFunction: animationStyle.animationTimingFunction,
        middleBoundaryDistance: circularDistance(normalizedPhase(middleBefore), normalizedPhase(middleAfter)),
        firstBoundaryDistance: circularDistance(normalizedPhase(before), normalizedPhase(after)),
        secondBoundaryDistance: circularDistance(normalizedPhase(beforeSecond), normalizedPhase(afterSecond)),
      }
    })

    expect(samples.animationDuration).toBe(1000)
    expect(samples.animationIterationCount).toBe('infinite')
    expect(samples.animationName).toBe('screenpilot-sharex-marching-ants')
    expect(samples.animationTimingFunction).toBe('linear')
    expect(samples.firstBoundaryDistance).toBeLessThan(0.25)
    expect(samples.secondBoundaryDistance).toBeLessThan(0.25)
    expect(Math.abs(samples.firstBoundaryDistance - samples.middleBoundaryDistance)).toBeLessThan(0.05)
    expect(Math.abs(samples.secondBoundaryDistance - samples.middleBoundaryDistance)).toBeLessThan(0.05)

    expect(samples.before).toBeLessThan(0)
    expect(samples.after).toBeGreaterThan(-1)
  }
})

test('Vision prompt optimization preview keeps pointer focus free of red paint', async ({ page }) => {
  await installVisionTauriMock(page)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)

  await page.mouse.move(100, 140)
  await page.mouse.down()
  await page.mouse.move(560, 430, { steps: 8 })
  await page.mouse.up()
  const prompt = page.getByPlaceholder('问点什么...')
  await prompt.fill('Explain the visible content.')
  const optimize = page.getByRole('button', { name: '优化', exact: true })
  await expect(optimize).toBeEnabled()
  await optimize.click()

  const preview = page.locator('[data-screenpilot-vision-prompt-preview="true"]')
  await expect(preview).toBeVisible()
  const previewEditor = preview.locator('textarea')
  await expect(previewEditor).toBeVisible()
  const unfocusedStyle = await focusPaintStyle(previewEditor)
  await previewEditor.click()
  const pointerStyle = await focusPaintStyle(previewEditor)
  expect(pointerStyle.outlineStyle).toBe('none')
  expect(pointerStyle.outlineWidth).toBe('0px')
  expect(pointerStyle.outlineOffset).toBe('0px')
  expect(pointerStyle.boxShadow).toBe('none')
  expect(pointerStyle.border).toBe(unfocusedStyle.border)
  expect(`${pointerStyle.outlineStyle} ${pointerStyle.border} ${pointerStyle.boxShadow}`).not.toMatch(RED_FOCUS_PAINT)

  await previewEditor.fill('Edited optimized prompt.')
  await expect(previewEditor).toHaveValue('Edited optimized prompt.')

  // Shift+Tab from the discard button returns keyboard focus to the
  // textarea, proving the no-ring rule also covers :focus-visible.
  const discard = preview.getByRole('button', { name: '放弃', exact: true })
  await discard.focus()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => previewEditor.evaluate((element) => document.activeElement === element)).toBe(true)
  const keyboardStyle = await focusPaintStyle(previewEditor)
  expect(keyboardStyle.outlineStyle).toBe('none')
  expect(keyboardStyle.outlineWidth).toBe('0px')
  expect(keyboardStyle.outlineOffset).toBe('0px')
  expect(keyboardStyle.boxShadow).toBe('none')
  expect(keyboardStyle.border).toBe(unfocusedStyle.border)
  expect(`${keyboardStyle.outlineStyle} ${keyboardStyle.border} ${keyboardStyle.boxShadow}`).not.toMatch(RED_FOCUS_PAINT)

  // Recompute once under the dark media query as well; the adapter rule is
  // theme-independent and must keep the same no-paint contract.
  await page.emulateMedia({ colorScheme: 'dark' })
  const darkStyle = await focusPaintStyle(previewEditor)
  expect(darkStyle.outlineStyle).toBe('none')
  expect(darkStyle.outlineWidth).toBe('0px')
  expect(darkStyle.outlineOffset).toBe('0px')
  expect(darkStyle.boxShadow).toBe('none')
  expect(darkStyle.border).toBe(unfocusedStyle.border)

  await discard.click()
  await expect(preview).toBeHidden()
})

test('Vision prompt preview reuses the large-model native edge resize frame', async ({ page }) => {
  test.setTimeout(60_000)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const captureAndWait = async (targetPage: Page) => {
    await targetPage.mouse.move(100, 140)
    await targetPage.mouse.down()
    await targetPage.mouse.move(560, 430, { steps: 8 })
    await targetPage.mouse.up()
    await expect(targetPage.getByPlaceholder('问点什么...')).toBeVisible()
  }

  await installVisionTauriMock(page, undefined, false)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)
  await captureAndWait(page)
  await page.getByPlaceholder('问点什么...').fill('Answer with the shared dialog frame.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()

  const answer = page.locator('[data-screenpilot-answer-panel="true"]')
  await expect(answer).toBeVisible()
  await expect.poll(async () => Math.round((await answer.boundingBox())?.height ?? 0)).toBe(216)
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
    }
  ).__SCREENPILOT_TEST__.floatingRect?.height ?? 0)).toBe(282)
  const answerInitial = await answer.boundingBox()
  if (answerInitial === null) throw new Error('Large-model answer geometry is missing')
  const answerNative = await page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
    }
  ).__SCREENPILOT_TEST__.floatingRect)
  if (answerNative === null) throw new Error('Large-model native geometry is missing')
  expect(Math.abs(answerNative.height - (answerInitial.height + 66))).toBeLessThanOrEqual(1)

  await page.setViewportSize({
    width: Math.round(answerNative.width),
    height: Math.round(answerNative.height),
  })
  await expect(answer).toHaveAttribute('data-screenpilot-floating-dialog-card', 'true')
  await expectSettledViewportBottom(answer, Math.round(answerNative.height))
  const answerFloatingInitial = await answer.boundingBox()
  if (answerFloatingInitial === null) throw new Error('Floating answer geometry is missing')
  expect(Math.abs(answerFloatingInitial.y + answerFloatingInitial.height - answerNative.height)).toBeLessThanOrEqual(1)

  await page.setViewportSize({
    width: Math.round(answerNative.width),
    height: Math.round(answerNative.height + 120),
  })
  await expect.poll(async () => (await answer.boundingBox())?.height ?? 0)
    .toBeGreaterThan(answerFloatingInitial.height + 100)
  await expectSettledViewportBottom(answer, Math.round(answerNative.height + 120))
  const answerExpanded = await answer.boundingBox()
  if (answerExpanded === null) throw new Error('Expanded answer geometry is missing')
  expect(Math.abs(answerExpanded.y + answerExpanded.height - (answerNative.height + 120))).toBeLessThanOrEqual(1)

  const promptPage = await page.context().newPage()
  promptPage.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  promptPage.on('pageerror', (error) => pageErrors.push(error.message))
  await installVisionTauriMock(promptPage, undefined, false)
  await promptPage.setViewportSize({ width: 1280, height: 720 })
  await promptPage.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(promptPage)
  await captureAndWait(promptPage)
  const prompt = promptPage.getByPlaceholder('问点什么...')
  await prompt.fill('Explain the visible content. '.repeat(30))
  await promptPage.getByRole('button', { name: '优化', exact: true }).click()

  const preview = promptPage.locator('[data-screenpilot-vision-prompt-preview="true"]')
  const editor = preview.locator('textarea')
  await expect(preview).toBeVisible()
  await expect(editor).toBeVisible()
  await expect(preview.locator('.screenpilot-vision-prompt-preview-resize-handle')).toHaveCount(0)
  const promptInitial = await preview.boundingBox()
  if (promptInitial === null) throw new Error('Prompt preview initial geometry is missing')
  expect(Math.abs(promptInitial.height - answerInitial.height)).toBeLessThanOrEqual(1)

  const promptNative = await promptPage.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
    }
  ).__SCREENPILOT_TEST__.floatingRect)
  if (promptNative === null) throw new Error('Prompt preview native geometry is missing')
  expect(Math.abs(promptNative.height - answerNative.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(promptNative.height - (promptInitial.height + 66))).toBeLessThanOrEqual(1)

  await promptPage.setViewportSize({
    width: Math.round(promptNative.width),
    height: Math.round(promptNative.height),
  })
  await expect(preview).toHaveAttribute('data-screenpilot-floating-dialog-card', 'true')
  await expectSettledViewportBottom(preview, Math.round(promptNative.height))
  const promptFloatingInitial = await preview.boundingBox()
  if (promptFloatingInitial === null) throw new Error('Floating prompt geometry is missing')
  expect(Math.abs(promptFloatingInitial.height - answerFloatingInitial.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(promptFloatingInitial.y + promptFloatingInitial.height - promptNative.height)).toBeLessThanOrEqual(1)

  await promptPage.setViewportSize({
    width: Math.round(promptNative.width),
    height: Math.round(promptNative.height + 120),
  })
  await expect.poll(async () => (await preview.boundingBox())?.height ?? 0)
    .toBeGreaterThan(promptFloatingInitial.height + 100)
  await expectSettledViewportBottom(preview, Math.round(promptNative.height + 120))
  const promptExpanded = await preview.boundingBox()
  if (promptExpanded === null) throw new Error('Expanded prompt geometry is missing')
  expect(Math.abs(promptExpanded.height - answerExpanded.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(promptExpanded.y + promptExpanded.height - (promptNative.height + 120))).toBeLessThanOrEqual(1)
  const promptResizeFeedback = await promptPage.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }
  ).__SCREENPILOT_TEST__.floatingRects.at(-1))
  if (promptResizeFeedback === undefined) throw new Error('Prompt preview resize feedback is missing')
  // The vendor prompt observer reports the card using a 64px chrome model,
  // while the painted frame is 66px. The native command treats this 2px
  // self-report as feedback and must not resize the window back underneath
  // the user's edge drag.
  expect(Math.abs(promptResizeFeedback.height - (promptNative.height + 120))).toBeLessThanOrEqual(2)

  const promptMinimumHeight = Math.round(promptInitial.height)
  await promptPage.setViewportSize({
    width: Math.round(promptNative.width),
    height: Math.round(promptNative.height - 200),
  })
  await expect.poll(async () => (await preview.boundingBox())?.height ?? 0)
    .toBe(promptMinimumHeight)

  await promptPage.setViewportSize({
    width: Math.round(promptNative.width),
    height: Math.round(promptNative.height + 120),
  })
  await expect.poll(async () => (await preview.boundingBox())?.height ?? 0)
    .toBeGreaterThan(promptInitial.height + 100)

  await editor.fill('Edited line '.repeat(250))
  const editorMetrics = await editor.evaluate((element) => {
    if (!(element instanceof HTMLTextAreaElement)) return null
    element.scrollTop = element.scrollHeight
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }
  })
  if (editorMetrics === null) throw new Error('Vision prompt preview editor is missing')
  expect(editorMetrics.scrollHeight).toBeGreaterThan(editorMetrics.clientHeight)
  expect(editorMetrics.scrollTop).toBeGreaterThan(0)

  await preview.getByRole('button', { name: '放弃', exact: true }).click()
  await expect(preview).toBeHidden()
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) => !message.includes('flushSync was called from inside a lifecycle method'),
  )
  expect(unexpectedConsoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
  await promptPage.close()
})

test('Vision text-only answer and prompt optimization use the expanded native frame', async ({ page }) => {
  test.setTimeout(60_000)

  const prepare = async (targetPage: Page) => {
    await installVisionTauriMock(targetPage, undefined, false)
    await targetPage.setViewportSize({ width: 1280, height: 720 })
    await targetPage.goto('/?window=vision#vision?mode=chat')
    await waitForVisionSelection(targetPage)
    await expect(targetPage.locator('[data-screenpilot-vision-image="false"]')).toBeVisible()
  }

  await prepare(page)
  const prompt = page.getByPlaceholder('问点什么...')
  await prompt.fill('Answer without a screenshot.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()
  const answer = page.locator('[data-screenpilot-answer-panel="true"]')
  await expect(answer).toBeVisible()
  await expect.poll(async () => Math.round((await answer.boundingBox())?.height ?? 0)).toBe(324)
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
    }
  ).__SCREENPILOT_TEST__.floatingRect?.height ?? 0)).toBe(390)
  const answerNative = await page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingRect: { width: number; height: number } | null
        floatingMinimumHeight: number
        floatingHasScreenshot: boolean
      }
    }
  ).__SCREENPILOT_TEST__)
  if (answerNative.floatingRect === null) throw new Error('Text-only native geometry is missing')
  expect(answerNative.floatingRect.height).toBe(390)
  expect(answerNative.floatingMinimumHeight).toBe(390)
  expect(answerNative.floatingHasScreenshot).toBe(false)

  await page.setViewportSize({ width: Math.round(answerNative.floatingRect.width), height: 190 })
  await expect.poll(async () => Math.round((await answer.boundingBox())?.height ?? 0)).toBe(324)
  await page.setViewportSize({ width: Math.round(answerNative.floatingRect.width), height: 510 })
  await expect.poll(async () => Math.round((await answer.boundingBox())?.height ?? 0)).toBeGreaterThan(424)

  const promptPage = await page.context().newPage()
  await prepare(promptPage)
  await promptPage.getByPlaceholder('问点什么...').fill('Optimize without a screenshot.')
  await promptPage.getByRole('button', { name: '优化', exact: true }).click()
  const preview = promptPage.locator('[data-screenpilot-vision-prompt-preview="true"]')
  await expect(preview).toBeVisible()
  await expect.poll(async () => Math.round((await preview.boundingBox())?.height ?? 0)).toBe(324)
  const promptNative = await promptPage.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingRect: { width: number; height: number } | null
        floatingMinimumHeight: number
        floatingHasScreenshot: boolean
      }
    }
  ).__SCREENPILOT_TEST__)
  if (promptNative.floatingRect === null) throw new Error('Text-only prompt native geometry is missing')
  expect(promptNative.floatingRect.height).toBe(390)
  expect(promptNative.floatingMinimumHeight).toBe(390)
  expect(promptNative.floatingHasScreenshot).toBe(false)
  await promptPage.setViewportSize({ width: Math.round(promptNative.floatingRect.width), height: 190 })
  await expect.poll(async () => Math.round((await preview.boundingBox())?.height ?? 0)).toBe(324)
  await promptPage.setViewportSize({ width: Math.round(promptNative.floatingRect.width), height: 510 })
  await expect.poll(async () => Math.round((await preview.boundingBox())?.height ?? 0)).toBeGreaterThan(424)
  await promptPage.close()
})

test('Vision floating surface keeps its client geometry after horizontal and vertical edge resizes', async ({ page }) => {
  test.setTimeout(180_000)

  const exercise = async (
    targetPage: Page,
    hasScreenshot: boolean,
    horizontalFirst: boolean,
    surface: 'answer' | 'prompt',
  ) => {
    await installVisionTauriMock(targetPage, undefined, false)
    await targetPage.setViewportSize({ width: 1280, height: 720 })
    await targetPage.goto(`/?window=vision#vision?mode=chat`)
    await waitForVisionSelection(targetPage)

    if (hasScreenshot) {
      await targetPage.mouse.move(120, 160)
      await targetPage.mouse.down()
      await targetPage.mouse.move(620, 460, { steps: 8 })
      await targetPage.mouse.up()
      await expect(targetPage.locator('[data-screenpilot-vision-image="true"]')).toBeVisible()

      // keepFullscreen=false normally clears the fullscreen region while the
      // capture is rebased. Seed one stale region after that transition so
      // the next floating feedback update proves the native clear path rather
      // than merely observing an initially-null mock value.
      await targetPage.evaluate(async () => {
        const testWindow = window as typeof window & {
          __TAURI_INTERNALS__: {
            invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
          }
        }
        await testWindow.__TAURI_INTERNALS__.invoke('vision_set_hit_region', {
          rect: { x: 0, y: 0, width: 24, height: 24 },
        })
      })
      await expect.poll(async () => targetPage.evaluate(() => (
        window as typeof window & {
          __SCREENPILOT_TEST__: { floatingHitRegion: unknown }
        }
      ).__SCREENPILOT_TEST__.floatingHitRegion)).not.toBeNull()
    }
    await targetPage.getByPlaceholder('问点什么...').fill(
      hasScreenshot ? 'Resize the captured frame.' : 'Resize the text-only frame.',
    )
    if (surface === 'prompt') {
      await targetPage.getByRole('button', { name: '优化', exact: true }).click()
    } else {
      await targetPage.locator('button:has(svg.lucide-arrow-up)').click()
    }

    const cardSelector = surface === 'prompt'
      ? '[data-screenpilot-vision-prompt-preview="true"]'
      : '[data-screenpilot-answer-panel="true"]'
    const card = targetPage.locator(cardSelector)
    await expect(card).toBeVisible()
    await expect.poll(async () => targetPage.evaluate(() => (
      window as typeof window & {
        __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } | null }
      }
    ).__SCREENPILOT_TEST__.floatingRect)).not.toBeNull()
    const native = await targetPage.evaluate(() => (
      window as typeof window & {
        __SCREENPILOT_TEST__: { floatingRect: { width: number; height: number } }
      }
    ).__SCREENPILOT_TEST__.floatingRect)
    const resizedWidth = Math.round(native.width + 160)
    const resizedHeight = Math.round(native.height + 120)

    const assertSurfaceMatchesViewport = async () => {
      await expect.poll(async () => targetPage.evaluate((selector: string) => {
        const panel = document.querySelector<HTMLElement>(selector)
        const frame = document.querySelector<HTMLElement>('[data-screenpilot-prompt-panel="true"]')
        if (panel === null || frame === null) return null
        const panelRect = panel.getBoundingClientRect()
        const frameRect = frame.getBoundingClientRect()
        return {
          floating: panel.dataset.screenpilotFloatingDialogCard === 'true',
          viewportWidth: Math.round(window.innerWidth),
          viewportHeight: Math.round(window.innerHeight),
          frameRight: Math.round(frameRect.right),
          panelRight: Math.round(panelRect.right),
          panelBottom: Math.round(panelRect.bottom),
          hitRegionCleared: (window as typeof window & {
            __SCREENPILOT_TEST__: { floatingHitRegion: unknown }
          }).__SCREENPILOT_TEST__.floatingHitRegion === null,
        }
      }, cardSelector)).toEqual({
        floating: true,
        viewportWidth: horizontalFirst ? resizedWidth : Math.round(native.width),
        viewportHeight: horizontalFirst ? Math.round(native.height) : resizedHeight,
        frameRight: horizontalFirst ? resizedWidth : Math.round(native.width),
        panelRight: horizontalFirst ? resizedWidth : Math.round(native.width),
        panelBottom: horizontalFirst ? Math.round(native.height) : resizedHeight,
        hitRegionCleared: true,
      })
    }

    if (horizontalFirst) {
      await targetPage.setViewportSize({ width: resizedWidth, height: Math.round(native.height) })
      await assertSurfaceMatchesViewport()
      await targetPage.setViewportSize({ width: resizedWidth, height: resizedHeight })
    } else {
      await targetPage.setViewportSize({ width: Math.round(native.width), height: resizedHeight })
      await assertSurfaceMatchesViewport()
      await targetPage.setViewportSize({ width: resizedWidth, height: resizedHeight })
    }
    await expect.poll(async () => targetPage.evaluate((selector: string) => {
      const panel = document.querySelector<HTMLElement>(selector)
      const frame = document.querySelector<HTMLElement>('[data-screenpilot-prompt-panel="true"]')
      if (panel === null || frame === null) return null
      const panelRect = panel.getBoundingClientRect()
      const frameRect = frame.getBoundingClientRect()
      return {
        floating: panel.dataset.screenpilotFloatingDialogCard === 'true',
        viewportWidth: Math.round(window.innerWidth),
        viewportHeight: Math.round(window.innerHeight),
        frameRight: Math.round(frameRect.right),
        panelRight: Math.round(panelRect.right),
        panelBottom: Math.round(panelRect.bottom),
        hitRegionCleared: (window as typeof window & {
          __SCREENPILOT_TEST__: { floatingHitRegion: unknown }
        }).__SCREENPILOT_TEST__.floatingHitRegion === null,
      }
    }, cardSelector)).toEqual({
      floating: true,
      viewportWidth: resizedWidth,
      viewportHeight: resizedHeight,
      frameRight: resizedWidth,
      panelRight: resizedWidth,
      panelBottom: resizedHeight,
      hitRegionCleared: true,
    })

    // Shrink both edges again while staying above the native profile minimum;
    // this catches stale width/height feedback in the reverse direction.
    const shrinkWidth = Math.round(native.width + 80)
    const shrinkHeight = Math.round(native.height + 40)
    await targetPage.setViewportSize({ width: shrinkWidth, height: shrinkHeight })
    await expect.poll(async () => targetPage.evaluate((selector) => {
      const panel = document.querySelector<HTMLElement>(selector)
      const frame = document.querySelector<HTMLElement>('[data-screenpilot-prompt-panel="true"]')
      if (panel === null || frame === null) return null
      const panelRect = panel.getBoundingClientRect()
      const frameRect = frame.getBoundingClientRect()
      return {
        floating: panel.dataset.screenpilotFloatingDialogCard === 'true',
        viewportWidth: Math.round(window.innerWidth),
        viewportHeight: Math.round(window.innerHeight),
        frameRight: Math.round(frameRect.right),
        panelRight: Math.round(panelRect.right),
        panelBottom: Math.round(panelRect.bottom),
      }
    }, cardSelector)).toEqual({
      floating: true,
      viewportWidth: shrinkWidth,
      viewportHeight: shrinkHeight,
      frameRight: shrinkWidth,
      panelRight: shrinkWidth,
      panelBottom: shrinkHeight,
    })
  }

  await exercise(page, true, true, 'answer')
  const verticalFirstScreenshot = await page.context().newPage()
  await exercise(verticalFirstScreenshot, true, false, 'answer')
  await verticalFirstScreenshot.close()
  const horizontalFirstText = await page.context().newPage()
  await exercise(horizontalFirstText, false, true, 'answer')
  await horizontalFirstText.close()
  const verticalFirstText = await page.context().newPage()
  await exercise(verticalFirstText, false, false, 'answer')
  await verticalFirstText.close()

  const horizontalFirstPromptScreenshot = await page.context().newPage()
  await exercise(horizontalFirstPromptScreenshot, true, true, 'prompt')
  await horizontalFirstPromptScreenshot.close()
  const verticalFirstPromptScreenshot = await page.context().newPage()
  await exercise(verticalFirstPromptScreenshot, true, false, 'prompt')
  await verticalFirstPromptScreenshot.close()
  const horizontalFirstPromptText = await page.context().newPage()
  await exercise(horizontalFirstPromptText, false, true, 'prompt')
  await horizontalFirstPromptText.close()
  const verticalFirstPromptText = await page.context().newPage()
  await exercise(verticalFirstPromptText, false, false, 'prompt')
  await verticalFirstPromptText.close()
})

test('Vision floating layout retries a deferred native resize before recording success', async ({ page }) => {
  test.setTimeout(60_000)
  // Make the first positioned native set deliberately report deferred. The
  // retry helper must leave the cache untouched until the following applied
  // response, then settle without an unbounded ordinary-feedback loop.
  await installVisionTauriMock(page, undefined, false, undefined, 0, 1)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)
  await page.getByPlaceholder('问点什么...').fill('Retry after native sizing.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()

  const answer = page.locator('[data-screenpilot-answer-panel="true"]')
  await expect(answer).toBeVisible()
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingDeferredRects: { width: number; height: number }[]
        floatingAppliedRects: { width: number; height: number }[]
        floatingRect: { width: number; height: number } | null
      }
    }
  ).__SCREENPILOT_TEST__.floatingDeferredRects.length)).toBeGreaterThan(0)
  await expect.poll(async () => page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingAppliedRects: { width: number; height: number }[]
      }
    }
  ).__SCREENPILOT_TEST__.floatingAppliedRects.length)).toBeGreaterThan(0)

  const native = await page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingRect: { width: number; height: number } | null
        floatingRects: { width: number; height: number }[]
      }
    }
  ).__SCREENPILOT_TEST__)
  if (native.floatingRect === null) throw new Error('Retried native geometry is missing')
  expect(native.floatingRect.height).toBe(390)
  expect(native.floatingRects.length).toBeLessThan(12)

  const profileParity = await page.evaluate(async () => {
    const testWindow = window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingRect: { width: number; height: number } | null
        floatingHasScreenshot: boolean
      }
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      }
    }
    await testWindow.__TAURI_INTERNALS__.invoke('vision_set_floating', {
      rect: { width: 480, height: 390, hasScreenshot: false },
    })
    const textOnly = {
      height: testWindow.__SCREENPILOT_TEST__.floatingRect?.height ?? 0,
      hasScreenshot: testWindow.__SCREENPILOT_TEST__.floatingHasScreenshot,
    }
    await testWindow.__TAURI_INTERNALS__.invoke('vision_set_floating', {
      rect: { width: 480, height: 282 },
    })
    const compact = {
      height: testWindow.__SCREENPILOT_TEST__.floatingRect?.height ?? 0,
      hasScreenshot: testWindow.__SCREENPILOT_TEST__.floatingHasScreenshot,
    }
    await testWindow.__TAURI_INTERNALS__.invoke('vision_fly_floating', {
      rect: {
        from: { x: 0, y: 0 },
        to: { x: 4, y: 4 },
        width: 480,
        height: 56,
      },
    })
    return {
      textOnly,
      compact,
      omittedFlyHasScreenshot: testWindow.__SCREENPILOT_TEST__.floatingHasScreenshot,
    }
  })
  expect(profileParity.textOnly).toEqual({ height: 390, hasScreenshot: false })
  expect(profileParity.compact).toEqual({ height: 282, hasScreenshot: true })
  expect(profileParity.omittedFlyHasScreenshot).toBe(true)
})

test('Vision mode transitions replace the previous screenshot height profile', async ({ page }) => {
  test.setTimeout(60_000)
  await installVisionTauriMock(page, undefined, false)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)

  await page.getByPlaceholder('问点什么...').fill('Text history before the screenshot.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()
  await expect(page.locator('[data-screenpilot-answer-panel="true"]')).toBeVisible()
  await expect(page.getByTitle('历史')).toContainText('1')
  await page.getByRole('button', { name: '关闭' }).click()
  await page.reload()
  await waitForVisionSelection(page)

  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await page.mouse.up()
  await page.getByPlaceholder('问点什么...').fill('Screenshot history after text-only.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()
  const screenshotAnswer = page.locator('[data-screenpilot-answer-panel="true"]')
  await expect(screenshotAnswer).toBeVisible()
  await expect.poll(async () => Math.round((await screenshotAnswer.boundingBox())?.height ?? 0)).toBe(216)
  await expect(page.locator('[data-screenpilot-vision-image="true"]')).toBeVisible()

  await page.getByTitle('历史').click()
  const textHistory = page.getByRole('button', { name: /Text history before the screenshot/ }).first()
  await expect(textHistory).toBeVisible()
  await textHistory.click()
  const restoredTextAnswer = page.locator('[data-screenpilot-answer-panel="true"]')
  await expect(page.locator('[data-screenpilot-vision-image="false"]')).toBeVisible()
  await expect.poll(async () => Math.round((await restoredTextAnswer.boundingBox())?.height ?? 0)).toBe(324)
  const restoredNative = await page.evaluate(() => (
    window as typeof window & {
      __SCREENPILOT_TEST__: {
        floatingRect: { width: number; height: number } | null
        floatingMinimumHeight: number
        floatingHasScreenshot: boolean
      }
    }
  ).__SCREENPILOT_TEST__)
  if (restoredNative.floatingRect === null) throw new Error('Restored text-only native geometry is missing')
  expect(restoredNative.floatingRect.height).toBe(390)
  expect(restoredNative.floatingMinimumHeight).toBe(390)
  expect(restoredNative.floatingHasScreenshot).toBe(false)

  await page.reload()
  await waitForVisionSelection(page)
  await expect(page.locator('[data-screenpilot-vision-image="false"]')).toBeVisible()
  await expect(page.locator('[data-screenpilot-answer-panel="true"]')).toHaveCount(0)
})

test('Vision answer actions stay pinned while long responses scroll', async ({ page }) => {
  await installVisionTauriMock(page, undefined, true, undefined, 1_200)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=chat')
  await waitForVisionSelection(page)
  await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { answerText: string }
    }).__SCREENPILOT_TEST__
    state.answerText = Array.from({ length: 80 }, (_, index) => (
      `Response line ${String(index + 1)} keeps the Vision answer body long enough to scroll.`
    )).join('\n')
  })
  await page.mouse.move(100, 140)
  await page.mouse.down()
  await page.mouse.move(560, 430, { steps: 8 })
  await page.mouse.up()
  await page.getByPlaceholder('问点什么...').fill('Give a long response.')
  await page.locator('button:has(svg.lucide-arrow-up)').click()

  const answerPanel = page.locator('[data-screenpilot-answer-panel="true"]')
  const answerActions = page.locator('[data-screenpilot-answer-actions="true"]')
  const answerBody = answerPanel.locator('[data-screenpilot-answer-scroll="true"]')
  await expect(answerActions).toBeVisible()
  await expectTransparentAnswerActions(answerActions)
  await expectAnswerActionsLeftAligned(answerPanel)
  const stopButton = answerActions.getByRole('button', { name: '停止', exact: true })
  await expect(stopButton).toBeVisible()
  await expect.poll(async () => answerPanel.evaluate((element) => {
    const scroll = element.querySelector('[data-screenpilot-answer-scroll="true"]')
    if (!(scroll instanceof HTMLElement)) return false
    return scroll.scrollHeight > scroll.clientHeight
  })).toBe(true)
  await expect.poll(async () => answerPanel.evaluate((element) => {
    const panel = element.getBoundingClientRect()
    const actions = element.querySelector<HTMLElement>('[data-screenpilot-answer-actions="true"]')?.getBoundingClientRect()
    if (actions === undefined) return false
    const settled = element.getAnimations().length === 0
    return settled && Math.abs(panel.bottom - actions.bottom) <= 2
  })).toBe(true)

  const panelBox = await answerPanel.boundingBox()
  const actionsBox = await answerActions.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  if (panelBox === null || actionsBox === null) throw new Error('Long Vision answer geometry is missing')
  const bottomGap = panelBox.y + panelBox.height - (actionsBox.y + actionsBox.height)
  expect(Math.abs(bottomGap)).toBeLessThanOrEqual(2)

  await answerBody.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error('Vision answer scroll body is missing')
    element.scrollTop = Math.floor(element.scrollHeight / 2)
  })
  const middleActionsBox = await answerActions.boundingBox()
  expect(middleActionsBox).not.toBeNull()
  if (middleActionsBox === null) throw new Error('Middle-scroll Vision action geometry is missing')
  expect(Math.abs(middleActionsBox.y - actionsBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(middleActionsBox.x - actionsBox.x)).toBeLessThanOrEqual(1)
  await expectAnswerActionsLeftAligned(answerPanel)

  await answerBody.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error('Vision answer scroll body is missing')
    element.scrollTop = element.scrollHeight
  })
  const scrolledActionsBox = await answerActions.boundingBox()
  expect(scrolledActionsBox).not.toBeNull()
  if (scrolledActionsBox === null) throw new Error('Scrolled Vision action geometry is missing')
  expect(Math.abs(scrolledActionsBox.y - actionsBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrolledActionsBox.x - actionsBox.x)).toBeLessThanOrEqual(1)
  await expectAnswerActionsLeftAligned(answerPanel)

  const finalLineVisibility = await answerPanel.evaluate((element) => {
    const actions = element.querySelector<HTMLElement>('[data-screenpilot-answer-actions="true"]')
    const scroll = element.querySelector<HTMLElement>('[data-screenpilot-answer-scroll="true"]')
    if (actions === null || scroll === null) return null
    const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    while (walker.nextNode()) {
      const candidate = walker.currentNode
      if (candidate.textContent?.includes('Response line 80') === true) {
        node = candidate as Text
        break
      }
    }
    if (node === null) return null
    const start = node.textContent.indexOf('Response line 80')
    if (start < 0) return null
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 'Response line 80'.length)
    const rect = range.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    return { textBottom: rect.bottom, actionsTop: actionsRect.top }
  })
  expect(finalLineVisibility).not.toBeNull()
  if (finalLineVisibility === null) throw new Error('Final Vision response line is missing')
  expect(finalLineVisibility.textBottom).toBeLessThanOrEqual(finalLineVisibility.actionsTop + 1)

  await expect(stopButton).toBeHidden()
  const completedActionsBox = await answerActions.boundingBox()
  expect(completedActionsBox).not.toBeNull()
  if (completedActionsBox === null) throw new Error('Completed Vision action geometry is missing')
  expect(Math.abs(completedActionsBox.y - actionsBox.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(completedActionsBox.x - actionsBox.x)).toBeLessThanOrEqual(1)
  await expectAnswerActionsLeftAligned(answerPanel)
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
  await expectFrostedTransparency(page.locator('[data-screenpilot-ocr-card="true"]'))
  await expectEdgeSafeFrame(page.locator('[data-screenpilot-window-frame="true"]', { has: page.getByText(/ScreenPilot 视觉测试/) }))
  const sourceLanguage = page.getByRole('combobox', { name: '源语言' })
  const targetLanguage = page.getByRole('combobox', { name: '目标语言' })
  await expect(sourceLanguage).toHaveValue('auto')
  await expect(targetLanguage).toHaveValue('auto')
  const sourceLanguageLabel = page.getByText('源语言', { exact: true })
  const targetLanguageLabel = page.getByText('目标语言', { exact: true })
  const ocrEngine = page.locator('[data-screenpilot-original-heading="true"] select:not([data-screenpilot-source-language-select="true"])')
  const translationEngine = page.locator('select[data-screenpilot-translation-method="true"]')
  await expect(sourceLanguageLabel).toBeVisible()
  await expect(ocrEngine).toBeVisible()
  await expect(targetLanguageLabel).toBeVisible()
  await expect(translationEngine).toBeVisible()
  const geometry = await page.evaluate(() => {
    const sourceHeading = document.querySelector('[data-screenpilot-original-heading="true"]')
    const targetHeading = document.querySelector('[data-screenpilot-translated-heading="true"]')
    const sourceLabel = sourceHeading?.querySelector('.screenpilot-source-language-control label')
    const sourceLanguage = sourceHeading?.querySelector('#screenpilot-source-language')
    const sourceEngine = sourceHeading?.querySelector('select:not([data-screenpilot-source-language-select="true"])')
    const targetLabel = targetHeading?.querySelector('.screenpilot-target-language-control label')
    const targetLanguage = targetHeading?.querySelector('#screenpilot-target-language')
    const targetEngine = targetHeading?.querySelector('select[data-screenpilot-translation-method="true"]')
    if (!(sourceHeading instanceof HTMLElement)
      || !(targetHeading instanceof HTMLElement)
      || !(sourceLabel instanceof HTMLElement)
      || !(sourceLanguage instanceof HTMLElement)
      || !(sourceEngine instanceof HTMLElement)
      || !(targetLabel instanceof HTMLElement)
      || !(targetLanguage instanceof HTMLElement)
      || !(targetEngine instanceof HTMLElement)) return null
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }
    return {
      originalHeadingBox: rect(sourceHeading),
      sourceLanguageLabelBox: rect(sourceLabel),
      sourceLanguageBox: rect(sourceLanguage),
      ocrEngineBox: rect(sourceEngine),
      translatedHeadingBox: rect(targetHeading),
      targetLanguageLabelBox: rect(targetLabel),
      targetLanguageBox: rect(targetLanguage),
      translationEngineBox: rect(targetEngine),
    }
  })
  expect(geometry).not.toBeNull()
  if (geometry === null) throw new Error('OCR translation controls geometry is missing')
  const {
    originalHeadingBox,
    sourceLanguageLabelBox,
    sourceLanguageBox,
    ocrEngineBox,
    translatedHeadingBox,
    targetLanguageLabelBox,
    targetLanguageBox,
    translationEngineBox,
  } = geometry
  const centerY = (box: { y: number; height: number }) => box.y + box.height / 2
  expect(Math.abs(centerY(sourceLanguageLabelBox) - centerY(sourceLanguageBox))).toBeLessThanOrEqual(1)
  expect(Math.abs(centerY(sourceLanguageBox) - centerY(ocrEngineBox))).toBeLessThanOrEqual(1)
  expect(sourceLanguageLabelBox.x).toBeGreaterThan(originalHeadingBox.x + originalHeadingBox.width * 0.25)
  expect(sourceLanguageBox.x).toBeGreaterThan(sourceLanguageLabelBox.x + sourceLanguageLabelBox.width)
  expect(ocrEngineBox.x).toBeGreaterThan(sourceLanguageBox.x + sourceLanguageBox.width)
  expect(Math.abs(originalHeadingBox.x + originalHeadingBox.width - ocrEngineBox.x - ocrEngineBox.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(centerY(targetLanguageLabelBox) - centerY(targetLanguageBox))).toBeLessThanOrEqual(1)
  expect(Math.abs(centerY(targetLanguageBox) - centerY(translationEngineBox))).toBeLessThanOrEqual(1)
  expect(targetLanguageLabelBox.x).toBeGreaterThan(translatedHeadingBox.x + translatedHeadingBox.width * 0.25)
  expect(targetLanguageBox.x).toBeGreaterThan(targetLanguageLabelBox.x + targetLanguageLabelBox.width)
  expect(translationEngineBox.x).toBeGreaterThan(targetLanguageBox.x + targetLanguageBox.width)
  expect(Math.abs(translatedHeadingBox.x + translatedHeadingBox.width - translationEngineBox.x - translationEngineBox.width)).toBeLessThanOrEqual(1)
  expect(targetLanguageBox.width).toBeCloseTo(translationEngineBox.width, 0)
  expect(targetLanguageBox.height).toBeCloseTo(translationEngineBox.height, 0)
  expect(sourceLanguageBox.width).toBeCloseTo(targetLanguageBox.width, 0)
  expect(sourceLanguageBox.height).toBeCloseTo(targetLanguageBox.height, 0)
  const screenshotSelects = page.getByRole('combobox')
  await expect(screenshotSelects).toHaveCount(4)
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
  await sourceLanguage.selectOption('en')
  await expect(page.getByText(/编辑后译文\(auto\)：ScreenPilot Visual Test/)).toBeVisible()
  const sourceLanguageRequest = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: {
        translationRequests: { text: string; sourceLanguage: string; targetLanguage: string }[]
      }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.at(-1)
  })
  expect(sourceLanguageRequest?.sourceLanguage).toBe('en')
  expect(sourceLanguageRequest?.targetLanguage).toBe('auto')
  await targetLanguage.selectOption('en')
  await expect(page.getByText(/编辑后译文\(en\)：ScreenPilot Visual Test/)).toBeVisible()
  const languageRequest = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: {
        translationRequests: { text: string; sourceLanguage: string; targetLanguage: string }[]
      }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.at(-1)
  })
  expect(languageRequest?.sourceLanguage).toBe('en')
  expect(languageRequest?.targetLanguage).toBe('en')
  const source = page.locator('.ocr-editable')
  const translationRequestCount = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { translationRequests: unknown[] }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.length
  })
  await source.fill('Edited synthetic OCR source')
  await page.waitForTimeout(950)
  const earlyTranslationRequestCount = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { translationRequests: unknown[] }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.length
  })
  expect(earlyTranslationRequestCount).toBe(translationRequestCount)
  await expect(page.getByText('编辑后译文(en)：Edited synthetic OCR source')).toBeVisible({ timeout: 2_000 })
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { translationRequests: unknown[] }
    }).__SCREENPILOT_TEST__
    return state.translationRequests.length
  })).toBe(translationRequestCount + 1)
  await expect(sourceLanguage).toBeVisible()
  await expect(sourceLanguage).toHaveValue('en')
  await expect(targetLanguage).toBeVisible()
  await expect(targetLanguage).toHaveValue('en')
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
  await expect(sourceLanguage).toBeVisible()
  await expect(targetLanguage).toBeVisible()
  await expect(page).toHaveScreenshot('screenshot-translation-source-language.png')
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

    const card = page.locator('[data-screenpilot-answer-panel="true"][data-screenpilot-floating-dialog-card="true"]')
    await expect(card).toBeVisible()
    const initialBox = await card.boundingBox()
    expect(initialBox).not.toBeNull()
    if (initialBox === null) throw new Error('chat initial resize geometry is missing')

    const minimumHeight = Math.round(initialBox.height)
    await page.setViewportSize({ width, height: initialHeight - 180 })
    await expect.poll(async () => Math.round((await card.boundingBox())?.height ?? 0))
      .toBe(minimumHeight)
    const minimumBox = await card.boundingBox()
    if (minimumBox === null) throw new Error('chat minimum resize geometry is missing')
    expect(minimumBox.height).toBe(minimumHeight)

    const resizedHeight = initialHeight + 160
    await page.setViewportSize({ width, height: resizedHeight })
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

test('OCR floating geometry ignores one-pixel native width feedback', async ({ page }) => {
  await installVisionTauriMock(page, 'Short OCR text.', false, undefined, 0, 0, 1)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/?window=vision#vision?mode=translate')
  await waitForVisionSelection(page)
  await page.mouse.move(120, 160)
  await page.mouse.down()
  await page.mouse.move(620, 460, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByText('Short OCR text.')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & { __SCREENPILOT_TEST__: { floatingRect: unknown } }).__SCREENPILOT_TEST__
    return state.floatingRect !== null
  })).toBe(true)
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }).__SCREENPILOT_TEST__
    return state.floatingRects.length
  })).toBeGreaterThan(5)
  const requestCountBeforeTransform = await page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }).__SCREENPILOT_TEST__
    return state.floatingRects.length
  })
  await page.locator('[data-screenpilot-window-frame="true"]').evaluate((element) => {
    const card = element as HTMLElement
    card.style.transform = 'scale(0.8)'
  })
  await expect.poll(async () => page.evaluate(() => {
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }).__SCREENPILOT_TEST__
    return state.floatingRects.length
  })).toBeGreaterThan(requestCountBeforeTransform)
  const samples = await page.evaluate(async () => {
    const card = document.querySelector<HTMLElement>('[data-screenpilot-window-frame="true"]')
    if (card === null) return null
    const values: { x: number; width: number }[] = []
    for (let index = 0; index < 30; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const rect = card.getBoundingClientRect()
      values.push({ x: rect.x, width: rect.width })
    }
    const state = (window as typeof window & {
      __SCREENPILOT_TEST__: { floatingRects: { width: number; height: number }[] }
    }).__SCREENPILOT_TEST__
    return { values, floatingRects: state.floatingRects.slice() }
  })
  expect(samples).not.toBeNull()
  if (samples === null) throw new Error('OCR geometry sample is missing')
  expect(new Set(samples.values.map((rect) => `${Math.round(rect.x)}:${Math.round(rect.width)}`)).size).toBe(1)
  expect(new Set(samples.floatingRects.map((rect) => Math.round(rect.width))).size).toBe(1)
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
