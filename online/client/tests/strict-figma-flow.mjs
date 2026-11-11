import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { clickHudAction, waitForConnectedHome } from './app-state.mjs'

const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)
assert.ok(local || process.env.STRICT_FIGMA_PUBLIC_SMOKE === '1', 'Use isolated loopback; opt into private-only public smoke explicitly')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const screenshots = process.env.STRICT_FIGMA_SCREENSHOTS
if (screenshots) await mkdir(screenshots, { recursive: true })
async function api(endpoint, token, body) {
  const response = await fetch(`${base}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(response.status, 200, `${endpoint}: ${response.status}`)
  return response.json()
}
const button = (page, name) => page.getByRole('button', { name, exact: true })
const heading = (page, name) => page.getByRole('heading', { name, exact: true })
const openPlay = async page => {
  await waitForConnectedHome(page)
  await page.locator('.club-main-menu .club-action-primary').click()
  await heading(page, 'Играть').waitFor()
}
const openMatchMenu = async page => clickHudAction(page, button(page, 'Меню матча'))
const hasNoExtras = page => page.evaluate(() => !window.qaUndesignedUI)
const matchHud = page => page.getByTestId('match-hud')
const breadcrumb = (page, path, label) => page.getByRole('navigation', { name: path, exact: true }).getByRole('button', { name: label, exact: true })
async function checkBreadcrumb(crumb) {
  const style = await crumb.evaluate(node => {
    const css = getComputedStyle(node)
    return { cursor: css.cursor, underline: css.textDecorationLine, height: node.getBoundingClientRect().height }
  })
  assert.equal(style.cursor, 'pointer')
  assert.equal(style.underline, 'underline')
  assert.ok(style.height >= 24, 'Breadcrumb hit target is at least 24 pixels tall')
}

assert.equal((await api('/ready')).physics, 'pooltool')
for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const contexts = [], users = [], errors = []
  const capture = async (page, name) => screenshots && page.screenshot({ path: path.join(screenshots, `${engine}-${name}.png`), animations: 'disabled' })
  const newGuest = async (label, width = 1440, height = 900) => {
    const context = await browser.newContext({ viewport: { width, height } })
    contexts.push(context)
    await context.addInitScript(() => {
      window.qaUndesignedUI = false
      const extras = '.result-panel,.shot-toast,.offline-banner,.hud-rules-dialog,.game-resume-notice,.model-game-notice,.hud-control-drawer,.clipboard-feedback'
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && (node.matches(extras) || node.querySelector(extras))) window.qaUndesignedUI = true
      }).observe(document, { childList: true, subtree: true })
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`))
    page.on('response', response => {
      if (!response.ok() && response.status() !== 304 && /\/(ui|assets|fonts)\//.test(new URL(response.url()).pathname) && !response.url().includes('/api/')) errors.push(`${label}: ${response.status()} ${response.url()}`)
    })
    await page.goto(base)
    await waitForConnectedHome(page)
    const token = await page.evaluate(() => localStorage.getItem('pooltool.token'))
    assert.ok(token)
    users.push(token)
    return { page, token, user: (await api('/api/me', token)).user }
  }
  try {
    const host = await newGuest('host')
    assert.equal(await host.page.locator('.club-main-menu .club-actions > button').count(), 4)
    await capture(host.page, 'home')
    await button(host.page, 'Настройки').click()
    await button(host.page, 'Графика').click()
    const settingsPath = 'Путь к настройкам'
    const settingsCrumb = breadcrumb(host.page, settingsPath, 'Настройки')
    const homeCrumb = breadcrumb(host.page, settingsPath, 'Главное меню')
    const currentCrumb = host.page.getByRole('navigation', { name: settingsPath, exact: true }).locator('[aria-current="page"]')
    assert.equal(await currentCrumb.evaluate(node => node.tagName), 'SPAN')
    assert.equal(await currentCrumb.innerText(), 'Графика')
    await checkBreadcrumb(settingsCrumb)
    await settingsCrumb.click()
    await heading(host.page, 'Настройки').waitFor()
    await button(host.page, 'Графика').click()
    await checkBreadcrumb(homeCrumb)
    await homeCrumb.press('Enter')
    await waitForConnectedHome(host.page)
    await openPlay(host.page)
    assert.equal(await host.page.locator('.club-actions button').count(), 6)
    await capture(host.page, 'play')
    if (local) {
      await button(host.page, 'Случайный противник').click()
      await heading(host.page, 'Ищем соперника').waitFor()
      assert.equal(await host.page.locator('.club-rating-data').count(), 0)
      assert.match(await host.page.locator('.club-split-note').innerText(), /Без изменения рейтинга/)
      await capture(host.page, 'casual')
      await button(host.page, 'Отменить поиск').click()
      await heading(host.page, 'Играть').waitFor()
      await host.page.getByRole('button', { name: /^Рейтинговая игра/ }).click()
      await heading(host.page, 'Равный вам соперник').waitFor()
      assert.equal(await host.page.locator('.club-split-note').count(), 0)
      await host.page.locator('.club-rating-data').waitFor()
      assert.match(await host.page.locator('.club-ranked-search-meta').innerText(), /Диапазон постепенно/)
      await capture(host.page, 'ranked')
      const playCrumb = breadcrumb(host.page, 'Путь по меню', 'Играть')
      await checkBreadcrumb(playCrumb)
      await playCrumb.click()
      await heading(host.page, 'Играть').waitFor()
      assert.equal((await api('/api/matchmaking', host.token)).queued, false, 'Leaving search via breadcrumb cancels the queue')
    }
    await button(host.page, 'Игра с другом').click()
    await button(host.page, 'Создать игру').click()
    await heading(host.page, 'Пригласите друга').waitFor()
    const code = (await host.page.locator('[data-room-code]').innerText()).trim()
    assert.match(code, /^[A-Z0-9]{6}$/)
    assert.deepEqual(await host.page.locator('.club-card button').allTextContents(), ['Скопировать код', 'Закрыть комнату и назад'])
    await host.page.waitForFunction(() => document.querySelector('.club-room-players')?.textContent.includes('Готов к игре'))
    await button(host.page, 'Скопировать код').click()
    await host.page.locator('.screen-reader-status').filter({ hasText: 'Код приглашения скопирован' }).waitFor({ state: 'attached' })
    await capture(host.page, 'lobby')
    await host.page.reload()
    await heading(host.page, 'Пригласите друга').waitFor()
    assert.equal((await host.page.locator('[data-room-code]').innerText()).trim(), code)

    const guest = await newGuest('guest', 1280, 800)
    await openPlay(guest.page)
    await button(guest.page, 'Игра с другом').click()
    await button(guest.page, 'Присоединиться').click()
    await guest.page.getByRole('textbox', { name: 'Код комнаты' }).fill(code.toLowerCase())
    await button(guest.page, 'Присоединиться к игре').click()
    await Promise.all([matchHud(host.page).waitFor(), matchHud(guest.page).waitFor()])
    const current = await api('/api/me/current', host.token)
    assert.equal(current.match.status, 'active')
    assert.equal(current.room.code, code)
    assert.equal((await api('/api/me/current', guest.token)).match.id, current.match.id)
    assert.equal(await host.page.locator('.game-stage canvas').count(), 1)
    await capture(host.page, 'match')

    const spectator = await newGuest('spectator', 1280, 800)
    await openPlay(spectator.page)
    await button(spectator.page, 'Просмотр матча').click()
    await spectator.page.getByRole('textbox', { name: 'Код комнаты' }).fill(code)
    await button(spectator.page, 'Смотреть матч').click()
    await matchHud(spectator.page).waitFor()
    assert.ok((await api('/api/me/current', spectator.token)).room.spectators.includes(spectator.user.id))

    if (local) {
      // One real break, using only the canvas and the normal input workflow.
      const shooter = [host, guest].find(actor => actor.user.id === current.match.players[current.match.currentPlayer].id)
      assert.ok(shooter)
      const page = shooter.page, canvas = page.locator('.game-stage canvas')
      await page.bringToFront()
      await canvas.waitFor()
      const click = () => page.mouse.click(32, 270)
      if (await canvas.getAttribute('data-input-suspended') === 'true') await click()
      await page.locator('canvas[data-input-suspended="false"]').waitFor()
      await click()
      await page.locator('[data-shot-phase="aim"]').waitFor()
      await capture(page, 'contact')
      await click()
      await page.locator('[data-shot-phase="power"]').waitFor()
      await page.locator('.hud-percent-wedge').waitFor()
      await page.locator('.hud-speed-wedge').waitFor()
      await capture(page, 'power')
      await page.mouse.move(400, 300)
      await page.mouse.down()
      await page.mouse.move(400, 530, { steps: 8 })
      await page.mouse.up()
      let shot
      for (const limit = Date.now() + 25_000; Date.now() < limit;) {
        const state = await api('/api/me/current', shooter.token)
        if (state.match?.lastShot?.result?.trajectory) { shot = state.match.lastShot.result; break }
        await page.waitForTimeout(200)
      }
      assert.ok(shot?.trajectory && shot.duration > 0, 'An actual canvas shot must produce server physics and playback')
    }

    await openMatchMenu(host.page)
    await heading(host.page, 'Меню матча').waitFor()
    const headerGap = await host.page.locator('.hud-wordmark > span').evaluate(brand => {
      const range = document.createRange()
      range.selectNodeContents(brand)
      return document.querySelector('.hud-player').getBoundingClientRect().left - range.getBoundingClientRect().right
    })
    assert.ok(headerGap >= 12, `Six-character table code must leave room before the scorecard: ${headerGap}px`)
    assert.deepEqual(await host.page.locator('.match-menu-actions button > span').allTextContents(), ['Продолжить игру', 'Настройки', 'Сдаться'])
    await capture(host.page, 'match-menu')
    const matchPath = 'Навигация матча'
    await button(host.page, 'Настройки').click()
    await button(host.page, 'Звук').click()
    const matchSettingsCrumb = breadcrumb(host.page, matchPath, 'Настройки')
    await checkBreadcrumb(matchSettingsCrumb)
    await matchSettingsCrumb.click()
    const matchMenuCrumb = breadcrumb(host.page, matchPath, 'Меню')
    await checkBreadcrumb(matchMenuCrumb)
    await matchMenuCrumb.click()
    await heading(host.page, 'Меню матча').waitFor()
    const matchResumeCrumb = breadcrumb(host.page, matchPath, 'Матч')
    await checkBreadcrumb(matchResumeCrumb)
    await matchResumeCrumb.press('Enter')
    await host.page.getByRole('dialog').waitFor({ state: 'hidden' })
    await openMatchMenu(host.page)
    await button(host.page, 'Сдаться').click()
    await heading(host.page, 'Сдаться?').waitFor()
    await capture(host.page, 'surrender')
    await button(host.page, 'Продолжить игру').click()
    assert.equal((await api('/api/me/current', host.token)).match.status, 'active')
    await openMatchMenu(host.page)
    await button(host.page, 'Сдаться').click()
    await button(host.page, 'Сдаться').click()
    for (const actor of [host, guest, spectator]) {
      await waitForConnectedHome(actor.page)
      assert.equal((await api('/api/me/current', actor.token)).room, null)
      assert.ok(await hasNoExtras(actor.page))
    }
    for (const actor of [host, guest]) {
      const ended = (await api('/api/me/history', actor.token)).matches.find(item => item.id === current.match.id)
      assert.equal(ended.reason, 'surrender')
      assert.equal(ended.winnerId, guest.user.id)
    }

    await openPlay(host.page)
    await button(host.page, 'Играть с ботом').click()
    await matchHud(host.page).waitFor()
    const solo = await api('/api/me/current', host.token)
    assert.equal(solo.room.settings.solo, true)
    assert.ok(solo.match.players.some(player => player.bot))
    await openMatchMenu(host.page)
    await button(host.page, 'Сдаться').click()
    await button(host.page, 'Сдаться').click()
    await waitForConnectedHome(host.page)
    assert.ok(await hasNoExtras(host.page))
    await host.page.locator('.club-main-menu').getByRole('button', { name: 'Профиль', exact: true }).click()
    await heading(host.page, 'Ваш профиль').waitFor()
    await heading(host.page, 'История матчей').waitFor()
    const rows = host.page.locator('.club-history li')
    assert.equal(await rows.count(), 2)
    assert.match(await rows.first().innerText(), /против Бот/)
    assert.deepEqual(await rows.locator('strong').allTextContents(), ['Поражение', 'Поражение'])
    assert.deepEqual(await rows.locator('.club-history-elo').allTextContents(), ['—', '—'])
    await capture(host.page, 'profile')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine, local, breadcrumbTargets: true, guestRoomsAutoStart: true, spectator: true, canvasShot: local, surrenderReturnsEveryoneHome: true, historyRetained: true, botDirect: true, extrasMounted: false }))
  } finally {
    for (const context of contexts) await context.close()
    for (const token of users) {
      const current = await api('/api/me/current', token).catch(() => null)
      if (current?.room) await api(`/api/rooms/${current.room.code}/leave`, token, {}).catch(() => {})
    }
    await browser.close()
  }
}
