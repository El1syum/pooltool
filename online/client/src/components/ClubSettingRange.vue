<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{ label: string; value: number; output: string; min?: number; max?: number; step?: number; disabled?: boolean }>(), { min: 0, max: 1, step: 0.01 })
const emit = defineEmits<{ 'update:value': [value: number] }>()
const progress = computed(() => Math.max(0, Math.min(100, 100 * (props.value - props.min) / (props.max - props.min))))
</script>

<template>
  <span class="club-range-value" :class="{ 'club-range-unavailable': disabled }">
    <input type="range" :value="value" :min="min" :max="max" :step="step" :aria-label="label"
      :disabled="disabled" :aria-valuetext="disabled ? 'Недоступно' : output"
      :style="{ '--club-range': `${progress}%` }" @input="emit('update:value', Number(($event.target as HTMLInputElement).value))" />
    <output>{{ output }}</output>
  </span>
</template>
