<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ fraction: number; label: string; unit: 'percent' | 'speed' }>()
const id = `shot-power-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const gradientId = `${id}-gradient`
const clipId = `${id}-clip`
const fillStart = computed(() => 1 - Math.max(0, Math.min(1, Number.isFinite(props.fraction) ? props.fraction : 0)))
// Exact Vector 3 path from public/ui/figma-assist/power-gauge.svg. Keep the
// geometry, clip and gradient in one SVG for Safari compatibility instead of
// depending on cross-document <use>/mask/paint resolution. Nothing is rasterized.
const outline = 'M0 0.000183105C32.1958 24.2798 44.9683 41.8182 54.9846 82.5886L149.714 82.5886L0 0.000183105Z'
</script>

<template>
  <svg class="hud-power-gauge" width="149.714" height="82.5888" viewBox="0 0 149.714 82.5888"
    role="meter" :aria-label="label" aria-valuemin="0" :aria-valuemax="unit === 'speed' ? 8 : 100"
    :aria-valuenow="unit === 'speed' ? Number(((1 - fillStart) * 8).toFixed(1)) : Math.round((1 - fillStart) * 100)" :data-fill="1 - fillStart">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="1" x2="0" y2="0">
        <stop :offset="fillStart" stop-color="#C7AA72" stop-opacity="0" />
        <stop :offset="fillStart" stop-color="#C7AA72" stop-opacity="1" />
        <stop offset="1" stop-color="#C7AA72" />
      </linearGradient>
      <clipPath :id="clipId" clipPathUnits="userSpaceOnUse"><path :d="outline" /></clipPath>
    </defs>
    <path class="hud-gauge-shape" :d="outline" :fill="`url(#${gradientId})`"
      stroke="#D9D9D9" stroke-width="2" :clip-path="`url(#${clipId})`" />
  </svg>
</template>
