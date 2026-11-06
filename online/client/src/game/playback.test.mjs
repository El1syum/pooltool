import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackClock, createTrajectorySampler, expandTrajectory, isLegalCuePlacement, normalizeAim, numberForPocket, sampleTrajectory } from './playback.ts'

test('pocket labels use the same clockwise mapping regardless of server array order', () => {
  const serverOrder = ['lb', 'lc', 'lt', 'rb', 'rc', 'rt']
  assert.deepEqual(serverOrder.map(numberForPocket), [1, 2, 3, 6, 5, 4])
  assert.equal(numberForPocket('4', 0), 4)
})

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

test('delta trajectories expand to full frames that keep resting balls in place', () => {
  const expanded = expandTrajectory({
    duration: 1, encoding: 'delta',
    frames: [
      { t: 0, balls: [['cue', 0, 0, 0.03, 2, 0, 0, 0, 1], ['8', 1, 1, 0.03, 0, 0, 0, 0, 1]] },
      { t: 0.5, balls: [['cue', 0.5, 0, 0.03, 2, 0, 0, 0, 1]] },
      { t: 1, balls: [['8', 1, 1, 0.03, 4, 0, 0, 0, 1]] },
    ],
  })
  assert.equal(expanded.frames.length, 3)
  assert.deepEqual(expanded.frames[1].balls.map(b => [b.id, b.position[0]]), [['cue', 0.5], ['8', 1]])
  assert.deepEqual(expanded.frames[2].balls.map(b => [b.id, b.position[0], b.pocketed]), [['cue', 0.5, false], ['8', 1, true]])
  assert.deepEqual(sampleTrajectory(expanded, 0.25)[0].position, [0.25, 0, 0.03])
})

test('compiled sampling matches reference interpolation and reuses its frame/ball/vector buffers', () => {
  const sampler = createTrajectorySampler(trajectory)
  const canonical = value => JSON.parse(JSON.stringify(value))
  for (const t of [-1, 0, 0.123, 0.5, 1, 1.9999, 2, 5, 0.75]) {
    assert.deepEqual(canonical(sampler.sample(t)), canonical(sampleTrajectory(trajectory, t)))
  }
  const first = sampler.sample(0.25), ball = first[0], position = ball.position, rotation = ball.quaternion
  const second = sampler.sample(0.5)
  assert.equal(second, first)
  assert.equal(second[0], ball)
  assert.equal(second[0].position, position)
  assert.equal(second[0].quaternion, rotation)
  assert.deepEqual(position, [0.5, 1, 0.03])
  assert.deepEqual(trajectory.frames[0].balls[0].position, [0, 0, 0.03], 'Sampling cannot mutate authoritative recordings')
})

test('compiled sampling handles sparse/reordered IDs, raw rounded endpoint quaternions and delta frames', () => {
  const recording = { duration: 1, encoding: 'delta', frames: [
    { t: 0, balls: [['cue', 0, 0, .03, 2, .1234, .2345, .3456, .8765], ['8', 1, 1, .03, 0, 0, 0, 0, 1]] },
    { t: .5, balls: [['8', 1, 1, .03, 4, 0, 0, 0, 1]] },
    { t: 1, balls: [['cue', 1, 0, .03, 0, .1234, .2345, .3456, .8765]] },
  ] }
  const expanded = expandTrajectory(recording), sampler = createTrajectorySampler(recording)
  for (const t of [-1, 0, .25, .5, .999, 1, 4, .2]) {
    assert.deepEqual(JSON.parse(JSON.stringify(sampler.sample(t))), JSON.parse(JSON.stringify(sampleTrajectory(expanded, t))))
  }
  const sparse = { duration: 2, frames: [
    { t: 0, balls: [{ id: 'cue', position: [0, 0, 0] }, { id: '1', position: [1, 0, 0], quaternion: [.1, 0, 0, .9] }] },
    { t: 1, balls: [{ id: '1', position: [2, 0, 0] }] },
    { t: 2, balls: [{ id: 'cue', position: [3, 0, 0] }] },
  ] }
  const sparseSampler = createTrajectorySampler(sparse)
  for (const t of [0, .5, 1, 1.5, 2, .2]) {
    assert.deepEqual(JSON.parse(JSON.stringify(sparseSampler.sample(t))), JSON.parse(JSON.stringify(sampleTrajectory(sparse, t))))
  }
  assert.deepEqual(createTrajectorySampler({ duration: 0, frames: [] }).sample(1), [])
})

test('playback uses a monotonic timeline while retaining authoritative catch-up and future starts', () => {
  const original = Date.now
  try {
    const clock = createPlaybackClock(1000, 1500, 200)
    assert.equal(clock.time(200), .5)
    Date.now = () => 999999999
    assert.equal(clock.time(700), 1)
    Date.now = () => -999999999
    assert.equal(clock.time(1200), 1.5)
    const future = createPlaybackClock(2000, 1000, 100)
    assert.equal(future.time(1099), 0)
    assert.equal(future.time(1100), 0)
    assert.equal(future.time(1200), .1)
  } finally { Date.now = original }
})
