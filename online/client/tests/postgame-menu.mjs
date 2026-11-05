// Real App + real Pooltool API lifecycle regression. Only this test's guest
// identities/rooms are changed. The sole intercepted response is an explicitly
// failed leave request; physics, match completion, and all successful exits are real.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback test server')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/postgame-menu')
await mkdir(artifacts, { recursive: true })
const readiness = await fetch(`${base}/ready`)
assert.equal(readiness.status, 200)
assert.equal((await readiness.json()).physics, 'pooltool', 'The real Pooltool engine is required')

async function api(actor, endpoint, body, method = 'POST', allowed = [200]) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${method} ${endpoint}: ${response.status} ${JSON.stringify(data.detail ?? '')}`)
  return data
}
async function until(callback, message, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await callback()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
async function mainMenu(page) {
  await page.locator('[data-club-view="menu"]').waitFor()
  const actions = page.getByRole('navigation', { name: 'Главное меню', exact: true })
  for (const name of ['Играть', 'Настройки', 'Профиль', 'Выход']) {
    await until(async () => await actions.getByRole('button', { name, exact: true }).isEnabled(), `Main-menu button stayed disabled: ${name}`)
  }
}
async function current(actor) { return api(actor, '/api/me/current', undefined, 'GET') }
async function activeMatch(page, actor, previousId) {
  await page.getByTestId('match-hud').waitFor()
  await page.locator('.game-stage canvas').waitFor()
  const state = await until(async () => {
    const state = await current(actor)
    return state.match?.status === 'active' && state.match.id !== previousId ? state : null
  }, 'A different, active authoritative match did not start')
  assert.equal(state.match.snapshot.balls.length, 16)
  assert.equal(await page.locator('.result-panel').count(), 0)
  return state
}
async function startSolo(page, actor) {
  await mainMenu(page)
  await page.getByRole('navigation', { name: 'Главное меню', exact: true }).getByRole('button', { name: 'Играть', exact: true }).click()
  await page.getByRole('button', { name: 'Тренировка с ботом', exact: true }).click()
  const botOptions = page.locator('[data-club-view="bot"] select')
  await botOptions.nth(0).selectOption('easy')
  await botOptions.nth(1).selectOption('180')
  await page.getByRole('button', { name: 'Играть с ботом', exact: true }).click()
  const state = await activeMatch(page, actor)
  assert.equal(state.room.settings.solo, true)
  return state
}
async function surrender(page, actor, matchId) {
  // Hold the actual help key even if a newly created scene's native lock grant
  // is still pending; checking pointerLockElement once races that browser event.
  await page.keyboard.down('ControlLeft')
  await page.locator('[data-testid="match-hud"].hud-assist-visible').waitFor()
  await page.waitForFunction(() => !document.pointerLockElement)
  try { await page.getByRole('button', { name: 'Меню матча', exact: true }).click() }
  finally { await page.keyboard.up('ControlLeft') }
  await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
  await page.getByRole('button', { name: 'Да, сдаться', exact: true }).click()
  await page.locator('.result-panel').waitFor()
  const finished = await until(async () => {
    const state = await current(actor)
    return state.match?.id === matchId && state.match.status === 'finished' ? state.match : null
  }, 'Surrender did not finish the real match')
  assert.notEqual(finished.winnerId, actor.user.id)
}
async function returnToMenu(page, actor) {
  await page.locator('.result-panel').getByRole('button', { name: 'В главное меню', exact: true }).click()
  await mainMenu(page)
  const state = await current(actor)
  assert.equal(state.room, null)
  assert.equal(state.match, null)
  assert.equal(await page.evaluate(() => localStorage.getItem('pooltool.token')), actor.token, 'Returning must preserve the guest identity')
}
async function createLobby(page, actor) {
  await mainMenu(page)
  await page.getByRole('navigation', { name: 'Главное меню', exact: true }).getByRole('button', { name: 'Играть', exact: true }).click()
  await page.getByRole('button', { name: 'Игра с другом', exact: true }).click()
  await page.getByRole('button', { name: 'Создать игру', exact: true }).click()
  await page.locator('[data-club-view="lobby"]').waitFor()
  const state = await current(actor)
  assert.ok(state.room?.code)
  assert.equal(state.match, null)
  return state.room
}

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  assert.ok(playwright[engineName], `Unknown browser: ${engineName}`)
  const browser = await playwright[engineName].launch({ headless: true,
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.DIRECT_NETWORK === '1' ? ['--no-proxy-server'] : [])] } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = [], failedAssets = [], actors = [], completed = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) failedAssets.push(`${response.status()} ${response.url()}`)
  })
  try {
    await page.goto(base)
    await mainMenu(page)
    const token = await page.evaluate(() => localStorage.getItem('pooltool.token'))
    assert.ok(token)
    const actor = { token, ...(await api({ token }, '/api/me', undefined, 'GET')) }
    actors.push(actor)

    const solo1 = await startSolo(page, actor)
    await surrender(page, actor, solo1.match.id)
    completed.push(solo1.match.id)
    await page.locator('.result-panel').getByRole('button', { name: 'Сыграть ещё', exact: true }).click()
    const solo2 = await activeMatch(page, actor, solo1.match.id)
    assert.equal(solo2.room.settings.solo, true)
    await surrender(page, actor, solo2.match.id)
    completed.push(solo2.match.id)
    await returnToMenu(page, actor)

    // Every main-menu action remains usable without refreshing the document.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.locator('.club-settings-shell').waitFor()
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click()
    await mainMenu(page)
    await page.getByRole('button', { name: 'Профиль', exact: true }).click()
    await page.getByRole('heading', { name: 'Ваш профиль', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Назад', exact: true }).click()
    await mainMenu(page)
    await page.getByRole('button', { name: 'Выход', exact: true }).click()
    await page.getByRole('heading', { name: 'Покинуть клуб?', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    await mainMenu(page)

    await createLobby(page, actor)
    await page.getByRole('button', { name: 'Выйти из комнаты', exact: true }).click()
    await mainMenu(page)
    assert.equal((await current(actor)).room, null)
    await page.getByRole('button', { name: 'Играть', exact: true }).click()
    await page.getByRole('button', { name: 'Случайный противник', exact: true }).click()
    await page.locator('[data-club-view="search"]').waitFor()
    await page.getByRole('button', { name: 'Отменить поиск', exact: true }).click()
    await page.locator('[data-club-view="choices"]').waitFor()
    await page.getByRole('button', { name: 'Назад', exact: true }).click()
    await mainMenu(page)

    // A genuine two-human match also returns to a working menu. The opponent
    // uses the normal API; the visible player creates/readies/surrenders via UI.
    const opponent = await api(null, '/api/auth/guest', { displayName: `Postgame ${engineName} opponent`, clientVersion: 'postgame-menu-qa' })
    actors.push(opponent)
    const humanRoom = await createLobby(page, actor)
    await api(opponent, `/api/rooms/${humanRoom.code}/join`)
    await page.getByRole('button', { name: 'Готов', exact: true }).click()
    await until(async () => (await current(actor)).room.players.find(player => player.id === actor.user.id)?.ready, 'Host readiness was not saved')
    await api(opponent, `/api/rooms/${humanRoom.code}/ready`, { ready: true })
    const human = await activeMatch(page, actor)
    assert.ok(!human.room.settings.solo)
    await surrender(page, actor, human.match.id)
    completed.push(human.match.id)

    // Hold exactly one failed leave response to check both in-flight ownership
    // (button disabled) and recovery (error visible, retry enabled).
    let releaseLeave, intercepted = false
    const leaveHeld = new Promise(resolve => { releaseLeave = resolve })
    const leaveUrl = `${base}/api/rooms/${humanRoom.code}/leave`
    await page.route(leaveUrl, async route => {
      intercepted = true
      await leaveHeld
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Тестовая ошибка выхода' }) })
    }, { times: 1 })
    const exit = page.locator('.result-panel').getByRole('button', { name: 'В главное меню', exact: true })
    await exit.click()
    await until(() => intercepted, 'The explicit leave failure was not reached')
    assert.equal(await exit.isDisabled(), true, 'The active leave operation must own busy state')
    releaseLeave()
    await page.getByRole('alert').filter({ hasText: 'Тестовая ошибка выхода' }).waitFor()
    await until(() => exit.isEnabled(), 'A failed leave must release its own busy state')
    assert.equal((await current(actor)).match.id, human.match.id, 'Failed leave must preserve the real current match')
    await page.getByRole('button', { name: 'Закрыть ошибку', exact: true }).click()
    await returnToMenu(page, actor)

    const solo3 = await startSolo(page, actor)
    await surrender(page, actor, solo3.match.id)
    completed.push(solo3.match.id)
    await returnToMenu(page, actor)
    assert.equal(new Set(completed).size, 4)
    assert.deepEqual(errors, [], 'No uncaught App errors')
    assert.deepEqual(failedAssets, [], 'No failed static assets')
    await page.screenshot({ path: path.join(artifacts, `${engineName}-menu-after-four-matches.png`), fullPage: true })
    console.log(JSON.stringify({ browser: engineName, completedMatches: completed.length, playAgain: true, mainMenuActions: 4, createAndLeave: true, searchAndCancel: true, failedLeaveRecovered: true, uncaughtErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engineName}-failure.png`), fullPage: true }).catch(() => {})
    throw error
  } finally {
    await context.close()
    for (const actor of actors) {
      const state = await current(actor).catch(() => null)
      if (state?.queue) await api(actor, '/api/matchmaking', {}, 'DELETE', [200, 404, 409]).catch(() => {})
      if (state?.room?.code) await api(actor, `/api/rooms/${state.room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    }
    await browser.close()
  }
}
