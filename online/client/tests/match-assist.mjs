// Real Vue HUD and untouched Figma exports; no simulation or application backend fixture.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const moduleUrl = value => path.isAbsolute(value) ? pathToFileURL(value).href : value
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'))
const { PNG } = await import(moduleUrl(process.env.PNG_MODULE || 'pngjs'))
const engine = process.env.BROWSER || 'chromium'
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/match-assist')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4318, strictPort: true } })
let browser
async function assertRackSpacing(page, viewport, timerGap) {
  const spacing = await page.locator('.hud-rack-detail').evaluate(node => {
    const text = node.firstChild
    const dot = text.data.indexOf('·')
    const textBounds = (start, end) => {
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, end)
      return range.getBoundingClientRect()
    }
    const left = textBounds(0, dot - 3)
    const center = textBounds(dot, dot + 1)
    const right = textBounds(dot + 4, text.length)
    const style = getComputedStyle(node)
    const context = document.createElement('canvas').getContext('2d')
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const expectedGap = context.measureText('   ').width
    const rack = node.getBoundingClientRect()
    return {
      text: node.innerText,
      leftGap: center.left - left.right,
      rightGap: right.left - center.right,
      expectedGap,
      timerGap: rack.top - node.previousElementSibling.getBoundingClientRect().bottom,
      left: left.left,
      right: right.right,
    }
  })
  assert.equal(spacing.text, 'Раунд 1   ·   8-BALL')
  assert.ok(spacing.expectedGap > 0, 'Round text must be visible')
  for (const actualGap of [spacing.leftGap, spacing.rightGap]) {
    // WebKit rounds the edges of individual DOM text ranges.
    assert.ok(Math.abs(actualGap - spacing.expectedGap) < 2, `Figma rack label must keep three spaces on both sides: ${JSON.stringify(spacing)}`)
  }
  assert.ok(Math.abs(spacing.timerGap - timerGap) < 0.3, `The vertical timer/rack spacing must remain ${timerGap}px: ${JSON.stringify(spacing)}`)
  assert.ok(spacing.left >= 0 && spacing.right <= viewport.width, `The rack label must fit ${viewport.width}px`)
  return spacing
}

try {
  await server.listen()
  browser = await playwright[engine].launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4318/tests/match-assist-fixture.html')
  await page.waitForFunction(() => window.fixtureReady)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => [...document.querySelectorAll('.assist-range use, .assist-elevation-slot svg use')].every(use => use.getBBox().width > 0))
  const geometry = await page.locator('.assist-range use, .assist-elevation-slot svg use').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBBox()
    return { href: node.getAttribute('href'), width: rect.width, height: rect.height }
  }))
  assert.equal(geometry.length, 10, 'All six slider parts and all four elevation fragments must render')
  assert.ok(geometry.every(part => part.width > 0 && part.height > 0), JSON.stringify(geometry))
  const fills = []
  for (const fraction of [0, 0.25, 0.5, 1]) {
    await page.evaluate(value => {
      window.assistFixture.aim.V0 = .2 + value * 7.8
      window.assistFixture.aim.theta = value * 60
    }, fraction)
    await page.waitForTimeout(30)
    const rows = []
    for (const label of ['Сила удара Ctrl', 'Наклон кия Ctrl']) {
      const container = page.getByRole('slider', { name: label, exact: true }).locator('..')
      const bytes = await container.screenshot({ path: path.join(artifacts, `${engine}-${fraction}-${label.startsWith('Сила') ? 'power' : 'elevation'}.png`) })
      const png = PNG.sync.read(bytes)
      let gold = 0, cream = 0
      for (let offset = 0; offset < png.data.length; offset += 4) {
        const [r, g, b, a] = png.data.subarray(offset, offset + 4)
        if (Math.abs(r - 199) < 3 && Math.abs(g - 170) < 3 && Math.abs(b - 114) < 3 && a > 225) gold++
        if (Math.abs(r - 241) < 3 && Math.abs(g - 237) < 3 && Math.abs(b - 225) < 3 && a > 225) cream++
      }
      assert.ok(cream > 35, `Thumb must be visible at ${fraction}: ${label}, ${cream}; ${JSON.stringify(await container.locator('use').evaluateAll(nodes=>nodes.map(node=>({href:node.getAttribute('href'),transform:node.getAttribute('transform'),rect:node.getBoundingClientRect().toJSON()}))))}`)
      rows.push({ gold, cream })
    }
    if (fraction === 0) assert.ok(rows.every(row => row.gold < 5), `No nonzero fill at the minimum: ${JSON.stringify(rows)}`)
    else assert.ok(rows.every((row, index) => row.gold > fills.at(-1).rows[index].gold + 25), `Both slider fills must grow: ${JSON.stringify({ fraction, rows, fills })}`)
    fills.push({ fraction, rows })
  }
  await page.getByRole('slider', { name: 'Сила удара Ctrl', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), .2)
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), 8)
  await page.getByRole('slider', { name: 'Наклон кия Ctrl', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.theta), 0)
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.theta), 60)
  const layouts = []
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => { window.assistFixture.aim.theta = 12; window.assistFixture.aim.V0 = 2.4 })
    const bounds = await page.locator('.assist-card, .hud-stage-instruction').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect()
      return { className: node.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }))
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height), `Assist panels must fit ${JSON.stringify(viewport)}: ${JSON.stringify(bounds)}`)
    if (viewport.width === 1920) {
      // Positions and sizes measured in the 1920×1080 source frame 102:17640.
      const expected = [[40, 360, 220, 360], [42, 336, 466, 667], [1570, 1880, 280, 574], [1630, 1880, 650, 928]]
      for (const [index, rect] of bounds.entries()) {
        assert.ok([rect.left, rect.right, rect.top, rect.bottom].every((value, side) => Math.abs(value - expected[index][side]) <= 1), `Design box ${index}: ${JSON.stringify(rect)}`)
      }
    }
    const rangeWidths = await page.locator('.assist-range').evaluateAll(nodes => nodes.map(node => ({ actual: node.offsetWidth, expected: Number.parseFloat(node.style.width) })))
    assert.ok(rangeWidths.every(range => range.actual === range.expected), `Flex rules must not shrink the SVG track: ${JSON.stringify(rangeWidths)}`)
    const safeZone = await page.locator('.assist-safe-zone').evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, source: [node.naturalWidth, node.naturalHeight] }))
    assert.deepEqual(safeZone, { width: 94, height: 94, source: [188, 188] }, 'The original 2× PNG must use its Figma CSS size')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, `No horizontal page overflow at ${viewport.width}`)
    await page.screenshot({ path: path.join(artifacts, `${engine}-${viewport.width}x${viewport.height}.png`) })
    const rackSpacing = await assertRackSpacing(page, viewport, viewport.width <= 760 ? 6 : 10)
    layouts.push({ viewport, bounds, rackSpacing })
  }
  await page.evaluate(() => { window.assistFixture.phase = 'aim' })
  const contact = page.getByRole('slider', { name: 'Точка контакта на схеме битка', exact: true })
  await contact.focus()
  await page.keyboard.press('ArrowRight')
  const contactAim = await page.evaluate(() => ({ ...window.assistFixture.aim }))
  assert.equal(contactAim.a, .05)
  assert.equal(contactAim.phi, 90, 'Contact controls must preserve the already-fixed direction')
  await page.evaluate(() => { window.assistFixture.canShoot = false })
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.a), .05, 'Spectator input must not change aim')
  await page.evaluate(() => { window.assistFixture.showAssist = false })
  assert.equal(await page.getByTestId('alt-assist').count(), 0)
  assert.equal(await page.getByRole('meter').count(), 0, 'Contact selection must not show power gauges')
  await page.evaluate(() => { window.assistFixture.phase = 'power' })
  await page.getByRole('meter', { name: 'Сила удара в процентах', exact: true }).waitFor()
  assert.equal(await page.getByRole('meter').count(), 2, 'Power meters must stay available without assist cards')
  assert.equal(await page.getByTestId('alt-assist').count(), 0)
  await page.evaluate(() => { window.assistFixture.showAssist = true })
  await page.getByTestId('alt-assist').waitFor()
  assert.equal(await page.getByRole('meter').count(), 2, 'Assistance must not duplicate the base power meters')
  await page.evaluate(() => { window.assistFixture.showAssist = false })
  assert.equal(await page.getByRole('meter').count(), 2, 'Releasing the assist toggle must leave the base power meters intact')
  await page.evaluate(() => { window.assistFixture.phase = 'overview'; window.assistFixture.user = { id: 'spectator' } })
  const overview = await page.locator('.hud-player, .hud-clock').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect()
    return { className: node.className, top: rect.top, bottom: rect.bottom }
  }))
  assert.ok(overview[2].top >= Math.max(overview[0].bottom, overview[1].bottom), `Overview clock must clear both player cards: ${JSON.stringify(overview)}`)
  assert.equal(await page.locator('.hud-match-status').count(), 0, 'Spectator state reuses the designed turn label, not a new status badge')
  assert.equal(await page.locator('.hud-turn-label').innerText(), 'Ход: Alex Chen')
  const clockRows = await page.locator('.hud-clock > *').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }
  }))
  assert.ok(clockRows[1].top >= clockRows[0].bottom && clockRows[2].top >= clockRows[1].bottom, `Mobile clock parts must form separate rows: ${JSON.stringify(clockRows)}`)
  await assertRackSpacing(page, { width: 390 }, 6)
  await page.screenshot({ path: path.join(artifacts, `${engine}-390x844-overview.png`) })
  // Only the original overview/direction/contact/power layers are mounted.
  // Native scene shots and optional calls are covered by match integration.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => {
    const state = window.assistFixture
    state.user = { id: 'a' }
    state.canShoot = true
    state.cameraMode = 'free'
    state.showAssist = true
    state.match.snapshot.callShotRequired = true
    state.match.snapshot.balls = [{ id: '1', position: [0, 0, .03], pocketed: false }]
    state.match.snapshot.table.pockets = [{ id: 'lt', position: [0, 1.98, 0], radius: .062 }]
  })
  assert.equal(await page.getByRole('button', { name: 'Параметры удара', exact: true }).count(), 0, 'No extra shot parameters panel')
  assert.equal(await page.getByRole('button', { name: 'Правила' }).count(), 0, 'Figma rules caption is not a new dialog trigger')
  assert.equal(await page.getByText('Правила 8-ball', { exact: true }).count(), 1)
  assert.equal(await page.getByTestId('alt-assist').count(), 0, 'Assist does not invent a separate overview/heading panel')
  assert.equal(await page.locator('.hud-overview-instruction h2').innerText(), 'Ваш ход')
  await assertRackSpacing(page, { width: 1920 }, 10)
  assert.equal(await page.locator('.hud-wordmark').innerText(), 'Pooltool\n8-BALL · СТОЛ ABC123')
  assert.equal(await page.locator('.hud-footer-instruction').innerText(), 'Колесо мыши · приблизить биток')
  await page.evaluate(() => { window.assistFixture.feedback = 'Соединение потеряно' })
  assert.equal(await page.locator('.hud-footer-instruction[role=status]').innerText(), 'Соединение потеряно')
  await page.evaluate(() => {
    window.assistFixture.feedback = ''
    window.assistFixture.cameraMode = 'cue'
  })
  await page.waitForFunction(() => [...document.querySelectorAll('.hud-direction-control img, .hud-direction-reticle, .hud-power-reticle')].length === 3
    && [...document.querySelectorAll('.hud-direction-control img, .hud-direction-reticle, .hud-power-reticle')].every(img => img.complete && img.naturalWidth > 0))
  assert.equal(await page.locator('.hud-direction-reticle').evaluate(img => img.naturalWidth), 56)
  assert.equal(await page.locator('.hud-power-reticle').evaluate(img => img.naturalWidth), 264)
  assert.equal(await page.locator('.hud-direction-control span').innerText(), 'Мышь ↔ · направление удара')
  assert.equal(await page.getByTestId('alt-assist').count(), 0)
  await page.evaluate(() => { window.assistFixture.phase = 'aim'; window.assistFixture.showAssist = false })
  const reticle = page.locator('.hud-contact-reticle')
  await reticle.click({ button: 'right' })
  assert.equal(await page.evaluate(() => window.assistFixture.phase), 'overview', 'RMB works within as well as outside the contact reticle')
  await page.evaluate(() => { window.assistFixture.phase = 'aim' })
  await reticle.click()
  assert.equal(await page.evaluate(() => window.assistFixture.phase), 'power')
  await page.getByRole('button', { name: 'Меню матча' }).click()
  const menu = page.getByRole('dialog', { name: 'Меню матча' })
  const menuActions = menu.locator('.match-menu-action')
  const menuBox = await menu.locator('.match-menu-card').boundingBox()
  assert.deepEqual([menuBox.x, menuBox.y, menuBox.width], [690, 320, 540], 'Menu frame 102:17902')
  assert.deepEqual(await menuActions.locator('span').allTextContents(), ['Продолжить игру', 'Настройки', 'Сдаться'])
  assert.equal(await menu.locator('.match-overlay-state').innerText(), 'Матч продолжается · время хода не останавливается')
  assert.equal(await page.getByRole('meter').count(), 0, 'The overlay hides the transient shot layers')
  await menu.getByRole('button', { name: 'Сдаться' }).click()
  const surrender = page.getByRole('dialog', { name: 'Сдаться?' })
  const surrenderBox = await surrender.locator('.match-surrender-card').boundingBox()
  assert.deepEqual([surrenderBox.x, surrenderBox.y, surrenderBox.width], [620, 340, 680], 'Surrender frame 102:19206')
  assert.equal(await surrender.locator('.match-menu-title > div').innerText(), 'Вам будет засчитано поражение.\nMorgan Reed получит победу в этой партии.')
  assert.deepEqual(await surrender.locator('.match-menu-action > span').allTextContents(), ['Сдаться', 'Продолжить игру'])
  await page.keyboard.press('Escape')
  await menu.waitFor()
  await menu.getByRole('button', { name: 'Продолжить игру' }).click()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.evaluate(() => { window.assistFixture.user = { id: 'spectator' }; window.assistFixture.overlay = true })
  assert.deepEqual(await menuActions.locator('span').allTextContents(), ['Продолжить игру', 'Настройки', 'Выйти'])
  await menu.getByRole('button', { name: 'Выйти', exact: true }).click()
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, geometry, fills, layouts, keyboardSliders: true, contactLocksDirection: true, strictStages: true, matchOverlays: true, jsErrors: errors.length }))
} finally {
  await browser?.close()
  await server.close()
}
