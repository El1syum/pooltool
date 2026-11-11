/** Read-only delivery check for the actual prepared GLB's cushion/jaw meshes. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {toolImport} from './tool_environment.mjs';
import {pocketHoles} from './playable_surface.mjs';
import {auditPocketTopology,auditPocketBores} from './pocket_topology.mjs';
import {assertDistinctArtifacts} from './pocket_artifact_paths.mjs';
import {auditWoodAtlas} from './pocket_wood_atlas.mjs';

const{values}=parseArgs({options:{input:{type:'string'},report:{type:'string'},strict:{type:'boolean',default:false}}});
assert.ok(values.input,'Usage: --input actual-model.glb [--report ignored-artifact-path.json] [--strict]');
const input=path.resolve(values.input),source=await readFile(input),hash=data=>createHash('sha256').update(data).digest('hex'),sourceHash=hash(source);
if(values.report)await assertDistinctArtifacts(input,[values.report]);
const{NodeIO}=await toolImport('@gltf-transform/core'),{ALL_EXTENSIONS}=await toolImport('@gltf-transform/extensions'),THREE=await toolImport('three');
const document=await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(input),root=new THREE.Group();
for(const node of document.getRoot().listNodes())for(const primitive of node.getMesh()?.listPrimitives()??[]){
  const geometry=new THREE.BufferGeometry();
  for(const[semantic,name]of[['POSITION','position'],['NORMAL','normal']]){const attribute=primitive.getAttribute(semantic);if(attribute)geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(attribute.getArray()),attribute.getElementSize()))}
  if(primitive.getIndices())geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(primitive.getIndices().getArray()),1));
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.name=node.getName()||node.getMesh().getName();mesh.applyMatrix4(new THREE.Matrix4().fromArray(node.getWorldMatrix()));root.add(mesh);
}
const solidRole=object=>/Cushion|Jaw|Upper_Wood_Deck|Open_Pocket_Well/i.test(object.name);
const sharp=(await toolImport('sharp')).default;
const report={input,sourceHash,...auditPocketTopology(THREE,root,pocketHoles(),{meshPredicate:solidRole}),...auditPocketBores(THREE,root,pocketHoles()),...await auditWoodAtlas(document,sharp)};
if(values.report){const target=path.resolve(values.report);assert.notEqual(target.toLowerCase(),input.toLowerCase());await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2))}
const counts=Object.fromEntries(Object.entries(report).filter(([,value])=>Array.isArray(value)).map(([key,value])=>[key,value.length]));
console.log(JSON.stringify({input,sourceHash,meshes:report.meshes,triangles:report.triangles,pocketFaces:report.pocketFaces,pocketSamples:report.pocketSamples,woodMeshes:report.woodMeshes,woodSamples:report.woodSamples,...counts}));
assert.equal(hash(await readFile(input)),sourceHash,'Audit must leave the GLB unchanged');
if(values.strict){assert.ok(report.meshes>0);assert.ok(Object.values(report.pocketFaces).every(count=>count>0));for(const[key,count]of Object.entries(counts))assert.equal(count,0,`${key}: ${JSON.stringify(report[key].slice(0,8))}`)}
