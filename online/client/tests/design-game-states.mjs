// Visual component regression only: actual Vue MatchHud and original Figma
// assets with the production CSS stack. There is no physics or backend fixture.
// Real gameplay remains covered separately by match-hud.mjs / shot-workflow.mjs.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const moduleUrl = value => path.isAbsolute(value) ? pathToFileURL(value).href : value
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'))
const { PNG } = await import(moduleUrl(process.env.PNG_MODULE || 'pngjs'))
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/design-game-states')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4338, strictPort: true } })
const viewports = [
  { width: 1920, height: 1080 }, { width: 1440, height: 900 },
  { width: 1280, height: 800 }, { width: 926, height: 728 },
  { width: 390, height: 844 }, { width: 320, height: 640 },
  { width: 1280, height: 540 },
]
const states = [
  { name: 'general', phase: 'overview', cameraMode: 'free', showAssist: false, cards: 0, scorecards: 2 },
  { name: 'direction', phase: 'overview', cameraMode: 'cue', showAssist: false, cards: 0, scorecards: 0 },
  { name: 'contact', phase: 'aim', cameraMode: 'cue', showAssist: false, cards: 0, scorecards: 0 },
  { name: 'contact-assist', phase: 'aim', cameraMode: 'cue', showAssist: true, cards: 1, scorecards: 0 },
  { name: 'power', phase: 'power', cameraMode: 'cue', showAssist: false, cards: 0, scorecards: 0 },
  { name: 'power-assist', phase: 'power', cameraMode: 'cue', showAssist: true, cards: 3, scorecards: 0 },
]
const intrinsicSizes = new Map()
async function intrinsicRatio(asset) {
  if (!asset.source.endsWith('.svg')) return asset.naturalWidth / asset.naturalHeight
  if (!intrinsicSizes.has(asset.source)) {
    const content = await readFile(path.resolve('public', `.${asset.source}`), 'utf8')
    const root = content.match(/<svg\b[^>]*>/)?.[0] || ''
    const width = Number.parseFloat(root.match(/\bwidth="([^"]+)"/)?.[1] || '')
    const height = Number.parseFloat(root.match(/\bheight="([^"]+)"/)?.[1] || '')
    assert.ok(width > 0 && height > 0, `Original SVG dimensions required: ${asset.source}`)
    intrinsicSizes.set(asset.source, width / height)
  }
  return intrinsicSizes.get(asset.source)
}
let browser
try {
  await server.listen()
  for (const engine of engines) {
    browser = await playwright[engine].launch({ headless: true })
    const page = await browser.newPage({ viewport: viewports[0] })
    const errors = [], failedAssets = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (/\.(svg|png|webp|woff2?|ttf|css)(?:\?|$)/.test(response.url()) && response.status() >= 400) failedAssets.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    await page.goto('http://127.0.0.1:4338/tests/match-assist-fixture.html')
    await page.waitForFunction(() => window.fixtureReady)
    await page.evaluate(async () => {
      const s = window.assistFixture
      s.match.snapshot.groups = ['solids', 'stripes']
      s.match.snapshot.balls = Array.from({ length: 15 }, (_, i) => ({ id: String(i + 1), position: [0, 0, .03], pocketed: [1, 3, 4, 7, 9, 12, 15].includes(i + 1) }))
      s.aim = { phi: 90, V0: 2.4, theta: 12, a: .25, b: -.2 }
      await document.fonts.ready
    })
    const layouts = []
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      for (const state of states) {
        await page.evaluate(({ phase, cameraMode, showAssist }) => Object.assign(window.assistFixture, { phase, cameraMode, showAssist }), state)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const label = `${engine} ${viewport.width}×${viewport.height} ${state.name}`
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="match-hud"] img')].every(img => img.complete && img.naturalWidth > 0))
        assert.equal(await page.locator('.hud-player:visible').count(), state.scorecards, `${label}: scorecard visibility`)
        assert.equal(await page.locator('.assist-card:visible').count(), state.cards, `${label}: side cards remain explicitly modifier-only`)
        assert.equal(await page.getByRole('meter').count(), state.phase === 'power' ? 2 : 0, `${label}: power meters do not depend on the help modifier`)
        if (state.name === 'general') {
          assert.equal(await page.locator('.hud-stage-instruction').isVisible(), true, `${label}: general-view stage instructions`)
          assert.equal(await page.getByText('Яркие — на столе', { exact: true }).isVisible(), true, `${label}: ball legend`)
          assert.equal(await page.getByText('Приглушённые — забиты', { exact: true }).isVisible(), true, `${label}: ball legend`)
        }
        if (state.name === 'direction') {
          assert.equal(await page.locator('img[src$="direction-arrow.svg"]').isVisible(), true, `${label}: horizontal direction guide`)
        }
        if (state.phase === 'aim') {
          assert.equal(await page.locator('img[src$="contact-ring.svg"]').isVisible(), true, `${label}: original contact ring`)
          assert.equal(await page.locator('img[src$="contact-reticle.svg"]').isVisible(), true, `${label}: original contact reticle`)
          if (state.showAssist && viewport.width > 760) assert.equal(await page.locator('img[src$="contact-leader.svg"]').isVisible(), true, `${label}: assisted contact annotation leader`)
        }
        const geometry = await page.evaluate(() => {
          const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
          const rect = node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
          }
          const root = document.querySelector('[data-testid="match-hud"]')
          return {
            overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
            controls: [...root.querySelectorAll('button')].filter(visible).map(node => ({ name: node.getAttribute('aria-label') || node.textContent.trim(), ...rect(node) })),
            assets: [...root.querySelectorAll('img')].filter(visible).map(node => ({ name: node.src.split('/').pop(), source: new URL(node.src).pathname, naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight, ...rect(node) })),
            cards: [...root.querySelectorAll('.assist-card')].filter(visible).map(node => ({ name: node.getAttribute('aria-label'), ...rect(node) })),
            scorecards: [...root.querySelectorAll('.hud-player')].filter(visible).map(rect),
            clock: rect(root.querySelector('.hud-clock')),
            header: rect(root.querySelector('.hud-identity')),
            menu: rect(root.querySelector('.hud-match-menu')),
            target: root.querySelector('.hud-contact-reticle, .hud-power-reticle') ? rect(root.querySelector('.hud-contact-reticle, .hud-power-reticle')) : null,
            stage: root.querySelector('.hud-stage-instruction') ? rect(root.querySelector('.hud-stage-instruction')) : null,
          }
        })
        await page.screenshot({ path: path.join(artifacts, `${engine}-${viewport.width}x${viewport.height}-${state.name}.png`) })
        assert.equal(geometry.overflow, false, `${label}: no page overflow`)
        const inside = r => r.x >= -1 && r.y >= -1 && r.right <= viewport.width + 1 && r.bottom <= viewport.height + 1
        assert.ok(geometry.controls.every(inside), `${label}: all visible controls must fit: ${JSON.stringify(geometry.controls.filter(r => !inside(r)))}`)
        assert.ok(geometry.cards.every(inside), `${label}: side panels must fit: ${JSON.stringify(geometry.cards)}`)
        for (const asset of geometry.assets) {
          assert.ok(asset.naturalWidth > 0 && asset.naturalHeight > 0 && asset.width > 0 && asset.height > 0, `${label}: nonempty original asset ${asset.name}`)
          const naturalRatio = await intrinsicRatio(asset)
          assert.ok(Math.abs(asset.width / asset.height - naturalRatio) < .12, `${label}: original asset proportions ${asset.name}: ${JSON.stringify(asset)}`)
        }
        const intersects = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1
        assert.equal(intersects(geometry.clock, geometry.header), false, `${label}: clock must not cover club identity`)
        for (let i = 0; i < geometry.cards.length; i++) for (let j = i + 1; j < geometry.cards.length; j++) {
          assert.equal(intersects(geometry.cards[i], geometry.cards[j]), false, `${label}: side cards must not overlap each other: ${JSON.stringify([geometry.cards[i], geometry.cards[j]])}`)
        }
        if (geometry.target) {
          const center = { x: geometry.target.x + geometry.target.width / 2, y: geometry.target.y + geometry.target.height / 2 }
          const contactCore = { x: center.x - 24, right: center.x + 24, y: center.y - 24, bottom: center.y + 24 }
          assert.equal(geometry.cards.some(card => intersects(card, contactCore)), false, `${label}: side cards must not cover the central contact target: ${JSON.stringify({ cards: geometry.cards, contactCore })}`)
        }
        if (viewport.width === 1920 && state.name === 'general') {
          const close = (value, expected) => Math.abs(value - expected) <= 1
          assert.ok(close(geometry.header.x, 40) && close(geometry.header.y, 36), `${label}: Figma club-identity slot`)
          assert.ok(close(geometry.menu.x, 1700) && close(geometry.menu.y, 36) && close(geometry.menu.width, 180) && close(geometry.menu.height, 44), `${label}: Figma menu slot`)
          assert.ok(geometry.scorecards.every(card => close(card.width, 500) && close(card.height, 130) && close(card.y, 26)), `${label}: Figma player-card slots: ${JSON.stringify(geometry.scorecards)}`)
          assert.ok(geometry.stage && close(geometry.stage.x, 40) && close(geometry.stage.y, 220) && close(geometry.stage.width, 320), `${label}: Figma general stage slot`)
        }
        if (state.phase === 'power') {
          await page.waitForFunction(() => [...document.querySelectorAll('.hud-power-gauge use')].every(node => node.getBBox().width > node.ownerSVGElement.viewBox.baseVal.width * .9))
          const meters = await page.getByRole('meter').evaluateAll(nodes => nodes.map(node => {
            const r = node.getBoundingClientRect()
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
          }))
          assert.ok(meters.every(inside), `${label}: both vector meters must fit: ${JSON.stringify(meters)}`)
        }
        layouts.push({ viewport, state: state.name, visibleAssets: geometry.assets.length, cards: geometry.cards.length })
      }
    }

    // Exercise actual modern CSS with the help modifier OFF; the former test loaded
    // only match-hud.css and could not detect the production visibility defect.
    await page.setViewportSize(viewports[0])
    await page.evaluate(() => Object.assign(window.assistFixture, { phase: 'power', cameraMode: 'cue', showAssist: false }))
    const fills = []
    for (const fraction of [.025, .25, .5, 1]) {
      await page.evaluate(value => { window.assistFixture.aim.V0 = value * 8 }, fraction)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const areas = []
      for (const meter of await page.getByRole('meter').all()) {
        const png = PNG.sync.read(await meter.screenshot())
        let gold = 0
        for (let i = 0; i < png.data.length; i += 4) {
          const [r, g, b, a] = png.data.subarray(i, i + 4)
          if (Math.abs(r - 199) <= 3 && Math.abs(g - 170) <= 3 && Math.abs(b - 114) <= 3 && a > 225) gold++
        }
        areas.push(gold)
      }
      if (fills.length) assert.ok(areas.every((area, i) => area > fills.at(-1).areas[i] + 15), `${engine}: both visible modern-CSS fills grow with speed: ${JSON.stringify({ fraction, areas, fills })}`)
      fills.push({ fraction, areas })
    }
    for (const scenario of ['spectator', 'opponent', 'placement', 'finished']) {
      await page.evaluate(kind => {
        const s = window.assistFixture
        Object.assign(s, { phase: 'overview', cameraMode: 'cue', showAssist: true, canShoot: false, canPlace: kind === 'placement', user: { id: kind === 'spectator' ? 'observer' : 'a' } })
        s.match.currentPlayer = kind === 'opponent' ? 1 : 0
        s.match.status = kind === 'finished' ? 'finished' : 'active'
      }, scenario)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
      assert.equal(await page.locator('.assist-card').count(), 0, `${engine} ${scenario}: the help modifier must not show editable local-shot instruments`)
      assert.equal(await page.locator('.hud-target').count(), 0, `${engine} ${scenario}: no local aiming target`)
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(failedAssets, [])
    console.log(JSON.stringify({ engine, componentOnly: true, realVue: true, productionCss: true, states: states.length, layouts, fillsWithoutModifier: fills, inactiveStateGuards: true, jsErrors: errors.length, failedAssets: failedAssets.length }))
    await browser.close(); browser = null
  }
} finally {
  await browser?.close()
  await server.close()
}
