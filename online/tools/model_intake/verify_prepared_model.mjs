/** Geometric verification, not a substitute for actual server gameplay testing. */
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {TABLE_REFERENCE,pocketHoles} from './playable_surface.mjs';
import {toolImport,preparationPaths} from './tool_environment.mjs';
const {NodeIO}=await toolImport('@gltf-transform/core');
const {ALL_EXTENSIONS}=await toolImport('@gltf-transform/extensions');
const THREE=await toolImport('three');
const {input}=await preparationPaths({outputRequired:false});
const document=await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(input),meshes=[];
for(const node of document.getRoot().listNodes())for(const primitive of node.getMesh()?.listPrimitives()||[]){
  const geometry=new THREE.BufferGeometry();for(const[key,name]of[['POSITION','position'],['NORMAL','normal']]){const a=primitive.getAttribute(key);if(a)geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(a.getArray()),a.getElementSize()));}
  if(primitive.getIndices())geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(primitive.getIndices().getArray()),1));const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.name=node.getName()||node.getMesh().getName();mesh.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));mesh.updateMatrixWorld(true);meshes.push(mesh);
}
const ray=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0),holes=pocketHoles();
function hit(x,z,far=1){ray.set(new THREE.Vector3(x,.3,z),down);ray.far=far;return ray.intersectObjects(meshes,false)[0];}
const gridFailures=[],grid=[];for(let ix=0;ix<17;ix++)for(let iz=0;iz<33;iz++){const x=(ix/16*2-1)*(TABLE_REFERENCE.width/2-.033),z=(iz/32*2-1)*(TABLE_REFERENCE.length/2-.033);if(holes.some(h=>Math.hypot(x-h.x,z-h.z)<h.radius+.002))continue;const top=hit(x,z);const sample={x,z,y:top?.point.y??null,name:top?.object.name??null};grid.push(sample);if(!top||Math.abs(top.point.y)>.002)gridFailures.push(sample);}
const pocketRays=holes.map(h=>{const top=hit(h.x,h.z,.6);return{id:h.id,hit:top?{y:top.point.y,name:top.object.name}:null};});
const entryRays=[];for(const h of holes){const vector=new THREE.Vector3(-Math.sign(h.x),0,Math.abs(h.z)<.01?0:-Math.sign(h.z)).normalize();for(const extra of[.02,.04,.06,.08]){const x=h.x+vector.x*(h.radius+extra),z=h.z+vector.z*(h.radius+extra),top=hit(x,z);entryRays.push({id:h.id,extra,x,z,y:top?.point.y??null,name:top?.object.name??null});}}
const result={input,gridSamples:grid.length,gridFailures,pocketRays,entryRays,openPockets:pocketRays.every(h=>!h.hit),flatCloth:gridFailures.length===0};
await writeFile(input.replace(/\.glb$/,'.geometry-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.openPockets||!result.flatCloth)process.exitCode=1;
