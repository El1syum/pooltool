<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createGameScene } from '../game/createGameScene'
import type { GameScene } from '../game/types'
import { defaultPreviewSnapshot, loadTableReference } from '../models/previewSnapshot'
import { configurationOf, libraryAssetForSlot, profileFromLibrary, selectionFromProfile, slotForLibraryAsset } from '../models/libraryProfile'
import { deleteLocalModel, exportVisualAssetProfile, getLocalModel, importLocalModel, importVisualAssetProfile,
  listLocalModels, loadVisualAssetProfile, saveVisualAssetProfile } from '../models/store'
import { defaultModelSlot, emptyVisualAssetProfile, emptyVisualAssetReport, type ModelLibraryAdapter,
  type ModelLibraryAsset, type ModelLibrarySnapshot, type ModelMaterialOverride, type ModelRole,
  type StoredModelAsset, type VisualAssetProfile } from '../models/types'
import { validateVisualAssetProfile } from '../models/validation'
import '../models/workshop.css'

const props = defineProps<{ library: ModelLibraryAdapter; canManage?: boolean; initialProfile?: VisualAssetProfile }>()
const emit = defineEmits<{ close: []; requestAdmin: []; apply: [profile: VisualAssetProfile] }>()
const library = ref<ModelLibrarySnapshot>({ version: 1, assets: [], profile: { tableId: null, environmentId: null } })
const draft = ref<VisualAssetProfile>(emptyVisualAssetProfile())
const role = ref<ModelRole>('table')
const selected = computed(() => draft.value[role.value])
const report = ref(emptyVisualAssetReport())
const info = computed(() => report.value[role.value])
const materialName = ref('')
const nodeSearch = ref('')
const material = computed(() => selected.value ? {
  ...(materialName.value ? info.value?.materialDefaults[materialName.value] : {}),
  ...selected.value.material,
  ...(materialName.value ? selected.value.materials[materialName.value] : {}),
} : {})
const nodeNames = computed(() => (info.value?.nodes ?? []).filter(name => name.toLowerCase().includes(nodeSearch.value.toLowerCase())).slice(0, 100))
const currentAsset = computed(() => libraryAssetForSlot(selected.value, role.value, library.value))
const available = computed(() => library.value.assets.filter(asset => asset.role === role.value && (asset.enabled || props.canManage)))
const localFiles = ref<Array<Omit<StoredModelAsset, 'bytes'> & { size: number }>>([])
const busy = ref(false), loading = ref(false), dirty = ref(false), calibration = ref(true)
const error = ref(''), message = ref(''), stage = ref<HTMLDivElement | null>(null)
let preview: GameScene | null = null, refreshTimer = 0, disposed = false, previewGeneration = 0
const axes = ['X', 'Y', 'Z']
const roleLabel = (value: ModelRole) => value === 'table' ? 'Стол' : 'Окружение'
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} МБ`

const referenceSource = ref<'server' | 'fallback'>('fallback')
const referenceSnapshot = ref(defaultPreviewSnapshot())

async function refreshPreview() {
  if (!preview) return
  const generation = ++previewGeneration
  loading.value = true
  try {
    const next = await preview.setVisualAssets(draft.value)
    if (!disposed && generation === previewGeneration) report.value = next
  } catch (failure) { if (!disposed && generation === previewGeneration) error.value = failure instanceof Error ? failure.message : 'Не удалось обновить предпросмотр' }
  finally { if (!disposed && generation === previewGeneration) loading.value = false }
}
watch(draft, () => {
  dirty.value = true
  clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => void refreshPreview(), 120)
}, { deep: true })
watch(role, () => { materialName.value = ''; nodeSearch.value = '' })
watch(calibration, value => preview?.setCalibrationOverlay(value))

function setDraft(value: VisualAssetProfile) {
  draft.value = validateVisualAssetProfile(value)
  void nextTick(() => { dirty.value = false })
}
async function action(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await task() } catch (failure) { error.value = failure instanceof Error ? failure.message : 'Операция не выполнена' }
  finally { busy.value = false }
}
async function refreshLibrary(reset = false) {
  library.value = await props.library.load()
  if (reset) setDraft(profileFromLibrary(library.value))
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0], target = role.value
  input.value = ''
  if (!file || !props.canManage) return
  await action(async () => {
    const asset = await importLocalModel(file)
    draft.value[target] = defaultModelSlot(asset.name, { kind: 'local', id: asset.id })
    localFiles.value = await listLocalModels()
    await refreshPreview()
    message.value = 'GLB загружен в локальный черновик. После подготовки опубликуйте его в общей библиотеке.'
  })
}
function selectAsset(asset: ModelLibraryAsset) { if (asset.enabled) { draft.value[role.value] = slotForLibraryAsset(asset); materialName.value = '' } }
function useLocal(id: string, name: string) { draft.value[role.value] = defaultModelSlot(name, { kind: 'local', id }); materialName.value = '' }
function chooseMaterial(name: string) {
  materialName.value = name
  if (name && selected.value && !selected.value.materials[name]) selected.value.materials[name] = {}
}
function setMaterial(field: keyof ModelMaterialOverride, value: string | number) {
  if (!selected.value || !props.canManage) return
  const target = materialName.value ? selected.value.materials[materialName.value] ?? (selected.value.materials[materialName.value] = {}) : selected.value.material
  Object.assign(target, { [field]: value })
}
function resetMaterial() {
  if (!selected.value) return
  if (materialName.value) delete selected.value.materials[materialName.value]
  else selected.value.material = {}
}
async function saveDraft() { await action(async () => { await saveVisualAssetProfile(draft.value); message.value = 'Черновик сохранён только в этом браузере. Общая сцена не изменена.' }) }
async function restoreDraft() { await action(async () => { setDraft(await loadVisualAssetProfile()); await refreshPreview(); message.value = 'Восстановлен локальный черновик; он ещё не опубликован.' }) }
async function saveRole(target: ModelRole): Promise<ModelLibraryAsset | null> {
  const slot = draft.value[target]
  if (!slot) return null
  if (report.value.errors[target]) throw new Error(report.value.errors[target])
  let asset = libraryAssetForSlot(slot, target, library.value)
  if (!asset) {
    if (slot.source.kind !== 'local') throw new Error('Модель не найдена в общей библиотеке')
    const stored = await getLocalModel(slot.source.id)
    if (!stored) throw new Error('Локальный файл отсутствует; повторите импорт')
    asset = await props.library.upload(new File([stored.bytes], stored.name, { type: 'model/gltf-binary' }), target)
    library.value.assets.push(asset)
    draft.value[target] = { ...slot, source: { kind: 'url', url: asset.url } }
  }
  return asset
}
async function saveSelected() {
  if (!props.canManage) return
  await action(async () => {
    const target = role.value, asset = await saveRole(target), slot = draft.value[target]
    if (!asset || !slot) return
    await props.library.update(asset.id, { name: slot.name, config: configurationOf(slot) })
    await refreshLibrary()
    await refreshPreview()
    message.value = 'Модель и её настройки сохранены в общей библиотеке. Выбор сцены публикуется отдельно.'
  })
}
async function publish() {
  if (!props.canManage) return
  await action(async () => {
    await refreshPreview()
    if (Object.keys(report.value.errors).length) throw new Error('Сначала исправьте ошибки предпросмотра')
    for (const target of ['table', 'environment'] as const) await saveRole(target)
    const selection = selectionFromProfile(draft.value, library.value)
    const configs: Record<string, ReturnType<typeof configurationOf>> = {}
    for (const target of ['table', 'environment'] as const) {
      const asset = libraryAssetForSlot(draft.value[target], target, library.value), slot = draft.value[target]
      if (asset && slot) configs[asset.id] = configurationOf(slot)
    }
    const result = await props.library.publish(selection, configs)
    library.value = result ?? await props.library.load()
    const profile = profileFromLibrary(library.value)
    setDraft(profile)
    await saveVisualAssetProfile(profile).catch(() => {})
    emit('apply', profile)
    message.value = 'Общая сцена опубликована. Новые игровые сцены загрузят выбранные модели; физика не меняется.'
  })
}
async function removeAsset(asset: ModelLibraryAsset) {
  if (!props.canManage || !window.confirm(`Удалить модель «${asset.name}» из общей библиотеки?`)) return
  await action(async () => {
    await props.library.remove(asset.id)
    if (currentAsset.value?.id === asset.id) draft.value[role.value] = null
    await refreshLibrary()
    message.value = 'Модель удалена из библиотеки.'
  })
}
async function restoreAsset(asset: ModelLibraryAsset) {
  if (!props.canManage || asset.enabled) return
  await action(async () => {
    await props.library.update(asset.id, { enabled: true })
    await refreshLibrary()
    message.value = 'Модель восстановлена в библиотеке. Общая сцена не изменена; выбор и публикация выполняются отдельно.'
  })
}
async function removeLocal(id: string) {
  if (!props.canManage) return
  await action(async () => {
    for (const target of ['table', 'environment'] as const) if (draft.value[target]?.source.kind === 'local' && draft.value[target]?.source.id === id) draft.value[target] = null
    await deleteLocalModel(id)
    localFiles.value = await listLocalModels()
  })
}
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function exportConfig() { download('pooltool-scene.json', new Blob([exportVisualAssetProfile(draft.value)], { type: 'application/json' })) }
async function importConfig(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file || !props.canManage) return
  await action(async () => {
    if (file.size > 256 * 1024) throw new Error('Конфигурация должна быть меньше 256 КБ')
    setDraft(importVisualAssetProfile(await file.text()))
    dirty.value = true
    await refreshPreview()
    message.value = 'Конфигурация загружена в черновик, но не опубликована.'
  })
}
async function downloadSource() {
  const slot = selected.value
  if (!slot) return
  await action(async () => {
    if (slot.source.kind === 'local') {
      const asset = await getLocalModel(slot.source.id)
      if (!asset) throw new Error('Локальный исходник отсутствует')
      download(asset.name, new Blob([asset.bytes], { type: 'model/gltf-binary' }))
    } else {
      const response = await fetch(slot.source.url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('Не удалось скачать исходную модель')
      download(slot.name.endsWith('.glb') ? slot.name : `${slot.name}.glb`, await response.blob())
    }
  })
}

onMounted(async () => {
  if (stage.value) {
    preview = createGameScene(stage.value)
    preview.setSettings({ quality: 'low', volume: 0, showAimGuide: false, showPocketLabels: true })
    preview.setState(referenceSnapshot.value)
    preview.setInteraction({ canShoot: false, canPlaceCueBall: false, spectator: true })
    preview.setCalibrationOverlay(true)
    void loadTableReference().then(reference => {
      if (!disposed && preview) { referenceSnapshot.value = reference.snapshot; preview.setState(reference.snapshot); referenceSource.value = reference.source }
    })
  }
  await action(async () => {
    await refreshLibrary()
    setDraft(props.initialProfile ?? profileFromLibrary(library.value))
    localFiles.value = await listLocalModels().catch(() => [])
    await refreshPreview()
  })
})
onBeforeUnmount(() => { disposed = true; clearTimeout(refreshTimer); previewGeneration++; preview?.destroy(); preview = null })
</script>

<template>
  <main class="model-workshop" aria-label="Мастерская моделей">
    <header class="model-workshop-header">
      <div><p class="model-eyebrow">POOLTOOL · БИБЛИОТЕКА АССЕТОВ</p><h1>Мастерская моделей</h1></div>
      <div class="model-actions"><span>{{ canManage ? 'Доступ администратора' : 'Просмотр библиотеки' }}</span><button v-if="!canManage" @click="emit('requestAdmin')">Войти администратором</button><button @click="emit('close')">Вернуться</button></div>
    </header>
    <p class="model-scope-note">Модели меняют только внешний вид. Размер поля, лузы, шары и расчёты остаются под контролем физического движка.</p>
    <p v-if="error" class="model-message model-error" role="alert">{{ error }}</p><p v-if="message" class="model-message" role="status">{{ message }}</p>
    <div class="model-workshop-layout">
      <section class="model-preview-column" aria-label="Калибровочный предпросмотр">
        <div ref="stage" class="model-preview-stage"></div>
        <div class="model-preview-toolbar"><button @click="preview?.resetCamera()">Общий вид</button><button @click="preview?.resetCamera(true)">Сверху</button><button @click="preview?.rotateCamera(-0.4)">↶</button><button @click="preview?.rotateCamera(0.4)">↷</button><button @click="preview?.zoomCamera(0.8)">+</button><button @click="preview?.zoomCamera(1.25)">−</button><label><input v-model="calibration" type="checkbox" /> Физические границы</label></div>
        <p class="model-preview-caption">Калибровка, не матч · поле {{ referenceSnapshot.table.width }} × {{ referenceSnapshot.table.length }} м · высота сукна {{ referenceSnapshot.table.renderHeight ?? referenceSnapshot.table.height }} м · {{ referenceSource === 'server' ? 'эталон игрового сервера' : 'локальный эталон, сервер недоступен' }}.</p>
        <p class="model-preview-caption">Жёлтый контур — реальное игровое поле. Начало координат стола — центр сукна; X поперёк, Y вверх, Z вдоль. Окружение начинается на полу.</p>
        <p v-if="loading" class="model-message" role="status">Загрузка модели и проверка ресурсов…</p>
        <p v-for="(text, target) in report.errors" :key="target" class="model-message model-error" role="alert">{{ roleLabel(target as ModelRole) }}: {{ text }}. Показана стандартная геометрия.</p>
        <section class="model-publish-actions"><h2>Черновик и публикация</h2><p>Предпросмотр не меняет общую сцену. Импортируйте GLB, совместите его с физическими границами и опубликуйте результат.</p><div class="model-actions"><button :disabled="busy" @click="exportConfig">Экспорт JSON</button><label v-if="canManage" class="model-file-button">Импорт JSON<input type="file" accept=".json,application/json" :disabled="busy" @change="importConfig" /></label><button v-if="canManage" :disabled="busy" @click="saveDraft">Сохранить черновик</button><button v-if="canManage" :disabled="busy" @click="restoreDraft">Восстановить черновик</button><button v-if="canManage" class="model-primary" :disabled="busy || loading || Object.keys(report.errors).length > 0" @click="publish">Опубликовать общую сцену</button></div><span v-if="dirty" class="model-unsaved">Есть изменения в предпросмотре</span></section>
      </section>
      <aside class="model-editor" aria-label="Настройка модели">
        <div class="model-role-tabs" role="tablist" aria-label="Тип модели"><button v-for="target in (['table', 'environment'] as const)" :key="target" role="tab" :aria-selected="role === target" :disabled="busy" @click="role = target">{{ roleLabel(target) }}</button></div>
        <section><div class="model-section-heading"><h2>Общая библиотека</h2><button :disabled="busy" @click="action(() => refreshLibrary())">Обновить</button></div><p v-if="!available.length">Модели этого типа ещё не загружены.</p><ul class="model-library-list"><li v-for="asset in available" :key="asset.id" :class="{ selected: currentAsset?.id === asset.id }"><button class="model-library-pick" :disabled="busy || !asset.enabled" @click="selectAsset(asset)"><strong>{{ asset.name }}</strong><span>{{ sizeLabel(asset.bytes) }}{{ asset.enabled ? '' : ' · отключена' }}</span></button><button v-if="canManage && !asset.enabled" :disabled="busy" :aria-label="`Восстановить ${asset.name}`" @click="restoreAsset(asset)">Восстановить</button><button v-if="canManage && asset.enabled" :disabled="busy" :aria-label="`Удалить ${asset.name}`" @click="removeAsset(asset)">×</button></li></ul><button :disabled="busy || !selected" @click="draft[role] = null">Стандартная геометрия</button></section>
        <section v-if="canManage"><h2>Подготовить новый GLB</h2><p>GLB 2.0 до 50 МБ со встроенными текстурами. Самостоятельные .gltf, внешние ресурсы и обязательные Draco/Meshopt/KTX2 не поддерживаются.</p><input :key="role" type="file" accept=".glb,model/gltf-binary" aria-label="Импорт GLB модели" :disabled="busy" @change="importFile" /><details v-if="localFiles.length"><summary>Локальные исходники ({{ localFiles.length }})</summary><ul class="model-library-list"><li v-for="asset in localFiles" :key="asset.id"><button :disabled="busy" @click="useLocal(asset.id, asset.name)">{{ asset.name }} · {{ sizeLabel(asset.size) }}</button><button :disabled="busy" :aria-label="`Удалить локальный ${asset.name}`" @click="removeLocal(asset.id)">×</button></li></ul></details></section>
        <template v-if="selected">
          <section><h2>Размещение</h2><label>Название<input v-model="selected.name" maxlength="160" :disabled="!canManage || busy" /></label><div v-for="(title, field) in { position: 'Положение, м', rotation: 'Поворот, градусы', scale: 'Масштаб' }" :key="field" class="model-transform"><h3>{{ title }}</h3><div><label v-for="(axis, index) in axes" :key="axis">{{ axis }}<input v-model.number="selected[field][index]" type="number" :step="field === 'rotation' ? 1 : 0.01" :min="field === 'scale' ? 0.0001 : undefined" :disabled="!canManage || busy" :aria-label="`${title} ${axis}`" /></label></div></div><label><input v-model="selected.replaceProcedural" type="checkbox" :disabled="!canManage || busy" /> Заменять стандартный {{ role === 'table' ? 'стол (лузы остаются физическими)' : 'пол' }}</label><button :disabled="!canManage || busy" @click="selected.position = [0,0,0]; selected.rotation = [0,0,0]; selected.scale = [1,1,1]">Сбросить трансформацию</button></section>
          <section><h2>Материалы</h2><label>Материал<select :value="materialName" @change="chooseMaterial(($event.target as HTMLSelectElement).value)"><option value="">Все материалы</option><option v-for="name in info?.materials || []" :key="name" :value="name">{{ name }}</option></select></label><label>Оттенок<input type="color" :value="material.color || '#ffffff'" :disabled="!canManage || busy" @input="setMaterial('color', ($event.target as HTMLInputElement).value)" /></label><label>Шероховатость {{ (material.roughness ?? 0.8).toFixed(2) }}<input type="range" min="0" max="1" step="0.01" :value="material.roughness ?? 0.8" :disabled="!canManage || busy" @input="setMaterial('roughness', Number(($event.target as HTMLInputElement).value))" /></label><label>Металличность {{ (material.metalness ?? 0).toFixed(2) }}<input type="range" min="0" max="1" step="0.01" :value="material.metalness ?? 0" :disabled="!canManage || busy" @input="setMaterial('metalness', Number(($event.target as HTMLInputElement).value))" /></label><p>Оттенок умножается на исходную PBR-текстуру. Сброс возвращает авторский материал.</p><button :disabled="!canManage || busy" @click="resetMaterial">Сбросить материал</button></section>
          <section v-if="info"><h2>Геометрия</h2><p>{{ info.meshes }} мешей · {{ info.vertices.toLocaleString('ru-RU') }} вершин</p><p>Исходные границы: {{ info.bounds.min.map(n => n.toFixed(3)).join(', ') }} → {{ info.bounds.max.map(n => n.toFixed(3)).join(', ') }}</p><details><summary>Видимость узлов</summary><input v-model="nodeSearch" placeholder="Поиск узла" aria-label="Поиск узла модели" /><p>Отображаются первые 100 совпадений.</p><label v-for="name in nodeNames" :key="name"><input v-model="selected.hiddenNodes" type="checkbox" :value="name" :disabled="!canManage || busy" /> Скрыть {{ name }}</label></details></section>
          <section class="model-actions"><button :disabled="busy" @click="downloadSource">Скачать исходный GLB</button><button v-if="canManage" class="model-primary" :disabled="busy || loading || !!report.errors[role]" @click="saveSelected">Сохранить модель в библиотеку</button></section>
        </template>
      </aside>
    </div>
  </main>
</template>
