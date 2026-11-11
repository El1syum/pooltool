import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_PRESENTATION_SETTINGS, nextRenderDeadline, presentationSettings, renderPixelRatio } from './settingsOptions.ts'

test('existing profiles fall back to supported, unchanged visual defaults', () => {
  assert.deepEqual(presentationSettings({}), DEFAULT_PRESENTATION_SETTINGS)
  assert.deepEqual(presentationSettings({
    renderScale: -1, shadowQuality: 'ultra', frameRateLimit: 500, invertCamera: 1,
    smoothAim: null, impactVolume: NaN, audioInBackground: 'true',
  }), DEFAULT_PRESENTATION_SETTINGS)
  assert.equal(presentationSettings({ impactVolume: 5 }).impactVolume, 1)
  assert.equal(presentationSettings({ impactVolume: -5 }).impactVolume, 0)
})

test('render scale applies after quality and display-DPR caps', () => {
  assert.equal(renderPixelRatio('medium', 3, 1), 1.5)
  assert.equal(renderPixelRatio('medium', 3, .5), .75)
  assert.equal(renderPixelRatio('high', 1.25, .75), .9375)
  assert.equal(renderPixelRatio('low', 2, .75), .75)
})

test('presentation limits do not drift and resume after a long frame', () => {
  for (const limit of [30, 60, 120]) {
    let deadline = 0, drawn = 0
    for (let tick = 0; tick < 144 * 10; tick++) {
      const next = nextRenderDeadline(tick * 1000 / 144, deadline, limit)
      if (next !== null) { deadline = next; drawn++ }
    }
    assert.ok(Math.abs(drawn - limit * 10) <= 1, `${limit} fps: rendered ${drawn}`)
    assert.equal(nextRenderDeadline(50_000, deadline, limit), 50_000 + 1000 / limit)
  }
  assert.equal(nextRenderDeadline(100, 10000, 0), 0)
})
