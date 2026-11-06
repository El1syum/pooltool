import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {toolImport} from './tool_environment.mjs';
import {buildPlayingSurface,pocketHoles,TABLE_REFERENCE,renderPoint} from './playable_surface.mjs';
import {auditPocketTopology,auditPocketBores} from './pocket_topology.mjs';
import {assertDistinctArtifacts} from './pocket_artifact_paths.mjs';
import {buildWoodDeck,buildPocketLinings} from './pocket_surround.mjs';
import {auditWoodAtlas} from './pocket_wood_atlas.mjs';
const THREE=await toolImport('three');

test('all rebuilt cushion/jaw shells around six pocket mouths are closed and consistently wound',()=>{
  const surface=buildPlayingSurface(THREE);
  const report=auditPocketTopology(THREE,surface,pocketHoles());
  assert.ok(report.meshes>=6,'Audit must actually include the rebuilt pocket jaw geometry');
  assert.ok(Object.values(report.pocketFaces).every(count=>count>0),'Every one of the six pockets must be covered by the audit');
  assert.equal(report.degenerate.length,0,`Degenerate pocket triangles: ${JSON.stringify(report.degenerate.slice(0,6))}`);
  assert.equal(report.normalConflicts.length,0,`Normals disagree with pocket triangle winding: ${JSON.stringify(report.normalConflicts.slice(0,6))}`);
  assert.equal(report.openEdges.length,0,`Exposed open cushion/jaw edges: ${JSON.stringify(report.openEdges.slice(0,8))}`);
  assert.equal(report.nonManifoldEdges.length,0,`Non-manifold pocket edges: ${JSON.stringify(report.nonManifoldEdges.slice(0,8))}`);
  assert.equal(report.windingConflicts.length,0,`Adjacent pocket faces have inconsistent winding: ${JSON.stringify(report.windingConflicts.slice(0,8))}`);
  assert.equal(report.inwardComponents.length,0,`Closed cushion shells must face outward: ${JSON.stringify(report.inwardComponents)}`);
});

test('the closed timber deck and open-bore pocket linings face outward without boundary defects',()=>{
  const root=new THREE.Group(),material=new THREE.MeshStandardMaterial();
  root.add(buildWoodDeck(THREE,TABLE_REFERENCE,material),...buildPocketLinings(THREE,TABLE_REFERENCE,material));
  const report=auditPocketTopology(THREE,root,pocketHoles(),{meshPredicate:()=>true});
  assert.equal(report.meshes,7);
  for(const key of['degenerate','openEdges','nonManifoldEdges','windingConflicts','normalConflicts','inwardComponents'])assert.equal(report[key].length,0,`${key}: ${JSON.stringify(report[key].slice(0,4))}`);
  assert.equal(auditPocketBores(THREE,root,pocketHoles()).blockedPocketRays.length,0);
});

test('visible cushion noses meet the unchanged engine contact lines and rounded jaw arcs',()=>{
  const surface=buildPlayingSurface(THREE);surface.updateMatrixWorld(true);
  const meshes=surface.children.filter(object=>object.isMesh&&/Cushion|Jaw|Collision_Nose/i.test(object.name));
  const ray=new THREE.Raycaster(),point=p=>new THREE.Vector3(...renderPoint(p));
  const check=(target,inward,label)=>{
    // A pocket bevel's exposed half-space is not reliably "toward the table
    // centre". Probe both sides; one must meet the actual contact surface.
    inward.normalize();const distances=[];
    for(const sign of[1,-1]){
      ray.set(target.clone().addScaledVector(inward,.025*sign),inward.clone().multiplyScalar(-sign));ray.far=.08;
      const hit=ray.intersectObjects(meshes,false)[0];if(hit)distances.push(hit.distance);
    }
    assert.ok(distances.some(distance=>Math.abs(distance-.025)<7e-6),`Visible nose ${label} does not meet physics contact (ray distances ${JSON.stringify(distances)})`);
  };
  for(const segment of TABLE_REFERENCE.linear){
    const a=point(segment.p1),b=point(segment.p2),mid=a.clone().lerp(b,.371),delta=b.clone().sub(a),inward=new THREE.Vector3(-delta.z,0,delta.x);
    check(mid,inward,`line-${segment.id}`);
  }
  for(const arc of TABLE_REFERENCE.circular){
    const center=point(arc.center),ends=[];
    for(const line of TABLE_REFERENCE.linear)for(const endpoint of[line.p1,line.p2]){
      const p=point(endpoint);
      if(Math.abs(Math.hypot(p.x-center.x,p.z-center.z)-arc.radius)<1e-7&&!ends.some(q=>q.distanceTo(p)<1e-7))ends.push(p);
    }
    assert.equal(ends.length,2);
    const start=Math.atan2(ends[0].z-center.z,ends[0].x-center.x),end=Math.atan2(ends[1].z-center.z,ends[1].x-center.x),delta=((end-start+Math.PI*3)%(Math.PI*2))-Math.PI;
    for(const fraction of[.173,.527,.841]){
      const angle=start+delta*fraction,inward=new THREE.Vector3(Math.cos(angle),0,Math.sin(angle)),target=center.clone().addScaledVector(inward,arc.radius);
      check(target,inward,`arc-${arc.id}-${fraction}`);
    }
  }
});

test('the independent audit rejects an inside-out closed jaw shell',()=>{
  const geometry=new THREE.BoxGeometry(.04,.04,.04),index=geometry.index;
  for(let offset=0;offset<index.count;offset+=3){const second=index.getX(offset+1);index.setX(offset+1,index.getX(offset+2));index.setX(offset+2,second)}
  geometry.computeVertexNormals();
  const root=new THREE.Group(),mesh=new THREE.Mesh(geometry);mesh.name='Rebuilt_Cushion_Inside_Out';root.add(mesh);
  const report=auditPocketTopology(THREE,root,[{id:'test',x:0,z:0,radius:.04}]);
  assert.equal(report.openEdges.length,0);
  assert.equal(report.windingConflicts.length,0);
  assert.equal(report.inwardComponents.length,1,'A consistently wound but inward shell must fail');
});

test('the independent audit rejects an intentionally uncapped pocket-side box',()=>{
  const geometry=new THREE.BoxGeometry(.04,.04,.04).toNonIndexed();
  const position=geometry.getAttribute('position');
  geometry.setAttribute('position',new THREE.BufferAttribute(position.array.slice(18),3));
  geometry.deleteAttribute('normal');
  const root=new THREE.Group(),mesh=new THREE.Mesh(geometry);mesh.name='Rebuilt_Cushion_Missing_Cap';root.add(mesh);
  const report=auditPocketTopology(THREE,root,[{id:'test',x:0,z:0,radius:.04}]);
  assert.ok(report.openEdges.length>0,'A missing cap must never pass the topology regression');
});

test('dense aperture rays reject a cap but accept an actually open well',()=>{
  const holes=[{id:'test',x:0,z:0,radius:.07}],root=new THREE.Group();
  const well=new THREE.Mesh(new THREE.CylinderGeometry(.07,.07,.22,48,1,true),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));well.position.y=-.11;root.add(well);
  const open=auditPocketBores(THREE,root,holes);assert.equal(open.pocketSamples,49);assert.equal(open.blockedPocketRays.length,0);
  const cap=new THREE.Mesh(new THREE.CircleGeometry(.07,48));cap.rotation.x=-Math.PI/2;root.add(cap);
  assert.equal(auditPocketBores(THREE,root,holes).blockedPocketRays.length,49);
});

test('a mirrored closed GLB node is not mistaken for an inside-out mesh',()=>{
  const root=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(.04,.04,.04));mesh.name='Rebuilt_Cushion_Mirrored';mesh.scale.x=-1;root.add(mesh);
  const report=auditPocketTopology(THREE,root,[{id:'test',x:0,z:0,radius:.04}]);
  for(const key of['openEdges','nonManifoldEdges','windingConflicts','normalConflicts','inwardComponents'])assert.equal(report[key].length,0,key);
});

test('audit outputs reject direct and hardlink aliases of the untouched source',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'pooltool-pocket-audit-test-'));
  try{
    const source=path.join(directory,'source.glb'),alias=path.join(directory,'alias.json');
    await writeFile(source,new Uint8Array([1,2,3]));await link(source,alias);
    await assert.rejects(()=>assertDistinctArtifacts(source,[source]));
    await assert.rejects(()=>assertDistinctArtifacts(source,[alias]));
    await assertDistinctArtifacts(source,[path.join(directory,'safe-report.json')]);
    const output=path.join(directory,'output.glb'),report=path.join(directory,'output.preparation.json');
    await writeFile(output,new Uint8Array([4,5,6]));await link(output,report);
    await assert.rejects(()=>assertDistinctArtifacts(source,[output,report]));
  }finally{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    await rm(directory,{recursive:true,force:true});
  }
});

test('actual-triangle UV sampling distinguishes brown wood from a teal atlas spill',async()=>{
  const pixels=new Uint8Array([110,70,40,255,20,130,100,255]);
  const decoder=()=>({ensureAlpha(){return this},raw(){return this},async toBuffer(){return{data:pixels,info:{width:2,height:1,channels:4}}}});
  const texture={getImage:()=>new Uint8Array([1])};
  const document=u=>({getRoot:()=>({listNodes:()=>[{getName:()=> 'Rebuilt_Upper_Wood_Deck',getMesh:()=>({getName:()=> 'Rebuilt_Upper_Wood_Deck',listPrimitives:()=>[{
    getMaterial:()=>({getBaseColorTexture:()=>texture}),getIndices:()=>null,
    getAttribute:()=>({getArray:()=>new Float32Array([u,.5,u,.5,u,.5]),getCount:()=>3}),
  }]})}]})});
  const brown=await auditWoodAtlas(document(.25),decoder);
  const teal=await auditWoodAtlas(document(.75),decoder),neutralPixels=pixels.slice();
  assert.equal(brown.woodSamples,7);assert.equal(brown.woodGreenSamples.length,0);
  assert.equal(teal.woodGreenSamples.length,7);
  pixels.set([100,100,100,255],4);
  assert.equal((await auditWoodAtlas(document(.75),decoder)).woodGreenSamples.length,0,'Neutral highlights are not teal stains');
  pixels.set(neutralPixels);
});
