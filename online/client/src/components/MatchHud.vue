<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Match, Room, User } from '../api'
import type { AimState, CameraMode, ShotPhase } from '../game/types'
import { normalizeAim, numberForPocket } from '../game/playback'
import FigmaBallBadge from './FigmaBallBadge.vue'
import ShotPowerGauge from './ShotPowerGauge.vue'

const props = defineProps<{
  match: Match; user: User; room: Room | null; aim: AimState; phase: ShotPhase
  canShoot: boolean; canPlace: boolean; canReposition: boolean; placingCue: boolean
  connected: boolean; connection: string; remaining: number; elapsed: number
  statusText: string; volume: number; topViewKey: string; calledBall: string
  calledPocket: string; cameraMode: CameraMode
}>()
const emit = defineEmits<{
  settings: []; menu: []; mute: []; rules: []; camera: [action: 'top' | 'free' | 'cue' | 'left' | 'right' | 'in' | 'out']
  aim: [value: AimState]; shoot: []; phase: [value: ShotPhase]; selectBall: [id: string]
  selectPocket: [id: string]; placeCue: []; copyCode: []; panelOpen: [value: boolean]
}>()
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string) => `${base}ui/figma-match/${name}.svg`
const controlsOpen = ref(false)
watch(controlsOpen, value => emit('panelOpen', value))
onBeforeUnmount(() => { if (controlsOpen.value) emit('panelOpen', false) })
const compact = computed(() => props.phase !== 'overview')
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
  <section class="hud-root" :class="{ 'hud-compact': compact, 'hud-offline': !connected }" :data-shot-phase="phase" :data-aim-direction="aim.phi" data-testid="match-hud" aria-label="Интерфейс матча">
    <div class="hud-identity" aria-label="Pooltool">
      <div class="hud-seal">8</div>
      <div class="hud-wordmark"><strong>Pooltool</strong><span>BILLIARDS • МАТЧ {{ formatTime(elapsed) }}</span></div>
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
        <span class="hud-rack-detail">{{ compact ? `Обзор сверху — ${keyHint}` : 'Партия 1 · 8-BALL' }}</span>
      </div>
    </div>

    <nav class="hud-utilities" aria-label="Меню матча">
      <button class="hud-leave" type="button" aria-label="Покинуть стол" title="Покинуть стол" @click="emit('menu')"><img :src="asset('arrow-left')" alt="" /><span>Покинуть стол</span></button>
      <button class="hud-icon-button" type="button" :aria-label="volume > 0 ? 'Выключить звук' : 'Включить звук'" :aria-pressed="volume <= 0" :title="volume > 0 ? 'Выключить звук' : 'Включить звук'" @click="emit('mute')"><img :src="asset('volume')" alt="" /></button>
      <button class="hud-icon-button" type="button" aria-label="Настройки" title="Настройки" @click="emit('settings')"><img :src="asset('settings')" alt="" /></button>
    </nav>

    <div class="hud-match-status match-status" role="status" :class="{ 'hud-status-attention': canPlace || !connected, 'hud-status-quiet': !showStatus }">{{ !connected ? connection : statusText }}</div>

    <div v-if="compact && match.status !== 'finished'" class="hud-target">
      <button class="hud-reticle" type="button" :class="{ 'hud-reticle-interactive': phase === 'aim' && canShoot }" :disabled="!canShoot || phase !== 'aim'" aria-label="Точка удара по битку. Нажмите для выбора силы" @pointermove="setSpin" @pointerdown="setSpin" @click="confirmContact">
        <img class="hud-reticle-ring" :src="asset('reticle-ring')" alt="" />
        <img class="hud-reticle-center" :src="asset('reticle-center')" alt="" :style="{ transform: `translate(${aim.a * 158}px, ${-aim.b * 158}px)` }" />
      </button>
      <div v-if="phase === 'power'" class="hud-charge" aria-live="polite">
        <ShotPowerGauge class="hud-percent-wedge" :fraction="powerFraction" unit="percent" label="Сила удара в процентах" />
        <ShotPowerGauge class="hud-speed-wedge" :fraction="powerFraction" unit="speed" label="Скорость удара в метрах в секунду" />
        <span class="hud-power-number">{{ power }}%</span><span class="hud-speed-number">{{ aim.V0.toFixed(1) }} м/с</span>
      </div>
    </div>

    <footer class="hud-footer">
      <div class="hud-footer-actions"><button type="button" @click="emit('camera', 'top')" aria-label="Вид сверху">Взгляд сверху кнопка {{ keyHint }}</button><button type="button" class="hud-control-toggle" :aria-expanded="controlsOpen" aria-controls="hud-controls" @click="controlsOpen = !controlsOpen">Параметры удара</button></div>
      <button class="hud-room-code" type="button" :title="room ? 'Скопировать код комнаты' : ''" :disabled="!room" @click="emit('copyCode')">{{ room ? `Комната ${room.code}` : 'Номер комнаты' }}</button>
      <button class="hud-rules" type="button" @click="emit('rules')"><img :src="asset('help')" alt="" />Правила</button>
    </footer>
    <p v-if="compact || canPlace" class="hud-phase-hint">{{ phaseHint }}</p>

    <section v-if="controlsOpen" id="hud-controls" class="hud-controls" aria-label="Параметры удара">
      <div class="hud-controls-heading"><h2>Параметры удара</h2><button type="button" aria-label="Закрыть параметры удара" @click="closeControls">×</button></div>
      <div class="hud-camera-actions" role="toolbar" aria-label="Управление камерой"><button type="button" @click="emit('camera', 'left')" aria-label="Повернуть стол влево">↶</button><button type="button" @click="emit('camera', 'right')" aria-label="Повернуть стол вправо">↷</button><button type="button" @click="emit('camera', 'in')" aria-label="Приблизить">+</button><button type="button" @click="emit('camera', 'out')" aria-label="Отдалить">−</button><button type="button" @click="emit('camera', 'free')">Обзор</button><button type="button" :aria-pressed="cameraMode === 'cue'" @click="emit('camera', 'cue')">Из-за кия</button></div>
      <label>Сила {{ power }}%<input aria-label="Сила удара" type="range" min="0.2" max="8" step="0.1" :value="aim.V0" :disabled="!canShoot" @input="setAim('V0', $event)" /></label>
      <label>Направление {{ aim.phi.toFixed(1) }}°<input aria-label="Направление удара" type="range" min="0" max="359.9" step="0.1" :value="aim.phi" :disabled="!canShoot || phase !== 'overview'" @input="setAim('phi', $event)" /></label>
      <label>Наклон кия {{ Math.round(aim.theta) }}°<input aria-label="Наклон кия" type="range" min="0" max="60" step="1" :value="aim.theta" :disabled="!canShoot" @input="setAim('theta', $event)" /></label>
      <label>Вращение X<input aria-label="Вращение X" type="range" min="-0.8" max="0.8" step="0.02" :value="aim.a" :disabled="!canShoot" @input="setAim('a', $event)" /></label>
      <label>Вращение Y<input aria-label="Вращение Y" type="range" min="-0.8" max="0.8" step="0.02" :value="aim.b" :disabled="!canShoot" @input="setAim('b', $event)" /></label>
      <div class="hud-call-title">Заказ шара <span v-if="match.snapshot.callShotRequired">· обязательно</span></div>
      <div class="hud-call-balls"><button v-for="ball in balls" :key="ball.id" type="button" :class="{ selected: calledBall === String(ball.id) }" :aria-label="`Шар ${ball.id}`" :aria-pressed="calledBall === String(ball.id)" :disabled="!canShoot" @click="emit('selectBall', String(ball.id))"><FigmaBallBadge :id="ball.id" /></button></div>
      <div class="hud-call-title">Заказ лузы</div><div class="hud-call-pockets"><button v-for="pocket in pockets" :key="pocket.id" type="button" :class="{ selected: calledPocket === pocket.id }" :aria-label="`Луза ${pocket.number}`" :aria-pressed="calledPocket === pocket.id" :disabled="!canShoot" @click="emit('selectPocket', pocket.id)">{{ pocket.number }}</button></div>
      <div class="hud-shot-actions"><button type="button" class="hud-primary" :disabled="!canShoot || canPlace" @click="emit('shoot')">Удар</button><button type="button" :disabled="!canShoot || canPlace" @click="advancePhase">{{ phase === 'overview' ? 'Прицелиться' : phase === 'aim' ? 'Выбрать силу' : 'К обзору' }}</button></div>
      <button v-if="canReposition" type="button" @click="placeCue">{{ placingCue ? 'Отменить перестановку' : 'Переставить биток' }}</button>
      <p class="hud-controls-help">ЛКМ — подтвердить этап, ПКМ — вернуться. В режиме силы оттяните кий и отпустите кнопку для удара. Таймер матча продолжает идти.</p>
    </section>
  </section>
</template>
