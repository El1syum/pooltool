// Compiled client, real WebGL and authenticated settings on the Pooltool service.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clickHudAction } from './app-state.mjs'

const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)
assert.ok(local || process.env.ANTIALIAS_PUBLIC_SMOKE === '1', 'Use loopback by default; the public smoke creates only its own guest and solo room')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)

async function api(endpoint, token, body) {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, 200, `${endpoint}: ${response.status}`)
  return response.json()
}

assert.equal((await api('/ready')).physics, 'pooltool')
for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({
    headless: true,
    ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  let actor, room
  try {
    actor = await api('/api/auth/guest', null, { displayName: `AA QA ${engine}`, clientVersion: 'antialias-settings-qa' })
    const started = await api('/api/solo', actor.token, { difficulty: 'easy', turnSeconds: 180 })
    room = started.room
    const context = await browser.newContext({ viewport: { width: 1080, height: 760 } })
    await context.addInitScript(token => localStorage.setItem('pooltool.token', token), actor.token)
    const page = await context.newPage(), errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.goto(base)
    await page.getByTestId('match-hud').waitFor()
    const canvas = page.locator('.game-stage canvas')
    const waitForMode = mode => page.locator(`.game-stage canvas[data-antialias-mode="${mode}"]`).waitFor()
    await waitForMode('auto')
    await canvas.evaluate(el => { el.dataset.qaSameCanvas = '1' })

    async function apply(mode, previous) {
      await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'Настройки', exact: true }).click()
      await dialog.getByRole('button', { name: 'Графика', exact: true }).click()
      const select = dialog.getByRole('combobox', { name: 'Сглаживание', exact: true })
      assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(option => option.value)), ['auto', 'fxaa', 'smaa'])
      assert.equal(await select.inputValue(), previous)
      await select.selectOption(mode)
      await dialog.getByRole('button', { name: 'Применить', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await waitForMode(mode)
      assert.equal((await api('/api/me/settings', actor.token)).settings.antialiasMode, mode)
      assert.equal(await canvas.getAttribute('data-qa-same-canvas'), '1', 'Applying AA must not recreate the game canvas')
      const { match } = await api('/api/me/current', actor.token)
      assert.equal(match.id, started.match.id)
      assert.equal(match.deadline, started.match.deadline, 'Changing local rendering must not alter the server deadline')
    }
    await apply('fxaa', 'auto')
    await apply('smaa', 'fxaa')
    await apply('auto', 'smaa')
    await apply('smaa', 'auto')
    await page.setViewportSize({ width: 760, height: 620 })
    await page.waitForFunction(() => document.querySelector('.game-stage canvas').width === 760)
    await waitForMode('smaa')
    await page.evaluate(userId => localStorage.removeItem(`pooltool.settings.${userId}`), actor.user.id)
    await page.reload()
    await page.getByTestId('match-hud').waitFor()
    await waitForMode('smaa')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine, liveModes: ['auto', 'fxaa', 'smaa'], persistedAfterReload: true, resized: true, sameCanvas: true, deadlineUnchanged: true, errors: errors.length }))
  } finally {
    if (room && actor) await api(`/api/rooms/${room.code}/leave`, actor.token, {}).catch(() => {})
    await browser.close()
  }
}
