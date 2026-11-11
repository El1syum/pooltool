<script setup lang="ts">
defineProps<{ label: string; active: boolean; inMatch: boolean; disabled?: boolean; status?: string }>()
const emit = defineEmits<{ toggle: [] }>()
const base = import.meta.env.BASE_URL || '/'
</script>

<template>
  <button class="club-toggle" type="button" role="switch" :aria-label="label" :aria-checked="active" :disabled="disabled" @click="emit('toggle')">
    <span>{{ status || (active ? 'Вкл.' : 'Выкл.') }}</span>
    <img :src="`${base}ui/${inMatch ? 'figma-match-settings' : 'club-menu'}/toggle-${active ? 'on' : 'off'}.svg`" alt="" />
  </button>
</template>
