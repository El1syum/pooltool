import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toolImport} from './tool_environment.mjs';
import {buildPlayingSurface,pocketHoles,TABLE_REFERENCE} from './playable_surface.mjs';
const THREE=await toolImport('three');
const surface=buildPlayingSurface(THREE);
surface.updateMatrixWorld(true);
const ray=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0);
const holes=pocketHoles();
function cast(x,z,objects=surface.children){ray.set(new THREE.Vector3(x,.3,z),down);ray.far=.6;return ray.intersectObjects(objects,false);}

test('the reference uses the current Pooltool eight-ball playing geometry',()=>{
  // These are measured engine dimensions, not a commercial nominal table size.
  assert.equal(TABLE_REFERENCE.width,.9906);assert.equal(TABLE_REFERENCE.length,1.9812);assert.equal(TABLE_REFERENCE.height,.708);
  assert.equal(TABLE_REFERENCE.linear.length,18);assert.equal(TABLE_REFERENCE.circular.length,12);assert.equal(holes.length,6);
});
test('the cloth is one flat, upward-wound region with non-overlapping interior faces',()=>{
  const bed=surface.getObjectByName('Rebuilt_Flat_Cloth_Open_Pockets');assert.ok(bed);
  const p=bed.geometry.getAttribute('position');for(let i=0;i<p.count;i++)assert.equal(p.getY(i),0);
  for(let ix=0;ix<17;ix++)for(let iz=0;iz<33;iz++){
    const x=((ix+.173)/17*2-1)*(TABLE_REFERENCE.width/2-.035),z=((iz+.371)/33*2-1)*(TABLE_REFERENCE.length/2-.035);
    if(holes.some(h=>Math.hypot(x-h.x,z-h.z)<=h.radius+.002))continue;
    const hits=cast(x,z,[bed]);assert.equal(hits.length,1,`A cloth sample must hit one triangle, not a crack/overlap: ${x},${z}`);assert.ok(Math.abs(hits[0].point.y)<1e-8);
  }
});
test('all six pocket centers and inner capture discs are genuinely open',()=>{
  for(const hole of holes)for(let ring=0;ring<4;ring++)for(let sample=0;sample<16;sample++){
    const angle=sample*Math.PI*2/16,radius=hole.radius*.6*ring/3;
    assert.equal(cast(hole.x+Math.cos(angle)*radius,hole.z+Math.sin(angle)*radius).length,0,`Blocked pocket ${hole.id}`);
  }
});
test('approaches have no raised decorative lip before a ball reaches capture',()=>{
  for(const hole of holes){const direction=new THREE.Vector3(-Math.sign(hole.x),0,Math.abs(hole.z)<.01?0:-Math.sign(hole.z)).normalize();for(const extra of[.02,.04,.06,.08]){
    const hits=cast(hole.x+direction.x*(hole.radius+extra),hole.z+direction.z*(hole.radius+extra));assert.ok(hits.length);assert.ok(hits[0].point.y<=.002,`Raised entrance at ${hole.id}: ${hits[0].point.y}`);
  }}
});
test('the flat receiving surface opts out of self-shadow casting, not receiving',()=>{
  const bed=surface.getObjectByName('Rebuilt_Flat_Cloth_Open_Pockets');assert.equal(bed.userData.pooltoolCastShadow,false);assert.equal(bed.material.roughness,.94);assert.equal(bed.material.metalness,0);
});

test('cloth edges stay behind the pocket lining instead of intersecting its bore',()=>{
  const bed=surface.getObjectByName('Rebuilt_Flat_Cloth_Open_Pockets');
  for(const hole of holes)for(let sample=0;sample<96;sample++){
    const angle=(sample+.371)*Math.PI*2/96,radius=hole.radius+.0002;
    assert.equal(cast(hole.x+Math.cos(angle)*radius,hole.z+Math.sin(angle)*radius,[bed]).length,0,`Fabric protrudes into leather lining at ${hole.id}`);
  }
});
