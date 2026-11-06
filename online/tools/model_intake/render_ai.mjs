import {readFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const client=path.resolve('online/client');
const {createServer}=await import(pathToFileURL(path.join(client,'node_modules/vite/dist/node/index.js')).href);
import {toolImport,preparationPaths} from './tool_environment.mjs';
const {chromium}=await toolImport('playwright');
const {input}=await preparationPaths({outputRequired:false});
const bytes=await readFile(input);
const prefix=path.basename(input,'.glb');
const artifacts=path.join(client,'tests/artifacts/model-intake/ai');await mkdir(artifacts,{recursive:true});
await copyFile(new URL('./preview-template.html',import.meta.url),path.join(artifacts,'preview.html'));
const server=await createServer({root:client,logLevel:'error',server:{host:'127.0.0.1',port:4326,strictPort:true,ws:false}});await server.listen();
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {const page=await browser.newPage({viewport:{width:1400,height:1000}});page.on('pageerror',e=>console.error(e.message));await page.route('**/generated-source.glb',route=>route.fulfill({contentType:'model/gltf-binary',body:bytes}));await page.goto('http://127.0.0.1:4326/tests/artifacts/model-intake/ai/preview.html');await page.waitForFunction(()=>window.auditReady,null,{timeout:120000});for(const orientation of ['raw','horizontal']){await page.evaluate(n=>window.auditOrientation(n),orientation);for(const name of ['threequarter','front','back','edge','top']){await page.evaluate(n=>window.auditView(n),name);await page.screenshot({path:path.join(artifacts,`${prefix}-${orientation}-${name}.png`)});}}console.log('Rendered GLB in raw and corrected orientations, five views each');}finally{await browser.close();await server.close();}
