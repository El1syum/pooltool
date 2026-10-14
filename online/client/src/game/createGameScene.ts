import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GameAudio } from './audio'
import { isLegalCuePlacement, normalizeAim, numberForPocket, sampleTrajectory } from './playback'
import {
  DEFAULT_BINDINGS,
  type AimParameters, type BallState, type BindingAction, type GameScene, type GameSnapshot,
  type CameraMode, type SceneCallbacks, type SceneInteraction, type SceneSettings, type ShotTrajectory, type Vec3Tuple,
} from './types'

/** Pocket marker colours by pocket number 1..6; the HUD uses the same palette. */
export const POCKET_COLORS = [0xf3ab43, 0x62cfc2, 0x669bf8, 0xf26a78, 0xaa80e7, 0xf0d667]
export const BALL_COLORS = ['#fffdf4', '#edba1c', '#305db8', '#d3323b', '#803bac', '#e97727', '#239652', '#8e2637', '#191d22']
const BASIS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const BASIS_INVERSE = BASIS.clone().invert()
const UP = new THREE.Vector3(0, 1, 0)
const DEFAULT_SETTINGS: SceneSettings = {
  quality: 'medium', volume: 0.5, sensitivity: 1, bindings: { ...DEFAULT_BINDINGS },
  showAimGuide: true, showPocketLabels: true,
}

interface BallVisual {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  radius: number
  texture: THREE.Texture
}

function fallbackBallTexture(id: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const context = canvas.getContext('2d')!
  const number = Number(id)
  const colored = Number.isInteger(number) && number > 0 && number <= 15
  const color = BALL_COLORS[number > 8 ? number - 8 : number] ?? '#fffdf4'
  context.fillStyle = number > 8 ? '#fffdf4' : color
  context.fillRect(0, 0, canvas.width, canvas.height)
  if (number > 8) {
    context.fillStyle = color
    context.fillRect(0, 140, canvas.width, 232)
  }
  if (colored) {
    for (const x of [256, 768]) {
      context.beginPath()
      context.fillStyle = '#fffdf4'
      context.arc(x, 256, 76, 0, Math.PI * 2)
      context.fill()
      context.fillStyle = '#191d22'
      context.font = 'bold 105px Arial'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(String(number), x, 262)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function labelTexture(number: number, color: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const context = canvas.getContext('2d')!
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`
  context.beginPath()
  context.arc(64, 64, 56, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = '#ffffff'
  context.lineWidth = 5
  context.stroke()
  context.fillStyle = '#10212d'
  context.font = 'bold 72px Arial'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(number), 64, 67)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function disposeGroup(group: THREE.Object3D): void {
  group.traverse(object => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite)) return
    if ('geometry' in object) object.geometry.dispose()
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    for (const material of materials) {
      if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose()
      material.dispose()
    }
  })
  group.clear()
}

/** Every moving ball is interpolated from the server trajectory; no client physics is used. */
export function createGameScene(container: HTMLElement, callbacks: SceneCallbacks = {}): GameScene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x10202b)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  const canvas = renderer.domElement
  canvas.style.width = canvas.style.height = '100%'
  canvas.style.display = 'block'
  canvas.style.touchAction = 'none'
  canvas.tabIndex = 0
  canvas.setAttribute('aria-label', 'Бильярдный стол. Левой кнопкой выберите направление удара, правой вращайте камеру.')
  canvas.setAttribute('role', 'application')
  container.appendChild(canvas)
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  controls.enablePan = false
  controls.minDistance = 1.2
  controls.maxDistance = 8
  controls.minPolarAngle = 0.03
  controls.maxPolarAngle = Math.PI * 0.48
  controls.mouseButtons = { LEFT: undefined, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
  controls.touches = { ONE: undefined, TWO: THREE.TOUCH.DOLLY_ROTATE }
  scene.add(new THREE.HemisphereLight(0xd9f0ff, 0x29231c, 2.1))
  const overhead = new THREE.DirectionalLight(0xfff3d9, 3.2)
  overhead.position.set(0.5, 5, 0.2)
  overhead.castShadow = true
  overhead.shadow.camera.left = overhead.shadow.camera.bottom = -3
  overhead.shadow.camera.right = overhead.shadow.camera.top = 3
  overhead.shadow.camera.near = 0.1
  overhead.shadow.camera.far = 12
  overhead.shadow.bias = -0.00008
  scene.add(overhead)
  const rimLight = new THREE.DirectionalLight(0x7fbecf, 0.7)
  rimLight.position.set(-2, 2, -3)
  scene.add(rimLight)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x15222a, roughness: 1 }))
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  scene.add(floor)
  const tableGroup = new THREE.Group()
  scene.add(tableGroup)
  const balls = new Map<string, BallVisual>()
  const pocketMeshes = new Map<string, THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>>()
  const pocketLabels: THREE.Sprite[] = []
  let settings = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_BINDINGS } }
  let interaction: SceneInteraction = { canShoot: false, canPlaceCueBall: false, spectator: false }
  let snapshot: GameSnapshot = { table: { width: 1.27, length: 2.54, height: 0.8, pockets: [] }, balls: [], cueBallId: 'cue' }
  let aim: AimParameters = { phi: 90, V0: 2, theta: 0, a: 0, b: 0 }
  let playback: { trajectory: ShotTrajectory; startAt: number; lastT: number; eventIndex: number } | null = null
  let calledPocket: string | null = null
  let destroyed = false
  // Local cue stroke shown the moment the player shoots, while the server computes
  // the authoritative shot; it never moves a ball.
  let stroke: { startedAt: number; from: THREE.Vector3; to: THREE.Vector3; sounded: boolean } | null = null
  let strokeSoundPlayed = false
  const STROKE_MS = 110
  let animationId = 0
  let lastTick = performance.now()
  let measuredAt = lastTick
  let measuredFrames = 0
  let framingScale: number | null = null
  let pointer: { id: number; x: number; y: number; lastX: number; moved: boolean; placement: Vec3Tuple | null } | null = null
  const activePointers = new Set<number>()
  const keys = new Set<string>()
  const audio = new GameAudio()
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  const tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -tableHeight())
  const worldPoint = new THREE.Vector3()
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xd4ffdc, dashSize: 0.035, gapSize: 0.02, transparent: true, opacity: 0.9 }))
  scene.add(line)
  const contactLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xedae48, transparent: true, opacity: 0.65 }))
  scene.add(contactLine)
  // Predicted cue-ball path after contact (or after a cushion when no ball is hit).
  const cuePathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x8fc8ff, dashSize: 0.02, gapSize: 0.014, transparent: true, opacity: 0.85 }))
  scene.add(cuePathLine)
  // Where the cue tip meets the cue ball (spin), shown on the ball itself.
  const contactDot = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3b3b }))
  scene.add(contactDot)
  function flatRing(color: number, scale: number): THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial> {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.028575 * scale, 0.0022, 8, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2
    ring.visible = false
    scene.add(ring)
    return ring
  }
  const targetRing = flatRing(0xf6d365, 1.35)
  const calledRing = flatRing(0x7ee08a, 1.6)
  let calledBall: string | null = null
  let predictedPocket: string | null = null
  let cameraMode: CameraMode = 'free'
  let cueDistance = 0.95
  const ghost = new THREE.Mesh(new THREE.SphereGeometry(0.028575, 20, 12), new THREE.MeshBasicMaterial({ color: 0xe0f5ff, transparent: true, opacity: 0.32, depthWrite: false, wireframe: true }))
  scene.add(ghost)
  const placement = new THREE.Mesh(new THREE.SphereGeometry(0.028575, 20, 12), new THREE.MeshBasicMaterial({ color: 0x87e3bd, transparent: true, opacity: 0.55, depthWrite: false }))
  placement.visible = false
  scene.add(placement)
  const cueGroup = new THREE.Group()
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.009, 1.25, 12), new THREE.MeshStandardMaterial({ color: 0xc4a374, roughness: 0.48 }))
  shaft.castShadow = true
  cueGroup.add(shaft)
  const cueTip = new THREE.Mesh(new THREE.CylinderGeometry(0.0041, 0.0041, 0.014, 12), new THREE.MeshStandardMaterial({ color: 0x5ea3ae, roughness: 0.9 }))
  cueTip.position.y = -0.632
  cueGroup.add(cueTip)
  scene.add(cueGroup)

  function tableHeight(): number { return snapshot.table.renderHeight ?? snapshot.table.height ?? 0.8 }
  function toWorld(position: Vec3Tuple): THREE.Vector3 {
    return new THREE.Vector3(position[0] - snapshot.table.width / 2, tableHeight() + position[2], snapshot.table.length / 2 - position[1])
  }
  function fromWorld(position: THREE.Vector3): Vec3Tuple {
    const cue = snapshot.balls.find(ball => String(ball.id) === String(snapshot.cueBallId ?? 'cue'))
    return [position.x + snapshot.table.width / 2, snapshot.table.length / 2 - position.z, cue?.radius ?? 0.028575]
  }
  function dimensionsSignature(value: GameSnapshot): string { return JSON.stringify(value.table) }
  function isEnabled(): boolean { return !destroyed && !playback && !interaction.spectator && interaction.canShoot && !interaction.canPlaceCueBall }
  function createTable(): void {
    disposeGroup(tableGroup)
    pocketMeshes.clear()
    pocketLabels.length = 0
    const { width: width, length } = snapshot.table
    const height = tableHeight()
    const wood = new THREE.MeshStandardMaterial({ color: 0x624832, roughness: 0.62 })
    const cloth = new THREE.MeshStandardMaterial({ color: 0x15725f, roughness: 0.92 })
    const trim = new THREE.MeshStandardMaterial({ color: 0xc4a77c, metalness: 0.2, roughness: 0.58 })
    const base = new THREE.Mesh(new THREE.BoxGeometry(width + 0.25, 0.25, length + 0.25), wood)
    base.position.y = height - 0.15
    base.castShadow = base.receiveShadow = true
    tableGroup.add(base)
    const bed = new THREE.Mesh(new THREE.BoxGeometry(width, 0.025, length), cloth)
    bed.position.y = height - 0.0125
    bed.receiveShadow = true
    tableGroup.add(bed)
    for (const side of [-1, 1]) {
      for (const half of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.058, length / 2 - 0.13), cloth.clone())
        rail.position.set(side * (width / 2 + 0.025), height + 0.022, half * (length / 4))
        rail.castShadow = rail.receiveShadow = true
        tableGroup.add(rail)
      }
      const end = new THREE.Mesh(new THREE.BoxGeometry(width - 0.11, 0.058, 0.09), cloth.clone())
      end.position.set(0, height + 0.022, side * (length / 2 + 0.025))
      end.castShadow = end.receiveShadow = true
      tableGroup.add(end)
      for (const half of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, height - 0.27, 0.14), wood.clone())
        leg.position.set(side * (width / 2 - 0.12), (height - 0.27) / 2, half * (length / 2 - 0.2))
        leg.castShadow = true
        tableGroup.add(leg)
      }
      for (let i = 1; i <= 7; i++) {
        if (i === 4) continue
        const diamond = new THREE.Mesh(new THREE.CircleGeometry(0.008, 4), trim.clone())
        diamond.rotation.set(-Math.PI / 2, 0, Math.PI / 4)
        diamond.position.set(side * (width / 2 + 0.089), height + 0.032, -length / 2 + length * i / 8)
        tableGroup.add(diamond)
      }
    }
    const pockets = snapshot.table.pockets.length ? snapshot.table.pockets : [
      { id: 'lb', center: [0, 0, 0] as Vec3Tuple, radius: 0.065 },
      { id: 'lc', center: [0, length / 2, 0] as Vec3Tuple, radius: 0.065 },
      { id: 'lt', center: [0, length, 0] as Vec3Tuple, radius: 0.065 },
      { id: 'rt', center: [width, length, 0] as Vec3Tuple, radius: 0.065 },
      { id: 'rc', center: [width, length / 2, 0] as Vec3Tuple, radius: 0.065 },
      { id: 'rb', center: [width, 0, 0] as Vec3Tuple, radius: 0.065 },
    ]
    pockets.forEach((pocket, index) => {
      const center = pocket.position ?? pocket.center ?? [0, 0, 0]
      const position = toWorld([center[0], center[1], 0.002])
      const well = new THREE.Mesh(new THREE.CircleGeometry(pocket.radius, 40), new THREE.MeshBasicMaterial({ color: 0x050b10 }))
      well.rotation.x = -Math.PI / 2
      well.position.copy(position)
      well.userData.pocketId = String(pocket.id)
      tableGroup.add(well)
      const number = numberForPocket(String(pocket.id), index)
      const color = POCKET_COLORS[number - 1] ?? POCKET_COLORS[0]!
      const mouth = new THREE.Mesh(new THREE.TorusGeometry(pocket.radius, 0.005, 8, 40), new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.1 }))
      mouth.rotation.x = -Math.PI / 2
      mouth.position.copy(position).y += 0.003
      mouth.userData.pocketId = String(pocket.id)
      pocketMeshes.set(String(pocket.id), mouth)
      tableGroup.add(mouth)
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(number, color), depthTest: false, transparent: true }))
      label.position.copy(position)
      const out = new THREE.Vector3(position.x, 0, position.z).normalize().multiplyScalar(0.12)
      label.position.add(out).y += 0.10
      label.scale.set(0.085, 0.085, 1)
      label.userData.pocketId = String(pocket.id)
      label.visible = settings.showPocketLabels
      label.renderOrder = 2
      pocketLabels.push(label)
      tableGroup.add(label)
    })
    tablePlane.constant = -height
    refreshPocketSelection()
  }

  function createBall(ball: BallState): BallVisual {
    const id = String(ball.id)
    const radius = ball.radius ?? 0.028575
    const texture = fallbackBallTexture(id)
    texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 24), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.2, metalness: 0.025 }))
    mesh.castShadow = mesh.receiveShadow = true
    mesh.userData.ballId = id
    scene.add(mesh)
    const visual: BallVisual = { mesh, radius, texture }
    const textureId = id === '0' || id === 'cue' || id === 'white' ? 'cue' : id
    if (/^(cue|[1-9]|1[0-5])$/.test(textureId)) {
      const base = import.meta.env.BASE_URL || '/'
      new THREE.TextureLoader().load(`${base}models/balls/${textureId}.png`, loaded => {
        if (destroyed || balls.get(id) !== visual) { loaded.dispose(); return }
        loaded.colorSpace = THREE.SRGBColorSpace
        loaded.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8)
        visual.texture.dispose()
        visual.texture = loaded
        mesh.material.map = loaded
        mesh.material.needsUpdate = true
      }, undefined, () => { /* Generated numbers stay usable if an optional texture is absent. */ })
    }
    return visual
  }

  function renderBalls(states: BallState[]): void {
    for (const ball of states) {
      const id = String(ball.id)
      let visual = balls.get(id)
      if (!visual) { visual = createBall(ball); balls.set(id, visual) }
      const radius = ball.radius ?? visual.radius
      visual.mesh.scale.setScalar(radius / visual.radius)
      visual.mesh.position.copy(toWorld(ball.position))
      visual.mesh.visible = !ball.pocketed && ball.state !== 4 && ball.position.every(Number.isFinite)
      if (ball.quaternion) {
        visual.mesh.quaternion.set(...ball.quaternion)
        visual.mesh.quaternion.premultiply(BASIS).multiply(BASIS_INVERSE)
      }
    }
  }

  function refreshPocketSelection(): void {
    for (const [id, mesh] of pocketMeshes) {
      mesh.material.emissiveIntensity = id === calledPocket ? 1.5 : id === predictedPocket ? 0.8 : 0.1
      mesh.scale.setScalar(id === calledPocket ? 1.2 : id === predictedPocket ? 1.1 : 1)
    }
  }

  function hideGuides(): void {
    line.visible = ghost.visible = contactLine.visible = cuePathLine.visible = targetRing.visible = contactDot.visible = false
  }

  function setLine(target: THREE.Line, points: THREE.Vector3[]): void {
    target.geometry.dispose()
    target.geometry = new THREE.BufferGeometry().setFromPoints(points)
    target.computeLineDistances()
    target.visible = true
  }

  /** Distance from `origin` along flat `direction` until a ball of `radius` meets a cushion line. */
  function railHit(origin: THREE.Vector3, direction: THREE.Vector3, radius: number): { distance: number; normal: THREE.Vector3 } {
    const halfW = snapshot.table.width / 2 - radius
    const halfL = snapshot.table.length / 2 - radius
    let distance = 10
    const normal = new THREE.Vector3()
    const test = (value: number, limit: number, axis: 'x' | 'z') => {
      if (Math.abs(value) < 1e-5) return
      const bound = value > 0 ? limit : -limit
      const travel = (bound - origin[axis]) / value
      if (travel >= 0 && travel < distance) {
        distance = travel
        normal.set(0, 0, 0)
        normal[axis] = value > 0 ? -1 : 1
      }
    }
    test(direction.x, halfW, 'x')
    test(direction.z, halfL, 'z')
    return { distance, normal }
  }

  /** First object ball the cue ball would contact along a straight line. */
  function firstBallHit(origin: THREE.Vector3, direction: THREE.Vector3, radius: number, limit: number, skip: string): { ball: BallState; distance: number } | null {
    let found: { ball: BallState; distance: number } | null = null
    for (const ball of snapshot.balls) {
      if (String(ball.id) === skip || ball.pocketed || ball.state === 4) continue
      const offset = toWorld(ball.position).sub(origin).setY(0)
      const along = offset.dot(direction)
      const separation = radius + (ball.radius ?? radius)
      const perpendicularSquared = offset.lengthSq() - along * along
      if (along <= 0 || perpendicularSquared >= separation * separation) continue
      const contact = along - Math.sqrt(Math.max(0, separation * separation - perpendicularSquared))
      if (contact >= 0 && contact < (found?.distance ?? limit)) found = { ball, distance: contact }
    }
    return found
  }

  /** Pocket whose mouth the object-ball path enters before the cushion, if any. */
  function pocketOnPath(origin: THREE.Vector3, direction: THREE.Vector3, limit: number): { id: string; distance: number } | null {
    let best: { id: string; distance: number } | null = null
    for (const pocket of snapshot.table.pockets) {
      const center = pocket.position ?? pocket.center
      if (!center) continue
      const offset = toWorld([center[0], center[1], 0]).setY(origin.y).sub(origin)
      const along = offset.dot(direction)
      const miss = Math.sqrt(Math.max(0, offset.lengthSq() - along * along))
      if (along > 0 && along < limit + pocket.radius * 1.5 && miss < pocket.radius * 0.75 && along < (best?.distance ?? Infinity)) best = { id: String(pocket.id), distance: along }
    }
    return best
  }

  function placeRing(ring: THREE.Mesh, ball: BallState | undefined): void {
    ring.visible = !!ball && !ball.pocketed && ball.state !== 4 && !playback
    if (ball) ring.position.copy(toWorld([ball.position[0], ball.position[1], 0.0015]))
  }

  function updateAimGuide(): void {
    placeRing(calledRing, calledBall ? snapshot.balls.find(ball => String(ball.id) === calledBall) : undefined)
    const previousPrediction = predictedPocket
    predictedPocket = null
    if (stroke && !playback) {
      cueGroup.visible = true
      hideGuides()
      contactDot.visible = true
      if (previousPrediction) refreshPocketSelection()
      return
    }
    const enabled = isEnabled() || (!playback && !!interaction.showRemoteAim && !interaction.canPlaceCueBall)
    cueGroup.visible = enabled
    hideGuides()
    if (!enabled) { if (previousPrediction) refreshPocketSelection(); return }
    const cueId = String(snapshot.cueBallId ?? 'cue')
    const cueBall = snapshot.balls.find(ball => String(ball.id) === cueId)
    if (!cueBall || cueBall.pocketed || cueBall.state === 4) { cueGroup.visible = false; return }
    const position = toWorld(cueBall.position)
    const radians = aim.phi * Math.PI / 180
    const direction = new THREE.Vector3(Math.cos(radians), 0, -Math.sin(radians))
    const radius = cueBall.radius ?? 0.028575
    const backwards = direction.clone().negate()
    backwards.y = Math.tan(aim.theta * Math.PI / 180)
    backwards.normalize()
    cueGroup.quaternion.setFromUnitVectors(UP, backwards)
    const pullback = 0.028 + aim.V0 / 8 * 0.10
    const right = new THREE.Vector3(-direction.z, 0, direction.x)
    cueGroup.position.copy(position).addScaledVector(backwards, 0.646 + pullback + radius).addScaledVector(right, aim.a * radius)
    cueGroup.position.y += aim.b * radius
    // The tip meets the sphere at (a, b) of its radius, on the face turned to the cue.
    const depth = Math.sqrt(Math.max(0, 1 - aim.a * aim.a - aim.b * aim.b))
    contactDot.position.copy(position).addScaledVector(direction, -radius * depth * 1.04).addScaledVector(right, aim.a * radius).addScaledVector(UP, aim.b * radius)
    contactDot.visible = true
    if (!settings.showAimGuide) { if (previousPrediction) refreshPocketSelection(); return }
    const rail = railHit(position, direction, radius)
    const hit = firstBallHit(position, direction, radius, rail.distance, cueId)
    const end = position.clone().addScaledVector(direction, Math.max(0, hit?.distance ?? rail.distance))
    setLine(line, [position, end])
    ghost.position.copy(end)
    ghost.scale.setScalar(radius / 0.028575)
    ghost.visible = true
    if (hit) {
      placeRing(targetRing, hit.ball)
      const center = toWorld(hit.ball.position)
      const objectDirection = center.clone().sub(end).setY(0).normalize()
      const objectRail = railHit(center, objectDirection, hit.ball.radius ?? radius)
      const pocket = pocketOnPath(center, objectDirection, objectRail.distance)
      predictedPocket = pocket?.id ?? null
      const objectLength = pocket ? pocket.distance : Math.min(objectRail.distance, 0.25 + aim.V0 * 0.12)
      setLine(contactLine, [center, center.clone().addScaledVector(objectDirection, objectLength)])
      contactLine.material.color.set(pocket ? 0x6ee68a : 0xedae48)
      // The cue ball leaves along the tangent line; follow (b > 0) bends it forward, draw back.
      const after = direction.clone().addScaledVector(objectDirection, aim.b * 1.6 - direction.dot(objectDirection)).setY(0)
      if (after.lengthSq() > 1e-4) {
        after.normalize()
        const afterRail = railHit(end, after, radius)
        setLine(cuePathLine, [end, end.clone().addScaledVector(after, Math.min(afterRail.distance, 0.12 + aim.V0 * 0.07))])
      }
    } else if (rail.distance < 10) {
      // No ball in the way: show the first cushion rebound.
      const bounce = direction.clone().addScaledVector(rail.normal, -2 * direction.dot(rail.normal)).normalize()
      const bounceRail = railHit(end, bounce, radius)
      const bounceHit = firstBallHit(end, bounce, radius, bounceRail.distance, cueId)
      setLine(cuePathLine, [end, end.clone().addScaledVector(bounce, Math.min(bounceHit?.distance ?? bounceRail.distance, 0.6))])
    }
    if (previousPrediction !== predictedPocket) refreshPocketSelection()
  }

  // --- Camera ------------------------------------------------------------------------

  function setCameraMode(mode: CameraMode): void {
    if (mode === cameraMode) return
    cameraMode = mode
    controls.enabled = mode === 'free'
    callbacks.onCameraModeChange?.(mode)
  }

  /** Rotate the view around the vertical axis through the target (free camera). */
  function rotateCamera(angle: number): void {
    if (cameraMode === 'cue') setCameraMode('free')
    const offset = camera.position.clone().sub(controls.target).applyAxisAngle(UP, angle)
    camera.position.copy(controls.target).add(offset)
    controls.update()
  }

  function zoomCamera(factor: number): void {
    if (cameraMode === 'cue') { cueDistance = Math.max(0.45, Math.min(2.4, cueDistance * factor)); return }
    const offset = camera.position.clone().sub(controls.target)
    const length = Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() * factor))
    camera.position.copy(controls.target).add(offset.setLength(length))
    controls.update()
  }

  /** Camera behind the cue, looking along the aim; eased so aiming feels smooth. */
  function followCue(delta: number): void {
    if (cameraMode !== 'cue' || playback) return
    const cueBall = snapshot.balls.find(ball => String(ball.id) === String(snapshot.cueBallId ?? 'cue'))
    if (!cueBall || cueBall.pocketed || cueBall.state === 4) return
    const position = toWorld(cueBall.position)
    const radians = aim.phi * Math.PI / 180
    const direction = new THREE.Vector3(Math.cos(radians), 0, -Math.sin(radians))
    const desired = position.clone().addScaledVector(direction, -cueDistance).addScaledVector(UP, 0.18 + cueDistance * 0.3)
    const target = position.clone().addScaledVector(direction, 0.35 + cueDistance * 0.4)
    const alpha = 1 - Math.exp(-delta * 9)
    camera.position.lerp(desired, alpha)
    controls.target.lerp(target, alpha)
    camera.lookAt(controls.target)
  }

  function setAim(partial: Partial<AimParameters>, notify = true): void {
    const next = normalizeAim({ ...aim, ...partial })
    if (Object.keys(next).every(key => next[key as keyof AimParameters] === aim[key as keyof AimParameters])) return
    aim = next
    updateAimGuide()
    if (notify) callbacks.onAimChange?.({ ...aim })
  }

  function resetCamera(topDown = false): void {
    setCameraMode('free')
    const length = snapshot.table.length
    const fit = framingFactor()
    controls.target.set(0, tableHeight(), 0)
    if (topDown) camera.position.set(0, tableHeight() + length * 1.7 * fit, length * 0.003)
    else camera.position.set(length * 0.74 * fit, tableHeight() + length * 1.05 * fit, length * 1.12 * fit)
    controls.update()
  }

  function framingFactor(): number {
    // Perspective makes the near corner wider than the far one. Keep every pocket label
    // inside a narrow canvas rather than fitting only the table's centre rectangle.
    return Math.max(1, 0.6 / Math.max(0.15, camera.aspect)) * (container.clientWidth < 640 ? 1.18 : 1)
  }

  function resize(): void {
    const width = Math.max(1, container.clientWidth)
    const height = Math.max(1, container.clientHeight)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    const nextScale = framingFactor()
    if (framingScale !== null && Math.abs(nextScale - framingScale) > 0.001) {
      const offset = camera.position.clone().sub(controls.target).multiplyScalar(nextScale / framingScale)
      camera.position.copy(controls.target).add(offset)
    }
    framingScale = nextScale
    controls.maxDistance = Math.max(8, snapshot.table.length * 2.5 * nextScale)
    camera.updateProjectionMatrix()
    controls.update()
  }

  function setSettings(partial: Partial<SceneSettings>): void {
    settings = {
      ...settings, ...partial,
      sensitivity: Math.max(0.1, Math.min(3, partial.sensitivity ?? settings.sensitivity)),
      volume: Math.max(0, Math.min(1, partial.volume ?? settings.volume)),
      bindings: { ...settings.bindings, ...partial.bindings },
    }
    const ratio = settings.quality === 'low' ? 1 : settings.quality === 'high' ? 2 : 1.5
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, ratio))
    renderer.shadowMap.enabled = settings.quality !== 'low'
    const shadowSize = settings.quality === 'high' ? 2048 : 1024
    if (overhead.shadow.mapSize.x !== shadowSize) {
      overhead.shadow.map?.dispose()
      overhead.shadow.map = null
      overhead.shadow.mapSize.set(shadowSize, shadowSize)
    }
    controls.rotateSpeed = settings.sensitivity
    updateOrbitButtons()
    for (const label of pocketLabels) label.visible = settings.showPocketLabels
    audio.setVolume(settings.volume)
    resize()
    updateAimGuide()
  }

  function orbitModifierHeld(): boolean {
    const binding = settings.bindings.orbit ?? DEFAULT_BINDINGS.orbit
    return !binding.startsWith('Mouse') && keys.has(binding)
  }

  function updateOrbitButtons(): void {
    controls.mouseButtons.LEFT = settings.bindings.orbit === 'Mouse0' || orbitModifierHeld() ? THREE.MOUSE.ROTATE : undefined
    controls.mouseButtons.RIGHT = settings.bindings.orbit === 'Mouse2' ? THREE.MOUSE.ROTATE : undefined
    controls.mouseButtons.MIDDLE = settings.bindings.orbit === 'Mouse1' ? THREE.MOUSE.ROTATE : THREE.MOUSE.DOLLY
  }

  function pointOnTable(event: PointerEvent): Vec3Tuple | null {
    const rect = canvas.getBoundingClientRect()
    mouse.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    raycaster.setFromCamera(mouse, camera)
    if (!raycaster.ray.intersectPlane(tablePlane, worldPoint)) return null
    return fromWorld(worldPoint)
  }

  function aimAt(position: Vec3Tuple): void {
    const cue = snapshot.balls.find(ball => String(ball.id) === String(snapshot.cueBallId ?? 'cue'))
    if (!cue || Math.hypot(position[0] - cue.position[0], position[1] - cue.position[1]) < 0.015) return
    setAim({ phi: Math.atan2(position[1] - cue.position[1], position[0] - cue.position[0]) * 180 / Math.PI })
  }

  function updatePlacement(position: Vec3Tuple): void {
    placement.position.copy(toWorld(position))
    placement.visible = true
    placement.material.color.set(isLegalCuePlacement(position, snapshot, interaction.placementRegion) ? 0x87e3bd : 0xed6b72)
  }

  function pointerDown(event: PointerEvent): void {
    audio.unlock()
    canvas.focus({ preventScroll: true })
    if (event.pointerType === 'mouse' && event.button === 0 && orbitModifierHeld()) return
    if (event.pointerType === 'mouse') {
      const mouseBinding = `Mouse${event.button}`
      const action = (Object.keys(settings.bindings) as BindingAction[]).find(key => key !== 'orbit' && settings.bindings[key] === mouseBinding)
      if (action) {
        event.preventDefault()
        canvas.setPointerCapture(event.pointerId)
        if (action === 'shoot') shoot()
        else if (action === 'resetCamera') resetCamera()
        else if (action === 'topView') resetCamera(true)
        else keys.add(mouseBinding)
        return
      }
    }
    activePointers.add(event.pointerId)
    if (activePointers.size > 1) { pointer = null; placement.visible = false; return }
    if (event.button !== 0 || settings.bindings.orbit === 'Mouse0' || interaction.spectator || playback) return
    const position = pointOnTable(event)
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, moved: false, placement: null }
    canvas.setPointerCapture(event.pointerId)
    if (position && interaction.canPlaceCueBall) { pointer.placement = position; updatePlacement(position) }
  }

  function pointerMove(event: PointerEvent): void {
    if (!pointer || pointer.id !== event.pointerId || activePointers.size > 1) return
    pointer.moved ||= Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4
    const position = pointOnTable(event)
    if (!position) return
    const dx = event.clientX - pointer.lastX
    pointer.lastX = event.clientX
    if (interaction.canPlaceCueBall && !interaction.spectator && !playback) {
      pointer.placement = position
      updatePlacement(position)
    } else if (isEnabled() && cameraMode === 'cue') {
      // Behind the cue the camera turns with the aim, so aim by horizontal drag instead.
      setAim({ phi: aim.phi - dx * 0.12 * settings.sensitivity })
    } else if (isEnabled()) aimAt(position)
  }

  function pointerUp(event: PointerEvent): void {
    if (event.pointerType === 'mouse') keys.delete(`Mouse${event.button}`)
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    activePointers.delete(event.pointerId)
    if (!pointer || pointer.id !== event.pointerId) return
    const active = pointer
    pointer = null
    placement.visible = false
    if (interaction.spectator || playback) return
    if (active.placement && interaction.canPlaceCueBall) {
      if (isLegalCuePlacement(active.placement, snapshot, interaction.placementRegion)) callbacks.onPlaceCueBall?.(active.placement)
      else callbacks.onError?.('Биток нельзя поставить здесь: выберите свободное место в разрешённой зоне.')
      return
    }
    if (active.moved) return
    const position = pointOnTable(event)
    const hits = raycaster.intersectObjects([...pocketLabels, ...pocketMeshes.values(), ...[...balls.values()].map(ball => ball.mesh)], false)
    const hit = hits[0]?.object
    if (hit?.userData.pocketId && interaction.canShoot) callbacks.onSelectPocket?.(String(hit.userData.pocketId))
    else {
      if (hit?.userData.ballId && interaction.canShoot) callbacks.onSelectBall?.(String(hit.userData.ballId))
      if (position && isEnabled() && cameraMode !== 'cue') aimAt(position)
    }
  }

  function cancelPointer(event: PointerEvent): void {
    if (event.pointerType === 'mouse') keys.delete(`Mouse${event.button}`)
    activePointers.delete(event.pointerId)
    if (pointer?.id === event.pointerId) { pointer = null; placement.visible = false }
  }

  function isEditing(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null
    return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName))
  }

  function keyDown(event: KeyboardEvent): void {
    if (isEditing(event) || !container.contains(document.activeElement) || destroyed) return
    const bindings = settings.bindings
    const action = (Object.keys(bindings) as BindingAction[]).find(key => bindings[key] === event.code)
    if (!action) return
    event.preventDefault()
    audio.unlock()
    if (action === 'shoot') { if (!event.repeat) shoot(); return }
    if (action === 'resetCamera') { resetCamera(); return }
    if (action === 'topView') { resetCamera(true); return }
    if (action === 'cueView') { if (!event.repeat) setCameraMode(cameraMode === 'cue' ? 'free' : 'cue'); return }
    keys.add(event.code)
    if (action === 'orbit') updateOrbitButtons()
  }
  function keyUp(event: KeyboardEvent): void { keys.delete(event.code); updateOrbitButtons() }
  function clearKeys(): void { keys.clear(); updateOrbitButtons(); pointer = null; activePointers.clear(); placement.visible = false }

  function updateKeys(delta: number): void {
    const held = (action: BindingAction) => keys.has(settings.bindings[action] ?? DEFAULT_BINDINGS[action]) ? 1 : 0
    const turn = held('cameraRight') - held('cameraLeft')
    if (turn) rotateCamera(turn * delta * 1.3)
    if (!isEnabled()) return
    const phi = (held('aimRight') - held('aimLeft')) * delta * 45 * settings.sensitivity
    const V0 = (held('powerUp') - held('powerDown')) * delta * 2
    const theta = (held('elevationUp') - held('elevationDown')) * delta * 25
    const a = (held('spinRight') - held('spinLeft')) * delta * 0.7
    const b = (held('spinUp') - held('spinDown')) * delta * 0.7
    if (phi || V0 || theta || a || b) setAim({ phi: aim.phi + phi, V0: aim.V0 + V0, theta: aim.theta + theta, a: aim.a + a, b: aim.b + b })
  }

  function shoot(): boolean {
    if (!isEnabled()) return false
    audio.unlock()
    callbacks.onShoot?.({ ...aim })
    return true
  }

  function playEvents(t: number): void {
    if (!playback) return
    const events = playback.trajectory.events ?? []
    while (playback.eventIndex < events.length) {
      const event = events[playback.eventIndex]!
      const time = event.t ?? event.time ?? 0
      if (time > t) break
      playback.eventIndex++
      if (time < playback.lastT - 0.05) continue
      const type = event.type ?? event.event_type ?? ''
      if (type.includes('pocket')) audio.impact('pocket', 0.55)
      else if (type.includes('cushion')) audio.impact('cushion', 0.35)
      else if (type.includes('ball_ball') || type.includes('ball-ball')) audio.impact('ball', 0.55)
      else if ((type.includes('stick_ball') || type.includes('stick-ball')) && !strokeSoundPlayed) audio.impact('cue', aim.V0 / 8)
    }
    playback.lastT = t
  }

  function tick(now: number): void {
    if (destroyed) return
    const delta = Math.min(0.05, (now - lastTick) / 1000)
    lastTick = now
    updateKeys(delta)
    if (playback) {
      // Date.now is the shared epoch clock. Parent adjusts startAt by its server-clock offset.
      const t = Math.max(0, (Date.now() - playback.startAt) / 1000)
      renderBalls(sampleTrajectory(playback.trajectory, t))
      playEvents(t)
      if (t >= playback.trajectory.duration) {
        const final = playback.trajectory.frames[playback.trajectory.frames.length - 1]
        if (final) { snapshot = { ...snapshot, balls: final.balls.map(ball => ({ ...ball })) }; renderBalls(snapshot.balls) }
        playback = null
        updateAimGuide()
        callbacks.onPlaybackComplete?.()
      }
    }
    if (stroke) {
      const progress = Math.min(1, (performance.now() - stroke.startedAt) / STROKE_MS)
      cueGroup.position.lerpVectors(stroke.from, stroke.to, progress * progress)
      if (progress >= 1 && !stroke.sounded) { stroke.sounded = strokeSoundPlayed = true; audio.impact('cue', aim.V0 / 8) }
    }
    followCue(delta)
    if (cameraMode === 'free') controls.update()
    renderer.render(scene, camera)
    measuredFrames++
    if (now - measuredAt >= 5000) {
      callbacks.onPerformance?.({ fps: measuredFrames * 1000 / (now - measuredAt), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles })
      measuredAt = now
      measuredFrames = 0
    }
    animationId = requestAnimationFrame(tick)
  }

  function handleContextLost(event: Event): void { event.preventDefault(); callbacks.onError?.('Графический контекст потерян. Обновите страницу, чтобы восстановить игру.') }
  function stopContextMenu(event: Event): void { event.preventDefault() }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  canvas.addEventListener('pointerdown', pointerDown)
  canvas.addEventListener('pointermove', pointerMove)
  canvas.addEventListener('pointerup', pointerUp)
  canvas.addEventListener('pointercancel', cancelPointer)
  canvas.addEventListener('contextmenu', stopContextMenu)
  canvas.addEventListener('webglcontextlost', handleContextLost)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('blur', clearKeys)
  createTable()
  setSettings(DEFAULT_SETTINGS)
  resetCamera()
  animationId = requestAnimationFrame(tick)

  return {
    setState(next) {
      const changed = dimensionsSignature(next) !== dimensionsSignature(snapshot)
      snapshot = next
      playback = null
      if (changed) { createTable(); resetCamera() }
      const ids = new Set(next.balls.map(ball => String(ball.id)))
      for (const [id, visual] of balls) {
        if (ids.has(id)) continue
        scene.remove(visual.mesh)
        visual.mesh.geometry.dispose(); visual.mesh.material.dispose(); visual.texture.dispose()
        balls.delete(id)
      }
      renderBalls(next.balls)
      updateAimGuide()
    },
    setInteraction(next) {
      interaction = { ...interaction, ...next }
      if (interaction.spectator || !interaction.canPlaceCueBall) placement.visible = false
      updateAimGuide()
    },
    setAim,
    getAim: () => ({ ...aim }),
    shoot,
    strike() {
      if (!cueGroup.visible) return
      audio.unlock()
      const cueId = String(snapshot.cueBallId ?? 'cue')
      const cueBall = snapshot.balls.find(ball => String(ball.id) === cueId)
      if (!cueBall) return
      const radians = aim.phi * Math.PI / 180
      const backwards = new THREE.Vector3(-Math.cos(radians), Math.tan(aim.theta * Math.PI / 180), Math.sin(radians)).normalize()
      const from = cueGroup.position.clone()
      // The tip stops at the cue ball surface: shaft half-length + tip offset from the group origin.
      const to = from.clone().addScaledVector(backwards, -(0.028 + aim.V0 / 8 * 0.10))
      stroke = { startedAt: performance.now(), from, to, sounded: false }
      strokeSoundPlayed = false
      updateAimGuide()
    },
    cancelStrike() {
      if (!stroke) return
      stroke = null
      strokeSoundPlayed = false
      updateAimGuide()
    },
    playShot(trajectory, startAt) {
      if (!trajectory.frames.length || !Number.isFinite(startAt)) { callbacks.onError?.('Получены некорректные данные удара.'); return }
      // A remote shot (opponent/bot) has no local stroke; its cue sound comes from the events.
      if (!stroke) strokeSoundPlayed = false
      stroke = null
      playback = { trajectory, startAt, lastT: Math.max(0, (Date.now() - startAt) / 1000), eventIndex: 0 }
      clearKeys()
      updateAimGuide()
    },
    setSettings,
    resetCamera,
    setCameraMode,
    getCameraMode: () => cameraMode,
    rotateCamera,
    zoomCamera,
    setCalledPocket(id) { calledPocket = id == null ? null : String(id); refreshPocketSelection() },
    setCalledBall(id) { calledBall = id == null || id === '' ? null : String(id); updateAimGuide() },
    resize,
    destroy() {
      if (destroyed) return
      destroyed = true
      cancelAnimationFrame(animationId)
      resizeObserver.disconnect()
      controls.dispose()
      audio.destroy()
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', clearKeys)
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointermove', pointerMove)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('pointercancel', cancelPointer)
      canvas.removeEventListener('contextmenu', stopContextMenu)
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      disposeGroup(scene)
      balls.clear()
      renderer.dispose()
      canvas.remove()
    },
  }
}
