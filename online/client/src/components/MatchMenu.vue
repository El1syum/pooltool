<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Match, Room } from '../api'
import AccessibleDialog from './AccessibleDialog.vue'
import MatchOverlayFooter from './MatchOverlayFooter.vue'

const props = defineProps<{
  match: Match; room: Room | null; userId: string; confirmation: boolean
  busy: boolean; connected: boolean; version: string; feedback?: string
}>()
const emit = defineEmits<{ resume: []; settings: []; confirm: []; cancel: []; surrender: []; leave: [] }>()
const title = ref<HTMLElement | null>(null)
const opponent = computed(() => props.match.players.find(player => player.id !== props.userId)?.displayName)
const isPlayer = computed(() => props.match.players.some(player => player.id === props.userId))
const canSurrender = computed(() => isPlayer.value && props.match.status !== 'finished')
const playerNames = computed(() => props.match.players.map(player => player.displayName).join(' против '))
const asset = (name: string) => `${import.meta.env.BASE_URL}ui/figma-match/match-${name}.svg`
const settingsIcon = `${import.meta.env.BASE_URL}ui/club-menu/settings.svg`
const exitIcon = `${import.meta.env.BASE_URL}ui/club-menu/exit.svg`
function dismiss() { if (props.confirmation) emit('cancel'); else emit('resume') }
watch(() => props.confirmation, () => {
  // Switching the card removes the old button. Put focus back at the
  // non-destructive dialog root without reclaiming a background window.
  if (document.hasFocus()) title.value?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true })
}, { flush: 'post' })
</script>

<template>
  <AccessibleDialog title-id="game-menu-title" dialog-class="match-menu-overlay" backdrop-class="match-menu-backdrop" return-focus-selector=".hud-match-menu" @close="dismiss">
    <div class="match-menu-scroll" :class="{ 'match-menu-confirming': confirmation }" @click.self="dismiss">
      <div v-if="confirmation" class="match-surrender-card">
        <div class="match-surrender-symbol"><img :src="asset('surrender-symbol')" alt="" /></div>
        <header class="match-menu-title">
          <p>ВЫХОД ИЗ ТЕКУЩЕЙ ПАРТИИ</p>
          <h1 id="game-menu-title" ref="title">Сдаться?</h1>
          <div>Вам будет засчитано поражение.<br />{{ opponent || 'Соперник' }} получит победу в этой партии.</div>
        </header>
        <p class="match-surrender-note">Отменить это решение и вернуться<br />в текущую партию будет нельзя.</p>
        <div class="match-surrender-divider" aria-hidden="true"></div>
        <div class="match-menu-actions">
          <button type="button" class="match-menu-action match-menu-danger" :disabled="busy || !canSurrender" @click="emit('surrender')"><img :src="asset('surrender')" alt="" /><span>Сдаться</span></button>
          <button type="button" class="match-menu-action match-menu-primary" @click="emit('resume')"><img :src="asset('resume')" alt="" /><span>Продолжить игру</span></button>
        </div>
      </div>
      <div v-else class="match-menu-card">
        <header class="match-menu-title">
          <p><template v-if="room">СТОЛ {{ room.code }} · </template>ПАРТИЯ 1</p>
          <h1 id="game-menu-title" ref="title">Меню матча</h1>
          <div>{{ playerNames }}</div>
        </header>
        <div class="match-menu-actions">
          <button type="button" class="match-menu-action match-menu-primary" aria-keyshortcuts="Escape" @click="emit('resume')"><img :src="asset('resume')" alt="" /><span>Продолжить игру</span><kbd aria-hidden="true">Esc</kbd></button>
          <button type="button" class="match-menu-action" @click="emit('settings')"><img :src="settingsIcon" alt="" /><span>Настройки</span></button>
          <button v-if="canSurrender" type="button" class="match-menu-action match-menu-danger" :disabled="busy" @click="emit('confirm')"><img :src="asset('surrender')" alt="" /><span>Сдаться</span></button>
          <button v-else type="button" class="match-menu-action" :disabled="busy" @click="emit('leave')"><img :src="exitIcon" alt="" /><span>Выйти</span></button>
        </div>
        <p v-if="canSurrender" class="match-menu-note">Вы по-прежнему за столом.<br />Вернитесь к игре до окончания времени хода.</p>
      </div>
    </div>
    <MatchOverlayFooter :page="confirmation ? 'surrender' : 'menu'" :status="match.status" :connected="connected" :version="version" :feedback="feedback" @resume="emit('resume')" @menu="emit('cancel')" />
  </AccessibleDialog>
</template>
