import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engine = process.env.BROWSER || 'chromium'
const base = process.env.POOLTOOL_URL || 'http://127.0.0.1:4321'
const artifacts = process.env.ARTIFACT_DIR || path.resolve(`tests/artifacts/menu-audit-${engine}`)
await mkdir(artifacts, { recursive: true })
const browser = await playwright[engine].launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 600, height: 844 } })
const errors = [], checks = []
page.on('pageerror', error => errors.push(error.message))

async function inspectHeader(surface, width) {
  const header = page.locator(surface).locator('.club-header')
  const result = await header.evaluate(element => {
    const brand = element.querySelector('.club-brand').getBoundingClientRect()
    const account = element.querySelector('.club-account').getBoundingClientRect()
    const name = element.querySelector('.club-account-text > span')
    const style = getComputedStyle(element)
    return {
      viewport: innerWidth, shellScroll: element.closest('.club-shell').scrollWidth,
      paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight),
      brandLeft: brand.left, brandRight: brand.right, accountLeft: account.left, accountRight: account.right,
      gap: parseFloat(style.columnGap), nameOverflow: getComputedStyle(name).textOverflow,
      name: name.textContent,
    }
  })
  assert.ok(result.brandLeft >= result.paddingLeft - 1, JSON.stringify(result))
  assert.ok(result.accountRight <= width - result.paddingRight + 1, JSON.stringify(result))
  assert.ok(result.accountLeft - result.brandRight >= result.gap - 1, JSON.stringify(result))
  assert.ok(result.shellScroll <= width + 1, JSON.stringify(result))
  assert.equal(result.name, 'W'.repeat(32))
  assert.equal(result.nameOverflow, 'ellipsis')
  checks.push({ surface, width, ...result })
}

async function tabCycle() {
  const dialog = page.getByRole('dialog')
  const expectedCount = await dialog.evaluate(element => [...element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(node => {
    const collapsed = node.closest('details:not([open])')
    return node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[inert]') && (!collapsed || collapsed.querySelector(':scope > summary')?.contains(node))
  }).length)
  await dialog.evaluate(element => element.focus())
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true)
  const lastTag = await page.evaluate(() => document.activeElement.outerHTML)
  await page.keyboard.press('Tab')
  const firstTag = await page.evaluate(() => document.activeElement.outerHTML)
  assert.equal(await dialog.evaluate(element => element.querySelector('.club-brand') === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement.outerHTML), lastTag)
  await page.keyboard.press('Tab')
  for (let index = 0; index < expectedCount; index++) {
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true)
    await page.keyboard.press('Tab')
  }
  assert.equal(await page.evaluate(() => document.activeElement.outerHTML), firstTag)
  checks.push({ focusCycle: true, expectedCount })
}

async function homeGeometry() {
  return page.evaluate(() => Object.fromEntries(['.club-header', '.club-footer', '.club-main-menu', '.club-game-title', '.club-game-title > h1', '.club-action-primary', '.club-action:not(.club-action-primary)'].map(selector => {
    const element = document.querySelector(selector), rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return [selector, { top: rect.top, left: rect.left, width: rect.width, height: rect.height, gap: style.gap, lineHeight: style.lineHeight, fontSize: style.fontSize, fontWeight: style.fontWeight }]
  })))
}

function assertDesktopFigma(geometry) {
  assert.equal(geometry['.club-header'].height, 112)
  assert.equal(geometry['.club-footer'].height, 82)
  assert.equal(geometry['.club-main-menu'].gap, '32px')
  assert.equal(geometry['.club-main-menu'].width, 480)
  assert.equal(geometry['.club-main-menu'].left, 480)
  assert.equal(geometry['.club-game-title'].gap, '14px')
  assert.ok(Math.abs(geometry['.club-game-title'].height - 143) < 1, JSON.stringify(geometry))
  assert.equal(geometry['.club-game-title > h1'].fontSize, '70px')
  assert.ok(Math.abs(parseFloat(geometry['.club-game-title > h1'].lineHeight) - 89.6) < .01, JSON.stringify(geometry))
  assert.equal(geometry['.club-game-title > h1'].fontWeight, '400')
  assert.equal(geometry['.club-action-primary'].height, 62)
  assert.equal(geometry['.club-action-primary'].fontWeight, '600')
  assert.equal(geometry['.club-action:not(.club-action-primary)'].fontWeight, '500')
  assert.ok(Math.abs(geometry['.club-action-primary'].top - 385) < 1, JSON.stringify(geometry))
}

async function backGeometry(surface) {
  return page.locator(surface).locator('.club-action-back').evaluateAll(buttons => buttons.map(button => {
    const style = getComputedStyle(button), box = button.getBoundingClientRect()
    const peer = button.closest('.club-actions, .club-actions-inline')?.querySelector('.club-action:not(.club-action-back)')
    return { fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, minHeight: parseFloat(style.minHeight), height: box.height, peerHeight: peer?.getBoundingClientRect().height ?? null }
  }))
}

function assertBackFigma(buttons, width) {
  for (const button of buttons) {
    assert.equal(button.fontSize, '14px')
    assert.equal(button.fontWeight, '500')
    assert.equal(button.lineHeight, 'normal')
    assert.equal(button.minHeight, width <= 480 ? 56 : 62)
    assert.ok(button.height >= button.minHeight - .5, JSON.stringify(button))
    if (button.peerHeight !== null) assert.ok(Math.abs(button.height - button.peerHeight) < .5, JSON.stringify(button))
  }
}

try {
  await page.goto(`${base}/tests/club-menu-fixture.html`)
  await page.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.setViewportSize({ width: 1440, height: 900 })
  const figmaGeometry = await homeGeometry()
  assertDesktopFigma(figmaGeometry)
  await page.screenshot({ path: path.join(artifacts, 'home-figma-1440x900.png') })
  const formerLayout = await page.addStyleTag({ content: '.club-shell[data-club-view="menu"] > .club-header { flex-basis:90px; } .club-shell[data-club-view="menu"] > .club-footer { flex-basis:54px; } .club-shell[data-club-view="menu"] .club-main-menu { gap:27px; } .club-shell[data-club-view="menu"] .club-game-title { gap:11.7px; } .club-shell[data-club-view="menu"] .club-game-title > p { line-height:1.5; } .club-shell[data-club-view="menu"] .club-game-title h1 { line-height:1.15; }' })
  const negativeGeometry = await homeGeometry()
  assert.throws(() => assertDesktopFigma(negativeGeometry), assert.AssertionError)
  await formerLayout.evaluate(element => element.remove())
  assertDesktopFigma(await homeGeometry())
  checks.push({ desktopFigmaGeometry: true, sourceFrame: '96:14801', figmaGeometry, negativeControl: negativeGeometry })
  await page.getByRole('button', { name: 'Играть', exact: true }).click()
  await page.getByRole('button', { name: 'Игра с другом', exact: true }).click()
  await page.getByRole('button', { name: 'Настройки игры', exact: true }).click()
  const rulesGeometry = await page.locator('[data-club-view="rules"]').evaluate(shell => {
    const measure = selector => {
      const element = shell.querySelector(selector), rect = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, gap: style.gap, padding: style.padding, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight }
    }
    return { content: measure('.club-content'), card: measure('.club-card'), title: measure('.club-section-title > h1'), eyebrow: measure('.club-section-title > p'), parameters: measure('.club-parameters'), actions: measure('.club-rule-actions'), rowTops: [...shell.querySelectorAll('.club-parameters > .club-parameter')].map(row => row.getBoundingClientRect().top), note: shell.querySelector('.club-rule-actions > .club-small-note').textContent, scrollHeight: shell.scrollHeight, height: shell.clientHeight }
  })
  assert.equal(rulesGeometry.card.width, 680)
  assert.equal(rulesGeometry.card.left, 380)
  assert.equal(rulesGeometry.card.padding, '32px')
  assert.equal(rulesGeometry.parameters.gap, '10px')
  assert.equal(rulesGeometry.parameters.height, 382)
  assert.equal(rulesGeometry.actions.gap, '12px')
  assert.equal(rulesGeometry.note, 'Правила применятся к новой комнате.')
  assert.equal(rulesGeometry.content.height, 706)
  assert.equal(rulesGeometry.title.fontSize, '40px')
  assert.equal(rulesGeometry.title.fontWeight, '400')
  assert.equal(rulesGeometry.eyebrow.height, 12)
  assert.ok(rulesGeometry.card.bottom <= 818 && rulesGeometry.scrollHeight <= rulesGeometry.height + 1, JSON.stringify(rulesGeometry))
  for (let index = 1; index < rulesGeometry.rowTops.length; index++) assert.equal(rulesGeometry.rowTops[index] - rulesGeometry.rowTops[index - 1], 56)
  await page.screenshot({ path: path.join(artifacts, 'rules-figma-1440x900.png') })
  checks.push({ desktopRulesGeometry: true, sourceFrame: '96:15035', rulesGeometry })
  const backTypography = await backGeometry('[data-club-view="rules"]')
  assertBackFigma(backTypography, 1440)
  const formerBack = await page.addStyleTag({ content: '.club-shell .club-action-back, .club-settings-shell .club-action-back { font-size:18px !important; font-weight:500 !important; line-height:1.3 !important; }' })
  const backNegative = await backGeometry('[data-club-view="rules"]')
  assert.throws(() => assertBackFigma(backNegative, 1440), assert.AssertionError)
  await formerBack.evaluate(element => element.remove())
  assertBackFigma(await backGeometry('[data-club-view="rules"]'), 1440)
  checks.push({ backFigmaTypography: true, sourceFrame: '96:15115', backTypography, negativeControl: backNegative })
  await page.getByRole('button', { name: 'В главное меню', exact: true }).click()
  await page.setViewportSize({ width: 600, height: 844 })
  // Exercise the fixture's public name-editing flow rather than mutating Vue internals.
  await page.getByRole('button', { name: 'Профиль', exact: true }).click()
  await page.getByLabel('Имя игрока', { exact: true }).fill('W'.repeat(32))
  await page.getByRole('button', { name: 'Сохранить имя', exact: true }).click()
  await page.getByRole('button', { name: 'Назад', exact: true }).click()

  for (const width of [320, 390, 480, 481, 500, 600, 760, 768, 900, 1440, 1920]) {
    await page.setViewportSize({ width, height: 844 })
    for (const view of ['menu', 'play', 'profile', 'lobby', 'search']) {
      await page.evaluate(view => {
        window.clubFixture.view = view
        window.clubFixture.room = view === 'lobby' ? {
          id: 'fixture-room', code: 'ABC123', hostId: 'fixture-player',
          players: [{ id: 'fixture-player', displayName: 'W'.repeat(32), ready: false }, { id: 'friend', displayName: 'Ж'.repeat(32), ready: true }],
          settings: { turnSeconds: 60, ranked: false },
        } : null
      }, view)
      const surface = `.club-shell[data-club-view="${view === 'play' ? 'choices' : view}"]`
      await page.locator(surface).waitFor()
      await inspectHeader(surface, width)
      const backButtons = await backGeometry(surface)
      assertBackFigma(backButtons, width)
      if (backButtons.length) checks.push({ backFigmaTypography: true, surface, width, backTypography: backButtons })
      if (view === 'lobby') {
        const outerGap = await page.locator(`${surface} .club-section`).evaluate(element => getComputedStyle(element).gap)
        assert.equal(outerGap, '26px')
        if (width === 1440) {
          const formerGap = await page.addStyleTag({ content: '.club-shell[data-club-view="lobby"] .club-section { gap:28px !important; }' })
          const negativeGap = await page.locator(`${surface} .club-section`).evaluate(element => getComputedStyle(element).gap)
          assert.throws(() => assert.equal(negativeGap, '26px'), assert.AssertionError)
          await formerGap.evaluate(element => element.remove())
          assert.equal(await page.locator(`${surface} .club-section`).evaluate(element => getComputedStyle(element).gap), '26px')
          checks.push({ lobbyFigmaGap: true, sourceFrame: '96:15142', outerGap, negativeControl: negativeGap })
        }
        const rows = await page.locator('.club-room-players > div').evaluateAll(elements => elements.map(row => {
          const [name, status] = [...row.children].map(node => node.getBoundingClientRect())
          const bounds = row.getBoundingClientRect()
          const range = document.createRange()
          range.selectNodeContents(row.firstElementChild)
          return { rowLeft: bounds.left, rowRight: bounds.right, nameLeft: name.left, nameRight: name.right, statusLeft: status.left, statusRight: status.right, textLines: [...range.getClientRects()].map(line => ({ left: line.left, right: line.right })) }
        }))
        for (const row of rows) {
          assert.ok(row.nameLeft >= row.rowLeft - 1 && row.statusRight <= row.rowRight + 1, JSON.stringify(row))
          assert.ok(row.nameRight <= row.statusLeft - 15, JSON.stringify(row))
          assert.ok(row.textLines.every(line => line.left >= row.nameLeft - 1 && line.right <= row.nameRight + 1), JSON.stringify(row))
        }
        checks.push({ lobbyNames: true, width, rows })
        if (width === 320) await page.screenshot({ path: path.join(artifacts, 'lobby-long-names-320.png') })
      }
      if ((width === 600 && view === 'play') || (width === 320 && view === 'profile') || (width === 1440 && view === 'menu')) {
        await page.screenshot({ path: path.join(artifacts, `${view}-${width}.png`) })
      }
    }
  }

  await page.evaluate(() => { window.clubFixture.view = 'menu'; window.clubFixture.room = null })
  await page.setViewportSize({ width: 600, height: 844 })
  const opener = page.getByRole('button', { name: 'Настройки', exact: true })
  await opener.focus()
  await opener.press('Enter')
  assert.equal(await page.getByRole('dialog').evaluate(element => element === document.activeElement), true)
  await tabCycle()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  assert.equal(await opener.evaluate(element => element === document.activeElement), true)
  checks.push({ escapeClosesAndRestoresFocus: true })

  for (const width of [320, 481, 600, 760, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    await opener.focus()
    await opener.press('Enter')
    await inspectHeader('.club-settings-shell', width)
    for (const label of ['Графика', 'Звук', 'Управление']) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await inspectHeader('.club-settings-shell', width)
      const backButtons = await backGeometry('.club-settings-shell')
      assertBackFigma(backButtons, width)
      checks.push({ backFigmaTypography: true, surface: `settings-${label}`, width, backTypography: backButtons })
      await tabCycle()
      if (label === 'Управление') {
        const cardGap = await page.locator('.club-settings-controls .club-card').evaluate(element => getComputedStyle(element).gap)
        assert.equal(cardGap, '20px')
        if (width === 1440) {
          const formerGap = await page.addStyleTag({ content: '.club-settings-controls .club-card { gap:12px !important; }' })
          const negativeGap = await page.locator('.club-settings-controls .club-card').evaluate(element => getComputedStyle(element).gap)
          assert.throws(() => assert.equal(negativeGap, '20px'), assert.AssertionError)
          await formerGap.evaluate(element => element.remove())
          assert.equal(await page.locator('.club-settings-controls .club-card').evaluate(element => getComputedStyle(element).gap), '20px')
          checks.push({ controlsFigmaGap: true, sourceFrame: '96:15509', cardGap, negativeControl: negativeGap })
        }
        const extra = page.locator('.club-extra-bindings')
        await extra.locator('summary').click()
        await tabCycle()
      }
      if (width === 600 && label === 'Графика') await page.screenshot({ path: path.join(artifacts, 'settings-graphics-600.png') })
      await page.getByRole('button', { name: 'Назад', exact: true }).click()
    }
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await opener.evaluate(element => element === document.activeElement), true)
  }

  for (const width of [320, 600, 1440]) {
    await page.setViewportSize({ width, height: 844 })
    const exitTrigger = page.getByRole('button', { name: 'Выход', exact: true })
    for (const input of ['keyboard', 'mouse']) {
      if (input === 'keyboard') { await exitTrigger.focus(); await exitTrigger.press('Enter') }
      else await exitTrigger.click()
      const confirmation = page.getByRole('dialog', { name: 'Покинуть клуб?', exact: true })
      await confirmation.waitFor()
      assert.equal(await confirmation.evaluate(element => element === document.activeElement), true)
      await page.keyboard.press('Shift+Tab')
      assert.equal(await page.getByRole('button', { name: 'Отмена', exact: true }).evaluate(element => element === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await page.getByRole('button', { name: 'Выйти из игры', exact: true }).evaluate(element => element === document.activeElement), true)
      await page.keyboard.press('Tab')
      assert.equal(await page.getByRole('button', { name: 'Отмена', exact: true }).evaluate(element => element === document.activeElement), true)
      if (input === 'keyboard') await page.keyboard.press('Escape')
      else await page.getByRole('button', { name: 'Отмена', exact: true }).click()
      await confirmation.waitFor({ state: 'detached' })
      assert.equal(await exitTrigger.evaluate(element => element === document.activeElement), true)
      checks.push({ exitCase: 'cancel-and-trap', input, width })
    }
  }

  await page.getByRole('button', { name: 'Выход', exact: true }).click()
  await page.getByRole('button', { name: 'Выйти из игры', exact: true }).click()
  const completedExit = page.getByRole('dialog', { name: 'До встречи за столом', exact: true })
  assert.equal(await completedExit.evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.getByRole('button', { name: 'Вернуться в клуб', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: 'Вернуться в клуб', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Escape')
  checks.push({ exitCase: 'confirmed-single-action-trap' })

  await page.getByRole('button', { name: 'Выход', exact: true }).click()
  await page.getByRole('button', { name: 'Открыть профиль', exact: true }).click()
  await page.getByRole('heading', { name: 'Ваш профиль', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Открыть профиль', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.getByRole('button', { name: 'В главное меню', exact: true }).click()
  checks.push({ exitCase: 'adjacent-navigation-focus' })

  await page.getByRole('button', { name: 'Выход', exact: true }).click()
  await page.evaluate(() => { window.clubFixture.busy = true })
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('button', { name: 'Отмена', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'В главное меню', exact: true }).evaluate(element => element === document.activeElement), true)
  await page.evaluate(() => { window.clubFixture.busy = false })
  checks.push({ exitCase: 'busy-cancel-focus-fallback' })

  assert.deepEqual(errors, [])
  const report = { engine, headerCases: checks.filter(check => 'brandRight' in check).length, focusCases: checks.filter(check => check.focusCycle || check.escapeClosesAndRestoresFocus).length, lobbyCases: checks.filter(check => check.lobbyNames).length, exitCases: checks.filter(check => check.exitCase).length, backTypographyCases: checks.filter(check => check.backFigmaTypography).length, finalFigmaNegativeControls: checks.filter(check => (check.backFigmaTypography || check.lobbyFigmaGap || check.controlsFigmaGap) && check.negativeControl).length, checks, errors }
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ engine, headerCases: report.headerCases, focusCases: report.focusCases, lobbyCases: report.lobbyCases, exitCases: report.exitCases, backTypographyCases: report.backTypographyCases, finalFigmaNegativeControls: report.finalFigmaNegativeControls, jsErrors: errors.length }))
} finally { await browser.close() }
