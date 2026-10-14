import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = process.env.POOLTOOL_URL || 'http://127.0.0.1:8790'
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts')
await mkdir(artifacts, { recursive: true })

async function api(endpoint, token, body = {}, method = 'POST') {
  const response = await fetch(base + endpoint, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  assert.ok(response.ok, `API ${endpoint}: ${response.status}`)
  return result
}

for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const engine = playwright[engineName]
  const suffix = String(Date.now()).slice(-8)
  const first = await api('/api/auth/guest', '', { displayName: `Frame-${engineName}-${suffix}`, clientVersion: 'browser-qa' })
  const second = await api('/api/auth/guest', '', { displayName: `FG-${engineName}-${suffix}`, clientVersion: 'browser-qa' })
  const { room } = await api('/api/rooms', first.token, { settings: { turnSeconds: 120, ranked: false }, clientVersion: 'browser-qa' })
  await api(`/api/rooms/${room.code}/join`, second.token)
  await api(`/api/rooms/${room.code}/ready`, first.token, { ready: true })
  await api(`/api/rooms/${room.code}/ready`, second.token, { ready: true })
  const browser = await engine.launch({ headless: true,
    ...(process.env[`${engineName.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`${engineName.toUpperCase()}_EXECUTABLE`] } : {}),
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
    await context.addInitScript(token => localStorage.setItem('pooltool.token', token), first.token)
    if (process.env.MOBILE_DEBUG) await context.addInitScript(() => {
      window.__qaDraws = 0
      const draw = WebGL2RenderingContext.prototype.drawElements
      WebGL2RenderingContext.prototype.drawElements = function (...args) {
        window.__qaDraws++
        const result = draw.apply(this, args)
        if (this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
          const pixel = new Uint8Array(4)
          this.readPixels(Math.floor(this.drawingBufferWidth / 2), Math.floor(this.drawingBufferHeight / 2), 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel)
          window.__qaPixel = Array.from(pixel)
        }
        return result
      }
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(base)
    await page.locator('.game-stage canvas').waitFor({ timeout: 30_000 })
    await page.getByRole('status').filter({ hasText: 'Соединение установлено' }).waitFor()
    await page.bringToFront()
    await page.screenshot({ path: path.join(artifacts, `${engineName}-mobile-framed.png`), fullPage: true })
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, body: document.documentElement.scrollWidth, canvas: document.querySelector('canvas').getBoundingClientRect().toJSON() }))
    if (process.env.MOBILE_DEBUG) console.log(await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2')
      return { phase: 'portrait', visibility: document.visibilityState, draws: window.__qaDraws, pixel: window.__qaPixel, glError: gl.getError(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], viewport: Array.from(gl.getParameter(gl.VIEWPORT)), lost: gl.isContextLost() }
    }))
    assert.ok(dimensions.body <= dimensions.viewport + 1)
    await page.bringToFront()
    await page.setViewportSize({ width: 844, height: 390 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.locator('.game-stage canvas').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(artifacts, `${engineName}-mobile-landscape.png`), fullPage: true })
    if (process.env.MOBILE_DEBUG) console.log(await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2')
      return { phase: 'landscape', visibility: document.visibilityState, draws: window.__qaDraws, pixel: window.__qaPixel, glError: gl.getError(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], viewport: Array.from(gl.getParameter(gl.VIEWPORT)), lost: gl.isContextLost() }
    }))
    await page.bringToFront()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.locator('.game-stage canvas').waitFor({ state: 'visible' })
    await page.screenshot({ path: path.join(artifacts, `${engineName}-mobile-resized.png`), fullPage: true })
    if (process.env.MOBILE_DEBUG) console.log(await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2')
      return { phase: 'portrait-restored', visibility: document.visibilityState, draws: window.__qaDraws, pixel: window.__qaPixel, glError: gl.getError(), buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], viewport: Array.from(gl.getParameter(gl.VIEWPORT)), lost: gl.isContextLost() }
    }))
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine: engineName, mobileFraming: true, resizeRoundtrip: true, jsErrors: errors.length, dimensions }))
  } finally {
    await browser.close()
    const current = await api('/api/me/current', first.token, {}, 'GET')
    await api(`/api/matches/${current.match.id}/commands`, first.token, { commandId: `framing-finish-${Date.now()}`, expectedRevision: current.match.revision, type: 'surrender', payload: {} })
    await api(`/api/rooms/${room.code}/leave`, first.token)
    await api(`/api/rooms/${room.code}/leave`, second.token)
  }
}
