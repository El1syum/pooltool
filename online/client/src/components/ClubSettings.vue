<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { User } from '../api'
import { DEFAULT_BINDINGS, type BindingAction, type GameSettings } from '../game/types'
import { bindingLabel } from '../game/assistBinding'
import { currentGameAudioOutput, gameAudioOutputs, setGameAudioOutput, supportsGameAudioOutput } from '../game/audio'
import { FRAME_RATE_LIMITS, presentationSettings, renderPixelRatio, RENDER_SCALES, SHADOW_QUALITIES } from '../game/settingsOptions'
import ClubSettingRange from './ClubSettingRange.vue'
import ClubSettingSwitch from './ClubSettingSwitch.vue'
import '../club-menu.css'
import '../club-settings-qa.css'

const props = withDefaults(defineProps<{
  settings: GameSettings; bindingCapture: BindingAction | null
  captureLabels: Record<BindingAction, string>; bindingConflicts: string[]; bindingCaptureError?: string; error?: string
  inMatch: boolean; user?: User | null; clientVersion: string
}>(), { user: null })
const emit = defineEmits<{
  'update:settings': [value: GameSettings]; capture: [action: BindingAction]
  save: []; close: []; home: []
}>()
type Tab = 'index' | 'graphics' | 'sound' | 'controls'
const tab = ref<Tab>('index')
const windowSize = ref({ width: 0, height: 0, ratio: 1 })
const fullscreen = ref(false)
const fullscreenAvailable = ref(false)
const displayModeBusy = ref(false)
const outputBusy = ref(false)
const outputAvailable = ref(false)
const outputDevices = ref<MediaDeviceInfo[]>([])
const outputDevice = ref('')
const localError = ref('')
const dialog = ref<HTMLElement | null>(null)
const scrollArea = ref<HTMLElement | null>(null)
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string, ext = 'svg') => `${base}ui/club-menu/${name}.${ext}`
const matchAsset = (name: string) => `${base}ui/figma-match-settings/${name}.svg`
const numberFormat = new Intl.NumberFormat('ru-RU')
const titles = { index: ['Настройки', 'Настройте атмосферу и почувствуйте игру.'], graphics: ['Графика', 'Каждый блик. Каждая деталь сукна.'], sound: ['Звук', 'Знакомый стук шаров. Тихая музыка клуба.'], controls: ['Управление', 'Точность начинается с удобства.'] }
const title = computed(() => titles[tab.value])
const graphicsSummary = computed(() => ({ low: 'Низкая', medium: 'Средняя', high: 'Высокая' }[props.settings.quality]))
const initial = computed(() => (props.user?.displayName || 'Игрок').trim().split(/\s+/).slice(0, 2).map(x => [...x][0]).join('').toUpperCase())
const graphicsQualities = { low: 'Низкое', medium: 'Среднее', high: 'Высокое' }
const shadowTitles = { auto: 'По качеству графики', off: 'Выкл.', medium: 'Среднее', high: 'Высокое' }
const presentation = computed(() => presentationSettings(props.settings))
const noAudioTrack = 'Аудиодорожка недоступна.'
const sensitivityMin = 0.1
const sensitivityMax = 3
const sensitivityPercent = computed(() => Math.round(100 * (props.settings.sensitivity - sensitivityMin) / (sensitivityMax - sensitivityMin)))
const actionNote = computed(() => tab.value === 'graphics' ? 'Новые параметры применяются без перезапуска.'
  : tab.value === 'sound' ? `Настройте громкость и ${props.inMatch ? 'примените' : 'сохраните'} изменения.`
    : 'Выберите назначение клавиши, чтобы изменить раскладку.')
const actionError = computed(() => localError.value || props.bindingCaptureError
  || props.bindingConflicts.map(conflict => `Конфликт: ${conflict}`).join(' · ') || props.error)
const saveLabel = computed(() => props.inMatch || tab.value === 'graphics' ? 'Применить' : 'Сохранить')
const canSelectOutput = computed(() => outputAvailable.value && (outputDevices.value.length > 0 || !!outputDevice.value))
const audioOutputHint = computed(() => outputAvailable.value ? 'Браузер не предоставил другие устройства вывода.'
  : 'Выбор устройства доступен в поддерживаемом браузере при защищённом подключении.')
type ControlRow = { label: string; value: string } | { label: string; action: BindingAction }
const controlRows = computed<ControlRow[]>(() => [
  { label: 'Прицеливание', value: props.inMatch ? 'Мышь ↔' : 'Мышь' },
  { label: 'Сила и удар', value: 'ЛКМ · удержать' },
  { label: props.inMatch ? 'Точка контакта / вращение' : 'Вращение битка', value: 'Мышь' },
  ...(props.inMatch ? [{ label: 'Наклон кия', value: 'Shift + колесо' }, { label: 'Приближение камеры', value: 'Колесо мыши' }] : []),
  { label: 'Вид сверху', action: 'topView' }, { label: 'Обзор стола', action: 'cueView' },
  { label: props.inMatch ? 'Меню матча' : 'Меню паузы', value: 'Esc' },
])
function update<K extends keyof GameSettings>(key: K, value: GameSettings[K]) { emit('update:settings', { ...props.settings, [key]: value, bindings: { ...props.settings.bindings } }) }
function goToIndex() { tab.value = 'index' }
function close() { emit('close') }
function updateWindow() {
  windowSize.value = { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio }
  fullscreen.value = Boolean(document.fullscreenElement)
  fullscreenAvailable.value = Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen)
}
function renderSizeLabel(scale: typeof RENDER_SCALES[number]) {
  if (!windowSize.value.width) return `${scale * 100}%`
  const ratio = renderPixelRatio(props.settings.quality, windowSize.value.ratio, scale)
  return `${Math.floor(windowSize.value.width * ratio)} × ${Math.floor(windowSize.value.height * ratio)}`
}
async function changeDisplayMode(event: Event) {
  const select = event.target as HTMLSelectElement
  const requested = select.value === 'fullscreen'
  if (displayModeBusy.value || requested === fullscreen.value) return
  localError.value = ''
  displayModeBusy.value = true
  try {
    if (requested) await document.documentElement.requestFullscreen()
    else await document.exitFullscreen()
  } catch { localError.value = 'Браузер не разрешил изменить полноэкранный режим.' }
  finally {
    updateWindow()
    select.value = fullscreen.value ? 'fullscreen' : 'window'
    displayModeBusy.value = false
  }
}
let outputRefresh = 0
async function refreshAudioOutputs() {
  const revision = ++outputRefresh
  outputAvailable.value = supportsGameAudioOutput()
  const devices = await gameAudioOutputs().catch(() => [])
  if (revision !== outputRefresh) return
  outputDevices.value = devices
  outputDevice.value = currentGameAudioOutput()
}
async function changeAudioOutput(event: Event) {
  const select = event.target as HTMLSelectElement
  if (outputBusy.value) return
  localError.value = ''
  outputBusy.value = true
  try { await setGameAudioOutput(select.value) }
  catch (error) { localError.value = error instanceof Error ? error.message : 'Не удалось изменить устройство вывода.' }
  finally {
    outputDevice.value = currentGameAudioOutput()
    select.value = outputDevice.value
    outputBusy.value = false
  }
}
function isTopmostDialog() {
  const modals = document.querySelectorAll('[aria-modal="true"]')
  return !!dialog.value && modals.item(modals.length - 1) === dialog.value
}
function onKey(event: KeyboardEvent) {
  const root = dialog.value
  if (!root || event.defaultPrevented || !isTopmostDialog()) return
  if (event.key === 'Escape' && !props.bindingCapture) { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || props.bindingCapture) return
  const elements = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(x =>
    x.tabIndex >= 0 && !x.matches(':disabled') && x.getClientRects().length && !x.closest('[inert]')
      && getComputedStyle(x).visibility !== 'hidden')
  const first = elements[0], last = elements.at(-1)
  if (!first || !last) { event.preventDefault(); root.focus({ preventScroll: true }); return }
  const active = document.activeElement
  if (!elements.includes(active as HTMLElement) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault()
    const next = event.shiftKey ? last : first
    next.focus()
  }
}
let previousFocus: HTMLElement | null = null
const inertSiblings: Array<{ element: HTMLElement; inert: boolean }> = []
watch(tab, value => {
  localError.value = ''
  if (scrollArea.value) scrollArea.value.scrollTop = 0
  if (document.hasFocus() && isTopmostDialog()) dialog.value?.focus({ preventScroll: true })
  if (value === 'sound') void refreshAudioOutputs()
}, { flush: 'post' })
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
  let branch = dialog.value
  while (branch?.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertSiblings.push({ element: sibling, inert: sibling.inert })
        sibling.inert = true
      }
    }
    if (branch.parentElement === document.body) break
    branch = branch.parentElement
  }
  updateWindow()
  window.addEventListener('resize', updateWindow)
  document.addEventListener('fullscreenchange', updateWindow)
  document.addEventListener('keydown', onKey, true)
  navigator.mediaDevices?.addEventListener('devicechange', refreshAudioOutputs)
  if (document.hasFocus()) dialog.value?.focus({ preventScroll: true })
})
onBeforeUnmount(() => {
  const root = dialog.value
  const mayRestore = document.activeElement === document.body || !!root?.contains(document.activeElement)
  outputRefresh++
  window.removeEventListener('resize', updateWindow)
  document.removeEventListener('fullscreenchange', updateWindow)
  document.removeEventListener('keydown', onKey, true)
  navigator.mediaDevices?.removeEventListener('devicechange', refreshAudioOutputs)
  for (const { element, inert } of inertSiblings) element.inert = inert
  queueMicrotask(() => {
    const target = previousFocus?.isConnected && !previousFocus.matches(':disabled') ? previousFocus
      : props.inMatch ? document.querySelector<HTMLElement>('.hud-match-menu') : null
    const unclaimed = document.activeElement === document.body || !!root?.contains(document.activeElement)
    if (mayRestore && unclaimed && document.hasFocus() && target && !target.closest('[inert]')
      && !document.querySelector('[aria-modal="true"]')) target.focus({ preventScroll: true })
  })
})
</script>

<template>
  <div ref="dialog" class="club-shell club-settings-shell" :class="{ 'club-settings-in-match': inMatch }"
    :data-settings-tab="tab" role="dialog" aria-modal="true" aria-labelledby="club-settings-title" tabindex="-1">
    <template v-if="!inMatch">
      <img class="club-background" :src="asset('club-background', 'webp')" alt="" aria-hidden="true" />
      <div class="club-shade" aria-hidden="true"></div>
      <header class="club-header">
        <button class="club-brand" type="button" aria-label="Закрыть настройки" @click="close"><span class="club-seal">8</span><span class="club-wordmark"><strong>Pooltool</strong><span>БИЛЬЯРДНЫЙ КЛУБ</span></span></button>
        <div v-if="user" class="club-account"><img :src="asset('online-dot')" alt="" /><span class="club-account-text"><span>{{ user.displayName }}</span><small>Рейтинг · {{ numberFormat.format(user.elo) }} Эло</small></span><span class="club-avatar">{{ initial }}</span></div>
      </header>
    </template>
    <section ref="scrollArea" class="club-content">
      <div class="club-section" :class="{ 'club-section-wide': tab === 'graphics' || tab === 'sound', 'club-settings-controls': tab === 'controls' }">
        <div class="club-section-title"><p>{{ tab === 'index' ? 'ВАШ КОМФОРТ' : inMatch ? 'НАСТРОЙКИ МАТЧА' : 'НАСТРОЙКИ' }}</p><h1 id="club-settings-title">{{ title[0] }}</h1><span>{{ title[1] }}</span></div>
        <template v-if="tab === 'index'">
          <nav class="club-actions club-settings-index-actions" aria-label="Разделы настроек">
            <button class="club-action" aria-label="Графика" aria-describedby="club-graphics-summary" @click="tab = 'graphics'"><img :src="asset('monitor')" alt="" /><span>Графика</span><small id="club-graphics-summary" data-testid="graphics-summary">{{ graphicsSummary }}</small></button>
            <button class="club-action" aria-label="Звук" aria-describedby="club-volume-summary" @click="tab = 'sound'"><img :src="asset('volume')" alt="" /><span>Звук</span><small id="club-volume-summary" data-testid="volume-summary">{{ Math.round(settings.volume * 100) }}%</small></button>
            <button class="club-action" aria-label="Управление" aria-describedby="club-input-summary" @click="tab = 'controls'"><img :src="asset('mouse')" alt="" /><span>Управление</span><small id="club-input-summary">Мышь и клавиатура</small></button>
            <button class="club-action club-action-back" :class="{ 'club-action-compact': !inMatch }" type="button" @click="close"><img :src="inMatch ? matchAsset('back') : asset('arrow-left')" alt="" /><span>{{ inMatch ? 'Назад к меню матча' : 'Назад' }}</span></button>
          </nav><p class="club-footnote" :class="{ 'club-settings-warning': error }" :role="error ? 'alert' : undefined">{{ error || 'Параметры сохраняются для вашего профиля.' }}</p>
        </template>
        <template v-else>
          <section class="club-card">
          <div v-if="tab === 'graphics'" class="club-parameters">
            <label class="club-parameter"><span>Режим экрана</span><select aria-label="Режим экрана" :value="fullscreen ? 'fullscreen' : 'window'" :disabled="!fullscreenAvailable || displayModeBusy" @change="changeDisplayMode"><option value="window">В окне браузера</option><option value="fullscreen">Полноэкранный</option></select></label>
            <label class="club-parameter"><span>Разрешение</span><select aria-label="Разрешение" :value="presentation.renderScale" @change="update('renderScale', Number(($event.target as HTMLSelectElement).value) as typeof RENDER_SCALES[number])"><option v-for="scale in RENDER_SCALES" :key="scale" :value="scale">{{ renderSizeLabel(scale) }}</option></select></label>
            <label class="club-parameter"><span>Качество графики</span><select :value="settings.quality" aria-label="Качество графики" @change="update('quality', ($event.target as HTMLSelectElement).value as GameSettings['quality'])"><option v-for="(label, quality) in graphicsQualities" :key="quality" :value="quality">{{ label }}</option></select></label>
            <label class="club-parameter"><span>Качество теней</span><select aria-label="Качество теней" :value="presentation.shadowQuality" @change="update('shadowQuality', ($event.target as HTMLSelectElement).value as typeof SHADOW_QUALITIES[number])"><option v-for="quality in SHADOW_QUALITIES" :key="quality" :value="quality">{{ shadowTitles[quality] }}</option></select></label>
            <label class="club-parameter" title="Сглаживание запрашивается у WebGL при запуске игры"><span>Сглаживание</span><select aria-label="Сглаживание" disabled><option>MSAA</option></select></label>
            <label class="club-parameter"><span>Частота кадров</span><select aria-label="Частота кадров" :value="presentation.frameRateLimit" @change="update('frameRateLimit', Number(($event.target as HTMLSelectElement).value) as typeof FRAME_RATE_LIMITS[number])"><option v-for="fps in FRAME_RATE_LIMITS" :key="fps" :value="fps">{{ fps ? `${fps} FPS` : 'По частоте экрана' }}</option></select></label>
            <div class="club-parameter" title="Частота обновления управляется браузером"><span>Вертикальная синхронизация</span><ClubSettingSwitch label="Вертикальная синхронизация" :active="false" :in-match="inMatch" status="Авто" disabled /></div>
          </div>
          <div v-else-if="tab === 'sound'" class="club-parameters">
            <label class="club-parameter"><span>Устройство вывода</span><select aria-label="Устройство вывода" :title="!canSelectOutput ? audioOutputHint : undefined" :value="outputDevice" :disabled="!canSelectOutput || outputBusy" @change="changeAudioOutput"><option value="">По умолчанию</option><option v-if="outputDevice && !outputDevices.some(device => device.deviceId === outputDevice)" :value="outputDevice" disabled>Устройство недоступно</option><option v-for="(device, index) in outputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label || `Устройство ${index + 1}` }}</option></select></label>
            <label class="club-parameter"><span>Общая громкость</span><ClubSettingRange label="Общая громкость" :value="settings.volume" :output="`${Math.round(settings.volume * 100)}%`" @update:value="update('volume', $event)" /></label>
            <label class="club-parameter" :title="noAudioTrack"><span>Музыка клуба</span><ClubSettingRange label="Музыка клуба" :value="0" output="—" disabled /></label>
            <label class="club-parameter"><span>Удары и шары</span><ClubSettingRange label="Удары и шары" :value="presentation.impactVolume" :output="`${Math.round(presentation.impactVolume * 100)}%`" @update:value="update('impactVolume', $event)" /></label>
            <label class="club-parameter" :title="noAudioTrack"><span>Атмосфера зала</span><ClubSettingRange label="Атмосфера зала" :value="0" output="—" disabled /></label>
            <label class="club-parameter" :title="noAudioTrack"><span>Уведомления</span><ClubSettingRange label="Уведомления" :value="0" output="—" disabled /></label>
            <div class="club-parameter"><span>Звук в фоновом режиме</span><ClubSettingSwitch label="Звук в фоновом режиме" :active="presentation.audioInBackground" :in-match="inMatch" @toggle="update('audioInBackground', !presentation.audioInBackground)" /></div>
          </div>
          <template v-else-if="tab === 'controls'">
            <div class="club-control-columns">
              <div class="club-control-bindings"><p class="club-settings-kicker">МЫШЬ И КЛАВИАТУРА</p>
                <div v-for="row in controlRows" :key="row.label" class="club-parameter"><span>{{ row.label }}</span>
                  <button v-if="'action' in row" class="club-value-button club-binding-value" type="button" :class="{ 'club-binding-capture': bindingCapture === row.action }" :aria-label="`Назначение: ${captureLabels[row.action]}`" @click="emit('capture', row.action)"><span data-binding-key>{{ bindingCapture === row.action ? 'Нажмите клавишу…' : bindingLabel(settings.bindings[row.action] || DEFAULT_BINDINGS[row.action]) }}</span><img :src="asset('pencil-small')" alt="" /></button>
                  <span v-else class="club-fixed-value club-binding-value">{{ row.value }}</span>
                </div>
              </div>
              <div class="club-control-mouse">
                <p class="club-settings-kicker">ПАРАМЕТРЫ МЫШИ</p>
                <label class="club-parameter club-sensitivity-row"><span>{{ inMatch ? 'Чувствительность мыши' : 'Чувствительность' }}</span><ClubSettingRange :label="inMatch ? 'Чувствительность мыши' : 'Чувствительность'" :value="settings.sensitivity" :min="sensitivityMin" :max="sensitivityMax" :step="0.1" :output="`${sensitivityPercent}%`" @update:value="update('sensitivity', $event)" /></label>
                <div class="club-parameter"><span>Инверсия камеры</span><ClubSettingSwitch label="Инверсия камеры" :active="presentation.invertCamera" :in-match="inMatch" @toggle="update('invertCamera', !presentation.invertCamera)" /></div>
                <div class="club-parameter"><span>Плавное прицеливание</span><ClubSettingSwitch label="Плавное прицеливание" :active="presentation.smoothAim" :in-match="inMatch" @toggle="update('smoothAim', !presentation.smoothAim)" /></div>
                <div class="club-control-hint"><strong>Почувствуйте силу удара</strong><p v-if="inMatch">Мышью выберите направление и точку контакта, подтверждая каждый этап ЛКМ. Shift + колесо поднимает кий над сукном. Удерживайте ЛКМ для набора силы, отпустите для удара.</p><p v-else>Удерживайте левую кнопку мыши, чтобы набрать силу. Отпустите для удара. Задайте вращение битка мышью на этапе выбора точки контакта.</p></div>
              </div>
            </div>
          </template>
            <div class="club-settings-actions">
              <div class="club-divider"></div><p class="club-small-note" :class="{ 'club-settings-warning': actionError }" :role="actionError ? 'alert' : undefined">{{ actionError || actionNote }}</p>
              <div class="club-actions-inline">
                <button class="club-action club-action-back" type="button" @click="goToIndex"><img :src="inMatch ? matchAsset('back') : asset('arrow-left')" alt="" /><span>Назад</span></button>
                <button class="club-action club-action-primary" type="button" :disabled="bindingConflicts.length > 0 || bindingCapture !== null || outputBusy || displayModeBusy" @click="emit('save')"><img :src="inMatch ? matchAsset('apply') : asset('check-dark')" alt="" /><span>{{ saveLabel }}</span><img v-if="!inMatch" :src="asset('chevron-dark')" alt="" /></button>
              </div>
            </div>
          </section>
        </template>
      </div>
    </section>
    <slot v-if="inMatch" name="match-footer" :tab="tab" :go-to-index="goToIndex" />
    <footer v-else class="club-footer">
      <nav class="club-breadcrumbs" aria-label="Путь к настройкам">
        <button type="button" @click="emit('home')">Главное меню</button><span aria-hidden="true"> / </span>
        <span v-if="tab === 'index'" aria-current="page">Настройки</span>
        <template v-else><button type="button" @click="goToIndex">Настройки</button><span aria-hidden="true"> / </span><span aria-current="page">{{ title[0] }}</span></template>
      </nav>
      <span>POOLTOOL · v.{{ clientVersion }}</span>
    </footer>
  </div>
</template>
