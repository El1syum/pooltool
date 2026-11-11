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
    const hud = page.getByTestId('match-hud')
    await hud.waitFor()
    const canvas = page.locator('.game-stage canvas')
    await canvas.waitFor()
    const canvasMarker = `resume-canvas-${engine}`
    await canvas.evaluate((element, marker) => { element.dataset.resumeQa = marker }, canvasMarker)
    const phase = () => hud.getAttribute('data-shot-phase')
    const heading = () => hud.getAttribute('data-aim-direction')
    const lockRequests = () => page.evaluate(() => window.qaLockRequests)
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const inputState = suspended => page.locator(`.game-stage canvas[data-input-suspended="${suspended}"]`).waitFor()
    const pause = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await inputState(true)
      await page.waitForFunction(() => !document.pointerLockElement)
      assert.equal(await page.getByTestId('game-input-resume').count(), 0, 'No extra recovery UI is mounted')
    }
    const restoreUpdates = async () => {
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/current' && response.request().method() === 'GET')
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
      assert.equal((await restored).status(), 200, 'Visibility restore must use the real current-match API')
      await page.waitForTimeout(200)
      await frames()
    }
    const clickScene = () => page.mouse.click(32, 270)
    if (await canvas.getAttribute('data-input-suspended') === 'true') await clickScene()
    await inputState(false)

    // Choose a heading via the real scene before simulating loss of focus.
    const initialHeading = await heading()
    await page.mouse.move(530, 350)
    await page.mouse.move(780, 350, { steps: 4 })
    await frames()
    assert.notEqual(await heading(), initialHeading, 'Foreground heading must respond to mouse input')
    await pause()
    const savedHeading = await heading(), requestsBeforeRestore = await lockRequests()
    await restoreUpdates()
    await page.mouse.move(800, 350); await page.mouse.move(1439, 350); await page.waitForTimeout(600)
    assert.equal(await heading(), savedHeading, 'Returning hover and edge dwell must not rotate the actual App aim')
    assert.equal(await phase(), 'overview')
    assert.equal(await lockRequests(), requestsBeforeRestore, 'Visibility/API restore cannot reacquire the cursor')
    await clickScene()
    await inputState(false)
    assert.equal(await heading(), savedHeading, 'The returning canvas click preserves the chosen heading')
    assert.equal(await phase(), 'overview', 'The returning click is not a heading confirmation')

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
    await inputState(false)
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
    await inputState(false)
    assert.equal(await phase(), 'power', 'The returning click cannot submit or reset a prepared power phase')
    assert.equal(await heading(), powerHeading)
    assert.equal(await page.locator('.hud-power-number').innerText(), powerBeforeReturn)
    assert.deepEqual(shots, [])

    // Match settings navigation remains accessible without clearing suspension
    // or recreating the canvas. There is no workshop link in this Figma flow.
    await pause()
    const beforeNavigation = await heading(), requestsBeforeNavigation = await lockRequests()
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    const settings = page.locator('.club-settings-shell')
    await settings.waitFor()
    assert.equal(await settings.getByRole('button', { name: 'Модели стола и окружения', exact: true }).count(), 0)
    await settings.getByRole('navigation', { name: 'Навигация матча' }).getByRole('button', { name: 'Матч', exact: true }).click()
    await inputState(true)
    await restoreUpdates()
    assert.equal(await heading(), beforeNavigation, 'Settings navigation preserves the selected heading')
    assert.equal(await lockRequests(), requestsBeforeNavigation, 'Settings navigation must not request capture')
    assert.equal(await canvas.getAttribute('data-resume-qa'), canvasMarker, 'The scene remains mounted across settings')
    await clickScene()
    await inputState(false)
    assert.equal(await phase(), 'overview')
    assert.equal(await heading(), beforeNavigation)
    assert.deepEqual(shots, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(badAssets, [])
    await page.screenshot({ path: path.join(artifacts, `${engine}-resumed.png`) })
    console.log(JSON.stringify({ engine, actualApp: true, realApi: true, eventDrivenFocusCases: true, headingResumeOnly: true, pausedHudContactFrozen: true, abortedPowerNoShot: true, navigationAccessible: true, scenePreservedWithoutCapture: true, shotCommands: shots.length, jsErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`) }).catch(() => {})
    throw error
  } finally {
    if (actor && room) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await context.close(); await browser.close()
  }
}
