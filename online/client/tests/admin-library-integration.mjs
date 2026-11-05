// Full, opt-in administration regression against the real App and real API.
// Mutations are deliberately restricted to an isolated loopback test service.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { minimalGlb } from './model-fixture.mjs'

const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Admin mutation tests may only target an isolated loopback service')
const username = process.env.ASSET_ADMIN_USERNAME, password = process.env.ASSET_ADMIN_PASSWORD
assert.ok(username && password, 'Set separate, disposable administrator credentials through environment variables')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/admin-library-integration')
await mkdir(artifacts, { recursive: true })
const bytes = Buffer.from(minimalGlb())
const hash = value => createHash('sha256').update(value).digest('hex')
const ready = await fetch(`${base}/ready`)
assert.equal(ready.status, 200)
assert.equal((await ready.json()).physics, 'pooltool', 'A real engine, not fixture physics, is required')

async function json(response, expected = 200) {
  const value = await response.json()
  assert.equal(response.status(), expected, `${new URL(response.url()).pathname}: ${JSON.stringify(value.detail ?? '')}`)
  return value
}
async function until(task, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await task(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(message)
}
async function home(page) {
  await page.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor({ timeout: 30_000 })
  await page.getByRole('status').filter({ hasText: 'Соединение установлено' }).waitFor()
}
async function openWorkshop(page, inMatch = false) {
  if (inMatch) await page.getByRole('button', { name: 'Меню матча', exact: true }).click()
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('button', { name: 'Модели стола и окружения', exact: true }).click()
  await page.getByRole('heading', { name: 'Мастерская моделей', exact: true }).waitFor()
}
async function login(page, enteredPassword = password) {
  await page.getByRole('button', { name: 'Вход администратора', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Вход администратора', exact: true })
  await dialog.getByLabel('Логин', { exact: true }).fill(username)
  await dialog.getByLabel('Пароль', { exact: true }).fill(enteredPassword)
  await dialog.getByRole('button', { name: 'Войти в библиотеку', exact: true }).click()
}
async function exportConfig(page) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Экспорт JSON', exact: true }).click()
  return JSON.parse(await readFile(await (await pending).path(), 'utf8'))
}
async function editorReady(page) {
  await page.waitForFunction(() => document.querySelector('input[aria-label="Импорт GLB модели"]')?.disabled === false)
  await page.waitForFunction(() => !document.querySelector('.model-preview-column')?.textContent.includes('Загрузка модели и проверка ресурсов'))
  await page.waitForTimeout(160) // Let the debounced cosmetic preview settle.
}
async function importGlb(page, name) {
  await editorReady(page)
  await page.getByLabel('Импорт GLB модели', { exact: true }).setInputFiles({ name, mimeType: 'model/gltf-binary', buffer: bytes })
  await page.getByText('GLB загружен в локальный черновик.', { exact: false }).waitFor()
  await editorReady(page)
}
async function setRange(page, label, value) {
  const control = page.getByLabel(label, { exact: false })
  await control.evaluate((element, next) => { element.value = String(next); element.dispatchEvent(new Event('input', { bubbles: true })) }, value)
}
async function publish(page) {
  await editorReady(page)
  await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).click()
  await page.getByText('Общая сцена опубликована.', { exact: false }).waitFor()
  await editorReady(page)
}
async function saveModel(page) {
  await editorReady(page)
  await page.getByRole('button', { name: 'Сохранить модель в библиотеку', exact: true }).click()
  await page.getByText('Модель и её настройки сохранены', { exact: false }).waitFor()
  await editorReady(page)
}
async function loadShared(page) {
  await page.getByRole('button', { name: 'Загрузить общую сцену', exact: true }).click()
  await editorReady(page)
}

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const engine = playwright[engineName]
  assert.ok(engine, `Unknown engine ${engineName}`)
  const admin = await playwright.request.newContext({ baseURL: base, extraHTTPHeaders: { Origin: new URL(base).origin } })
  let csrf = '', browser, context, page, room, actor, opponent, releaseStartup
  const created = new Set(), checks = [], errors = [], failedAssets = [], modelWrites = []
  let baseline, startupHeld = false
  const prefix = `admin-${engineName}-${Date.now()}`
  async function api(endpoint, options = {}, expected = 200) { return json(await admin.fetch(endpoint, options), expected) }
  async function authenticateAdmin() { csrf = (await api('/api/assets/admin/login', { method: 'POST', data: { username, password } })).csrfToken }
  async function library() { return api('/api/assets/library?includeDisabled=true') }
  const signed = () => ({ 'X-Asset-CSRF': csrf })
  async function playerApi(user, endpoint, body, method = 'POST') {
    return api(endpoint, { method, headers: { Authorization: `Bearer ${user.token}` }, ...(method === 'GET' ? {} : { data: body ?? {} }) })
  }
  async function check(title, task) { await task(); checks.push(title); console.log(`${engineName}: PASS ${title}`) }
  try {
    await authenticateAdmin()
    baseline = await library()
    actor = await api('/api/auth/guest', { method: 'POST', data: { displayName: `${prefix}-host`.slice(0, 32), clientVersion: 'admin-regression' } })
    browser = await engine.launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true })
    await context.addInitScript(({ token, id, name }) => {
      localStorage.setItem('pooltool.token', token); localStorage.setItem('pooltool.name', name)
      localStorage.setItem(`pooltool.settings.${id}`, JSON.stringify({ volume: .35 }))
      // Record, but do not replace or fabricate, the application's live socket.
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); if (new URL(args[0], location.href).pathname === '/ws') window.adminTestSocket = this }
      }
    }, { token: actor.token, id: actor.user.id, name: actor.user.displayName })
    let notifyStartup
    const startupRequest = new Promise(resolve => { notifyStartup = resolve })
    const startupGate = new Promise(resolve => { releaseStartup = resolve })
    await context.route('**/api/me/settings', async route => {
      if (route.request().method() === 'PUT' && !startupHeld) {
        startupHeld = true; notifyStartup(); await startupGate
      }
      await route.continue()
    })
    page = await context.newPage()
    page.on('dialog', dialog => dialog.accept())
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', async response => {
      const pathname = new URL(response.url()).pathname
      if (/\.(css|js|svg|woff2?|ttf|png|webp)$/.test(pathname) && response.status() >= 400) failedAssets.push(`${response.status()} ${pathname}`)
      if (pathname === '/api/assets/models' && response.request().method() === 'POST' && response.ok()) {
        try { created.add((await response.json()).asset.id) } catch {}
      }
    })
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/assets/') && !['GET', 'HEAD'].includes(request.method())) modelWrites.push({ method: request.method(), path: new URL(request.url()).pathname }) })
    await page.goto(base)
    await home(page)
    await check('Delayed startup settings sync cannot close Settings or discard newer edits', async () => {
      await Promise.race([startupRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Cached settings did not trigger the real startup PUT')), 15_000))])
      await page.getByRole('button', { name: 'Настройки', exact: true }).click()
      await page.getByRole('button', { name: 'Звук', exact: true }).click()
      const volume = page.locator('input[type="range"]').first()
      await volume.evaluate(element => { element.value = '.65'; element.dispatchEvent(new Event('input', { bubbles: true })) })
      releaseStartup()
      await until(async () => (await playerApi(actor, '/api/me/settings', null, 'GET')).settings.volume === .65, 'Newer settings were overwritten by the delayed startup response')
      assert.equal(await page.getByRole('dialog', { name: 'Звук', exact: true }).count(), 1)
      assert.equal(Number(await volume.inputValue()), .65)
      await page.getByRole('button', { name: 'Закрыть настройки', exact: true }).click()
      await context.unroute('**/api/me/settings')
    })
    await openWorkshop(page)
    await check('Public read-only and login cancellation', async () => {
      assert.equal(await page.getByLabel('Импорт GLB модели', { exact: true }).count(), 0)
      await page.getByRole('button', { name: 'Вход администратора', exact: true }).click()
      await page.keyboard.press('Escape')
      assert.equal(await page.getByRole('dialog', { name: 'Вход администратора', exact: true }).count(), 0)
    })
    await check('Wrong password is rejected and cleared', async () => {
      await login(page, 'wrong-disposable-test-password')
      await page.getByRole('dialog').getByRole('alert').waitFor()
      assert.equal(await page.getByLabel('Пароль', { exact: true }).inputValue(), '')
      await page.getByRole('button', { name: 'Закрыть вход администратора', exact: true }).click()
    })
    await login(page); await editorReady(page)
    await check('Valid login and authoritative preview reference', async () => {
      assert.match(await page.locator('.model-session-bar').innerText(), new RegExp(username))
      await page.getByText(/эталон игрового сервера/).waitFor()
    })
    await check('Bad GLB is rejected before any server upload', async () => {
      const before = modelWrites.filter(write => write.path === '/api/assets/models').length
      await page.getByLabel('Импорт GLB модели', { exact: true }).setInputFiles({ name: 'invalid.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('invalid') })
      await page.locator('.model-message.model-error').first().waitFor()
      assert.equal(modelWrites.filter(write => write.path === '/api/assets/models').length, before)
    })
    const tableName = `${prefix}-table.glb`, environmentName = `${prefix}-environment.glb`
    await importGlb(page, tableName)
    await check('Local import previews real geometry without upload and downloads the original', async () => {
      assert.equal(created.size, 0)
      assert.match(await page.locator('.model-editor').innerText(), /1 мешей · 3 вершин/)
      const pending = page.waitForEvent('download')
      await page.getByRole('button', { name: 'Скачать исходный GLB', exact: true }).click()
      assert.equal(hash(await readFile(await (await pending).path())), hash(bytes))
    })
    await check('All transform axes, replacement and reset', async () => {
      for (const [label, values] of [['Положение, м', [.1, .2, .3]], ['Поворот, градусы', [10, 20, 30]], ['Масштаб', [1.1, 1.2, 1.3]]])
        for (let index = 0; index < 3; index++) await page.getByLabel(`${label} ${'XYZ'[index]}`, { exact: true }).fill(String(values[index]))
      await page.getByLabel(/Заменять стандартный стол/).uncheck()
      const slot = (await exportConfig(page)).table
      assert.deepEqual(slot.position, [.1, .2, .3]); assert.deepEqual(slot.rotation, [10, 20, 30]); assert.deepEqual(slot.scale, [1.1, 1.2, 1.3]); assert.equal(slot.replaceProcedural, false)
      await page.getByRole('button', { name: 'Сбросить трансформацию', exact: true }).click()
      const reset = (await exportConfig(page)).table
      assert.deepEqual(reset.position, [0, 0, 0]); assert.deepEqual(reset.rotation, [0, 0, 0]); assert.deepEqual(reset.scale, [1, 1, 1])
    })
    await check('Global and named materials reset independently', async () => {
      await page.getByLabel('Оттенок', { exact: true }).fill('#123456')
      await setRange(page, /Шероховатость/, .42); await setRange(page, /Металличность/, .23)
      assert.deepEqual((await exportConfig(page)).table.material, { color: '#123456', roughness: .42, metalness: .23 })
      await page.locator('.model-editor select').selectOption('Cloth')
      await page.getByLabel('Оттенок', { exact: true }).fill('#abcdef')
      assert.equal((await exportConfig(page)).table.materials.Cloth.color, '#abcdef')
      await page.getByRole('button', { name: 'Сбросить материал', exact: true }).click()
      const reset = (await exportConfig(page)).table
      assert.equal(reset.materials.Cloth, undefined); assert.equal(reset.material.color, '#123456')
      await page.locator('.model-editor select').selectOption('')
      await page.getByRole('button', { name: 'Сбросить материал', exact: true }).click()
      assert.deepEqual((await exportConfig(page)).table.material, {})
    })
    await check('Node search/visibility and all preview controls', async () => {
      await page.getByText('Видимость узлов', { exact: true }).click()
      await page.getByLabel('Поиск узла модели', { exact: true }).fill('Workshop')
      await page.getByLabel('Скрыть WorkshopTriangle', { exact: true }).check()
      assert.deepEqual((await exportConfig(page)).table.hiddenNodes, ['WorkshopTriangle'])
      await page.getByLabel('Скрыть WorkshopTriangle', { exact: true }).uncheck()
      await page.getByLabel('Поиск узла модели', { exact: true }).fill('missing')
      assert.equal(await page.getByLabel('Скрыть WorkshopTriangle', { exact: true }).count(), 0)
      await page.getByLabel('Поиск узла модели', { exact: true }).fill('')
      for (const label of ['Сверху', 'Общий вид', '↶', '↷', '+', '−']) await page.locator('.model-preview-toolbar').getByRole('button', { name: label, exact: true }).click()
      await page.getByLabel('Физические границы', { exact: true }).uncheck(); await page.getByLabel('Физические границы', { exact: true }).check()
    })
    await check('Local draft and JSON round-trip', async () => {
      await page.getByLabel('Положение, м X', { exact: true }).fill('.12')
      await page.getByRole('button', { name: 'Сохранить черновик', exact: true }).click()
      await page.getByText('Черновик сохранён только в этом браузере.', { exact: false }).waitFor()
      const saved = await exportConfig(page)
      await page.getByLabel('Положение, м X', { exact: true }).fill('.34')
      await page.getByRole('button', { name: 'Восстановить черновик', exact: true }).click()
      await page.getByText('Восстановлен локальный черновик', { exact: false }).waitFor()
      assert.equal(await page.getByLabel('Положение, м X', { exact: true }).inputValue(), '0.12')
      await page.getByLabel('Положение, м X', { exact: true }).fill('.56')
      await page.locator('input[type=file][accept=".json,application/json"]').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(saved)) })
      await page.getByText('Конфигурация загружена в черновик', { exact: false }).waitFor()
      assert.deepEqual(await exportConfig(page), saved)
    })
    await check('Save one model and download actual server file', async () => {
      await saveModel(page)
      const state = await library(), asset = state.assets.find(value => value.name === tableName)
      assert.ok(asset); assert.equal(asset.config.position[0], .12)
      assert.deepEqual(state.profile, baseline.profile, 'Save does not select an unpublished asset')
      assert.equal(hash(await (await admin.get(asset.url)).body()), hash(bytes))
    })
    await check('Table/environment publication includes renamed models atomically', async () => {
      await page.getByLabel('Название', { exact: true }).fill(`${prefix}-renamed-table`)
      await page.getByRole('tab', { name: 'Окружение', exact: true }).click()
      await importGlb(page, environmentName)
      await page.getByLabel('Название', { exact: true }).fill(`${prefix}-renamed-environment`)
      await page.getByLabel('Положение, м Y', { exact: true }).fill('.33')
      await publish(page)
      const state = await library()
      assert.equal(state.assets.find(value => value.id === state.profile.tableId).name, `${prefix}-renamed-table`)
      assert.equal(state.assets.find(value => value.id === state.profile.environmentId).name, `${prefix}-renamed-environment`)
      assert.equal(state.assets.find(value => value.id === state.profile.environmentId).config.position[1], .33)
    })
    await check('Refresh never silently rebases an old draft over another administrator', async () => {
      await page.getByRole('tab', { name: 'Стол', exact: true }).click()
      const oldDraft = await exportConfig(page), state = await library()
      await api(`/api/assets/models/${state.profile.tableId}`, { method: 'PATCH', headers: signed(), data: { expectedVersion: state.version, config: { position: [.5, 0, 0] } } })
      await page.getByRole('button', { name: 'Обновить', exact: true }).click()
      await editorReady(page)
      assert.deepEqual(await exportConfig(page), oldDraft)
      assert.equal(await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).isDisabled(), true)
      assert.equal((await library()).assets.find(value => value.id === state.profile.tableId).config.position[0], .5)
      await loadShared(page)
      assert.equal(await page.getByLabel('Положение, м X', { exact: true }).inputValue(), '0.5')
    })
    await check('Uploading a local slot cannot bypass a stale draft version', async () => {
      const state = await library()
      await api(`/api/assets/models/${state.profile.tableId}`, { method: 'PATCH', headers: signed(), data: { expectedVersion: state.version, config: { position: [.63, 0, 0] } } })
      await page.getByRole('tab', { name: 'Окружение', exact: true }).click()
      await importGlb(page, `${prefix}-stale-environment.glb`)
      const oldDraft = await exportConfig(page)
      const conflict = page.waitForResponse(response => response.url().includes('/api/assets/') && response.status() === 409)
      await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).click()
      await conflict
      await page.getByRole('alert').filter({ hasText: /обнов|измен|конфликт/i }).first().waitFor()
      assert.deepEqual(await exportConfig(page), oldDraft, 'A conflict retains the local file and all edits')
      const after = await library()
      assert.equal(after.assets.find(value => value.id === state.profile.tableId).config.position[0], .63)
      assert.equal(after.profile.environmentId, state.profile.environmentId)
      assert.equal(await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).isDisabled(), true)
      await loadShared(page)
    })
    await check('Revoked session reauthentication retains the mounted canvas and complete draft', async () => {
      await page.getByRole('tab', { name: 'Стол', exact: true }).click()
      await page.getByLabel('Положение, м X', { exact: true }).fill('.77')
      await page.getByLabel('Название', { exact: true }).fill(`${prefix}-unsaved-reauth`)
      await editorReady(page)
      const before = await exportConfig(page), marker = `${prefix}-reauth-canvas`
      await page.locator('.model-preview-stage canvas').evaluate((canvas, value) => { canvas.dataset.auditMarker = value }, marker)
      const session = await json(await context.request.get(`${base}/api/assets/admin/session`))
      await json(await context.request.post(`${base}/api/assets/admin/logout`, { headers: { 'X-Asset-CSRF': session.csrfToken } }))
      await page.getByRole('button', { name: 'Сохранить модель в библиотеку', exact: true }).click()
      await page.getByRole('button', { name: 'Вход администратора', exact: true }).waitFor()
      await login(page); await editorReady(page)
      assert.deepEqual(await exportConfig(page), before)
      assert.equal(await page.locator('.model-preview-stage canvas').getAttribute('data-audit-marker'), marker)
    })
    await check('Standard geometry clears just one role after publication', async () => {
      await loadShared(page)
      await page.getByRole('tab', { name: 'Окружение', exact: true }).click()
      const before = await library()
      await page.getByRole('button', { name: 'Стандартная геометрия', exact: true }).click()
      assert.deepEqual((await library()).profile, before.profile)
      await publish(page)
      assert.deepEqual((await library()).profile, { tableId: before.profile.tableId, environmentId: null })
    })
    await check('Disable/restore remains reversible and does not auto-publish', async () => {
      await page.getByRole('tab', { name: 'Стол', exact: true }).click()
      const state = await library(), asset = state.assets.find(value => value.id === state.profile.tableId)
      await page.getByRole('button', { name: `Удалить ${asset.name}`, exact: true }).click()
      await page.getByText('Модель удалена из библиотеки.', { exact: true }).waitFor()
      let after = await library()
      assert.equal(after.profile.tableId, null); assert.equal(after.assets.find(value => value.id === asset.id).enabled, false)
      assert.equal((await admin.get(asset.url)).status(), 404)
      await page.getByRole('button', { name: `Восстановить ${asset.name}`, exact: true }).click()
      await page.getByText('Модель восстановлена в библиотеке.', { exact: false }).waitFor()
      after = await library(); assert.equal(after.profile.tableId, null); assert.equal(after.assets.find(value => value.id === asset.id).enabled, true)
      await page.locator('.model-library-pick').filter({ hasText: asset.name }).click(); await editorReady(page)
      await page.getByLabel('Название', { exact: true }).fill(`${prefix}-saved-rename`)
      await saveModel(page)
      assert.ok((await library()).assets.find(value => value.name === `${prefix}-saved-rename`))
    })
    await check('Removing a local source leaves the uploaded model untouched', async () => {
      const summary = page.getByText(/Локальные исходники/)
      if (await summary.count()) {
        const details = page.locator('details').filter({ has: summary }).first()
        if (!await details.getAttribute('open')) await summary.click()
        await page.getByRole('button', { name: `Удалить локальный ${tableName}`, exact: true }).click()
        await page.getByRole('button', { name: `Удалить локальный ${tableName}`, exact: true }).waitFor({ state: 'hidden' })
      }
      assert.ok((await library()).assets.find(value => value.name === `${prefix}-saved-rename`))
    })
    await check('Existing match updates and reconnect preserve the workshop and unsaved draft', async () => {
      await page.getByRole('button', { name: 'Вернуться', exact: true }).click()
      opponent = await api('/api/auth/guest', { method: 'POST', data: { displayName: `${prefix}-opponent`.slice(0, 32), clientVersion: 'admin-regression' } })
      room = (await playerApi(actor, '/api/rooms', { settings: { turnSeconds: 180, ranked: false } })).room
      await playerApi(opponent, `/api/rooms/${room.code}/join`)
      await playerApi(actor, `/api/rooms/${room.code}/ready`, { ready: true })
      await playerApi(opponent, `/api/rooms/${room.code}/ready`, { ready: true })
      await page.getByTestId('match-hud').waitFor({ timeout: 30_000 })
      await openWorkshop(page, true)
      await importGlb(page, `${prefix}-match-local.glb`)
      await page.getByLabel('Положение, м X', { exact: true }).fill('.77')
      const before = await exportConfig(page), marker = `${prefix}-match-canvas`
      await page.locator('.model-preview-stage canvas').evaluate((canvas, value) => { canvas.dataset.auditMarker = value }, marker)
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/current' && response.ok())
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await restored
      assert.equal(await page.getByRole('heading', { name: 'Мастерская моделей', exact: true }).count(), 1)
      assert.deepEqual(await exportConfig(page), before)
      assert.equal(await page.locator('.model-preview-stage canvas').getAttribute('data-audit-marker'), marker)
      // Closing the real socket exercises the actual reconnect path. Browser
      // offline emulation alone does not reliably close an existing WebSocket.
      const reconnect = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/current' && response.ok(), { timeout: 20_000 })
      await page.evaluate(() => window.adminTestSocket.close())
      await reconnect
      assert.deepEqual(await exportConfig(page), before)
      assert.equal(await page.locator('.model-preview-stage canvas').getAttribute('data-audit-marker'), marker)

      const current = (await playerApi(actor, '/api/me/current', null, 'GET')).match
      const shooter = current.players[current.currentPlayer].id === actor.user.id ? actor : opponent
      const fired = await playerApi(shooter, `/api/matches/${current.id}/commands`, {
        commandId: `admin-playback-${crypto.randomUUID()}`, expectedRevision: current.revision,
        type: 'shot', payload: { V0: 1.5, phi: 0, theta: 0, a: 0, b: 0 },
      })
      assert.ok(fired.result?.trajectory?.frames.length > 1, 'A real physical shot must run while the workshop is open')
      assert.ok(fired.result.duration > 4, 'The physical shot must leave enough time for the two return regressions')
      assert.deepEqual(await exportConfig(page), before)
      assert.equal(await page.locator('.model-preview-stage canvas').getAttribute('data-audit-marker'), marker)
      await page.getByRole('button', { name: 'Вернуться', exact: true }).click()
      await page.getByTestId('match-hud').waitFor()
      await page.locator('.hud-match-status').filter({ hasText: 'Воспроизведение удара' }).waitFor({ timeout: 2_000 })
      // The complementary case: entering the workshop interrupts an ALREADY
      // running renderer. Returning must resume, not jump to final positions.
      await openWorkshop(page, true)
      await page.getByRole('button', { name: 'Вернуться', exact: true }).click()
      await page.getByTestId('match-hud').waitFor()
      await page.locator('.hud-match-status').filter({ hasText: 'Воспроизведение удара' }).waitFor({ timeout: 2_000 })
      await until(async () => {
        const value = (await playerApi(actor, '/api/me/current', null, 'GET')).match
        return value.status === 'active' && Date.parse(value.playbackUntil || 0) <= Date.now() ? value : null
      }, 'The real shared physical playback did not settle')
      await playerApi(actor, `/api/rooms/${room.code}/leave`, {})
      await playerApi(opponent, `/api/rooms/${room.code}/leave`, {})
      room = null
    })
    await check('Session persists on reload; logout returns read-only without discarding the draft', async () => {
      await page.reload(); await home(page); await openWorkshop(page); await editorReady(page)
      await importGlb(page, `${prefix}-logout-local.glb`)
      await page.getByLabel('Положение, м X', { exact: true }).fill('.91')
      const before = await exportConfig(page)
      await page.getByRole('button', { name: 'Выйти из админки', exact: true }).click()
      await page.getByRole('button', { name: 'Вход администратора', exact: true }).waitFor()
      assert.equal(await page.getByLabel('Импорт GLB модели', { exact: true }).count(), 0)
      assert.equal((await json(await context.request.get(`${base}/api/assets/admin/session`))).authenticated, false)
      assert.deepEqual(await exportConfig(page), before)
    })
    assert.deepEqual(errors, [], 'No uncaught client JavaScript errors')
    assert.deepEqual(failedAssets, [], 'No broken static resources')
    await page.screenshot({ path: path.join(artifacts, `${engineName}-read-only-draft.png`), fullPage: true })
    console.log(JSON.stringify({ engine: engineName, checks: checks.length, startupPutHeld: startupHeld, concurrentWriteProtected: true, renamePublished: true, reauthDraftRetained: true, matchNavigationRetained: true, logoutDraftRetained: true, jsErrors: errors.length, staticErrors: failedAssets.length }))
  } catch (failure) {
    process.exitCode = 1
    await page?.screenshot({ path: path.join(artifacts, `${engineName}-failure.png`), fullPage: true }).catch(() => {})
    console.error(`${engineName}: ${failure.stack || failure}`)
    if (errors.length || failedAssets.length) console.error(JSON.stringify({ errors, failedAssets }))
  } finally {
    releaseStartup?.()
    if (room) for (const user of [actor, opponent].filter(Boolean)) await playerApi(user, `/api/rooms/${room.code}/leave`, {}).catch(() => {})
    await context?.close(); await browser?.close()
    try {
      await authenticateAdmin()
      const current = await library()
      const configs = {}, names = {}
      for (const id of Object.values(baseline?.profile ?? {})) {
        const asset = baseline.assets.find(value => value.id === id)
        if (asset) { configs[id] = asset.config; names[id] = asset.name }
      }
      if (baseline) await api('/api/assets/library/profile', { method: 'PUT', headers: signed(), data: { ...baseline.profile, configs, names, expectedVersion: current.version } })
      for (const id of created) {
        const state = await library()
        await api(`/api/assets/models/${id}?expectedVersion=${state.version}`, { method: 'DELETE', headers: signed() })
      }
      await api('/api/assets/admin/logout', { method: 'POST', headers: signed() })
    } catch (failure) { process.exitCode = 1; console.error(`${engineName}: fixture cleanup failed: ${failure.message}`) }
    await admin.dispose()
  }
}
