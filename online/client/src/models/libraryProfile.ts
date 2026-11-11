import { emptyVisualAssetProfile, type ModelConfiguration, type ModelLibraryAsset, type ModelLibrarySelection,
  type ModelLibrarySnapshot, type ModelRole, type VisualAssetProfile, type VisualAssetSlot } from './types'
import { validateVisualAssetProfile } from './validation'

export function slotForLibraryAsset(asset: ModelLibraryAsset): VisualAssetSlot {
  const profile = validateVisualAssetProfile({ version: 1, [asset.role]: { ...asset.config, name: asset.name, source: { kind: 'url', url: asset.url } } })
  const slot = profile[asset.role]
  if (!slot) throw new Error('Некорректная роль модели в библиотеке')
  return slot
}
export function profileFromLibrary(library: ModelLibrarySnapshot): VisualAssetProfile {
  const profile = emptyVisualAssetProfile()
  for (const role of ['table', 'environment'] as const) {
    const id = role === 'table' ? library.profile.tableId : library.profile.environmentId
    const asset = library.assets.find(asset => asset.id === id && asset.role === role && asset.enabled)
    if (asset) profile[role] = slotForLibraryAsset(asset)
  }
  return profile
}
export function configurationOf(slot: VisualAssetSlot): ModelConfiguration {
  // Vue drafts contain proxies, which structuredClone cannot clone. Validation
  // produces fresh plain values and also prevents invalid edits being published.
  const clean = validateVisualAssetProfile({ version: 1, table: slot, environment: null }).table!
  const { name: _name, source: _source, ...config } = clean
  return config
}
export function libraryAssetForSlot(slot: VisualAssetSlot | null, role: ModelRole, library: ModelLibrarySnapshot): ModelLibraryAsset | null {
  if (!slot || slot.source.kind !== 'url') return null
  const url = slot.source.url
  return library.assets.find(asset => asset.role === role && asset.url === url) ?? null
}
export function selectionFromProfile(profile: VisualAssetProfile, library: ModelLibrarySnapshot): ModelLibrarySelection {
  const selection: ModelLibrarySelection = { tableId: null, environmentId: null }
  for (const role of ['table', 'environment'] as const) {
    const slot = profile[role]
    if (!slot) continue
    const asset = libraryAssetForSlot(slot, role, library)
    if (!asset) throw new Error('Сначала сохраните все импортированные модели в общей библиотеке')
    selection[role === 'table' ? 'tableId' : 'environmentId'] = asset.id
  }
  return selection
}
