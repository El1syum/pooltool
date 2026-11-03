<script setup lang="ts">
import { computed } from 'vue'
import type { AimState, ShotPhase } from '../game/types'
import { normalizeAim } from '../game/playback'
import AssistRange from './AssistRange.vue'
import CueElevationDiagram from './CueElevationDiagram.vue'

const props = defineProps<{ aim: AimState; phase: ShotPhase; canShoot: boolean }>()
const emit = defineEmits<{ aim: [value: AimState]; phase: [value: ShotPhase] }>()
const asset = (name: string, extension = 'svg') => `${import.meta.env.BASE_URL || '/'}ui/figma-assist/${name}.${extension}`
const power = computed(() => Math.round(props.aim.V0 / 8 * 100))
const contactText = computed(() => `${props.aim.a >= 0 ? 'Вправо' : 'Влево'} ${Math.round(Math.abs(props.aim.a) * 100)}% · ${props.aim.b >= 0 ? 'Вверх' : 'Вниз'} ${Math.round(Math.abs(props.aim.b) * 100)}%`)
const stage = computed(() => props.phase === 'aim'
  ? { number: '03 / 04 · ВРАЩЕНИЕ', title: 'Точка контакта', text: 'Направление сохранено. Выберите точку касания кия с битком и подтвердите ЛКМ.' }
  : props.phase === 'power'
    ? { number: '04 / 04 · УДАР', title: 'Почувствуйте силу', text: 'Оттяните кий вниз и отпустите ЛКМ для удара. Точка контакта сохранена.' }
    : { number: '01 / 04 · ОБЗОР', title: 'Ваш ход', text: 'Оцените стол. Мышь выбирает направление, первый ЛКМ фиксирует его.' })
function change(field: keyof AimState, value: number) {
  if (!props.canShoot || ((field === 'a' || field === 'b') && props.phase !== 'aim')) return
  emit('aim', normalizeAim({ ...props.aim, [field]: value }))
}
function spin(event: PointerEvent) {
  if (!props.canShoot || props.phase !== 'aim') return
  const target = event.currentTarget as HTMLElement
  if (event.type === 'pointerdown') { event.preventDefault(); target.setPointerCapture(event.pointerId) }
  else if (!(event.buttons & 1)) return
  const box = target.getBoundingClientRect()
  emit('aim', normalizeAim({ ...props.aim, a: (event.clientX - box.left - box.width / 2) / (box.width / 2), b: -(event.clientY - box.top - box.height / 2) / (box.height / 2) }))
}
</script>

<template>
  <div class="hud-assist-panels" data-testid="alt-assist" aria-label="Дополнительные приборы. Удерживается Alt">
    <aside class="hud-stage-instruction"><span>{{ stage.number }}</span><h2>{{ stage.title }}</h2><p>{{ stage.text }}</p></aside>
    <section v-if="phase === 'power'" class="assist-card assist-power" aria-label="Прибор силы удара">
      <div class="assist-value"><h2>СИЛА УДАРА</h2><strong>{{ power }}%</strong></div>
      <div class="assist-regulator"><AssistRange kind="power" label="Сила удара Alt" :value="aim.V0" :min="0.2" :max="8" :disabled="!canShoot" @change="change('V0', $event)" /><span>{{ power }}%</span></div>
      <div class="assist-endpoints"><span>0 · мягко</span><span>100 · сильно</span></div>
      <p class="assist-key">ЛКМ · оттянуть вниз</p>
    </section>
    <section v-if="phase === 'power'" class="assist-card assist-elevation" aria-label="Прибор наклона кия">
      <div class="assist-value"><h2>НАКЛОН КИЯ</h2><strong>{{ Math.round(aim.theta) }}°</strong></div>
      <CueElevationDiagram :theta="aim.theta" />
      <div class="assist-regulator assist-angle-scale"><span>0°</span><AssistRange kind="elevation" label="Наклон кия Alt" :value="aim.theta" :min="0" :max="60" :step="1" :disabled="!canShoot" @change="change('theta', $event)" /><span>60°</span></div>
      <p>Подъём кия над плоскостью стола. Вид сбоку, не поворот влево/вправо.</p>
      <p class="assist-key">Shift + колесо мыши</p>
    </section>
    <section v-if="phase !== 'overview'" class="assist-card assist-contact" :class="{ 'assist-contact-lower': phase === 'power' }" aria-label="Прибор точки контакта">
      <h2>ТОЧКА КОНТАКТА</h2>
      <div class="assist-cue-face" role="slider" tabindex="0" aria-label="Точка контакта на схеме битка" :aria-valuetext="contactText" :aria-disabled="!canShoot || phase !== 'aim'" @pointerdown="spin" @pointermove="spin" @keydown.left.prevent="change('a', aim.a - 0.05)" @keydown.right.prevent="change('a', aim.a + 0.05)" @keydown.up.prevent="change('b', aim.b + 0.05)" @keydown.down.prevent="change('b', aim.b - 0.05)">
        <img class="assist-cue-sphere" :src="asset('cue-ball')" alt="" />
        <img class="assist-safe-zone" :src="asset('contact-safe-zone', 'png')" alt="" />
        <span class="assist-axis-x"></span><span class="assist-axis-y"></span>
        <img class="assist-contact-dot" :src="asset('contact-dot')" alt="" :style="{ left: `${64 + aim.a * 72}px`, top: `${64 - aim.b * 72}px` }" />
      </div>
      <strong class="assist-contact-value">{{ contactText }}</strong>
      <p>{{ phase === 'aim' ? 'Мышь — точка контакта. Направление удара не меняется.' : 'Точка контакта сохранена. ПКМ — вернуться к её выбору.' }}</p>
    </section>
  </div>
</template>
