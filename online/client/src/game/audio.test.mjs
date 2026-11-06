import assert from 'node:assert/strict'
import test from 'node:test'
import { GameAudio } from './audio.ts'

class FakeAudioContext {
  static instances = []
  state = 'running'; currentTime = 0; sampleRate = 48000; destination = {}; buffers = []; sources = []; gains = []; closed = false
  constructor() { FakeAudioContext.instances.push(this) }
  createBuffer(channels, length, rate) {
    const buffer = { channels, length, rate, getChannelData: () => new Float32Array(length) }
    this.buffers.push(buffer); return buffer
  }
  createGain() {
    const node = { gain: { value: 0, setTargetAtTime(value) { this.value = value } }, connect() {}, disconnect() { this.disconnected = true } }
    this.gains.push(node); return node
  }
  createBufferSource() {
    const source = { buffer: null, onended: null, connect(target) { this.target = target }, disconnect() { this.disconnected = true }, start() { this.started = true }, stop() { this.stopped = true } }
    this.sources.push(source); return source
  }
  resume() { this.state = 'running'; return Promise.resolve() }
  close() { this.closed = true; return Promise.resolve() }
}

function withAudio(callback) {
  const original = globalThis.window
  globalThis.window = { AudioContext: FakeAudioContext }
  try { callback() } finally { globalThis.window = original }
}

test('waveforms are prepared once, strengths use gain and collision bursts are coalesced', () => withAudio(() => {
  const audio = new GameAudio(); audio.unlock()
  const context = FakeAudioContext.instances.at(-1)
  assert.equal(context.buffers.length, 4)
  audio.unlock(); assert.equal(context.buffers.length, 4)
  for (let index = 0; index < 63; index++) audio.impact('ball', .55)
  assert.equal(context.sources.length, 1, 'A 63-contact frame must not construct 63 overlapping audio voices')
  assert.equal(context.sources[0].target.gain.value, .55)
  audio.impact('cushion', .35); audio.impact('pocket', .7)
  assert.equal(context.sources.length, 3, 'Different collision sounds remain audible')
  context.currentTime += .009; audio.impact('ball', .9)
  assert.equal(context.sources.length, 4)
  assert.equal(context.sources[0].buffer, context.sources[3].buffer)
  assert.equal(context.sources[3].target.gain.value, .9)
  assert.equal(context.buffers.length, 4)
  audio.destroy()
}))

test('audio graph has a hard voice bound, completed nodes are released and destruction stops all voices', () => withAudio(() => {
  const audio = new GameAudio(); audio.unlock()
  const context = FakeAudioContext.instances.at(-1)
  for (let index = 0; index < 1000; index++) { context.currentTime += .01; audio.impact('ball') }
  assert.equal(context.sources.length, 24)
  const first = context.sources[0]; first.onended()
  assert.equal(first.disconnected, true); assert.equal(first.target.disconnected, true)
  context.currentTime += .01; audio.impact('ball')
  assert.equal(context.sources.length, 25)
  audio.setVolume(0); context.currentTime += .01; audio.impact('cue')
  assert.equal(context.sources.length, 25)
  audio.destroy()
  assert.equal(context.closed, true)
  for (const source of context.sources.slice(1)) assert.equal(source.stopped, true)
  assert.ok(context.sources.every(source => source.disconnected))
  audio.unlock(); audio.impact('ball'); assert.equal(context.sources.length, 25)
}))
