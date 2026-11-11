import type { BallState, CompactBallEntry, GameSnapshot, QuaternionTuple, ShotTrajectory, Vec3Tuple } from './types'

export function numberForPocket(id: string, index: number): number {
  const mapping: Record<string, number> = { lb: 1, lc: 2, lt: 3, rt: 4, rc: 5, rb: 6 }
  return mapping[id] ?? (Number(id) >= 1 && Number(id) <= 6 ? Number(id) : index + 1)
}

export function normalizeAim<T extends { phi: number; V0: number; theta: number; a: number; b: number }>(aim: T): T {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
  const a = finite(aim.a, 0)
  const b = finite(aim.b, 0)
  const spinScale = Math.max(1, Math.hypot(a, b) / 0.8)
  return {
    ...aim,
    phi: ((finite(aim.phi, 90) % 360) + 360) % 360,
    V0: Math.max(0.1, Math.min(8, finite(aim.V0, 2))),
    theta: Math.max(0, Math.min(60, finite(aim.theta, 0))),
    a: a / spinScale,
    b: b / spinScale,
  }
}

/** Expand the server's delta encoding into full frames, once per received shot. */
export function expandTrajectory(trajectory: ShotTrajectory): ShotTrajectory {
  if (trajectory.encoding !== 'delta') return trajectory
  const current = new Map<string, BallState>()
  const frames = trajectory.frames.map(frame => {
    for (const entry of frame.balls as unknown as CompactBallEntry[]) {
      const [id, x, y, z, state, qx, qy, qz, qw] = entry
      current.set(String(id), { id, position: [x, y, z], state, pocketed: state === 4, quaternion: [qx, qy, qz, qw] as QuaternionTuple })
    }
    return { t: frame.t, balls: [...current.values()] }
  })
  return { ...trajectory, encoding: undefined, frames }
}

export function sampleTrajectory(trajectory: ShotTrajectory, t: number): BallState[] {
  const frames = trajectory.frames
  if (!frames.length) return []
  if (t <= frames[0]!.t) return frames[0]!.balls
  if (t >= frames[frames.length - 1]!.t) return frames[frames.length - 1]!.balls
  let low = 0
  let high = frames.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (frames[mid]!.t <= t) low = mid
    else high = mid
  }
  const left = frames[low]!
  const right = frames[high]!
  const progress = (t - left.t) / Math.max(0.000001, right.t - left.t)
  const next = new Map(right.balls.map(ball => [String(ball.id), ball]))
  return left.balls.map(ball => {
    const other = next.get(String(ball.id))
    if (!other) return ball
    // Discrete state changes happen at their authoritative frame, not half a frame early.
    const position = ball.position.map((v, axis) => v + (other.position[axis]! - v) * progress) as Vec3Tuple
    let quaternion = ball.quaternion
    if (quaternion && other.quaternion) {
      const end = other.quaternion
      const sign = quaternion.reduce((sum, value, i) => sum + value * end[i]!, 0) < 0 ? -1 : 1
      const interpolated = quaternion.map((v, i) => v + (end[i]! * sign - v) * progress)
      const length = Math.hypot(...interpolated) || 1
      quaternion = interpolated.map(v => v / length) as [number, number, number, number]
    }
    return { ...ball, position, quaternion }
  })
}

/**
 * Compile ID lookups once and reuse one output buffer for every rendered frame.
 * The returned states are transient: callers must not retain or mutate them.
 * Sampling remains identical to sampleTrajectory, including discrete state changes.
 */
export function createTrajectorySampler(trajectory: ShotTrajectory): { sample: (t: number) => BallState[] } {
  const frames = expandTrajectory(trajectory).frames
  const byId = frames.map(frame => new Map(frame.balls.map(ball => [String(ball.id), ball])))
  const output: BallState[] = []
  const positions: Vec3Tuple[] = []
  const rotations: QuaternionTuple[] = []
  let lower = 0
  return { sample(t) {
    if (!frames.length) { output.length = 0; return output }
    // Normal playback is sequential, so retain the previous interval.
    if (t < frames[lower]!.t) lower = 0
    while (lower + 1 < frames.length && frames[lower + 1]!.t <= t) lower++
    const left = frames[lower]!
    const upper = Math.min(lower + 1, frames.length - 1)
    const right = frames[upper]!
    const progress = Math.max(0, Math.min(1, (t - left.t) / Math.max(0.000001, right.t - left.t)))
    output.length = left.balls.length
    for (let index = 0; index < left.balls.length; index++) {
      const ball = left.balls[index]!
      const next = byId[upper]!.get(String(ball.id))
      const other = next ?? ball
      const position = positions[index] ?? (positions[index] = [0, 0, 0])
      const current = output[index] ?? (output[index] = { id: ball.id, position })
      current.id = ball.id; current.radius = ball.radius; current.state = ball.state; current.pocketed = ball.pocketed
      for (let axis = 0; axis < 3; axis++) position[axis] = ball.position[axis]! + (other.position[axis]! - ball.position[axis]!) * progress
      if (ball.quaternion) {
        const start = ball.quaternion, end = other.quaternion
        const rotation = rotations[index] ?? (rotations[index] = [0, 0, 0, 1])
        if (next && end && t > frames[0]!.t && t < frames[frames.length - 1]!.t) {
          let dot = 0
          for (let axis = 0; axis < 4; axis++) dot += start[axis]! * end[axis]!
          const sign = dot < 0 ? -1 : 1
          for (let axis = 0; axis < 4; axis++) rotation[axis] = start[axis]! + (end[axis]! * sign - start[axis]!) * progress
          const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]) || 1
          for (let axis = 0; axis < 4; axis++) rotation[axis] = rotation[axis]! / length
        } else for (let axis = 0; axis < 4; axis++) rotation[axis] = start[axis]!
        current.quaternion = rotation
      } else current.quaternion = undefined
    }
    return output
  } }
}

/** Anchor epoch synchronization once; wall-clock adjustments cannot jerk an active shot. */
export function createPlaybackClock(startAt: number, epochNow = Date.now(), monotonicNow = performance.now()): { time: (now?: number) => number } {
  const origin = monotonicNow - (epochNow - startAt)
  return { time: (now = performance.now()) => Math.max(0, (now - origin) / 1000) }
}

export function isLegalCuePlacement(
  position: Vec3Tuple,
  snapshot: GameSnapshot,
  region?: { minX?: number; maxX?: number; minY?: number; maxY?: number },
): boolean {
  const cueId = String(snapshot.cueBallId ?? 'cue')
  const cue = snapshot.balls.find(ball => String(ball.id) === cueId)
  const radius = cue?.radius ?? 0.028575
  const [x, y] = position
  if (!position.every(Number.isFinite)) return false
  const minX = Math.max(radius, region?.minX ?? radius)
  const maxX = Math.min(snapshot.table.width - radius, region?.maxX ?? snapshot.table.width - radius)
  const minY = Math.max(radius, region?.minY ?? radius)
  const maxY = Math.min(snapshot.table.length - radius, region?.maxY ?? snapshot.table.length - radius)
  if (x < minX || x > maxX || y < minY || y > maxY) return false
  if (snapshot.balls.some(ball => String(ball.id) !== cueId && !ball.pocketed && ball.state !== 4 &&
    Math.hypot(x - ball.position[0], y - ball.position[1]) < radius + (ball.radius ?? radius) + 0.0001)) return false
  return !snapshot.table.pockets.some(pocket => {
    const center = pocket.position ?? pocket.center
    return center && Math.hypot(x - center[0], y - center[1]) < pocket.radius + radius
  })
}
