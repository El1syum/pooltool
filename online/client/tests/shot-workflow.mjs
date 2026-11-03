// Isolated real Three.js input test. A temporary Vite server is started unless VITE_BASE is supplied.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = process.env.VITE_BASE || 'http://127.0.0.1:4312'
const engineName = process.env.BROWSER || 'chromium'
let browser, viteServer
try {
  if (!process.env.VITE_BASE) {
    viteServer = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4312, strictPort: true } })
    await viteServer.listen()
  }
  browser = await playwright[engineName].launch({ headless: true,
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Use the exact optimized Three.js module instance used by the renderer;
  // the inline fixture itself is fulfilled by Playwright, not transformed by Vite.
  const sceneModule = await (await fetch(base + '/src/game/createGameScene.ts')).text()
  const threeModule = sceneModule.match(/import\s+\*\s+as\s+THREE\s+from\s+["']([^"']+)["']/)?.[1]
  assert.ok(threeModule, 'The real renderer Three.js module must be discoverable')
  await page.addInitScript(() => {
    window.ballCenters = []
    const clear = WebGL2RenderingContext.prototype.clear
    const draw = WebGL2RenderingContext.prototype.drawElements
    WebGL2RenderingContext.prototype.clear = function (mask) {
      if ((mask & this.COLOR_BUFFER_BIT) && this.getParameter(this.FRAMEBUFFER_BINDING) === null) window.ballCenters = []
      return clear.call(this, mask)
    }
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      const result = draw.apply(this, args)
      // The current full-size ball SphereGeometry(32,24) has 4416 indices.
      if (args[1] !== 4416 || this.getParameter(this.FRAMEBUFFER_BINDING) !== null) return result
      const program = this.getParameter(this.CURRENT_PROGRAM)
      const mvLocation = this.getUniformLocation(program, 'modelViewMatrix')
      const pLocation = this.getUniformLocation(program, 'projectionMatrix')
      if (!mvLocation || !pLocation) return result
      const m = this.getUniform(program, mvLocation), p = this.getUniform(program, pLocation)
      const x = p[0]*m[12] + p[4]*m[13] + p[8]*m[14] + p[12]*m[15]
      const y = p[1]*m[12] + p[5]*m[13] + p[9]*m[14] + p[13]*m[15]
      const w = p[3]*m[12] + p[7]*m[13] + p[11]*m[14] + p[15]*m[15]
      window.ballCenters.push([x/w,y/w])
      return result
    }
  })
  await page.route('**/workflow-fixture', route => route.fulfill({ contentType: 'text/html', body: `
    <style>body{margin:0}#stage{width:100vw;height:100vh}#fixture-ui{position:fixed;right:12px;bottom:12px;z-index:2}</style><div id="stage"></div><button id="fixture-ui">UI control</button>
    <script type="module">
      import { createGameScene } from '/src/game/createGameScene.ts';
      import { DEFAULT_BINDINGS } from '/src/game/types.ts';
      import * as THREE from ${JSON.stringify(threeModule)};
      const beforeRender = THREE.Scene.prototype.onBeforeRender;
      THREE.Scene.prototype.onBeforeRender = function(renderer,scene,camera,...rest) { window.renderScene=this;window.renderCamera=camera;return beforeRender?.call(this,renderer,scene,camera,...rest); };
      const intersectPlane = THREE.Ray.prototype.intersectPlane;
      THREE.Ray.prototype.intersectPlane = function(plane,target) { const result=intersectPlane.call(this,plane,target);if(plane.normal.y===1&&plane.constant===-.8)window.tableRay=result?.toArray()??null;return result; };
      window.projectTarget = (kind,id) => { let target;window.renderScene.updateMatrixWorld(true);window.renderCamera.updateMatrixWorld(true);window.renderScene.traverse(object=>{if((kind==='ball'&&object.userData.ballId===id)||(kind==='pocket'&&object.isSprite&&object.userData.pocketId===id))target=object;});if(!target)return null;const point=target.getWorldPosition(new THREE.Vector3()).project(window.renderCamera);return{x:(point.x+1)*innerWidth/2,y:(1-point.y)*innerHeight/2}; };
      window.defaults = DEFAULT_BINDINGS;
      window.events = { phases: [], shots: [], aims: [], placements: [], balls: [], pockets: [] };
      document.querySelector('#fixture-ui').onclick=()=>window.uiClicks=(window.uiClicks||0)+1;
      window.game = createGameScene(document.querySelector('#stage'), {
        onShotPhaseChange: phase => { window.phase = phase; window.events.phases.push(phase); },
        onAimChange: aim => window.events.aims.push(aim),
        onShoot: aim => window.events.shots.push(aim),
        onPlaceCueBall: position => window.events.placements.push(position),
        onSelectBall: id => window.events.balls.push(id),
        onSelectPocket: id => window.events.pockets.push(id),
      });
      window.snapshot = {
        cueBallId: 'cue',
        table: {width:1.27,length:2.54,height:0.8,pockets:[]},
        balls: [
          {id:'cue',position:[0.635,0.635,0.028575],radius:0.028575},
          {id:'1',position:[0.635,1.98,0.028575],radius:0.028575},
          {id:'8',position:[0.3,1.9,0.028575],radius:0.028575},
        ],
      };
      window.game.setState(window.snapshot);
      window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false});
      window.game.setShotPhase('overview');
      window.game.resetCamera(true);
      window.ready = true;
    </script>` }))
  await page.goto(base + '/workflow-fixture')
  await page.waitForFunction(() => window.ready === true && window.renderCamera).catch(failure=>{throw new Error(`${failure.message}; page errors: ${JSON.stringify(errors)}`)})
  const canvas = page.locator('canvas[role=application]')
  await page.getByRole('button',{name:'UI control',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.phase),'overview','UI controls outside the canvas never confirm the shot workflow')
  const objectTarget=await page.evaluate(()=>window.projectTarget('ball','1'))
  assert.ok(objectTarget)
  await page.mouse.click(objectTarget.x,objectTarget.y)
  assert.deepEqual(await page.evaluate(()=>window.events.balls),['1'],'Object-ball call selection keeps priority over free-point confirmation')
  assert.equal(await page.evaluate(()=>window.phase),'overview')
  await page.mouse.move(500, 350)
  const overviewHeading = await page.evaluate(() => window.game.getAim().phi)
  await page.mouse.move(550, 350)
  assert.notEqual(await page.evaluate(() => window.game.getAim().phi), overviewHeading, 'Unheld mouse movement chooses direction before the first click')
  await page.mouse.move(8, 8)
  const confirmedHeading = await page.evaluate(() => window.game.getAim().phi)
  await canvas.click({ position: { x: 8, y: 8 } })
  const backgroundIntersection=await page.evaluate(()=>window.tableRay)
  assert.ok(!backgroundIntersection||Math.abs(backgroundIntersection[0])>.635||Math.abs(backgroundIntersection[2])>1.27,'Regression click must really be outside the felt')
  assert.equal(await page.evaluate(() => window.phase), 'aim', 'The first background click locks direction and opens cue contact')
  assert.equal(await page.evaluate(() => window.game.getAim().phi), confirmedHeading)
  await page.waitForFunction(() => window.ballCenters.some(([x,y]) => Math.hypot(x*500,y*350) < 1.5))
  await page.mouse.move(100, 250)
  await page.mouse.move(140, 250)
  assert.equal(await page.evaluate(() => window.game.getAim().phi), confirmedHeading, 'Contact selection never rotates the confirmed heading')
  await page.evaluate(() => window.game.setAim({phi:222,a:0.3,b:-0.2}))
  const contactAim = await page.evaluate(() => window.game.getAim())
  assert.equal(contactAim.phi, confirmedHeading, 'External aim updates cannot bypass the contact-phase direction lock')
  assert.deepEqual([contactAim.a,contactAim.b], [0.3,-0.2], 'Contact can still be selected without changing direction')
  await canvas.focus()
  await page.keyboard.down('ArrowRight')
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0
    const tick = () => ++frames >= 8 ? resolve() : requestAnimationFrame(tick)
    requestAnimationFrame(tick)
  }))
  await page.keyboard.up('ArrowRight')
  assert.equal(await page.evaluate(() => window.game.getAim().phi), confirmedHeading, 'Direction keys are locked in the contact phase')
  await page.getByRole('button',{name:'UI control',exact:true}).click()
  assert.equal(await page.evaluate(()=>window.phase),'aim','UI controls never confirm contact')
  await canvas.focus()
  await page.keyboard.down('a')
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0
    const tick = () => ++frames >= 8 ? resolve() : requestAnimationFrame(tick)
    requestAnimationFrame(tick)
  }))
  await page.keyboard.up('a')
  assert.notEqual(await page.evaluate(() => window.game.getAim().a), contactAim.a, 'Contact keyboard bindings remain usable')
  assert.equal(await page.evaluate(() => window.game.getAim().phi), confirmedHeading)
  const beforeContactConfirmation=await page.evaluate(()=>window.game.getAim())
  await page.mouse.move(8,8)
  await page.mouse.down()
  await page.mouse.move(8,24)
  await page.mouse.up()
  assert.equal(await page.evaluate(()=>window.phase),'aim','A dragged contact press is not a confirmation or a charge gesture')
  assert.equal(await page.evaluate(()=>window.events.shots.length),0,'Dragging the contact confirmation press cannot fire a shot')
  await canvas.click({ position: { x: 8, y: 8 } })
  assert.equal(await page.evaluate(() => window.phase), 'power', 'A background contact confirmation click enters power')
  assert.deepEqual(await page.evaluate(()=>window.game.getAim()),beforeContactConfirmation,'Background confirmation preserves direction and selected contact')
  await page.waitForFunction(() => window.ballCenters.some(([x,y]) => Math.hypot(x*500,y*350) < 1.5))
  assert.equal(await page.evaluate(() => window.events.shots.length), 0, 'A confirmation click must not shoot')
  await page.evaluate(() => window.game.setAim({a:0.6,b:0.4,phi:222}))
  const locked = await page.evaluate(() => window.game.getAim())
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(450, 400, { steps: 5 })
  await page.mouse.up()
  const shot = await page.evaluate(() => window.events.shots.at(-1))
  assert.deepEqual([shot.phi,shot.a,shot.b], [locked.phi,locked.a,locked.b])
  assert.ok(shot.V0 > 0.2 && shot.V0 <= 8)
  assert.equal(shot.theta, locked.theta, 'A sideways power pull never changes cue elevation')
  assert.equal(await page.evaluate(() => window.phase), 'power', 'Only the parent resets the phase after a submitted shot')
  const shots = await page.evaluate(() => window.events.shots.length)
  await canvas.click({ position: { x: 400, y: 300 } })
  assert.equal(await page.evaluate(() => window.events.shots.length), shots, 'A power click without drag must not shoot')
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(480, 300, { steps: 4 })
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.events.shots.length), shots, 'A sideways-only move does not select power or shoot')
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(400, 250, { steps: 4 })
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.events.shots.length), shots, 'An upward move without pulling the cue cannot shoot')

  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(430, 380)
  await page.evaluate(() => window.game.setInteraction({canShoot:false}))
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.events.shots.length), shots, 'Losing input permission cancels the pending strike')
  await page.evaluate(() => window.game.setShotPhase('aim'))
  const blockedAim = await page.evaluate(() => window.game.getAim())
  await page.mouse.move(200, 300)
  await page.mouse.move(280, 300)
  assert.deepEqual(await page.evaluate(() => window.game.getAim()), blockedAim, 'A modal/opponent turn blocks free-motion aiming')
  await page.evaluate(() => window.game.setInteraction({canShoot:true,canPlaceCueBall:true}))
  await page.mouse.move(300, 300)
  await page.mouse.move(350, 300)
  assert.deepEqual(await page.evaluate(() => window.game.getAim()), blockedAim, 'Placement takes priority over free-motion aiming')
  await page.evaluate(() => { window.game.setInteraction({canShoot:true,canPlaceCueBall:false}); window.game.setShotPhase('power'); })
  await canvas.click({ position: { x: 400, y: 300 }, button: 'right' })
  assert.equal(await page.evaluate(() => window.phase), 'aim')
  await canvas.click({ position: { x: 400, y: 300 }, button: 'right' })
  assert.equal(await page.evaluate(() => window.phase), 'overview')
  assert.equal(await page.evaluate(() => window.events.shots.length), shots)
  await page.mouse.move(300, 300)
  const unlockedHeading = await page.evaluate(() => window.game.getAim().phi)
  await page.mouse.move(350, 300)
  assert.notEqual(await page.evaluate(() => window.game.getAim().phi), unlockedHeading, 'Returning to overview unlocks heading selection')

  // A high background pixel can miss the horizontal table plane entirely in
  // the shallow cue camera. Confirmation is about the selected state, not a ray hit.
  await page.evaluate(() => {
    window.game.setShotPhase('overview');window.game.setCameraMode('cue');window.game.zoomCamera(100)
  })
  await page.evaluate(() => new Promise(resolve => {
    let frames=0;const settle=()=>++frames>=60?resolve():requestAnimationFrame(settle);requestAnimationFrame(settle)
  }))
  await page.mouse.move(8,8)
  await page.evaluate(() => {window.game.setAim({phi:123,a:.2,b:-.25});window.tableRay='unset'})
  const noHitHeading=await page.evaluate(()=>window.game.getAim().phi)
  await page.mouse.click(8,8)
  assert.equal(await page.evaluate(()=>window.tableRay),null,'The overview regression ray must actually miss the table plane')
  assert.equal(await page.evaluate(()=>window.phase),'aim','A background click without any table-plane hit still confirms direction')
  assert.equal(await page.evaluate(()=>window.game.getAim().phi),noHitHeading)
  await page.evaluate(() => new Promise(resolve => {
    let frames=0;const settle=()=>++frames>=60?resolve():requestAnimationFrame(settle);requestAnimationFrame(settle)
  }))
  await page.evaluate(() => {window.game.setAim({a:.25,b:-.3});window.tableRay='unset'})
  const noHitContact=await page.evaluate(()=>window.game.getAim())
  await page.mouse.click(8,8)
  assert.equal(await page.evaluate(()=>window.tableRay),null,'The contact regression ray must actually miss the table plane')
  assert.equal(await page.evaluate(()=>window.phase),'power','A background click without any table-plane hit still confirms contact')
  assert.deepEqual(await page.evaluate(()=>window.game.getAim()),noHitContact)
  assert.equal(await page.evaluate(()=>window.events.shots.length),shots,'Both no-hit confirmations must not fire')
  await page.mouse.click(8,8,{button:'right'})
  assert.equal(await page.evaluate(()=>window.phase),'aim','Right click still reverses a background-confirmed power phase')
  await page.mouse.click(8,8,{button:'right'})
  assert.equal(await page.evaluate(()=>window.phase),'overview')

  for(const interaction of [{canShoot:false,spectator:false},{canShoot:true,spectator:true}]) {
    await page.evaluate(value=>window.game.setInteraction(value),interaction)
    await page.mouse.click(8,8)
    assert.equal(await page.evaluate(()=>window.phase),'overview','Opponent/modal/spectator input cannot confirm a background click')
    assert.equal(await page.evaluate(()=>window.events.shots.length),shots)
  }
  await page.evaluate(()=>{window.game.setInteraction({canShoot:true,spectator:false});window.game.resetCamera(true)})
  const pocketTarget=await page.evaluate(()=>window.projectTarget('pocket','lb'))
  assert.ok(pocketTarget)
  await page.mouse.click(pocketTarget.x,pocketTarget.y)
  assert.deepEqual(await page.evaluate(()=>window.events.pockets),['lb'],'Pocket call selection keeps priority over confirmation')
  assert.equal(await page.evaluate(()=>window.phase),'overview')

  await page.evaluate(() => window.game.setShotPhase('power'))
  await page.mouse.move(400, 300)
  await page.mouse.down()
  await page.mouse.move(430, 380)
  await page.evaluate(() => window.game.playShot({duration:1,frames:[{t:0,balls:window.snapshot.balls},{t:1,balls:window.snapshot.balls}]}, Date.now()+1000))
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.events.shots.length), shots, 'Playback cancels the pending gesture')
  await page.evaluate(() => { window.game.setState(window.snapshot); window.game.setShotPhase(null); window.game.shoot(); })
  assert.equal(await page.evaluate(() => window.events.shots.length), shots+1, 'Legacy input remains available with null phase')

  let mappedShots = await page.evaluate(() => window.events.shots.length)
  await page.evaluate(() => { window.game.setShotPhase('overview'); window.game.setSettings({bindings:{...window.defaults,shoot:'Mouse0'}}); })
  await canvas.click({ position:{x:500,y:350} })
  assert.equal(await page.evaluate(() => window.events.shots.length), ++mappedShots, 'Mouse0 shoot overrides the default overview click')
  assert.equal(await page.evaluate(() => window.phase), 'overview')
  await page.evaluate(() => { window.game.setShotPhase('aim'); window.game.setSettings({bindings:{...window.defaults,shoot:'Mouse2'}}); })
  await canvas.click({ position:{x:500,y:350}, button:'right' })
  assert.equal(await page.evaluate(() => window.events.shots.length), ++mappedShots, 'Mouse2 shoot overrides default right-click back')
  assert.equal(await page.evaluate(() => window.phase), 'aim')
  await page.evaluate(() => window.game.setSettings({bindings:{...window.defaults,topView:'Mouse0'}}))
  await canvas.click({ position:{x:500,y:350} })
  assert.equal(await page.evaluate(() => window.game.getCameraMode()), 'free')
  assert.equal(await page.evaluate(() => window.phase), 'overview', 'Mouse0 top view must not advance aim/power')
  await page.evaluate(() => window.game.setSettings({bindings:{...window.defaults,orbit:'Mouse0'}}))
  await canvas.click({ position:{x:500,y:350} })
  assert.equal(await page.evaluate(() => window.phase), 'overview', 'Mouse0 orbit must not enter aiming')
  await page.evaluate(() => window.game.setSettings({bindings:{...window.defaults,orbit:'KeyX'}}))
  await canvas.focus()
  await page.keyboard.down('x')
  await canvas.click({ position:{x:500,y:350} })
  await page.keyboard.up('x')
  assert.equal(await page.evaluate(() => window.phase), 'overview', 'The orbit modifier must not enter aiming')

  await page.evaluate(() => {
    window.game.setSettings({bindings:{...window.defaults,shoot:'Mouse0'}});
    window.game.setInteraction({canShoot:false,canPlaceCueBall:true,spectator:false});
    window.game.resetCamera(true);
  })
  const placed = await page.evaluate(() => window.events.placements.length)
  await canvas.click({ position:{x:500,y:350} })
  assert.equal(await page.evaluate(() => window.events.placements.length), placed+1, 'Placement overrides Mouse0 shoot after a foul')
  assert.equal(await page.evaluate(() => window.events.shots.length), mappedShots)
  await page.evaluate(() => window.game.setSettings({bindings:{...window.defaults,orbit:'Mouse0'}}))
  await page.evaluate(() => new Promise(resolve => {
    let frames = 0
    const settle = () => ++frames >= 45 ? resolve() : requestAnimationFrame(settle)
    requestAnimationFrame(settle)
  }))
  const beforePlaceDrag = await page.evaluate(() => window.ballCenters)
  await page.mouse.move(500,350)
  await page.mouse.down()
  await page.mouse.move(530,370,{steps:5})
  await page.mouse.up()
  assert.equal(await page.evaluate(() => window.events.placements.length), placed+2, 'Placement overrides Mouse0 orbit')
  const afterPlaceDrag = await page.evaluate(() => window.ballCenters)
  assert.ok(beforePlaceDrag.length > 0 && afterPlaceDrag.length > 0)
  assert.ok(beforePlaceDrag.every(([x,y]) => afterPlaceDrag.some(([u,v]) => Math.hypot(x-u,y-v) < 0.005)), 'A placement drag must not rotate the camera simultaneously')
  await page.evaluate(() => window.game.setSettings({bindings:{...window.defaults,orbit:'KeyX'}}))
  await canvas.focus()
  await page.keyboard.down('x')
  await canvas.click({ position:{x:500,y:350} })
  await page.keyboard.up('x')
  assert.equal(await page.evaluate(() => window.events.placements.length), placed+2, 'An explicit orbit modifier suppresses placement')

  await page.evaluate(() => {
    window.game.setInteraction({canShoot:true,canPlaceCueBall:false});
    window.game.setSettings({bindings:window.defaults});
    window.game.setShotPhase(null);
    window.game.setAim({phi:90});
    window.game.setCameraMode('cue');
  })
  await page.waitForFunction(() => window.ballCenters.length > 0 && window.ballCenters.every(([x,y]) => Math.hypot(x*500,y*350) > 10))
  assert.deepEqual(errors, [])
  await page.evaluate(() => window.game.destroy())
  console.log(JSON.stringify({engine:engineName,phaseTransitions:true,backgroundConfirmation:true,noPlaneHitConfirmation:true,callTargetPriority:true,uiClickIsolation:true,contactPressNoCharge:true,blockedConfirmation:true,overviewHoverDirection:true,contactHeadingLocked:true,contactKeyboard:true,powerDrag:true,lockedAim:true,permissionCancellation:true,placementPriority:true,playbackCancellation:true,legacy:true,centeredCueProjection:true,mouseRemapping:true,orbitModifier:true,jsErrors:errors.length}))
} finally {
  await browser?.close()
  await viteServer?.close()
}
