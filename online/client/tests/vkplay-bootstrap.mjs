// Explicit fake-platform integration, NOT proof of live VK Play/GAS acceptance.
// Runs the actual App in an iframe with a stub SDK, stub exchange and stub WS.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
const modulePath=process.env.PLAYWRIGHT_MODULE||'playwright'
const playwright=await import(path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath)
const artifacts=path.resolve('tests/artifacts/vkplay-bootstrap')
await mkdir(artifacts,{recursive:true})
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:4334,strictPort:true}})
const base='http://127.0.0.1:4334'
const guestToken='existing-test-guest-token'
const tokens={ '123':'platform-session-A', '456':'platform-session-B' }
const userFor=uid=>({id:`platform-internal-${uid}`,displayName:uid==='123'?'VK Player A':'VK Player B',elo:1000,games:0,wins:0,losses:0,settings:{}})
const room={id:'room-A',code:'AAA111',hostId:'platform-internal-123',players:[{id:'platform-internal-123',displayName:'VK Player A',ready:true},{id:'opponent',displayName:'Opponent',ready:true}],spectators:[],status:'playing',settings:{turnSeconds:60,ranked:false},matchId:'match-A'}
const match={id:'match-A',roomId:'room-A',revision:0,turn:0,status:'active',players:room.players,currentPlayer:0,deadline:new Date(Date.now()+180000).toISOString(),startedAt:new Date().toISOString(),ranked:false,snapshot:{balls:[{id:'cue',position:[.5,.5,.028575],radius:.028575,state:0,pocketed:false}],table:{width:.9906,length:1.9812,height:.708,renderHeight:.708,pockets:[]},currentPlayer:0,ballInHand:false,needsPlacement:false,hittable:[],groups:[null,null]}}
let browser
try{
 await server.listen()
 for(const engine of (process.env.BROWSERS||'chromium,webkit').split(',')){
  browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})})
  const context=await browser.newContext({viewport:{width:1280,height:900}})
  await context.addInitScript(({guestToken})=>{
   localStorage.setItem('pooltool.token',guestToken)
   localStorage.setItem('pooltool.pendingCommand',JSON.stringify({matchId:'guest-match',command:{commandId:'guest-pending-command',type:'surrender',expectedRevision:0,payload:{}}}))
   localStorage.setItem('pooltool.room','GUEST1');localStorage.setItem('pooltool.match','guest-match')
  },{guestToken})
  const page=await context.newPage(),exchanges=[],authFrames=[],unexpected=[],errors=[]
  let sdkLoads=0,uid='123',socketA=null,socketB=null,holdLate=false,releaseLate=null,lateArrived=null,inflightCommands=0
  let emptyRestore=false,holdReplayLeave=false,releaseReplayLeave=null,replayLeaveArrived=null,crossIdentityReplays=0
  const replayRoom={...room,id:'room-B',code:'BBB222',hostId:'platform-internal-456',status:'finished',matchId:'match-B',settings:{...room.settings,solo:true},players:[userFor('456'),{id:'opponent',displayName:'Opponent',bot:'easy'}]}
  const replayMatch={...match,id:'match-B',roomId:'room-B',status:'finished',revision:1,winnerId:'opponent',finishedAt:new Date().toISOString(),players:replayRoom.players}
  page.on('pageerror',error=>errors.push(error.message))
  await context.route('**/tests/vkplay-shell',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><iframe name="pooltool" src="/tests/vkplay-app-fixture.html?platform=vkplay" style="border:0;width:100vw;height:100vh"></iframe>'}))
  await context.route('https://vkplay.ru/app/42/static/mailru.core.js',route=>{
   sdkLoads++
   return route.fulfill({contentType:'text/javascript',body:`window.fixtureUid='123';window.iframeApi=async function(callbacks){return {getLoginStatus(){queueMicrotask(()=>callbacks.getLoginStatusCallback(2))},authUser(){throw Error('Unexpected popup')},registerUser(){throw Error('Unexpected registration')},reloadWindow(){throw Error('Unexpected reload')},getAuthToken(){queueMicrotask(()=>callbacks.getAuthTokenCallback({status:'ok',uid:window.fixtureUid,hash:'otp-'+window.fixtureUid}))}}}`})
  })
  await context.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),body=request.postDataJSON()
   const reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)})
   if(url.pathname==='/api/auth/config')return reply({guestEnabled:true,vkPlay:{enabled:true,configured:true,appId:'42'}})
   if(url.pathname==='/api/auth/vkplay'){
    exchanges.push(body);assert.equal(request.headers().authorization,undefined,'The cached guest token must never accompany a platform exchange')
    assert.equal(body.uid,uid);assert.equal(body.hash,`otp-${uid}`)
    return reply({token:tokens[uid],user:userFor(uid)})
   }
   if(url.pathname==='/api/auth/guest'){unexpected.push('guest login');return reply({detail:'Guest forbidden in this explicit platform test'})}
   if(url.pathname==='/api/assets/library')return reply({version:1,assets:[],profile:{tableId:null,environmentId:null}})
   if(url.pathname==='/api/me/current'){
    const isA=request.headers().authorization===`Bearer ${tokens['123']}`
    if(isA&&holdLate){holdLate=false;lateArrived?.();await new Promise(resolve=>releaseLate=resolve)}
    return reply(isA&&!emptyRestore?{room,match,queue:{queued:false}}:{room:null,match:null,queue:{queued:false}})
   }
   if(url.pathname==='/api/matches/match-A')return reply({match})
   if(url.pathname==='/api/matches/match-B')return reply({match:replayMatch})
   if(url.pathname==='/api/rooms/BBB222/leave'&&holdReplayLeave){
    holdReplayLeave=false;replayLeaveArrived?.();await new Promise(resolve=>releaseReplayLeave=resolve)
    return reply({})
   }
   if(url.pathname==='/api/solo'){
    crossIdentityReplays++
    return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Unexpected cross-identity replay'})})
   }
   if(url.pathname==='/api/me')return reply({user:userFor(uid)})
   if(url.pathname==='/api/me/history')return reply({matches:[]})
   if(url.pathname==='/api/telemetry/events')return reply({acceptedIds:(body?.events||[]).map(value=>value.id)})
   if(url.pathname==='/api/me/settings')return reply({settings:{}})
   if(url.pathname.includes('/commands'))unexpected.push('resumed guest command')
   unexpected.push(url.pathname);return reply({})
  })
  await context.routeWebSocket('**/ws',socket=>{
   socket.onMessage(raw=>{
    const value=JSON.parse(raw)
    if(value.type==='auth'){
     authFrames.push(value);const current=value.token===tokens['123']?'123':'456'
     assert.equal(value.token,tokens[current]);if(current==='123')socketA=socket;else socketB=socket
     socket.send(JSON.stringify({type:'authenticated',user:userFor(current),serverTime:Date.now()}))
     socket.send(JSON.stringify({type:'restored',...(current==='123'&&!emptyRestore?{room,match}:{room:null,match:null}),queue:{queued:false}}))
    }else if(value.type==='ping')socket.send(JSON.stringify({type:'pong',clientTime:value.clientTime,serverTime:Date.now()}))
    else if(value.type==='command')inflightCommands++ // Deliberately do not ACK A's test shot.
   })
  })
  await page.goto(`${base}/tests/vkplay-shell`)
  const frame=page.frame({name:'pooltool'});assert.ok(frame)
  await frame.getByTestId('match-hud').waitFor({timeout:30000})
  assert.equal(exchanges.length,1);assert.equal(authFrames.length,1)
  assert.equal(await frame.evaluate(()=>localStorage.getItem('pooltool.token')),guestToken)
  await frame.getByRole('button',{name:'Параметры удара',exact:true}).click()
  await frame.getByRole('button',{name:'Удар',exact:true}).click()
  await page.waitForTimeout(30)
  assert.equal(inflightCommands,1)
  // Hold a real fetch response from A, then switch SDK identity through a denied
  // websocket session. The late response must not restore A's private match.
  holdLate=true
  const arrived=new Promise(resolve=>lateArrived=resolve)
  await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
  await arrived
  socketA.close({code:1008,reason:'Test session invalidated'})
  await frame.getByTestId('vkplay-entry').waitFor()
  assert.equal(await frame.getByTestId('match-hud').count(),0)
  uid='456';await frame.evaluate(()=>window.fixtureUid='456')
  await frame.getByRole('button',{name:'Повторить вход',exact:true}).click()
  await frame.getByRole('heading',{name:'Pooltool',exact:true}).waitFor()
  releaseLate();await page.waitForTimeout(250)
  assert.equal(exchanges.length,2);assert.equal(authFrames.length,2);assert.equal(sdkLoads,1)
  assert.equal(await frame.getByTestId('match-hud').count(),0)
  assert.doesNotMatch(await frame.locator('body').innerText(),/VK Player A|AAA111|match-A/)
  assert.match(await frame.locator('body').innerText(),/VK Player B/)
  const storage=await frame.evaluate(()=>Object.fromEntries(Object.entries(localStorage)))
  assert.equal(storage['pooltool.token'],guestToken);assert.equal(storage['pooltool.room'],'GUEST1');assert.equal(storage['pooltool.match'],'guest-match')
  assert.match(storage['pooltool.pendingCommand'],/guest-pending-command/)
  assert.doesNotMatch(JSON.stringify(storage),/platform-session-[AB]|otp-123|otp-456/)
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.equal(inflightCommands,1,'The old shot must not replay after identity change')
  await page.screenshot({path:path.join(artifacts,`${engine}-identity-B.png`),fullPage:true})

  // A pending "play again" is an intent owned by B. Deliberately delay only
  // its fake leave response, switch to A with an empty account, then release B.
  // A stale continuation must not create a new solo game under A's credentials.
  socketB.send(JSON.stringify({type:'restored',room:replayRoom,match:replayMatch,queue:{queued:false}}))
  await frame.locator('.result-panel').waitFor()
  holdReplayLeave=true
  const replayArrived=new Promise(resolve=>replayLeaveArrived=resolve)
  await frame.locator('.result-panel').getByRole('button',{name:'Сыграть ещё',exact:true}).click()
  await replayArrived
  assert.equal(await frame.locator('.result-panel').getByRole('button',{name:'Сыграть ещё',exact:true}).isDisabled(),true)
  socketB.close({code:1008,reason:'Test replay identity invalidated'})
  await frame.getByTestId('vkplay-entry').waitFor()
  emptyRestore=true;uid='123';await frame.evaluate(()=>window.fixtureUid='123')
  await frame.getByRole('button',{name:'Повторить вход',exact:true}).click()
  await frame.getByRole('heading',{name:'Pooltool',exact:true}).waitFor()
  releaseReplayLeave();await page.waitForTimeout(250)
  assert.equal(crossIdentityReplays,0,'An old account replay must never POST /api/solo for the new identity')
  assert.equal(await frame.locator('.result-panel').count(),0)
  assert.equal(await frame.getByTestId('match-hud').count(),0)
  assert.match(await frame.locator('body').innerText(),/VK Player A/)
  assert.doesNotMatch(await frame.locator('body').innerText(),/VK Player B|BBB222|match-B/)
  const mainActions=frame.getByRole('navigation',{name:'Главное меню',exact:true})
  for(const label of ['Играть','Настройки','Профиль','Выход'])assert.equal(await mainActions.getByRole('button',{name:label,exact:true}).isEnabled(),true)
  assert.equal(exchanges.length,3);assert.equal(authFrames.length,3)
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(artifacts,`${engine}-replay-identity-A.png`),fullPage:true})
  console.log(JSON.stringify({engine,fakePlatform:true,actualApp:true,guestTokenUntouched:true,platformSessionMemoryOnly:true,freshIdentityAfterDeniedSession:true,latePrivateMatchRejected:true,crossIdentityReplayRejected:true,newIdentityMenuEnabled:true,sdkLoads,exchanges:exchanges.length,jsErrors:errors.length}))
  await context.close();await browser.close();browser=null
 }
}finally{await browser?.close();await server.close()}
