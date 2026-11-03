import {createServer} from '../../client/node_modules/vite/dist/node/index.js'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {mkdir,writeFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(here,'../../client')
const modulePath=process.env.PLAYWRIGHT_MODULE||path.resolve(root,'node_modules/playwright/index.mjs')
const playwright=await import(path.isAbsolute(modulePath)?pathToFileURL(modulePath).href:modulePath)
const engineName=process.env.BROWSER||'chromium'
const server=await createServer({root,configFile:false,optimizeDeps:{noDiscovery:true},server:{host:'127.0.0.1',port:4328,strictPort:true,fs:{allow:[path.resolve(here,'../../..')]}}})
let browser
try{
 await server.listen();browser=await playwright[engineName].launch({headless:true,...(engineName==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})})
 const page=await browser.newPage({viewport:{width:1800,height:1200},deviceScaleFactor:1})
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 const output=path.resolve(root,'tests/artifacts/model-intake/pack');await mkdir(output,{recursive:true})
 for(const mode of ['original','prepared','hybrid']){
  const prepared=mode!=='original',hybrid=mode==='hybrid'
  await page.goto('http://127.0.0.1:4328/@fs/'+path.resolve(here,'viewer.html').replaceAll('\\','/')+(hybrid?'?hybrid=1':prepared?'?prepared=1':''))
  await page.waitForFunction(()=>window.fixtureReady)
  for(const view of ['perspective','top','side']){await page.evaluate(view=>window.setView(view),view);await page.screenshot({path:path.join(output,`pack-${mode}-${view}.png`)})}
  if(prepared){await page.evaluate(()=>{window.setView('top');window.setOverlay(true)});await page.screenshot({path:path.join(output,`pack-${mode}-physical-pockets.png`)})}
  if(prepared){await page.evaluate(()=>{window.setOverlay(false);window.focusTable(0,'perspective')});await page.screenshot({path:path.join(output,`pack-table-1-${mode}-perspective.png`)});await page.evaluate(()=>{window.setOverlay(true);window.focusTable(0,'top')});await page.screenshot({path:path.join(output,`pack-table-1-${mode}-pocket-comparison.png`)})}
  if(hybrid){
   const report=await page.evaluate(()=>window.verifyHybrid(0));await writeFile(path.join(output,'hybrid-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));assert.equal(report.failures.length,0);assert.ok(report.maxBedDeviation<1e-5)
   const bytes=await page.evaluate(()=>window.exportHybrid(0));await writeFile(path.join(output,'candidates/pack-table-1-playable-hybrid-local-only.glb'),Buffer.from(bytes));console.log(`Hybrid exported ${bytes.length} bytes`)
  }
 }
 assert.deepEqual(errors,[]);console.log(`${engineName}: rendered original/prepared six tables and physical pocket overlay; zero JS errors`)
}finally{await browser?.close();await server.close()}
