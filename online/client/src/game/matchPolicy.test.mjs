import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMatchVisualPolicy, effectiveAimGuide, getAimGuidePolicy } from './matchPolicy.ts'

test('ranked active and calculating matches force the guide off', () => {
  for (const status of ['active', 'calculating']) {
    const match = { ranked: true, status }
    assert.equal(getAimGuidePolicy(match).locked, true)
    assert.equal(effectiveAimGuide(true, match), false)
    assert.equal(effectiveAimGuide(false, match), false)
    assert.match(getAimGuidePolicy(match).reason, /рейтинговом/)
  }
})

test('a ranked reconnect snapshot without a known status stays locked', () => {
  assert.equal(getAimGuidePolicy({ ranked: true }).locked, true)
  assert.equal(effectiveAimGuide(true, { ranked: true, status: 'restoring' }), false)
})

test('casual, finished and absent matches restore the unchanged personal preference', () => {
  for (const match of [null, undefined, { ranked: false, status: 'active' }, { status: 'active' }, { ranked: true, status: 'finished' }]) {
    assert.equal(getAimGuidePolicy(match).locked, false)
    assert.equal(getAimGuidePolicy(match).forcedValue, null)
    assert.equal(effectiveAimGuide(true, match), true)
    assert.equal(effectiveAimGuide(false, match), false)
  }
})

test('a forged personal preference cannot change the authoritative match policy', () => {
  const personal = { showAimGuide: true, ranked: false, volume: 0.5 }
  const effective = applyMatchVisualPolicy(personal, { ranked: true, status: 'active' })
  assert.equal(effective.showAimGuide, false)
  assert.equal(effective.ranked, false, 'Unrelated preferences are not rewritten or treated as authority')
  assert.equal(personal.showAimGuide, true)
})

test('applying visual policy never mutates or overwrites saved casual settings', () => {
  const bindings = Object.freeze({ shoot: 'Space' })
  const personal = Object.freeze({ showAimGuide: true, volume: 0.7, bindings })
  const ranked = applyMatchVisualPolicy(personal, { ranked: true, status: 'calculating' })
  assert.notEqual(ranked, personal)
  assert.equal(ranked.showAimGuide, false)
  assert.equal(ranked.volume, 0.7)
  assert.equal(ranked.bindings, bindings)
  assert.deepEqual(personal, { showAimGuide: true, volume: 0.7, bindings: { shoot: 'Space' } })
  const restored = applyMatchVisualPolicy(personal, { ranked: true, status: 'finished' })
  assert.equal(restored.showAimGuide, true)
})

test('policy is participant-independent and applies equally to spectators', () => {
  const match = { ranked: true, status: 'active', currentPlayer: 1, players: [{ id: 'a' }, { id: 'b' }] }
  assert.deepEqual(getAimGuidePolicy(match), getAimGuidePolicy({ ranked: true, status: 'active' }))
})
