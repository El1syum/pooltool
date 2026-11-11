export const RENDER_SCALES = [1, 0.75, 0.5] as const
export const SHADOW_QUALITIES = ['auto', 'off', 'medium', 'high'] as const
export const FRAME_RATE_LIMITS = [0, 30, 60, 120] as const

export interface PresentationSettings {
  renderScale: (typeof RENDER_SCALES)[number]
  shadowQuality: (typeof SHADOW_QUALITIES)[number]
  frameRateLimit: (typeof FRAME_RATE_LIMITS)[number]
  invertCamera: boolean
  smoothAim: boolean
  impactVolume: number
  audioInBackground: boolean
}

export const DEFAULT_PRESENTATION_SETTINGS: Readonly<PresentationSettings> = {
  renderScale: 1,
  shadowQuality: 'auto',
  frameRateLimit: 0,
  invertCamera: false,
  smoothAim: true,
  impactVolume: 1,
  audioInBackground: false,
}

export function presentationSettings(value: Partial<PresentationSettings>): PresentationSettings {
  const { renderScale, shadowQuality, frameRateLimit, invertCamera, smoothAim, impactVolume, audioInBackground } = value
  return {
    renderScale: RENDER_SCALES.find(item => item === renderScale) ?? DEFAULT_PRESENTATION_SETTINGS.renderScale,
    shadowQuality: SHADOW_QUALITIES.find(item => item === shadowQuality) ?? DEFAULT_PRESENTATION_SETTINGS.shadowQuality,
    frameRateLimit: FRAME_RATE_LIMITS.find(item => item === frameRateLimit) ?? DEFAULT_PRESENTATION_SETTINGS.frameRateLimit,
    invertCamera: invertCamera === true,
    smoothAim: smoothAim !== false,
    impactVolume: typeof impactVolume === 'number' && Number.isFinite(impactVolume) ? Math.max(0, Math.min(1, impactVolume)) : 1,
    audioInBackground: audioInBackground === true,
  }
}

export function renderPixelRatio(quality: 'low' | 'medium' | 'high', deviceRatio: number, scale: PresentationSettings['renderScale']): number {
  const cap = quality === 'low' ? 1 : quality === 'high' ? 2 : 1.5
  return Math.min(deviceRatio || 1, cap) * scale
}

/** Only limit presentation. The game loop still samples inputs, audio and trajectories on every rAF. */
export function nextRenderDeadline(now: number, deadline: number, limit: PresentationSettings['frameRateLimit']): number | null {
  if (limit === 0) return 0
  if (now + 0.5 < deadline) return null
  const interval = 1000 / limit
  return (deadline > 0 && now - deadline < interval ? deadline : now) + interval
}
