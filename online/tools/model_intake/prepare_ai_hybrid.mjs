// Offline derivative: keep AI decorative shell, rebuild all functional-looking play parts.
import path from 'node:path';
import {mkdir,stat,writeFile} from 'node:fs/promises';
import {buildPlayingSurface,clipGeometry,pocketHoles,TABLE_REFERENCE} from './playable_surface.mjs';
import {toolImport,preparationPaths} from './tool_environment.mjs';
const {NodeIO}=await toolImport('@gltf-transform/core');
const {ALL_EXTENSIONS}=await toolImport('@gltf-transform/extensions');
const {weld,prune,dedup}=await toolImport('@gltf-transform/functions');
const THREE=await toolImport('three');
const {input,output}=await preparationPaths();
await mkdir(path.dirname(output),{recursive:true});
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),document=await io.read(input),buffer=document.getRoot().listBuffers()[0];
function accessor(name,type,array){return document.createAccessor(name,buffer).setType(type).setArray(array);}
function applyGeometry(primitive,geometry,name){
  for(const key of primitive.listSemantics())primitive.setAttribute(key,null);
  for(const[key,semantic,type]of[['position','POSITION','VEC3'],['normal','NORMAL','VEC3'],['uv','TEXCOORD_0','VEC2']])if(geometry.getAttribute(key))primitive.setAttribute(semantic,accessor(`${name}_${key}`,type,new Float32Array(geometry.getAttribute(key).array)));
  primitive.setIndices(geometry.index?accessor(`${name}_indices`,'SCALAR',new Uint32Array(geometry.index.array)):null);
}
const source=document.getRoot().listMeshes()[0].listPrimitives()[0],sourceNode=document.getRoot().listNodes()[0];
const geometry=new THREE.BufferGeometry();
for(const[semantic,name]of[['POSITION','position'],['NORMAL','normal'],['TEXCOORD_0','uv']]){const a=source.getAttribute(semantic);if(a)geometry.setAttribute(name,new THREE.BufferAttribute(new Float32Array(a.getArray()),a.getElementSize()));}
if(source.getIndices())geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(source.getIndices().getArray()),1));
const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal');
const sx=1.31/.609934,sy=2.15,sz=2.30/1.030865;
for(let i=0;i<p.count;i++){
  const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
  p.setXYZ(i,(z+.305)*sx,(y-.0381)*sy+.025,(-x+.0002585)*sz);
  const nx=n.getX(i),ny=n.getY(i),nz=n.getZ(i),v=new THREE.Vector3(nz/sx,ny/sy,-nx/sz).normalize();n.setXYZ(i,v.x,v.y,v.z);
}
const clipped=clipGeometry(THREE,geometry,{inner:{halfX:.565,halfZ:1.06,minY:-.035},holes:pocketHoles(TABLE_REFERENCE,.009),circleSegments:64});
applyGeometry(source,clipped,'AI_Decorative_Shell');sourceNode.setName('AI_Decorative_Shell_Repaired').setTranslation([0,0,0]).setRotation([0,0,0,1]).setScale([1,1,1]);
const shellMaterial=source.getMaterial();shellMaterial.setName('AI_Shell_Original_Basecolor_Matte').setMetallicFactor(0).setRoughnessFactor(.58).setMetallicRoughnessTexture(null).setNormalScale(.2).setBaseColorFactor([.6,.6,.6,1]);
const extension=shellMaterial.getExtension('KHR_materials_specular');if(extension)extension.setSpecularColorFactor([1,1,1]);
const group=buildPlayingSurface(THREE);
const legMaterial=new THREE.MeshStandardMaterial({name:'Rebuilt_Blackwood_Legs',color:'#1b211f',roughness:.55,metalness:0});
const footMaterial=new THREE.MeshStandardMaterial({name:'Rebuilt_Brushed_Brass_Feet',color:'#77725a',roughness:.48,metalness:.75});
for(const x of[-.515,.515])for(const z of[-.86,.86]){
  const leg=new THREE.Mesh(new THREE.CylinderGeometry(.075,.052,.528,4,1,false),legMaterial);leg.rotation.y=Math.PI/4;leg.position.set(x,-.442,z);leg.name=`Rebuilt_Support_Leg_${x}_${z}`;group.add(leg);
  const foot=new THREE.Mesh(new THREE.CylinderGeometry(.053,.053,.012,20),footMaterial);foot.position.set(x,-.702,z);foot.name=`Rebuilt_Leveling_Foot_${x}_${z}`;group.add(foot);
}
group.updateMatrixWorld(true);
const materials=new Map(),grouped=new Map();let appendedTriangles=0;
const scene=document.getRoot().listScenes()[0];
group.traverse(object=>{
  if(!object.isMesh)return;
  const geometry=object.geometry.clone().applyMatrix4(object.matrixWorld),material=object.material;
  if(!materials.has(material)){materials.set(material,document.createMaterial(material.name).setBaseColorFactor([...material.color.toArray(),1]).setRoughnessFactor(material.roughness).setMetallicFactor(material.metalness).setDoubleSided(material.side===THREE.DoubleSide));}
  if(!geometry.getAttribute('uv'))geometry.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count*2),2));
  if(!grouped.has(material))grouped.set(material,[]);grouped.get(material).push(geometry.index?geometry.toNonIndexed():geometry);appendedTriangles+=(geometry.index?geometry.index.count:geometry.getAttribute('position').count)/3;
});
for(const[material,geometries]of grouped){
  const geometry=new THREE.BufferGeometry();
  for(const attribute of['position','normal','uv']){const size=attribute==='uv'?2:3,total=geometries.reduce((s,g)=>s+g.getAttribute(attribute).array.length,0),data=new Float32Array(total);let offset=0;for(const source of geometries){data.set(source.getAttribute(attribute).array,offset);offset+=source.getAttribute(attribute).array.length;}geometry.setAttribute(attribute,new THREE.BufferAttribute(data,size));}
  const name=material===legMaterial?'Rebuilt_Support_Legs':material===footMaterial?'Rebuilt_Leveling_Feet':material.name.includes('Cloth')?'Rebuilt_Flat_Cloth_Open_Pockets':material.name.includes('Cushion')?'Rebuilt_Cushions_And_Rounded_Jaws':material.name.includes('Leather')?'Rebuilt_Open_Pocket_Wells':'Rebuilt_Flush_Pocket_Trim';
  const extras=material.name.includes('Cloth')?{pooltoolCastShadow:false,preparation:'Single planar Earcut-triangulated cloth with open pockets'}:{};
  const primitive=document.createPrimitive().setMaterial(materials.get(material));applyGeometry(primitive,geometry,name);const mesh=document.createMesh(name).addPrimitive(primitive).setExtras(extras);scene.addChild(document.createNode(name).setMesh(mesh).setExtras(extras));
}
document.getRoot().setExtras({preparation:{source:'User-provided AI-generated tabletop',sourcePreserved:true,rebuilt:['flat cloth','engine-aligned linear/circular cushions','open pocket cuts and wells','support legs and leveling feet'],calibration:{width:TABLE_REFERENCE.width,length:TABLE_REFERENCE.length,height:TABLE_REFERENCE.height,clothY:0},limitations:'Generated decorative shell retains minor organic irregularities. All cosmetic; not a new physics table.'}});
await document.transform(weld(),dedup(),prune());await io.write(output,document);
const meshes=document.getRoot().listMeshes().flatMap(m=>m.listPrimitives().map(p=>({name:m.getName(),vertices:p.getAttribute('POSITION').getCount(),triangles:(p.getIndices()?.getCount()||p.getAttribute('POSITION').getCount())/3})));
const report={output,bytes:(await stat(output)).size,aiShellTriangles:clipped.getAttribute('position').count/3,appendedTriangles,totalTriangles:meshes.reduce((s,m)=>s+m.triangles,0),vertices:meshes.reduce((s,m)=>s+m.vertices,0),meshes:meshes.length,reference:TABLE_REFERENCE,parts:meshes};await writeFile(output.replace(/\.glb$/,'.preparation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,reference:undefined,parts:undefined},null,2));
