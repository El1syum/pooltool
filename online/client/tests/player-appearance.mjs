// Real Vue + Three.js preview, explicit local catalogue/test triangle. No server writes.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { minimalGlb } from './model-fixture.mjs'
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engine = process.env.BROWSER || 'chromium'
const artifacts = path.resolve('tests/artifacts/player-appearance')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4324, strictPort: true } })
let browser
try {
  await server.listen()
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = [], writes = [], models = [], references = []
  page.on('pageerror', failure => errors.push(failure.message))
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`) })
  await page.route('**/models/library/*.glb', async route => {
    models.push(new URL(route.request().url()).pathname)
    await route.fulfill(route.request().url().endsWith('/broken.glb') ? { status: 404, body: 'Missing fixture' } : { contentType: 'model/gltf-binary', body: Buffer.from(minimalGlb()) })
  })
  await page.route('**/api/assets/table-reference', async route => { references.push(route.request().url()); await route.fulfill({ status: 503, body: '{}' }) })
  await page.goto('http://127.0.0.1:4324/tests/player-appearance-fixture.html')
  await page.waitForFunction(() => window.fixtureReady)
  await page.getByRole('dialog', { name: 'Оформление' }).waitFor()
  await page.locator('.appearance-preview canvas').waitFor()
  await page.getByLabel('Стол', { exact: true }).selectOption('asset:table-a')
  await page.waitForFunction(() => window.fixtureRenderScene?.children.some(object => object.name === 'pooltool-Клубный стол'))
  assert.equal(await page.getByLabel('Стол', { exact: true }).locator('option[value="asset:disabled-table"]').count(), 0)
  assert.equal(await page.getByLabel('Стол', { exact: true }).locator('option[value="asset:room-a"]').count(), 0)
  await page.getByLabel('Окружение', { exact: true }).selectOption('procedural')
  assert.equal(await page.evaluate(() => window.appliedSelections.length), 0, 'Previewing a draft cannot apply or publish it')
  await page.getByRole('button', { name: 'Сверху', exact: true }).click()
  await page.getByRole('button', { name: 'Повернуть предпросмотр вправо' }).click()
  await page.getByRole('button', { name: 'Приблизить предпросмотр' }).click()
  await page.screenshot({ path: path.join(artifacts, `${engine}-desktop.png`) })
  await page.getByRole('button', { name: 'Отмена', exact: true }).click()
  assert.equal(await page.evaluate(() => window.appliedSelections.length), 0)
  await page.locator('#opener').click()
  assert.equal(await page.getByLabel('Стол', { exact: true }).inputValue(), 'default', 'Cancel must discard the local draft')
  await page.getByLabel('Стол', { exact: true }).selectOption('asset:table-a')
  await page.getByRole('button', { name: 'Применить', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.appliedSelections.at(-1)), { version: 1, table: { mode: 'asset', id: 'table-a' }, environment: { mode: 'default' } })
  await page.locator('#opener').click()
  assert.equal(await page.getByLabel('Стол', { exact: true }).inputValue(), 'asset:table-a')
  await page.getByLabel('Стол', { exact: true }).selectOption('asset:broken-table')
  await page.getByRole('alert').filter({ hasText: /Показана базовая геометрия/ }).waitFor()
  const fallback = await page.evaluate(() => {
    let count = 0
    window.fixtureRenderScene.traverse(object => { if (object.geometry?.type === 'BoxGeometry' && object.geometry.parameters.height === .025 && object.visible) count++ })
    return count
  })
  assert.equal(fallback, 1, 'Failed cosmetic art keeps one visible procedural bed')
  await page.getByRole('button', { name: 'Обновить библиотеку' }).click()
  await page.getByRole('button', { name: 'Общая библиотека и мастерская' }).click()
  assert.equal(await page.evaluate(() => window.retryCount), 1)
  assert.equal(await page.evaluate(() => window.manageCount), 1)
  await page.evaluate(() => document.querySelector('.appearance-manage').focus())
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Назад', 'Keyboard focus must stay inside the dialog')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Стол', { exact: true }).selectOption('asset:table-a')
  await page.waitForTimeout(200)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow screen must not overflow horizontally')
  await page.screenshot({ path: path.join(artifacts, `${engine}-390.png`), fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  // A temporarily unavailable catalogue may not erase an ID loaded from storage.
  await page.evaluate(() => { window.appearanceFixture.setLibrary(null); window.appearanceFixture.setLoading(true) })
  await page.locator('#opener').click()
  assert.equal(await page.getByLabel('Стол', { exact: true }).inputValue(), 'asset:table-a')
  await page.getByRole('button', { name: 'Применить', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.appliedSelections.at(-1).table), { mode: 'asset', id: 'table-a' })
  const referenceCount = references.length
  await page.goto('http://127.0.0.1:4324/tests/player-appearance-fixture.html?live=1')
  await page.waitForFunction(() => window.fixtureReady)
  await page.locator('.appearance-preview canvas').waitFor()
  await page.getByText(/размеры текущего матча · поле 0,82 × 1,64 м/).waitFor()
  assert.equal(references.length, referenceCount, 'A live match snapshot takes priority without fetching a different table reference')
  assert.deepEqual(writes, [], 'Personal selection never calls admin publishing or any server write')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, tests: 'real GLB preview, draft/apply/cancel, enabled role filtering, fallback, focus/Escape, 390px, loading ID preservation, actual live dimensions, zero server writes', models: [...new Set(models)], jsErrors: errors.length }))
} finally { await browser?.close(); await server.close() }
