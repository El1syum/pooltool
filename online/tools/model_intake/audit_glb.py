"""Read-only GLB audit; writes reports and embedded image copies to an output dir."""
from __future__ import annotations
import argparse, io, json, struct
from pathlib import Path
import numpy as np
from PIL import Image

COMPONENTS = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
COUNTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

def read_glb(path):
    raw = Path(path).read_bytes()
    magic, version, total = struct.unpack_from('<III', raw)
    assert (magic, version, total) == (0x46546c67, 2, len(raw))
    chunks, offset = {}, 12
    while offset < len(raw):
        length, kind = struct.unpack_from('<II', raw, offset)
        chunks[kind] = memoryview(raw)[offset+8:offset+8+length]
        offset += length + 8
    document = json.loads(bytes(chunks[0x4e4f534a]).decode().rstrip('\0 \r\n'))
    return raw, document, chunks.get(0x004e4942, memoryview(b''))

def accessor(document, binary, index):
    a = document['accessors'][index]
    v = document['bufferViews'][a['bufferView']]
    dtype = np.dtype(COMPONENTS[a['componentType']]).newbyteorder('<')
    width = COUNTS[a['type']]
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = v.get('byteStride', width*dtype.itemsize)
    return np.ndarray((a['count'], width), dtype=dtype, buffer=binary, offset=start, strides=(stride, dtype.itemsize))

def transform(node):
    if 'matrix' in node:
        return np.asarray(node['matrix']).reshape(4,4,order='F')
    x,y,z,w = node.get('rotation', [0,0,0,1])
    rotation = np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)], [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)], [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
    result = np.eye(4)
    result[:3,:3] = rotation @ np.diag(node.get('scale', [1,1,1]))
    result[:3,3] = node.get('translation', [0,0,0])
    return result

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('input',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    raw, doc, binary=read_glb(args.input)
    summary={'file':args.input.name,'bytes':len(raw),'asset':doc.get('asset'),'extensionsUsed':doc.get('extensionsUsed',[]),'extensionsRequired':doc.get('extensionsRequired',[]),'nodes':doc.get('nodes',[]),'materials':doc.get('materials',[]),'meshes':[], 'images':[]}
    all_positions=[]
    matrices={}
    def visit(index, parent):
        node=doc['nodes'][index];mat=parent@transform(node);matrices[index]=mat
        for child in node.get('children',[]):visit(child,mat)
    for root in doc.get('scenes',[{}])[doc.get('scene',0)].get('nodes',[]):visit(root,np.eye(4))
    for ni,node in enumerate(doc.get('nodes',[])):
        if 'mesh' not in node:continue
        mesh=doc['meshes'][node['mesh']]
        for pi,p in enumerate(mesh['primitives']):
            pos=accessor(doc,binary,p['attributes']['POSITION'])
            world=(np.c_[pos,np.ones(len(pos))]@matrices.get(ni,np.eye(4)).T)[:,:3]
            all_positions.append(world)
            indices=accessor(doc,binary,p['indices']).ravel() if 'indices'in p else np.arange(len(pos))
            tri=indices.reshape(-1,3)
            area=np.linalg.norm(np.cross(world[tri[:,1]]-world[tri[:,0]],world[tri[:,2]]-world[tri[:,0]]),axis=1)/2
            summary['meshes'].append({'node':ni,'mesh':node['mesh'],'primitive':pi,'name':mesh.get('name'), 'vertices':len(pos),'triangles':len(tri),'material':p.get('material'),'mode':p.get('mode',4),'attributes':p['attributes'],'bounds':{'min':world.min(axis=0).tolist(),'max':world.max(axis=0).tolist()},'nonFiniteVertices':int((~np.isfinite(world).all(axis=1)).sum()),'zeroAreaTriangles':int((area<1e-12).sum()),'area':float(area.sum())})
            np.savez_compressed(args.output/f'mesh-{ni}-{pi}.npz',positions=world,triangles=tri)
    if all_positions:
        total=np.concatenate(all_positions);summary['bounds']={'min':total.min(axis=0).tolist(),'max':total.max(axis=0).tolist(),'size':np.ptp(total,axis=0).tolist()}
    for i,image in enumerate(doc.get('images',[])):
        item={**image,'index':i}
        if 'bufferView' in image:
            view=doc['bufferViews'][image['bufferView']];start=view.get('byteOffset',0);payload=bytes(binary[start:start+view['byteLength']]);item['bytes']=len(payload)
            try:
                im=Image.open(io.BytesIO(payload));item.update(size=list(im.size),mode=im.mode,format=im.format)
                ext=(im.format or 'bin').lower();(args.output/f'image-{i}.{ext}').write_bytes(payload)
                im.thumbnail((1024,1024));im.convert('RGB').save(args.output/f'image-{i}-preview.jpg',quality=90)
            except Exception as exc:item['imageError']=str(exc)
        summary['images'].append(item)
    (args.output/'glb-document.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2),encoding='utf8')
    (args.output/'audit.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(summary,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
