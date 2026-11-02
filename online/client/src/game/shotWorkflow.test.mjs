import assert from 'node:assert/strict'
import test from 'node:test'
import { applyShotPhaseLocks, isMeaningfulPowerDrag, powerDragAim, previousShotPhase } from './shotWorkflow.ts'

const aim = { phi: 123, V0: 2.5, theta: 10, a: 0.3, b: -0.2 }

test('the contact phase fixes direction but still allows selecting cue contact', () => {
  const changed = { ...aim, phi: 270, a: -0.4, b: 0.5 }
  assert.deepEqual(applyShotPhaseLocks(changed, 'aim', aim), { ...changed, phi: aim.phi })
  assert.equal(changed.phi, 270, 'The supplied aim is not mutated')
})

test('the power phase fixes both direction and contact, and overview releases them', () => {
  const changed = { ...aim, phi: 270, V0: 6, theta: 25, a: -0.4, b: 0.5 }
  assert.deepEqual(applyShotPhaseLocks(changed, 'power', aim), { ...changed, phi: aim.phi, a: aim.a, b: aim.b })
  assert.deepEqual(applyShotPhaseLocks(changed, 'overview', aim), changed)
  assert.deepEqual(applyShotPhaseLocks(changed, null, aim), changed)
  assert.deepEqual(applyShotPhaseLocks(changed, 'aim', null), changed)
})

test('power drag maps the canvas pull distance to the permitted speed range', () => {
  assert.equal(powerDragAim(aim, 0, 0, 1000, 600).V0, 0.2)
  assert.equal(powerDragAim(aim, 0, 90, 1000, 600).V0, 4)
  assert.equal(powerDragAim(aim, 0, 180, 1000, 600).V0, 8)
  assert.equal(powerDragAim(aim, 0, 900, 1000, 600).V0, 8)
  assert.equal(powerDragAim(aim, 0, -50, 1000, 600).V0, 0.2)
})

test('sideways drag never silently changes cue elevation or the selected speed', () => {
  for (const dx of [125, 999, -999]) {
    const result = powerDragAim(aim, dx, 90, 1000, 600)
    assert.equal(result.theta, aim.theta)
    assert.equal(result.V0, 4)
  }
})

test('direction, elevation and spin remain locked throughout a power drag', () => {
  const result = powerDragAim(aim, 70, 80, 1000, 600)
  assert.deepEqual([result.phi, result.theta, result.a, result.b], [aim.phi, aim.theta, aim.a, aim.b])
  assert.deepEqual(aim, { phi: 123, V0: 2.5, theta: 10, a: 0.3, b: -0.2 })
})

test('small canvases retain usable drag travel and invalid samples stay finite', () => {
  assert.equal(powerDragAim(aim, 0, 80, 120, 100).V0, 4)
  const result = powerDragAim(aim, NaN, Infinity, 0, NaN)
  assert.equal(result.V0, 0.2)
  assert.equal(result.theta, 10)
})

test('only a meaningful downward pull counts as a shot', () => {
  assert.equal(isMeaningfulPowerDrag(0, 0), false)
  assert.equal(isMeaningfulPowerDrag(3, 4), false)
  assert.equal(isMeaningfulPowerDrag(80, 0), false)
  assert.equal(isMeaningfulPowerDrag(0, -80), false)
  assert.equal(isMeaningfulPowerDrag(0, 8), true)
  assert.equal(isMeaningfulPowerDrag(NaN, 20), false)
})

test('right-click steps back one phase and leaves legacy/overview intact', () => {
  assert.equal(previousShotPhase('power'), 'aim')
  assert.equal(previousShotPhase('aim'), 'overview')
  assert.equal(previousShotPhase('overview'), 'overview')
  assert.equal(previousShotPhase(null), null)
})
