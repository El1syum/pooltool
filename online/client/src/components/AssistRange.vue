<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ value: number; min: number; max: number; step?: number; label: string; kind: 'power' | 'elevation'; disabled?: boolean }>()
const emit = defineEmits<{ change: [value: number] }>()
const width = computed(() => props.kind === 'power' ? 182 : 192)
const height = computed(() => props.kind === 'power' ? 20 : 16)
const fraction = computed(() => Math.max(0, Math.min(1, (props.value - props.min) / (props.max - props.min))))
const reference = computed(() => props.kind === 'power' ? 54.6 : 51)
// Original Figma exports encode UTF-8 bytes as numeric XML entities in IDs.
const part = (name: string) => `${import.meta.env.BASE_URL || '/'}ui/figma-assist/${props.kind === 'power' ? 'power-track' : 'elevation-track'}.svg#${encodeURIComponent(String.fromCharCode(...new TextEncoder().encode(name)))}`
const track = computed(() => part(props.kind === 'power' ? 'Дорожка' : 'Диапазон'))
const fill = computed(() => part(props.kind === 'power' ? 'Уровень' : 'Установленный наклон'))
const thumb = computed(() => part(props.kind === 'power' ? 'Бегунок' : 'Указатель наклона'))
</script>

<template>
  <div class="assist-range-slot" :class="`assist-range-slot-${kind}`">
  <span class="assist-range" :style="{ width: `${width}px`, height: `${height}px` }">
    <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true" overflow="visible">
      <use :href="track" />
      <use :href="fill" :transform="`scale(${fraction * width / reference} 1)`" />
      <use :href="thumb" :transform="`translate(${fraction * width - reference} 0)`" />
    </svg>
    <input :aria-label="label" type="range" :min="min" :max="max" :step="step || 0.1" :value="value" :disabled="disabled" @input="emit('change', Number(($event.target as HTMLInputElement).value))" />
  </span>
  </div>
</template>
