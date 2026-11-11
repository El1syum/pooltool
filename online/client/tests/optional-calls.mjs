// Opt-in real-engine integration: only this test's two guest users and room are
// changed. No fixture physics, intercepted commands, or shared model writes.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/optional-calls')
await mkdir(artifacts, { recursive: true })
const readyResponse = await fetch(`${base}/ready`)
assert.equal(readyResponse.status, 200)
assert.equal((await readyResponse.json()).physics, 'pooltool', 'This scenario requires the real Pooltool engine')

async function api(actor, endpoint, body, method = 'POST', allowed = [200]) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(90_000),
  })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${method} ${endpoint}: ${response.status} ${JSON.stringify(data.detail ?? '')}`)
  return data
}

async function until(callback, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await callback()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function settled(actor, minimumRevision) {
  return until(async () => {
    const match = (await api(actor, '/api/me/current', undefined, 'GET')).match
    return match?.revision >= minimumRevision && match.status !== 'calculating'
      && Date.parse(match.playbackUntil || 0) <= Date.now() ? match : null
  }, 'The authoritative shot playback did not finish', 65_000)
}

async function command(actor, match, type, payload) {
  return api(actor, `/api/matches/${match.id}/commands`, {
    commandId: `optional-${crypto.randomUUID()}`, expectedRevision: match.revision, type, payload,
  })
}

async function setRange(page, label, value) {
  const range = page.getByLabel(label, { exact: true })
  await range.evaluate((element, next) => {
    element.value = String(next)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  assert.equal(Number(await range.inputValue()), value)
}

for (const engineName of engines) {
  assert.ok(playwright[engineName], `Unknown browser: ${engineName}`)
  const browser = await playwright[engineName].launch({ headless: true,
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.DIRECT_NETWORK === '1' ? ['--no-proxy-server'] : [])] } : {}),
  })
  const actors = [], contexts = [], pages = []
  const frames = new Map(), outgoing = new Map()
  const errors = [], failedAssets = []
  let room
  try {
    for (const displayName of ['No Call Host', 'No Call Guest']) {
      actors.push(await api(null, '/api/auth/guest', { displayName, clientVersion: 'optional-calls-qa' }))
    }
    room = (await api(actors[0], '/api/rooms', { settings: { turnSeconds: 180, ranked: false } })).room
    await api(actors[1], `/api/rooms/${room.code}/join`)
    await api(actors[0], `/api/rooms/${room.code}/ready`, { ready: true })
    let match = (await api(actors[1], `/api/rooms/${room.code}/ready`, { ready: true })).match
    assert.equal(match.snapshot.shotNumber, 0)

    // Reach a genuine post-break position. A very soft shot away from the rack
    // is intentionally a miss/foul; the next player's real cue placement is
    // still required and performed through the normal API.
    const breaker = actors.find(actor => actor.user.id === match.players[match.currentPlayer].id)
    const opening = await command(breaker, match, 'shot', { V0: .2, phi: 270, theta: 0, a: 0, b: 0 })
    assert.ok(opening.result?.trajectory?.frames.length > 1)
    match = await settled(breaker, opening.match.revision)
    assert.equal(match.snapshot.shotNumber, 1)
    assert.equal(match.snapshot.callShotRequired, false, 'Calls remain optional after the opening shot')
    assert.equal(match.snapshot.needsPlacement, true, 'The miss must exercise normal foul/placement rules')
    const currentIndex = actors.findIndex(actor => actor.user.id === match.players[match.currentPlayer].id)
    const currentActor = actors[currentIndex]
    const placed = await command(currentActor, match, 'placeCueBall', { x: .4, y: .4 })
    match = placed.match
    assert.equal(match.snapshot.needsPlacement, false)
    assert.equal(match.snapshot.callShotRequired, false)

    for (const [index, actor] of actors.entries()) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      contexts.push(context)
      await context.addInitScript(({ token, name }) => {
        localStorage.setItem('pooltool.token', token)
        localStorage.setItem('pooltool.name', name)
      }, { token: actor.token, name: actor.user.displayName })
      const page = await context.newPage()
      pages.push(page)
      frames.set(page, [])
      outgoing.set(page, [])
      page.on('websocket', socket => {
        socket.on('framereceived', frame => { try { frames.get(page).push(JSON.parse(frame.payload)) } catch {} })
        socket.on('framesent', frame => { try {
          const parsed = JSON.parse(frame.payload)
          if (parsed.type === 'command') outgoing.get(page).push(parsed.command)
        } catch {} })
      })
      page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/matches\/[^/]+\/commands$/.test(new URL(request.url()).pathname)) {
          outgoing.get(page).push(request.postDataJSON())
        }
      })
      page.on('pageerror', error => errors.push(`client ${index}: ${error.message}`))
      page.on('response', response => {
        const pathname = new URL(response.url()).pathname
        if (/\.(css|js|svg|woff2?|ttf|png|webp)$/.test(pathname) && !response.ok()) failedAssets.push(`${response.status()} ${pathname}`)
      })
      await page.goto(base)
      await page.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
      await page.getByTestId('match-hud').waitFor()
      await page.evaluate(() => document.fonts.ready)
    }

    const current = pages[currentIndex]
    const other = pages[1 - currentIndex]
    await current.bringToFront()
    await current.getByRole('button', { name: 'Параметры удара', exact: true }).click()
    const controls = current.locator('#hud-controls')
    await controls.waitFor()
    assert.doesNotMatch(await controls.innerText(), /·\s*обязательно/)
    assert.deepEqual(await controls.locator('.hud-call-title').allTextContents(), ['Заказ шара · необязательно', 'Заказ лузы · необязательно'])
    assert.equal(await controls.locator('.hud-call-balls .selected, .hud-call-pockets .selected').count(), 0, 'No ball or pocket has been selected')
    await setRange(current, 'Сила удара', .2)
    await setRange(current, 'Направление удара', 270)
    await setRange(current, 'Наклон кия', 0)
    await setRange(current, 'Вращение X', 0)
    await setRange(current, 'Вращение Y', 0)
    const beforeFrames = frames.get(current).length
    const beforeOther = frames.get(other).length
    const beforeCommands = outgoing.get(current).length
    const shoot = current.getByRole('button', { name: 'Удар', exact: true })
    assert.equal(await shoot.isEnabled(), true)
    await current.screenshot({ path: path.join(artifacts, `${engineName}-no-calls-before-shot.png`), fullPage: true })
    await shoot.click()

    const result = await until(() => frames.get(current).slice(beforeFrames)
      .find(frame => frame.result?.trajectory?.frames?.length > 1), 'The real no-call GUI shot did not produce a trajectory', 65_000)
    const submitted = outgoing.get(current).slice(beforeCommands).find(item => item.type === 'shot')
    assert.ok(submitted, 'The real App must send the shot command')
    assert.equal('ballCall' in submitted.payload, false)
    assert.equal('pocketCall' in submitted.payload, false)
    assert.equal(result.result.strike.V0, .2)
    assert.equal(result.result.strike.phi, 270)
    assert.equal(result.result.finalState.callShotRequired, false)
    assert.equal(result.result.finalState.shotNumber, 2)
    assert.equal(await current.locator('.error-banner').count(), 0, 'No required-call notification may appear')
    await until(() => frames.get(other).slice(beforeOther).find(frame => frame.result?.trajectory?.frames?.length > 1), 'The other real client did not receive the no-call shot', 65_000)
    const final = await settled(currentActor, match.revision + 1)
    const finalOther = (await api(actors[1 - currentIndex], '/api/me/current', undefined, 'GET')).match
    assert.equal(final.revision, finalOther.revision)
    assert.deepEqual(final.snapshot, finalOther.snapshot, 'Both players must receive the same authoritative final state')
    assert.equal(final.snapshot.callShotRequired, false)
    assert.deepEqual(errors, [])
    assert.deepEqual(failedAssets, [])
    await current.screenshot({ path: path.join(artifacts, `${engineName}-no-calls-after-shot.png`), fullPage: true })
    console.log(JSON.stringify({ engine: engineName, room: room.code, openingShotNumber: 1, guiShotNumber: final.snapshot.shotNumber,
      shotWithoutCalls: true, requiredCallWarning: false, sharedFinalState: true,
      trajectoryFrames: result.result.trajectory.frames.length, jsErrors: errors.length }))
  } catch (error) {
    process.exitCode = 1
    for (const [index, page] of pages.entries()) await page.screenshot({ path: path.join(artifacts, `${engineName}-failure-${index}.png`), fullPage: true }).catch(() => {})
    console.error(`${engineName}: ${error.stack || error}`)
    if (errors.length || failedAssets.length) console.error(JSON.stringify({ errors, failedAssets }))
  } finally {
    if (room) for (const actor of actors) await api(actor, `/api/rooms/${room.code}/leave`, {}, 'POST', [200, 403, 404, 409]).catch(() => {})
    await Promise.all(contexts.map(context => context.close()))
    await browser.close()
  }
}
