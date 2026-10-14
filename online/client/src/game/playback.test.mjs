import assert from 'node:assert/strict'
import test from 'node:test'
import { isLegalCuePlacement, normalizeAim, sampleTrajectory } from './playback.ts'

const trajectory = {
  duration: 2,
  frames: [
    { t: 0, balls: [{ id: 'cue', position: [0, 0, 0.03], quaternion: [0, 0, 0, 1], pocketed: false }] },
    { t: 1, balls: [{ id: 'cue', position: [1, 2, 0.03], quaternion: [0, 0, 0, -1], pocketed: false }] },
    { t: 2, balls: [{ id: 'cue', position: [2, 4, 0.03], quaternion: [0, 0, 0, 1], pocketed: true }] },
  ],
}
const snapshot = {
  cueBallId: 'cue',
  table: { width: 1.2, length: 2.4, pockets: [{ id: 'lb', center: [0, 0, 0], radius: 0.07 }] },
  balls: [
    { id: 'cue', position: [0.3, 0.3, 0.03], radius: 0.03 },
    { id: '1', position: [0.6, 0.6, 0.03], radius: 0.03 },
  ],
}

test('clients sample the same authoritative position, including late catch-up', () => {
  assert.deepEqual(sampleTrajectory(trajectory, 0.5)[0].position, [0.5, 1, 0.03])
  assert.deepEqual(sampleTrajectory(trajectory, 999)[0].position, [2, 4, 0.03])
  assert.deepEqual(sampleTrajectory(trajectory, -5)[0].position, [0, 0, 0.03])
  assert.deepEqual(sampleTrajectory({ duration: 0, frames: [] }, 0), [])
})

test('a ball disappears at its authoritative pocket frame rather than before it', () => {
  assert.equal(sampleTrajectory(trajectory, 1.99)[0].pocketed, false)
  assert.equal(sampleTrajectory(trajectory, 2)[0].pocketed, true)
})

test('equivalent quaternion signs do not create a zero-length orientation', () => {
  assert.equal(Math.abs(sampleTrajectory(trajectory, 0.5)[0].quaternion[3]), 1)
})

test('cue parameters remain finite and spin stays in a circular safe range', () => {
  const aim = normalizeAim({ phi: -450, V0: Infinity, theta: 999, a: 1, b: 1 })
  assert.equal(aim.phi, 270)
  assert.equal(aim.V0, 2)
  assert.equal(aim.theta, 60)
  assert.ok(Math.abs(Math.hypot(aim.a, aim.b) - 0.8) < 1e-12)
})

test('ball-in-hand preview rejects collisions, rails and pocket mouths', () => {
  assert.equal(isLegalCuePlacement([0.5, 0.5, 0.03], snapshot), true)
  assert.equal(isLegalCuePlacement([0.6, 0.6, 0.03], snapshot), false)
  assert.equal(isLegalCuePlacement([0.02, 0.5, 0.03], snapshot), false)
  assert.equal(isLegalCuePlacement([0.04, 0.04, 0.03], snapshot), false)
})

test('placement honors the server-provided restricted region', () => {
  assert.equal(isLegalCuePlacement([0.5, 0.5, 0.03], snapshot, { maxY: 0.4 }), false)
  assert.equal(isLegalCuePlacement([0.5, 0.3, 0.03], snapshot, { maxY: 0.4 }), true)
  assert.equal(isLegalCuePlacement([NaN, 0.5, 0.03], snapshot), false)
})
