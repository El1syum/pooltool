<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ fraction: number; label: string; unit: 'percent' | 'speed' }>()
const gradientId = `shot-power-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const fillStart = computed(() => 1 - Math.max(0, Math.min(1, Number.isFinite(props.fraction) ? props.fraction : 0)))
const base = import.meta.env.BASE_URL || '/'
// Reference the original Figma vector, rather than copying/redrawing its path.
const outline = `${base}ui/figma-assist/power-gauge.svg#Vector%203`
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
    </defs>
    <use :href="outline" :fill="`url(#${gradientId})`" />
  </svg>
</template>
