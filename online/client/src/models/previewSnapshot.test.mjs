import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultPreviewSnapshot, validatePreviewSnapshot } from './previewSnapshot.ts'

test('offline model reference uses the current authoritative eight-ball geometry', () => {
  const snapshot = defaultPreviewSnapshot()
  assert.equal(snapshot.table.width, 0.9906)
  assert.equal(snapshot.table.length, 1.9812)
  assert.equal(snapshot.table.renderHeight, 0.708)
  assert.equal(snapshot.table.pockets.length, 6)
  assert.ok(snapshot.table.pockets.some(p => p.id === 'lc' && p.center[0] === -0.0685))
  assert.deepEqual(validatePreviewSnapshot(snapshot), snapshot)
})
test('reference validation rejects malformed geometry and returns detached data', () => {
  for (const modify of [s => {s.table.width = NaN}, s => {s.table.length = -1}, s => {s.balls[0].position[0] = Infinity}, s => {s.table.pockets[0].radius = -1}]) {
    const input = defaultPreviewSnapshot(); modify(input)
    assert.throws(() => validatePreviewSnapshot(input))
  }
  const input = defaultPreviewSnapshot(), result = validatePreviewSnapshot(input)
  result.table.width = 4
  assert.equal(input.table.width, 0.9906)
})
