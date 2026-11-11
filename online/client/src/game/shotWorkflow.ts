import type { AimParameters, ShotPhase } from './types'

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** The first confirmation fixes direction; the second also fixes cue contact. */
export function applyShotPhaseLocks(aim: AimParameters, phase: ShotPhase | null, locked: Pick<AimParameters, 'phi' | 'a' | 'b'> | null): AimParameters {
  if (!locked) return aim
  if (phase === 'aim') return { ...aim, phi: locked.phi }
  if (phase === 'power') return { ...aim, phi: locked.phi, a: locked.a, b: locked.b }
  return aim
}

/**
 * Pull down for power. Both HUD gauges describe this one speed; sideways motion
 * must not silently alter cue elevation. All other values stay at the locked
 * start aim. Travel is measured in CSS pixels.
 */
export function powerDragAim(start: AimParameters, _dx: number, dy: number, _width: number, height: number): AimParameters {
  const powerTravel = Math.max(160, finite(height, 0) * 0.3)
  return {
    ...start,
    V0: clamp(finite(dy, 0) / powerTravel * 8, 0.2, 8),
  }
}

/** Confirmation clicks, sideways moves and upward jitter never strike a ball. */
export function isMeaningfulPowerDrag(dx: number, dy: number): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy) && dy >= 8
}

export function previousShotPhase(phase: ShotPhase | null): ShotPhase | null {
  return phase === 'power' ? 'aim' : phase === 'aim' ? 'overview' : phase
}
