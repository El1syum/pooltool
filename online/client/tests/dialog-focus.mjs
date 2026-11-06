// Component-only accessibility regression. Real Vue dialog, production CSS;
// does not simulate physics or create any network identity/room.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/dialog-focus')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
const results = [], errors = []
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
    browser = await playwright[engine].launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 844, height: 390 } })
    page.on('pageerror', error => errors.push({ engine, message: error.message }))
    await page.goto(`http://127.0.0.1:${address.port}/tests/dialog-focus.fixture.html`)
    await page.locator('#opener').click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'dialog', 'Initial focus belongs to the dialog, not a destructive action')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'close', 'First Shift+Tab must wrap inside from the dialog root')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'replace', 'Forward Tab wraps to the first control')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'close')
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[aria-modal="true"]'))), true, 'Tab cannot reach background controls')
    }
    await page.evaluate(() => document.querySelector('#background').focus())
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'background', 'Background content is inert while modal')
    await page.locator('#next').focus()
    await page.evaluate(() => window.disableNextControl(true))
    await page.waitForFunction(() => document.querySelector('#next').disabled)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'replace', 'A newly disabled focused control recovers to the eligible dialog cycle')
    await page.evaluate(() => window.disableNextControl(false))
    await page.locator('#replace').click()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[aria-modal="true"]'))), true, 'Removed focused controls do not break trapping')
    await page.screenshot({ path: path.join(artifacts, `${engine}-dialog.png`) })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'opener', 'Closing returns focus to the opener')
    assert.equal(await page.evaluate(() => document.querySelector('main').inert), false)
    assert.equal(await page.evaluate(() => document.querySelector('#already-inert').inert), true, 'Pre-existing inert state survives close')
    await page.evaluate(() => window.resetDialogContents())
    await page.locator('#opener').click()
    await page.locator('#replace').click()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'opener', 'Removing the focused control then Escape returns focus without needing an extra Tab')
    await page.evaluate(() => window.claimFocusOnClose(true))
    await page.locator('#opener').click()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'background', 'A parent claiming focus on close keeps ownership over deferred restoration')
    await page.evaluate(() => window.claimFocusOnClose(false))
    await page.locator('#opener').click()
    await page.locator('#next').click()
    await page.getByRole('dialog', { name: 'Правила', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-labelledby')), 'next-title', 'Closing the old dialog cannot steal focus from the next')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'next-close')
    await page.locator('#next-close').click()
    assert.equal(await page.evaluate(() => document.querySelector('main').inert), false, 'Transition restores background inert state')
    await page.locator('#opener').click()
    await page.locator('.modal-backdrop').click({ position: { x: 2, y: 2 } })
    await page.getByRole('dialog').waitFor({ state: 'detached' })
    results.push({ engine, status: 'PASS', checks: ['initial-root', 'first-shift-tab', 'forward-wrap', 'reverse-wrap', 'tab-cycle', 'inert-background', 'disabled-focused-control', 'dynamic-contents', 'escape', 'focus-return', 'removed-focus-escape', 'parent-focus-claim', 'preserved-inert', 'dialog-transition', 'backdrop-close'] })
    await browser.close(); browser = null
  }
  assert.deepEqual(errors, [])
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ results, errors }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', results, errors }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
