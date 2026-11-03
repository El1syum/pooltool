/** Tiny original GLB generated for tests; not a substitute for production art. */
export function minimalGlb(change = value => value) {
  const positions = new Float32Array([-0.2, 0, -0.2, 0, 0, 0.2, 0.2, 0, -0.2])
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0])
  const binary = new Uint8Array(positions.byteLength + normals.byteLength)
  binary.set(new Uint8Array(positions.buffer)); binary.set(new Uint8Array(normals.buffer), positions.byteLength)
  const document = change({
    asset: { version: '2.0', generator: 'Pooltool test fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'WorkshopTriangle', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [{ name: 'Cloth', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.5, 0.2, 1], roughnessFactor: 0.9, metallicFactor: 0 } }],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }, { buffer: 0, byteOffset: positions.byteLength, byteLength: normals.byteLength, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.2, 0, -0.2], max: [0.2, 0, 0.2] }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }],
  })
  const json = new TextEncoder().encode(JSON.stringify(document))
  const padded = new Uint8Array(Math.ceil(json.byteLength / 4) * 4).fill(0x20)
  padded.set(json)
  const result = new ArrayBuffer(12 + 8 + padded.byteLength + 8 + binary.byteLength)
  const header = new DataView(result)
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, result.byteLength, true)
  header.setUint32(12, padded.byteLength, true); header.setUint32(16, 0x4e4f534a, true)
  new Uint8Array(result, 20, padded.byteLength).set(padded)
  const offset = 20 + padded.byteLength
  header.setUint32(offset, binary.byteLength, true); header.setUint32(offset + 4, 0x004e4942, true)
  new Uint8Array(result, offset + 8).set(binary)
  return result
}
