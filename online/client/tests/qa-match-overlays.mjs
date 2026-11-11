// QA 11 November: real compiled App and real loopback Pooltool API, no mocked game.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clickHudAction, waitForConnectedHome } from './app-state.mjs'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = new URL(process.env.POOLTOOL_URL || 'http://127.0.0.1:8791')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use an isolated loopback service')
const output = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/qa-match-overlays-20261111')
await mkdir(output, { recursive: true })
const readiness = await (await fetch(new URL('/ready', base))).json()
assert.equal(readiness.physics, 'pooltool')
async function api(actor, endpoint, body, method = 'POST') {
  const response = await fetch(new URL(endpoint, base), {
    method, headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }), signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  assert.equal(response.status, 200, `${method} ${endpoint}: ${JSON.stringify(data.detail || '')}`)
  return data
}
const closeTo = (value, expected, label, tolerance = 1.5) => assert.ok(Math.abs(value - expected) <= tolerance, `${label}: ${value} vs ${expected}`)
const sizes = [[1920,1080], [1440,900], [1201,800], [1024,768], [844,390], [568,320], [390,844], [320,568]]
for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const errors = [], staticErrors = [], geometry = [], actors = []
  let roomCode, page
  try {
    for (const name of ['QA Alex Chen', 'QA Morgan Reed']) actors.push(await api(null, '/api/auth/guest', { displayName: name, clientVersion: 'qa-overlays-20261111' }))
    const [actor, opponent] = actors
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
    await context.addInitScript(token => localStorage.setItem('pooltool.token', token), actor.token)
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if (response.status() >= 400 && /\.(js|css|svg|ttf|png|webp|glb)$/.test(pathname)) staticErrors.push(`${response.status()} ${pathname}`)
    })
    const button = name => page.getByRole('button', { name, exact: true })
    const state = () => api(actor, '/api/me/current', undefined, 'GET')
    const menuNav = page.getByRole('navigation', { name: 'Путь по меню', exact: true })
    const matchNav = page.getByRole('navigation', { name: 'Навигация матча', exact: true })
    const settings = page.locator('.club-settings-in-match')
    const readyForSearch = mode => page.waitForFunction(mode => {
      const root = document.querySelector('.club-shell[data-club-view="search"]')
      return root && [...root.querySelectorAll('button')].some(node => !node.disabled && node.textContent.includes('Отменить поиск'))
        && root.textContent.includes(mode === 'ranked' ? 'Равный вам соперник' : 'Ищем соперника')
    }, mode)
    await page.goto(base.href)
    await waitForConnectedHome(page)
    await button('Играть').click()
    await button('Случайный противник').click()
    await readyForSearch('casual')
    assert.equal((await state()).queue.mode, 'casual')
    await page.getByText('Без изменения рейтинга', { exact: true }).waitFor()
    assert.equal(await page.locator('.club-ranked-search-meta').count(), 0)
    await page.screenshot({ path: path.join(output, `${engine}-casual-search.png`) })
    let failedCurrent = 0
    await page.route('**/api/me/current', async route => {
      if (!failedCurrent++) await route.fulfill({ status:503, json:{ detail:'QA: transient state read failure after queue cancellation' } })
      else await route.continue()
    })
    await menuNav.getByRole('button', { name: 'Главное меню', exact: true }).click()
    await waitForConnectedHome(page)
    await page.unroute('**/api/me/current')
    assert.ok(failedCurrent >= 1)
    assert.ok(!(await state()).queue?.queued, 'Breadcrumb must cancel the real queue before returning home')
    await button('Играть').click()
    await page.getByRole('button', { name: /^Рейтинговая игра/ }).click()
    await readyForSearch('ranked')
    assert.equal((await state()).queue.mode, 'ranked')
    assert.match(await page.locator('.club-card').innerText(), /900\s*[–-]\s*1\s*100/, 'Show the actual server-supplied initial Elo window')
    await page.getByText('Ожидаем второго игрока', { exact: true }).waitFor()
    await page.locator('.club-ranked-search-meta').filter({ hasText: 'Диапазон постепенно расширяется во время поиска.' }).waitFor()
    assert.equal(await page.getByText('Без изменения рейтинга', { exact: true }).count(), 0)
    await page.screenshot({ path: path.join(output, `${engine}-ranked-search.png`) })
    await menuNav.getByRole('button', { name: 'Играть', exact: true }).click()
    await page.locator('.club-shell[data-club-view="choices"]').waitFor()
    assert.ok(!(await state()).queue?.queued)
    await button('Игра с другом').click()
    await button('Создать игру').click()
    await page.locator('.club-shell[data-club-view="lobby"]').waitFor()
    roomCode = (await state()).room.code
    await button('Выйти из комнаты').click()
    await page.locator('.club-shell[data-club-view="friend"]').waitFor()
    assert.equal((await state()).room, null)
    roomCode = undefined

    const created = await api(actor, '/api/rooms', { settings: { turnSeconds: 180, ranked: false } })
    roomCode = created.room.code
    await api(opponent, `/api/rooms/${roomCode}/join`)
    await api(actor, `/api/rooms/${roomCode}/ready`, { ready: true })
    const opening = (await api(opponent, `/api/rooms/${roomCode}/ready`, { ready: true })).match
    await page.reload()
    const canvas = await page.locator('.game-stage canvas').elementHandle({ timeout: 30_000 })
    const hud = page.getByTestId('match-hud')
    await hud.waitFor()
    await clickHudAction(page, button('Меню матча'))

    async function inspect(label, selector, expected) {
      const content = page.locator(selector)
      await content.waitFor()
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())) })
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height })
        const bounds = await content.evaluate(element => {
          const rect = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } }
          const footer = document.querySelector('.match-overlay-footer'), layer = document.querySelector('[aria-modal="true"]')
          const scroll = layer.querySelector('.match-menu-scroll, .club-content')
          const cards = [...document.querySelectorAll('.hud-player')].map(rect)
          const clock = document.querySelector('.hud-clock')
          return { panel:rect(element), footer:rect(footer), scroll:rect(scroll), cards, clock:rect(clock),
            logo:rect(document.querySelector('.hud-identity')), menu:rect(document.querySelector('.hud-match-menu')),
            textClip:element.scrollWidth > element.clientWidth + 1,
            docWidth:document.documentElement.scrollWidth,
            actions:[...element.querySelectorAll('.match-menu-action')].map(rect),
            icons:[...element.querySelectorAll('img')].map(img => ({ src:new URL(img.src).pathname, natural:[img.naturalWidth,img.naturalHeight], rendered:[img.getBoundingClientRect().width,img.getBoundingClientRect().height] })),
          }
        })
        assert.equal(bounds.cards.length, 2)
        assert.ok(bounds.cards.every(card => card.width > 1 && card.height > 1 && card.bottom <= bounds.scroll.top + 1), JSON.stringify({ label, width, height, bounds }))
        assert.ok(bounds.clock.bottom <= bounds.scroll.top + 1 && bounds.scroll.bottom <= bounds.footer.top + 1, JSON.stringify({ label, width, height, bounds }))
        assert.ok(bounds.panel.left >= -1 && bounds.panel.right <= width + 1 && bounds.docWidth <= width + 1 && !bounds.textClip, JSON.stringify({ label, width, height, bounds }))
        assert.ok(bounds.footer.top >= 0 && bounds.footer.bottom <= height + 1)
        if (label === 'surrender' && width === 320) assert.ok(bounds.actions.every(action => action.bottom <= bounds.scroll.bottom + 1), 'Keep both decisions visible at 320×568 without scrolling')
        if (width === 1920) {
          closeTo(bounds.panel.width, expected.width, `${label} Figma width`)
          closeTo(bounds.panel.top, expected.top, `${label} Figma top`)
          closeTo(bounds.footer.top, 1022, 'Figma footer')
          closeTo(bounds.cards[0].left, 288, 'Figma left player')
          closeTo(bounds.cards[1].left, 1132, 'Figma right player')
          assert.ok(bounds.actions.every(action => Math.abs(action.height - 66) <= 1))
          await page.screenshot({ path: path.join(output, `${engine}-${label}-1920.png`) })
        }
        if (width === 320) await page.screenshot({ path: path.join(output, `${engine}-${label}-320.png`) })
        assert.ok(bounds.icons.every(icon => icon.natural.every(value => value > 0)))
        geometry.push({ label, width, height, ...bounds })
      }
      await page.setViewportSize({ width: 1920, height: 1080 })
      assert.equal(await canvas.evaluate(element => element === document.querySelector('.game-stage canvas')), true, 'Overlay must retain the live canvas')
      assert.equal(await hud.evaluate(element => Boolean(element.closest('[inert]'))), true, 'The visible HUD must remain inert')
    }
    await inspect('menu', '.match-menu-card', { width: 540, top: 320 })
    const clock = hud.locator('.hud-clock-digits')
    const before = await clock.innerText()
    await page.waitForFunction(previous => document.querySelector('.hud-clock-digits')?.textContent !== previous, before)
    assert.equal((await state()).match.deadline, opening.deadline, 'Opening the menu cannot pause or reset the authoritative deadline')
    await button('Сдаться').click()
    await inspect('surrender', '.match-surrender-card', { width: 680, top: 340 })
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: 'Меню матча', exact: true }).waitFor()
    assert.equal((await state()).match.status, 'active')
    await button('Настройки').click()
    await inspect('settings-index', '.club-settings-in-match .club-section', { width: 580, top: 285 })
    for (const [title, tab, width, top] of [['Графика','graphics',820,230], ['Звук','sound',820,230], ['Управление','controls',1180,215]]) {
      await settings.getByRole('button', { name: title, exact: true }).click()
      await inspect(tab, '.club-settings-in-match .club-section', { width, top })
      await matchNav.getByRole('button', { name: 'Настройки', exact: true }).click()
      await page.locator('.club-settings-in-match[data-settings-tab="index"]').waitFor()
    }
    await matchNav.getByRole('button', { name: 'Меню', exact: true }).click()
    await page.getByRole('heading', { name: 'Меню матча', exact: true }).waitFor()
    await matchNav.getByRole('button', { name: 'Матч', exact: true }).click()
    await page.locator('[aria-modal="true"]').waitFor({ state: 'detached' })
    assert.equal(await hud.evaluate(element => Boolean(element.closest('[inert]'))), false)
    const resumed = (await state()).match
    assert.equal(resumed.id, opening.id)
    assert.equal(resumed.deadline, opening.deadline)
    assert.equal(resumed.snapshot.shotNumber, opening.snapshot.shotNumber, 'Menu actions must not submit an accidental shot')
    assert.deepEqual(errors, [])
    assert.deepEqual(staticErrors, [])
    await writeFile(path.join(output, `${engine}-geometry.json`), JSON.stringify(geometry, null, 2))
    console.log(JSON.stringify({ engine, layouts:geometry.length, authoritativeQueueAndLobby:true, deadlineContinues:true, canvasStable:true, errors:0 }))
  } catch (error) {
    await page?.screenshot({ path:path.join(output, `${engine}-failure.png`) }).catch(() => {})
    await writeFile(path.join(output, `${engine}-failure.json`), JSON.stringify({ message:error.message, geometry, errors, staticErrors }, null, 2))
    throw error
  } finally {
    if (roomCode) for (const actor of actors) await api(actor, `/api/rooms/${roomCode}/leave`).catch(() => {})
    for (const actor of actors) await api(actor, '/api/matchmaking', undefined, 'DELETE').catch(() => {})
    await browser.close()
  }
}
