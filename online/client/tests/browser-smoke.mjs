import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// `PLAYWRIGHT_MODULE` can point to a bundled playwright/index.mjs without a project dependency.
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = process.env.POOLTOOL_URL || 'http://127.0.0.1:8790'
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifactDir = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts')
const networkDelay = Math.max(0, Number(process.env.NETWORK_DELAY_MS) || 0)
await mkdir(artifactDir, { recursive: true })

async function api(page, endpoint, body, method = 'POST') {
  return page.evaluate(async ({ endpoint, body, method }) => {
    const response = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('pooltool.token')}` },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    return { status: response.status, data: await response.json() }
  }, { endpoint, body, method })
}

for (const engineName of engines) {
  const engine = playwright[engineName]
  assert.ok(engine, `Unknown browser engine: ${engineName}`)
  const browser = await engine.launch({ headless: true,
    ...(process.env[`${engineName.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`${engineName.toUpperCase()}_EXECUTABLE`] } : {}),
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const contexts = []
  const errors = []
  const failures = []
  const performanceSamples = []
  const textures = new Set()
  const tag = `${engineName}-${Date.now()}`
  try {
    async function client(label, viewport = { width: 1280, height: 800 }) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600 })
      contexts.push(context)
      if (networkDelay) await context.route('**/api/**', async route => {
        await new Promise(resolve => setTimeout(resolve, networkDelay))
        await route.continue()
      })
      await context.addInitScript(name => localStorage.setItem('pooltool.name', name), `${label}-${tag}`)
      await context.addInitScript(() => {
        const names = new WeakMap()
        const find = WebGL2RenderingContext.prototype.getUniformLocation
        const set = WebGL2RenderingContext.prototype.uniformMatrix4fv
        WebGL2RenderingContext.prototype.getUniformLocation = function (...args) {
          const location = find.apply(this, args)
          if (location) names.set(location, args[1])
          return location
        }
        WebGL2RenderingContext.prototype.uniformMatrix4fv = function (...args) {
          if (names.get(args[0]) === 'modelViewMatrix') window.__qaViewMatrix = Array.from(args[2])
          return set.apply(this, args)
        }
      })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(`${label}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`))
      page.on('requestfailed', request => failures.push({ client: label, path: new URL(request.url()).pathname, reason: request.failure()?.errorText }))
      page.on('request', request => {
        if (!request.url().endsWith('/api/telemetry/events') || request.method() !== 'POST') return
        for (const event of request.postDataJSON()?.events ?? []) if (event.type === 'clientPerformance') performanceSamples.push(event.data)
      })
      page.on('response', response => {
        if (/\/models\/balls\/[^/]+\.png$/.test(new URL(response.url()).pathname) && response.ok()) textures.add(response.url())
      })
      await page.goto(base)
      await page.getByRole('status').filter({ hasText: 'Соединение установлено' }).waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: 'Играть', exact: true }).click()
      return page
    }
    const first = await client('Host')
    const second = await client('Guest')
    const spectator = await client('Spectator', { width: 390, height: 844 })
    await first.getByLabel('Время на ход').selectOption('120')
    await first.getByRole('button', { name: 'Создать комнату', exact: true }).click()
    await first.getByRole('heading', { name: /^Комната / }).waitFor()
    const code = (await first.getByRole('heading', { name: /^Комната / }).innerText()).replace('Комната ', '').trim()
    await second.getByLabel('Код комнаты').fill(code)
    await second.getByRole('button', { name: 'Присоединиться', exact: true }).click()
    await second.getByRole('heading', { name: `Комната ${code}` }).waitFor()
    await first.getByRole('button', { name: 'Готов', exact: true }).click()
    await second.getByRole('button', { name: 'Готов', exact: true }).click()
    // The server starts as soon as both participants are ready.
    for (const player of [first, second]) await player.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    await spectator.getByLabel('Код комнаты').fill(code)
    await spectator.getByRole('button', { name: 'Наблюдать матч', exact: true }).click()
    await spectator.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    const state = await api(first, '/api/me/current', undefined, 'GET')
    assert.equal(state.status, 200)
    let currentMatch = state.data.match
    let initialRevision = currentMatch.revision
    const firstUser = (await api(first, '/api/me', undefined, 'GET')).data.user
    const currentPage = currentMatch.players[currentMatch.currentPlayer].id === firstUser.id ? first : second
    const otherPage = currentPage === first ? second : first
    if (currentMatch.snapshot.ballInHand) {
      const reposition = currentPage.getByRole('button', { name: 'Переставить биток', exact: true })
      if (await reposition.count()) await reposition.click()
      await currentPage.getByRole('button', { name: 'Вид сверху', exact: true }).click()
      const placementBounds = await currentPage.locator('.game-stage canvas').boundingBox()
      assert.ok(placementBounds)
      const placementResponse = currentPage.waitForResponse(response => response.url().includes(`/api/matches/${currentMatch.id}/commands`) && response.request().method() === 'POST')
      await currentPage.locator('.game-stage canvas').click({ position: { x: placementBounds.width * 0.5, y: placementBounds.height * 0.75 } })
      const placed = await placementResponse.then(response => response.json())
      assert.ok(placed.match, `Raycast cue placement failed: ${JSON.stringify(placed)}`)
      currentMatch = placed.match
      initialRevision = currentMatch.revision
    }
    assert.equal(await currentPage.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), true)
    assert.equal(await otherPage.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), false)
    assert.equal(await spectator.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), false)
    await first.getByRole('button', { name: 'Настройки', exact: true }).click()
    const dialog = first.getByRole('dialog')
    await dialog.getByLabel('Качество графики').selectOption('low')
    await dialog.locator('.binding-grid label').filter({ hasText: /^Удар/ }).getByRole('button').click()
    await first.keyboard.press('KeyQ')
    await dialog.locator('.binding-grid label').filter({ hasText: /^Удар/ }).getByRole('button').filter({ hasText: /^KeyQ$/ }).waitFor()
    await dialog.locator('.binding-grid label').filter({ hasText: /^Вращать камеру/ }).getByRole('button').click()
    await first.keyboard.press('KeyX')
    await dialog.locator('.binding-grid label').filter({ hasText: /^Вращать камеру/ }).getByRole('button').filter({ hasText: /^KeyX$/ }).waitFor()
    await dialog.getByRole('button', { name: 'Сохранить и закрыть', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const savedUser = (await api(first, '/api/me', undefined, 'GET')).data.user
    assert.equal(savedUser.settings.quality, 'low')
    assert.equal(savedUser.settings.bindings.shoot, 'KeyQ')
    assert.equal(savedUser.settings.bindings.orbit, 'KeyX')
    await first.reload()
    await first.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    await first.getByRole('button', { name: 'Настройки', exact: true }).click()
    assert.equal(await first.getByRole('dialog').getByLabel('Качество графики').inputValue(), 'low')
    await first.getByRole('dialog').locator('.binding-grid label').filter({ hasText: /^Удар/ }).getByRole('button').filter({ hasText: /^KeyQ$/ }).waitFor()
    await first.getByRole('dialog').getByRole('button', { name: 'Сохранить и закрыть', exact: true }).click()
    await first.getByRole('dialog').waitFor({ state: 'hidden' })
    await first.locator('.game-stage canvas').focus()
    const orbitAim = await first.getByLabel(/^Направление /).inputValue()
    const beforeOrbit = await first.evaluate(() => window.__qaViewMatrix)
    const orbitBounds = await first.locator('.game-stage canvas').boundingBox()
    assert.ok(orbitBounds)
    await first.keyboard.down('KeyX')
    await first.mouse.move(orbitBounds.x + orbitBounds.width / 2, orbitBounds.y + orbitBounds.height / 2)
    await first.mouse.down()
    await first.mouse.move(orbitBounds.x + orbitBounds.width / 2 + 80, orbitBounds.y + orbitBounds.height / 2 + 20, { steps: 6 })
    await first.mouse.up()
    await first.keyboard.up('KeyX')
    await first.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const afterOrbit = await first.evaluate(() => window.__qaViewMatrix)
    assert.ok(beforeOrbit && afterOrbit && beforeOrbit.some((value, index) => Math.abs(value - afterOrbit[index]) > 0.001), `A remapped keyboard modifier must orbit the camera with left drag (${JSON.stringify({ before: beforeOrbit, after: afterOrbit })})`)
    assert.equal(await first.getByLabel(/^Направление /).inputValue(), orbitAim, 'Orbit modifier must not change aim')
    const denied = await api(spectator, `/api/matches/${currentMatch.id}/commands`, {
      commandId: `spectator-${Date.now()}`, expectedRevision: initialRevision,
      type: 'shot', payload: { phi: 90, V0: 2.5, theta: 0, a: 0, b: 0 },
    })
    assert.ok([403, 409].includes(denied.status), `Spectator must be refused by the server, got ${denied.status}`)
    const bounds = await currentPage.locator('.game-stage canvas').boundingBox()
    assert.ok(bounds && bounds.width > 100 && bounds.height > 100)
    await currentPage.locator('.game-stage canvas').click({ position: { x: bounds.width * 0.55, y: bounds.height * 0.5 } })
    await currentPage.getByLabel(/^Направление /).evaluate(input => { input.value = '90'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await currentPage.getByLabel(/^Сила /).evaluate(input => { input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    await currentPage.getByRole('button', { name: 'Вид сверху', exact: true }).click()
    await currentPage.screenshot({ path: path.join(artifactDir, `${engineName}-desktop-initial.png`), fullPage: true })
    await spectator.screenshot({ path: path.join(artifactDir, `${engineName}-mobile-spectator.png`), fullPage: true })
    const commandResponse = currentPage.waitForResponse(response => response.url().includes(`/api/matches/${currentMatch.id}/commands`) && response.request().method() === 'POST', { timeout: 65_000 })
    await currentPage.getByRole('button', { name: 'Удар', exact: true }).click()
    await currentPage.locator('.match-status').filter({ hasText: /рассчитывает|Воспроизведение/ }).waitFor({ timeout: 10_000 })
    const result = await commandResponse.then(response => response.json())
    assert.ok(result.result?.trajectory?.frames?.length > 1, 'An actual physical trajectory is required')
    assert.ok(result.result.duration > 0, 'Shot duration is required')
    assert.equal(result.result.initialState.balls.length, 16)
    await currentPage.locator('.match-status').filter({ hasText: /Воспроизведение/ }).waitFor({ timeout: 30_000 })
    await otherPage.locator('.match-status').filter({ hasText: /Воспроизведение/ }).waitFor({ timeout: 30_000 })
    await spectator.locator('.match-status').filter({ hasText: /Воспроизведение/ }).waitFor({ timeout: 30_000 })
    await currentPage.screenshot({ path: path.join(artifactDir, `${engineName}-playback.png`), fullPage: true })
    // A reloaded observer resumes the running trajectory or the authoritative final state.
    await spectator.reload()
    await spectator.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    await currentPage.waitForFunction(() => !document.querySelector('.match-status')?.textContent?.includes('Воспроизведение') && !document.querySelector('.match-status')?.textContent?.includes('рассчитывает'), undefined, { timeout: Math.max(30_000, (result.result.duration + 8) * 1000) })
    currentMatch = (await api(first, '/api/me/current', undefined, 'GET')).data.match
    const finalOther = (await api(second, '/api/me/current', undefined, 'GET')).data.match
    const finalSpectator = (await api(spectator, '/api/me/current', undefined, 'GET')).data.match
    assert.ok(currentMatch.revision > initialRevision)
    assert.deepEqual(currentMatch.snapshot.balls, finalOther.snapshot.balls)
    assert.deepEqual(currentMatch.snapshot.balls, finalSpectator.snapshot.balls)
    assert.equal(await spectator.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), false)
    const spectatorLeave = spectator.waitForResponse(response => response.url().endsWith(`/api/rooms/${code}/leave`) && response.request().method() === 'POST')
    await spectator.getByRole('button', { name: 'Выйти', exact: true }).click()
    assert.equal((await spectatorLeave).status(), 200)
    await spectator.getByRole('button', { name: 'Играть', exact: true }).click()
    await spectator.getByLabel('Код комнаты').fill(code)
    await spectator.getByRole('button', { name: 'Наблюдать матч', exact: true }).click()
    await spectator.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    const rejoinedObserver = (await api(spectator, '/api/me/current', undefined, 'GET')).data.match
    assert.equal(rejoinedObserver.id, currentMatch.id, 'A spectator can explicitly rejoin the same room')
    assert.equal(await spectator.getByRole('button', { name: 'Удар', exact: true }).isEnabled(), false)
    await spectator.screenshot({ path: path.join(artifactDir, `${engineName}-spectator-rejoined.png`), fullPage: true })
    assert.ok(textures.size >= 16, `Original textures must load, got ${textures.size}`)
    assert.ok(performanceSamples.some(sample => sample.drawCalls > 20 && sample.triangles > 10000), 'Renderer must draw actual nonempty game geometry')
    const mobileSize = await spectator.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON() }))
    assert.ok(mobileSize.body <= mobileSize.viewport + 1, `Mobile page overflows horizontally: ${JSON.stringify(mobileSize)}`)
    assert.deepEqual(errors, [], `Unexpected JavaScript errors: ${errors.join('; ')}`)
    const surrendering = currentMatch.players[currentMatch.currentPlayer].id === firstUser.id ? first : second
    const surrendered = await api(surrendering, `/api/matches/${currentMatch.id}/commands`, {
      commandId: `finish-${Date.now()}`, expectedRevision: currentMatch.revision, type: 'surrender', payload: {},
    })
    assert.equal(surrendered.status, 200)
    assert.equal(surrendered.data.match.status, 'finished')
    await first.getByRole('button', { name: 'История и рейтинг', exact: true }).click()
    await first.getByRole('heading', { name: 'Профиль', exact: true }).waitFor()
    const history = await api(first, '/api/me/history', undefined, 'GET')
    assert.ok(history.data.matches.some(item => (item.id || item.matchId) === currentMatch.id), 'Completed match must appear in profile history')
    assert.equal((await api(first, '/api/me', undefined, 'GET')).data.user.games, 1)
    await first.getByRole('button', { name: 'Назад', exact: true }).click()
    const firstLeave = first.waitForResponse(response => response.url().endsWith(`/api/rooms/${code}/leave`) && response.request().method() === 'POST')
    await first.getByRole('button', { name: 'Выйти из комнаты', exact: true }).click()
    assert.equal((await firstLeave).status(), 200)
    const secondLeave = second.waitForResponse(response => response.url().endsWith(`/api/rooms/${code}/leave`) && response.request().method() === 'POST')
    await second.getByRole('button', { name: 'В главное меню', exact: true }).click()
    assert.equal((await secondLeave).status(), 200)
    assert.equal((await api(first, '/api/me/current', undefined, 'GET')).data.room, null)
    assert.equal((await api(second, '/api/me/current', undefined, 'GET')).data.room, null)
    for (const player of [first, second]) await player.getByRole('button', { name: 'Играть', exact: true }).click()
    await first.getByRole('button', { name: 'Случайный противник', exact: true }).click()
    await first.getByRole('heading', { name: 'Поиск соперника', exact: true }).waitFor()
    await second.getByRole('button', { name: 'Случайный противник', exact: true }).click()
    for (const player of [first, second]) await player.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    const queuedFirst = (await api(first, '/api/me/current', undefined, 'GET')).data.match
    const queuedSecond = (await api(second, '/api/me/current', undefined, 'GET')).data.match
    assert.ok(queuedFirst.id !== currentMatch.id, 'Matchmaking must create a new match')
    assert.equal(queuedFirst.id, queuedSecond.id)
    await api(first, `/api/matches/${queuedFirst.id}/commands`, { commandId: `queue-finish-${Date.now()}`, expectedRevision: queuedFirst.revision, type: 'surrender', payload: {} })
    assert.deepEqual(errors, [], `Unexpected JavaScript errors in profile/matchmaking: ${errors.join('; ')}`)
    console.log(JSON.stringify({ engine: engineName, room: code, tests: 'two-player actual shot, spectator permission, reconnect, saved remapping/quality, synchronized final state, profile history, matchmaking, textures, desktop/mobile canvas', trajectoryFrames: result.result.trajectory.frames.length, duration: result.result.duration, textures: textures.size, jsErrors: errors.length, geometrySamples: performanceSamples.length, networkDelayMs: networkDelay }))
  } catch (error) {
    for (let i = 0; i < contexts.length; i++) {
      const page = contexts[i].pages()[0]
      if (page) await page.screenshot({ path: path.join(artifactDir, `${engineName}-failure-${i}.png`), fullPage: true }).catch(() => {})
    }
    console.error(`${engineName}: ${error.stack || error}`)
    if (errors.length) console.error(JSON.stringify({ jsErrors: errors }))
    if (failures.length) console.error(JSON.stringify({ failedRequests: failures }))
    process.exitCode = 1
  } finally {
    await Promise.all(contexts.map(context => context.close()))
    await browser.close()
  }
}
