/** Sample actual delivered deck triangle UVs, not an unused atlas rectangle. */
export async function auditWoodAtlas(document,sharp){
  const samples=[[1,0,0],[0,1,0],[0,0,1],[.5,.5,0],[.5,0,.5],[0,.5,.5],[1/3,1/3,1/3]],decoded=new Map();
  const result={woodMeshes:0,woodSamples:0,woodGreenSamples:[],woodMissingTextures:[]};
  for(const node of document.getRoot().listNodes()){
    const mesh=node.getMesh();if(!mesh||!/Upper_Wood_Deck/i.test(node.getName()||mesh.getName()))continue;
    result.woodMeshes++;
    for(const primitive of mesh.listPrimitives()){
      const texture=primitive.getMaterial()?.getBaseColorTexture(),uv=primitive.getAttribute('TEXCOORD_0');
      if(!texture?.getImage()||!uv){result.woodMissingTextures.push({mesh:node.getName()||mesh.getName()});continue}
      let image=decoded.get(texture);
      if(!image){image=await sharp(Buffer.from(texture.getImage())).ensureAlpha().raw().toBuffer({resolveWithObject:true});decoded.set(texture,image)}
      const uvs=uv.getArray(),indices=primitive.getIndices()?.getArray(),count=indices?.length??uv.getCount(),{width,height,channels}=image.info;
      for(let offset=0;offset<count;offset+=3){
        const ids=[0,1,2].map(axis=>indices?indices[offset+axis]:offset+axis);
        for(const weights of samples){
          const u=ids.reduce((value,id,index)=>value+uvs[id*2]*weights[index],0),v=ids.reduce((value,id,index)=>value+uvs[id*2+1]*weights[index],0);
          const x=Math.max(0,Math.min(width-1,Math.floor(u*width))),y=Math.max(0,Math.min(height-1,Math.floor(v*height))),pixel=(y*width+x)*channels;
          const[r,g,b]=image.data.subarray(pixel,pixel+3);result.woodSamples++;
          // Ignore near-black compression noise and neutral/brown grain. The
          // teal cloth region is distinctly green-dominant in the source atlas.
          if(g>=25&&g>r*1.1&&g>b*1.1)result.woodGreenSamples.push({mesh:node.getName()||mesh.getName(),triangle:offset/3,uv:[u,v],rgb:[r,g,b]});
        }
      }
    }
  }
  return result;
}
