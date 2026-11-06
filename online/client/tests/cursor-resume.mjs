// Real Three renderer/input lifecycle regression. Physics/API are not mocked.
// Only unsupported/denied browser Pointer Lock capabilities are explicitly injected.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || process.env.BROWSER || 'chromium,webkit').split(',')
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser
try {
  await server.listen()
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  const source = await (await fetch(base + '/src/game/createGameScene.ts')).text()
  const threeModule = source.match(/import\s+\*\s+as\s+THREE\s+from\s+["']([^"']+)["']/)?.[1]
  assert.ok(threeModule)

  for (const engine of engines) {
    browser = await playwright[engine].launch({ headless: true,
      ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
    })
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true })
    const errors = []
    let page
    await context.route('**/cursor-resume-fixture?*', route => route.fulfill({ contentType: 'text/html', body: `
      <meta charset="utf-8"><style>body{margin:0}#stage{width:100vw;height:100vh}#activate{position:fixed;right:20px;top:20px;z-index:10}</style>
      <div id="stage"></div><button id="activate">Начать прицеливание</button>
      <script type="module">
        import { createGameScene } from '/src/game/createGameScene.ts';
        import * as THREE from ${JSON.stringify(threeModule)};
        const mode=new URLSearchParams(location.search).get('mode');
        if(mode==='background'){
          let focused=false;document.hasFocus=()=>focused;
          window.setForeground=value=>{focused=value;window.dispatchEvent(new Event(value?'focus':'blur'))};
        }
        const original=THREE.Scene.prototype.onBeforeRender;
        THREE.Scene.prototype.onBeforeRender=function(renderer,scene,camera,...rest){window.camera=camera;return original?.call(this,renderer,scene,camera,...rest)};
        window.events={phase:null,shots:[],calls:[],placements:[],requests:0,exits:0,suspension:[],lockStates:[]};
        window.game=createGameScene(document.querySelector('#stage'),{
          onShotPhaseChange:phase=>window.events.phase=phase,
          onShoot:aim=>window.events.shots.push(aim),
          onSelectBall:id=>window.events.calls.push({ball:id}),
          onSelectPocket:id=>window.events.calls.push({pocket:id}),
          onPlaceCueBall:point=>window.events.placements.push(point),
          onInputSuspendedChange:value=>window.events.suspension.push(value),
        });
        window.canvas=document.querySelector('canvas');
        window.nativeAvailable=typeof canvas.requestPointerLock==='function';
        if(mode==='unsupported')canvas.requestPointerLock=undefined;
        else if(mode==='denied'||mode==='background')canvas.requestPointerLock=()=>{window.events.requests++;return Promise.reject(new DOMException('Explicit test denial','NotAllowedError'))};
        else if(mode==='deferred'){
          let held=null;window.pendingRequests=[];
          Object.defineProperty(document,'pointerLockElement',{configurable:true,get:()=>held});
          document.exitPointerLock=()=>{window.events.exits++;held=null;queueMicrotask(()=>document.dispatchEvent(new Event('pointerlockchange')))};
          canvas.requestPointerLock=()=>{window.events.requests++;return new Promise((resolve,reject)=>window.pendingRequests.push({resolve,reject}))};
          window.grantEvent=()=>{held=canvas;document.dispatchEvent(new Event('pointerlockchange'))};
          window.resolve=index=>window.pendingRequests[index].resolve();
          window.grant=index=>{window.grantEvent();window.resolve(index)};
        }
        else if(window.nativeAvailable){const native=canvas.requestPointerLock.bind(canvas);canvas.requestPointerLock=()=>{window.events.requests++;const result=native();if(result?.catch)return result.catch(error=>{window.events.lockError=error.message;throw error});return result}};
        window.snapshot={cueBallId:'cue',shotNumber:0,table:{width:1.27,length:2.54,height:.8,pockets:[]},balls:[
          {id:'cue',position:[.635,.635,.028575],radius:.028575},
          {id:'1',position:[.635,1.98,.028575],radius:.028575},
        ]};
        window.game.setState(window.snapshot);
        window.game.setShotPhase('overview');
        window.game.setDefaultAimCamera('cue');
        window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false,ownTurn:true,pointerLockAllowed:true});
        window.game.beginAimTurn();
        window.state=()=>({aim:window.game.getAim(),phase:window.events.phase,shots:window.events.shots.length,calls:window.events.calls.length,placements:window.events.placements.length});
        window.projectBall=id=>{const b=window.snapshot.balls.find(b=>b.id===id),t=window.snapshot.table,p=new THREE.Vector3(b.position[0]-t.width/2,b.position[2]+t.height,t.length/2-b.position[1]).project(window.camera);return{x:(p.x+1)*500,y:(1-p.y)*350}};
        document.querySelector('#activate').onclick=()=>{window.game.resumeInput();window.game.requestAimPointerLock()};
        document.addEventListener('pointerlockchange',()=>window.events.lockStates.push({locked:document.pointerLockElement===canvas,suspended:window.events.suspension.at(-1)}));
        window.addEventListener('pointerdown',event=>window.events.pointerId=event.pointerId,true);
        window.ready=true;
      </script>` }))
    const load = async mode => {
      if (page) await page.close()
      page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/cursor-resume-fixture?mode=${mode}`)
      await page.waitForFunction(() => window.ready && window.camera)
      await page.bringToFront()
    }
    const state = () => page.evaluate(() => window.state())
    const waitFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const blur = async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await page.waitForFunction(() => !document.pointerLockElement)
    }
    const polls = async () => {
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'))
        document.dispatchEvent(new Event('visibilitychange'))
        window.game.setInteraction({canShoot:true,ownTurn:true,pointerLockAllowed:true})
        window.game.setSettings({sensitivity:1})
      })
      await waitFrames()
    }
    const assertFrozenUntilClick = async (message, point = { x: 700, y: 120 }) => {
      const frozen = await state()
      const requests = await page.evaluate(() => window.events.requests)
      await page.locator('canvas').focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Space')
      assert.deepEqual(await state(), frozen, `${message}: keyboard input cannot bypass the resume boundary`)
      await polls()
      await page.mouse.move(500, 350)
      await page.mouse.move(999, 350)
      await page.waitForTimeout(550)
      assert.deepEqual(await state(), frozen, `${message}: hover and edge dwell after return must preserve the whole preparation`)
      assert.equal(await page.evaluate(() => window.events.requests), requests, `${message}: focus/polling must not recapture the mouse`)
      await page.mouse.click(point.x, point.y)
      await waitFrames()
      assert.deepEqual(await state(), frozen, `${message}: first returning click is resume only, including optional calls and placement`)
      return frozen
    }

    let fallbackCases = 0
    for (const mode of ['unsupported', 'denied']) {
      await load(mode)
      await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
      await page.evaluate(() => window.game.setAim({phi:123,V0:3,theta:10,a:.2,b:-.1}))
      await blur()
      const object = await page.evaluate(() => window.projectBall('1'))
      assert.ok(object.x > 0 && object.x < 1000 && object.y > 0 && object.y < 700)
      await assertFrozenUntilClick(`${mode} heading`, object)
      await page.mouse.move(500, 350)
      const resumedHeading = await state()
      await page.mouse.move(560, 350)
      assert.notEqual((await state()).aim.phi, resumedHeading.aim.phi, `${mode}: deliberate movement works after resuming`)
      await page.mouse.move(8, 8)
      await page.mouse.click(8, 8)
      assert.equal((await state()).phase, 'aim', `${mode}: the next separate click confirms heading normally`)
      await blur()
      await assertFrozenUntilClick(`${mode} contact`)
      await page.mouse.click(8, 8)
      assert.equal((await state()).phase, 'power', `${mode}: the next separate click advances contact normally`)

      // Abort a real downward power gesture. Its stale pointerup and the resume
      // click must not complete a shot, even though the phase remains power.
      await page.mouse.move(400, 300)
      await page.mouse.down()
      await page.mouse.move(400, 440, { steps: 4 })
      await blur()
      const afterAbortedPull = await state()
      await page.mouse.up()
      assert.deepEqual(await state(), afterAbortedPull, `${mode}: stale drag release after blur never fires`)
      await assertFrozenUntilClick(`${mode} power`)
      await page.mouse.move(400, 300)
      await page.mouse.down()
      await page.mouse.move(400, 420, { steps: 4 })
      await page.mouse.up()
      assert.equal((await state()).shots, 1, `${mode}: a fresh deliberate power gesture still fires exactly once`)
      fallbackCases++

      // The resume gate must precede custom mouse bindings, not just the default
      // heading->contact workflow.
      await load(mode)
      await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
      await page.evaluate(() => window.game.setSettings({bindings:{shoot:'Mouse0'}}))
      await blur()
      await assertFrozenUntilClick(`${mode} Mouse0 shoot binding`)
      await page.mouse.click(8, 8)
      assert.equal((await state()).shots, 1, `${mode}: the binding resumes only after its protective return click`)
      fallbackCases++

      // Background ownership changes must not implicitly undo the focus gate.
      // This catches blur on the opponent's turn, where canLockAimPointer was
      // false before the player became eligible to shoot again.
      await load(mode)
      await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
      await page.evaluate(() => { window.game.setInteraction({canShoot:false,ownTurn:false});window.game.resetCamera(true) })
      await blur()
      const requestsBeforeTurn = await page.evaluate(() => window.events.requests)
      await page.evaluate(() => {
        window.snapshot.shotNumber++
        window.game.setState(window.snapshot)
        window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false,ownTurn:true,pointerLockAllowed:true})
        window.game.beginAimTurn()
      })
      await waitFrames()
      assert.equal(await page.evaluate(() => window.events.requests), requestsBeforeTurn, `${mode}: a new own turn while suspended must not capture`)
      await assertFrozenUntilClick(`${mode} opponent-to-own background turn`)
      fallbackCases++

      await load(mode)
      await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
      await blur()
      const beforeCancelledResume = await state()
      await page.mouse.move(700, 120)
      await page.mouse.down()
      await page.mouse.move(950, 500, { steps: 3 })
      assert.deepEqual(await state(), beforeCancelledResume, `${mode}: the held resume gesture cannot steer or charge`)
      await page.evaluate(() => window.canvas.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerType:'mouse',pointerId:window.events.pointerId})))
      await page.mouse.up()
      await assertFrozenUntilClick(`${mode} cancelled resume gesture`)
      fallbackCases++
    }

    // Transient user activation may begin only on touchend. Wait out the prior
    // mouse gesture and use a real touchscreen tap, not a synthetic tap event.
    await load('unsupported')
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    await blur()
    await page.waitForFunction(() => !navigator.userActivation || !navigator.userActivation.isActive, null, { timeout: 7000 })
    const touchFrozen = await state()
    await page.touchscreen.tap(700, 120)
    assert.deepEqual(await state(), touchFrozen, 'A real touch resume tap must not confirm heading or change any shot parameter')
    await page.touchscreen.tap(8, 8)
    assert.equal((await state()).phase, 'aim', 'A second deliberate touch tap works after activation-on-up resume')

    // Attempt a real browser tab transition. Some headless engines keep every
    // page focused/visible; that limitation is reported rather than pretending
    // it is an OS focus test. The fallback explicitly injects the blur event.
    // In either case, bringToFront is not a scoped game-control gesture.
    await load('native')
    if (engine === 'chromium') {
      // Playwright enables focus emulation for every Chromium page by default.
      // Disable that testing override so actual tab foreground changes reach
      // document.hasFocus()/blur rather than pretending both pages are focused.
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await page.bringToFront()
      await page.waitForFunction(() => document.hasFocus())
    }
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    let nativeLock = await page.waitForFunction(() => document.pointerLockElement === window.canvas, null, { timeout: 4000 }).then(() => true, () => false)
    if (engine === 'chromium') assert.equal(nativeLock, true, 'Exercise real native Pointer Lock in Chromium')
    const other = await context.newPage()
    if (engine === 'chromium') {
      const cdp = await context.newCDPSession(other)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    }
    await other.goto('about:blank')
    await other.bringToFront()
    const actualFocusLost = await page.waitForFunction(() => !document.hasFocus() || document.visibilityState === 'hidden', null, { timeout: 2000 }).then(() => true, () => false)
    if (!actualFocusLost) await blur() // Explicitly reported as event-only in this engine.
    await page.waitForTimeout(800)
    await page.waitForFunction(() => !document.pointerLockElement)
    const frozen = await state(), oldRequests = await page.evaluate(() => window.events.requests)
    await page.bringToFront()
    await polls()
    await page.mouse.move(700, 350)
    await page.waitForTimeout(200)
    assert.deepEqual(await state(), frozen, `${engine}: bringing the game forward must not move the selected aim`)
    assert.equal(await page.evaluate(() => window.events.requests), oldRequests, `${engine}: tab activation/polling must not request lock`)
    await page.mouse.click(700, 350)
    await waitFrames()
    assert.deepEqual(await state(), frozen, `${engine}: explicit return click must neither confirm nor alter heading`)
    if (nativeLock) {
      await page.waitForFunction(() => document.pointerLockElement === window.canvas, null, { timeout: 4000 })
      await page.mouse.move(1500, 350)
      assert.notEqual((await state()).aim.phi, frozen.aim.phi, 'Native unbounded movement works again after explicit resume')
      const selected = (await state()).aim.phi
      await page.mouse.down(); await page.mouse.up()
      assert.equal((await state()).phase, 'aim')
      assert.equal((await state()).aim.phi, selected)
    }
    assert.equal((await state()).shots, 0)
    await other.close()
    await page.evaluate(() => window.game.destroy())

    // Explicit foreground-API fixture for a scene constructed while the browser
    // reports another window active. Visibility/focus alone cannot resume it.
    await load('background')
    const backgroundState = await state()
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    assert.equal(await page.evaluate(() => window.events.requests), 0, 'Even explicit UI cannot capture while the browser reports no foreground focus')
    assert.deepEqual(await state(), backgroundState)
    await page.evaluate(() => window.setForeground(true))
    await assertFrozenUntilClick(`${engine} scene created in background`)
    await page.evaluate(() => window.game.destroy())

    if (nativeLock) {
      // Simulate an unowned browser unlock (the same event path as Escape),
      // independently from blur. It must require an intentional resume too.
      await load('native')
      await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
      await page.waitForFunction(() => document.pointerLockElement === window.canvas)
      await page.evaluate(() => document.exitPointerLock())
      await page.waitForFunction(() => !document.pointerLockElement)
      await assertFrozenUntilClick(`${engine} unrequested native unlock`)
      assert.ok(await page.evaluate(() => window.events.suspension.includes(true)), 'An unowned native unlock must mark input suspended before accepting new gameplay')
      await page.evaluate(() => window.game.destroy())
    }

    // Explicit browser-API timing fixture: a request made before blur grants
    // late. This is not a mock game state or a claimed native browser grant.
    await load('deferred')
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    assert.equal(await page.evaluate(() => window.events.requests), 1)
    await blur()
    const beforeLateGrant = await state()
    await page.evaluate(() => { document.querySelector('#activate').focus();window.grant(0) })
    await page.waitForFunction(() => !document.pointerLockElement)
    assert.ok(await page.evaluate(() => window.events.exits > 0), 'A late grant after blur must be released, not accepted')
    await polls()
    assert.equal(await page.evaluate(() => window.events.requests), 1, 'A stale grant must not trigger recapture')
    assert.deepEqual(await state(), beforeLateGrant)
    assert.equal(await page.evaluate(() => document.activeElement===window.canvas), false, 'Late completion must not refocus the game canvas')
    await page.evaluate(() => window.game.destroy())

    // Another timing-only browser fixture: A's native grant event arrives,
    // but its Promise resolves only after an independently accepted B lease.
    // A stale completion must not tear down B's current pointer ownership.
    await load('deferred')
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    await page.evaluate(() => window.grantEvent())
    assert.equal(await page.evaluate(() => document.pointerLockElement===window.canvas), true)
    await blur()
    await page.getByRole('button', { name: 'Начать прицеливание', exact: true }).click()
    assert.equal(await page.evaluate(() => window.events.requests), 2)
    await page.evaluate(() => window.grant(1))
    assert.equal(await page.evaluate(() => document.pointerLockElement===window.canvas), true)
    const exitsBeforeStale = await page.evaluate(() => window.events.exits)
    await page.evaluate(() => window.resolve(0))
    await waitFrames()
    assert.equal(await page.evaluate(() => document.pointerLockElement===window.canvas), true, 'Old request A resolving must not release current accepted request B')
    assert.equal(await page.evaluate(() => window.events.exits), exitsBeforeStale)
    await page.evaluate(() => window.game.destroy())
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({engine,realThree:true,nativeLock,actualOtherTab:actualFocusLost,eventFocusFallback:!actualFocusLost,fallbackCases,returnClickConsumed:true,fullAimPreserved:true,abortedPowerNeverFires:true,customMouseBindingGuard:true,cancelledResumeSafe:true,touchActivationOnUp:true,noAutomaticRecapture:true,backgroundConstructionFixture:true,explicitLateGrantFixture:true,staleCompletionCannotReleaseNewLease:true,jsErrors:errors.length}))
    await context.close(); await browser.close(); browser = null
  }
} finally {
  await browser?.close()
  await server.close()
}
