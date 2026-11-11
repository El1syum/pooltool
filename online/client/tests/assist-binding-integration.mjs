// Actual App and real settings API. No transport, identity or gameplay is stubbed.
// Only disposable loopback guest profiles/solo rooms are changed.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clickHudAction } from './app-state.mjs'

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

async function openControls(page) {
  await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
  await page.getByRole('dialog').getByRole('button', { name: 'Настройки', exact: true }).click()
  const settings = page.locator('.club-settings-shell')
  await settings.getByRole('button', { name: 'Управление', exact: true }).click()
  assert.equal(await settings.locator('details').count(), 0)
  assert.equal(await settings.getByRole('button', { name: 'Назначение: Дополнительные приборы', exact: true }).count(), 0)
  return settings
}

async function enterPower(page) {
  const hud = page.getByTestId('match-hud')
  // A trusted canvas click may first resume input after backgrounding. Stop
  // once power is selected: never click again and accidentally make a shot.
  for (let i = 0; i < 4 && await hud.getAttribute('data-shot-phase') !== 'power'; i++) {
    await page.mouse.click(42, 260)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  await page.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()
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
    await page.bringToFront()
    await page.getByTestId('match-hud').waitFor()
    await page.locator('.game-stage canvas').waitFor()
    const assist = page.getByTestId('alt-assist')
    await enterPower(page)
    await page.keyboard.down('ControlLeft')
    await assist.waitFor()
    assert.match(await assist.getAttribute('aria-label'), /Ctrl/)
    await page.keyboard.up('ControlLeft')
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

    const settings = await openControls(page)
    const topView = settings.getByRole('button', { name: 'Назначение: Вид сверху', exact: true })
    const apply = settings.getByRole('button', { name: 'Применить', exact: true })
    const originalTopView = await topView.innerText()
    await topView.click()
    assert.match(await topView.innerText(), /Нажмите клавишу/)
    await page.keyboard.press('Escape')
    assert.equal(await topView.innerText(), originalTopView)
    // Existing hidden preferences must still be considered when editing a
    // visible Figma binding. The two physical Ctrl keys are one family.
    await topView.click(); await page.keyboard.press('ControlRight')
    await page.getByText(/Конфликт:.*Ctrl/).waitFor()
    assert.equal(await apply.isDisabled(), true)
    await topView.click(); await page.keyboard.press('KeyT')
    await apply.click()
    await settings.waitFor({ state: 'hidden' })
    async function loadStoredBinding(binding, additional = {}) {
      await api(actor, '/api/me/settings', { ...legacy, bindings: { ...legacy.bindings, ...additional, assist: binding } }, 'PUT')
      assert.equal((await api(actor, '/api/me/settings', undefined, 'GET')).settings.bindings.assist, binding)
      await page.evaluate(id => localStorage.removeItem(`pooltool.settings.${id}`), actor.user.id)
      await page.reload()
      await page.getByTestId('match-hud').waitFor()
      await page.locator('.game-stage canvas').waitFor()
    }
    // Players may have saved a different binding before the UI was aligned
    // to Figma. The same persisted preference must keep working.
    await loadStoredBinding('KeyH')
    await enterPower(page)
    await page.keyboard.press('ControlLeft')
    assert.equal(await assist.count(), 0)
    await page.keyboard.down('KeyH')
    await assist.waitFor()
    assert.match(await assist.getAttribute('aria-label'), /H/)
    await page.keyboard.up('KeyH')
    await assist.waitFor({ state: 'hidden' })
    await loadStoredBinding('Space')
    await enterPower(page)
    await page.keyboard.down('Space')
    await assist.waitFor()
    await page.keyboard.up('Space')
    assert.deepEqual(shots, [], 'A stored assist/shoot conflict must not fire a shot')
    await loadStoredBinding('KeyC', { resetCamera: 'KeyJ' })
    await enterPower(page)
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
    await page.screenshot({ path: path.join(artifacts, `${engine}-assist.png`) })
    console.log(JSON.stringify({ engine, actualApp: true, realSettingsApi: true, defaultCtrlFamily: true, oldAltInactive: true, noExtraControls: true, escapeCancels: true, familyConflict: true, storedConflictSafe: true, legacyPreferenceRetained: true, nativeCopyChordSafe: true, keyupBlurModalSafe: true, shotCommands: shots.length, jsErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`), fullPage: true }).catch(() => {})
    throw error
  } finally {
    if (room && actor) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await context.close(); await browser.close()
  }
}
