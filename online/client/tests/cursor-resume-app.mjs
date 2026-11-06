// Actual compiled App + real loopback API. Only this test's guest/solo room is
// changed. Browser blur/focus/visibility events exercise the real app handlers;
// this does not claim native OS application-switch certification.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback service')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/cursor-resume-app')
await mkdir(artifacts, { recursive: true })
const ready = await fetch(`${base}/ready`)
assert.equal(ready.status, 200)
assert.equal((await ready.json()).physics, 'pooltool')

async function api(actor, endpoint, body, method = 'POST', allowed = [200]) {
  const response = await fetch(base + endpoint, {
    method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }), signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${method} ${endpoint}: ${response.status} ${JSON.stringify(data.detail || '')}`)
  return data
}

for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage(), errors = [], shots = [], badAssets = []
  let actor, room
  page.on('pageerror', error => errors.push(error.message))
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const message = JSON.parse(frame.payload); if (message.type === 'command' && message.command?.type === 'shot') shots.push(message) } catch {}
  }))
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/matches\/[^/]+\/commands$/.test(new URL(request.url()).pathname) && request.postDataJSON()?.type === 'shot') shots.push(request.postDataJSON())
  })
  page.on('response', response => {
    if (/\.(js|css|svg|png|webp|ttf)$/.test(new URL(response.url()).pathname) && !response.ok()) badAssets.push(response.url())
  })
  try {
    actor = await api(null, '/api/auth/guest', { displayName: `Resume ${engine}`, clientVersion: 'cursor-resume-app-qa' })
    const solo = await api(actor, '/api/solo', { difficulty: 'easy', turnSeconds: 180 })
    room = solo.room
    await context.addInitScript(token => {
      localStorage.setItem('pooltool.token', token)
      window.qaLockRequests = 0
      const original = HTMLCanvasElement.prototype.requestPointerLock
      if (typeof original === 'function') HTMLCanvasElement.prototype.requestPointerLock = function (...args) {
        window.qaLockRequests++
        return original.apply(this, args)
      }
    }, actor.token)
    await page.goto(base)
    await page.bringToFront()
    const hud = page.getByTestId('match-hud'), banner = page.getByTestId('game-input-resume')
    await hud.waitFor()
    await page.locator('.game-stage canvas').waitFor()
    if (await banner.count()) await banner.getByRole('button', { name: 'Продолжить игру', exact: true }).click()
    const canvas = page.locator('.game-stage canvas')
    const canvasMarker = `resume-canvas-${engine}`
    await canvas.evaluate((element, marker) => { element.dataset.resumeQa = marker }, canvasMarker)
    const phase = () => hud.getAttribute('data-shot-phase')
    const heading = () => hud.getAttribute('data-aim-direction')
    const lockRequests = () => page.evaluate(() => window.qaLockRequests)
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const pause = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await banner.waitFor()
      await page.waitForFunction(() => !document.pointerLockElement)
    }
    const restoreUpdates = async () => {
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/current' && response.request().method() === 'GET')
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
      assert.equal((await restored).status(), 200, 'Visibility restore must use the real current-match API')
      await page.waitForTimeout(200)
      await frames()
    }
    const clickScene = () => page.mouse.click(32, 270)

    // Set actual shot controls through the shipped drawer before suspending.
    await page.keyboard.down('ControlLeft')
    await page.locator('[data-testid="match-hud"].hud-assist-visible').waitFor()
    await page.waitForFunction(() => !document.pointerLockElement)
    await page.getByRole('button', { name: 'Параметры удара', exact: true }).click()
    await page.keyboard.up('ControlLeft')
    for (const [name, value] of [['Направление удара', 123], ['Сила удара', 3], ['Наклон кия', 10], ['Вращение X', .2], ['Вращение Y', -.1]]) {
      await page.getByRole('slider', { name, exact: true }).evaluate((element, next) => {
        element.value = String(next); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }))
      }, value)
    }
    await page.getByRole('button', { name: 'Закрыть параметры удара', exact: true }).click()
    await pause()
    const savedHeading = await heading(), requestsBeforeRestore = await lockRequests()
    await restoreUpdates()
    await page.mouse.move(800, 350); await page.mouse.move(1439, 350); await page.waitForTimeout(600)
    assert.equal(await heading(), savedHeading, 'Returning hover and edge dwell must not rotate the actual App aim')
    assert.equal(await phase(), 'overview')
    assert.equal(await lockRequests(), requestsBeforeRestore, 'Visibility/API restore cannot reacquire the cursor')
    await banner.getByRole('button', { name: 'Продолжить игру', exact: true }).click()
    await banner.waitFor({ state: 'hidden' })
    assert.equal(await heading(), savedHeading, 'The explicit resume button preserves the chosen heading')
    assert.equal(await phase(), 'overview', 'The resume button is not a heading-confirmation click')

    // A separate click enters contact. The HUD itself must freeze, not just the
    // renderer, because its pointermove handler updates a/b independently.
    await clickScene()
    await page.locator('[data-testid="match-hud"][data-shot-phase="aim"]').waitFor()
    const reticle = page.getByRole('button', { name: 'Точка удара по битку. Нажмите для выбора силы', exact: true })
    const bounds = await reticle.boundingBox()
    await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .35)
    const contactBeforePause = await page.locator('.hud-reticle-center').getAttribute('style')
    const contactHeading = await heading()
    await pause()
    assert.equal(await reticle.isDisabled(), true)
    await restoreUpdates()
    await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .75)
    await frames()
    assert.equal(await page.locator('.hud-reticle-center').getAttribute('style'), contactBeforePause, 'Paused HUD contact hover cannot change spin')
    assert.equal(await heading(), contactHeading)
    await clickScene()
    await banner.waitFor({ state: 'hidden' })
    assert.equal(await phase(), 'aim', 'The returning canvas click resumes without advancing contact')
    assert.equal(await page.locator('.hud-reticle-center').getAttribute('style'), contactBeforePause)
    await clickScene()
    await page.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()

    // Interrupt a genuine power pull. Neither its late release nor the next
    // restoring click may become a server command.
    await page.mouse.move(400, 300); await page.mouse.down(); await page.mouse.move(400, 430, { steps: 5 })
    await pause()
    const powerBeforeReturn = await page.locator('.hud-power-number').innerText()
    const powerHeading = await heading()
    await page.mouse.up()
    await restoreUpdates()
    await page.mouse.move(1200, 500)
    await clickScene()
    await banner.waitFor({ state: 'hidden' })
    assert.equal(await phase(), 'power', 'The returning click cannot submit or reset a prepared power phase')
    assert.equal(await heading(), powerHeading)
    assert.equal(await page.locator('.hud-power-number').innerText(), powerBeforeReturn)
    assert.deepEqual(shots, [])

    // Navigation remains accessible while frozen, and does not silently clear
    // suspension. Recreating the real scene via the read-only workshop keeps it.
    await pause()
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.locator('.club-settings-shell').waitFor()
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click()
    await banner.waitFor()
    const beforeRecreate = await heading(), requestsBeforeRecreate = await lockRequests()
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.getByRole('button', { name: 'Модели стола и окружения', exact: true }).click()
    await page.locator('.model-library-page').waitFor()
    await page.getByRole('button', { name: 'Вернуться', exact: true }).click()
    await hud.waitFor(); await canvas.waitFor(); await banner.waitFor()
    await restoreUpdates()
    assert.equal(await heading(), beforeRecreate, 'Scene recreation preserves the selected heading')
    assert.equal(await lockRequests(), requestsBeforeRecreate, 'A recreated scene does not inherit capture authority')
    assert.equal(await canvas.getAttribute('data-resume-qa'), null, 'The workshop return really recreated the scene')
    await clickScene()
    await banner.waitFor({ state: 'hidden' })
    assert.equal(await phase(), 'overview')
    assert.equal(await heading(), beforeRecreate)
    assert.deepEqual(shots, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(badAssets, [])
    await page.screenshot({ path: path.join(artifacts, `${engine}-resumed.png`) })
    console.log(JSON.stringify({ engine, actualApp: true, realApi: true, eventDrivenFocusCases: true, headingResumeOnly: true, pausedHudContactFrozen: true, abortedPowerNoShot: true, navigationAccessible: true, sceneRecreatedWithoutCapture: true, shotCommands: shots.length, jsErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    if (actor && room) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await context.close(); await browser.close()
  }
}
