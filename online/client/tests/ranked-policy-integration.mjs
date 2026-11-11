import assert from 'node:assert/strict'
import { clickHudAction } from './app-state.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Real API/compiled client check. It creates disposable guests and rated matches;
// use an isolated test database. No rank or renderer state is mocked/injected.
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Run only against an isolated loopback test service')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)

async function api(actor, endpoint, body, method = 'POST') {
  const response = await fetch(base + endpoint, {
    method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }), signal: AbortSignal.timeout(30_000),
  })
  const result = await response.json()
  assert.equal(response.status, 200, `${method} ${endpoint}: ${response.status} ${JSON.stringify(result.detail)}`)
  return result
}
async function graphics(page) {
  const settings = page.locator('.club-settings-shell')
  if (!await settings.count()) {
    await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  }
  await settings.waitFor()
  if (!await settings.getByRole('heading', { name: 'Графика', exact: true }).count()) {
    if (!await settings.getByRole('button', { name: 'Графика', exact: true }).count()) await settings.getByRole('button', { name: 'Назад', exact: true }).click()
    await settings.getByRole('button', { name: 'Графика', exact: true }).click()
  }
  const advanced = settings.locator('details').filter({ hasText: 'Дополнительные параметры графики' })
  if (await advanced.getAttribute('open') === null) await advanced.locator('summary').click()
  const control = advanced.getByRole('switch', { name: 'Линия прицеливания', exact: true })
  await control.waitFor()
  return control
}
async function assertPolicy(page, { locked, checked }) {
  const control = await graphics(page)
  assert.equal(await control.isDisabled(), locked)
  assert.equal(await control.getAttribute('aria-checked'), String(checked))
  if (locked) await page.getByRole('note').filter({ hasText: 'линия прицеливания отключена' }).waitFor()
  return control
}
async function waitScene(page) {
  await page.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
  await page.locator('[data-testid="match-hud"]').waitFor()
}
async function pair(first, second, mode) {
  assert.equal((await api(first, '/api/matchmaking', { mode })).queued, true)
  const paired = await api(second, '/api/matchmaking', { mode })
  const match = (await api(first, `/api/matches/${paired.matchId}`, undefined, 'GET')).match
  assert.equal(match.ranked, mode === 'ranked')
  return { room: paired.room, match }
}

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const engine = playwright[engineName]
  assert.ok(engine)
  const browser = await engine.launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const contexts = [], actors = [], errors = []
  let room, keepalive
  try {
    for (const name of ['Policy A', 'Policy B', 'Policy Observer']) actors.push(await api(null, '/api/auth/guest', { displayName: `${name} ${engineName}`, clientVersion: 'ranked-policy-qa' }))
    const preference = { quality: 'medium', volume: 0.5, sensitivity: 1, bindings: {}, showAimGuide: true, showPocketLabels: true }
    for (const actor of actors) await api(actor, '/api/me/settings', preference, 'PUT')
    const paired = await pair(actors[0], actors[1], 'ranked')
    room = paired.room
    await api(actors[2], `/api/rooms/${room.code}/spectate`)
    // Keep the second real participant online without a third GPU renderer.
    keepalive = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
    await new Promise((resolve, reject) => {
      keepalive.addEventListener('open', () => keepalive.send(JSON.stringify({ type: 'auth', token: actors[1].token })))
      keepalive.addEventListener('error', reject, { once: true })
      keepalive.addEventListener('message', event => { if (JSON.parse(event.data).type === 'authenticated') resolve() })
    })
    const pages = []
    for (const actor of [actors[0], actors[2]]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      contexts.push(context)
      await context.addInitScript(({ token, name }) => {
        localStorage.setItem('pooltool.token', token); localStorage.setItem('pooltool.name', name)
        // Only hold native sockets so the test can exercise a real transport drop.
        const OriginalWebSocket = window.WebSocket
        window.__policySockets = []
        window.WebSocket = class extends OriginalWebSocket { constructor(...args) { super(...args); window.__policySockets.push(this) } }
      }, { token: actor.token, name: actor.user.displayName })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      pages.push(page)
      await page.goto(base)
      await waitScene(page)
      await assertPolicy(page, { locked: true, checked: false })
      const stored = await page.evaluate(id => JSON.parse(localStorage.getItem(`pooltool.settings.${id}`)), actor.user.id)
      assert.equal(stored.showAimGuide, true, 'Ranked presentation must not persist its forced false value')
    }
    const first = pages[0]
    const canvas = await first.locator('.game-stage canvas').elementHandle()
    // Changing another preference while locked must not leak the derived false
    // value into the server's saved casual settings through update:settings.
    await first.getByRole('navigation', { name: 'Навигация матча' }).getByRole('button', { name: 'Матч', exact: true }).click()
    await clickHudAction(first, first.getByRole('button', { name: 'Меню матча', exact: true }))
    await first.getByRole('button', { name: 'Настройки', exact: true }).click()
    await first.getByRole('button', { name: 'Звук', exact: true }).click()
    await first.getByLabel('Общая громкость', { exact: true }).evaluate(input => { input.value = '0.6'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await first.getByRole('button', { name: 'Применить', exact: true }).click()
    await first.locator('.club-settings-shell').waitFor({ state: 'hidden' })
    const saved = (await api(actors[0], '/api/me/settings', undefined, 'GET')).settings
    assert.equal(saved.showAimGuide, true)
    assert.equal(saved.volume, 0.6)
    assert.equal(await canvas.evaluate(element => element === document.querySelector('.game-stage canvas')), true, 'Settings must not rebuild scene')
    await assertPolicy(first, { locked: true, checked: false })
    await first.reload()
    await waitScene(first)
    await assertPolicy(first, { locked: true, checked: false })
    // Real socket close -> reconnect -> same authoritative ranked lock.
    await first.evaluate(() => window.__policySockets.forEach(socket => socket.close()))
    await first.waitForFunction(() => window.__policySockets.length > 1 && window.__policySockets.at(-1).readyState === WebSocket.OPEN, null, { timeout: 15_000 })
    const control = first.getByRole('switch', { name: 'Линия прицеливания', exact: true })
    assert.equal(await control.isDisabled(), true)
    assert.equal(await control.getAttribute('aria-checked'), 'false')
    const current = (await api(actors[0], `/api/matches/${paired.match.id}`, undefined, 'GET')).match
    // The visible player wins. An authoritative self-surrender now leaves the
    // match instead of keeping its finished settings overlay open.
    await api(actors[1], `/api/matches/${current.id}/commands`, { commandId: `policy-end-${engineName}-${Date.now()}`, expectedRevision: current.revision, type: 'surrender' })
    for (const page of pages) {
      await page.waitForFunction(() => { const element = document.querySelector('[aria-label="Линия прицеливания"]'); return element && !element.disabled && element.getAttribute('aria-checked') === 'true' })
    }
    // Leave the UI actor through its actual navigation so its lifecycle guards
    // can reject delayed packets; don't remove a live UI participant behind it.
    await pages[1].close()
    const settings = first.locator('.club-settings-shell')
    await settings.getByRole('button', { name: 'Назад', exact: true }).click()
    await settings.getByRole('heading', { name: 'Настройки', exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Назад к меню матча', exact: true }).click()
    await first.getByRole('dialog').getByRole('button', { name: 'В главное меню', exact: true }).click()
    await first.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor()
    for (const actor of actors.slice(1)) await api(actor, `/api/rooms/${room.code}/leave`)
    room = null
    const casual = await pair(actors[0], actors[1], 'casual')
    room = casual.room
    await first.reload()
    await waitScene(first)
    await assertPolicy(first, { locked: false, checked: true })
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine: engineName, passed: 'ranked players+spectators locked OFF; saved casual pref preserved during settings changes; fresh scene/reload/real socket reconnect; finished+casual preference restored; stable canvas; no JS errors' }))
  } finally {
    keepalive?.close()
    if (room) for (const actor of actors) await api(actor, `/api/rooms/${room.code}/leave`).catch(() => {})
    for (const context of contexts) await context.close()
    await browser.close()
  }
}
