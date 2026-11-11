// Actual App and real settings API. No transport, identity or gameplay is stubbed.
// Only disposable loopback guest profiles/solo rooms are changed.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback service')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/assist-binding')
await mkdir(artifacts, { recursive: true })
assert.equal((await (await fetch(`${base}/ready`)).json()).physics, 'pooltool')

async function api(actor, endpoint, body, method = 'POST', allowed = [200]) {
  const response = await fetch(base + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30_000),
  })
  const value = await response.json()
  assert.ok(allowed.includes(response.status), `${method} ${endpoint}: ${response.status} ${JSON.stringify(value.detail ?? '')}`)
  return value
}

async function openAdvancedControls(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Настройки', exact: true }).click()
  const settings = page.locator('.club-settings-shell')
  await settings.getByRole('button', { name: 'Управление', exact: true }).click()
  await settings.locator('summary').filter({ hasText: /^Дополнительные назначения$/ }).click()
  return settings
}

for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = [], shots = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const value = JSON.parse(frame.payload); if (value.type === 'command' && value.command?.type === 'shot') shots.push(value) } catch {}
  }))
  let actor, room
  try {
    actor = await api(null, '/api/auth/guest', { displayName: `Assist ${engine}`, clientVersion: 'assist-binding-qa' })
    const legacy = { quality: 'medium', volume: .5, sensitivity: 1, bindings: { shoot: 'Space', resetCamera: 'KeyC', orbit: 'Mouse2' }, showAimGuide: true, showPocketLabels: true }
    await api(actor, '/api/me/settings', legacy, 'PUT')
    const solo = await api(actor, '/api/solo', { difficulty: 'easy', turnSeconds: 180 })
    room = solo.room
    await context.addInitScript(({ token, userId, legacy }) => {
      localStorage.setItem('pooltool.token', token)
      if (!sessionStorage.getItem('assist-legacy-installed')) {
        localStorage.setItem(`pooltool.settings.${userId}`, JSON.stringify(legacy))
        sessionStorage.setItem('assist-legacy-installed', '1')
      }
    }, { token: actor.token, userId: actor.user.id, legacy })
    await page.goto(base)
    await page.getByTestId('match-hud').waitFor()
    await page.locator('.game-stage canvas').waitFor()
    assert.match(await page.locator('.hud-alt-hint').innerText(), /Ctrl/)
    // The first-person heading uses native PointerLock. The configured assist
    // hold intentionally releases it so a real cursor can reach HUD controls.
    await page.keyboard.down('ControlLeft')
    await page.getByTestId('alt-assist').waitFor()
    await page.getByRole('button', { name: 'Параметры удара', exact: true }).click()
    await page.keyboard.up('ControlLeft')
    await page.getByRole('button', { name: 'Прицелиться', exact: true }).click()
    await page.getByRole('button', { name: 'Точка удара по битку. Нажмите для выбора силы', exact: true }).click()
    await page.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()
    assert.equal(await page.getByRole('meter').count(), 2)
    assert.equal(await page.getByTestId('alt-assist').count(), 0)
    await page.keyboard.down('AltLeft')
    assert.equal(await page.getByTestId('alt-assist').count(), 0, 'The old hidden Alt binding must not remain active')
    await page.keyboard.up('AltLeft')
    await page.keyboard.down('ControlLeft')
    await page.getByTestId('alt-assist').waitFor()
    await page.keyboard.down('ControlRight')
    await page.keyboard.up('ControlLeft')
    assert.equal(await page.getByTestId('alt-assist').count(), 1, 'Either held Ctrl keeps the cards available')
    await page.keyboard.up('ControlRight')
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('meter').count(), 2)
    await page.keyboard.down('ControlLeft')
    await page.getByTestId('alt-assist').waitFor()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    await page.keyboard.up('ControlLeft')
    await page.keyboard.down('ControlRight')
    await page.getByTestId('alt-assist').waitFor()
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    await page.getByRole('dialog').getByRole('button', { name: 'Продолжить игру', exact: true }).click()
    assert.equal(await page.getByTestId('alt-assist').count(), 0, 'Closing a modal must not revive stale held-key state')
    await page.keyboard.up('ControlRight')

    await page.keyboard.down('ControlLeft')
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.keyboard.up('ControlLeft')
    const settings = await openAdvancedControls(page)
    const assist = settings.getByRole('button', { name: 'Назначение: Дополнительные приборы', exact: true })
    const apply = settings.getByRole('button', { name: 'Применить', exact: true })
    assert.equal(await assist.innerText(), 'Ctrl')
    await assist.click()
    const captureBox = await assist.boundingBox()
    await page.mouse.click(captureBox.x + captureBox.width / 2, captureBox.y + captureBox.height / 2)
    await page.getByText('Для дополнительных приборов выберите клавишу клавиатуры. Esc — отмена.', { exact: true }).waitFor()
    assert.match(await assist.innerText(), /Нажмите клавишу/)
    await page.keyboard.press('Escape')
    assert.equal(await assist.innerText(), 'Ctrl')
    await assist.click()
    await page.keyboard.press('KeyH')
    assert.equal(await assist.innerText(), 'H')
    await settings.locator('.club-control-hint').getByText(/Дополнительные приборы — H\./).waitFor()

    // Family-aware conflicts cannot silently put assist and a shot on the two Ctrl keys.
    await assist.click(); await page.keyboard.press('ControlLeft')
    const shootBinding = page.getByRole('button', { name: 'Назначение: Удар', exact: true })
    await shootBinding.click(); await page.keyboard.press('ControlRight')
    await page.getByText(/Конфликт:.*Ctrl/).waitFor()
    assert.equal(await apply.isDisabled(), true)
    await shootBinding.click(); await page.keyboard.press('Space')
    // An invalid unsaved overlap applies immediately, but assist must win over
    // shoot even before the player resolves the conflict and can save.
    await assist.click(); await page.keyboard.press('Space')
    assert.equal(await apply.isDisabled(), true)
    await settings.getByRole('navigation', { name: 'Навигация матча' }).getByRole('button', { name: 'Матч', exact: true }).click()
    await settings.waitFor({ state: 'hidden' })
    await page.keyboard.down('Space')
    await page.getByTestId('alt-assist').waitFor()
    assert.deepEqual(shots, [], 'An unsaved assist/shoot conflict must not fire a shot')
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.keyboard.up('Space')
    await openAdvancedControls(page)
    await assist.click(); await page.keyboard.press('KeyH')
    const saved = page.waitForResponse(response => response.url().endsWith('/api/me/settings') && response.request().method() === 'PUT' && response.request().postDataJSON()?.bindings?.assist === 'KeyH' && response.ok())
    await apply.click()
    await saved
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.equal((await api(actor, '/api/me/settings', undefined, 'GET')).settings.bindings.assist, 'KeyH')
    assert.match(await page.locator('.hud-alt-hint').innerText(), /H/)
    await page.keyboard.down('ControlLeft')
    assert.equal(await page.getByTestId('alt-assist').count(), 0)
    await page.keyboard.up('ControlLeft')
    await page.keyboard.down('KeyH')
    await page.getByTestId('alt-assist').waitFor()
    assert.match(await page.getByTestId('alt-assist').getAttribute('aria-label'), /H/)
    await page.keyboard.up('KeyH')
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    await page.keyboard.down('KeyH')
    await page.getByTestId('alt-assist').waitFor()
    await page.getByRole('button', { name: 'Параметры удара', exact: true }).click()
    await page.keyboard.up('KeyH')
    await page.getByRole('slider', { name: 'Направление удара', exact: true }).focus()
    await page.keyboard.press('KeyH')
    assert.equal(await page.getByTestId('alt-assist').count(), 0, 'Editing a field must not activate the assist hold binding')
    await page.getByRole('button', { name: 'Закрыть параметры удара', exact: true }).click()

    // Remove the local preference, proving the persisted API value restores the key.
    await page.evaluate(id => localStorage.removeItem(`pooltool.settings.${id}`), actor.user.id)
    await page.reload()
    await page.getByTestId('match-hud').waitFor()
    assert.match(await page.locator('.hud-alt-hint').innerText(), /H/)
    await page.keyboard.down('KeyH')
    await page.getByTestId('alt-assist').waitFor()
    await page.keyboard.up('KeyH')
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    // A normal letter can be assigned after freeing its old action. Native
    // Ctrl+C must then remain a browser chord, not activate assist or reset.
    await page.keyboard.down('KeyH')
    await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.keyboard.up('KeyH')
    await openAdvancedControls(page)
    await page.getByRole('button', { name: 'Назначение: Сброс камеры', exact: true }).click()
    await page.keyboard.press('KeyJ')
    await page.getByRole('button', { name: 'Назначение: Дополнительные приборы', exact: true }).click()
    await page.keyboard.press('KeyC')
    const savedC = page.waitForResponse(response => response.url().endsWith('/api/me/settings') && response.request().method() === 'PUT' && response.request().postDataJSON()?.bindings?.assist === 'KeyC' && response.ok())
    await apply.click()
    await savedC
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.evaluate(() => {
      window.assistCopyChord = []
      document.addEventListener('keydown', event => { if (event.ctrlKey && event.code === 'KeyC') window.assistCopyChord.push({ prevented: event.defaultPrevented }) })
    })
    await page.keyboard.press('ControlLeft+KeyC')
    assert.deepEqual(await page.evaluate(() => window.assistCopyChord), [{ prevented: false }], 'Ctrl+C must reach the browser without being consumed by assist C')
    assert.equal(await page.getByTestId('alt-assist').count(), 0)
    await page.keyboard.down('KeyC')
    await page.getByTestId('alt-assist').waitFor()
    await page.keyboard.up('KeyC')
    await page.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    assert.deepEqual(shots, [], 'Displaying/remapping assist must never submit a shot')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(artifacts, `${engine}-remapped-H.png`) })
    console.log(JSON.stringify({ engine, actualApp: true, realSettingsApi: true, defaultCtrlFamily: true, oldAltInactive: true, keyboardOnlyCapture: true, escapeCancels: true, familyConflict: true, unsavedConflictSafe: true, remappedH: true, serverReload: true, nativeCopyChordSafe: true, keyupBlurModalSafe: true, shotCommands: shots.length, jsErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`), fullPage: true }).catch(() => {})
    throw error
  } finally {
    if (room && actor) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await context.close(); await browser.close()
  }
}
