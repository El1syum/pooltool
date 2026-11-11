import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engine = process.env.BROWSER || 'chromium'
const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}/tests/antialias-renderer.fixture.html`)
  await page.waitForFunction(() => window.antialiasFixture)
  const sample = async mode => {
    const result = await page.evaluate(mode => window.antialiasFixture.sample(mode), mode)
    assert.equal(result.error, 0)
    assert.equal(result.sameCanvas, true)
    assert.ok(result.center > 200, 'the scene is visibly rendered and tone-mapped')
    return result
  }
  const auto = await sample('auto')
  assert.equal(auto.mode, 'auto')
  assert.equal(auto.targets.length, 0, 'Auto has no offscreen antialiasing passes')
  const fxaa = await sample('fxaa')
  const smaa = await sample('smaa')
  assert.equal(fxaa.mode, 'fxaa')
  assert.equal(smaa.mode, 'smaa')
  assert.ok(fxaa.partial > 10 && smaa.partial > 10, 'both passes actually smooth rendered edge pixels')
  assert.notEqual(fxaa.signature, smaa.signature, 'the GPU applies two different filters')
  assert.ok(Math.abs(fxaa.center - auto.center) <= 2 && Math.abs(smaa.center - auto.center) <= 2,
    'sRGB and tone mapping remain consistent away from edges')
  assert.ok(auto.calls < fxaa.calls && fxaa.calls < smaa.calls, 'telemetry includes each fullscreen draw')
  assert.ok(auto.textures < fxaa.textures && fxaa.textures < smaa.textures)
  for (const result of [fxaa, smaa]) {
    assert.ok(result.targets.length > 0)
    assert.ok(result.targets.every(([w, h, samples]) => w === result.w && h === result.h && samples === 0))
  }

  await page.evaluate(() => window.antialiasFixture.resize(149, 101, 1.25))
  const resized = await sample('smaa')
  assert.deepEqual([resized.w, resized.h], [186, 126])
  assert.ok(resized.targets.every(([w, h]) => w === resized.w && h === resized.h), 'all passes track the integer render buffer')
  const reset = await sample('auto')
  assert.equal(reset.textures, auto.textures, 'going back to Auto releases all post resources')
  assert.deepEqual(reset.targets, [])

  await page.evaluate(() => window.antialiasFixture.blockFloat(true))
  for (let i = 0; i < 2; i++) {
    const fallback = await sample('smaa')
    assert.equal(fallback.mode, 'auto')
    assert.equal(fallback.fallback, 'smaa')
    assert.deepEqual(fallback.fallbacks, ['smaa'], 'a failed mode is reported once')
    assert.equal(fallback.textures, auto.textures)
  }
  await page.evaluate(() => window.antialiasFixture.blockFloat(false))
  const recovered = await sample('fxaa')
  assert.equal(recovered.mode, 'fxaa')
  assert.equal(recovered.fallback, null)
  assert.equal(await page.evaluate(() => window.antialiasFixture.dispose()), auto.textures)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, effects: ['auto', 'fxaa', 'smaa'], partialPixels: [fxaa.partial, smaa.partial], resized: [resized.w, resized.h], fallbackAndDisposal: true }))
} finally {
  await browser?.close()
  await server.close()
}
