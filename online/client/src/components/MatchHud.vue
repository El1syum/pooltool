<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Match, Room, User } from '../api'
import type { AimState, CameraMode, ShotPhase } from '../game/types'
import { normalizeAim, numberForPocket } from '../game/playback'
import FigmaBallBadge from './FigmaBallBadge.vue'
import ShotPowerGauge from './ShotPowerGauge.vue'
import MatchAssistPanels from './MatchAssistPanels.vue'

const props = defineProps<{
  match: Match; user: User; room: Room | null; aim: AimState; phase: ShotPhase
  canShoot: boolean; canPlace: boolean; canReposition: boolean; placingCue: boolean
  connected: boolean; connection: string; remaining: number; elapsed: number
  statusText: string; volume: number; topViewKey: string; calledBall: string
  calledPocket: string; cameraMode: CameraMode; showAssist?: boolean; assistKeyLabel?: string
}>()
const emit = defineEmits<{
  settings: []; menu: []; mute: []; rules: []; camera: [action: 'top' | 'free' | 'cue' | 'left' | 'right' | 'in' | 'out']
  aim: [value: AimState]; shoot: []; phase: [value: ShotPhase]; selectBall: [id: string]
  selectPocket: [id: string]; placeCue: []; copyCode: []; panelOpen: [value: boolean]; toggleAssist: []
}>()
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string) => `${base}ui/figma-match/${name}.svg`
const assistAsset = (name: string) => `${base}ui/figma-assist/${name}.svg`
const controlsOpen = ref(false)
watch(controlsOpen, value => emit('panelOpen', value))
onBeforeUnmount(() => { if (controlsOpen.value) emit('panelOpen', false) })
const localTurn = computed(() => props.match.status === 'active' && props.match.players[props.match.currentPlayer]?.id === props.user.id)
const headingView = computed(() => props.phase === 'overview' && props.cameraMode === 'cue' && localTurn.value && !props.canPlace)
const compact = computed(() => props.phase !== 'overview' || headingView.value)
const showOverviewInstruction = computed(() => !compact.value && localTurn.value && !props.canPlace)
const contactDescription = computed(() => {
  const horizontal = Math.abs(props.aim.a) < 0.025 ? '' : props.aim.a > 0 ? 'справа' : 'слева'
  const vertical = Math.abs(props.aim.b) < 0.025 ? '' : props.aim.b > 0 ? 'выше центра' : 'ниже центра'
  return `Контакт · ${[horizontal, vertical].filter(Boolean).join(' ') || 'по центру'}`
})
const keyHint = computed(() => props.topViewKey.replace(/^Key/, '').replace(/^Digit/, '').replace('Space', 'Пробел'))
const showStatus = computed(() => props.canPlace || !props.connected || props.match.status === 'calculating' || props.statusText === 'Воспроизведение удара' || !props.match.players.some(player => player.id === props.user.id))
const power = computed(() => Math.round(props.aim.V0 / 8 * 100))
const powerFraction = computed(() => Math.max(0, Math.min(1, props.aim.V0 / 8)))
const formatTime = (seconds: number) => `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.max(0, Math.floor(seconds)) % 60).padStart(2, '0')}`
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase() || 'И'
const players = computed(() => props.match.players.map((player, index) => {
  const groups = props.match.snapshot.groups
  const group = Array.isArray(groups) ? groups[index] : player.group
  const ids = group === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : group === 'stripes' ? [9, 10, 11, 12, 13, 14, 15] : []
  const potted = ids.filter(id => props.match.snapshot.balls.some(ball => Number(ball.id) === id && (ball.pocketed || ball.state === 4)))
  return { ...player, index, initials: initials(player.displayName), group, ids, potted,
    active: props.match.status !== 'finished' && index === props.match.currentPlayer,
    local: player.id === props.user.id,
    groupName: group === 'solids' ? 'Цельные' : group === 'stripes' ? 'Полоски' : 'Открытый стол' }
}).sort((left, right) => Number(right.local) - Number(left.local)))
const balls = computed(() => {
  const hittable = props.match.snapshot.hittable
  return props.match.snapshot.balls.filter(ball => String(ball.id) !== 'cue' && String(ball.id) !== '0' && !ball.pocketed && ball.state !== 4 && (!Array.isArray(hittable) || hittable.map(String).includes(String(ball.id))))
})
const pockets = computed(() => props.match.snapshot.table.pockets.map((pocket, index) => ({ id: String(pocket.id), number: numberForPocket(String(pocket.id), index) })).sort((a, b) => a.number - b.number))
const activeName = computed(() => props.match.players[props.match.currentPlayer]?.displayName || 'Игрок')
const turnLabel = computed(() => props.match.status === 'finished' ? 'Матч завершён' : props.match.status === 'calculating' ? 'Расчёт удара' : props.match.players[props.match.currentPlayer]?.id === props.user.id ? 'Ваш ход' : `Ход: ${activeName.value}`)
const phaseHint = computed(() => props.canPlace ? 'Установите биток в разрешённой зоне' : props.phase === 'aim' ? 'Направление зафиксировано · Выберите точку касания · ЛКМ — подтвердить · ПКМ — назад' : props.phase === 'power' ? 'Оттяните кий вниз для выбора силы и отпустите ЛКМ · ПКМ — назад' : props.canShoot ? 'Наведите направление · ЛКМ — зафиксировать' : props.statusText)
function setAim(field: keyof AimState, event: Event) {
  emit('aim', normalizeAim({ ...props.aim, [field]: Number((event.target as HTMLInputElement).value) }))
}
function setSpin(event: PointerEvent) {
  if (!props.canShoot || props.phase !== 'aim') return
  const target = event.currentTarget as HTMLElement
  const bounds = target.getBoundingClientRect()
  const a = (event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2)
  const b = -(event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2)
  emit('aim', normalizeAim({ ...props.aim, a, b }))
}
function confirmContact() { if (props.canShoot && props.phase === 'aim') emit('phase', 'power') }
function closeControls() { controlsOpen.value = false }
function advancePhase() { emit('phase', props.phase === 'overview' ? 'aim' : props.phase === 'aim' ? 'power' : 'overview'); closeControls() }
function placeCue() { emit('placeCue'); closeControls() }
defineExpose({ closeControls })
</script>

<template>
  <section class="hud-root hud-modern" :class="{ 'hud-compact': compact, 'hud-heading': headingView, 'hud-offline': !connected, 'hud-assist-visible': showAssist }" :data-shot-phase="phase" :data-aim-direction="aim.phi" :data-camera-mode="cameraMode" data-testid="match-hud" aria-label="Интерфейс матча">
    <div class="hud-identity" aria-label="Pooltool">
      <div class="hud-seal">8</div>
      <div class="hud-wordmark"><strong>Pooltool</strong><span>8-BALL · МАТЧ {{ formatTime(elapsed) }}</span></div>
    </div>

    <div class="hud-scoreboard">
      <article v-for="player in players" :key="player.id" class="hud-player" :class="{ 'hud-player-active': player.active }" :data-player-id="player.id" :data-group="player.group || 'open'" data-testid="player-scorecard" :aria-label="`${player.displayName}, ${player.groupName}${player.ids.length ? `, забито ${player.potted.length} из 7, осталось ${7 - player.potted.length}` : ''}`">
        <div class="hud-avatar">{{ player.initials }}</div>
        <div class="hud-player-identity">
          <div class="hud-player-name"><strong :title="player.displayName">{{ player.displayName }}</strong><span>{{ player.groupName }}</span></div>
          <div class="hud-pocketed-row">
            <FigmaBallBadge v-for="id in player.potted" :key="id" :id="id" />
            <span v-if="player.potted.length" class="hud-pocketed-label">POCKETED</span>
            <span v-else class="hud-empty-balls">{{ player.ids.length ? 'Пока нет забитых шаров' : 'Группы определятся после разбоя' }}</span>
          </div>
        </div>
        <div class="hud-player-total"><strong>{{ player.ids.length ? player.potted.length : '—' }}</strong><span>{{ player.ids.length ? 'Из 7' : 'Группа' }}</span></div>
      </article>
      <div class="hud-clock" :class="{ 'hud-clock-low': remaining <= 10 && match.status === 'active' }">
        <div class="hud-turn-label"><img :src="asset('turn-light')" alt="" /><span>{{ turnLabel }}</span></div>
        <div class="hud-clock-digits" aria-label="Оставшееся время хода">{{ match.status === 'calculating' ? '··:··' : formatTime(remaining) }}</div>
        <span class="hud-rack-detail">Раунд 1 · 8-BALL</span>
      </div>
    </div>

    <button class="hud-match-menu" type="button" aria-label="Меню матча" @click="emit('menu')"><img :src="assistAsset('menu')" alt="" /><span>Меню</span><kbd>Esc</kbd></button>

    <div class="hud-match-status match-status" role="status" :class="{ 'hud-status-attention': canPlace || !connected, 'hud-status-quiet': !showStatus }">{{ !connected ? connection : statusText }}</div>

    <aside v-if="showOverviewInstruction" class="hud-stage-instruction hud-overview-instruction"><span>01 / 04 · ОБЗОР</span><h2>Ваш ход</h2><p>Оцените стол и оставшиеся шары. Затем выберите направление удара.</p></aside>
    <div v-if="!compact && match.status !== 'finished'" class="hud-ball-legend" aria-label="Обозначения состояния шаров"><span><img :src="assistAsset('legend-live')" alt="" />Яркие — на столе</span><span><img :src="assistAsset('legend-pocketed')" alt="" />Приглушённые — забиты</span></div>

    <div v-if="compact && match.status !== 'finished'" class="hud-target">
      <button v-if="phase === 'aim'" class="hud-reticle hud-contact-reticle" type="button" :class="{ 'hud-reticle-interactive': canShoot }" :disabled="!canShoot" aria-label="Точка удара по битку. Нажмите для выбора силы" @pointermove="setSpin" @pointerdown="setSpin" @click="confirmContact">
        <img class="hud-reticle-ring" :src="assistAsset('contact-ring')" alt="" />
        <img class="hud-reticle-center" :src="assistAsset('contact-reticle')" alt="" :style="{ transform: `translate(${aim.a * 77}px, ${-aim.b * 77}px)` }" />
      </button>
      <img v-else class="hud-power-reticle" :src="assistAsset('power-reticle')" alt="" />
      <div v-if="headingView" class="hud-direction-control"><img :src="assistAsset('direction-arrow')" alt="" /><span>Мышь ↔ · направление удара</span></div>
      <div v-if="phase === 'aim' && showAssist && localTurn" class="hud-contact-annotation" :style="{ left: `${158 + aim.a * 77}px`, top: `${158 - aim.b * 77}px` }"><img :src="assistAsset('contact-leader')" alt="" /></div>
      <div v-if="phase === 'power'" class="hud-charge" aria-live="polite">
        <ShotPowerGauge class="hud-percent-wedge" :fraction="powerFraction" unit="percent" label="Сила удара в процентах" />
        <ShotPowerGauge class="hud-speed-wedge" :fraction="powerFraction" unit="speed" label="Скорость удара в метрах в секунду" />
        <span class="hud-power-number">{{ power }}%</span><span class="hud-speed-number">{{ aim.V0.toFixed(1) }} м/с</span>
      </div>
      <span v-if="phase === 'power'" class="hud-target-caption">Мышь ↕ · сила удара</span>
    </div>

    <span v-if="phase === 'aim' && showAssist && localTurn" class="hud-contact-caption" :style="{ '--contact-offset-x': `${aim.a * 77}px`, '--contact-offset-y': `${-aim.b * 77}px` }">{{ contactDescription }}</span>
    <MatchAssistPanels v-if="showAssist && localTurn && !canPlace" :aim="aim" :phase="phase" :show-stage="!showOverviewInstruction" :assist-key-label="assistKeyLabel" :can-shoot="canShoot" @aim="emit('aim', $event)" @phase="emit('phase', $event)" />

    <footer class="hud-footer">
      <div class="hud-footer-actions"><button type="button" @click="emit('camera', 'top')" aria-label="Вид сверху">{{ keyHint }} · вид сверху</button><button type="button" @click="emit('camera', 'free')">Обзор стола</button><button type="button" class="hud-control-toggle" :aria-expanded="controlsOpen" aria-controls="hud-controls" @click="controlsOpen = !controlsOpen">Параметры удара</button><span class="hud-alt-hint"><kbd>{{ assistKeyLabel || 'Ctrl' }}</kbd> · дополнительные приборы</span></div>
      <span class="hud-footer-instruction">{{ phase === 'aim' ? 'ЛКМ по сцене · подтвердить точку контакта' : phase === 'power' ? 'Зажмите ЛКМ · оттяните вниз и отпустите' : canShoot ? 'ЛКМ по сцене · подтвердить направление' : 'Колесо мыши · приблизиться к битку' }}</span>
      <div class="hud-footer-right"><button class="hud-room-code" type="button" :title="room ? 'Скопировать код комнаты' : ''" :disabled="!room" @click="emit('copyCode')"><template v-if="room">Комната <span data-room-code>{{ room.code }}</span></template><template v-else>Стол</template></button><span>·</span><button class="hud-rules" type="button" aria-label="Правила" @click="emit('rules')">Правила 8-ball</button><button class="hud-touch-assist" type="button" :aria-pressed="Boolean(showAssist)" @click="emit('toggleAssist')">Помощь</button></div>
    </footer>
    <p v-if="canPlace" class="hud-phase-hint">{{ phaseHint }}</p>

    <section v-if="controlsOpen" id="hud-controls" class="hud-controls" aria-label="Параметры удара">
      <div class="hud-controls-heading"><h2>Параметры удара</h2><button type="button" aria-label="Закрыть параметры удара" @click="closeControls">×</button></div>
      <div class="hud-camera-actions" role="toolbar" aria-label="Управление камерой"><button type="button" @click="emit('camera', 'left')" aria-label="Повернуть стол влево">↶</button><button type="button" @click="emit('camera', 'right')" aria-label="Повернуть стол вправо">↷</button><button type="button" @click="emit('camera', 'in')" aria-label="Приблизить">+</button><button type="button" @click="emit('camera', 'out')" aria-label="Отдалить">−</button><button type="button" @click="emit('camera', 'free')">Обзор</button><button type="button" :aria-pressed="cameraMode === 'cue'" @click="emit('camera', 'cue')">Из-за кия</button></div>
      <label>Сила {{ power }}%<input aria-label="Сила удара" type="range" min="0.2" max="8" step="0.1" :value="aim.V0" :disabled="!canShoot" @input="setAim('V0', $event)" /></label>
      <label>Направление {{ aim.phi.toFixed(1) }}°<input aria-label="Направление удара" type="range" min="0" max="359.9" step="0.1" :value="aim.phi" :disabled="!canShoot || phase !== 'overview'" @input="setAim('phi', $event)" /></label>
      <label>Наклон кия {{ Math.round(aim.theta) }}°<input aria-label="Наклон кия" type="range" min="0" max="60" step="1" :value="aim.theta" :disabled="!canShoot" @input="setAim('theta', $event)" /></label>
      <label>Вращение X<input aria-label="Вращение X" type="range" min="-0.8" max="0.8" step="0.02" :value="aim.a" :disabled="!canShoot" @input="setAim('a', $event)" /></label>
      <label>Вращение Y<input aria-label="Вращение Y" type="range" min="-0.8" max="0.8" step="0.02" :value="aim.b" :disabled="!canShoot" @input="setAim('b', $event)" /></label>
      <div class="hud-call-title">Заказ шара <span>· необязательно</span></div>
      <div class="hud-call-balls"><button v-for="ball in balls" :key="ball.id" type="button" :class="{ selected: calledBall === String(ball.id) }" :aria-label="`Шар ${ball.id}`" :aria-pressed="calledBall === String(ball.id)" :disabled="!canShoot" @click="emit('selectBall', String(ball.id))"><FigmaBallBadge :id="ball.id" /></button></div>
      <div class="hud-call-title">Заказ лузы <span>· необязательно</span></div><div class="hud-call-pockets"><button v-for="pocket in pockets" :key="pocket.id" type="button" :class="{ selected: calledPocket === pocket.id }" :aria-label="`Луза ${pocket.number}`" :aria-pressed="calledPocket === pocket.id" :disabled="!canShoot" @click="emit('selectPocket', pocket.id)">{{ pocket.number }}</button></div>
      <div class="hud-shot-actions"><button type="button" class="hud-primary" :disabled="!canShoot || canPlace" @click="emit('shoot')">Удар</button><button type="button" :disabled="!canShoot || canPlace" @click="advancePhase">{{ phase === 'overview' ? 'Прицелиться' : phase === 'aim' ? 'Выбрать силу' : 'К обзору' }}</button></div>
      <button v-if="canReposition" type="button" @click="placeCue">{{ placingCue ? 'Отменить перестановку' : 'Переставить биток' }}</button>
      <p class="hud-controls-help">ЛКМ — подтвердить этап, ПКМ — вернуться. В режиме силы оттяните кий и отпустите кнопку для удара. Таймер матча продолжает идти.</p>
    </section>
  </section>
</template>
