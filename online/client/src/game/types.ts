import type { VisualAssetLoadReport, VisualAssetProfile } from '../models/types'
import { DEFAULT_ASSIST_BINDING } from './assistBinding'

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
  /** Authoritative shot boundary; temporary input/UI locks are not new turns. */
  shotNumber?: number
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
  | 'cameraLeft' | 'cameraRight' | 'cueView' | 'assist'

export const DEFAULT_BINDINGS: Record<BindingAction, string> = {
  aimLeft: 'ArrowLeft', aimRight: 'ArrowRight', powerUp: 'ArrowUp', powerDown: 'ArrowDown',
  elevationUp: 'KeyW', elevationDown: 'KeyS', spinLeft: 'KeyA', spinRight: 'KeyD',
  spinUp: 'KeyR', spinDown: 'KeyF', shoot: 'Space', resetCamera: 'KeyC', topView: 'KeyT', orbit: 'Mouse2',
  cameraLeft: 'KeyQ', cameraRight: 'KeyE', cueView: 'KeyV', assist: DEFAULT_ASSIST_BINDING,
}

/** 'free': orbit around the table; 'cue': follow behind the cue along the aim. */
export type CameraMode = 'free' | 'cue'

/** Match UI workflow; null on GameScene keeps the original unrestricted controls. */
export type ShotPhase = 'overview' | 'aim' | 'power'

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
  /** Authoritative active-turn ownership, independent of modal/busy input locks. */
  ownTurn?: boolean
  /** Release mouse lock for auxiliary UI without disabling its shot controls. */
  pointerLockAllowed?: boolean
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
  onCameraModeChange?: (mode: CameraMode) => void
  onShotPhaseChange?: (phase: ShotPhase | null) => void
  /** External focus/lock loss freezes scene and HUD input until explicit resume. */
  onInputSuspendedChange?: (suspended: boolean) => void
}

export interface GameScene {
  /** Cosmetic GLB table/environment only; never changes physics or ball coordinates. */
  setVisualAssets: (profile: VisualAssetProfile) => Promise<VisualAssetLoadReport>
  getVisualAssetReport: () => VisualAssetLoadReport
  /** Workshop-only wire reference of the actual cloth bounds and axes. */
  setCalibrationOverlay: (visible: boolean) => void
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
  setCameraMode: (mode: CameraMode) => void
  getCameraMode: () => CameraMode
  /** Opt-in match heading view; previews and legacy controls remain free by default. */
  setDefaultAimCamera: (mode: CameraMode) => void
  /** A new authoritative own shot, not a temporary UI permission change. Clears camera overrides. */
  beginAimTurn: () => void
  /** Call from a direct user gesture to hide the cursor for unbounded cue heading. */
  requestAimPointerLock: () => void
  /** Foreground user gesture only; never confirms a shot-preparation phase. */
  resumeInput: () => void
  /** Preserve the external-focus boundary if a match scene is recreated. */
  suspendInput: () => void
  /** Synchronously validates foreground/native ownership before HUD input. */
  isInputSuspended: () => boolean
  /** null restores legacy input; phase changes cancel any unfinished pointer gesture. */
  setShotPhase: (phase: ShotPhase | null) => void
  /** Radians around the vertical axis; switches the cue view to the free camera. */
  rotateCamera: (angle: number) => void
  /** Factor > 1 moves away, < 1 closer. */
  zoomCamera: (factor: number) => void
  setCalledPocket: (id: string | number | null) => void
  setCalledBall: (id: string | number | null) => void
  resize: () => void
  destroy: () => void
}
