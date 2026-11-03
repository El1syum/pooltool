// Offline derivative only. Does not edit the provided source or change game physics.
import path from 'node:path';
import {mkdir,writeFile,stat} from 'node:fs/promises';
import {toolImport,preparationPaths} from './tool_environment.mjs';
const {NodeIO}=await toolImport('@gltf-transform/core');
const {ALL_EXTENSIONS}=await toolImport('@gltf-transform/extensions');
const {dedup,prune,weld,simplify,textureCompress}=await toolImport('@gltf-transform/functions');
const {MeshoptSimplifier}=await toolImport('meshoptimizer');
const {default:sharp}=await toolImport('sharp');
const {input,output}=await preparationPaths();
await mkdir(path.dirname(output),{recursive:true});
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document=await io.read(input);
function report(){return document.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>({vertices:p.getAttribute('POSITION').getCount(),triangles:(p.getIndices()?.getCount()||p.getAttribute('POSITION').getCount())/3})));}
const before=report();
await MeshoptSimplifier.ready;
await document.transform(dedup(),weld(),simplify({simplifier:MeshoptSimplifier,ratio:0.05,error:0.003}),prune());
// Keep web-native textures and plain geometry; no Draco/Meshopt/KTX2 runtime decoder.
await document.transform(textureCompress({encoder:sharp,targetFormat:'webp',resize:[2048,2048],quality:92,effort:5}));
const root=document.getRoot();
for(const material of root.listMaterials()){
  material.setDoubleSided(false);
  const specular=material.getExtension('KHR_materials_specular');
  if(specular) specular.setSpecularColorFactor([1,1,1]);
}
await io.write(output,document);
const result={input,output,inputBytes:(await stat(input)).size,outputBytes:(await stat(output)).size,before,after:report(),textureSize:2048,ratioTarget:0.05,errorTolerance:0.003,notes:'UV-preserving simplification; plain GLB geometry; WebP textures. Source unchanged.'};
await writeFile(output.replace(/\.glb$/i,'.optimization.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
