<script setup lang="ts">
import { computed } from 'vue'
import type { Match, Room, User } from '../api'
import type { AimState, CameraMode, ShotPhase } from '../game/types'
import { normalizeAim } from '../game/playback'
import { bindingLabel } from '../game/assistBinding'
import FigmaBallBadge from './FigmaBallBadge.vue'
import ShotPowerGauge from './ShotPowerGauge.vue'
import MatchAssistPanels from './MatchAssistPanels.vue'

const props = defineProps<{
  match: Match; user: User; room: Room | null; aim: AimState; phase: ShotPhase
  canShoot: boolean; canPlace: boolean; remaining: number; topViewKey: string; overviewKey: string
  cameraMode: CameraMode; showAssist?: boolean; assistKeyLabel?: string; overlay?: boolean; feedback?: string
}>()
const emit = defineEmits<{
  menu: []; camera: [action: 'top' | 'free']; aim: [value: AimState]; phase: [value: ShotPhase]; copyCode: []
}>()
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string) => `${base}ui/figma-match/${name}.svg`
const assistAsset = (name: string) => `${base}ui/figma-assist/${name}.svg`
const localTurn = computed(() => props.match.status === 'active' && props.match.players[props.match.currentPlayer]?.id === props.user.id)
const headingView = computed(() => props.phase === 'overview' && props.cameraMode === 'cue' && localTurn.value && !props.canPlace)
const compact = computed(() => !props.overlay && (props.phase !== 'overview' || headingView.value))
const assistVisible = computed(() => props.showAssist && localTurn.value && !props.canPlace && props.phase !== 'overview')
const contactDescription = computed(() => {
  const horizontal = Math.abs(props.aim.a) < 0.025 ? '' : props.aim.a > 0 ? 'справа' : 'слева'
  const vertical = Math.abs(props.aim.b) < 0.025 ? '' : props.aim.b > 0 ? 'выше центра' : 'ниже центра'
  return `Контакт · ${[horizontal, vertical].filter(Boolean).join(' ') || 'по центру'}`
})
const powerFraction = computed(() => Math.max(0, Math.min(1, props.aim.V0 / 8)))
const formatTime = (seconds: number) => `${String(Math.floor(Math.max(0, seconds) / 60)).padStart(2, '0')}:${String(Math.max(0, Math.floor(seconds)) % 60).padStart(2, '0')}`
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase()
const players = computed(() => props.match.players.map((player, index) => {
  const groups = props.match.snapshot.groups
  const group = Array.isArray(groups) ? groups[index] : player.group
  const ids = group === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : group === 'stripes' ? [9, 10, 11, 12, 13, 14, 15] : []
  const potted = ids.filter(id => props.match.snapshot.balls.some(ball => Number(ball.id) === id && (ball.pocketed || ball.state === 4)))
  return { ...player, initials: initials(player.displayName), group, potted,
    active: props.match.status !== 'finished' && index === props.match.currentPlayer,
    local: player.id === props.user.id,
    groupName: group === 'solids' ? 'Цельные' : group === 'stripes' ? 'Полоски' : '' }
}).sort((left, right) => Number(right.local) - Number(left.local)))
const turnLabel = computed(() => {
  if (props.match.status === 'finished') return 'Матч завершён'
  if (props.match.status === 'calculating') return 'Расчёт удара'
  const player = props.match.players[props.match.currentPlayer]
  return player?.id === props.user.id ? 'Ваш ход' : player ? `Ход: ${player.displayName}` : ''
})
const footerInstruction = computed(() => {
  if (props.feedback) return props.feedback
  if (props.canPlace) return 'ЛКМ по столу · установить биток'
  if (props.phase === 'aim') return 'ЛКМ · сохранить точку контакта'
  if (props.phase === 'power') return assistVisible.value ? 'Отпустите ЛКМ · выполнить удар' : 'ПКМ · вернуться к точке контакта'
  if (headingView.value) return 'ЛКМ · перейти к точке контакта'
  return 'Колесо мыши · приблизить биток'
})

function setSpin(event: PointerEvent) {
  if (!props.canShoot || props.phase !== 'aim' || (event.type === 'pointerdown' && event.button !== 0)) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const a = (event.clientX - bounds.left - bounds.width / 2) / (bounds.width / 2)
  const b = -(event.clientY - bounds.top - bounds.height / 2) / (bounds.height / 2)
  emit('aim', normalizeAim({ ...props.aim, a, b }))
}
function changeContactPhase(phase: 'overview' | 'power') {
  if (props.canShoot && props.phase === 'aim') emit('phase', phase)
}
</script>

<template>
  <section class="hud-root hud-modern" :class="{ 'hud-compact': compact, 'hud-heading': headingView, 'hud-assist-visible': assistVisible, 'hud-overlay': overlay }" :data-shot-phase="phase" :data-aim-direction="aim.phi" :data-camera-mode="cameraMode" data-testid="match-hud" aria-label="Интерфейс матча">
    <div class="hud-identity" aria-label="Pooltool">
      <div class="hud-seal">8</div>
      <div class="hud-wordmark"><strong>Pooltool</strong><span>8-BALL<span v-if="room"> · СТОЛ {{ room.code }}</span></span></div>
    </div>

    <div class="hud-scoreboard">
      <article v-for="player in players" :key="player.id" class="hud-player" :class="{ 'hud-player-active': player.active }" :data-player-id="player.id" :data-group="player.group || 'open'" data-testid="player-scorecard" :aria-label="`${player.displayName}${player.groupName ? `, ${player.groupName}, забито ${player.potted.length} из 7, осталось ${7 - player.potted.length}` : ''}`">
        <div class="hud-avatar">{{ player.initials }}</div>
        <div class="hud-player-identity">
          <div class="hud-player-name"><strong :title="player.displayName">{{ player.displayName }}</strong><span v-if="player.groupName">{{ player.groupName }}</span></div>
          <div class="hud-pocketed-row">
            <FigmaBallBadge v-for="id in player.potted" :key="id" :id="id" />
            <span v-if="player.potted.length" class="hud-pocketed-label">POCKETED</span>
          </div>
        </div>
        <div class="hud-player-total"><strong>{{ player.potted.length }}</strong><span>Из 7</span></div>
      </article>
      <div class="hud-clock" :class="{ 'hud-clock-low': remaining <= 10 && match.status === 'active' }">
        <div class="hud-turn-label"><img :src="asset('turn-light')" alt="" /><span>{{ turnLabel }}</span></div>
        <div class="hud-clock-digits" aria-label="Оставшееся время хода">{{ match.status === 'calculating' ? '··:··' : formatTime(remaining) }}</div>
        <span class="hud-rack-detail">Раунд 1 · 8-BALL</span>
      </div>
    </div>

    <button class="hud-match-menu" type="button" aria-label="Меню матча" @click="emit('menu')"><img :src="assistAsset('menu')" alt="" /><span>Меню</span><kbd>Esc</kbd></button>

    <template v-if="!overlay">
      <aside v-if="!compact && localTurn && !canPlace" class="hud-stage-instruction hud-overview-instruction"><span>01 / 04 · ОБЗОР</span><h2>Ваш ход</h2><p>Оцените стол и приблизьте биток колесом мыши, чтобы выбрать направление удара.</p></aside>
      <div v-if="!compact && match.status !== 'finished'" class="hud-ball-legend" aria-label="Обозначения состояния шаров"><span><img :src="assistAsset('legend-live')" alt="" />Яркие — на столе</span><span><img :src="assistAsset('legend-pocketed')" alt="" />Приглушённые — забиты</span></div>

      <div v-if="compact && match.status !== 'finished'" class="hud-target">
        <button v-if="phase === 'aim'" class="hud-reticle hud-contact-reticle" type="button" :class="{ 'hud-reticle-interactive': canShoot }" :disabled="!canShoot" aria-label="Точка удара по битку. Нажмите для выбора силы" @pointermove="setSpin" @pointerdown="setSpin" @click="changeContactPhase('power')" @contextmenu.prevent="changeContactPhase('overview')">
          <img class="hud-reticle-ring" :src="assistAsset('contact-ring')" alt="" />
          <img class="hud-reticle-center" :src="assistAsset('contact-reticle')" alt="" :style="{ transform: `translate(${aim.a * 77}px, ${-aim.b * 77}px)` }" />
        </button>
        <template v-else-if="headingView">
          <img class="hud-power-reticle" :src="assistAsset('direction-ring')" alt="" />
          <img class="hud-direction-reticle" :src="assistAsset('direction-reticle')" alt="" />
          <div class="hud-direction-control"><img :src="assistAsset('direction-arrow')" alt="" /><span>Мышь ↔ · направление удара</span></div>
        </template>
        <img v-else class="hud-power-reticle" :src="assistAsset('power-reticle')" alt="" />
        <div v-if="phase === 'aim' && assistVisible" class="hud-contact-annotation" :style="{ left: `${158 + aim.a * 77}px`, top: `${158 - aim.b * 77}px` }"><img :src="assistAsset('contact-leader')" alt="" /><span class="hud-contact-caption">{{ contactDescription }}</span></div>
        <div v-if="phase === 'power'" class="hud-charge" aria-live="polite">
          <ShotPowerGauge class="hud-percent-wedge" :fraction="powerFraction" unit="percent" label="Сила удара в процентах" />
          <ShotPowerGauge class="hud-speed-wedge" :fraction="powerFraction" unit="speed" label="Скорость удара в метрах в секунду" />
          <span class="hud-power-number">{{ Math.round(powerFraction * 100) }}%</span><span class="hud-speed-number">{{ aim.V0.toFixed(1) }} м/с</span>
        </div>
        <span v-if="phase === 'power'" class="hud-target-caption">ЛКМ + мышь ↓ · сила удара</span>
      </div>

      <MatchAssistPanels v-if="assistVisible" :aim="aim" :phase="phase" :assist-key-label="assistKeyLabel" :can-shoot="canShoot" @aim="emit('aim', $event)" />

      <footer class="hud-footer">
        <div class="hud-footer-actions">
          <span v-if="phase === 'power' && assistVisible">Shift + колесо · наклон кия</span>
          <button type="button" @click="emit('camera', 'top')" aria-label="Вид сверху">{{ bindingLabel(topViewKey) }} · вид сверху</button>
          <button v-if="phase !== 'power' || !assistVisible" type="button" @click="emit('camera', 'free')">{{ bindingLabel(overviewKey) }} · обзор стола</button>
        </div>
        <span class="hud-footer-instruction" :class="{ 'hud-footer-feedback': feedback }" :role="feedback ? 'status' : undefined">{{ footerInstruction }}</span>
        <div class="hud-footer-right"><template v-if="room"><button class="hud-room-code" type="button" title="Скопировать код комнаты" @click="emit('copyCode')">Комната <span data-room-code>{{ room.code }}</span></button><span>·</span></template><span>Правила 8-ball</span></div>
      </footer>
    </template>
  </section>
</template>
