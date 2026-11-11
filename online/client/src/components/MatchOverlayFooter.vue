<script setup lang="ts">
import type { Match } from '../api'

defineProps<{
  page: 'menu' | 'surrender' | 'index' | 'graphics' | 'sound' | 'controls'
  status: Match['status']; connected: boolean; version: string; feedback?: string
}>()
const emit = defineEmits<{ resume: []; menu: []; settings: [] }>()
const titles = { menu: 'Меню', surrender: 'Сдаться', index: 'Настройки', graphics: 'Графика', sound: 'Звук', controls: 'Управление' }
const runningIcon = `${import.meta.env.BASE_URL}ui/figma-match/match-running.svg`
</script>

<template>
  <footer class="match-overlay-footer">
    <nav aria-label="Навигация матча" class="match-overlay-path">
      <button type="button" @click="emit('resume')">Матч</button><span aria-hidden="true">/</span>
      <template v-if="page !== 'menu'"><button type="button" @click="emit('menu')">Меню</button><span aria-hidden="true">/</span></template>
      <template v-if="page === 'graphics' || page === 'sound' || page === 'controls'"><button type="button" @click="emit('settings')">Настройки</button><span aria-hidden="true">/</span></template>
      <span aria-current="page">{{ titles[page] }}</span>
    </nav>
    <span class="match-overlay-state" :class="{ 'match-overlay-feedback': feedback || !connected }" role="status">
      <img v-if="!feedback && connected && status !== 'finished'" :src="runningIcon" alt="" />
      {{ feedback || (!connected ? 'Соединение потеряно' : status !== 'finished' ? 'Матч продолжается · время хода не останавливается' : '') }}
    </span>
    <span class="match-overlay-version">POOLTOOL · v.{{ version }}</span>
  </footer>
</template>
