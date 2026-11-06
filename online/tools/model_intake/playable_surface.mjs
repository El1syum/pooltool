/** Offline art preparation only. The engine remains the collision authority. */
import {TABLE_REFERENCE,renderPoint,pocketHoles} from './table_coordinates.mjs';
import {buildCushionRails} from './cushion_geometry.mjs';
import {buildPocketLinings} from './pocket_surround.mjs';
export {TABLE_REFERENCE,renderPoint,pocketHoles};

function split(poly, plane){
  const inside=[],outside=[];
  for(let i=0;i<poly.length;i++){
    const a=poly[i],b=poly[(i+1)%poly.length];
    const da=plane[0]*a[0]+plane[1]*a[1]+plane[2]*a[2]+plane[3];
    const db=plane[0]*b[0]+plane[1]*b[1]+plane[2]*b[2]+plane[3];
    const ai=da>=-1e-9,bi=db>=-1e-9;
    (ai?inside:outside).push(a);
    if(ai!==bi){const t=da/(da-db),point=a.map((v,k)=>v+(b[k]-v)*t);inside.push(point);outside.push(point);}
  }
  return {inside,outside};
}
function subtract(poly,planes){
  const output=[];let current=poly;
  for(const plane of planes){if(current.length<3)break;const part=split(current,plane);if(part.outside.length>=3)output.push(part.outside);current=part.inside;}
  return output;
}
function circlePlanes(hole,count){return Array.from({length:count},(_,i)=>{const a=i*Math.PI*2/count,c=Math.cos(a),s=Math.sin(a);return[-c,0,-s,hole.radius+c*hole.x+s*hole.z];});}
function overlaps(poly, hole){let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;for(const v of poly){minX=Math.min(minX,v[0]);maxX=Math.max(maxX,v[0]);minZ=Math.min(minZ,v[2]);maxZ=Math.max(maxZ,v[2]);}return minX<hole.x+hole.radius&&maxX>hole.x-hole.radius&&minZ<hole.z+hole.radius&&maxZ>hole.z-hole.radius;}

/** Cut a 3D inner prism and vertical pocket prisms; preserve interpolated UVs/normals. */
export function clipGeometry(THREE, geometry,{inner=null,holes=[],circleSegments=48}={}){
  const p=geometry.getAttribute('position'),n=geometry.getAttribute('normal'),uv=geometry.getAttribute('uv'),indices=geometry.getIndex();
  const innerPlanes=inner?[[1,0,0,inner.halfX],[-1,0,0,inner.halfX],[0,0,1,inner.halfZ],[0,0,-1,inner.halfZ],[0,1,0,-inner.minY]]:null;
  const holePlanes=holes.map(h=>circlePlanes(h,circleSegments));
  const result=[];const count=indices?indices.count:p.count;
  function vertex(i){return[p.getX(i),p.getY(i),p.getZ(i),n?.getX(i)||0,n?.getY(i)||0,n?.getZ(i)||0,uv?.getX(i)||0,uv?.getY(i)||0];}
  for(let i=0;i<count;i+=3){
    let polygons=[[vertex(indices?indices.getX(i):i),vertex(indices?indices.getX(i+1):i+1),vertex(indices?indices.getX(i+2):i+2)]];
    if(innerPlanes){const next=[];for(const poly of polygons)next.push(...subtract(poly,innerPlanes));polygons=next;}
    for(let h=0;h<holes.length;h++){const next=[];for(const poly of polygons){if(overlaps(poly,holes[h]))next.push(...subtract(poly,holePlanes[h]));else next.push(poly);}polygons=next;}
    for(const poly of polygons)for(let k=1;k<poly.length-1;k++){const tri=[poly[0],poly[k],poly[k+1]];const a=tri[0],b=tri[1],c=tri[2];const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];if(Math.hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)>1e-10)result.push(...tri);}
  }
  const positions=[],normals=[],uvs=[];for(const v of result){positions.push(...v.slice(0,3));const length=Math.hypot(...v.slice(3,6))||1;normals.push(v[3]/length,v[4]/length,v[5]/length);uvs.push(...v.slice(6,8));}
  const output=new THREE.BufferGeometry();output.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));output.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));output.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));return output;
}

export function buildPlayingSurface(THREE,reference=TABLE_REFERENCE,options={}){
  const group=new THREE.Group();group.name='Rebuilt_Engine_Aligned_Playing_Surface';
  const cloth=new THREE.MeshStandardMaterial({name:'Rebuilt_Cloth_Muted_Turquoise',color:options.clothColor||'#18776e',roughness:.94,metalness:0});
  const rubber=new THREE.MeshStandardMaterial({name:'Rebuilt_Cushions_Turquoise',color:options.cushionColor||'#135f58',roughness:.87,metalness:0});
  const pocketMaterial=new THREE.MeshStandardMaterial({name:'Rebuilt_Pocket_Leather',color:'#111816',roughness:.91,metalness:0});
  const halfX=options.bedHalfX??reference.width/2+.115,halfZ=options.bedHalfZ??reference.length/2+.115;
  // The fabric terminates behind the leather bore, not through its differently
  // tessellated cylinder. A sub-millimetre upholstery clearance prevents teal
  // stitching/z-fighting inside the well; the visible bore keeps its exact R.
  const holes=pocketHoles(reference,.0006),steps=96;
  // Triangulate the complete planar region once. Repeated per-triangle boolean
  // subtraction creates T-junctions, visible as subpixel cracks on flat cloth.
  const contour=[new THREE.Vector2(-halfX,-halfZ),new THREE.Vector2(halfX,-halfZ)],interiorHoles=[];
  const right=holes.find(h=>Math.abs(h.z)<.01&&h.x>0),left=holes.find(h=>Math.abs(h.z)<.01&&h.x<0);
  function sideNotch(hole,side){
    const edge=side*halfX,dx=edge-hole.x;
    if(Math.abs(dx)>=hole.radius)return false;
    const alpha=Math.acos(Math.abs(dx)/hole.radius);
    const start=side>0?-alpha:Math.PI-alpha,end=side>0?-2*Math.PI+alpha:-Math.PI+alpha;
    for(let i=0;i<=steps;i++){const a=start+(end-start)*i/steps;contour.push(new THREE.Vector2(hole.x+Math.cos(a)*hole.radius,hole.z+Math.sin(a)*hole.radius));}
    return true;
  }
  const openRight=sideNotch(right,1);contour.push(new THREE.Vector2(halfX,halfZ),new THREE.Vector2(-halfX,halfZ));const openLeft=sideNotch(left,-1);
  for(const hole of holes){
    if((hole===right&&openRight)||(hole===left&&openLeft))continue;
    if(Math.abs(hole.x)+hole.radius>halfX+1e-6||Math.abs(hole.z)+hole.radius>halfZ+1e-6)throw Error('Bed extents must contain corner pockets; side-pocket notches may intersect its boundary');
    interiorHoles.push(Array.from({length:steps},(_,i)=>{const a=-i*Math.PI*2/steps;return new THREE.Vector2(hole.x+Math.cos(a)*hole.radius,hole.z+Math.sin(a)*hole.radius);}));
  }
  const points=[...contour,...interiorHoles.flat()],triangles=THREE.ShapeUtils.triangulateShape(contour,interiorHoles),positions=[],normals=[],uvs=[],indices=[];
  for(const point of points){positions.push(point.x,0,point.y);normals.push(0,1,0);uvs.push((point.x/halfX+1)/2,(point.y/halfZ+1)/2);}
  for(const tri of triangles){const[a,b,c]=tri.map(i=>points[i]);const cross=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);indices.push(...(cross<0?tri:[tri[0],tri[2],tri[1]]));}
  const bed=new THREE.BufferGeometry();bed.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));bed.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));bed.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));bed.setIndex(indices);
  const bedMesh=new THREE.Mesh(bed,cloth);bedMesh.name='Rebuilt_Flat_Cloth_Open_Pockets';bedMesh.userData.pooltoolCastShadow=false;group.add(bedMesh);
  group.add(...buildCushionRails(THREE,reference,rubber));
  group.add(...buildPocketLinings(THREE,reference,pocketMaterial));
  group.userData={preparation:'New flat cloth and collision-aligned cushions/pocket cuts. Cosmetic only; generated from current Pooltool eight-ball dimensions.',reference:{width:reference.width,length:reference.length,height:reference.height}};
  return group;
}
