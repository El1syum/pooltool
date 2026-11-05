// Visual component test only: real Vue HUD + original Figma vector, no fake game.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'

const moduleUrl = value => path.isAbsolute(value) ? pathToFileURL(value).href : value
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'))
const { PNG } = await import(moduleUrl(process.env.PNG_MODULE || 'pngjs'))
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/power-gauges')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4314, strictPort: true } })
let browser
try {
  await server.listen()
  const Hud = (await server.ssrLoadModule('/src/components/MatchHud.vue')).default
  const engine = process.env.BROWSER || 'chromium'
  browser = await playwright[engine].launch({ headless: true })
  // The native Figma slots contain fractional CSS pixels. A 2× raster reduces
  // asymmetric edge quantization between the 180°-rotated and native copies.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let fraction = 0
  await page.route('**/gauge-fixture', async route => {
    const props = {
      match: { id: 'component-fixture', status: 'active', revision: 0, currentPlayer: 0,
        players: [{ id: 'a', displayName: 'Alex Chen' }, { id: 'b', displayName: 'Morgan Reed' }],
        snapshot: { groups: [null, null], balls: [], table: { width: 1.27, length: 2.54, pockets: [] } } },
      user: { id: 'a' }, room: { code: 'ABC123' }, aim: { phi: 90, V0: fraction * 8, theta: 15, a: 0, b: 0 },
      phase: 'power', showAssist: false, canShoot: true, canPlace: false, canReposition: false, placingCue: false,
      connected: true, connection: '', remaining: 24, elapsed: 0, statusText: 'Ваш ход',
      volume: 0.5, topViewKey: 'KeyT', calledBall: '', calledPocket: '', cameraMode: 'cue',
    }
    const html = await renderToString(createSSRApp(Hud, props))
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/style.css?direct"><link rel="stylesheet" href="/src/match-hud.css?direct"><link rel="stylesheet" href="/src/match-design.css?direct"></head><body style="margin:0;background:#102125"><main style="position:relative;width:100vw;height:100vh">${html}</main></body></html>` })
  })
  const counts = []
  for (fraction of [0, 0.25, 0.5, 1]) {
    await page.goto('http://127.0.0.1:4314/gauge-fixture')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForFunction(() => [...document.querySelectorAll('.hud-power-gauge use')].length === 2
      && [...document.querySelectorAll('.hud-power-gauge use')].every(use => use.getBBox().width > 140))
    assert.equal(await page.getByTestId('alt-assist').count(), 0, 'The base power HUD must work without enabling assist cards')
    const gauges = page.getByRole('meter')
    const areas = []
    for (let index = 0; index < 2; index++) {
      assert.equal(await gauges.nth(index).getAttribute('aria-valuenow'), String(fraction * (index ? 8 : 100)))
      const png = PNG.sync.read(await gauges.nth(index).screenshot())
      let gold = 0
      for (let offset = 0; offset < png.data.length; offset += 4) {
        const [r, g, b, a] = png.data.subarray(offset, offset + 4)
        if (Math.abs(r - 199) < 3 && Math.abs(g - 170) < 3 && Math.abs(b - 114) < 3 && a > 225) gold++
      }
      areas.push(gold)
    }
    if (fraction === 0) assert.ok(areas.every(value => value < 10), `Zero force must have no gold fill: ${areas}`)
    else assert.ok(areas.every((value, index) => value > counts.at(-1).areas[index] + 20), `Fill must grow with force: ${JSON.stringify({ fraction, areas, counts })}`)
    assert.ok(Math.abs(areas[0] - areas[1]) < Math.max(20, areas[0] * 0.03), `Both units must visualize the same speed: ${JSON.stringify({ fraction, areas, counts })}`)
    counts.push({ fraction, areas })
    await page.screenshot({ path: path.join(artifacts, `${engine}-${fraction * 100}.png`) })
  }
  const geometry = await page.locator('.hud-target, .hud-percent-wedge, .hud-speed-wedge').evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect()
    return { className: node.getAttribute('class'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }))
  for (const gauge of geometry.slice(1)) {
    assert.ok(Math.abs(gauge.width - 149.714) < 0.75 && Math.abs(gauge.height - 82.589) < 0.75,
      `Latest Figma gauge slot must retain its 149.714 × 82.589 geometry: ${JSON.stringify(gauge)}`)
  }
  assert.ok(Math.abs(geometry[1].x - geometry[0].x + 77) < 1 && Math.abs(geometry[1].y - geometry[0].y - 181) < 1,
    `Percent gauge must use the latest Figma base-power offset (-77,181): ${JSON.stringify(geometry)}`)
  assert.ok(Math.abs(geometry[2].x - geometry[0].x - 242.786) < 1 && Math.abs(geometry[2].y - geometry[0].y - 45) < 1,
    `Speed gauge must use the latest Figma base-power offset (242.786,45): ${JSON.stringify(geometry)}`)
  assert.ok(geometry[1].x < geometry[0].x + geometry[0].width / 2 && geometry[2].x > geometry[0].x + geometry[0].width / 2,
    `The percent and speed indicators must flank the cue reticle: ${JSON.stringify(geometry)}`)
  for (const viewport of [{ width: 640, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport)
    const bounds = await page.locator('.hud-power-gauge, .hud-power-number, .hud-speed-number').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }))
    assert.ok(bounds.every(rect => rect.left >= 0 && rect.right <= viewport.width && rect.top >= 0 && rect.bottom <= viewport.height), `Gauges and units must fit ${JSON.stringify(viewport)}: ${JSON.stringify(bounds)}`)
    await page.screenshot({ path: path.join(artifacts, `${engine}-${viewport.width}x${viewport.height}.png`) })
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, counts, geometry, tests: 'base power gauges without the assist key, original external SVG, increasing real pixel fill, percent/speed agreement, latest Figma slots', jsErrors: errors.length }))
} finally {
  await browser?.close()
  await server.close()
}
