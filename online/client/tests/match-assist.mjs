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
const artifacts = path.resolve('tests/artifacts/match-assist')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4318, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await playwright[engine].launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:4318/tests/match-assist-fixture.html')
  await page.waitForFunction(() => window.fixtureReady)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => [...document.querySelectorAll('.assist-range use, .assist-elevation > svg use')].every(use => use.getBBox().width > 0))
  const geometry = await page.locator('.assist-range use, .assist-elevation > svg use').evaluateAll(nodes => nodes.map(node => {
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
    for (const label of ['Сила удара Alt', 'Наклон кия Alt']) {
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
  await page.getByRole('slider', { name: 'Сила удара Alt', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), .2)
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), 8)
  await page.getByRole('slider', { name: 'Наклон кия Alt', exact: true }).focus()
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
    const rangeWidths = await page.locator('.assist-range').evaluateAll(nodes => nodes.map(node => ({ actual: node.offsetWidth, expected: Number.parseFloat(node.style.width) })))
    assert.ok(rangeWidths.every(range => range.actual === range.expected), `Flex rules must not shrink the SVG track: ${JSON.stringify(rangeWidths)}`)
    const safeZone = await page.locator('.assist-safe-zone').evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, source: [node.naturalWidth, node.naturalHeight] }))
    assert.deepEqual(safeZone, { width: 94, height: 94, source: [188, 188] }, 'The original 2× PNG must use its Figma CSS size')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, `No horizontal page overflow at ${viewport.width}`)
    await page.screenshot({ path: path.join(artifacts, `${engine}-${viewport.width}x${viewport.height}.png`) })
    layouts.push({ viewport, bounds })
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
  await page.evaluate(() => { window.assistFixture.phase = 'overview'; window.assistFixture.user = { id: 'spectator' } })
  const overview = await page.locator('.hud-player, .hud-clock, .hud-match-status').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect()
    return { className: node.className, top: rect.top, bottom: rect.bottom }
  }))
  assert.ok(overview[2].top >= Math.max(overview[0].bottom, overview[1].bottom), `Overview clock must clear both player cards: ${JSON.stringify(overview)}`)
  assert.ok(overview[3].top >= overview[2].bottom, `Spectator status must clear the overview clock: ${JSON.stringify(overview)}`)
  const clockRows = await page.locator('.hud-clock > *').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }
  }))
  assert.ok(clockRows[1].top >= clockRows[0].bottom && clockRows[2].top >= clockRows[1].bottom, `Mobile clock parts must form separate rows: ${JSON.stringify(clockRows)}`)
  await page.screenshot({ path: path.join(artifacts, `${engine}-390x844-overview.png`) })
  // A recovered legacy snapshot must not re-introduce mandatory call UI.
  // This is a component-only check; the authoritative no-call shot is covered
  // separately by the real-engine match integration tests.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.evaluate(() => {
    const state = window.assistFixture
    state.user = { id: 'a' }
    state.canShoot = true
    state.calledBall = ''
    state.calledPocket = ''
    state.match.snapshot.callShotRequired = true
    state.match.snapshot.balls = [{ id: '1', position: [0, 0, .03], pocketed: false }]
    state.match.snapshot.table.pockets = [{ id: 'lt', position: [0, 1.98, 0], radius: .062 }]
  })
  await page.getByRole('button', { name: 'Параметры удара', exact: true }).click()
  const calls = page.locator('.hud-call-title')
  assert.deepEqual(await calls.allTextContents(), ['Заказ шара · необязательно', 'Заказ лузы · необязательно'])
  assert.equal(await page.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), true)
  await page.getByRole('button', { name: 'Удар', exact: true }).click()
  assert.equal(await page.evaluate(() => window.shotRequests), 1, 'No call selection is needed to request a shot')
  await page.getByRole('button', { name: 'Шар 1', exact: true }).click()
  await page.getByRole('button', { name: 'Луза 3', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.callSelections), [{ ball: '1' }, { pocket: 'lt' }], 'Optional target selectors remain available')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, geometry, fills, layouts, keyboardSliders: true, contactLocksDirection: true, optionalCalls: true, jsErrors: errors.length }))
} finally {
  await browser?.close()
  await server.close()
}
