// Real application/API integration. Test triangle files are not supplied game art.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { minimalGlb } from './model-fixture.mjs'
const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
const origin = new URL(base).origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Personal-appearance integration mutates only an isolated loopback test library')
const username = process.env.ASSET_ADMIN_USERNAME, password = process.env.ASSET_ADMIN_PASSWORD
assert.ok(username && password, 'Provide separate test-library administrator credentials through environment variables')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = path.resolve('tests/artifacts/player-appearance-integration')
await mkdir(artifacts, { recursive: true })
async function json(response, expected = 200) { const body = await response.json(); assert.equal(response.status(), expected, `${new URL(response.url()).pathname}`); return body }
async function home(page) { await page.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor({ timeout: 30_000 }); await page.getByRole('status').filter({ hasText: 'Соединение установлено' }).waitFor() }
async function openAppearance(page) {
  await page.bringToFront()
  if (!await page.getByRole('dialog', { name: 'Настройки', exact: true }).count()) {
    if (await page.locator('.game-stage canvas').count()) await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
    await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  }
  await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Оформление', exact: true }).click()
  await page.getByRole('dialog', { name: 'Оформление', exact: true }).waitFor()
  await page.locator('.appearance-preview canvas').waitFor()
}
async function closeSettings(page) { await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' }) }
async function apply(page) { await page.getByRole('button', { name: 'Применить', exact: true }).click(); await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor(); await closeSettings(page) }
async function saved(page, id) { return page.evaluate(id => JSON.parse(localStorage.getItem(`pooltool.assets.${encodeURIComponent(id)}`) || 'null'), id) }
const configuration = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], replaceProcedural: false, material: {}, materials: {}, hiddenNodes: [] })

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: origin } })
  const baseline = await json(await admin.get('/api/assets/library'))
  const created = [], actors = [], contexts = [], errors = [], adminWrites = [], shotCommands = []
  let browser, csrf = '', room = null
  try {
    csrf = (await json(await admin.post('/api/assets/admin/login', { data: { username, password } }))).csrfToken
    for (const letter of ['a', 'b']) {
      const result = await json(await admin.post(`/api/assets/models?role=table&name=${encodeURIComponent(`appearance-${engineName}-${Date.now()}-${letter}.glb`)}`, { headers: { 'X-Asset-CSRF': csrf, 'Content-Type': 'model/gltf-binary' }, data: Buffer.from(minimalGlb()) }))
      created.push(result.asset)
      await json(await admin.patch(`/api/assets/models/${result.asset.id}`, { headers: { 'X-Asset-CSRF': csrf }, data: { config: configuration() } }))
    }
    const current = await json(await admin.get('/api/assets/library'))
    const sharedProfile = { tableId: created[0].id, environmentId: baseline.profile.environmentId }
    await json(await admin.put('/api/assets/library/profile', { headers: { 'X-Asset-CSRF': csrf }, data: { ...sharedProfile, configs: {}, expectedVersion: current.version } }))
    for (const name of ['Personal', 'Default']) actors.push(await json(await admin.post('/api/auth/guest', { data: { displayName: `${name}-${engineName}-${Date.now()}`, clientVersion: 'appearance-qa' } })))
    browser = await playwright[engineName].launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
    const pages = []
    for (const [index, actor] of actors.entries()) {
      const context = await browser.newContext({ viewport: { width: index ? 1280 : 1440, height: 900 } })
      contexts.push(context)
      await context.addInitScript(({ token, name }) => { localStorage.setItem('pooltool.token', token); localStorage.setItem('pooltool.name', name) }, { token: actor.token, name: actor.user.displayName })
      const page = await context.newPage(); pages.push(page)
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/assets/')) adminWrites.push(new URL(request.url()).pathname) })
      page.on('websocket', socket => socket.on('framesent', frame => { try { const value = JSON.parse(frame.payload); if (value.type === 'command' && value.command?.type === 'shot') shotCommands.push(value) } catch {} }))
      await page.goto(base); await home(page)
    }
    const [first, second] = pages, firstId = actors[0].user.id
    await openAppearance(first)
    await first.getByLabel('Стол', { exact: true }).selectOption(`asset:${created[1].id}`)
    await apply(first)
    assert.deepEqual((await saved(first, firstId)).table, { mode: 'asset', id: created[1].id })
    assert.deepEqual((await json(await admin.get('/api/assets/library'))).profile, sharedProfile, 'Personal Apply must not publish a shared scene')
    await first.reload(); await home(first); await openAppearance(first)
    assert.equal(await first.getByLabel('Стол', { exact: true }).inputValue(), `asset:${created[1].id}`)
    await first.getByRole('button', { name: 'Отмена', exact: true }).click(); await closeSettings(first)
    await openAppearance(second)
    assert.equal(await second.getByLabel('Стол', { exact: true }).inputValue(), 'default')
    const secondSaved = await saved(second, actors[1].user.id)
    assert.ok(secondSaved === null || secondSaved.table.mode === 'default', 'Another user retains their independent default')
    await second.getByRole('button', { name: 'Отмена', exact: true }).click(); await closeSettings(second)

    // A failed first catalogue fetch must preserve the ID loaded from local storage.
    await first.route('**/api/assets/library', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Injected catalogue outage' }) }))
    await first.reload(); await home(first); await openAppearance(first)
    await first.getByRole('alert').filter({ hasText: 'Сохранённый выбор не изменён' }).waitFor()
    assert.equal(await first.getByLabel('Стол', { exact: true }).inputValue(), `asset:${created[1].id}`)
    await apply(first)
    assert.deepEqual((await saved(first, firstId)).table, { mode: 'asset', id: created[1].id })
    await first.unroute('**/api/assets/library')
    await openAppearance(first); await first.getByLabel('Стол', { exact: true }).locator(`option[value="asset:${created[1].id}"]:not([disabled])`).waitFor({ state: 'attached' })
    await first.getByRole('button', { name: 'Отмена', exact: true }).click(); await closeSettings(first)

    const auth = actor => ({ Authorization: `Bearer ${actor.token}` })
    room = (await json(await admin.post('/api/rooms', { headers: auth(actors[0]), data: { settings: { turnSeconds: 180, ranked: false } } }))).room
    await json(await admin.post(`/api/rooms/${room.code}/join`, { headers: auth(actors[1]) }))
    await json(await admin.post(`/api/rooms/${room.code}/ready`, { headers: auth(actors[0]), data: { ready: true } }))
    const match = (await json(await admin.post(`/api/rooms/${room.code}/ready`, { headers: auth(actors[1]), data: { ready: true } }))).match
    for (const page of pages) await page.locator('.game-stage canvas').waitFor({ timeout: 40_000 })
    const currentIndex = match.players[match.currentPlayer].id === firstId ? 0 : 1, active = pages[currentIndex]
    const marker = `appearance-live-${Date.now()}`
    await active.locator('.game-stage canvas').evaluate((canvas, marker) => { canvas.dataset.appearanceQa = marker }, marker)
    await openAppearance(active)
    await active.locator('.game-stage canvas').focus(); await active.keyboard.press('Space')
    await active.keyboard.down('Alt')
    assert.equal(await active.getByTestId('alt-assist').count(), 0)
    await active.keyboard.up('Alt')
    await active.locator('.appearance-preview canvas').click({ position: { x: 80, y: 80 } })
    await active.getByLabel('Стол', { exact: true }).selectOption('procedural')
    await apply(active)
    assert.equal((await saved(active, actors[currentIndex].user.id)).table.mode, 'procedural')
    assert.equal(await active.locator('.game-stage canvas').getAttribute('data-appearance-qa'), marker, 'Appearance modal must preserve the match canvas')
    assert.equal((await json(await admin.get(`/api/matches/${match.id}`, { headers: auth(actors[currentIndex]) }))).match.revision, match.revision, 'Preview interactions cannot perform a shot')
    assert.equal(shotCommands.length, 0)
    assert.deepEqual((await json(await admin.get('/api/assets/library'))).profile, sharedProfile)
    await active.screenshot({ path: path.join(artifacts, `${engineName}-personal-procedural-match.png`) })

    // A confirmed disable invalidates only the affected personal choice.
    await openAppearance(first); await first.getByLabel('Стол', { exact: true }).selectOption(`asset:${created[1].id}`); await apply(first)
    await json(await admin.delete(`/api/assets/models/${created[1].id}`, { headers: { 'X-Asset-CSRF': csrf } }))
    await openAppearance(first)
    await first.waitForFunction(id => JSON.parse(localStorage.getItem(`pooltool.assets.${encodeURIComponent(id)}`) || '{}').table?.mode === 'default', firstId)
    assert.equal(await first.getByLabel('Стол', { exact: true }).inputValue(), 'default')
    await first.getByRole('button', { name: 'Отмена', exact: true }).click(); await closeSettings(first)
    assert.deepEqual((await json(await admin.get('/api/assets/library'))).profile, sharedProfile)
    assert.deepEqual(adminWrites, [], 'The public appearance UI must make zero administrative writes')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine: engineName, tests: 'real public UI, user-local persistence/reload, another-user isolation, no shared publication, first-fetch outage preserves ID, active-match canvas/input gating, procedural choice, disabled asset reconciliation', jsErrors: 0, adminWrites: 0 }))
  } catch (failure) {
    for (const [index, context] of contexts.entries()) await context.pages()[0]?.screenshot({ path: path.join(artifacts, `${engineName}-failure-${index}.png`) }).catch(() => {})
    console.error(`${engineName}: ${failure.stack || failure}`)
    process.exitCode = 1
  } finally {
    await Promise.all(contexts.map(context => context.close()))
    if (room) for (const actor of actors) await admin.post(`/api/rooms/${room.code}/leave`, { headers: { Authorization: `Bearer ${actor.token}` } }).catch(() => {})
    try {
      csrf = (await json(await admin.post('/api/assets/admin/login', { data: { username, password } }))).csrfToken
      for (const asset of created) await json(await admin.delete(`/api/assets/models/${asset.id}`, { headers: { 'X-Asset-CSRF': csrf } }))
      const current = await json(await admin.get('/api/assets/library'))
      await json(await admin.put('/api/assets/library/profile', { headers: { 'X-Asset-CSRF': csrf }, data: { ...baseline.profile, configs: {}, expectedVersion: current.version } }))
      await admin.post('/api/assets/admin/logout', { headers: { 'X-Asset-CSRF': csrf } })
    } catch (failure) { console.error(`${engineName}: cleanup failed: ${failure.message}`); process.exitCode = 1 }
    await browser?.close(); await admin.dispose()
  }
}
