import { emptyVisualAssetProfile, type StoredModelAsset, type VisualAssetProfile } from './types'
import { MAX_MODEL_BYTES, validateGlb, validateVisualAssetProfile } from './validation'

const DATABASE = 'pooltool-model-workshop'
const PROFILE_KEY = 'active'
let database: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Браузер не предоставляет IndexedDB для локальных моделей'))
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('assets', { keyPath: 'id' }); request.result.createObjectStore('profiles') }
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null }; resolve(request.result) }
    request.onerror = () => { database = null; reject(request.error ?? new Error('Не удалось открыть хранилище моделей')) }
  })
  return database
}
async function transaction<T>(store: 'assets' | 'profiles', mode: IDBTransactionMode, run: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const connection = await db()
  return new Promise<T>((resolve, reject) => {
    const tx = connection.transaction(store, mode), request = run(tx.objectStore(store))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error ?? new Error('Ошибка чтения модели'))
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error ?? new Error('Ошибка сохранения модели'))
    tx.onabort = () => reject(tx.error ?? new Error('Сохранение модели отменено'))
  })
}

export async function importLocalModel(file: File): Promise<StoredModelAsset> {
  if (!/\.glb$/i.test(file.name) || file.size > MAX_MODEL_BYTES) throw new Error('Выберите самодостаточный файл .glb до 50 МБ')
  const bytes = await file.arrayBuffer()
  validateGlb(bytes)
  const id = crypto.randomUUID?.() ?? `model-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const asset: StoredModelAsset = { id, name: file.name.slice(0, 160), bytes, createdAt: Date.now() }
  await transaction('assets', 'readwrite', store => store.put(asset))
  return asset
}
export async function getLocalModel(id: string): Promise<StoredModelAsset | null> {
  return (await transaction<StoredModelAsset | undefined>('assets', 'readonly', store => store.get(id))) ?? null
}
export async function listLocalModels(): Promise<Array<Omit<StoredModelAsset, 'bytes'> & { size: number }>> {
  const assets = await transaction<StoredModelAsset[]>('assets', 'readonly', store => store.getAll())
  return assets.map(({ bytes, ...metadata }) => ({ ...metadata, size: bytes.byteLength })).sort((a, b) => b.createdAt - a.createdAt)
}
export async function deleteLocalModel(id: string): Promise<void> {
  await transaction('assets', 'readwrite', store => store.delete(id))
}
export async function loadVisualAssetProfile(): Promise<VisualAssetProfile> {
  const value = await transaction<unknown>('profiles', 'readonly', store => store.get(PROFILE_KEY))
  return value ? validateVisualAssetProfile(value) : emptyVisualAssetProfile()
}
export async function saveVisualAssetProfile(profile: VisualAssetProfile): Promise<void> {
  await transaction('profiles', 'readwrite', store => store.put(validateVisualAssetProfile(profile), PROFILE_KEY))
}

export function exportVisualAssetProfile(profile: VisualAssetProfile): string {
  return JSON.stringify(validateVisualAssetProfile(profile), null, 2)
}
export function importVisualAssetProfile(text: string): VisualAssetProfile {
  if (text.length > 256 * 1024) throw new Error('Конфигурация моделей слишком большая')
  try { return validateVisualAssetProfile(JSON.parse(text)) }
  catch (error) { throw new Error(error instanceof Error ? error.message : 'Некорректный JSON конфигурации') }
}

/** Optional checked-in shared catalogue: no endpoint accepts arbitrary uploads. */
export async function loadPublishedVisualAssets(url = '/models/scene.json'): Promise<VisualAssetProfile | null> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Не удалось загрузить каталог моделей (${response.status})`)
  const text = await response.text()
  const profile = importVisualAssetProfile(text)
  for (const role of ['table', 'environment'] as const) if (profile[role]?.source.kind === 'local') throw new Error('Общий каталог не может ссылаться на локальные ID другого браузера')
  return profile
}
