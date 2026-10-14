/** Short procedural impact sounds: no downloaded or unlicensed media is required. */
export class GameAudio {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private volume = 0.7
  private destroyed = false

  unlock(): void {
    if (this.destroyed) return
    try {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) return
      if (!this.context) {
        this.context = new AudioContextClass()
        this.gain = this.context.createGain()
        this.gain.gain.value = this.volume
        this.gain.connect(this.context.destination)
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
    } catch { /* Audio is optional; unsupported devices can still play. */ }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02)
  }

  impact(kind: 'cue' | 'ball' | 'cushion' | 'pocket' = 'ball', strength = 1): void {
    const context = this.context
    if (!context || !this.gain || context.state !== 'running' || this.volume <= 0) return
    const duration = kind === 'pocket' ? 0.16 : kind === 'cushion' ? 0.07 : 0.035
    const count = Math.floor(context.sampleRate * duration)
    const buffer = context.createBuffer(1, count, context.sampleRate)
    const data = buffer.getChannelData(0)
    const frequency = kind === 'ball' ? 2100 : kind === 'cue' ? 1700 : kind === 'pocket' ? 150 : 420
    for (let i = 0; i < count; i++) {
      const time = i / context.sampleRate
      data[i] = (Math.sin(time * Math.PI * 2 * frequency) * 0.65 + (Math.random() * 2 - 1) * 0.35) *
        Math.exp(-time / (duration * 0.16)) * Math.min(1, Math.max(0.05, strength))
    }
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    source.start()
  }

  destroy(): void {
    this.destroyed = true
    if (this.context) void this.context.close().catch(() => undefined)
    this.context = null
    this.gain = null
  }
}
