<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ id: string | number }>()
const base = import.meta.env.BASE_URL || '/'
const palette = ['#f8f2de', '#e6b632', '#3a6ba5', '#be4338', '#75408c', '#d47c32', '#3a7754', '#7b3438', '#242825']
const number = computed(() => Number(props.id))
const striped = computed(() => number.value > 8)
const color = computed(() => palette[striped.value ? number.value - 8 : number.value] || '#f8f2de')
</script>

<template>
  <span class="hud-ball" :class="{ 'hud-ball-striped': striped }" :style="{ backgroundColor: striped ? '#f8f2de' : color }" :aria-label="`Шар ${id}`">
    <span v-if="striped" class="hud-ball-stripe" :style="{ backgroundColor: color }"></span>
    <img class="hud-ball-shading" :src="`${base}ui/figma-match/ball-shading.svg`" alt="" />
    <span class="hud-ball-medallion">{{ id }}</span>
    <img class="hud-ball-highlight" :src="`${base}ui/figma-match/ball-highlight.svg`" alt="" />
  </span>
</template>
