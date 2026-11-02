<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{ fraction: number; label: string; unit: 'percent' | 'speed' }>()
const gradientId = `shot-power-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const fillStart = computed(() => 1 - Math.max(0, Math.min(1, Number.isFinite(props.fraction) ? props.fraction : 0)))
const base = import.meta.env.BASE_URL || '/'
// Reference the original Figma vector, rather than copying/redrawing its path.
const outline = `${base}ui/figma-match/wedge-outline.svg#Vector%203`
</script>

<template>
  <svg class="hud-power-gauge" width="250.5" height="138.187" viewBox="0 0 250.5 138.187"
    role="meter" :aria-label="label" aria-valuemin="0" :aria-valuemax="unit === 'speed' ? 8 : 100"
    :aria-valuenow="unit === 'speed' ? Number(((1 - fillStart) * 8).toFixed(1)) : Math.round((1 - fillStart) * 100)" :data-fill="1 - fillStart">
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
        <stop :offset="fillStart" stop-color="#BEAF8F" stop-opacity="0" />
        <stop :offset="fillStart" stop-color="#BEAF8F" stop-opacity="1" />
        <stop offset="1" stop-color="#BEAF8F" />
      </linearGradient>
    </defs>
    <use :href="outline" :fill="`url(#${gradientId})`" />
  </svg>
</template>
