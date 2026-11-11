import { slotForLibraryAsset } from './libraryProfile'
import type { ModelLibraryAsset, ModelLibrarySnapshot, ModelRole, VisualAssetProfile, VisualAssetSlot } from './types'

/** Personal presentation only. No URLs, model transforms, or admin state are saved. */
export type PlayerAssetChoice = { mode: 'default' } | { mode: 'procedural' } | { mode: 'asset'; id: string }
export interface PlayerAssetSelection { version: 1; table: PlayerAssetChoice; environment: PlayerAssetChoice }
export interface ResolvedPlayerAssets {
  selection: PlayerAssetSelection
  profile: VisualAssetProfile
  /** Explicit saved choices invalidated by a confirmed catalogue, not a failed fetch. */
  unavailable: ModelRole[]
}
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>
const roles: ModelRole[] = ['table', 'environment']
const assetId = /^[A-Za-z0-9_-]{1,128}$/

export const defaultPlayerAssetSelection = (): PlayerAssetSelection => ({ version: 1, table: { mode: 'default' }, environment: { mode: 'default' } })

function choice(value: unknown): PlayerAssetChoice {
  if (!value || typeof value !== 'object') return { mode: 'default' }
  const item = value as Record<string, unknown>
  if (item.mode === 'procedural') return { mode: 'procedural' }
  if (item.mode === 'asset' && typeof item.id === 'string' && assetId.test(item.id)) return { mode: 'asset', id: item.id }
  return { mode: 'default' }
}

export function parsePlayerAssetSelection(value: unknown): PlayerAssetSelection {
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1) return defaultPlayerAssetSelection()
  const item = value as Record<string, unknown>
  return { version: 1, table: choice(item.table), environment: choice(item.environment) }
}

export function playerAssetStorageKey(userId: string | null | undefined): string | null {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 256
    ? `pooltool.assets.${encodeURIComponent(userId)}` : null
}

export function readPlayerAssetSelection(storage: PreferenceStorage | null | undefined, userId: string | null | undefined): PlayerAssetSelection {
  const key = playerAssetStorageKey(userId)
  if (!storage || !key) return defaultPlayerAssetSelection()
  try { return parsePlayerAssetSelection(JSON.parse(storage.getItem(key) || 'null')) }
  catch { return defaultPlayerAssetSelection() }
}

export function writePlayerAssetSelection(storage: PreferenceStorage | null | undefined, userId: string | null | undefined, value: unknown): boolean {
  const key = playerAssetStorageKey(userId)
  if (!storage || !key) return false
  try { storage.setItem(key, JSON.stringify(parsePlayerAssetSelection(value))); return true }
  catch { return false }
}

function findAsset(library: ModelLibrarySnapshot, role: ModelRole, id: string | null): ModelLibraryAsset | undefined {
  return library.assets.find(asset => asset.id === id && asset.role === role && asset.enabled)
}

/** Only a successfully loaded catalogue may invalidate a saved asset ID. */
export function reconcilePlayerAssetSelection(value: unknown, library: ModelLibrarySnapshot | null | undefined): PlayerAssetSelection {
  const result = parsePlayerAssetSelection(value)
  if (!library) return result
  for (const role of roles) {
    const selected = result[role]
    if (selected.mode === 'asset' && !findAsset(library, role, selected.id)) result[role] = { mode: 'default' }
  }
  return result
}

export function resolvePlayerAssets(value: unknown, library: ModelLibrarySnapshot | null | undefined): ResolvedPlayerAssets {
  const original = parsePlayerAssetSelection(value)
  const selection = reconcilePlayerAssetSelection(original, library)
  const profile: VisualAssetProfile = { version: 1, table: null, environment: null }
  const unavailable: ModelRole[] = []
  if (!library) return { selection, profile, unavailable }
  const serverId = (role: ModelRole) => role === 'table' ? library.profile.tableId : library.profile.environmentId
  const resolveSlot = (role: ModelRole, id: string | null): VisualAssetSlot | null => {
    const asset = findAsset(library, role, id)
    if (!asset) return null
    try { return slotForLibraryAsset(asset) }
    catch { return null } // Invalid remote metadata never grants a URL/config override.
  }
  for (const role of roles) {
    const selected = selection[role]
    if (original[role].mode === 'asset' && selected.mode !== 'asset') unavailable.push(role)
    if (selected.mode === 'procedural') continue
    const id = selected.mode === 'asset' ? selected.id : serverId(role)
    profile[role] = resolveSlot(role, id)
    if (selected.mode === 'asset' && !profile[role]) {
      selection[role] = { mode: 'default' }
      if (!unavailable.includes(role)) unavailable.push(role)
      profile[role] = resolveSlot(role, serverId(role))
    }
  }
  return { selection, profile, unavailable }
}

export function playerAssetChoiceValue(value: PlayerAssetChoice): string {
  return value.mode === 'asset' ? `asset:${value.id}` : value.mode
}
export function playerAssetChoiceFromValue(value: string): PlayerAssetChoice {
  return value === 'procedural' ? { mode: 'procedural' }
    : value.startsWith('asset:') ? choice({ mode: 'asset', id: value.slice(6) }) : { mode: 'default' }
}
