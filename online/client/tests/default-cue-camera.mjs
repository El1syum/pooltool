// Real Three.js regression: opt-in first-person heading, not a skipped contact phase.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = process.env.VITE_BASE || 'http://127.0.0.1:4336'
const engineName = process.env.BROWSER || 'chromium'
let browser, viteServer
try {
  if (!process.env.VITE_BASE) {
    viteServer = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4336, strictPort: true } })
    await viteServer.listen()
  }
  browser = await playwright[engineName].launch({ headless: true,
    ...(engineName === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, hasTouch: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const sceneModule = await (await fetch(base + '/src/game/createGameScene.ts')).text()
  const threeModule = sceneModule.match(/import\s+\*\s+as\s+THREE\s+from\s+["']([^"']+)["']/)?.[1]
  assert.ok(threeModule)
  await page.route('**/cue-camera-fixture', route => route.fulfill({ contentType: 'text/html', body: `
    <style>body{margin:0}#stage{width:100vw;height:100vh}</style><div id="stage"></div>
    <script type="module">
      import { createGameScene } from '/src/game/createGameScene.ts';
      import * as THREE from ${JSON.stringify(threeModule)};
      const beforeRender = THREE.Scene.prototype.onBeforeRender;
      THREE.Scene.prototype.onBeforeRender = function(renderer,scene,camera,...rest) { window.camera=camera;return beforeRender?.call(this,renderer,scene,camera,...rest); };
      window.events={phases:[],shots:[],playbacks:0};
      window.game=createGameScene(document.querySelector('#stage'),{
        onShotPhaseChange:phase=>{window.phase=phase;window.events.phases.push(phase)},
        onShoot:aim=>window.events.shots.push(aim),
        onPlaybackComplete:()=>window.events.playbacks++,
      });
      window.snapshot={cueBallId:'cue',table:{width:1.27,length:2.54,height:.8,pockets:[]},balls:[
        {id:'cue',position:[.635,.635,.028575],radius:.028575},
        {id:'1',position:[.635,1.98,.028575],radius:.028575},
      ]};
      window.game.setState(window.snapshot);
      window.game.setShotPhase('overview');
      window.frames=(count=20)=>new Promise(resolve=>{const tick=()=>--count<=0?resolve():requestAnimationFrame(tick);requestAnimationFrame(tick)});
      window.pose=()=>window.camera.position.toArray();
      window.ready=true;
    </script>` }))
  await page.goto(base + '/cue-camera-fixture')
  await page.waitForFunction(() => window.ready && window.camera)
  const canvas = page.locator('canvas[role=application]')
  const mode = () => page.evaluate(() => window.game.getCameraMode())
  const phase = () => page.evaluate(() => window.phase)
  const pose = () => page.evaluate(() => window.pose())
  const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]))

  assert.equal(await mode(), 'free', 'Previews and existing scene callers retain their free-camera default')
  await page.evaluate(() => window.game.setDefaultAimCamera('cue'))
  assert.equal(await mode(), 'free', 'An inactive scene must not be forced into first person')
  await page.evaluate(() => {
    window.game.setInteraction({canShoot:true,canPlaceCueBall:false,spectator:false});
    window.game.beginAimTurn();
  })
  assert.equal(await mode(), 'cue')
  assert.equal(await phase(), 'overview', 'The initial view does not confirm or skip heading selection')
  await page.waitForFunction(() => {
    const aim=window.game.getAim(),radians=aim.phi*Math.PI/180;
    const expected=[-Math.cos(radians)*.95,.828575+.18+.95*.3,.635+Math.sin(radians)*.95];
    return window.camera.position.distanceTo({x:expected[0],y:expected[1],z:expected[2]})<.015;
  })
  await page.mouse.move(500,350)
  const beforeHeading = await page.evaluate(() => window.game.getAim().phi)
  await page.mouse.move(560,350)
  assert.notEqual(await page.evaluate(() => window.game.getAim().phi), beforeHeading, 'Horizontal mouse movement steers first-person heading')
  await page.mouse.move(8,8)
  const selectedHeading = await page.evaluate(() => window.game.getAim().phi)
  await page.mouse.click(8,8)
  assert.equal(await phase(), 'aim')
  assert.equal(await mode(), 'cue', 'First confirmation does not jump back to the free camera')
  await page.mouse.move(200,200)
  await page.mouse.move(260,200)
  await page.evaluate(() => window.game.setAim({phi:222,a:.2,b:-.3}))
  assert.equal(await page.evaluate(() => window.game.getAim().phi), selectedHeading, 'Direction locks only after first confirmation')
  assert.deepEqual(await page.evaluate(() => {const a=window.game.getAim();return[a.a,a.b]}), [.2,-.3])
  await page.mouse.click(8,8)
  assert.equal(await phase(), 'power')
  assert.equal(await mode(), 'cue')
  assert.equal(await page.evaluate(() => window.events.shots.length), 0, 'Contact confirmation does not fire the shot')
  await page.mouse.click(8,8,{button:'right'})
  await page.mouse.click(8,8,{button:'right'})
  assert.equal(await phase(), 'overview')
  assert.equal(await mode(), 'cue', 'Returning to heading keeps the default cue view')

  await page.evaluate(() => { window.game.resetCamera(true); return window.frames() })
  assert.equal(await mode(), 'free')
  const topPose = await pose()
  assert.ok(topPose[1] > 4 && Math.abs(topPose[0]) < .001, 'Top-view button actually frames the table from above')
  await page.evaluate(() => {
    window.game.setInteraction({canShoot:false}); // a menu/parameters drawer
    window.game.setInteraction({canShoot:true});
    return window.frames();
  })
  assert.equal(await mode(), 'free', 'Closing a modal does not erase an explicit top/free choice')
  assert.ok(distance(await pose(),topPose)<.002)
  await page.mouse.click(8,8)
  assert.equal(await phase(),'aim')
  await page.evaluate(()=>{
    window.game.setInteraction({canShoot:false});
    window.game.setShotPhase('overview'); // App resets preparation when opening a modal.
    window.game.setInteraction({canShoot:true});
  })
  assert.equal(await mode(),'free','A modal opened from contact also restores the manual overview')
  assert.ok(distance(await pose(),topPose)<.01,'Input-lock ordering must not discard the chosen top pose')
  await page.mouse.click(8,8)
  assert.equal(await phase(),'aim')
  await page.mouse.click(8,8,{button:'right'})
  assert.equal(await phase(),'overview')
  assert.equal(await mode(),'free','Backing out of contact restores an explicitly chosen overview')
  assert.ok(distance(await pose(),topPose)<.01,'The chosen top-view framing is restored as well as its mode')

  await page.evaluate(() => window.game.beginAimTurn())
  assert.equal(await mode(),'cue','A genuine new own shot resets the previous turn camera override')
  await page.evaluate(() => {
    window.game.setCameraMode('free');
    window.game.setInteraction({canShoot:false});
    window.game.setInteraction({canShoot:true});
  })
  assert.equal(await mode(),'free','The explicit free-camera toggle also survives temporary input locking')
  await page.evaluate(() => { window.game.beginAimTurn(); return window.frames(45) })
  const orbitBefore=await pose()
  await page.mouse.move(500,350)
  await page.mouse.down({button:'right'})
  await page.mouse.move(640,400,{steps:6})
  await page.mouse.up({button:'right'})
  await page.evaluate(() => window.frames())
  assert.equal(await mode(),'free','An explicit orbit gesture can leave first person')
  assert.equal(await phase(),'overview','Orbiting does not confirm heading')
  assert.ok(distance(await pose(),orbitBefore)>.05,'The same right-drag gesture actually rotates the camera')
  await page.evaluate(() => {window.game.setInteraction({canShoot:false});window.game.setInteraction({canShoot:true})})
  assert.equal(await mode(),'free','An explicit orbit choice survives modal permission changes')

  await page.evaluate(() => {
    window.game.beginAimTurn();
    window.game.setInteraction({canShoot:false,ownTurn:false}); // timeout, no shot/trajectory
    window.game.setShotPhase('overview');
  })
  assert.equal(await mode(),'free','A timeout gives the opponent an overview even without shot playback')
  await page.evaluate(()=>{
    window.game.setInteraction({canShoot:true}); // stale permission alone must not override ownership
    window.game.beginAimTurn();
  })
  assert.equal(await mode(),'free','An inactive/non-own turn is never treated as an own aiming turn')
  await page.evaluate(()=>{window.game.setInteraction({canShoot:true,ownTurn:true});window.game.beginAimTurn()})
  assert.equal(await mode(),'cue','A genuine new own turn restores first person after a timeout')

  await page.evaluate(() => {
    window.game.beginAimTurn();
    window.game.setShotPhase('power');
    window.game.setInteraction({canShoot:false});
    window.game.playShot({duration:.05,frames:[{t:0,balls:window.snapshot.balls},{t:.05,balls:window.snapshot.balls}]},Date.now());
  })
  assert.equal(await mode(),'free','Shot playback is not stuck looking out from behind the cue')
  await page.waitForFunction(() => window.events.playbacks===1)
  await page.evaluate(() => {
    window.game.setShotPhase('overview');
    window.game.setInteraction({canShoot:true});
    window.game.beginAimTurn();
  })
  assert.equal(await mode(),'cue','The next own shot after playback starts behind the cue again')
  await page.evaluate(() => {
    window.game.setInteraction({canShoot:false,canPlaceCueBall:true});
    window.game.beginAimTurn();
  })
  assert.equal(await mode(),'free','Ball-in-hand placement is never forced into the cue camera')
  await page.evaluate(() => {
    window.game.resetCamera(true);
    window.game.setInteraction({canShoot:true,canPlaceCueBall:false});
    window.game.beginAimTurn();
  })
  assert.equal(await mode(),'cue','Completing placement can begin heading in first person')
  await page.evaluate(() => {
    window.game.setInteraction({canShoot:false,spectator:true});
    window.game.beginAimTurn();
    window.game.setInteraction({canShoot:true});
  })
  assert.equal(await mode(),'free','Even an accidental canShoot flag cannot force a spectator into the player camera')

  await page.evaluate(() => {
    window.game.setInteraction({canShoot:true,spectator:false});
    window.game.beginAimTurn();
    // Portable touch-pointer input for both browser engines. Only native capture
    // bookkeeping is shimmed for synthetic pointer IDs; the renderer and camera are real.
    const canvas=document.querySelector('canvas');
    const set=canvas.setPointerCapture.bind(canvas),has=canvas.hasPointerCapture.bind(canvas);
    canvas.setPointerCapture=id=>id===901?undefined:set(id);
    canvas.hasPointerCapture=id=>id===901?false:has(id);
    window.touch=(type,x,y)=>canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:901,pointerType:'touch',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:y}));
    window.touchStart=window.game.getAim().phi;
    window.touch('pointerdown',400,350);
    window.touch('pointermove',470,350);
    window.touch('pointerup',470,350);
  })
  assert.notEqual(await page.evaluate(()=>window.game.getAim().phi),await page.evaluate(()=>window.touchStart),'Touch drag chooses direction in cue view')
  assert.equal(await phase(),'overview','A touch steering drag is not a heading confirmation')
  const touchHeading=await page.evaluate(()=>window.game.getAim().phi)
  await page.evaluate(()=>{window.touch('pointerdown',8,8);window.touch('pointerup',8,8)})
  assert.equal(await phase(),'aim','A separate touch tap confirms the chosen direction')
  assert.equal(await page.evaluate(()=>window.game.getAim().phi),touchHeading,'Touch confirmation does not recalculate the first-person direction from a table ray')
  assert.equal(await page.evaluate(()=>window.events.shots.length),0)
  assert.deepEqual(errors,[])
  await page.evaluate(()=>window.game.destroy())
  console.log(JSON.stringify({engine:engineName,defaultCueView:true,headingBeforeConfirmation:true,contactLock:true,topFreeOverride:true,modalOverridePreserved:true,orbitFromCue:true,newTurnReset:true,timeoutOverview:true,placementAndSpectatorFree:true,playbackReset:true,touchHeading:true,jsErrors:errors.length}))
} finally {
  await browser?.close()
  await viteServer?.close()
}
