type ImpactKind = 'cue' | 'ball' | 'cushion' | 'pocket'
const IMPACT_KINDS: ImpactKind[] = ['cue', 'ball', 'cushion', 'pocket']
const MAX_VOICES = 24
const MIN_KIND_INTERVAL = 0.008

type RoutableAudioContext = AudioContext & { setSinkId: (deviceId: string) => Promise<void> }
const outputContexts = new Set<RoutableAudioContext>()
// Output IDs are per-origin hardware choices, not account settings. Keep
// them in the current page; never ask for microphone access or sync to server.
let selectedOutput = ''

export function supportsGameAudioOutput(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext
    && typeof window.AudioContext?.prototype === 'object'
    && 'setSinkId' in window.AudioContext.prototype
    && Boolean(navigator.mediaDevices?.enumerateDevices)
}

export async function gameAudioOutputs(): Promise<MediaDeviceInfo[]> {
  if (!supportsGameAudioOutput()) return []
  const seen = new Set(['', 'default'])
  return (await navigator.mediaDevices.enumerateDevices()).filter(device => {
    if (device.kind !== 'audiooutput' || seen.has(device.deviceId)) return false
    seen.add(device.deviceId)
    return true
  })
}

export function currentGameAudioOutput(): string { return selectedOutput }

export async function setGameAudioOutput(deviceId: string): Promise<void> {
  if (!supportsGameAudioOutput()) throw new Error('Браузер не позволяет выбрать устройство вывода')
  // The list contains only devices already permitted by the browser.
  if (deviceId && !(await gameAudioOutputs()).some(device => device.deviceId === deviceId)) {
    throw new Error('Устройство вывода больше не доступно')
  }
  const contexts = [...outputContexts]
  const results = await Promise.allSettled(contexts.map(context => context.setSinkId(deviceId)))
  if (results.some((result, index) => result.status === 'rejected' && outputContexts.has(contexts[index]!))) {
    await Promise.allSettled(contexts.map(context => context.setSinkId(selectedOutput)))
    throw new Error('Не удалось переключить звук на выбранное устройство')
  }
  selectedOutput = deviceId
}

/** Short cached procedural impacts; collision bursts cannot flood the audio graph. */
export class GameAudio {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private volume = 0.7
  private backgroundPlayback = false
  private destroyed = false
  private buffers = new Map<ImpactKind, AudioBuffer>()
  private lastImpact = new Map<ImpactKind, number>()
  private voices = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()

  private prepareBuffers(context: AudioContext): void {
    for (const kind of IMPACT_KINDS) {
      if (this.buffers.has(kind)) continue
      const duration = kind === 'pocket' ? 0.16 : kind === 'cushion' ? 0.07 : 0.035
      const buffer = context.createBuffer(1, Math.floor(context.sampleRate * duration), context.sampleRate)
      const data = buffer.getChannelData(0)
      const frequency = kind === 'ball' ? 2100 : kind === 'cue' ? 1700 : kind === 'pocket' ? 150 : 420
      for (let i = 0; i < data.length; i++) {
        const time = i / context.sampleRate
        data[i] = (Math.sin(time * Math.PI * 2 * frequency) * 0.65 + (Math.random() * 2 - 1) * 0.35) * Math.exp(-time / (duration * 0.16))
      }
      this.buffers.set(kind, buffer)
    }
  }

  unlock(): void {
    if (this.destroyed) return
    try {
      const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextClass) return
      if (!this.context) {
        this.context = new AudioContextClass()
        this.gain = this.context.createGain()
        this.gain.gain.value = this.playbackVolume()
        this.gain.connect(this.context.destination)
        if (supportsGameAudioOutput() && 'setSinkId' in this.context) {
          const context = this.context as RoutableAudioContext
          outputContexts.add(context)
          const device = selectedOutput
          if (device) void context.setSinkId(device).catch(() => {
            // A device/permission may disappear between menu and match.
            if (selectedOutput === device) selectedOutput = ''
          })
        }
        // Prepare outside the collision/render loop, once per audio context.
        this.prepareBuffers(this.context)
      }
      if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
    } catch { /* Audio is optional; unsupported devices can still play. */ }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.refreshPlaybackVolume()
  }

  setBackgroundPlayback(allowed: boolean): void {
    this.backgroundPlayback = allowed
    this.refreshPlaybackVolume()
  }

  private playbackVolume(): number {
    return !this.backgroundPlayback && typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 0 : this.volume
  }

  refreshPlaybackVolume(): void {
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(this.playbackVolume(), this.context.currentTime, 0.02)
  }

  impact(kind: ImpactKind = 'ball', strength = 1): void {
    const context = this.context
    if (!context || !this.gain || context.state !== 'running' || this.playbackVolume() <= 0) return
    // Simultaneous contacts remain in the physical trajectory. Their identical
    // overlapping sound voices are inaudible separately and need not be spawned.
    const now = context.currentTime
    if (this.voices.size >= MAX_VOICES || now - (this.lastImpact.get(kind) ?? -Infinity) < MIN_KIND_INTERVAL) return
    const buffer = this.buffers.get(kind)
    if (!buffer) return
    this.lastImpact.set(kind, now)
    const source = context.createBufferSource()
    const gain = context.createGain()
    gain.gain.value = Math.min(1, Math.max(0.05, Number.isFinite(strength) ? strength : 1))
    source.buffer = buffer
    source.connect(gain)
    gain.connect(this.gain)
    const voice = { source, gain }
    this.voices.add(voice)
    source.onended = () => { source.disconnect(); gain.disconnect(); this.voices.delete(voice) }
    source.start()
  }

  destroy(): void {
    this.destroyed = true
    for (const { source, gain } of this.voices) {
      source.onended = null
      try { source.stop() } catch { /* A completed voice is already stopped. */ }
      source.disconnect(); gain.disconnect()
    }
    this.voices.clear(); this.buffers.clear(); this.lastImpact.clear()
    if (this.context) {
      outputContexts.delete(this.context as RoutableAudioContext)
      void this.context.close().catch(() => undefined)
    }
    this.context = null
    this.gain = null
  }
}
