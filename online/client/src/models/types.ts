export type ModelRole = 'table' | 'environment'
export type ModelVector = [number, number, number]
export type ModelSource = { kind: 'local'; id: string } | { kind: 'url'; url: string }

export interface ModelMaterialOverride {
  color?: string
  roughness?: number
  metalness?: number
  emissive?: string
  emissiveIntensity?: number
}

export interface VisualAssetSlot {
  name: string
  source: ModelSource
  /** World metres; table origin is the centre of the authoritative cloth. */
  position: ModelVector
  /** XYZ Euler angles in degrees; glTF uses Y up. */
  rotation: ModelVector
  scale: ModelVector
  replaceProcedural: boolean
  material: ModelMaterialOverride
  materials: Record<string, ModelMaterialOverride>
  hiddenNodes: string[]
}

export interface VisualAssetProfile {
  version: 1
  table: VisualAssetSlot | null
  environment: VisualAssetSlot | null
}
export type ModelConfiguration = Omit<VisualAssetSlot, 'name' | 'source'>
export interface ModelLibraryAsset {
  id: string
  name: string
  role: ModelRole
  url: string
  bytes: number
  enabled: boolean
  config: ModelConfiguration
  createdAt?: string | number
  updatedAt?: string | number
  sha256?: string
}
export interface ModelLibrarySelection { tableId: string | null; environmentId: string | null }
export interface ModelLibrarySnapshot { version: number; assets: ModelLibraryAsset[]; profile: ModelLibrarySelection }
/** Authentication stays in the app adapter, not in the preparation component. */
export interface ModelLibraryAdapter {
  load: () => Promise<ModelLibrarySnapshot>
  upload: (file: File, role: ModelRole) => Promise<ModelLibraryAsset>
  update: (id: string, patch: { name?: string; enabled?: boolean; config?: ModelConfiguration }) => Promise<ModelLibraryAsset>
  remove: (id: string) => Promise<void>
  publish: (selection: ModelLibrarySelection, configs: Record<string, ModelConfiguration>) => Promise<ModelLibrarySnapshot | void>
}

export interface StoredModelAsset {
  id: string
  name: string
  bytes: ArrayBuffer
  createdAt: number
}

export interface ModelAssetInfo {
  name: string
  meshes: number
  vertices: number
  materials: string[]
  materialDefaults: Record<string, ModelMaterialOverride>
  nodes: string[]
  bounds: { min: ModelVector; max: ModelVector }
}

export interface VisualAssetLoadReport {
  table: ModelAssetInfo | null
  environment: ModelAssetInfo | null
  errors: Partial<Record<ModelRole, string>>
}

export const emptyVisualAssetProfile = (): VisualAssetProfile => ({ version: 1, table: null, environment: null })
export const emptyVisualAssetReport = (): VisualAssetLoadReport => ({ table: null, environment: null, errors: {} })

export function defaultModelSlot(name: string, source: ModelSource): VisualAssetSlot {
  return { name, source, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], replaceProcedural: true,
    material: {}, materials: {}, hiddenNodes: [] }
}
