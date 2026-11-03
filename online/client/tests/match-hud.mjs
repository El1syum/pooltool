import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Opt-in integration smoke: the service must use the real Pooltool engine.
// It creates three disposable guest identities and closes their room afterwards.
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/match-hud')
const networkDelay = Math.max(0, Number(process.env.NETWORK_DELAY_MS) || 0)
await mkdir(artifacts, { recursive: true })
const defaultDocument = await fetch(new URL('/', base))
assert.equal(defaultDocument.status, 200, 'The ordinary preview URL must serve the current client')
assert.equal(defaultDocument.headers.get('cache-control'), 'no-store', 'The default HTML must not keep an old build cached')

async function api(actor, endpoint, body, method = 'POST', allowed = [200]) {
  const response = await fetch(base + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(90_000),
  })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${method} ${endpoint}: ${response.status} ${JSON.stringify(data.detail ?? '')}`)
  return { status: response.status, data }
}

async function until(callback, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await callback()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function clickNamed(page, names) {
  for (const name of names) {
    const button = page.getByRole('button', { name, exact: true }).first()
    if (await button.count() && await button.isVisible()) { await button.click(); return button }
  }
  throw new Error(`No visible action: ${names.join(', ')}`)
}

async function closeDialog(page) {
  const dialog = page.getByRole('dialog').last()
  await clickNamed(dialog, ['Закрыть правила', 'Закрыть настройки', 'Закрыть', 'Понятно', 'Вернуться в игру', 'Сохранить и закрыть'])
  await dialog.waitFor({ state: 'hidden' })
}

async function setRange(page, pattern, value) {
  const input = page.getByLabel(pattern).first()
  await input.waitFor()
  await input.evaluate((element, next) => {
    element.value = String(next)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
  assert.equal(Number(await input.inputValue()), value)
}

async function assertViewport(page, viewport) {
  await page.bringToFront()
  await page.setViewportSize(viewport)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const size = await page.evaluate(() => {
    const canvas = document.querySelector('.game-stage canvas')
    const rect = canvas?.getBoundingClientRect()
    return { width: innerWidth, height: innerHeight, bodyWidth: document.documentElement.scrollWidth,
      canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null }
  })
  assert.ok(size.canvas && size.canvas.width > 150 && size.canvas.height > 150, `Nonempty canvas required: ${JSON.stringify(size)}`)
  assert.ok(size.bodyWidth <= size.width + 1, `Horizontal overflow: ${JSON.stringify(size)}`)
  assert.ok(size.canvas.x >= -1 && size.canvas.x + size.canvas.width <= size.width + 1, 'Canvas must stay horizontally inside the viewport')
  return size
}

/** Optional, explicitly noninteractive design fixture; never used for gameplay assertions. */
async function scoreboardFixture(page, engineName) {
  const { createServer } = await import('vite')
  const { createSSRApp } = await import('vue')
  const { renderToString } = await import('@vue/server-renderer')
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  let fixturePage
  try {
    const Hud = (await server.ssrLoadModule('/src/components/MatchHud.vue')).default
    const potted = new Set([1, 3, 4, 7, 9, 12, 15])
    const props = {
      match: { id: 'visual-fixture', roomId: 'fixture-room', status: 'active', revision: 0, currentPlayer: 0,
        startedAt: new Date().toISOString(), deadline: null,
        players: [{ id: 'a', displayName: 'Alex Chen' }, { id: 'b', displayName: 'Morgan Reed' }],
        snapshot: { groups: ['solids', 'stripes'], balls: Array.from({ length: 15 }, (_, index) => ({ id: String(index + 1), position: [0, 0, 0.03], pocketed: potted.has(index + 1) })), table: { width: 1.27, length: 2.54, pockets: [] } } },
      user: { id: 'a' }, room: { code: 'ABC123' }, aim: { phi: 90, V0: 2.4, theta: 15, a: 0, b: 0 },
      phase: 'overview', canShoot: true, canPlace: false, canReposition: false, placingCue: false,
      connected: true, connection: 'Соединение установлено', remaining: 24, elapsed: 0, statusText: 'Ваш ход',
      volume: 0.5, topViewKey: 'KeyT', calledBall: '', calledPocket: '', cameraMode: 'free',
    }
    const markup = await renderToString(createSSRApp(Hud, props))
    const links = page.locator('link[rel="stylesheet"]')
    const css = await links.count() ? await links.first().getAttribute('href') : (await (await fetch(base)).text()).match(/href="([^"]+\.css)"/)?.[1]
    assert.ok(css, 'A compiled stylesheet is required for the visual fixture')
    fixturePage = await page.context().newPage()
    await fixturePage.setViewportSize({ width: 1920, height: 1080 })
    await fixturePage.goto(`${base}/ready`)
    await fixturePage.setContent(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><base href="${base}/"><link rel="stylesheet" href="${css}"></head><body class="app-shell in-match"><main style="position:relative;width:100vw;height:100vh;background:#10202b">${markup}</main></body></html>`, { waitUntil: 'networkidle' })
    await fixturePage.evaluate(() => document.fonts.ready)
    await fixturePage.waitForFunction(() => [...document.querySelectorAll('img')].every(image => image.complete && image.naturalWidth > 0))
    const cards = fixturePage.locator('[data-testid="player-scorecard"]')
    assert.match(await cards.nth(0).getAttribute('aria-label'), /забито 4 из 7, осталось 3/)
    assert.match(await cards.nth(1).getAttribute('aria-label'), /забито 3 из 7, осталось 4/)
    await fixturePage.screenshot({ path: path.join(artifacts, `${engineName}-scoreboard-visual-fixture.png`), fullPage: true })
  } finally {
    await fixturePage?.close()
    await server.close()
  }
}

for (const engineName of engines) {
  const engine = playwright[engineName]
  assert.ok(engine, `Unknown browser engine ${engineName}`)
  const browser = await engine.launch({ headless: true,
    ...(process.env[`${engineName.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`${engineName.toUpperCase()}_EXECUTABLE`] } : {}),
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.DIRECT_NETWORK === '1' ? ['--no-proxy-server'] : [])] } : {}) })
  const contexts = []
  const actors = []
  const pages = []
  const received = new Map()
  const sent = new Map()
  const errors = []
  const badAssets = []
  const textures = new Set()
  const workload = []
  let injectedFailures = 0
  let room
  try {
    if (process.env.FIXTURE_ONLY === '1') {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
      contexts.push(context)
      const page = await context.newPage()
      await page.goto(`${base}/ready`)
      await scoreboardFixture(page, engineName)
      console.log(JSON.stringify({ engine: engineName, fixtureOnly: true, tests: 'noninteractive 4/3 scorecard visual fixture; no gameplay assertions' }))
      continue
    }
    for (const displayName of ['Alex Chen', 'Morgan Reed', 'HUD Observer']) {
      actors.push((await api(null, '/api/auth/guest', { displayName, clientVersion: 'match-hud-qa' })).data)
    }
    room = (await api(actors[0], '/api/rooms', { settings: { turnSeconds: 180, ranked: false } })).data.room
    await api(actors[1], `/api/rooms/${room.code}/join`)
    await api(actors[0], `/api/rooms/${room.code}/ready`, { ready: true })
    const opening = (await api(actors[1], `/api/rooms/${room.code}/ready`, { ready: true })).data.match
    assert.equal(opening.snapshot.balls.length, 16)
    await api(actors[2], `/api/rooms/${room.code}/spectate`)

    for (const [index, viewport] of [{ width: 1920, height: 1080 }, { width: 1280, height: 800 }, { width: 390, height: 844 }].entries()) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600 })
      contexts.push(context)
      await context.addInitScript(({ token, name }) => {
        localStorage.setItem('pooltool.token', token)
        localStorage.setItem('pooltool.name', name)
      }, { token: actors[index].token, name: actors[index].user.displayName })
      if (process.env.INJECT_MATCH_FETCH_502 === '1') {
        let injected = false
        await context.route('**/api/matches/*', async route => {
          if (!injected && route.request().method() === 'GET') {
            injected = true
            injectedFailures++
            await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: 'Injected transient snapshot fetch failure' }) })
          } else await route.continue()
        })
      }
      if (networkDelay) await context.route('**/api/**', async route => {
        await new Promise(resolve => setTimeout(resolve, networkDelay))
        await route.continue()
      })
      const page = await context.newPage()
      pages.push(page)
      received.set(page, [])
      sent.set(page, [])
      page.on('websocket', socket => {
        socket.on('framereceived', frame => { try { received.get(page).push(JSON.parse(frame.payload)) } catch { /* ping/binary */ } })
        socket.on('framesent', frame => { try { sent.get(page).push(JSON.parse(frame.payload)) } catch { /* ping/binary */ } })
      })
      page.on('pageerror', error => errors.push(`client ${index}: ${error.message}`))
      page.on('response', response => {
        const pathname = new URL(response.url()).pathname
        if (/\/models\/balls\/[^/]+\.png$/.test(pathname) && response.ok()) textures.add(pathname)
        if (/\.(css|js|svg|woff2?|ttf|png|webp)$/.test(pathname) && !response.ok()) badAssets.push(`${response.status()} ${pathname}`)
      })
      page.on('request', request => {
        if (request.method() !== 'POST' || !request.url().endsWith('/api/telemetry/events')) return
        for (const event of request.postDataJSON()?.events ?? []) if (event.type === 'clientPerformance') workload.push(event.data)
      })
      await page.goto(base)
      await page.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
      await page.locator('[data-testid="match-hud"]').waitFor()
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid="match-hud"]')).position === 'absolute')
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="match-hud"] img')].every(image => image.complete && image.naturalWidth > 0))
    }

    const first = pages[0]
    const spectator = pages[2]
    let match = (await api(actors[0], '/api/me/current', undefined, 'GET')).data.match
    const currentIndex = match.players[match.currentPlayer].id === actors[0].user.id ? 0 : 1
    const current = pages[currentIndex]
    const currentActor = actors[currentIndex]
    const other = pages[currentIndex === 0 ? 1 : 0]
    const canvasMarker = `canvas-${engineName}-${Date.now()}`
    await current.locator('.game-stage canvas').evaluate((canvas, marker) => { canvas.dataset.hudQa = marker }, canvasMarker)
    async function assertStableCanvas() {
      assert.equal(await current.locator('.game-stage canvas').getAttribute('data-hud-qa'), canvasMarker, 'Opening a HUD panel must not recreate the 3D scene')
    }

    for (const [page, size] of [[first, { width: 1920, height: 1080 }], [pages[1], { width: 1280, height: 800 }], [spectator, { width: 390, height: 844 }]]) {
      await assertViewport(page, size)
      await page.screenshot({ path: path.join(artifacts, `${engineName}-${size.width}x${size.height}.png`), fullPage: true })
    }
    const cards = first.locator('[data-testid="player-scorecard"]')
    assert.equal(await cards.count(), 2)
    const cardText = await cards.allTextContents()
    assert.ok(cardText.some(value => value.includes('Alex Chen')) && cardText.some(value => value.includes('Morgan Reed')), 'Both real player names must be shown')
    assert.ok(cardText.every(value => !/Осталось\s*14/.test(value)), 'An unassigned group must not pretend the player owns all 14 object balls')
    const assetGeometry = await first.locator('[data-testid="match-hud"] img').evaluateAll(images => images.map(image => {
      const rect = image.getBoundingClientRect()
      return { name: image.src.split('/').pop(), natural: [image.naturalWidth, image.naturalHeight], rendered: [rect.width, rect.height] }
    }))
    assert.ok(assetGeometry.some(asset => asset.name === 'menu.svg' && asset.rendered[0] > 0 && asset.rendered[1] > 0), 'The original match-menu asset must occupy a visible slot')
    const fontMetrics = await first.evaluate(async () => {
      await document.fonts.load('600 19px "Pooltool Inter"')
      const samples = []
      for (const [name, weight, variation] of [['regular', '400', 'normal'], ['semibold', '600', 'normal'], ['explicitSemibold', '600', '"wght" 600']]) {
        const span = document.createElement('span')
        span.textContent = 'Alex Chen Morgan Reed 0123456789'
        Object.assign(span.style, { position: 'fixed', visibility: 'hidden', whiteSpace: 'nowrap', fontFamily: '"Pooltool Inter"', fontSize: '19px', fontWeight: weight, fontVariationSettings: variation })
        document.body.append(span)
        samples.push({ name, width: span.getBoundingClientRect().width })
        span.remove()
      }
      return samples
    })

    // Modal keyboard gating is tested deliberately with focus forced back onto canvas.
    for (const action of ['Правила', 'Настройки', 'Меню матча']) {
      if (action === 'Настройки') await clickNamed(current, ['Меню матча'])
      await clickNamed(current, [action])
      const dialog = current.getByRole('dialog').last()
      await dialog.waitFor()
      const before = sent.get(current).filter(frame => frame.type === 'command' && frame.command?.type === 'shot').length
      await current.locator('.game-stage canvas').focus()
      await current.keyboard.press('Space')
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(sent.get(current).filter(frame => frame.type === 'command' && frame.command?.type === 'shot').length, before, `${action} must block shooting behind the modal`)
      await closeDialog(current)
      await assertStableCanvas()
    }

    await clickNamed(current, ['Меню матча'])
    await clickNamed(current, ['Выключить звук', 'Звук'])
    const storedVolume = await current.evaluate(id => JSON.parse(localStorage.getItem(`pooltool.settings.${id}`) || '{}').volume, currentActor.user.id)
    assert.equal(storedVolume, 0, 'Mute must use the actual persisted game volume')
    await clickNamed(current, ['Включить звук', 'Звук'])
    await closeDialog(current)
    await assertStableCanvas()

    const denied = await api(actors[2], `/api/matches/${match.id}/commands`, {
      commandId: `hud-spectator-${Date.now()}`, expectedRevision: match.revision,
      type: 'shot', payload: { phi: 90, V0: 3, theta: 0, a: 0, b: 0 },
    }, 'POST', [403, 409])
    assert.ok([403, 409].includes(denied.status))

    // Exercise the Figma's compact aiming and charging states without sending a shot.
    await clickNamed(current, ['Параметры удара'])
    await clickNamed(current, ['Прицелиться'])
    await current.locator('[data-testid="match-hud"][data-shot-phase="aim"]').waitFor()
    await current.locator('.hud-reticle-ring').waitFor()
    const heading = await current.getByTestId('match-hud').getAttribute('data-aim-direction')
    const contact = current.locator('.hud-reticle')
    const contactBounds = await contact.boundingBox()
    assert.ok(contactBounds)
    const oldContact = await current.locator('.hud-reticle-center').getAttribute('style')
    await current.mouse.move(contactBounds.x + contactBounds.width * 0.65, contactBounds.y + contactBounds.height * 0.35)
    assert.notEqual(await current.locator('.hud-reticle-center').getAttribute('style'), oldContact, 'Contact hover changes the cue tip position')
    assert.equal(await current.getByTestId('match-hud').getAttribute('data-aim-direction'), heading, 'Choosing contact must not rotate the shot')
    await current.locator('.game-stage canvas').focus()
    await current.keyboard.press('ArrowRight')
    assert.equal(await current.getByTestId('match-hud').getAttribute('data-aim-direction'), heading, 'Contact phase locks direction keys too')
    await new Promise(resolve => setTimeout(resolve, 750)) // allow the cue-camera easing to settle before visual QA
    await current.screenshot({ path: path.join(artifacts, `${engineName}-aim-state.png`), fullPage: true })
    const reticleGeometry = await current.locator('.hud-target img').evaluateAll(images => images.map(image => {
      const rect = image.getBoundingClientRect()
      return { name: image.src.split('/').pop(), natural: [image.naturalWidth, image.naturalHeight], rendered: [rect.width, rect.height] }
    }))
    assert.ok(reticleGeometry.every(asset => asset.natural[0] > 0 && asset.rendered[0] > 0 && asset.rendered[1] > 0))
    await current.getByRole('button', { name: 'Точка удара по битку. Нажмите для выбора силы', exact: true }).click()
    await current.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()
    assert.equal(await current.getByTestId('alt-assist').count(), 0, 'Extra instruments are hidden without Alt')
    await current.keyboard.down('Alt')
    await current.getByTestId('alt-assist').waitFor()
    await current.locator('.hud-percent-wedge').waitFor()
    await new Promise(resolve => setTimeout(resolve, 750))
    await current.screenshot({ path: path.join(artifacts, `${engineName}-power-state.png`), fullPage: true })
    await current.waitForFunction(() => [...document.querySelectorAll('.hud-power-gauge use')].every(use => use.getBBox().width > 200))
    const wedgeGeometry = await current.locator('.hud-charge svg').evaluateAll(gauges => gauges.map(gauge => {
      const rect = gauge.getBoundingClientRect()
      return { name: gauge.getAttribute('aria-label'), natural: [gauge.width.baseVal.value, gauge.height.baseVal.value], rendered: [rect.width, rect.height] }
    }))
    assert.equal(wedgeGeometry.length, 2)
    assert.ok(wedgeGeometry.every(asset => asset.natural[0] > 0 && asset.rendered[0] > 0 && asset.rendered[1] > 0))
    const phaseCanvas = current.locator('.game-stage canvas')
    const phaseBounds = await phaseCanvas.boundingBox()
    assert.ok(phaseBounds)
    for (const phase of ['aim', 'overview']) {
      await phaseCanvas.click({ button: 'right', position: { x: phaseBounds.width * 0.25, y: phaseBounds.height * 0.4 } })
      await current.locator(`[data-testid="match-hud"][data-shot-phase="${phase}"]`).waitFor()
    }
    await current.keyboard.up('Alt')
    await current.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    await current.keyboard.down('Alt')
    await current.getByTestId('alt-assist').waitFor()
    await current.evaluate(() => window.dispatchEvent(new Event('blur')))
    await current.getByTestId('alt-assist').waitFor({ state: 'hidden' })
    await current.keyboard.up('Alt')
    await assertStableCanvas()

    // Pulling the cue changes real bounded parameters; Escape cancels before release.
    await clickNamed(current, ['Параметры удара'])
    await clickNamed(current, ['Прицелиться'])
    await current.getByRole('button', { name: 'Точка удара по битку. Нажмите для выбора силы', exact: true }).click()
    await current.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()
    await current.keyboard.down('Alt')
    const beforeDrag = sent.get(current).filter(frame => frame.type === 'command' && frame.command?.type === 'shot').length
    const oldPower = await current.locator('.hud-power-number').innerText()
    const pullX = phaseBounds.x + phaseBounds.width * 0.25
    const pullY = phaseBounds.y + phaseBounds.height * 0.4
    await current.mouse.move(pullX, pullY)
    await current.mouse.down()
    await current.mouse.move(pullX + 50, pullY + 175, { steps: 8 })
    assert.notEqual(await current.locator('.hud-power-number').innerText(), oldPower, 'A pull gesture must update the power indicator')
    const speed = Number((await current.locator('.hud-speed-number').innerText()).replace(/[^\d.]/g, ''))
    const percent = Number((await current.locator('.hud-power-number').innerText()).replace(/[^\d.]/g, ''))
    assert.ok(speed >= 0.2 && speed <= 8, 'Dragging must respect the server speed bounds')
    assert.ok(Math.abs(percent - speed / 8 * 100) <= 1, 'Percent and m/s gauges must describe the same speed')
    const fills = await current.locator('.hud-power-gauge').evaluateAll(gauges => gauges.map(gauge => Number(gauge.getAttribute('data-fill'))))
    assert.equal(fills[0], fills[1], 'Both SVG fills change together with cue speed')
    await current.keyboard.press('Escape')
    await current.mouse.up()
    await current.locator('[data-testid="match-hud"][data-shot-phase="aim"]').waitFor()
    assert.equal(sent.get(current).filter(frame => frame.type === 'command' && frame.command?.type === 'shot').length, beforeDrag, 'Cancelling a pull must not submit a shot')
    await phaseCanvas.click({ button: 'right', position: { x: phaseBounds.width * 0.25, y: phaseBounds.height * 0.4 } })
    await current.locator('[data-testid="match-hud"][data-shot-phase="overview"]').waitFor()
    await current.keyboard.up('Alt')

    // This control panel is intentionally secondary: opening it cannot remove canvas.
    await clickNamed(current, ['Параметры удара', 'Управление ударом'])
    await assertStableCanvas()
    await setRange(current, /^Направление/, 90)
    await setRange(current, /^Сила/, 3)
    await setRange(current, /^Наклон/, 0)
    await setRange(current, /^Вращение X/, 0)
    await setRange(current, /^Вращение Y/, 0)
    await current.waitForFunction(() => [...document.querySelectorAll('.hud-controls .hud-ball img')].every(image => image.complete && image.naturalWidth > 0))
    const badgeGeometry = await current.locator('.hud-controls .hud-ball img').evaluateAll(images => [...new Map(images.map(image => {
      const rect = image.getBoundingClientRect()
      const name = image.src.split('/').pop()
      return [name, { name, natural: [image.naturalWidth, image.naturalHeight], rendered: [rect.width, rect.height] }]
    })).values()])
    assert.equal(badgeGeometry.length, 2)
    assert.ok(badgeGeometry.every(asset => asset.rendered[0] > 0 && asset.rendered[1] > 0))
    await current.screenshot({ path: path.join(artifacts, `${engineName}-controls-drawer.png`), fullPage: true })
    const shoot = current.getByRole('button', { name: 'Удар', exact: true })
    assert.equal(await shoot.isEnabled(), true)
    const beforeShot = received.get(current).length
    const shotStarted = Date.now()
    // Submit through the actual contact → charge → release gesture. The
    // explicit shot button stays covered by the full browser-smoke scenario.
    await clickNamed(current, ['Прицелиться'])
    await current.locator('[data-testid="match-hud"][data-shot-phase="aim"]').waitFor()
    await current.getByRole('button', { name: 'Точка удара по битку. Нажмите для выбора силы', exact: true }).click()
    await current.locator('[data-testid="match-hud"][data-shot-phase="power"]').waitFor()
    const gestureBounds = await phaseCanvas.boundingBox()
    assert.ok(gestureBounds)
    const gestureX = gestureBounds.x + gestureBounds.width * 0.25
    const gestureY = gestureBounds.y + gestureBounds.height * 0.4
    const travel = Math.max(160, gestureBounds.height * 0.3) * 3 / 8
    await current.mouse.move(gestureX, gestureY)
    await current.mouse.down()
    await current.mouse.move(gestureX, gestureY + travel, { steps: 8 })
    await current.mouse.up()
    const result = await until(() => received.get(current).slice(beforeShot).find(frame => frame.type === 'match' && frame.result?.trajectory), 'Real shot trajectory was not received', 65_000)
    assert.ok(Math.abs(result.result.strike.V0 - 3) < 0.05, 'The selected charge must reach the authoritative engine')
    assert.ok(Math.abs(result.result.strike.phi - 90) < 0.01, 'The heading fixed before contact must reach the authoritative engine unchanged')
    const clickToResultMs = Date.now() - shotStarted
    assert.ok(Number.isFinite(result.result.wallDuration) && result.result.wallDuration >= 0, 'Actual server calculation time must be reported separately from motion duration')
    assert.ok(result.result.duration > 0 && result.result.trajectory.frames.length > 1)
    assert.equal(result.result.initialState.balls.length, 16)
    await current.screenshot({ path: path.join(artifacts, `${engineName}-physical-playback.png`), fullPage: true })
    await until(async () => {
      const state = (await api(currentActor, '/api/me/current', undefined, 'GET')).data.match
      if (state.revision > match.revision && state.status !== 'calculating' && Date.parse(state.playbackUntil || 0) <= Date.now()) return state
      return null
    }, 'Authoritative playback did not complete', Math.max(30_000, (result.result.duration + 10) * 1000))
    match = (await api(actors[0], '/api/me/current', undefined, 'GET')).data.match
    const opponentState = (await api(actors[1], '/api/me/current', undefined, 'GET')).data.match
    const observedState = (await api(actors[2], '/api/me/current', undefined, 'GET')).data.match
    assert.deepEqual(match.snapshot.balls, opponentState.snapshot.balls)
    assert.deepEqual(match.snapshot.balls, observedState.snapshot.balls)
    assert.equal(await current.locator('.game-stage canvas').getAttribute('data-hud-qa'), canvasMarker)
    assert.ok(textures.size >= 16, `Original ball textures must load; got ${textures.size}`)
    assert.deepEqual(badAssets, [], 'Static HUD assets/fonts must not return HTTP errors')
    assert.deepEqual(errors, [], 'No uncaught JavaScript errors are expected')
    if (process.env.INJECT_MATCH_FETCH_502 === '1') assert.ok(injectedFailures > 0, 'The network-failure path must really be exercised')
    assert.ok(workload.some(sample => sample.drawCalls > 20 && sample.triangles > 10_000), 'Actual nonempty 3D geometry must be rendered')
    const build = await first.locator('script[type="module"][src]').first().getAttribute('src')
    if (process.env.VISUAL_FIXTURE === '1') await scoreboardFixture(first, engineName)
    console.log(JSON.stringify({ engine: engineName, room: room.code, build, jsErrors: errors.length, injectedFailures, assetGeometry, reticleGeometry, wedgeGeometry, badgeGeometry, fontMetrics, visualFixture: process.env.VISUAL_FIXTURE === '1',
      textures: textures.size, geometrySamples: workload.length, trajectoryFrames: result.result.trajectory.frames.length,
      duration: result.result.duration, serverWallSeconds: result.result.wallDuration, clickToResultMs,
      tests: 'uncached default URL, responsive HUD, stable canvas, modal gating, mute, spectator authority, real shot and shared final state' }))
  } catch (error) {
    for (let index = 0; index < pages.length; index++) await pages[index].screenshot({ path: path.join(artifacts, `${engineName}-failure-${index}.png`), fullPage: true }).catch(() => {})
    console.error(`${engineName}: ${error.stack || error}`)
    if (errors.length) console.error(JSON.stringify({ jsErrors: errors }))
    if (badAssets.length) console.error(JSON.stringify({ badAssets }))
    process.exitCode = 1
  } finally {
    if (room) for (const actor of actors) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await Promise.all(contexts.map(context => context.close()))
    await browser.close()
  }
}
