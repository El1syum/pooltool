<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createGameScene } from '../game/createGameScene'
import type { GameScene, GameSnapshot } from '../game/types'
import { defaultPreviewSnapshot, loadTableReference, validatePreviewSnapshot } from '../models/previewSnapshot'
import { defaultPlayerAssetSelection, parsePlayerAssetSelection, playerAssetChoiceFromValue, playerAssetChoiceValue, resolvePlayerAssets, type PlayerAssetSelection } from '../models/playerSelection'
import { emptyVisualAssetReport, type ModelLibraryAsset, type ModelLibrarySnapshot, type ModelRole } from '../models/types'
import '../models/playerAppearance.css'

const props = withDefaults(defineProps<{
  library: ModelLibrarySnapshot | null
  selection: PlayerAssetSelection
  snapshot?: GameSnapshot | null
  loading?: boolean
  error?: string
}>(), { snapshot: null, loading: false, error: '' })
const emit = defineEmits<{ apply: [selection: PlayerAssetSelection]; close: []; retry: []; manage: [] }>()
const draft = ref(parsePlayerAssetSelection(props.selection))
const dialog = ref<HTMLElement | null>(null), stage = ref<HTMLDivElement | null>(null)
const modelLoading = ref(false), renderError = ref(''), invalidated = ref<ModelRole[]>([])
const report = ref(emptyVisualAssetReport())
const reference = ref(defaultPreviewSnapshot())
const referenceSource = ref<'match' | 'server' | 'fallback'>('fallback')
const resolved = computed(() => resolvePlayerAssets(draft.value, props.library))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(parsePlayerAssetSelection(props.selection)))
const roles: ModelRole[] = ['table', 'environment']
const roleName = (role: ModelRole) => role === 'table' ? 'Стол' : 'Окружение'
const list = (role: ModelRole) => props.library?.assets.filter(asset => asset.enabled && asset.role === role) ?? []
const megabytes = (bytes: number) => (bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const metric = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 4 })
const sourceLabel = computed(() => referenceSource.value === 'match' ? 'размеры текущего матча' : referenceSource.value === 'server' ? 'игровой эталон сервера' : 'локальный игровой эталон')
const base = import.meta.env.BASE_URL || '/'
let preview: GameScene | null = null, disposed = false, generation = 0
let previousFocus: HTMLElement | null = null

function serverName(role: ModelRole) {
  const id = role === 'table' ? props.library?.profile.tableId : props.library?.profile.environmentId
  return list(role).find(asset => asset.id === id)?.name || 'базовая сцена'
}
function unresolvedChoice(role: ModelRole) {
  const selected = draft.value[role]
  return selected.mode === 'asset' && !list(role).some(asset => asset.id === selected.id)
}
function selectedAsset(role: ModelRole): ModelLibraryAsset | undefined {
  const selected = draft.value[role]
  return selected.mode === 'asset' ? list(role).find(asset => asset.id === selected.id) : undefined
}
function select(role: ModelRole, event: Event) {
  const next = resolvePlayerAssets({ ...draft.value, [role]: playerAssetChoiceFromValue((event.target as HTMLSelectElement).value) }, props.library)
  draft.value = next.selection
  invalidated.value = [...invalidated.value.filter(item => item !== role), ...next.unavailable]
}
function apply() { emit('apply', parsePlayerAssetSelection(resolved.value.selection)) }
async function refreshPreview() {
  if (!preview) return
  const current = ++generation
  modelLoading.value = true; report.value = emptyVisualAssetReport()
  try {
    const next = await preview.setVisualAssets(resolved.value.profile)
    if (!disposed && current === generation) report.value = next
  } catch (failure) { if (!disposed && current === generation) renderError.value = failure instanceof Error ? failure.message : 'Предпросмотр недоступен' }
  finally { if (!disposed && current === generation) modelLoading.value = false }
}
function setReference(snapshot: GameSnapshot, source: 'match' | 'server' | 'fallback') {
  try {
    reference.value = validatePreviewSnapshot(snapshot)
    referenceSource.value = source
    preview?.setState(reference.value)
  } catch { /* Keep the last valid reference rather than changing physical scale. */ }
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])].filter(element => element.getClientRects().length)
  if (!controls.length) { event.preventDefault(); dialog.value?.focus(); return }
  const first = controls[0], last = controls[controls.length - 1]
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus() }
}
watch(() => props.selection, (value, previous) => {
  if (JSON.stringify(draft.value) === JSON.stringify(parsePlayerAssetSelection(previous))) draft.value = parsePlayerAssetSelection(value)
}, { deep: true })
watch(() => props.library, library => {
  if (!library) return
  const next = resolvePlayerAssets(draft.value, library)
  invalidated.value = next.unavailable
  draft.value = next.selection
}, { deep: true, immediate: true })
watch(() => resolved.value.profile, () => { void refreshPreview() }, { deep: true })
watch(() => props.snapshot, value => { if (value) setReference(value, 'match') }, { deep: true })
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKey, true)
  if (props.snapshot) setReference(props.snapshot, 'match')
  if (stage.value) {
    try {
      preview = createGameScene(stage.value, { onError: message => { renderError.value = message } })
      preview.setSettings({ quality: 'low', volume: 0, showAimGuide: false, showPocketLabels: false })
      preview.setState(reference.value)
      preview.setInteraction({ canShoot: false, canPlaceCueBall: false, spectator: true, showRemoteAim: false })
      preview.setCalibrationOverlay(false)
      preview.resetCamera()
      void refreshPreview()
    } catch (failure) { renderError.value = failure instanceof Error ? failure.message : '3D-предпросмотр недоступен' }
  }
  if (!props.snapshot) void loadTableReference().then(result => { if (!disposed && !props.snapshot) setReference(result.snapshot, result.source) })
  await nextTick()
  dialog.value?.querySelector<HTMLElement>('button')?.focus()
})
onBeforeUnmount(() => {
  disposed = true; generation++
  window.removeEventListener('keydown', onKey, true)
  preview?.destroy(); preview = null
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <section ref="dialog" class="appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title" aria-describedby="appearance-scope" tabindex="-1">
    <div class="appearance-content">
      <header class="appearance-header">
        <div><p class="appearance-eyebrow">POOLTOOL · ВАШ КЛУБ</p><h1 id="appearance-title">Оформление</h1></div>
        <button class="appearance-back" type="button" @click="emit('close')"><img :src="`${base}ui/club-menu/arrow-left.svg`" alt="" />Назад</button>
      </header>
      <p id="appearance-scope" class="appearance-scope">Только у вас на этом устройстве. На физику и противника не влияет.</p>
      <div class="appearance-layout">
        <div class="appearance-preview-column">
          <div class="appearance-preview-frame" :aria-busy="modelLoading">
            <div ref="stage" class="appearance-preview" aria-label="3D-предпросмотр оформления, без управления игрой"></div>
            <span v-if="modelLoading" class="appearance-preview-loading" role="status">Загружаем модель…</span>
          </div>
          <div class="appearance-camera" role="toolbar" aria-label="Камера предпросмотра"><button type="button" @click="preview?.resetCamera()">Общий вид</button><button type="button" @click="preview?.resetCamera(true)">Сверху</button><button type="button" aria-label="Повернуть предпросмотр влево" @click="preview?.rotateCamera(-0.4)">↶</button><button type="button" aria-label="Повернуть предпросмотр вправо" @click="preview?.rotateCamera(0.4)">↷</button><button type="button" aria-label="Приблизить предпросмотр" @click="preview?.zoomCamera(0.8)">+</button><button type="button" aria-label="Отдалить предпросмотр" @click="preview?.zoomCamera(1.25)">−</button></div>
          <p class="appearance-caption">Предпросмотр · {{ sourceLabel }} · поле {{ metric(reference.table.width) }} × {{ metric(reference.table.length) }} м.</p>
          <p v-if="renderError" class="appearance-warning" role="alert">{{ renderError }}. Выбор оформления остаётся доступен.</p>
          <p v-for="(message, role) in report.errors" :key="role" class="appearance-warning" role="alert">{{ roleName(role as ModelRole) }}: {{ message }}. Показана базовая геометрия.</p>
        </div>
        <div class="appearance-options">
          <div class="appearance-options-heading"><h2>Ваш выбор</h2><span>Личное оформление</span></div>
          <p v-if="loading" class="appearance-notice" role="status">Обновляем библиотеку. Текущий выбор сохранён.</p>
          <p v-if="error" class="appearance-warning" role="alert">{{ error }}</p>
          <p v-if="!library && !loading" class="appearance-notice">Библиотека пока недоступна. Предпросмотр показывает базовую сцену; сохранённые модели не сброшены.</p>
          <p v-if="invalidated.length" class="appearance-warning" role="status">{{ invalidated.map(roleName).join(', ') }}: выбранная модель больше недоступна. Используется общий вариант.</p>
          <div v-for="role in roles" :key="role" class="appearance-role">
            <label :for="`appearance-${role}`">{{ roleName(role) }}</label>
            <select :id="`appearance-${role}`" :value="playerAssetChoiceValue(draft[role])" @change="select(role, $event)">
              <option value="default">Как в общей сцене · {{ serverName(role) }}</option>
              <option value="procedural">{{ role === 'table' ? 'Базовый стол' : 'Базовое окружение' }}</option>
              <option v-if="unresolvedChoice(role)" :value="playerAssetChoiceValue(draft[role])" disabled>Выбранная модель · ожидание библиотеки</option>
              <option v-for="asset in list(role)" :key="asset.id" :value="`asset:${asset.id}`">{{ asset.name }} · {{ megabytes(asset.bytes) }} МБ</option>
            </select>
            <p v-if="selectedAsset(role)" class="appearance-choice-detail">{{ selectedAsset(role)?.name }}<span>{{ megabytes(selectedAsset(role)?.bytes || 0) }} МБ · из общей библиотеки</span></p>
            <p v-else-if="draft[role].mode === 'default'" class="appearance-role-note">Следует опубликованному выбору администратора.</p>
            <p v-else-if="draft[role].mode === 'procedural'" class="appearance-role-note">Исходное оформление без дополнительной 3D-модели.</p>
          </div>
          <p v-if="library && !library.assets.some(asset => asset.enabled)" class="appearance-notice">Дополнительных моделей пока нет. Администратор может добавить их в общую библиотеку.</p>
          <div class="appearance-secondary-actions"><button type="button" :disabled="loading" @click="emit('retry')">Обновить библиотеку</button><button type="button" @click="draft = defaultPlayerAssetSelection(); invalidated = []">Сбросить выбор</button></div>
          <div class="appearance-apply-actions"><button type="button" @click="emit('close')">Отмена</button><button class="appearance-primary" type="button" @click="apply">Применить</button></div>
          <p class="appearance-save-note">{{ dirty ? 'Изменения ещё не применены.' : 'Общая сцена не меняется.' }} Для выбора модели вход администратора не нужен.</p>
          <button class="appearance-manage" type="button" @click="emit('manage')">Общая библиотека и мастерская</button>
        </div>
      </div>
    </div>
  </section>
</template>
