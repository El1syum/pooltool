// Real Three renderer + native browser pointer lock, with explicit denied and
// unsupported API cases. No game/API/physics response is mocked by this fixture.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engine = process.env.BROWSER || 'chromium'
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser
try {
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  let page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await context.route('**/pointer-lock-fixture?*', async route => route.fulfill({ contentType: 'text/html', body: `
    <meta charset="utf-8"><style>body{margin:0}#stage{width:100vw;height:100vh}button{position:fixed;right:20px;top:20px;z-index:9}</style>
    <div id="stage"></div><button id="lock">Захватить мышь</button>
    <script type="module">
      import { createGameScene } from '/src/game/createGameScene.ts';
      const mode=new URLSearchParams(location.search).get('mode');
      window.events={shots:[],phase:null,moves:[],requests:0};
      window.game=createGameScene(document.querySelector('#stage'),{onShotPhaseChange:phase=>window.events.phase=phase,onShoot:aim=>window.events.shots.push(aim)});
      window.canvas=document.querySelector('canvas');
      window.nativeAvailable=typeof window.canvas.requestPointerLock==='function';
      if(window.nativeAvailable&&mode==='native'){const native=window.canvas.requestPointerLock.bind(window.canvas);window.canvas.requestPointerLock=()=>{window.events.requests++;const result=native();if(result?.catch)return result.catch(error=>{window.events.lockError=error.message;throw error});return result}};
      if(mode==='unsupported')window.canvas.requestPointerLock=undefined;
      if(mode==='denied')window.canvas.requestPointerLock=()=>{window.events.requests++;return Promise.reject(new DOMException('Explicit test denial','NotAllowedError'))};
      window.game.setState({cueBallId:'cue',shotNumber:0,table:{width:1.27,length:2.54,height:.8,pockets:[]},balls:[{id:'cue',position:[.635,.635,.028575],radius:.028575},{id:'1',position:[.635,1.98,.028575],radius:.028575}]});
      window.game.setShotPhase('overview');
      window.game.setDefaultAimCamera('cue');
      window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false,ownTurn:true,pointerLockAllowed:true});
      window.game.beginAimTurn();
      window.canvas.addEventListener('mousemove',event=>{if(document.pointerLockElement===window.canvas)window.events.moves.push({x:event.clientX,y:event.clientY,dx:event.movementX})});
      document.querySelector('#lock').onclick=()=>{window.game.setShotPhase('overview');window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false,ownTurn:true,pointerLockAllowed:true});window.game.setCameraMode('cue');window.game.requestAimPointerLock()};
      window.ready=true;
    </script>` }))
  const load = async (mode, fresh = false) => {
    if (fresh) { await page.close(); page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)) }
    await page.goto(`${base}/pointer-lock-fixture?mode=${mode}`)
    await page.waitForFunction(() => window.ready)
    await page.bringToFront()
  }
  const aim = () => page.evaluate(() => window.game.getAim().phi)
  const phase = () => page.evaluate(() => window.events.phase)
  const unlock = () => page.waitForFunction(() => document.pointerLockElement === null)
  let nativeLock = false
  await load('native')
  if (await page.evaluate(() => window.nativeAvailable)) {
    await page.getByRole('button', { name: 'Захватить мышь', exact: true }).click()
    nativeLock = await page.waitForFunction(() => document.pointerLockElement === window.canvas, null, { timeout: 5000 }).then(() => true, () => false)
    if (engine === 'chromium') assert.equal(nativeLock, true, 'Native pointer lock must be exercised in Chromium')
  }
  if (nativeLock) {
    const a = await aim()
    await page.mouse.move(1500, 350)
    const b = await aim()
    await page.mouse.move(2500, 350)
    const c = await aim()
    assert.notEqual(b, a, 'Locked motion changes heading even beyond the viewport')
    assert.notEqual(c, b, 'Further locked motion is not clamped to a screen edge')
    assert.equal(await phase(), 'overview')
    await page.mouse.move(500, 350)
    const confirmed = await aim()
    await page.mouse.down()
    await page.mouse.up()
    assert.equal(await phase(), 'aim', 'The first LMB confirms rather than consuming an extra capture click')
    assert.equal(await aim(), confirmed)
    await unlock()
    assert.equal(await page.evaluate(() => window.events.shots.length), 0)

    for (const [index, mutation] of [
      () => window.game.setInteraction({ canShoot: false }),
      () => window.game.setInteraction({ pointerLockAllowed: false }),
      () => window.game.setInteraction({ ownTurn: false }),
      () => window.game.setInteraction({ canPlaceCueBall: true }),
      () => window.game.setInteraction({ spectator: true }),
      () => window.game.resetCamera(true),
      () => window.dispatchEvent(new Event('blur')),
      () => window.game.setShotPhase('aim'),
    ].entries()) {
      // Each safety case gets a fresh browsing context surface, avoiding the
      // browser's rate limit on artificial rapid lock/unlock stress loops.
      await load('native', true)
      await page.getByRole('button', { name: 'Захватить мышь', exact: true }).click()
      await page.waitForFunction(() => document.pointerLockElement === window.canvas, null, { timeout: 5000 }).catch(async failure => {
        throw new Error(`Native recapture ${index} failed: ${JSON.stringify(await page.evaluate(() => ({ events: window.events, phase: window.events.phase, mode: window.game.getCameraMode(), focus: document.hasFocus() })))}`, { cause: failure })
      })
      await page.evaluate(mutation)
      await unlock()
    }
    await load('native', true)
    await page.getByRole('button', { name: 'Захватить мышь', exact: true }).click()
    await page.waitForFunction(() => document.pointerLockElement === window.canvas)
    await page.evaluate(() => window.game.destroy())
    await unlock()
  }

  for (const mode of ['unsupported', 'denied']) {
    await load(mode, true)
    await page.getByRole('button', { name: 'Захватить мышь', exact: true }).click()
    await unlock()
    await page.mouse.move(500, 350)
    await page.mouse.move(999, 350)
    const a = await aim()
    await page.waitForTimeout(650)
    const b = await aim()
    await page.waitForTimeout(400)
    const c = await aim()
    assert.notEqual(b, a, `${mode}: edge dwell must turn after its brief delay`)
    assert.notEqual(c, b, `${mode}: staying against the same edge continues turning`)
    await page.mouse.move(500, 350)
    const stopped = await aim()
    await page.waitForTimeout(450)
    assert.equal(await aim(), stopped, `${mode}: turning stops away from the edge`)
    await page.mouse.move(1, 350)
    await page.evaluate(() => window.game.setInteraction({ pointerLockAllowed: false }))
    const modal = await aim()
    await page.waitForTimeout(450)
    assert.equal(await aim(), modal, `${mode}: auxiliary UI suspends edge turning without disabling controls`)
    await page.evaluate(() => { window.game.setAim({ V0: 4 }); window.game.setInteraction({ pointerLockAllowed: true }) })
    assert.equal(await page.evaluate(() => window.game.getAim().V0), 4)
    await page.mouse.click(8, 8)
    assert.equal(await phase(), 'aim')
    const fixed = await aim()
    await page.mouse.move(999, 350)
    await page.waitForTimeout(450)
    assert.equal(await aim(), fixed, `${mode}: contact phase must never rotate`) 
    assert.equal(await page.evaluate(() => window.events.shots.length), 0)
    await page.evaluate(() => window.game.destroy())
  }
  // The renderer is also used without App. Even an unsaved conflicting assist
  // binding must never become a shot/camera/orbit action in this lower layer.
  await load('unsupported', true)
  for (const [assist, eventCode, otherAction] of [
    ['Space', 'Space', 'shoot'],
    ['KeyC', 'KeyC', 'resetCamera'],
    ['KeyT', 'KeyT', 'topView'],
    ['ShiftLeft', 'ShiftRight', 'orbit'],
  ]) {
    await page.evaluate(({ assist, eventCode, otherAction }) => {
      window.game.setSettings({ bindings: { assist, [otherAction]: eventCode } })
      window.canvas.focus()
    }, { assist, eventCode, otherAction })
    const before = await aim()
    await page.keyboard.press(eventCode)
    assert.equal(await phase(), 'overview')
    assert.equal(await page.evaluate(() => window.game.getCameraMode()), 'cue', `${assist} must not trigger the conflicting camera action`)
    assert.equal(await aim(), before)
    assert.equal(await page.evaluate(() => window.events.shots.length), 0, `${assist} must never shoot through a lower-layer conflict`)
  }
  await page.evaluate(() => window.game.destroy())
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ engine, realThree: true, nativeLock, infiniteLockedHeading: nativeLock, firstClickConfirms: true, safeUnlocks: nativeLock, unsupportedAndDeniedFallback: true, auxiliaryControlsKeepCursor: true, assistConflictPriority: true, contactLocksHeading: true, jsErrors: errors.length }))
} finally {
  await browser?.close()
  await server.close()
}
