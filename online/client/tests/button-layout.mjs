import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

// Layout-only integration. Uses actual Vue components and production styles;
// no network identity, room, match or administrator mutation is performed.
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/button-layout/final')
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
await mkdir(artifacts, { recursive: true })
const failures = [], results = []
let browser

function uniform(boxes, label, { minimum = 0, widths = false, sameRow = false } = {}) {
  assert.ok(boxes.length >= 2, `${label}: expected an actual action group`)
  assert.ok(boxes.every(box => box.height >= minimum - .5), `${label}: controls below minimum ${minimum}: ${JSON.stringify(boxes)}`)
  assert.ok(Math.max(...boxes.map(box => box.height)) - Math.min(...boxes.map(box => box.height)) <= .6,
    `${label}: unequal action heights: ${JSON.stringify(boxes)}`)
  if (widths) assert.ok(Math.max(...boxes.map(box => box.width)) - Math.min(...boxes.map(box => box.width)) <= 1,
    `${label}: unequal equal-column widths: ${JSON.stringify(boxes)}`)
  if (sameRow) assert.ok(Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) <= .6,
    `${label}: actions do not share a top edge: ${JSON.stringify(boxes)}`)
}
async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
}
async function rects(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => {
    const r = node.getBoundingClientRect()
    return { text: node.textContent.trim().replace(/\s+/g, ' '), x: r.x, y: r.y, width: r.width, height: r.height, disabled: node.matches(':disabled') }
  }))
}
async function check(page, name, action) {
  try { const value = await action(); results.push({ name, status: 'PASS', ...(value ? { value } : {}) }) }
  catch (error) {
    failures.push({ name, message: error.message })
    await page.screenshot({ path: path.join(artifacts, `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-failure.png`), fullPage: true })
  }
}
async function bounds(page, label, selector = 'button, .model-file-button') {
  const report = await page.locator(selector).evaluateAll(nodes => {
    const visible = nodes.filter(node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    return {
      viewport: innerWidth, body: document.documentElement.scrollWidth,
      clipped: visible.flatMap(node => {
        const r = node.getBoundingClientRect(), css = getComputedStyle(node)
        if (css.position === 'fixed' || node.closest('.hud-scoreboard')) return []
        const badChildren = [...node.children].filter(child => { const c = child.getBoundingClientRect(); return c.width && (c.left < r.left - 1 || c.right > r.right + 1 || c.top < r.top - 1 || c.bottom > r.bottom + 1) }).map(child => child.tagName)
        const outside = r.left < -1 || r.right > innerWidth + 1
        return outside || badChildren.length || node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
          ? [{ text: node.textContent.trim(), rect: { x: r.x, width: r.width, height: r.height }, outside, badChildren, scroll: [node.scrollWidth, node.scrollHeight], client: [node.clientWidth, node.clientHeight] }] : []
      }),
    }
  })
  assert.ok(report.body <= report.viewport + 1, `${label}: document overflow: ${JSON.stringify(report)}`)
  assert.deepEqual(report.clipped, [], `${label}: clipped/overflowing buttons: ${JSON.stringify(report.clipped)}`)
}
async function clubGroups(page, label, width) {
  await settle(page)
  const all = await rects(page, '.club-action')
  assert.ok(all.length > 0, `${label}: actual club actions must render`)
  assert.ok(all.every(box => box.height >= (width <= 480 ? 56 : 62) - .5), `${label}: action below the shared minimum: ${JSON.stringify(all)}`)
  const inline = await rects(page, '.club-actions-inline > .club-action')
  if (inline.length) uniform(inline, `${label} inline`, { minimum: width <= 480 ? 56 : 62, widths: true, sameRow: width > 480 })
  for (const [index, group] of (await page.locator('.club-actions').all()).entries()) {
    const boxes = await group.locator(':scope > .club-action').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { text: node.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height }
    }))
    if (boxes.length >= 2) uniform(boxes, `${label} stack ${index}`, { minimum: width <= 480 ? 56 : 62, widths: true })
  }
  // A field, explanation or room summary separates action groups. Compare
  // adjacent sibling actions, not unrelated actions elsewhere in the card.
  const directGroups = await page.locator('.club-card').evaluateAll(cards => cards.flatMap(card => {
    const groups = []; let current = []
    for (const child of card.children) {
      if (child.matches('.club-action')) {
        const r = child.getBoundingClientRect(); current.push({ text: child.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height })
      } else { if (current.length >= 2) groups.push(current); current = [] }
    }
    if (current.length >= 2) groups.push(current)
    return groups
  }))
  directGroups.forEach((group, index) => uniform(group, `${label} adjacent ${index}`, { minimum: width <= 480 ? 56 : 62, widths: true }))
  const direct = await rects(page, '.club-card > .club-action')
  if (direct.length >= 2) uniform(direct, `${label} actual direct actions`, { minimum: width <= 480 ? 56 : 62, widths: true })
  // Retain the broad card contract after buttons move into layout wrappers:
  // an independent copy-code control must not silently become a different size.
  for (const [index, card] of (await page.locator('.club-card').all()).entries()) {
    const boxes = await card.locator('.club-action').evaluateAll(nodes => nodes.map(node => {
      const r = node.getBoundingClientRect(); return { text: node.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height }
    }))
    if (boxes.length >= 2) uniform(boxes, `${label} complete card ${index}`, { minimum: width <= 480 ? 56 : 62, widths: true })
  }
  await bounds(page, label, '.club-action')
  return { inline, controls: await page.locator('.club-action').count() }
}

try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  for (const engine of engines) {
    browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = [], mutations = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push(request.url()) })
    // Workshop is a local layout fixture: deny backend dependency explicitly.
    await page.route('**/api/assets/table-reference', async route => {
      const snapshot = await page.evaluate(() => window.buttonLayoutFixture.snapshot)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ snapshot }) })
    })
    await page.goto(`${base}tests/button-layout.fixture.html`)
    await page.waitForFunction(() => window.fixtureReady)
    for (const width of [1920, 1440, 760, 481, 390, 320]) {
      await page.setViewportSize({ width, height: width > 480 ? 1080 : 844 })
      await page.evaluate(() => { const f = window.buttonLayoutFixture; f.setSurface('club'); f.state.view = 'menu'; f.state.busy = false })
      const id = `${engine}-${width}`
      await check(page, `${id}-menu`, () => clubGroups(page, id + ' menu', width))
      await page.getByRole('button', { name: 'Играть', exact: true }).click()
      await check(page, `${id}-play`, () => clubGroups(page, id + ' play', width))
      await page.getByRole('button', { name: 'Игра с другом', exact: true }).click()
      await check(page, `${id}-friend`, () => clubGroups(page, id + ' friend', width))
      await page.getByRole('button', { name: 'Настройки игры', exact: true }).click()
      await check(page, `${id}-rules`, () => clubGroups(page, id + ' rules', width))
      await page.getByRole('button', { name: 'Сохранить правила', exact: true }).click()
      await page.getByRole('button', { name: 'Присоединиться', exact: true }).click()
      await check(page, `${id}-join`, () => clubGroups(page, id + ' join', width))
      await page.getByRole('button', { name: 'Назад', exact: true }).click()
      await page.getByRole('button', { name: 'Создать игру', exact: true }).click()
      await check(page, `${id}-lobby`, () => clubGroups(page, id + ' lobby', width))
      await page.getByRole('button', { name: 'Готов', exact: true }).click()
      await check(page, `${id}-lobby-ready`, () => clubGroups(page, id + ' lobby ready', width))
      await page.getByRole('button', { name: 'Выйти из комнаты', exact: true }).click()
      await page.getByRole('button', { name: 'Тренировка с ботом', exact: true }).click()
      await check(page, `${id}-bot`, () => clubGroups(page, id + ' bot', width))
      await page.getByRole('button', { name: 'Назад', exact: true }).click()
      await page.getByRole('button', { name: 'Просмотр матча', exact: true }).click()
      await check(page, `${id}-watch`, () => clubGroups(page, id + ' watch', width))
      await page.getByRole('button', { name: 'Назад', exact: true }).click()
      for (const mode of ['Случайный противник', 'Рейтинговая игра']) {
        await page.getByRole('button', { name: mode === 'Рейтинговая игра' ? /^Рейтинговая игра\s/ : mode, exact: true }).click()
        await check(page, `${id}-search-${mode}`, () => clubGroups(page, id + ' search ' + mode, width))
        await page.getByRole('button', { name: 'Отменить поиск', exact: true }).click()
      }
      await page.getByRole('button', { name: 'В главное меню', exact: true }).click()
      await page.getByRole('button', { name: 'Выход', exact: true }).click()
      await check(page, `${id}-exit`, () => clubGroups(page, id + ' exit', width))
      await page.evaluate(() => { window.buttonLayoutFixture.state.view = 'profile' })
      await check(page, `${id}-profile`, () => clubGroups(page, id + ' profile', width))
      await page.locator('.club-actions-inline').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(artifacts, `${id}-profile.png`), fullPage: true })
      await page.locator('.club-actions-inline').screenshot({ path: path.join(artifacts, `${id}-profile-actions.png`) })
      await page.evaluate(() => { window.buttonLayoutFixture.state.busy = true })
      await check(page, `${id}-profile-disabled`, () => clubGroups(page, id + ' profile disabled', width))
      await page.evaluate(() => { window.buttonLayoutFixture.state.busy = false })
      if (width === 1440) {
        // Prove the regression rejects the exact former 48-vs-62 defect.
        await page.locator('.club-action-back').evaluate(node => { node.style.height = '48px'; node.style.minHeight = '48px'; node.style.maxHeight = '48px' })
        const bad = await rects(page, '.club-actions-inline > .club-action')
        assert.throws(() => uniform(bad, 'injected old regression'))
        await page.locator('.club-action-back').evaluate(node => node.removeAttribute('style'))
      }
      // Stress a genuine content mutation, not a tiny fixed-height happy path.
      await page.locator('.club-actions-inline .club-action-primary > span').evaluate(node => node.textContent = 'Сохранить очень длинное имя игрока без обрезки текста')
      await check(page, `${id}-profile-long-label`, () => clubGroups(page, id + ' profile long label', width))
      await page.locator('.club-actions-inline .club-action-primary > span').evaluate(node => node.textContent = 'Сохранитьоченьдлинноеимяигрокабезпробелов')
      await check(page, `${id}-profile-unbroken-label`, () => clubGroups(page, id + ' profile unbroken label', width))

      await page.evaluate(() => window.buttonLayoutFixture.setSurface('settings'))
      await check(page, `${id}-settings-index`, () => clubGroups(page, id + ' settings index', width))
      for (const tab of ['Графика', 'Звук', 'Управление']) {
        await page.getByRole('button', { name: tab, exact: true }).click()
        await check(page, `${id}-settings-${tab}`, () => clubGroups(page, id + ' settings ' + tab, width))
        await page.evaluate(() => { window.buttonLayoutFixture.state.bindingCapture = 'assist'; window.buttonLayoutFixture.state.bindingConflicts = ['Проверка отключённого сохранения'] })
        await check(page, `${id}-settings-${tab}-disabled`, () => clubGroups(page, id + ' settings disabled ' + tab, width))
        await page.evaluate(() => { window.buttonLayoutFixture.state.bindingCapture = null; window.buttonLayoutFixture.state.bindingConflicts = [] })
        await page.getByRole('button', { name: 'Назад', exact: true }).click()
      }
      await page.evaluate(() => window.buttonLayoutFixture.setSurface('appearance'))
      await page.locator('.appearance-apply-actions').waitFor()
      await settle(page)
      for (const selector of ['.appearance-secondary-actions > button', '.appearance-apply-actions > button']) {
        await check(page, `${id}-${selector}`, async () => { const boxes = await rects(page, selector); uniform(boxes, id + selector); await bounds(page, id + selector, selector); return boxes })
      }
      await page.evaluate(() => window.buttonLayoutFixture.state.appearanceLoading = true)
      await check(page, `${id}-appearance-disabled`, async () => uniform(await rects(page, '.appearance-secondary-actions > button'), id + ' appearance disabled'))
      await page.evaluate(() => window.buttonLayoutFixture.setSurface('workshop'))
      await page.locator('.model-publish-actions .model-actions').waitFor()
      await settle(page)
      await check(page, `${id}-workshop-publication`, async () => {
        const boxes = await rects(page, '.model-publish-actions .model-actions > button, .model-publish-actions .model-actions > .model-file-button')
        // Flex-wrap may put different-sized labels on separate rows. Compare
        // controls sharing a row, including the native file-input label proxy.
        const rows = new Map()
        for (const box of boxes) { const row = Math.round(box.y); if (!rows.has(row)) rows.set(row, []); rows.get(row).push(box) }
        for (const [row, controls] of rows) if (controls.length >= 2) uniform(controls, id + ' publication row ' + row, { sameRow: true })
        assert.ok(boxes.length >= 6, 'Administrator publication actions must actually render')
        await bounds(page, id + ' workshop')
        return boxes
      })
      await page.evaluate(() => { window.buttonLayoutFixture.state.canManage = false })
      await settle(page)
      await check(page, `${id}-workshop-readonly`, async () => {
        uniform(await rects(page, '.model-workshop-header .model-actions > button'), id + ' workshop read-only')
        await bounds(page, id + ' workshop read-only')
      })
      await page.evaluate(() => { window.buttonLayoutFixture.state.canManage = true; window.buttonLayoutFixture.setSurface('login'); window.buttonLayoutFixture.state.configured = true })
      await page.locator('.model-admin-submit').waitFor()
      await check(page, `${id}-admin-login`, async () => { await bounds(page, id + ' admin login'); assert.ok((await rects(page, '.model-admin-submit'))[0].height >= 54) })
      await page.evaluate(() => { window.buttonLayoutFixture.state.configured = false })
      await check(page, `${id}-admin-unconfigured`, () => bounds(page, id + ' admin unconfigured'))
      await page.evaluate(() => window.buttonLayoutFixture.setSurface('hud'))
      await page.getByRole('button', { name: 'Параметры удара', exact: true }).click()
      await check(page, `${id}-hud-shot`, async () => uniform(await rects(page, '.hud-shot-actions > button'), id + ' hud shot', { widths: true, sameRow: true }))
      await check(page, `${id}-hud-camera`, async () => uniform(await rects(page, '.hud-camera-actions > button'), id + ' hud camera'))
      // Close glyphs and ball/pocket selectors intentionally use their own
      // compact geometry; this audit concerns ordinary action-button groups.
      await check(page, `${id}-hud-bounds`, () => bounds(page, id + ' hud controls', '.hud-camera-actions > button, .hud-shot-actions > button, .hud-controls > button'))
    }
    assert.deepEqual(errors, [], `${engine} component JS errors`)
    assert.deepEqual(mutations, [], `${engine} layout fixture must not mutate any API`)
    assert.equal(await page.evaluate(() => window.buttonLayoutFixture.counters.writes), 0)
    await browser.close(); browser = null
  }
  await writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ results, failures }, null, 2))
  console.log(JSON.stringify({ engines, checks: results.length, failures: failures.length, details: failures }))
  assert.equal(failures.length, 0, 'All button layout checks must pass; see result.json for evidence')
} finally { await browser?.close(); await server.close() }
