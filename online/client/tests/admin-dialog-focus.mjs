// Actual ModelAdminLogin component, no authentication/HTTP API mutations.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/admin-dialog-focus')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
const results = [], failures = [], errors = [], apiRequests = []
let browser
try {
  await server.listen()
  for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
    browser = await playwright[engine].launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 900, height: 750 } })
    page.on('pageerror', error => errors.push({ engine, message: error.message }))
    await page.route('**/api/**', route => { apiRequests.push({ engine, method: route.request().method(), path: new URL(route.request().url()).pathname }); return route.fulfill({ status: 503, body: 'Component test forbids API access' }) })
    await page.addInitScript(() => {
      window.adminFocusLockRequests = 0
      Element.prototype.requestPointerLock = function () { window.adminFocusLockRequests++; return Promise.reject(new Error('Component test forbids Pointer Lock')) }
    })
    await page.goto(server.resolvedUrls.local[0] + 'tests/button-layout.fixture.html')
    await page.waitForFunction(() => window.fixtureReady)
    await page.evaluate(() => {
      const fixture = window.buttonLayoutFixture
      const originalPush = fixture.counters.events.push.bind(fixture.counters.events)
      fixture.counters.events.push = (...events) => {
        const result = originalPush(...events)
        if (events.includes('login-close')) fixture.setSurface(window.adminFocusNextSurface || 'club')
        return result
      }
      const opener = document.createElement('button')
      opener.id = 'admin-opener'; opener.textContent = 'Открыть тестовый вход'
      opener.addEventListener('click', () => fixture.setSurface('login'))
      const other = document.createElement('button')
      other.id = 'admin-background-other'; other.textContent = 'Другое фоновое действие'
      document.body.prepend(opener, other)
      window.adminFocusOriginalHasFocus = document.hasFocus.bind(document)
    })
    const dialog = page.getByRole('dialog', { name: 'Вход администратора', exact: true })
    const close = () => dialog.getByRole('button', { name: 'Закрыть вход администратора', exact: true })
    const inside = () => page.evaluate(() => Boolean(document.activeElement?.closest('.model-admin-login')))
    async function reset() {
      await page.evaluate(() => {
        document.hasFocus = window.adminFocusOriginalHasFocus
        window.adminFocusNextSurface = null
        const fixture = window.buttonLayoutFixture
        fixture.setSurface('club'); fixture.state.busy = false
      })
      await dialog.waitFor({ state: 'detached' })
    }
    async function open(configured, busy = false) {
      await reset()
      await page.evaluate(({ configured, busy }) => {
        const fixture = window.buttonLayoutFixture
        fixture.state.configured = configured; fixture.state.busy = busy
        document.querySelector('#admin-opener').focus()
      }, { configured, busy })
      await page.keyboard.press('Enter')
      await dialog.waitFor()
    }
    async function check(name, action) {
      try { await action(); results.push({ engine, name, status: 'PASS' }) }
      catch (error) {
        failures.push({ engine, name, message: error.message,
          active: await page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, name: document.activeElement?.getAttribute('name') })) })
        await page.screenshot({ path: path.join(artifacts, `${engine}-${name}-failure.png`), fullPage: true })
      } finally { await reset() }
    }

    await check('unconfigured-root-shift-tab', async () => {
      await open(false)
      assert.equal(await dialog.evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Shift+Tab')
      assert.equal(await dialog.getByRole('button', { name: 'Вернуться к библиотеке', exact: true }).evaluate(node => node === document.activeElement), true, 'First Shift+Tab must stay inside the unconfigured dialog')
      await page.keyboard.press('Tab')
      assert.equal(await close().evaluate(node => node === document.activeElement), true)
      for (let index = 0; index < 12; index++) { await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab'); assert.equal(await inside(), true) }
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    await check('busy-initial-focus-and-wrap', async () => {
      await open(true, true)
      assert.equal(await dialog.evaluate(node => node === document.activeElement), true, 'A disabled username must not leave initial focus in the background')
      await page.keyboard.press('Shift+Tab')
      assert.equal(await close().evaluate(node => node === document.activeElement), true)
      for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert.equal(await inside(), true) }
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    await check('normal-input-cycle-and-password-clear', async () => {
      await open(true)
      const username = dialog.locator('input[name="username"]'), password = dialog.locator('input[name="password"]')
      assert.equal(await username.evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Tab'); assert.equal(await password.evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Tab'); assert.equal(await close().evaluate(node => node === document.activeElement), true)
      await username.fill('fixture-admin'); await password.fill('fixture-only-password')
      await password.focus(); await page.keyboard.press('Tab')
      const submit = dialog.getByRole('button', { name: 'Войти в библиотеку', exact: true })
      assert.equal(await submit.evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Tab'); assert.equal(await close().evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Shift+Tab'); assert.equal(await submit.evaluate(node => node === document.activeElement), true)
      await page.keyboard.press('Enter')
      assert.equal(await password.inputValue(), '', 'Password is cleared on submit, before the event handler')
      assert.equal(await page.evaluate(() => window.buttonLayoutFixture.counters.events.filter(event => event === 'login-submit').length), 1)
      await close().click(); await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    await check('dynamic-busy-recovers-focus', async () => {
      await open(true)
      await page.evaluate(() => { window.buttonLayoutFixture.state.busy = true })
      await page.keyboard.press('Tab')
      assert.equal(await inside(), true, 'A newly disabled focused input must not break trapping')
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    await check('outside-focus-recovers-only-on-tab', async () => {
      await open(true)
      await page.evaluate(() => document.querySelector('#admin-background-other').focus())
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-background-other')
      await page.keyboard.press('Shift+Tab'); assert.equal(await inside(), true, 'Document capture recovers Tab after an outside focus change')
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    })
    await check('no-focus-steal-from-background-control', async () => {
      await open(true)
      await page.evaluate(() => { document.querySelector('#admin-background-other').focus(); window.buttonLayoutFixture.setSurface('club') })
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-background-other', 'Programmatic close must not steal external focus')
    })
    await check('background-window-close-guard', async () => {
      await open(true)
      await page.evaluate(() => { document.hasFocus = () => false; window.buttonLayoutFixture.setSurface('club') })
      await dialog.waitFor({ state: 'detached' })
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'admin-opener', 'Closing while the document is unfocused must not focus the opener')
    })
    await check('background-window-mount-guard', async () => {
      await reset()
      await page.evaluate(() => {
        const fixture = window.buttonLayoutFixture
        fixture.state.configured = true; fixture.state.busy = false
        document.querySelector('#admin-opener').focus()
        document.hasFocus = () => false
        fixture.setSurface('login')
      })
      await dialog.waitFor()
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener', 'Mounting in an unfocused document must not move focus')
    })
    await check('backdrop-close-returns-focus', async () => {
      await open(true)
      await page.locator('.model-admin-backdrop').click({ position: { x: 2, y: 2 } })
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    await check('replacement-dialog-keeps-focus', async () => {
      await open(true)
      await page.evaluate(() => { window.adminFocusNextSurface = 'settings' })
      await close().click(); await dialog.waitFor({ state: 'detached' })
      await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.club-settings-shell'))), true)
    })
    await check('disconnected-opener-safe-close', async () => {
      await open(true)
      await page.evaluate(() => document.querySelector('#admin-opener').remove())
      await close().click(); await dialog.waitFor({ state: 'detached' })
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'admin-opener')
    })
    assert.equal(await page.evaluate(() => window.adminFocusLockRequests), 0, 'Dialog never captures the system cursor')
    await browser.close(); browser = null
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(apiRequests, [])
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ results, failures, errors, apiRequests, simulatedForegroundGuard: true }, null, 2) + '\n')
  console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks: results.length + failures.length, failures, errors, apiRequests, artifacts }))
  if (failures.length) process.exitCode = 1
} finally { await browser?.close(); await server.close() }
