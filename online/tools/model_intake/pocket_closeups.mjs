/** Read-only GLB pocket inspection. Captures are art evidence, not gameplay proof. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {toolImport} from './tool_environment.mjs';
import {pocketHoles} from './playable_surface.mjs';
import {assertDistinctArtifacts} from './pocket_artifact_paths.mjs';

const {values}=parseArgs({options:{input:{type:'string'},'output-dir':{type:'string'},label:{type:'string',default:'Pocket geometry'}}});
assert.ok(values.input,'Usage: --input actual-model.glb [--output-dir ignored-artifact-directory] [--label text]');
const input=path.resolve(values.input),bytes=await readFile(input);
const hash=data=>createHash('sha256').update(data).digest('hex'),sourceHash=hash(bytes);
const output=path.resolve(values['output-dir']||'online/client/tests/artifacts/pocket-audit');
await mkdir(output,{recursive:true});
await assertDistinctArtifacts(input,[...pocketHoles().flatMap(h=>['inward','top'].map(angle=>`${h.id}-${angle}.png`)),'six-pockets-inward.png','six-pockets-top.png','overview.png','capture.json'].map(name=>path.join(output,name)));
const client=path.resolve('online/client');
const {createServer}=await import(pathToFileURL(path.join(client,'node_modules/vite/dist/node/index.js')).href);
const modulePath=process.env.PLAYWRIGHT_MODULE;
const {chromium}=modulePath?await import(path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath):await toolImport('playwright');
const sharp=(await toolImport('sharp')).default;
const html=await readFile(new URL('./preview-template.html',import.meta.url),'utf8');
const server=await createServer({root:client,logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:true,ws:false}});
let browser;
try{
  await server.listen();
  const base=`http://127.0.0.1:${server.httpServer.address().port}`;
  const transformed=await server.transformIndexHtml('/pocket-closeups.html',html);
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:640,height:480}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/pocket-closeups.html',route=>route.fulfill({contentType:'text/html',body:transformed}));
  await page.route('**/generated-source.glb',route=>route.fulfill({contentType:'model/gltf-binary',body:bytes}));
  await page.goto(base+'/pocket-closeups.html');
  await page.waitForFunction(()=>window.auditReady,null,{timeout:60000});
  const shots=[];
  for(const angle of ['inward','top'])for(const hole of pocketHoles()){
    const geometry=await page.evaluate(({hole,angle,label})=>{
      const T=window.THREE,root=window.auditRoot,camera=window.auditCamera;
      root.updateMatrixWorld(true);
      const target=new T.Vector3(hole.x,.012,hole.z).applyMatrix4(root.matrixWorld);
      const inward=new T.Vector3(-Math.sign(hole.x),0,Math.abs(hole.z)<.01?0:-Math.sign(hole.z)).normalize();
      camera.aspect=640/480;camera.fov=38;camera.up.set(0,1,0);
      camera.position.copy(target).addScaledVector(inward,angle==='inward'?.31:.045);camera.position.y+=angle==='inward'?.17:.42;
      camera.lookAt(target);camera.updateProjectionMatrix();
      document.querySelector('#label').textContent=`${label} · ${hole.id} · ${angle}`;
      window.auditRenderer.render(window.auditScene,camera);
      return {target:target.toArray(),camera:camera.position.toArray()};
    },{hole,angle,label:values.label});
    const filename=`${hole.id}-${angle}.png`;
    await page.screenshot({path:path.join(output,filename)});
    shots.push({id:hole.id,angle,filename,...geometry});
  }
  for(const angle of ['inward','top']){
    const selected=shots.filter(shot=>shot.angle===angle);
    await sharp({create:{width:1920,height:960,channels:3,background:'#1d2529'}}).composite(selected.map((shot,index)=>({input:path.join(output,shot.filename),left:index%3*640,top:Math.floor(index/3)*480}))).png().toFile(path.join(output,`six-pockets-${angle}.png`));
  }
  await page.setViewportSize({width:1400,height:1000});
  await page.evaluate(()=>{window.auditRenderer.setSize(1400,1000);window.auditCamera.aspect=1.4;window.auditCamera.updateProjectionMatrix();window.auditView('threequarter')});
  await page.screenshot({path:path.join(output,'overview.png')});
  assert.deepEqual(errors,[]);
  assert.equal(hash(await readFile(input)),sourceHash,'Read-only capture must not change the source GLB');
  const report={input,sourceHash,bytes:bytes.length,shots,errors,scope:'Actual GLB/Three.js art capture; not a gameplay or collision certification'};
  await writeFile(path.join(output,'capture.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({input,output,sourceHash,pockets:6,closeups:12,errors:0}));
}finally{await browser?.close();await server.close();}
