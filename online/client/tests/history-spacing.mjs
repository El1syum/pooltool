import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/history-spacing')
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
const results = []
await mkdir(artifacts, { recursive: true })

async function measure(page) {
  return page.locator('.club-history').evaluate(list => {
    list.scrollLeft = list.scrollWidth
    const rect = list.getBoundingClientRect()
    const right = rect.left + list.clientLeft + list.clientWidth
    const cells = [...list.querySelectorAll('.club-history-elo')].map(cell => {
      const range = document.createRange()
      range.selectNodeContents(cell)
      return { text: cell.textContent, gap: right - range.getBoundingClientRect().right }
    })
    return { width: innerWidth, clientWidth: list.clientWidth, scrollWidth: list.scrollWidth,
      scrollLeft: list.scrollLeft, gutter: list.offsetWidth - list.clientWidth,
      verticalOverflow: list.scrollHeight > list.clientHeight,
      bodyWidth: document.documentElement.scrollWidth, cells }
  })
}

try {
  await server.listen()
  const base = server.resolvedUrls.local[0]
  for (const engine of engines) {
    const browser = await playwright[engine].launch({ headless: true })
    try {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}tests/club-menu-fixture.html`)
      await page.evaluate(() => {
        window.clubFixture.history = Array.from({ length: 24 }, (_, index) => ({
          id: `spacing-${index}`, startedAt: '2026-11-05T16:44:13Z',
          opponentName: index % 2 ? 'Бот (средний)' : 'Лукьян',
          mode: index % 2 ? 'casual' : 'ranked',
          winnerId: index % 3 ? 'fixture-player' : 'opponent',
          eloDelta: index % 2 ? null : index % 3 ? 16 : -16,
        }))
        window.clubFixture.view = 'profile'
      })
      await page.locator('.club-history li').last().waitFor({ state: 'attached' })
      await page.evaluate(() => document.fonts.ready)
      for (const width of [1440, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 })
        for (const scrollbar of ['native', '16px']) {
          const barStyle = scrollbar === '16px' ? await page.addStyleTag({ content:
            '.club-history::-webkit-scrollbar { width:16px; height:16px; }' }) : null
          try {
            // Both the original and the previous 12px gap must fail this gate.
            for (const previousGap of [0, 12]) {
              const oldStyle = await page.addStyleTag({ content: `.club-history-elo { padding-inline-end:${previousGap}px!important; }` })
              const before = await measure(page)
              assert.ok(before.cells.some(cell => cell.gap < 23.5), `${previousGap}px negative control must detect insufficient spacing`)
              await oldStyle.evaluate(node => node.remove())
            }
            const after = await measure(page)
            assert.equal(after.cells.length, 24)
            assert.ok(after.verticalOverflow, 'actual overflowing history is required')
            assert.ok(after.bodyWidth <= width + 1, 'no document-level horizontal overflow')
            assert.ok(after.cells.every(cell => cell.gap >= 23.5), JSON.stringify(after))
            if (width <= 390) assert.ok(after.scrollLeft > 0, 'test the actual horizontal right edge on mobile')
            results.push({ engine, width, scrollbar, minimumTextGap: Math.min(...after.cells.map(cell => cell.gap)),
              gutter: after.gutter, horizontalScroll: after.scrollLeft, status: 'PASS' })
            if ([1440, 390].includes(width)) {
              await page.locator('.club-history').scrollIntoViewIfNeeded()
              await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-${scrollbar}.png`) })
            }
          } finally { if (barStyle) await barStyle.evaluate(node => node.remove()) }
        }
      }
      assert.deepEqual(errors, [])
    } finally { await browser.close() }
  }
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ checks: results.length, results }, null, 2))
  console.log(JSON.stringify({ checks: results.length, status: 'PASS', artifacts }))
} finally { await server.close() }
