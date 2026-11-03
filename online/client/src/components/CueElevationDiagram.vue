<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ theta: number }>()
const part = (name: string) => `${import.meta.env.BASE_URL || '/'}ui/figma-assist/cue-elevation.svg#${encodeURIComponent(String.fromCharCode(...new TextEncoder().encode(name)))}`
const angle = computed(() => Math.max(0, Math.min(60, props.theta)))
const referenceAngle = Math.atan2(43, 200) * 180 / Math.PI
const length = computed(() => Math.min(1, 43 / Math.max(1, Math.sin(angle.value * Math.PI / 180) * Math.hypot(200, 43))))
</script>
<template>
  <svg width="262" height="70" viewBox="0 0 262 70" role="img" :aria-label="`Наклон кия ${Math.round(angle)} градусов`">
    <use :href="part('Плоскость сукна')" />
    <g :transform="`translate(210 55) rotate(${angle - referenceAngle}) scale(${length}) translate(-210 -55)`"><use :href="part('Ось наклонённого кия')" /></g>
    <use :href="part('Биток в профиль')" />
    <use v-if="angle > 0" :href="part('Дуга наклона')" />
  </svg>
</template>
