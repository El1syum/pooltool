// Actual App + real API regression for the deliberately disabled platform mode.
// No SDK, GAS or platform account is mocked into a successful login here.
import assert from 'node:assert/strict'
import { waitForConnectedHome } from './app-state.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/vkplay-disabled')
await mkdir(artifacts, { recursive: true })
const response = await fetch(`${base}/api/auth/config`)
assert.equal(response.status, 200)
const config = await response.json()
assert.equal(config.guestEnabled, true)
assert.equal(config.vkPlay.enabled, false, 'This smoke test must never target an enabled live platform login')
assert.equal(config.vkPlay.configured, false)

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engineName].launch({ headless: true, ...(engineName === 'chromium' ? {
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...(process.env.DIRECT_NETWORK === '1' ? ['--no-proxy-server'] : [])],
  } : {}) })
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const page = await context.newPage(), errors = [], external = [], requests = []
  page.on('pageerror', failure => errors.push(failure.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname === 'vkplay.ru' || url.hostname.endsWith('.vkplay.ru')) external.push(url.pathname)
    if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/me') requests.push({ path: url.pathname, method: request.method() })
  })
  try {
    await page.goto(base)
    await page.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor({ timeout: 30_000 })
    await waitForConnectedHome(page)
    const token = await page.evaluate(() => localStorage.getItem('pooltool.token'))
    assert.ok(token, 'Ordinary preview continues to create a real guest session')
    const identity = await context.request.get(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(identity.status(), 200)
    const user = (await identity.json()).user
    const boundary = requests.length
    await page.goto(`${base}/?platform=vkplay`)
    await page.getByTestId('vkplay-entry').waitFor({ timeout: 30_000 })
    await page.getByTestId('vkplay-entry').getByRole('alert').waitFor()
    assert.match(await page.getByTestId('vkplay-entry').innerText(), /VK Play/)
    assert.equal(await page.evaluate(() => localStorage.getItem('pooltool.token')), token)
    assert.deepEqual(requests.slice(boundary).filter(item => item.path !== '/api/auth/config'), [], 'Disabled platform mode must not silently authenticate the cached guest or exchange a ticket')
    assert.deepEqual(external, [], 'Disabled mode must not load the platform SDK')
    assert.equal(await page.getByRole('heading', { name: 'Pooltool', exact: true }).count(), 0)
    await page.screenshot({ path: path.join(artifacts, `${engineName}-disabled.png`), fullPage: true })
    await page.getByRole('button', { name: 'Повторить вход', exact: true }).click()
    await page.getByTestId('vkplay-entry').getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('pooltool.token')), token)
    assert.deepEqual(requests.slice(boundary).filter(item => item.path !== '/api/auth/config'), [])
    await page.goto(base)
    await waitForConnectedHome(page)
    assert.equal(await page.evaluate(() => localStorage.getItem('pooltool.token')), token)
    const restored = await context.request.get(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal((await restored.json()).user.id, user.id)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine: engineName, guestPreserved: true, platformDisabled: true, noGuestFallback: true, sdkRequests: external.length, jsErrors: errors.length }))
  } catch (failure) {
    process.exitCode = 1
    await page.screenshot({ path: path.join(artifacts, `${engineName}-failure.png`), fullPage: true }).catch(() => {})
    console.error(`${engineName}: ${failure.stack || failure}`)
  } finally { await context.close(); await browser.close() }
}
