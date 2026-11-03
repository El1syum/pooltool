// Local preparation + real GLTFLoader/renderer tests. The library adapter below
// is an explicit in-memory fixture; server authorization has separate API tests.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
import { minimalGlb } from './model-fixture.mjs'

const module = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(module) ? pathToFileURL(module).href : module)
const pngModule=process.env.PNG_MODULE||'pngjs'
const { PNG }=await import(path.isAbsolute(pngModule)?pathToFileURL(pngModule).href:pngModule)
const engineName = process.env.BROWSER || 'chromium'
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/model-workshop')
await mkdir(artifacts,{recursive:true})
const server = await createServer({logLevel:'error',server:{host:'127.0.0.1',port:4316,strictPort:true}})
let browser
try {
 await server.listen()
 browser=await playwright[engineName].launch({headless:true,...(engineName==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}: {})})
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 const page=await context.newPage(),errors=[],external=[]
 page.on('pageerror',error=>errors.push(error.message))
 page.on('request',request=>{if(request.url().includes('attacker.invalid'))external.push(request.url())})
 const bytes=minimalGlb(),array=Array.from(new Uint8Array(bytes))
 await page.route('**/models/library/*.glb',route=>route.fulfill({contentType:'model/gltf-binary',body:Buffer.from(bytes)}))
 await page.goto('http://127.0.0.1:4316/tests/model-workshop-fixture.html')
 await page.waitForFunction(()=>window.fixtureReady)
 // Rebuilding from the placeholder .8m cloth to an authoritative server height
 // must remove the previous bed, not reattach its disposed child meshes.
 const tableRebuilds=[]
 for(const [height,width,length] of [[.8,1.27,2.54],[.65,1.18,2.36],[.9,1.42,2.84],[.75,1.27,2.54]]){
   const result=await page.evaluate(({height,width,length})=>{
     const{THREE}=window.modelModules,scene=window.fixtureRenderScene
     window.modelScene.setCalibrationOverlay(false)
     window.modelScene.setState({table:{width,length,height,pockets:[]},cueBallId:'cue',balls:[{id:'cue',position:[width/2,length/2,.028575],radius:.028575}]})
     window.modelScene.resetCamera(true)
     scene.updateMatrixWorld(true)
     const beds=[],meshes=[];let cue
     scene.traverse(object=>{
       if(object.isMesh)meshes.push(object)
       if(object.geometry?.type==='BoxGeometry'&&object.geometry.parameters.height===.025)beds.push(object)
       if(object.userData.ballId==='cue')cue=object
     })
     const ray=new THREE.Raycaster(new THREE.Vector3(0,3,0),new THREE.Vector3(0,-1,0))
     const hits=ray.intersectObjects(meshes,false).filter(hit=>hit.object.visible&&hit.object.material?.visible!==false)
     return{height,beds:beds.length,bedWidth:beds[0]?.geometry.parameters.width,bedLength:beds[0]?.geometry.parameters.depth,bedY:beds[0]?.position.y,cueY:cue?.position.y,firstHitBall:hits[0]?.object.userData.ballId}
   },{height,width,length})
   assert.equal(result.beds,1,`Old procedural beds must be removed at height ${height}: ${JSON.stringify(result)}`)
   assert.equal(result.bedY,height-.0125);assert.equal(result.cueY,height+.028575)
   assert.equal(result.bedWidth,width);assert.equal(result.bedLength,length)
   assert.equal(result.firstHitBall,'cue',`The cloth must not occlude the actual cue ball: ${JSON.stringify(result)}`)
   await page.waitForTimeout(50)
   const screenshot=await page.locator('#stage canvas').screenshot({path:path.join(artifacts,`${engineName}-table-height-${height}.png`)})
   const png=PNG.sync.read(screenshot);let visibleCuePixels=0
   for(let y=png.height/2-18;y<png.height/2+18;y++)for(let x=png.width/2-18;x<png.width/2+18;x++){
     const offset=(Math.floor(y)*png.width+Math.floor(x))*4,[r,g,b]=png.data.subarray(offset,offset+3)
     if(r>145&&g>145&&b>120&&Math.max(r,g,b)-Math.min(r,g,b)<65)visibleCuePixels++
   }
   assert.ok(visibleCuePixels>30,`The real WebGL cue ball must be visibly rendered after height ${height}, cream pixels=${visibleCuePixels}`)
   tableRebuilds.push({...result,visibleCuePixels})
 }
 const imported=await page.evaluate(async values=>{
   const{store,types}=window.modelModules
   const asset=await store.importLocalModel(new File([new Uint8Array(values)],'table-test.glb',{type:'model/gltf-binary'}))
   const profile=types.emptyVisualAssetProfile();profile.table=types.defaultModelSlot(asset.name,{kind:'local',id:asset.id})
   await store.saveVisualAssetProfile(profile)
   const report=await window.modelScene.setVisualAssets(profile)
   return{id:asset.id,report}
 },array)
 assert.equal(imported.report.table.meshes,1);assert.equal(imported.report.table.vertices,3);assert.deepEqual(imported.report.table.materials,['Cloth'])
 await page.reload();await page.waitForFunction(()=>window.fixtureReady)
 const restored=await page.evaluate(async()=>{
   const profile=await window.modelModules.store.loadVisualAssetProfile()
   return{profile,report:await window.modelScene.setVisualAssets(profile)}
 })
 assert.equal(restored.profile.table.source.id,imported.id);assert.equal(restored.report.table.meshes,1)
 const styles=await page.evaluate(async()=>{
   const{THREE,VisualAssetManager,store}=window.modelModules,scene=new THREE.Scene(),replacements=[]
   const manager=new VisualAssetManager(scene,{tableHeight:()=>.8,onTableReplacement:value=>replacements.push(value),onEnvironmentReplacement:()=>{}})
   const profile=await store.loadVisualAssetProfile();await manager.setProfile(profile)
   const mesh=scene.getObjectByName('WorkshopTriangle'),baseline=mesh.material.color.getHexString()
   profile.table.position=[.12,-.02,.3];profile.table.rotation=[0,90,0];profile.table.scale=[2,2,2];profile.table.materials.Cloth={color:'#ff0000',roughness:.3}
   await manager.setProfile(profile)
   const changed={position:scene.children[0].position.toArray(),rotation:scene.children[0].rotation.y,scale:scene.children[0].scale.toArray(),color:mesh.material.color.getHexString(),roughness:mesh.material.roughness}
   profile.table.materials={};await manager.setProfile(profile)
   const reset=mesh.material.color.getHexString()
   let disposed=0;mesh.geometry.addEventListener('dispose',()=>disposed++)
   await manager.setProfile({version:1,table:null,environment:null});manager.destroy()
   return{changed,baseline,reset,disposed,children:scene.children.length,replacements}
 })
 assert.deepEqual(styles.changed.position,[.12,.78,.3]);assert.equal(styles.changed.rotation,Math.PI/2);assert.deepEqual(styles.changed.scale,[2,2,2]);assert.equal(styles.changed.color,'ff0000');assert.equal(styles.changed.roughness,.3);assert.equal(styles.reset,styles.baseline);assert.equal(styles.disposed,1);assert.equal(styles.children,0);assert.equal(styles.replacements.at(-1),false)
 const rejected=await page.evaluate(async values=>{
   try{await window.modelModules.store.importLocalModel(new File([new Uint8Array(values)],'unsafe.glb'));return false}catch(error){return String(error.message)}
 },Array.from(new Uint8Array(minimalGlb(value=>({...value,images:[{uri:'https://attacker.invalid/a.png'}]})))))
 assert.match(rejected,/Внешние файлы/);assert.deepEqual(external,[])
 const race=await page.evaluate(async()=>{
   const{types}=window.modelModules,profile=types.emptyVisualAssetProfile()
   profile.environment=types.defaultModelSlot('Race model',{kind:'url',url:'/models/library/00000000000000000000000000000099.glb'})
   const pending=window.modelScene.setVisualAssets(profile)
   await window.modelScene.setVisualAssets(types.emptyVisualAssetProfile());await pending
   return window.modelScene.getVisualAssetReport()
 })
 assert.equal(race.environment,null);assert.deepEqual(race.errors,{})
 await page.goto('http://127.0.0.1:4316/tests/model-workshop-fixture.html?mode=workshop')
 await page.waitForFunction(()=>window.fixtureReady)
 await page.getByRole('heading',{name:'Мастерская моделей',exact:true}).waitFor()
 await page.getByLabel('Импорт GLB модели',{exact:true}).setInputFiles({name:'prepared-table.glb',mimeType:'model/gltf-binary',buffer:Buffer.from(bytes)})
 await page.getByText('GLB загружен в локальный черновик.',{exact:false}).waitFor()
 assert.equal(await page.evaluate(()=>window.uploadCalls.length),0,'Import/preview must not upload before an explicit publish')
 await page.getByLabel('Положение, м X',{exact:true}).fill('0.12')
 await page.getByRole('button',{name:'Опубликовать общую сцену',exact:true}).click()
 await page.getByText('Общая сцена опубликована.',{exact:false}).waitFor()
 const publication=await page.evaluate(()=>({uploads:window.uploadCalls.map(({name,role})=>({name,role})),published:window.publishCalls[0],applied:window.appliedProfile}))
 assert.deepEqual(publication.uploads,[{name:'prepared-table.glb',role:'table'}]);assert.equal(publication.published.selection.tableId,'00000000000000000000000000000001');assert.equal(publication.published.configs['00000000000000000000000000000001'].position[0],.12);assert.equal(publication.applied.table.source.kind,'url')
 await page.evaluate(()=>window.libraryState.assets.push({...window.libraryState.assets[0],id:'00000000000000000000000000000099',name:'Disabled table',enabled:false}))
 await page.getByRole('button',{name:'Обновить',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'Disabled table',exact:false}).first().isDisabled(),true,'Disabled files must not be selected before restoring')
 await page.getByRole('button',{name:'Восстановить Disabled table',exact:true}).click()
 await page.getByText('Модель восстановлена в библиотеке.',{exact:false}).waitFor()
 const restoration=await page.evaluate(()=>({update:window.updateCalls.at(-1),selection:window.libraryState.profile,publishCount:window.publishCalls.length}))
 assert.deepEqual(restoration.update,{id:'00000000000000000000000000000099',patch:{enabled:true}})
 assert.equal(restoration.selection.tableId,'00000000000000000000000000000001');assert.equal(restoration.publishCount,1,'Restoring a model must not publish or select it')
 await page.screenshot({path:path.join(artifacts,`${engineName}-workshop.png`),fullPage:true})
 await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Workshop must fit a narrow viewport')
 await page.screenshot({path:path.join(artifacts,`${engineName}-workshop-mobile.png`),fullPage:true})
 await page.goto('http://127.0.0.1:4316/tests/model-workshop-fixture.html?mode=workshop&readonly=1')
 await page.waitForFunction(()=>window.fixtureReady)
 assert.equal(await page.getByLabel('Импорт GLB модели',{exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'Опубликовать общую сцену',exact:true}).count(),0)
 await page.getByRole('button',{name:'Войти администратором',exact:true}).click();assert.equal(await page.evaluate(()=>window.adminRequests),1)
 assert.deepEqual(errors,[])
 console.log(JSON.stringify({engine:engineName,tableRebuilds,meshCount:imported.report.table.meshes,vertices:imported.report.table.vertices,idbReload:true,materialReset:true,disposedOnce:true,staleLoadCancelled:true,publishAdapter:true,restoreWithoutPublish:true,readonly:true,jsErrors:errors.length}))
}finally{await browser?.close();await server.close()}
