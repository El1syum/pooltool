// Read-only audit of an actual prepared GLB, not a generated triangle fixture.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
assert.ok(process.env.MODEL_TABLE_PATH, 'Set MODEL_TABLE_PATH to the actual prepared table GLB')
const file = path.resolve(process.env.MODEL_TABLE_PATH), bytes = await readFile(file)
const hash = data => createHash('sha256').update(data).digest('hex'), sourceHash = hash(bytes)
assert.ok(bytes.length <= 50 * 1024 * 1024, 'Prepared table must remain within the 50 MiB runtime limit')
const referenceResponse = await fetch(process.env.MODEL_REFERENCE_URL || 'http://127.0.0.1:8791/api/assets/table-reference', { signal: AbortSignal.timeout(15000) })
assert.equal(referenceResponse.status, 200, 'Use an actual engine reference, not an assumed table size')
const snapshot = (await referenceResponse.json()).snapshot
assert.equal(snapshot.balls.length, 16, 'The authoritative engine reference must contain the real initial ball set')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const artifacts = path.resolve('tests/artifacts/prepared-table')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4326, strictPort: true } })
let browser
try {
  await server.listen()
  const validation = await server.ssrLoadModule('/src/models/validation.ts')
  validation.validateGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
    browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
    const errors = [], external = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:4326') external.push(request.url()) })
    await page.route('**/models/library/prepared-table.glb', route => route.fulfill({ contentType: 'model/gltf-binary', body: bytes }))
    await page.goto('http://127.0.0.1:4326/tests/prepared-table-fixture.html')
    await page.waitForFunction(() => window.fixtureReady)
    const geometry = await page.evaluate(snapshot => window.preparedQa.rawGeometry(snapshot), snapshot)
    await writeFile(path.join(artifacts, `${engine}-geometry.json`), JSON.stringify({ sourceHash, reference: snapshot.table, ...geometry }, null, 2))
    assert.ok(geometry.vertices <= 1_000_000, 'Prepared table exceeds the renderer vertex limit')
    const badSurface = geometry.grid.filter(sample => sample.y === null || Math.abs(sample.y) > .002)
    assert.equal(badSurface.length, 0, `Interior rays must first meet flat cloth at Y=0: ${JSON.stringify(badSurface.slice(0, 12))}`)
    assert.equal(geometry.conflicts.length, 0, `Overlapping near-coplanar meshes can z-fight on the cloth: ${JSON.stringify(geometry.conflicts.slice(0, 12))}`)
    assert.equal(geometry.intrusionVertices, 0, `Non-cloth geometry protrudes into the playable interior: ${JSON.stringify(geometry.intrusions.slice(0, 12))}`)
    for (const pocket of geometry.openings) assert.ok(!pocket.hits.length || pocket.hits[0].y < -.05, `Pocket ${pocket.id} centre is obstructed above -5cm: ${JSON.stringify(pocket.hits)}`)
    const report = await page.evaluate(snapshot => window.preparedQa.runtime(snapshot), snapshot)
    assert.deepEqual(report.errors, {})
    await page.waitForTimeout(1200)
    const metrics = await page.evaluate(() => window.preparedQa.runtimeMetrics())
    assert.equal(metrics.containerY, snapshot.table.renderHeight ?? snapshot.table.height)
    assert.equal(metrics.visibleProceduralBeds, 0, 'Replacement must hide the procedural bed')
    assert.equal(metrics.initialProceduralPocketDisks, snapshot.table.pockets.length, 'Fallback table must retain its six dark pocket caps')
    assert.equal(metrics.visibleProceduralPocketDisks, 0, 'Flat fallback pocket caps must not close an imported table\'s open wells')
    assert.equal(metrics.pocketMarkers.length, snapshot.table.pockets.length, 'Replacement must retain all authoritative pocket markers')
    assert.deepEqual(metrics.pocketMarkers.map(p=>p.id).sort(),snapshot.table.pockets.map(p=>String(p.id)).sort())
    assert.equal(metrics.ballChecks.length, 16)
    for (const ball of metrics.ballChecks) {
      const source = snapshot.balls.find(item => String(item.id) === ball.id)
      assert.ok(Math.abs(ball.y - ((snapshot.table.renderHeight ?? snapshot.table.height) + source.position[2])) < .00001)
      assert.equal(ball.firstHitBall, ball.id, `Ball ${ball.id} is occluded by imported geometry: ${JSON.stringify(ball)}`)
    }
    if (metrics.cloth) for (const y of [metrics.cloth.min[1], metrics.cloth.max[1]]) assert.ok(Math.abs(y - metrics.containerY) < .0001, 'Baked cloth must sit on the authoritative height')
    await page.screenshot({ path: path.join(artifacts, `${engine}-top-shadows.png`) })
    await page.evaluate(() => window.preparedQa.shadowQuality('low'))
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(artifacts, `${engine}-top-no-shadows.png`) })
    const disposal = await page.evaluate(() => window.preparedQa.disposeReload())
    assert.equal(disposal.removed, true)
    assert.equal(disposal.restoredBeds, 1)
    assert.equal(disposal.restoredPocketDisks, snapshot.table.pockets.length, 'Clearing custom art must restore the fallback pocket caps')
    assert.deepEqual(disposal.counts, disposal.expected, 'Each loaded model GPU resource must dispose once')
    assert.equal(disposal.freshContainer, true)
    assert.equal(disposal.ballsStable, true)
    assert.equal(disposal.pocketMarkersStable, true, 'Loading/replacing art must not rebuild or remove physical pocket picking markers')
    assert.deepEqual(disposal.report.errors, {})
    assert.equal(await page.evaluate(() => window.preparedQa.destroy()), 0)
    assert.deepEqual(external, [])
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.preparedErrors), [])
    await writeFile(path.join(artifacts, `${engine}-runtime.json`), JSON.stringify({ metrics, disposal }, null, 2))
    console.log(JSON.stringify({ engine, sourceHash, bytes: bytes.length, vertices: geometry.vertices, triangles: geometry.triangles, interiorRays: geometry.grid.length, pockets: geometry.openings.length, visibleBalls: metrics.ballChecks.length, externalRequests: external.length, tests: 'actual engine dimensions, flat/coplanar cloth audit, open pocket centres, real renderer/16 unoccluded balls, authoritative height, disposal/reload, source untouched' }))
    await browser.close(); browser = null
  }
  assert.equal(hash(await readFile(file)), sourceHash, 'Source GLB must remain untouched')
} finally { await browser?.close(); await server.close() }
