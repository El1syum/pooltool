<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ClubSettings from '../src/components/ClubSettings.vue'
import type { User } from '../src/api'
import { createGameScene } from '../src/game/createGameScene'
import { DEFAULT_PRESENTATION_SETTINGS } from '../src/game/settingsOptions'
import { DEFAULT_BINDINGS, type BindingAction, type GameScene, type GameSettings } from '../src/game/types'

const query = new URLSearchParams(location.search)
const inMatch = query.has('match')
const withGame = query.has('renderer')
const open = ref(false)
const capture = ref<BindingAction | null>(null)
const saves = ref(0)
const goHome = ref(false)
const settings = ref<GameSettings>({ ...DEFAULT_PRESENTATION_SETTINGS, quality: 'medium', volume: .5, sensitivity: 1,
  showAimGuide: true, showPocketLabels: true, bindings: { ...DEFAULT_BINDINGS } })
const user = { id: 'tester', displayName: 'Игрок с длинным именем', elo: 1000 } as User
const labels = Object.fromEntries(Object.keys(DEFAULT_BINDINGS).map(action => [action, ({ topView: 'Вид сверху', cueView: 'Вид из-за кия' } as Record<string, string>)[action] || action])) as Record<BindingAction, string>
const sceneRoot = ref<HTMLElement | null>(null)
let scene: GameScene | undefined
const chrome = computed(() => innerWidth <= 760 ? (innerHeight < 500 ? 126 : 172) : 176)
function openSettings() {
  if (withGame && !scene && sceneRoot.value) {
    scene = createGameScene(sceneRoot.value)
    scene.setSettings(settings.value)
  }
  open.value = true
}
function save() { saves.value++; open.value = false }
watch(settings, value => scene?.setSettings(value), { deep: true })
function key(event: KeyboardEvent) {
  if (!capture.value) return
  event.preventDefault()
  if (event.code !== 'Escape') settings.value.bindings[capture.value] = event.code
  capture.value = null
}
window.addEventListener('keydown', key, true)
onBeforeUnmount(() => { scene?.destroy(); window.removeEventListener('keydown', key, true) })
</script>

<template>
  <div :style="{ '--match-overlay-chrome-bottom': `${chrome}px` }">
    <main data-under-settings>
      <button class="hud-match-menu" type="button" @click="openSettings">Открыть настройки</button>
      <div ref="sceneRoot" style="width: min(640px, 100vw); height: 360px"></div>
      <output hidden data-saved>{{ saves }}</output><output hidden data-home>{{ goHome }}</output>
      <output hidden data-settings>{{ JSON.stringify(settings) }}</output>
    </main>
    <ClubSettings v-if="open" :user="user" :settings="settings" :in-match="inMatch" :binding-capture="capture"
      :capture-labels="labels" :binding-conflicts="[]" :error="query.has('error') ? 'Не удалось сохранить настройки.' : undefined" client-version="qa"
      @update:settings="settings = $event" @capture="capture = $event" @save="save"
      @close="open = false" @home="goHome = true; open = false">
      <template #match-footer="{ tab, goToIndex }">
        <footer data-match-footer style="height: 62px; flex: 0 0 62px">
          <button type="button" @click="goToIndex">Настройки матча</button><span>{{ tab }}</span>
        </footer>
      </template>
    </ClubSettings>
  </div>
</template>
