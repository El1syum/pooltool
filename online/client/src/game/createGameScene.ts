import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GameAudio } from './audio'
import { isLegalCuePlacement, normalizeAim, numberForPocket, sampleTrajectory } from './playback'
import {
  DEFAULT_BINDINGS,
  type AimParameters, type BallState, type BindingAction, type GameScene, type GameSnapshot,
  type SceneCallbacks, type SceneInteraction, type SceneSettings, type ShotTrajectory, type Vec3Tuple,
} from './types'

const POCKET_COLORS = [0xf3ab43, 0x62cfc2, 0x669bf8, 0xf26a78, 0xaa80e7, 0xf0d667]
const BALL_COLORS = ['#fffdf4', '#edba1c', '#305db8', '#d3323b', '#803bac', '#e97727', '#239652', '#8e2637', '#191d22']
const BASIS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
const BASIS_INVERSE = BASIS.clone().invert()
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
  let animationId = 0
  let lastTick = performance.now()
  let measuredAt = lastTick
  let measuredFrames = 0
  let framingScale: number | null = null
  let pointer: { id: number; x: number; y: number; moved: boolean; placement: Vec3Tuple | null } | null = null
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
      mesh.material.emissiveIntensity = id === calledPocket ? 1.5 : 0.1
      mesh.scale.setScalar(id === calledPocket ? 1.2 : 1)
    }
  }

  function updateAimGuide(): void {
    const enabled = isEnabled() || (!playback && !!interaction.showRemoteAim && !interaction.canPlaceCueBall)
    cueGroup.visible = enabled
    line.visible = ghost.visible = enabled && settings.showAimGuide
    contactLine.visible = false
    if (!enabled) return
    const cueId = String(snapshot.cueBallId ?? 'cue')
    const cueBall = snapshot.balls.find(ball => String(ball.id) === cueId)
    if (!cueBall || cueBall.pocketed || cueBall.state === 4) { cueGroup.visible = line.visible = ghost.visible = false; return }
    const position = toWorld(cueBall.position)
    const radians = aim.phi * Math.PI / 180
    const direction = new THREE.Vector3(Math.cos(radians), 0, -Math.sin(radians))
    const radius = cueBall.radius ?? 0.028575
    const backwards = direction.clone().negate()
    backwards.y = Math.tan(aim.theta * Math.PI / 180)
    backwards.normalize()
    cueGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), backwards)
    const pullback = 0.028 + aim.V0 / 8 * 0.10
    const lateral = new THREE.Vector3(-direction.z, 0, direction.x).multiplyScalar(aim.a * radius)
    cueGroup.position.copy(position).addScaledVector(backwards, 0.646 + pullback + radius).add(lateral)
    cueGroup.position.y += aim.b * radius
    let distance = 10
    const halfW = snapshot.table.width / 2 - radius
    const halfL = snapshot.table.length / 2 - radius
    if (direction.x > 0.00001) distance = Math.min(distance, (halfW - position.x) / direction.x)
    if (direction.x < -0.00001) distance = Math.min(distance, (-halfW - position.x) / direction.x)
    if (direction.z > 0.00001) distance = Math.min(distance, (halfL - position.z) / direction.z)
    if (direction.z < -0.00001) distance = Math.min(distance, (-halfL - position.z) / direction.z)
    let hitBall: BallState | null = null
    for (const ball of snapshot.balls) {
      if (String(ball.id) === cueId || ball.pocketed || ball.state === 4) continue
      const center = toWorld(ball.position)
      const offset = center.clone().sub(position)
      offset.y = 0
      const along = offset.dot(direction)
      const separation = radius + (ball.radius ?? radius)
      const perpendicularSquared = offset.lengthSq() - along * along
      if (along <= 0 || perpendicularSquared >= separation * separation) continue
      const firstContact = along - Math.sqrt(Math.max(0, separation * separation - perpendicularSquared))
      if (firstContact >= 0 && firstContact < distance) { distance = firstContact; hitBall = ball }
    }
    const end = position.clone().addScaledVector(direction, Math.max(0, distance))
    line.geometry.dispose()
    line.geometry = new THREE.BufferGeometry().setFromPoints([position, end])
    line.computeLineDistances()
    ghost.position.copy(end)
    ghost.scale.setScalar(radius / 0.028575)
    if (hitBall && settings.showAimGuide) {
      const center = toWorld(hitBall.position)
      const targetDirection = center.clone().sub(end).setY(0).normalize()
      contactLine.geometry.dispose()
      contactLine.geometry = new THREE.BufferGeometry().setFromPoints([center, center.clone().addScaledVector(targetDirection, 0.22)])
      contactLine.visible = true
    }
  }

  function setAim(partial: Partial<AimParameters>, notify = true): void {
    const next = normalizeAim({ ...aim, ...partial })
    if (Object.keys(next).every(key => next[key as keyof AimParameters] === aim[key as keyof AimParameters])) return
    aim = next
    updateAimGuide()
    if (notify) callbacks.onAimChange?.({ ...aim })
  }

  function resetCamera(topDown = false): void {
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
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, placement: null }
    canvas.setPointerCapture(event.pointerId)
    if (position && interaction.canPlaceCueBall) { pointer.placement = position; updatePlacement(position) }
  }

  function pointerMove(event: PointerEvent): void {
    if (!pointer || pointer.id !== event.pointerId || activePointers.size > 1) return
    pointer.moved ||= Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 4
    const position = pointOnTable(event)
    if (!position) return
    if (interaction.canPlaceCueBall && !interaction.spectator && !playback) {
      pointer.placement = position
      updatePlacement(position)
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
      if (position && isEnabled()) aimAt(position)
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
    keys.add(event.code)
    if (action === 'orbit') updateOrbitButtons()
  }
  function keyUp(event: KeyboardEvent): void { keys.delete(event.code); updateOrbitButtons() }
  function clearKeys(): void { keys.clear(); updateOrbitButtons(); pointer = null; activePointers.clear(); placement.visible = false }

  function updateKeys(delta: number): void {
    if (!isEnabled()) return
    const held = (action: BindingAction) => keys.has(settings.bindings[action] ?? DEFAULT_BINDINGS[action]) ? 1 : 0
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
      else if (type.includes('stick_ball') || type.includes('stick-ball')) audio.impact('cue', aim.V0 / 8)
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
    controls.update()
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
    playShot(trajectory, startAt) {
      if (!trajectory.frames.length || !Number.isFinite(startAt)) { callbacks.onError?.('Получены некорректные данные удара.'); return }
      playback = { trajectory, startAt, lastT: Math.max(0, (Date.now() - startAt) / 1000), eventIndex: 0 }
      clearKeys()
      updateAimGuide()
    },
    setSettings,
    resetCamera,
    setCalledPocket(id) { calledPocket = id == null ? null : String(id); refreshPocketSelection() },
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
