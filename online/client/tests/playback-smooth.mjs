import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { reactive } from 'vue'

// An actual real-engine result is required: this test never generates substitute physics.
const resultPath = process.env.SHOT_RESULT_PATH
assert.ok(resultPath, 'Set SHOT_RESULT_PATH to a JSON result produced by PhysicsEngine.simulate')
const result = JSON.parse(await readFile(resultPath, 'utf8'))
assert.ok(result.trajectory?.frames.length > 1 && result.initialState?.balls?.length)
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser
try {
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const { createTrajectorySampler, expandTrajectory, sampleTrajectory } = await server.ssrLoadModule('/src/game/playback.ts')
  const expanded = expandTrajectory(result.trajectory), proxied = reactive(expanded)
  const sampler = createTrajectorySampler(expanded)
  for (const frame of expanded.frames) {
    for (const t of [frame.t, Math.min(expanded.duration, frame.t + .007)]) {
      const expected = sampleTrajectory(expanded, t), actual = sampler.sample(t)
      assert.equal(actual.length, expected.length)
      for (let index = 0; index < actual.length; index++) {
        assert.equal(actual[index].id, expected[index].id)
        assert.equal(actual[index].state, expected[index].state)
        assert.equal(actual[index].pocketed, expected[index].pocketed)
        for (const key of ['position', 'quaternion']) {
          if (!expected[index][key]) continue
          for (let axis = 0; axis < expected[index][key].length; axis++) assert.ok(Math.abs(actual[index][key][axis] - expected[index][key][axis]) < 1e-12)
        }
      }
    }
  }
  const samples = expanded.frames.length * 30
  function benchmark(sample) {
    let checksum = 0
    const start = performance.now()
    for (let index = 0; index < samples; index++) checksum += sample(index % expanded.frames.length / expanded.frames.length * expanded.duration)[0].position[0]
    return { milliseconds: performance.now() - start, checksum, samples }
  }
  benchmark(t => sampleTrajectory(expanded, t)); benchmark(t => sampleTrajectory(proxied, t)); benchmark(sampler.sample)
  const raw = benchmark(t => sampleTrajectory(expanded, t)), proxy = benchmark(t => sampleTrajectory(proxied, t)), compiled = benchmark(sampler.sample)
  assert.ok(Math.abs(raw.checksum - compiled.checksum) < 1e-8)
  console.log(JSON.stringify({ phase: 'cpu-only-paired-benchmark', realFrames: expanded.frames.length, raw, proxy, compiled }))
  const source = await (await fetch(base + '/src/game/createGameScene.ts')).text()
  const threeModule = source.match(/import\s+\*\s+as\s+THREE\s+from\s+["']([^"']+)["']/)?.[1]
  assert.ok(threeModule)
  for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
    browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/real-shot.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) }))
    await page.route('**/playback-smooth-fixture', route => route.fulfill({ contentType: 'text/html', body: `
      <meta charset="utf-8"><style>body{margin:0}#stage{width:100vw;height:100vh}button{position:fixed;top:10px;right:10px;z-index:2}</style>
      <div id="stage"></div><button id="play">Воспроизвести</button><script type="module">
      import {createGameScene} from '/src/game/createGameScene.ts';
      import {expandTrajectory,sampleTrajectory} from '/src/game/playback.ts';
      import * as THREE from ${JSON.stringify(threeModule)};
      window.result=await (await fetch('/real-shot.json')).json();
      const originalDate=Date.now,epoch=originalDate(),mono=performance.now();window.clockOffset=0;
      Date.now=()=>epoch+performance.now()-mono+window.clockOffset;
      const nativeRAF=requestAnimationFrame.bind(window);
      window.requestAnimationFrame=callback=>nativeRAF(time=>{window.frameTime=time;callback(time)});
      window.audioStats={buffers:0,sources:0,active:0,maxActive:0};
      const NativeAudio=window.AudioContext||window.webkitAudioContext;
      if(NativeAudio){class CountedAudio extends NativeAudio{
        createBuffer(...args){window.audioStats.buffers++;return super.createBuffer(...args)}
        createBufferSource(){const source=super.createBufferSource(),start=source.start.bind(source);source.start=(...args)=>{window.audioStats.sources++;window.audioStats.active++;window.audioStats.maxActive=Math.max(window.audioStats.maxActive,window.audioStats.active);return start(...args)};source.addEventListener('ended',()=>window.audioStats.active--);return source}
      }window.AudioContext=CountedAudio;window.webkitAudioContext=CountedAudio}
      const recording=expandTrajectory(window.result.trajectory);window.records=[];window.done=0;window.running=false;
      const before=THREE.Scene.prototype.onBeforeRender;
      THREE.Scene.prototype.onBeforeRender=function(renderer,scene,camera,...args){
        if(window.running){
          const t=Math.max(0,(window.frameTime-window.monotonicStart)/1000),expected=sampleTrajectory(recording,t);
          let maxError=0;
          for(const ball of expected){const object=this.children.find(item=>String(item.userData.ballId)===String(ball.id));if(!object)continue;
            const p=ball.position,h=window.result.initialState.table.renderHeight??window.result.initialState.table.height??.8,w=window.result.initialState.table.width,l=window.result.initialState.table.length;
            maxError=Math.max(maxError,Math.abs(object.position.x-(p[0]-w/2)),Math.abs(object.position.y-(p[2]+h)),Math.abs(object.position.z-(l/2-p[1])));
          }window.records.push({time:window.frameTime,t,maxError});
        }return before?.call(this,renderer,scene,camera,...args)
      };
      window.game=createGameScene(document.querySelector('#stage'),{onPlaybackComplete:()=>{window.running=false;window.done++}});
      window.game.setState(window.result.initialState);window.game.setSettings({quality:'medium',volume:.5});window.game.setInteraction({canShoot:true,ownTurn:true,spectator:false});
      window.begin=(offset=100)=>{window.clockOffset=0;window.game.setState(window.result.initialState);const start=Date.now()+offset;window.monotonicStart=mono+(start-epoch);window.records=[];window.running=true;window.game.playShot(recording,start)};
      document.querySelector('#play').onclick=()=>{window.game.shoot();window.begin()};window.ready=true;
      </script>` }))
    await page.goto(base + '/playback-smooth-fixture')
    await page.waitForFunction(() => window.ready)
    await page.locator('#play').click()
    await page.waitForTimeout(900)
    await page.evaluate(() => { window.clockOffset = 20_000 })
    await page.waitForTimeout(900)
    await page.evaluate(() => { window.clockOffset = -20_000 })
    await page.waitForFunction(() => window.done === 1, null, { timeout: Math.ceil(result.duration * 1000 + 10_000) })
    const stats = await page.evaluate(() => ({ records: window.records, audio: window.audioStats }))
    assert.ok(stats.records.length > 10)
    assert.ok(stats.records.at(-1).t >= result.duration - .25, 'A forward wall-clock jump must not finish the shot early')
    assert.ok(Math.max(...stats.records.map(frame => frame.maxError)) < .002, 'Wall-clock jumps must not warp the authoritative ball path')
    for (let index = 1; index < stats.records.length; index++) assert.ok(stats.records[index].t >= stats.records[index - 1].t)
    assert.ok(stats.audio.buffers <= 4)
    assert.ok(stats.audio.maxActive <= 24)
    const sourcesBeforeFuture = stats.audio.sources
    await page.evaluate(() => window.begin(1000))
    await page.waitForTimeout(250)
    const future = await page.evaluate(() => ({ records: window.records, sources: window.audioStats.sources }))
    assert.ok(future.records.length && future.records.every(frame => frame.t === 0), 'Future shared start must hold the initial physical state')
    assert.equal(future.sources, sourcesBeforeFuture, 'Remote t=0 impacts must not sound before the shared start')
    await page.evaluate(() => window.begin(-2000))
    await page.waitForTimeout(250)
    const catchup = await page.evaluate(() => window.records)
    assert.ok(catchup.length && catchup[0].t >= 1.95 && catchup[0].t < 2.5, `Late clients must catch up instead of replaying from zero: ${JSON.stringify(catchup.slice(0, 2))}`)
    assert.ok(Math.max(...catchup.map(frame => frame.maxError)) < .002)
    const intervals = stats.records.slice(1).map((frame, index) => frame.time - stats.records[index].time).sort((a, b) => a - b)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine, realFrames: expanded.frames.length, sampledRafFrames: stats.records.length,
      maxPositionErrorMetres: Math.max(...stats.records.map(frame => frame.maxError)), medianFrameMs: intervals[Math.floor(intervals.length / 2)],
      p95FrameMs: intervals[Math.floor(intervals.length * .95)], audio: stats.audio, wallClockJumpsSafe: true, lateCatchup: true, jsErrors: errors.length,
      note: 'Headless software-GPU timings are diagnostic, not a physical-device FPS SLA' }))
    await page.evaluate(() => window.game.destroy())
    await browser.close(); browser = null
  }
} finally { await browser?.close(); await server.close() }
