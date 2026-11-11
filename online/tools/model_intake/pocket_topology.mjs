/** Geometry-only checks for rebuilt cushion shells, independent of rendering. */
export function auditPocketTopology(THREE,root,holes,{weldTolerance=1e-6,pocketMargin=.12,meshPredicate=object=>/Cushion|Jaw/i.test(object.name)}={}){
  root.updateMatrixWorld(true);
  const meshes=[];
  root.traverse(object=>{if(object.isMesh&&meshPredicate(object))meshes.push(object)});
  const result={meshes:meshes.length,triangles:0,pocketFaces:Object.fromEntries(holes.map(h=>[h.id,0])),degenerate:[],openEdges:[],nonManifoldEdges:[],windingConflicts:[],normalConflicts:[],inwardComponents:[]};
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3(),face=new THREE.Vector3(),normal=new THREE.Vector3();
  const key=point=>point.toArray().map(value=>Math.round(value/weldTolerance)).join(',');
  for(const mesh of meshes){
    const edges=new Map(),parents=new Map(),volumes=[],position=mesh.geometry.getAttribute('position'),normals=mesh.geometry.getAttribute('normal'),index=mesh.geometry.index;
    const find=value=>{let root=value;while(parents.get(root)!==root)root=parents.get(root);while(value!==root){const next=parents.get(value);parents.set(value,root);value=next}return root};
    const join=(first,second)=>{for(const value of[first,second])if(!parents.has(value))parents.set(value,value);const a=find(first),b=find(second);if(a!==b)parents.set(a,b)};
    const normalMatrix=new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),orientation=Math.sign(mesh.matrixWorld.determinant())||1,count=index?.count??position.count;
    for(let offset=0;offset<count;offset+=3){
      const ids=[0,1,2].map(axis=>index?index.getX(offset+axis):offset+axis);
      a.fromBufferAttribute(position,ids[0]).applyMatrix4(mesh.matrixWorld);b.fromBufferAttribute(position,ids[1]).applyMatrix4(mesh.matrixWorld);c.fromBufferAttribute(position,ids[2]).applyMatrix4(mesh.matrixWorld);
      const points=[a,b,c],keys=points.map(key),area2=face.copy(ab.subVectors(b,a)).cross(ac.subVectors(c,a)).length();
      result.triangles++;
      for(const hole of holes)if(points.some(point=>Math.hypot(point.x-hole.x,point.z-hole.z)<hole.radius+pocketMargin))result.pocketFaces[hole.id]++;
      if(area2<1e-12){result.degenerate.push({mesh:mesh.name,triangle:offset/3,point:a.toArray()});continue}
      join(keys[0],keys[1]);join(keys[1],keys[2]);
      volumes.push({key:keys[0],volume:a.dot(new THREE.Vector3().crossVectors(b,c))/6});
      if(normals){
        face.normalize();normal.set(0,0,0);
        for(const id of ids)normal.add(new THREE.Vector3().fromBufferAttribute(normals,id).applyMatrix3(normalMatrix));
        if(normal.lengthSq()>1e-12&&normal.normalize().dot(face)*orientation<-.01)result.normalConflicts.push({mesh:mesh.name,triangle:offset/3,dot:normal.dot(face)*orientation});
      }
      for(let side=0;side<3;side++){
        const next=(side+1)%3,first=keys[side],second=keys[next];
        if(first===second)continue;
        const edgeKey=first<second?first+'|'+second:second+'|'+first;
        let edge=edges.get(edgeKey);
        if(!edge){edge={count:0,direction:0,vertexKey:first,first:points[side].clone(),second:points[next].clone()};edges.set(edgeKey,edge)}
        edge.count++;edge.direction+=first<second?1:-1;
      }
    }
    const notClosed=new Set();
    for(const edge of edges.values()){
      const entry={mesh:mesh.name,first:edge.first.toArray(),second:edge.second.toArray()};
      if(edge.count!==2||edge.direction!==0)notClosed.add(find(edge.vertexKey));
      if(edge.count===1)result.openEdges.push(entry);
      else if(edge.count>2)result.nonManifoldEdges.push({...entry,faces:edge.count});
      else if(edge.count===2&&edge.direction!==0)result.windingConflicts.push(entry);
    }
    const sums=new Map();for(const item of volumes){const component=find(item.key);sums.set(component,(sums.get(component)??0)+item.volume)}
    // Signed volume establishes outwardness only for closed orientable shells;
    // an open sheet's value depends on its position relative to the origin.
    for(const[component,volume]of sums)if(!notClosed.has(component)&&volume*orientation< -1e-10)result.inwardComponents.push({mesh:mesh.name,component,volume:volume*orientation});
  }
  return result;
}

/** Dense real-mesh aperture rays catch hidden caps missed by a centre-only check. */
export function auditPocketBores(THREE,root,holes){
  root.updateMatrixWorld(true);
  const meshes=[];root.traverse(object=>{if(object.isMesh)meshes.push(object)});
  const ray=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0),blockedPocketRays=[];
  let pocketSamples=0;
  for(const hole of holes)for(const fraction of[0,.2,.4,.6])for(let sample=0;sample<(fraction?16:1);sample++){
    const angle=sample*Math.PI*2/16,x=hole.x+Math.cos(angle)*hole.radius*fraction,z=hole.z+Math.sin(angle)*hole.radius*fraction;
    ray.set(new THREE.Vector3(x,.3,z),down);ray.far=1.2;
    const first=ray.intersectObjects(meshes,false)[0];pocketSamples++;
    if(first&&first.point.y>=-.05)blockedPocketRays.push({id:hole.id,x,z,y:first.point.y,mesh:first.object.name});
  }
  return {pocketSamples,blockedPocketRays};
}
