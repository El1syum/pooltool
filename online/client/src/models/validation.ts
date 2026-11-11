import type { ModelMaterialOverride, ModelVector, VisualAssetProfile, VisualAssetSlot } from './types'

export const MAX_MODEL_BYTES = 50 * 1024 * 1024
export const MAX_MODEL_VERTICES = 1_000_000
export const MAX_MODEL_NODES = 3000
export const MAX_TEXTURE_SIZE = 8192
export class ModelValidationError extends Error {}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelValidationError('Некорректный объект конфигурации модели')
  return value as Record<string, unknown>
}
const label = (value: unknown, fallback = '') => typeof value === 'string' ? value.slice(0, 160) : fallback
const number = (value: unknown, low: number, high: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new ModelValidationError(`Недопустимое значение: ${field}`)
  return value
}
function vector(value: unknown, fallback: ModelVector, low: number, high: number, field: string): ModelVector {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length !== 3) throw new ModelValidationError(`Требуются три координаты: ${field}`)
  return value.map(entry => number(entry, low, high, field)) as ModelVector
}
function material(value: unknown): ModelMaterialOverride {
  if (value === undefined) return {}
  const source = object(value), result: ModelMaterialOverride = {}
  for (const field of ['color', 'emissive'] as const) if (source[field] !== undefined) {
    if (typeof source[field] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(source[field])) throw new ModelValidationError(`Цвет ${field} должен быть #RRGGBB`)
    result[field] = source[field] as string
  }
  for (const field of ['roughness', 'metalness'] as const) if (source[field] !== undefined) result[field] = number(source[field], 0, 1, field)
  if (source.emissiveIntensity !== undefined) result.emissiveIntensity = number(source.emissiveIntensity, 0, 10, 'emissiveIntensity')
  return result
}

/** Published art must stay in the same-origin static model catalogue, never an API or arbitrary URL. */
export function validatePublishedModelUrl(value: unknown, origin = 'https://pooltool.invalid'): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/models/')) throw new ModelValidationError('Публичная модель должна находиться в /models/ на сервере игры')
  const url = new URL(value, origin)
  let decoded: string
  try { decoded = decodeURIComponent(url.pathname) } catch { throw new ModelValidationError('Некорректный путь модели') }
  if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol) || url.hash || decoded.includes('\\')
      || !decoded.startsWith('/models/') || decoded.split('/').includes('..') || !decoded.toLowerCase().endsWith('.glb')) {
    throw new ModelValidationError('Допускается только локальный путь /models/…/*.glb без переходов по каталогам')
  }
  return url.pathname + url.search
}

function slot(value: unknown): VisualAssetSlot | null {
  if (value == null) return null
  const source = object(value), modelSource = object(source.source)
  let resolved: VisualAssetSlot['source']
  if (modelSource.kind === 'local' && typeof modelSource.id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(modelSource.id)) resolved = { kind: 'local', id: modelSource.id }
  else if (modelSource.kind === 'url') resolved = { kind: 'url', url: validatePublishedModelUrl(modelSource.url) }
  else throw new ModelValidationError('Неизвестный источник модели')
  const materials: Record<string, ModelMaterialOverride> = Object.create(null)
  if (source.materials !== undefined) {
    const entries = Object.entries(object(source.materials))
    if (entries.length > 300) throw new ModelValidationError('Слишком много материалов')
    for (const [name, override] of entries) materials[label(name)] = material(override)
  }
  if (source.hiddenNodes !== undefined && (!Array.isArray(source.hiddenNodes) || source.hiddenNodes.length > MAX_MODEL_NODES || source.hiddenNodes.some(name => typeof name !== 'string'))) throw new ModelValidationError('Некорректный список скрытых узлов')
  return { name: label(source.name, 'Модель'), source: resolved,
    position: vector(source.position, [0, 0, 0], -100, 100, 'position'),
    rotation: vector(source.rotation, [0, 0, 0], -3600, 3600, 'rotation'),
    scale: vector(source.scale, [1, 1, 1], 0.0001, 1000, 'scale'),
    replaceProcedural: source.replaceProcedural !== false, material: material(source.material), materials,
    hiddenNodes: ((source.hiddenNodes ?? []) as string[]).map(name => label(name)) }
}

export function validateVisualAssetProfile(value: unknown): VisualAssetProfile {
  const source = object(value)
  if (source.version !== 1) throw new ModelValidationError('Неподдерживаемая версия конфигурации моделей')
  return { version: 1, table: slot(source.table), environment: slot(source.environment) }
}

/** Validate GLB before GLTFLoader can resolve any embedded resource URL. */
export function validateGlb(bytes: ArrayBuffer): Record<string, unknown> {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_MODEL_BYTES) throw new ModelValidationError('Нужен самодостаточный GLB до 50 МБ')
  const view = new DataView(bytes)
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) throw new ModelValidationError('Файл не является корректным GLB 2.0')
  let offset = 12, json: Record<string, unknown> | null = null, chunks = 0
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new ModelValidationError('Повреждён заголовок блока GLB')
    const length = view.getUint32(offset, true), kind = view.getUint32(offset + 4, true)
    offset += 8
    if (length % 4 || offset + length > bytes.byteLength) throw new ModelValidationError('Повреждена длина блока GLB')
    if (chunks === 0 && kind !== 0x4e4f534a) throw new ModelValidationError('Первым блоком GLB должен быть JSON')
    if (kind === 0x4e4f534a) {
      if (json || length > 8 * 1024 * 1024) throw new ModelValidationError('Некорректный JSON-блок GLB')
      try { json = object(JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, offset, length)).replace(/[\u0000\s]+$/, ''))) }
      catch { throw new ModelValidationError('Не удалось прочитать JSON модели') }
    }
    offset += length; chunks++
  }
  if (!json || (object(json.asset).version !== '2.0')) throw new ModelValidationError('Требуется glTF 2.0')
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 80) throw new ModelValidationError('Слишком глубокая структура GLB')
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (key.toLowerCase() === 'uri' && (typeof entry !== 'string' || !entry.startsWith('data:'))) throw new ModelValidationError('Внешние файлы запрещены: сохраните модель как GLB со встроенными текстурами')
      walk(entry, depth + 1)
    }
  }
  walk(json)
  if (Array.isArray(json.nodes) && json.nodes.length > MAX_MODEL_NODES) throw new ModelValidationError('В модели слишком много узлов (максимум 3000)')
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired : []
  if (required.some(extension => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(String(extension)))) throw new ModelValidationError('Пересохраните GLB без обязательных Draco/Meshopt/KTX2-декодеров')
  return json
}
