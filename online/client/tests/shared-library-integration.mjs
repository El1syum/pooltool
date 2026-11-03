import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { minimalGlb } from './model-fixture.mjs'

const base = process.env.POOLTOOL_URL || 'http://127.0.0.1:8791'
const origin = new URL(base).origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname) || process.env.ALLOW_SHARED_LIBRARY_MUTATION === '1', 'Shared library mutations are restricted to loopback; explicitly opt in for an isolated remote test environment.')
const username = process.env.ASSET_ADMIN_USERNAME
const password = process.env.ASSET_ADMIN_PASSWORD
assert.ok(username && password, 'Set ASSET_ADMIN_USERNAME and ASSET_ADMIN_PASSWORD for this disposable test server.')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/shared-library')
await mkdir(artifacts, { recursive: true })

async function json(response) { const result = await response.json(); assert.ok(response.ok(), `HTTP ${response.status()} for ${new URL(response.url()).pathname}`); return result }
async function openModels(page) {
  await page.bringToFront()
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Настройки', exact: true }) }).waitFor()
  await page.getByRole('button', { name: 'Модели стола и окружения', exact: true }).click()
  await page.getByRole('heading', { name: 'Мастерская моделей', exact: true }).waitFor()
}
async function home(page) { await page.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor({ timeout: 30_000 }); await page.getByRole('status').filter({ hasText: 'Соединение установлено' }).waitFor() }
async function ready(page) { await page.getByRole('button', { name: 'Готов', exact: true }).click() }

const results = []
for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const engine = playwright[engineName]
  assert.ok(engine, `Unknown browser ${engineName}`)
  const browser = await engine.launch({ headless: true, ...(process.env[`${engineName.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`${engineName.toUpperCase()}_EXECUTABLE`] } : {}), ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const other = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage(), second = await other.newPage()
  const errors = [], uploaded = [], runtimeModels = new Set()
  const suffix = `${engineName}-${Date.now()}`
  const baseline = await json(await context.request.get(`${base}/api/assets/library`))
  let csrf = '', roomCode = ''
  for (const target of [page, second]) target.on('pageerror', error => errors.push(error.message))
  try {
    await Promise.all([page.goto(base), second.goto(base)])
    await Promise.all([home(page), home(second)])
    await openModels(page)
    assert.equal(await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).count(), 0)
    assert.equal(await page.getByLabel('Импорт GLB модели', { exact: true }).count(), 0)
    await page.screenshot({ path: path.join(artifacts, `${engineName}-readonly.png`) })
    await page.getByRole('button', { name: 'Вход администратора', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Вход администратора', exact: true })
    await dialog.getByLabel('Логин', { exact: true }).fill(username)
    await dialog.getByLabel('Пароль', { exact: true }).fill(`${password}-invalid`)
    await dialog.getByRole('button', { name: 'Войти в библиотеку', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'Неверный логин или пароль' }).waitFor()
    assert.equal(await dialog.getByLabel('Пароль', { exact: true }).inputValue(), '')
    await dialog.getByLabel('Пароль', { exact: true }).fill(password)
    await dialog.getByRole('button', { name: 'Войти в библиотеку', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByText('Доступ администратора', { exact: true }).waitFor()
    csrf = (await json(await context.request.get(`${base}/api/assets/admin/session`))).csrfToken
    assert.ok(csrf)
    assert.equal(await page.evaluate(secret => Object.keys(localStorage).every(key => !(localStorage.getItem(key) || '').includes(secret)), password), true)
    const payload = Buffer.from(minimalGlb())
    for (const [role, label, x] of [['table', 'Стол', '0.14'], ['environment', 'Окружение', '-0.21']]) {
      await page.getByRole('tab', { name: label, exact: true }).click()
      await page.getByLabel('Импорт GLB модели', { exact: true }).setInputFiles({ name: `${suffix}-${role}.glb`, mimeType: 'model/gltf-binary', buffer: payload })
      await page.getByText('GLB загружен в локальный черновик. После подготовки опубликуйте его в общей библиотеке.', { exact: true }).waitFor()
      await page.getByLabel('Название', { exact: true }).fill(`shared-${suffix}-${role}`)
      await page.getByLabel('Положение, м X', { exact: true }).fill(x)
      await page.getByRole('checkbox', { name: /^Заменять стандартный/ }).uncheck()
      const uploadedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assets/models' && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Сохранить модель в библиотеку', exact: true }).click()
      const result = await (await uploadedResponse).json()
      assert.ok(result.asset?.id, 'Upload must return a real server asset')
      uploaded.push(result.asset)
      await page.getByText('Модель и её настройки сохранены в общей библиотеке. Выбор сцены публикуется отдельно.', { exact: true }).waitFor()
    }
    const publication = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assets/library/profile' && response.request().method() === 'PUT')
    await page.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).click()
    const publishedResponse = await publication
    const published = await publishedResponse.json()
    assert.equal(publishedResponse.status(), 200)
    const sent = publishedResponse.request().postDataJSON()
    const table = uploaded.find(item => item.role === 'table'), environment = uploaded.find(item => item.role === 'environment')
    assert.deepEqual(published.profile, { tableId: table.id, environmentId: environment.id })
    assert.deepEqual(Object.keys(sent.configs).sort(), [table.id, environment.id].sort())
    assert.equal(sent.configs[table.id].replaceProcedural, false)
    assert.equal(sent.configs[environment.id].replaceProcedural, false)
    const publicState = await json(await other.request.get(`${base}/api/assets/library`))
    assert.deepEqual(publicState.profile, published.profile)
    assert.equal(publicState.assets.find(item => item.id === table.id).config.position[0], .14)
    assert.equal(publicState.assets.find(item => item.id === environment.id).config.position[0], -.21)
    await page.screenshot({ path: path.join(artifacts, `${engineName}-published.png`) })
    await second.reload()
    await home(second)
    await openModels(second)
    await second.getByLabel('Положение, м X', { exact: true }).waitFor()
    assert.equal(await second.getByLabel('Положение, м X', { exact: true }).inputValue(), '0.14')
    assert.equal(await second.getByLabel('Положение, м X', { exact: true }).isDisabled(), true)
    assert.equal(await second.getByRole('button', { name: 'Опубликовать общую сцену', exact: true }).count(), 0)
    await second.getByRole('tab', { name: 'Окружение', exact: true }).click()
    assert.equal(await second.getByLabel('Положение, м X', { exact: true }).inputValue(), '-0.21')
    const denied = await other.request.patch(`${base}/api/assets/models/${table.id}`, { headers: { Origin: origin }, data: { name: 'Must not change' } })
    assert.equal(denied.status(), 401)
    await page.getByRole('button', { name: 'Выйти из админки', exact: true }).click()
    await page.locator('.model-session-bar').filter({ hasText: 'Режим просмотра' }).waitFor()
    assert.equal(await page.getByLabel('Импорт GLB модели', { exact: true }).count(), 0)
    assert.equal((await json(await context.request.get(`${base}/api/assets/admin/session`))).authenticated, false)
    await Promise.all([page.getByRole('button', { name: 'Вернуться', exact: true }).click(), second.getByRole('button', { name: 'Вернуться', exact: true }).click()])
    await Promise.all([home(page), home(second)])
    second.on('response', response => { if (uploaded.some(asset => new URL(response.url()).pathname === asset.url) && response.ok()) runtimeModels.add(new URL(response.url()).pathname) })
    await second.getByRole('button', { name: 'Играть', exact: true }).click()
    await second.getByRole('button', { name: 'Игра с другом', exact: true }).click()
    await second.getByRole('button', { name: 'Настройки игры', exact: true }).click()
    await second.getByRole('combobox').selectOption('90')
    await second.getByRole('button', { name: 'Сохранить правила', exact: true }).click()
    await second.getByRole('button', { name: 'Создать игру', exact: true }).click()
    const invitation = second.getByLabel('Код приглашения', { exact: true })
    await invitation.waitFor()
    roomCode = (await invitation.innerText()).trim()
    await page.getByRole('button', { name: 'Играть', exact: true }).click()
    await page.getByRole('button', { name: 'Игра с другом', exact: true }).click()
    await page.getByRole('button', { name: 'Присоединиться', exact: true }).click()
    await page.getByLabel('Код комнаты', { exact: true }).fill(roomCode)
    await page.getByRole('button', { name: 'Присоединиться к игре', exact: true }).click()
    await page.getByText('90 секунд на удар', { exact: false }).waitFor()
    const gameModelResponses = uploaded.map(asset => second.waitForResponse(response => new URL(response.url()).pathname === asset.url && response.ok(), { timeout: 45_000 }))
    await ready(second)
    await ready(page)
    await Promise.all([page.locator('.game-stage canvas').waitFor({ timeout: 45_000 }), second.locator('.game-stage canvas').waitFor({ timeout: 45_000 })])
    await Promise.all(gameModelResponses)
    await second.waitForFunction(() => document.querySelector('.game-stage canvas')?.width > 0)
    assert.equal(runtimeModels.size, 2, 'Fresh match renderer fetched both server GLB URLs')
    assert.equal(await second.getByRole('alert').count(), 0)
    await second.screenshot({ path: path.join(artifacts, `${engineName}-shared-models-match.png`) })
    assert.deepEqual(errors, [])
    results.push(`${engineName}: passed`)
  } catch (failure) {
    await page.screenshot({ path: path.join(artifacts, `${engineName}-failure-admin.png`) }).catch(() => {})
    await second.screenshot({ path: path.join(artifacts, `${engineName}-failure-player.png`) }).catch(() => {})
    results.push(`${engineName}: FAILED: ${failure.message}`)
  } finally {
    // Test accounts/rooms and only this run's assets are touched during cleanup.
    for (const [ctx, target] of [[context, page], [other, second]]) {
      const token = await target.evaluate(() => localStorage.getItem('pooltool.token')).catch(() => '')
      if (token && roomCode) await ctx.request.post(`${base}/api/rooms/${roomCode}/leave`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {})
    }
    if (uploaded.length) {
      try {
        const login = await json(await context.request.post(`${base}/api/assets/admin/login`, { headers: { Origin: origin }, data: { username, password } }))
        csrf = login.csrfToken
        for (const asset of uploaded) await json(await context.request.delete(`${base}/api/assets/models/${asset.id}`, { headers: { Origin: origin, 'X-Asset-CSRF': csrf } }))
        const current = await json(await context.request.get(`${base}/api/assets/library`))
        await json(await context.request.put(`${base}/api/assets/library/profile`, { headers: { Origin: origin, 'X-Asset-CSRF': csrf }, data: { ...baseline.profile, configs: {}, expectedVersion: current.version } }))
        await context.request.post(`${base}/api/assets/admin/logout`, { headers: { Origin: origin, 'X-Asset-CSRF': csrf } })
      } catch (failure) { results.push(`${engineName}: cleanup FAILED: ${failure.message}`) }
    }
    await browser.close()
  }
}
for (const result of results) console.log(result)
assert.ok(results.every(result => !result.includes('FAILED')), 'Shared library integration failed; inspect saved screenshots.')
