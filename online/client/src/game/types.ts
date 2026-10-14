export type Vec3Tuple = [number, number, number]
export type QuaternionTuple = [number, number, number, number]

export interface BallState {
  id: string | number
  position: Vec3Tuple
  radius?: number
  state?: number
  pocketed?: boolean
  quaternion?: QuaternionTuple
}

export interface PocketState {
  id: string | number
  position?: Vec3Tuple
  center?: Vec3Tuple
  radius: number
}

export interface TableState {
  width: number
  length: number
  height?: number
  renderHeight?: number
  cushionHeight?: number
  pockets: PocketState[]
}

export interface GameSnapshot {
  balls: BallState[]
  table: TableState
  cueBallId?: string | number
  ballInHand?: boolean | string
  ballInHandRegion?: string
  needsPlacement?: boolean
  [key: string]: unknown
}

export interface TrajectoryFrame {
  t: number
  balls: BallState[]
}

/** Server delta entry: [id, x, y, z, state, qx, qy, qz, qw]. */
export type CompactBallEntry = [string, number, number, number, number, number, number, number, number]

export interface ShotTrajectory {
  duration: number
  frames: TrajectoryFrame[]
  /** 'delta': each frame lists only changed balls as CompactBallEntry. */
  encoding?: string
  events?: Array<{ t?: number; time?: number; type?: string; event_type?: string }>
}

/** pooltool cue convention: degrees, m/s and a/b normalized to cue-ball radius. */
export interface AimParameters {
  phi: number
  V0: number
  theta: number
  a: number
  b: number
}

export type BindingAction =
  | 'aimLeft' | 'aimRight' | 'powerUp' | 'powerDown'
  | 'elevationUp' | 'elevationDown' | 'spinLeft' | 'spinRight'
  | 'spinUp' | 'spinDown' | 'shoot' | 'resetCamera' | 'topView' | 'orbit'

export const DEFAULT_BINDINGS: Record<BindingAction, string> = {
  aimLeft: 'ArrowLeft', aimRight: 'ArrowRight', powerUp: 'ArrowUp', powerDown: 'ArrowDown',
  elevationUp: 'KeyW', elevationDown: 'KeyS', spinLeft: 'KeyA', spinRight: 'KeyD',
  spinUp: 'KeyR', spinDown: 'KeyF', shoot: 'Space', resetCamera: 'KeyC', topView: 'KeyT', orbit: 'Mouse2',
}

export interface SceneSettings {
  quality: 'low' | 'medium' | 'high'
  volume: number
  sensitivity: number
  bindings: Partial<Record<BindingAction, string>>
  showAimGuide: boolean
  showPocketLabels: boolean
}

export type GameSettings = SceneSettings
export type AimState = AimParameters

export interface SceneInteraction {
  canShoot: boolean
  canPlaceCueBall: boolean
  spectator: boolean
  /** Display a remote player's cue without giving the viewer input permissions. */
  showRemoteAim?: boolean
  /** Bounds in pooltool metres. Server remains the authority for placement. */
  placementRegion?: { minX?: number; maxX?: number; minY?: number; maxY?: number }
}

export interface SceneCallbacks {
  onAimChange?: (aim: AimParameters) => void
  onShoot?: (aim: AimParameters) => void
  onPlaceCueBall?: (position: Vec3Tuple) => void
  onSelectPocket?: (pocketId: string) => void
  onSelectBall?: (ballId: string) => void
  onPlaybackComplete?: () => void
  onError?: (message: string) => void
  onPerformance?: (data: { fps: number; drawCalls: number; triangles: number }) => void
}

export interface GameScene {
  setState: (snapshot: GameSnapshot) => void
  setInteraction: (interaction: Partial<SceneInteraction>) => void
  setAim: (aim: Partial<AimParameters>, notify?: boolean) => void
  getAim: () => AimParameters
  shoot: () => boolean
  /** Immediate local cue stroke while the server computes the shot. */
  strike: () => void
  cancelStrike: () => void
  playShot: (trajectory: ShotTrajectory, startAt: number) => void
  setSettings: (settings: Partial<SceneSettings>) => void
  resetCamera: (topDown?: boolean) => void
  setCalledPocket: (id: string | number | null) => void
  resize: () => void
  destroy: () => void
}
