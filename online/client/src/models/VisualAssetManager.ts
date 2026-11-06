import * as THREE from 'three'
import { getLocalModel } from './store'
import { emptyVisualAssetProfile, emptyVisualAssetReport, type ModelAssetInfo, type ModelMaterialOverride,
  type ModelRole, type VisualAssetLoadReport, type VisualAssetProfile, type VisualAssetSlot } from './types'
import { MAX_MODEL_BYTES, MAX_MODEL_NODES, MAX_MODEL_VERTICES, MAX_TEXTURE_SIZE, validateGlb, validatePublishedModelUrl, validateVisualAssetProfile } from './validation'

interface LoadedAsset {
  container: THREE.Group
  root: THREE.Group
  materials: Map<THREE.Material, { original: THREE.Material; name: string }>
  visibility: Map<THREE.Object3D, boolean>
  info: ModelAssetInfo
}
interface SlotState { key: string | null; generation: number; controller: AbortController | null; pending: Promise<void> | null; asset: LoadedAsset | null }
interface Options {
  tableHeight: () => number
  onTableReplacement: (replace: boolean) => void
  onEnvironmentReplacement: (replace: boolean) => void
}

function disposeAsset(asset: LoadedAsset): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
  asset.root.traverse(node => {
    if (!(node instanceof THREE.Mesh)) return
    geometries.add(node.geometry)
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material)
  })
  for (const { original } of asset.materials.values()) materials.add(original)
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
  for (const geometry of geometries) geometry.dispose()
  const closedImages = new Set<unknown>()
  for (const texture of textures) {
    texture.dispose()
    const image = texture.image as { close?: () => void } | undefined
    if (image && typeof image.close === 'function' && !closedImages.has(image)) { image.close(); closedImages.add(image) }
  }
  for (const material of materials) material.dispose()
  asset.container.removeFromParent()
  asset.container.clear()
}

function overrideMaterial(material: THREE.Material, override: ModelMaterialOverride): void {
  const target = material as THREE.MeshStandardMaterial
  if (override.color && target.color?.isColor) target.color.set(override.color)
  if (override.emissive && target.emissive?.isColor) target.emissive.set(override.emissive)
  if (override.roughness !== undefined && 'roughness' in target) target.roughness = override.roughness
  if (override.metalness !== undefined && 'metalness' in target) target.metalness = override.metalness
  if (override.emissiveIntensity !== undefined && 'emissiveIntensity' in target) target.emissiveIntensity = override.emissiveIntensity
  material.needsUpdate = true
}

async function responseBytes(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`Файл модели недоступен (${response.status})`)
  if (Number(response.headers.get('content-length')) > MAX_MODEL_BYTES) throw new Error('Модель превышает 50 МБ')
  if (!response.body) return response.arrayBuffer()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_MODEL_BYTES) throw new Error('Модель превышает 50 МБ')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes.buffer
}

async function loadAsset(slot: VisualAssetSlot, signal: AbortSignal): Promise<LoadedAsset> {
  let bytes: ArrayBuffer
  if (slot.source.kind === 'local') {
    const stored = await getLocalModel(slot.source.id)
    if (!stored) throw new Error('Локальный файл отсутствует. Импортируйте GLB в этом браузере заново')
    bytes = stored.bytes
  } else {
    const url = validatePublishedModelUrl(slot.source.url, window.location.origin)
    bytes = await responseBytes(await fetch(url, { credentials: 'same-origin', signal }))
  }
  validateGlb(bytes)
  if (signal.aborted) throw new DOMException('Загрузка отменена', 'AbortError')
  const loading = new THREE.LoadingManager()
  loading.setURLModifier(url => {
    if (/^(data:|blob:)/i.test(url)) return url
    throw new Error('GLB пытается загрузить внешний ресурс: встройте все текстуры в модель')
  })
  // Ordinary games without custom models do not pay the glTF loader download.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader(loading).parseAsync(bytes, '')
  const root = gltf.scene
  const container = new THREE.Group()
  container.name = `pooltool-${slot.name}`
  container.add(root)
  const materials = new Map<THREE.Material, { original: THREE.Material; name: string }>()
  const visibility = new Map<THREE.Object3D, boolean>()
  const info: ModelAssetInfo = { name: slot.name, meshes: 0, vertices: 0, materials: [], materialDefaults: Object.create(null), nodes: [], bounds: { min: [0, 0, 0], max: [0, 0, 0] } }
  const asset: LoadedAsset = { root, container, materials, visibility, info }
  try {
    let nodeCount = 0
    root.traverse(node => {
      nodeCount++
      if (node.name.length > 160) throw new Error('Сократите имена узлов до 160 символов для настройки в мастерской')
      visibility.set(node, node.visible)
      if (node.name) info.nodes.push(node.name)
      if (!(node instanceof THREE.Mesh)) return
      info.meshes++
      info.vertices += (node.geometry.getAttribute('position')?.count ?? 0) * (node instanceof THREE.InstancedMesh ? node.count : 1)
      // Optional authoring hints for cosmetic meshes, e.g. a flat cloth should
      // receive ball shadows without casting a redundant self-shadow.
      node.castShadow = node.userData.pooltoolCastShadow !== false
      node.receiveShadow = node.userData.pooltoolReceiveShadow !== false
      // Model meshes are cosmetic only. Picking still uses server-driven balls,
      // physical pocket markers and the authoritative table plane.
      node.userData = { ...node.userData, pooltoolCosmetic: true }
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (material.name.length > 160) throw new Error('Сократите имена материалов до 160 символов')
        if (!materials.has(material)) materials.set(material, { original: material.clone(), name: material.name || `material-${materials.size + 1}` })
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) {
          const image = value.image as { width?: number; height?: number } | undefined
          if ((image?.width ?? 0) > MAX_TEXTURE_SIZE || (image?.height ?? 0) > MAX_TEXTURE_SIZE) throw new Error('Текстура превышает 8192 px; уменьшите её перед импортом')
        }
      }
    })
    if (nodeCount > MAX_MODEL_NODES || info.vertices > MAX_MODEL_VERTICES || !info.meshes) throw new Error('Нужна модель с геометрией: до 3000 узлов и 1 млн вершин с учётом экземпляров')
    info.materials = [...new Set([...materials.values()].map(value => value.name))].sort()
    for (const { original, name } of materials.values()) {
      const material = original as THREE.MeshStandardMaterial
      info.materialDefaults[name] = {
        ...(material.color?.isColor ? { color: `#${material.color.getHexString()}` } : {}),
        ...(typeof material.roughness === 'number' ? { roughness: material.roughness } : {}),
        ...(typeof material.metalness === 'number' ? { metalness: material.metalness } : {}),
        ...(material.emissive?.isColor ? { emissive: `#${material.emissive.getHexString()}` } : {}),
        ...(typeof material.emissiveIntensity === 'number' ? { emissiveIntensity: material.emissiveIntensity } : {}),
      }
    }
    info.nodes = [...new Set(info.nodes)].sort()
    root.updateMatrixWorld(true)
    const bounds = new THREE.Box3().setFromObject(root)
    if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error('Не удалось определить размеры модели')
    info.bounds = { min: bounds.min.toArray(), max: bounds.max.toArray() }
    return asset
  } catch (error) { disposeAsset(asset); throw error }
}

/** Cosmetic-only models. No scene transform is ever sent to the physics server. */
export class VisualAssetManager {
  private profile = emptyVisualAssetProfile()
  private report = emptyVisualAssetReport()
  private slots: Record<ModelRole, SlotState> = {
    table: { key: null, generation: 0, controller: null, pending: null, asset: null },
    environment: { key: null, generation: 0, controller: null, pending: null, asset: null },
  }
  private destroyed = false
  constructor(private scene: THREE.Scene, private options: Options) {}

  async setProfile(value: VisualAssetProfile): Promise<VisualAssetLoadReport> {
    if (this.destroyed) return this.getReport()
    this.profile = validateVisualAssetProfile(value)
    await Promise.all((['table', 'environment'] as const).map(role => this.update(role)))
    return this.getReport()
  }
  getReport(): VisualAssetLoadReport { return structuredClone(this.report) }
  refresh(): void {
    for (const role of ['table', 'environment'] as const) {
      const asset = this.slots[role].asset, slot = this.profile[role]
      if (asset && slot) {
        asset.container.position.set(slot.position[0], slot.position[1] + (role === 'table' ? this.options.tableHeight() : 0), slot.position[2])
        asset.container.rotation.set(...slot.rotation.map(angle => THREE.MathUtils.degToRad(angle)) as [number, number, number])
        asset.container.scale.set(...slot.scale)
        for (const [material, baseline] of asset.materials) {
          material.copy(baseline.original)
          overrideMaterial(material, { ...slot.material, ...slot.materials[baseline.name] })
        }
        const hidden = new Set(slot.hiddenNodes)
        for (const [node, visible] of asset.visibility) node.visible = visible && !hidden.has(node.name)
      }
    }
    this.options.onTableReplacement(Boolean(this.slots.table.asset && this.profile.table?.replaceProcedural))
    this.options.onEnvironmentReplacement(Boolean(this.slots.environment.asset && this.profile.environment?.replaceProcedural))
  }
  private async update(role: ModelRole): Promise<void> {
    const state = this.slots[role], slot = this.profile[role]
    const key = slot ? JSON.stringify(slot.source) : null
    if (state.key === key && (!slot || state.asset || state.pending)) { this.refresh(); await state.pending; return }
    state.controller?.abort()
    const generation = ++state.generation
    state.key = key
    if (state.asset) disposeAsset(state.asset)
    state.asset = null
    this.report[role] = null
    delete this.report.errors[role]
    this.refresh()
    if (!slot) { state.pending = null; return }
    const controller = state.controller = new AbortController()
    state.pending = (async () => {
      try {
        const asset = await loadAsset(slot, controller.signal)
        if (this.destroyed || generation !== state.generation || controller.signal.aborted) { disposeAsset(asset); return }
        state.asset = asset
        this.report[role] = asset.info
        this.scene.add(asset.container)
        this.refresh()
      } catch (error) {
        if (generation !== state.generation || this.destroyed || controller.signal.aborted) return
        this.report.errors[role] = error instanceof Error ? error.message : 'Не удалось загрузить модель'
        this.refresh()
      } finally { if (generation === state.generation) { state.pending = null; state.controller = null } }
    })()
    await state.pending
  }
  destroy(): void {
    this.destroyed = true
    for (const state of Object.values(this.slots)) { state.generation++; state.controller?.abort(); if (state.asset) disposeAsset(state.asset); state.asset = null }
    this.options.onTableReplacement(false)
    this.options.onEnvironmentReplacement(false)
  }
}
