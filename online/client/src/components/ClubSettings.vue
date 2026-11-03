<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { User } from '../api'
import { DEFAULT_BINDINGS, type BindingAction, type GameSettings } from '../game/types'
import '../club-menu.css'

const props = withDefaults(defineProps<{
  settings: GameSettings; bindingCapture: BindingAction | null
  captureLabels: Record<BindingAction, string>; bindingConflicts: string[]
  aimGuideLocked: boolean; inMatch: boolean; user?: User | null; clientVersion: string
}>(), { user: null })
const emit = defineEmits<{
  'update:settings': [value: GameSettings]; capture: [action: BindingAction]
  reset: []; save: []; close: []; models: []; appearance: []
}>()
type Tab = 'index' | 'graphics' | 'sound' | 'controls'
const tab = ref<Tab>('index')
const resolution = ref('По размеру окна')
const fullscreen = ref(false)
const fullscreenAvailable = ref(false)
const localError = ref('')
const dialog = ref<HTMLElement | null>(null)
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string, ext = 'svg') => `${base}ui/club-menu/${name}.${ext}`
const titles = { index: ['Настройки', 'Клуб под ваш вкус.'], graphics: ['Графика', 'Идеальный вид на вашу следующую партию.'], sound: ['Звук', 'Знакомый стук шаров. Тихая музыка клуба.'], controls: ['Управление', 'Точность начинается с удобства.'] }
const title = computed(() => titles[tab.value])
const initial = computed(() => (props.user?.displayName || 'Игрок').trim().split(/\s+/).slice(0, 2).map(x => [...x][0]).join('').toUpperCase())
const shadowValue = computed(() => props.settings.quality === 'low' ? 'Выкл.' : props.settings.quality === 'high' ? 'Высокое · 2048 px' : 'Среднее · 1024 px')
const actions = computed(() => (Object.keys(props.captureLabels) as BindingAction[]).filter(action => !['shoot', 'topView', 'cueView', 'orbit'].includes(action)))
const shortBinding = (binding: string | undefined) => binding?.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '↔ ').replace('Mouse0', 'ЛКМ').replace('Mouse1', 'СКМ').replace('Mouse2', 'ПКМ').replace('Space', 'Пробел') || 'Не назначено'
function update<K extends keyof GameSettings>(key: K, value: GameSettings[K]) { emit('update:settings', { ...props.settings, [key]: value, bindings: { ...props.settings.bindings } }) }
function close() { emit('close') }
function updateWindow() { resolution.value = `${window.innerWidth} × ${window.innerHeight}`; fullscreen.value = Boolean(document.fullscreenElement); fullscreenAvailable.value = Boolean(document.fullscreenEnabled) }
async function toggleFullscreen() {
  localError.value = ''
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen() }
  catch { localError.value = 'Браузер не разрешил полноэкранный режим. Можно использовать его системную команду.' }
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && !props.bindingCapture) { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || props.bindingCapture) return
  const elements = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])].filter(x => x.getClientRects().length)
  const first = elements[0], last = elements.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
let previousFocus: Element | null = null
onMounted(() => { previousFocus = document.activeElement; updateWindow(); window.addEventListener('resize', updateWindow); document.addEventListener('fullscreenchange', updateWindow); dialog.value?.focus() })
onBeforeUnmount(() => { window.removeEventListener('resize', updateWindow); document.removeEventListener('fullscreenchange', updateWindow); if (previousFocus instanceof HTMLElement) previousFocus.focus() })
</script>

<template>
  <div ref="dialog" class="club-shell club-settings-shell" :class="{ 'club-settings-in-match': inMatch }" role="dialog" aria-modal="true" aria-labelledby="club-settings-title" tabindex="-1" @keydown="onKey">
    <img v-if="!inMatch" class="club-background" :src="asset('club-background', 'webp')" alt="" aria-hidden="true" />
    <div class="club-shade" aria-hidden="true"></div>
    <header class="club-header">
      <button class="club-brand" type="button" aria-label="Закрыть настройки" @click="close"><span class="club-seal">8</span><span class="club-wordmark"><strong>Pooltool</strong><span>БИЛЬЯРДНЫЙ КЛУБ</span></span></button>
      <div v-if="user" class="club-account"><img :src="asset('online-dot')" alt="" /><span class="club-account-text"><span>{{ user.displayName }}</span><small>Рейтинг · {{ user.elo }} Эло</small></span><span class="club-avatar">{{ initial }}</span></div>
      <button v-else class="club-text-button" @click="close">Закрыть</button>
    </header>
    <section class="club-content">
      <div class="club-section" :class="{ 'club-section-wide': tab === 'graphics' || tab === 'sound', 'club-settings-controls': tab === 'controls' }">
        <div class="club-section-title"><p>{{ tab === 'index' ? 'ВАШ КЛУБ' : 'НАСТРОЙКИ' }}</p><h1 id="club-settings-title">{{ title[0] }}</h1><span>{{ title[1] }}</span></div>
        <template v-if="tab === 'index'">
          <nav class="club-actions" aria-label="Разделы настроек">
            <button class="club-action" @click="tab = 'graphics'"><img :src="asset('monitor')" alt="" /><span>Графика</span><img :src="asset('chevron-gold')" alt="" /></button>
            <button class="club-action" @click="tab = 'sound'"><img :src="asset('volume')" alt="" /><span>Звук</span><img :src="asset('chevron-gold')" alt="" /></button>
            <button class="club-action" @click="tab = 'controls'"><img :src="asset('mouse')" alt="" /><span>Управление</span><img :src="asset('chevron-gold')" alt="" /></button>
            <button class="club-action" @click="emit('appearance')"><img :src="asset('monitor')" alt="" /><span>Оформление</span><img :src="asset('chevron-gold')" alt="" /></button>
            <button class="club-action club-action-back" @click="close"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button>
          </nav><p class="club-footnote">Внешний вид, звук и точность под вашим контролем.</p>
          <button class="club-text-button" @click="emit('models')">Модели стола и окружения</button>
        </template>
        <section v-else class="club-card">
          <div v-if="tab === 'graphics'" class="club-parameters">
            <div class="club-parameter"><span>Режим экрана</span><button class="club-value-button" :disabled="!fullscreenAvailable" @click="toggleFullscreen">{{ fullscreen ? 'Полный экран' : 'В окне браузера' }}<img :src="asset('chevron-down')" alt="" /></button></div>
            <div class="club-parameter"><span>Разрешение</span><span class="club-fixed-value">{{ resolution }}</span></div>
            <label class="club-parameter"><span>Качество графики</span><select :value="settings.quality" aria-label="Качество графики" @change="update('quality', ($event.target as HTMLSelectElement).value as GameSettings['quality'])"><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label>
            <div class="club-parameter"><span>Качество теней</span><span class="club-fixed-value">{{ shadowValue }}</span></div>
            <div class="club-parameter"><span>Сглаживание</span><span class="club-fixed-value">MSAA · WebGL</span></div>
            <div class="club-parameter"><span>Частота кадров</span><span class="club-muted">По частоте экрана</span></div>
            <div class="club-parameter"><span>Вертикальная синхронизация</span><span class="club-muted">Управляется браузером</span></div>
            <div class="club-parameter"><span>Линия прицеливания</span><button class="club-toggle" role="switch" aria-label="Линия прицеливания" :aria-checked="aimGuideLocked ? false : settings.showAimGuide" :disabled="aimGuideLocked" @click="update('showAimGuide', !settings.showAimGuide)"><span>{{ aimGuideLocked ? 'Рейтинговый матч' : settings.showAimGuide ? 'Вкл.' : 'Выкл.' }}</span><img :src="asset(!aimGuideLocked && settings.showAimGuide ? 'toggle-on' : 'toggle-off')" alt="" /></button></div>
            <p v-if="aimGuideLocked" class="club-small-note club-locked-note" role="note">В рейтинговом матче линия прицеливания отключена и недоступна для изменения.</p>
            <div class="club-parameter"><span>Номера луз</span><button class="club-toggle" role="switch" aria-label="Номера луз" :aria-checked="settings.showPocketLabels" @click="update('showPocketLabels', !settings.showPocketLabels)"><span>{{ settings.showPocketLabels ? 'Вкл.' : 'Выкл.' }}</span><img :src="asset(settings.showPocketLabels ? 'toggle-on' : 'toggle-off')" alt="" /></button></div>
          </div>
          <div v-else-if="tab === 'sound'" class="club-parameters">
            <div class="club-parameter"><span>Устройство вывода</span><span class="club-fixed-value">Системное устройство</span></div>
            <label class="club-parameter"><span>Общая громкость</span><span class="club-range-value"><input type="range" :value="settings.volume" min="0" max="1" step="0.01" aria-label="Общая громкость" :style="{ '--club-range': `${settings.volume * 100}%` }" @input="update('volume', Number(($event.target as HTMLInputElement).value))" /><output>{{ Math.round(settings.volume * 100) }}%</output></span></label>
            <div class="club-parameter"><span>Удары и шары</span><span class="club-muted">Общая громкость</span></div>
            <div v-for="label in ['Музыка клуба', 'Атмосфера зала', 'Уведомления']" :key="label" class="club-parameter"><span>{{ label }}</span><span class="club-muted">Аудиоматериал не добавлен</span></div>
            <p class="club-small-note">Работают звуки кия и столкновения шаров. Музыку и атмосферу подключим вместе с готовыми аудиоассетами.</p>
          </div>
          <template v-else-if="tab === 'controls'">
            <div class="club-control-columns">
              <div class="club-control-bindings"><p class="club-settings-kicker">МЫШЬ И КЛАВИАТУРА</p>
                <div class="club-parameter"><span>Прицеливание</span><span class="club-fixed-value club-binding-value">Мышь</span></div>
                <div v-for="action in (['shoot', 'topView', 'cueView', 'orbit'] as BindingAction[])" :key="action" class="club-parameter"><span>{{ captureLabels[action] }}</span><button class="club-value-button club-binding-value" :class="{ 'club-binding-capture': bindingCapture === action }" :aria-label="`Назначение: ${captureLabels[action]}`" @click="emit('capture', action)">{{ bindingCapture === action ? 'Нажмите клавишу…' : shortBinding(settings.bindings[action] || DEFAULT_BINDINGS[action]) }}</button></div>
                <div class="club-parameter"><span>Меню матча</span><span class="club-fixed-value club-binding-value">Esc</span></div>
              </div>
              <div class="club-control-mouse"><p class="club-settings-kicker">ПАРАМЕТРЫ МЫШИ</p><label class="club-parameter"><span>Чувствительность</span><span class="club-range-value"><input type="range" :value="settings.sensitivity" min="0.1" max="3" step="0.1" aria-label="Чувствительность" :style="{ '--club-range': `${(settings.sensitivity - 0.1) / 2.9 * 100}%` }" @input="update('sensitivity', Number(($event.target as HTMLInputElement).value))" /><output>{{ settings.sensitivity.toFixed(1) }}×</output></span></label>
                <div class="club-control-hint"><strong>Подготовка удара</strong><p>Выберите направление до первого ЛКМ. Затем задайте точку контакта, подтвердите ЛКМ и выберите силу. ПКМ возвращает на предыдущий шаг. Удерживайте Alt для дополнительных подсказок.</p></div>
                <p class="club-small-note">Нажмите назначение и затем нужную клавишу или кнопку мыши. Esc отменяет переназначение.</p>
              </div>
            </div>
            <details class="club-extra-bindings"><summary>Дополнительные назначения</summary><div class="club-extra-binding-grid"><div v-for="action in actions" :key="action" class="club-parameter"><span>{{ captureLabels[action] }}</span><button class="club-value-button club-binding-value" :class="{ 'club-binding-capture': bindingCapture === action }" :aria-label="`Назначение: ${captureLabels[action]}`" @click="emit('capture', action)">{{ bindingCapture === action ? 'Нажмите клавишу…' : shortBinding(settings.bindings[action] || DEFAULT_BINDINGS[action]) }}</button></div></div></details>
          </template>
          <p v-if="localError" class="club-settings-warning" role="alert">{{ localError }}</p>
          <p v-for="conflict in bindingConflicts" :key="conflict" class="club-settings-warning" role="alert">Конфликт: {{ conflict }}</p>
          <div class="club-divider"></div><p class="club-small-note">Изменения применяются сразу. Сохраните их для следующей игры.</p>
          <div class="club-actions-inline"><button class="club-action club-action-back" @click="tab = 'index'"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button><button class="club-action club-action-primary" :disabled="bindingConflicts.length > 0 || bindingCapture !== null" @click="emit('save')"><img :src="asset('check-dark')" alt="" /><span>Сохранить</span><img :src="asset('chevron-dark')" alt="" /></button></div>
          <div class="club-settings-utilities"><button class="club-text-button" @click="emit('reset')">Сбросить настройки</button><button class="club-text-button" @click="emit('close')">Закрыть без сохранения на сервер</button></div>
        </section>
      </div>
    </section>
    <footer class="club-footer"><span>Главное меню / Настройки{{ tab !== 'index' ? ` / ${title[0]}` : '' }}</span><span>POOLTOOL · v.{{ clientVersion }}</span></footer>
  </div>
</template>
