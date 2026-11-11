import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_MODEL_BYTES, validateGlb, validatePublishedModelUrl, validateVisualAssetProfile } from './validation.ts'
import { minimalGlb } from '../../tests/model-fixture.mjs'

test('a self-contained GLB 2.0 is accepted before invoking the loader', () => {
  const model = validateGlb(minimalGlb())
  assert.equal(model.asset.version, '2.0')
  assert.equal(model.materials[0].name, 'Cloth')
})
test('external GLB resources and decoder-only formats are rejected before network requests', () => {
  for (const uri of ['https://attacker.invalid/image.png', '//attacker.invalid/a.bin', '../private.bin', 'file:///secret', 'javascript:alert(1)']) {
    assert.throws(() => validateGlb(minimalGlb(value => ({ ...value, images: [{ uri }] }))), /Внешние файлы/)
  }
  assert.throws(() => validateGlb(minimalGlb(value => ({ ...value, extensionsRequired: ['KHR_draco_mesh_compression'] }))), /Draco/)
})
test('truncated, corrupt and oversized model containers fail closed', () => {
  assert.throws(() => validateGlb(new ArrayBuffer(4)), /GLB/)
  const bytes = minimalGlb(); new DataView(bytes).setUint32(8, bytes.byteLength + 4, true)
  assert.throws(() => validateGlb(bytes), /корректным GLB/)
  assert.throws(() => validateGlb(new ArrayBuffer(MAX_MODEL_BYTES + 1)), /50 МБ/)
  assert.throws(() => validateGlb(minimalGlb(value => ({ ...value, nodes: Array.from({ length: 3001 }, () => ({})) }))), /3000/)
})
test('only the same-origin static GLB catalogue can be fetched', () => {
  assert.equal(validatePublishedModelUrl('/models/custom/table.glb?v=1'), '/models/custom/table.glb?v=1')
  for (const url of ['https://evil.invalid/table.glb', '//evil.invalid/table.glb', '/api/me', '/models/../api/private.glb', '/models/%2e%2e/api/private.glb', '/models/%2F..%2Fapi/private.glb', '/models/custom/a.gltf', '/models/custom/a.glb#x']) {
    assert.throws(() => validatePublishedModelUrl(url), /модел|путь|локальный/)
  }
})
test('configuration preserves cosmetic transforms but rejects invalid physics-like inputs', () => {
  const table = { name: 'Prepared table', source: { kind: 'url', url: '/models/custom/table.glb' }, position: [0, -0.02, 0], rotation: [0, 180, 0], scale: [1, 1, 1], material: { color: '#15725f', roughness: 0.8 }, materials: { Cloth: { color: '#336699' } }, hiddenNodes: ['OptionalLamp'] }
  const result = validateVisualAssetProfile({ version: 1, table, environment: null })
  assert.deepEqual(result.table.rotation, [0, 180, 0])
  assert.equal(result.table.materials.Cloth.color, '#336699')
  assert.equal(result.table.replaceProcedural, true)
  for (const patch of [{ scale: [-1, 1, 1] }, { position: [Infinity, 0, 0] }, { rotation: [0, '90', 0] }, { material: { color: 'red' } }, { material: { metalness: 2 } }]) assert.throws(() => validateVisualAssetProfile({ version: 1, table: { ...table, ...patch } }))
  assert.throws(() => validateVisualAssetProfile({ version: 2 }))
})
