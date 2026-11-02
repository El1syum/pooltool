import assert from 'node:assert/strict'
import test from 'node:test'
import { isMeaningfulPowerDrag, powerDragAim, previousShotPhase } from './shotWorkflow.ts'

const aim = { phi: 123, V0: 2.5, theta: 10, a: 0.3, b: -0.2 }

test('power drag maps the canvas pull distance to the permitted speed range', () => {
  assert.equal(powerDragAim(aim, 0, 0, 1000, 600).V0, 0.2)
  assert.equal(powerDragAim(aim, 0, 90, 1000, 600).V0, 4)
  assert.equal(powerDragAim(aim, 0, 180, 1000, 600).V0, 8)
  assert.equal(powerDragAim(aim, 0, 900, 1000, 600).V0, 8)
  assert.equal(powerDragAim(aim, 0, -50, 1000, 600).V0, 0.2)
})

test('sideways drag adjusts elevation without exceeding the server bounds', () => {
  assert.equal(powerDragAim(aim, 125, 90, 1000, 600).theta, 40)
  assert.equal(powerDragAim(aim, 999, 90, 1000, 600).theta, 60)
  assert.equal(powerDragAim(aim, -999, 90, 1000, 600).theta, 0)
})

test('direction and spin remain locked throughout a power drag', () => {
  const result = powerDragAim(aim, 70, 80, 1000, 600)
  assert.deepEqual([result.phi, result.a, result.b], [aim.phi, aim.a, aim.b])
  assert.deepEqual(aim, { phi: 123, V0: 2.5, theta: 10, a: 0.3, b: -0.2 })
})

test('small canvases retain usable drag travel and invalid samples stay finite', () => {
  assert.equal(powerDragAim(aim, 0, 80, 120, 100).V0, 4)
  const result = powerDragAim(aim, NaN, Infinity, 0, NaN)
  assert.equal(result.V0, 0.2)
  assert.equal(result.theta, 10)
})

test('a click and small pointer jitter never count as a shot', () => {
  assert.equal(isMeaningfulPowerDrag(0, 0), false)
  assert.equal(isMeaningfulPowerDrag(3, 4), false)
  assert.equal(isMeaningfulPowerDrag(0, 8), true)
  assert.equal(isMeaningfulPowerDrag(NaN, 20), false)
})

test('right-click steps back one phase and leaves legacy/overview intact', () => {
  assert.equal(previousShotPhase('power'), 'aim')
  assert.equal(previousShotPhase('aim'), 'overview')
  assert.equal(previousShotPhase('overview'), 'overview')
  assert.equal(previousShotPhase(null), null)
})
