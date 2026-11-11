// Real Vue home/menu layout regression. No API, game or administrator writes.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/home-viewport')
const viewports = [[1920, 1080], [1440, 900], [1366, 768], [1280, 720],
  [1024, 600], [800, 600], [390, 844], [375, 667], [320, 568], [320, 480],
  [844, 390], [667, 375], [568, 320], [680, 384]]
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
const results = [], failures = []
await mkdir(artifacts, { recursive: true })

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function layout(page) {
  return page.evaluate(() => {
    const rect = node => {
      const box = node.getBoundingClientRect()
      return { name: node.className || node.tagName, text: node.textContent.trim().replace(/\s+/g, ' '),
        x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
    }
    const shell = document.querySelector('.club-shell[data-club-view="menu"]')
    const scroll = [document.documentElement, document.body, shell, shell.querySelector('.club-content'),
      shell.querySelector('.club-main-menu'), shell.querySelector('.club-actions')].map(node => ({
      name: node.className || node.tagName, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
      scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
    }))
    const items = [...shell.querySelectorAll('.club-header, .club-game-title, .club-main-menu > nav, .club-main-menu > p, .club-main-menu > button, .club-footer')].map(rect)
    const buttons = [...shell.querySelectorAll('.club-main-menu button')].map(button => {
      const box = rect(button)
      const ranges = [...button.querySelectorAll('span')].flatMap(span => {
        const range = document.createRange(); range.selectNodeContents(span)
        return [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }))
      })
      return { ...box, ranges, mainAction: Boolean(button.closest('nav[aria-label="Главное меню"]')),
        disabled: button.disabled, scrollWidth: button.scrollWidth,
        clientWidth: button.clientWidth, scrollHeight: button.scrollHeight, clientHeight: button.clientHeight }
    })
    const header = [...shell.querySelector('.club-header').children].map(rect)
    const footerParts = [...shell.querySelector('.club-footer').children].map(rect)
    return { width: innerWidth, height: innerHeight, scroll, items, buttons, header, footerParts,
      connectedFooters: shell.querySelectorAll('.club-footer .club-connection').length }
  })
}

function assertFits(value, label) {
  assert.ok(value.scroll.every(item => item.scrollHeight <= item.clientHeight + 1
    && item.scrollWidth <= item.clientWidth + 1), `${label}: actual overflow ${JSON.stringify(value.scroll)}`)
  for (const item of [...value.items, ...value.buttons, ...value.header, ...value.footerParts]) {
    assert.ok(item.width > 0 && item.height > 0 && item.x >= -.5 && item.y >= -.5
      && item.right <= value.width + .5 && item.bottom <= value.height + .5,
    `${label}: outside viewport ${JSON.stringify(item)}`)
  }
  for (let first = 0; first < value.items.length; first++) {
    for (let second = first + 1; second < value.items.length; second++) {
      const a = value.items[first], b = value.items[second]
      const width = Math.min(a.right, b.right) - Math.max(a.x, b.x)
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y)
      assert.ok(width <= .5 || height <= .5, `${label}: overlapping content ${JSON.stringify([a, b])}`)
    }
  }
  const [brand, account] = value.header
  assert.ok(brand.right <= account.x + .5 || brand.bottom <= account.y + .5,
    `${label}: overlapping header controls`)
  for (let first = 0; first < value.footerParts.length; first++) {
    for (let second = first + 1; second < value.footerParts.length; second++) {
      const a = value.footerParts[first], b = value.footerParts[second]
      assert.ok(Math.min(a.right, b.right) - Math.max(a.x, b.x) <= .5
        || Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) <= .5,
      `${label}: overlapping footer metadata/status ${JSON.stringify([a, b])}`)
    }
  }
  for (const button of value.buttons) {
    if (button.mainAction) assert.equal(button.ranges.length, 1,
      `${label}: each short main action label must stay on one line: ${JSON.stringify(button)}`)
    assert.ok(button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1,
      `${label}: clipped control ${JSON.stringify(button)}`)
    for (const text of button.ranges) assert.ok(text.left >= button.x - .5 && text.right <= button.right + .5
      && text.top >= button.y - .5 && text.bottom <= button.bottom + .5, `${label}: clipped label ${JSON.stringify(button)}`)
  }
}

async function check(page, name, callback) {
  try { const value = await callback(); results.push({ name, status: 'PASS', ...(value ? { value } : {}) }) }
  catch (error) {
    failures.push({ name, message: error.message })
    if (failures.length <= 6) await page.screenshot({ path: path.join(artifacts, `${name.replace(/[^a-z0-9_-]/gi, '_')}-failure.png`) })
  }
}

try {
  await server.listen()
  for (const engine of engines) {
    const browser = await playwright[engine].launch({ headless: true })
    try {
      const page = await browser.newPage(), errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${server.resolvedUrls.local[0]}tests/club-menu-fixture.html`)
      await page.locator('.club-main-menu').waitFor()
      for (const [width, height] of viewports) {
        const name = `${engine}-${width}x${height}`
        await check(page, name, async () => {
          await page.setViewportSize({ width, height }); await settle(page)
          const value = await layout(page); assertFits(value, name)
          assert.equal(value.connectedFooters, 0, 'Do not render the healthy connection footer')
          assert.equal(await page.getByText('Соединение установлено', { exact: true }).count(), 0)
          assert.equal(await page.locator('.club-main-menu nav button').count(), 4)
          if ((width === 320 && height === 480) || width === 1366) {
            const visited = new Set()
            await page.locator('.club-brand').focus()
            for (let step = 0; step < 10; step++) {
              await page.keyboard.press('Tab')
              const action = await page.evaluate(() => document.activeElement?.closest('.club-main-menu nav button')?.textContent.trim())
              if (action) visited.add(action)
              assertFits(await layout(page), `${name} keyboard focus`)
            }
            assert.equal(visited.size, 4, 'All four home actions must remain in the real Tab sequence')
          }
          if ([[1366, 768], [320, 480], [568, 320]].some(([w, h]) => width === w && height === h))
            await page.screenshot({ path: path.join(artifacts, `${name}.png`) })
          return { scroll: value.scroll, buttonBounds: value.buttons, viewport: [width, height] }
        })
      }
      await check(page, `${engine}-old-minimum-negative-control`, async () => {
        await page.setViewportSize({ width: 1280, height: 720 })
        const style = await page.addStyleTag({ content: '.club-shell[data-club-view="menu"] .club-content { min-height:706px!important; flex-shrink:0!important; }' })
        try {
          await settle(page)
          const value = await layout(page)
          assert.throws(() => assertFits(value, 'old minimum'), /actual overflow|outside viewport|overlapping content/)
        } finally { await style.evaluate(node => node.remove()) }
      })
      for (const [width, height] of [[320, 480], [844, 390]]) {
        for (const mode of ['offline', 'resume', 'room']) {
          const name = `${engine}-${width}x${height}-${mode}`
          await check(page, name, async () => {
            await page.setViewportSize({ width, height })
            await page.evaluate(mode => {
              const state = window.clubFixture
              state.connected = mode !== 'offline'; state.matchAvailable = mode === 'resume'
              state.connection = mode === 'offline' ? 'Подключение потеряно' : 'Соединение установлено'
              state.room = mode === 'room' ? { id: 'fixture-room', code: 'ABC123', players: [] } : null
            }, mode)
            await settle(page); const value = await layout(page); assertFits(value, name)
            if (mode === 'offline') {
              const status = page.locator('.club-footer .club-connection-offline')
              assert.equal(await status.isVisible(), true)
              assert.equal(await status.textContent(), 'Подключение потеряно')
              assert.equal(await page.getByText('Соединение установлено', { exact: true }).count(), 0)
              const box = await status.boundingBox()
              assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + .5 && box.y + box.height <= height + .5)
            } else assert.equal(value.connectedFooters, 0)
          })
        }
      }
      await page.evaluate(() => { Object.assign(window.clubFixture, { connected: true, matchAvailable: false, room: null, view: 'profile' }) })
      await check(page, `${engine}-profile-remains-scrollable`, async () => {
        await page.setViewportSize({ width: 390, height: 568 }); await settle(page)
        assert.equal(await page.locator('.club-shell .club-content').evaluate(node => node.scrollHeight > node.clientHeight + 10), true)
        const save = page.getByRole('button', { name: 'Сохранить профиль', exact: true })
        await save.scrollIntoViewIfNeeded(); const box = await save.boundingBox()
        assert.ok(box.y >= 0 && box.y + box.height <= 568 + .5)
        await page.getByLabel('Имя игрока', { exact: true }).fill('ИгрокСОченьДлиннымИменем1234567890'.slice(0, 32))
        await save.click()
      })
      await page.getByRole('button', { name: 'Назад', exact: true }).click()
      for (const [width, height] of [[320, 480], [568, 320]]) {
        await check(page, `${engine}-${width}x${height}-long-name`, async () => {
          await page.setViewportSize({ width, height }); await settle(page)
          assert.ok((await page.locator('.club-account-text > span').textContent()).length >= 30)
          assertFits(await layout(page), 'long profile name')
        })
      }
      await page.setViewportSize({ width: 390, height: 568 })
      await page.getByRole('button', { name: 'Играть', exact: true }).click()
      await check(page, `${engine}-play-choices-remain-reachable`, async () => {
        const buttons = page.locator('.club-section .club-actions > button')
        assert.equal(await buttons.count(), 6)
        for (const button of await buttons.all()) {
          await button.scrollIntoViewIfNeeded(); const box = await button.boundingBox()
          assert.ok(box.y >= 0 && box.y + box.height <= 568 + .5)
        }
      })
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  }
} finally {
  await server.close()
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks: results.length, results, failures }, null, 2))
}
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', checks: results.length, failures, artifacts }))
if (failures.length) process.exitCode = 1
