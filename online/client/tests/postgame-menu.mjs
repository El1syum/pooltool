// Real App + real Pooltool API lifecycle regression. Only this test's guest
// identities/rooms are changed. Physics, match completion, and successful exits
// are real; only explicitly failed leave responses are intercepted.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clickHudAction } from './app-state.mjs'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback test server')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/postgame-menu')
// Optional second lane against a separate service with the same MAX_MATCH_SECONDS.
// A real non-surrender bot finish must return home and allow a fresh start.
const soloLimit = Number(process.env.POSTGAME_SOLO_LIMIT_SECONDS || 0)
assert.ok(Number.isInteger(soloLimit) && soloLimit >= 0 && soloLimit <= 60)
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
const checkedButtonGroups = new WeakMap()
async function equalAppActions(page, name, selector, expectedCount) {
  const checked = checkedButtonGroups.get(page) || new Set()
  checkedButtonGroups.set(page, checked)
  const key = `${name}-${expectedCount}`
  if (checked.has(key)) return
  const original = page.viewportSize(), measurements = []
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const metrics = await page.locator(selector).evaluate(group => {
      const rect = group.getBoundingClientRect(), panel = group.closest('.match-menu-overlay'), bounds = panel.getBoundingClientRect()
      return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
        panel: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
        group: { width: rect.width }, buttons: [...group.querySelectorAll('button')].map(button => {
          const r = button.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(button)
          return { text: button.textContent.trim(), width: r.width, height: r.height, left: r.left, right: r.right,
            contentFits: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1,
            textFits: [...range.getClientRects()].every(text => text.left >= r.left - 1 && text.right <= r.right + 1 && text.top >= r.top - 1 && text.bottom <= r.bottom + 1) }
        }) }
    })
    assert.equal(metrics.buttons.length, expectedCount, `${name}: actual App actions required`)
    assert.ok(metrics.pageWidth <= viewport.width + 1, `${name}: horizontal page overflow ${JSON.stringify(metrics)}`)
    assert.ok(metrics.panel.left >= -1 && metrics.panel.right <= viewport.width + 1 && metrics.panel.top >= -1 && metrics.panel.bottom <= viewport.height + 1, `${name}: dialog clipped by viewport ${JSON.stringify(metrics)}`)
    const first = metrics.buttons[0]
    for (const button of metrics.buttons) {
      assert.ok(button.height >= 48 && Math.abs(button.height - first.height) <= 1, `${name}: unequal action heights ${JSON.stringify(metrics)}`)
      assert.ok(Math.abs(button.width - first.width) <= 1 && Math.abs(button.width - metrics.group.width) <= 1, `${name}: unequal action widths ${JSON.stringify(metrics)}`)
      assert.ok(button.contentFits && button.textFits, `${name}: clipped action text ${JSON.stringify(metrics)}`)
    }
    const last = page.locator(selector).getByRole('button').last()
    await last.scrollIntoViewIfNeeded()
    const reachable = await last.boundingBox()
    assert.ok(reachable && reachable.y >= -1 && reachable.y + reachable.height <= viewport.height + 1, `${name}: final action cannot be reached`)
    measurements.push(metrics)
  }
  await page.setViewportSize(original)
  await writeFile(path.join(artifacts, `${page.context().browser().browserType().name()}-${key}-button-layout.json`), JSON.stringify(measurements, null, 2))
  checked.add(key)
}
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
  await page.getByRole('button', { name: 'Играть с ботом', exact: true }).click()
  const state = await activeMatch(page, actor)
  assert.equal(state.room.settings.solo, true)
  return state
}
async function modalFocus(page, selector, { initial = false } = {}) {
  const dialog = page.locator(selector)
  await dialog.waitFor()
  if (initial) assert.equal(await dialog.evaluate(element => document.activeElement === element), true, 'New match modal receives initial focus')
  const controls = dialog.locator('button:enabled')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await controls.last().evaluate(element => document.activeElement === element), true, 'Reverse Tab is contained in the real match modal')
  await page.keyboard.press('Tab')
  assert.equal(await controls.first().evaluate(element => document.activeElement === element), true, 'Forward Tab wraps in the real match modal')
  for (let index = 0; index < await controls.count() + 2; index++) {
    await page.keyboard.press('Tab')
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'Tab cannot escape to the HUD/canvas')
  }
  assert.equal(await page.locator('[data-testid="match-hud"]').evaluate(element => Boolean(element.closest('[inert]'))), true, 'Background HUD is inert while a match dialog is open')
}
async function confirmSurrender(page, actor, matchId) {
  const menu = page.getByRole('button', { name: 'Меню матча', exact: true })
  await clickHudAction(page, menu)
  await modalFocus(page, '.match-menu-overlay', { initial: true })
  await equalAppActions(page, 'match-menu', '.match-menu-actions', 3)
  await page.getByRole('button', { name: 'Продолжить игру', exact: true }).click()
  await clickHudAction(page, menu)
  await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
  await modalFocus(page, '.match-menu-overlay')
  await page.keyboard.press('Escape')
  await page.getByRole('heading', { name: 'Меню матча', exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Сдаться?', exact: true }).count(), 0, 'Escape cancels only surrender confirmation, not the entire match menu')
  const afterCancel = await current(actor)
  assert.equal(afterCancel.match?.id, matchId)
  assert.equal(afterCancel.match.status, 'active', 'Cancel must neither finish nor leave the real match')
  await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
  await equalAppActions(page, 'surrender', '.match-menu-actions', 2)
  const before = await documentState(page)
  await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
  return before
}
async function assertLeftRoom(page, actor) {
  await mainMenu(page)
  const state = await current(actor)
  assert.equal(state.room, null)
  assert.equal(state.match, null)
  const cached = await page.evaluate(() => ['pooltool.token', 'pooltool.room', 'pooltool.match', 'pooltool.pendingCommand'].map(key => localStorage.getItem(key)))
  assert.deepEqual(cached, [actor.token, null, null, null], 'Leave must retain identity and clear room, match and pending-command bookmarks')
}
const documentState = page => page.evaluate(() => ({ panels: window.qaResultPanels, document: performance.timeOrigin }))
async function assertFinishedHome(page, actor, matchId, before, reason) {
  await assertLeftRoom(page, actor)
  assert.equal(await page.locator('.result-panel').count(), 0)
  assert.deepEqual(await documentState(page), before, 'A completed match must not mount a result panel or reload the page')
  const finished = (await api(actor, '/api/me/history', undefined, 'GET')).matches.find(item => item.id === matchId)
  assert.equal(finished?.status, 'finished', 'The result must still be in real match history after leaving')
  assert.equal(finished.reason, reason)
  return finished
}
async function assertSurrenderHome(page, actor, matchId, before) {
  const finished = await assertFinishedHome(page, actor, matchId, before, 'surrender')
  assert.ok(finished.winnerId && finished.winnerId !== actor.user.id)
  return finished
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
  const onPage = page => {
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/api/')) failedAssets.push(`${response.status()} ${response.url()}`)
    })
  }
  onPage(page)
  const watchPanels = () => {
    window.qaResultPanels = 0
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && (node.matches('.result-panel') || node.querySelector('.result-panel'))) window.qaResultPanels++
      }
    }).observe(document, { subtree: true, childList: true })
  }
  await page.addInitScript(watchPanels)
  await page.addInitScript(() => {
    window.dialogFocusTrace = []
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, event => {
      if (!/^(Control|Escape|Tab)/.test(event.code)) return
      window.dialogFocusTrace.push({ type, code: event.code, repeat: event.repeat, focused: document.hasFocus(), visibility: document.visibilityState,
        active: document.activeElement?.tagName, activeClass: document.activeElement?.className,
        activeInert: Boolean(document.activeElement?.closest('[inert]')), hudInert: Boolean(document.querySelector('[data-testid="match-hud"]')?.closest('[inert]')),
        modal: document.querySelector('[aria-modal="true"]')?.getAttribute('aria-labelledby') || null })
      if (window.dialogFocusTrace.length > 120) window.dialogFocusTrace.shift()
    }, true)
  })
  try {
    await page.goto(base)
    await mainMenu(page)
    const token = await page.evaluate(() => localStorage.getItem('pooltool.token'))
    assert.ok(token)
    const actor = { token, ...(await api({ token }, '/api/me', undefined, 'GET')) }
    actors.push(actor)

    if (soloLimit) {
      async function playUntilExpiry() {
        const before = await documentState(page)
        const { match } = await startSolo(page, actor)
        await page.locator('[data-club-view="menu"]').waitFor({ timeout: (soloLimit + 15) * 1000 })
        await assertFinishedHome(page, actor, match.id, before, 'maximumDuration')
        return match.id
      }
      const first = await playUntilExpiry()
      assert.notEqual(await playUntilExpiry(), first)
      assert.deepEqual(errors, [])
      assert.deepEqual(failedAssets, [])
      console.log(JSON.stringify({ browser: engineName, freshSoloAfterExpiry: true, realDurationExpiry: true, uncaughtErrors: errors.length }))
      continue
    }

    const solo1 = await startSolo(page, actor)
    await assertSurrenderHome(page, actor, solo1.match.id, await confirmSurrender(page, actor, solo1.match.id))
    completed.push(solo1.match.id)

    // Every main-menu action remains usable without refreshing the document.
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
    await page.locator('.club-settings-shell').waitFor()
    await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click()
    await mainMenu(page)
    await page.getByRole('button', { name: 'Профиль', exact: true }).click()
    await page.getByRole('heading', { name: 'Ваш профиль', exact: true }).waitFor()
    assert.equal(await page.locator('.club-history').count(), 0, 'Profile does not add a history panel absent in Figma')
    await page.getByRole('button', { name: 'Назад', exact: true }).click()
    await mainMenu(page)
    await page.getByRole('button', { name: 'Выход', exact: true }).click()
    await page.getByRole('heading', { name: 'Покинуть клуб?', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Отмена', exact: true }).click()
    await mainMenu(page)

    await createLobby(page, actor)
    await page.getByRole('button', { name: 'Закрыть комнату и назад', exact: true }).click()
    await page.locator('[data-club-view="friend"]').waitFor()
    assert.equal((await current(actor)).room, null)
    await page.getByRole('button', { name: 'Назад', exact: true }).click()
    await page.locator('[data-club-view="choices"]').waitFor()
    await page.getByRole('button', { name: 'Случайный противник', exact: true }).click()
    await page.locator('[data-club-view="search"]').waitFor()
    await page.getByRole('button', { name: 'Отменить поиск', exact: true }).click()
    await page.locator('[data-club-view="choices"]').waitFor()
    await page.getByRole('button', { name: 'Назад', exact: true }).click()
    await mainMenu(page)

    // Two real browsers in a rated match: both return home automatically.
    const opponent = await api(null, '/api/auth/guest', { displayName: `Postgame ${engineName} opponent`, clientVersion: 'postgame-menu-qa' })
    actors.push(opponent)
    const originalElo = (await api(actor, '/api/me', undefined, 'GET')).user.elo
    const opponentElo = opponent.user.elo
    assert.equal((await api(actor, '/api/matchmaking', { mode: 'ranked' })).queued, true)
    const paired = await api(opponent, '/api/matchmaking', { mode: 'ranked' })
    assert.ok(paired.matchId)
    const ranked = await activeMatch(page, actor)
    assert.equal(ranked.match.ranked, true)
    const winnerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      await winnerContext.addInitScript(token => localStorage.setItem('pooltool.token', token), opponent.token)
      const winner = await winnerContext.newPage()
      onPage(winner)
      await winner.addInitScript(watchPanels)
      await winner.goto(base)
      assert.equal((await activeMatch(winner, opponent)).match.id, ranked.match.id)
      const winnerBefore = await documentState(winner)
      const finished = await assertSurrenderHome(page, actor, ranked.match.id, await confirmSurrender(page, actor, ranked.match.id))
      completed.push(ranked.match.id)
      assert.equal(finished.winnerId, opponent.user.id)
      assert.ok(finished.eloDelta < 0)
      assert.equal((await api(actor, '/api/me', undefined, 'GET')).user.elo, originalElo + finished.eloDelta)
      assert.equal((await api(opponent, '/api/me', undefined, 'GET')).user.elo, opponentElo - finished.eloDelta)
      const winnerRecord = await assertFinishedHome(winner, opponent, ranked.match.id, winnerBefore, 'surrender')
      assert.equal(winnerRecord.winnerId, opponent.user.id)
      assert.equal(winnerRecord.eloDelta, -finished.eloDelta)
    } finally { await winnerContext.close() }

    // An ordinary non-surrender finish also attempts automatic exit, and the
    // existing Match Menu provides manual retry if it fails.
    const humanRoom = await createLobby(page, actor)
    await api(opponent, `/api/rooms/${humanRoom.code}/join`)
    await until(async () => (await current(actor)).room.players.find(player => player.id === actor.user.id)?.ready, 'Host readiness was not saved')
    await api(opponent, `/api/rooms/${humanRoom.code}/ready`, { ready: true })
    const human = await activeMatch(page, actor)
    assert.ok(!human.room.settings.solo)
    // Hold exactly one failed automatic leave response to check busy state
    // and recovery (footer error visible, Match Menu retry enabled).
    let releaseLeave, intercepted = false
    const leaveHeld = new Promise(resolve => { releaseLeave = resolve })
    const leaveUrl = `${base}/api/rooms/${humanRoom.code}/leave`
    await page.route(leaveUrl, async route => {
      intercepted = true
      await leaveHeld
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Тестовая ошибка выхода' }) })
    }, { times: 1 })
    const beforeHumanExit = await documentState(page)
    await api(opponent, `/api/rooms/${humanRoom.code}/leave`)
    await until(() => intercepted, 'The automatic leave request was not reached')
    await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
    const menu = page.locator('.match-menu-overlay')
    const exit = menu.getByRole('button', { name: 'Выйти', exact: true })
    await exit.waitFor()
    assert.equal(await exit.isDisabled(), true, 'The active leave operation must own busy state')
    releaseLeave()
    await menu.getByRole('status').filter({ hasText: 'Тестовая ошибка выхода' }).waitFor()
    await until(() => exit.isEnabled(), 'A failed leave must release its own busy state')
    const afterFailedExit = await current(actor)
    assert.equal(afterFailedExit.match.id, human.match.id, 'Failed leave must preserve the real current match')
    assert.equal(afterFailedExit.match.reason, 'left')
    await exit.click()
    const humanRecord = await assertFinishedHome(page, actor, human.match.id, beforeHumanExit, 'left')
    assert.equal(humanRecord.winnerId, actor.user.id)
    completed.push(human.match.id)

    const solo3 = await startSolo(page, actor)
    await page.route(`${base}/api/rooms/${solo3.room.code}/leave`, route => route.fulfill({
      status: 503, json: { detail: 'Тестовая ошибка автоматического выхода' },
    }), { times: 1 })
    const beforeRetry = await confirmSurrender(page, actor, solo3.match.id)
    await page.getByRole('status').filter({ hasText: 'Тестовая ошибка автоматического выхода' }).waitFor()
    assert.equal((await current(actor)).match.reason, 'surrender', 'The surrender is recorded even if room leave fails')
    assert.equal(await page.locator('.result-panel').count(), 0)
    await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
    await page.getByRole('dialog').getByRole('button', { name: 'Выйти', exact: true }).click()
    await assertSurrenderHome(page, actor, solo3.match.id, beforeRetry)
    completed.push(solo3.match.id)

    // Process a real leave, then lose only its response. A fresh authoritative
    // membership read should recover without another command or room leave.
    const solo4 = await startSolo(page, actor)
    const lostUrl = `${base}/api/rooms/${solo4.room.code}/leave`
    let leaveRequests = 0, committedLeaveStatus
    const countLeave = request => { if (request.url() === lostUrl && request.method() === 'POST') leaveRequests++ }
    page.on('request', countLeave)
    await page.route(lostUrl, async route => {
      const realLeave = await route.fetch()
      committedLeaveStatus = realLeave.status()
      await route.abort('failed')
    }, { times: 1 })
    try {
      await assertSurrenderHome(page, actor, solo4.match.id, await confirmSurrender(page, actor, solo4.match.id))
      assert.equal(committedLeaveStatus, 200)
      assert.equal(leaveRequests, 1, 'A committed leave must not be repeated after a lost response')
    } finally { page.off('request', countLeave) }
    completed.push(solo4.match.id)
    assert.equal(new Set(completed).size, 5)
    assert.deepEqual(errors, [], 'No uncaught App errors')
    assert.deepEqual(failedAssets, [], 'No failed static assets')
    await page.screenshot({ path: path.join(artifacts, `${engineName}-menu-after-five-matches.png`), fullPage: true })
    console.log(JSON.stringify({ browser: engineName, completedMatches: completed.length, bothPlayersReturnWithoutResult: true, canceledConfirmation: true, savedHistoryAndElo: true, mainMenuActions: 4, createAndLeave: true, searchAndCancel: true, failedLeaveRecovered: true, failedAutoLeaveRecovered: true, lostLeaveResponseRecovered: true, uncaughtErrors: errors.length }))
  } catch (error) {
    await page.screenshot({ path: path.join(artifacts, `${engineName}-failure.png`), fullPage: true }).catch(() => {})
    const diagnostics = await page.evaluate(() => ({ trace: window.dialogFocusTrace, focused: document.hasFocus(), visibility: document.visibilityState,
      active: document.activeElement?.outerHTML?.slice(0, 500), inert: [...document.querySelectorAll('[inert]')].map(element => element.className),
      modal: document.querySelector('[aria-modal="true"]')?.getAttribute('aria-labelledby') || null, locked: Boolean(document.pointerLockElement) })).catch(() => null)
    await writeFile(path.join(artifacts, `${engineName}-failure-diagnostics.json`), JSON.stringify(diagnostics, null, 2))
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
