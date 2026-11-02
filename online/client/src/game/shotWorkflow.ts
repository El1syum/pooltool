import type { AimParameters, ShotPhase } from './types'

const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/**
 * Pull down for power; move sideways for elevation. The shot direction and spin
 * come from the locked start aim, never from the drag. Dimensions are CSS pixels.
 */
export function powerDragAim(start: AimParameters, dx: number, dy: number, width: number, height: number): AimParameters {
  const powerTravel = Math.max(160, finite(height, 0) * 0.3)
  const elevationTravel = Math.max(160, finite(width, 0) * 0.25)
  return {
    ...start,
    V0: clamp(finite(dy, 0) / powerTravel * 8, 0.2, 8),
    theta: clamp(finite(start.theta, 0) + finite(dx, 0) / elevationTravel * 60, 0, 60),
  }
}

/** A confirmation click or minor pointer jitter must never strike a ball. */
export function isMeaningfulPowerDrag(dx: number, dy: number): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= 8
}

export function previousShotPhase(phase: ShotPhase | null): ShotPhase | null {
  return phase === 'power' ? 'aim' : phase === 'aim' ? 'overview' : phase
}
