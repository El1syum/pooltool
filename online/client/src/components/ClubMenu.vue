<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { timestamp, type Room, type User } from '../api'
import { isRoomCode, normalizeRoomCode } from '../roomCode'
import { emptyProfileDetails, type ProfileDetails } from '../profileDetails'
import ClubProfileFields from './ClubProfileFields.vue'
import ClubRatingProgress from './ClubRatingProgress.vue'
import '../club-menu.css'

const props = withDefaults(defineProps<{
  view: string; user: User; room?: Room | null; history?: Array<Record<string, unknown>>
  busy: boolean; connected: boolean; code: string; name: string; error?: string
  turnSeconds: number; showAimGuide?: boolean; searchMode: 'casual' | 'ranked'
  clientVersion: string; searchElapsedSeconds?: number; ratingWindow?: number | null
  profileDetails?: ProfileDetails; profileChanged?: boolean
}>(), { room: null, history: () => [], showAimGuide: true, profileDetails: emptyProfileDetails })
const emit = defineEmits<{
  navigate: [view: 'menu' | 'play' | 'profile']; settings: []; exit: []
  search: [mode: 'casual' | 'ranked']; cancelSearch: []; createRoom: []; joinRoom: [spectate: boolean]
  leave: []; copyCode: []; playBot: []; saveName: []
  'update:code': [value: string]; 'update:name': [value: string]; 'update:turnSeconds': [value: number]
  'update:profileDetails': [value: ProfileDetails]; 'update:showAimGuide': [value: boolean]
}>()
type Subview = 'choices' | 'friend' | 'rules' | 'join' | 'watch' | 'exit'
const subview = ref<Subview>('choices')
const lobbyReturnPage = ref<'choices' | 'friend'>('friend')
const draftTurnSeconds = ref(props.turnSeconds)
const draftAimGuide = ref(props.showAimGuide)
const shell = ref<HTMLElement | null>(null)
const content = ref<HTMLElement | null>(null)
const exitDialog = ref<HTMLElement | null>(null)
const codeInput = ref<HTMLInputElement | null>(null)
const profileFields = ref<InstanceType<typeof ClubProfileFields> | null>(null)
const clock = ref(Date.now())
const startedSearch = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { clock.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.view, (view, before) => {
  if (view !== before) subview.value = before === 'lobby' && view === 'play' ? lobbyReturnPage.value : 'choices'
  if (view === 'lobby') lobbyReturnPage.value = 'friend'
  if (view === 'search' && before !== 'search') startedSearch.value = Date.now()
})
const page = computed(() => props.view === 'play' ? subview.value : props.view === 'menu' && subview.value === 'exit' ? 'exit' : props.view)
watch(page, (value, before) => {
  if (content.value) content.value.scrollTop = 0
  if (value === 'join' || value === 'watch') { codeInput.value?.focus({ preventScroll: true }); return }
  if (value === 'exit') { exitDialog.value?.focus({ preventScroll: true }); return }
  if (before !== 'exit') return
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.club-header') && shell.value?.contains(active)) return
  const selector = value === 'menu' ? '[data-exit-trigger]' : value === 'profile' ? '.club-account' : '.club-brand'
  const target = shell.value?.querySelector<HTMLElement>(selector)
  const focusTarget = target?.matches(':disabled') ? shell.value?.querySelector<HTMLElement>('.club-brand') : target
  focusTarget?.focus({ preventScroll: true })
}, { flush: 'post' })
const disabled = computed(() => props.busy || !props.connected)
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string, extension = 'svg') => `${base}ui/club-menu/${name}.${extension}`
const initials = computed(() => props.user.displayName.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase() || 'И')
const number = new Intl.NumberFormat('ru-RU').format
const searchSeconds = computed(() => props.searchElapsedSeconds ?? Math.max(0, Math.floor((clock.value - startedSearch.value) / 1000)))
const searchRange = computed(() => props.ratingWindow != null && Number.isFinite(props.ratingWindow) && props.ratingWindow >= 0
  ? `${number(Math.max(0, props.user.elo - props.ratingWindow))}–${number(props.user.elo + props.ratingWindow)}`
  : '—')
const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const title = computed(() => ({ choices: ['У ВАШЕГО СТОЛА', 'Играть', 'Выберите, с кем разделить партию.'], friend: ['ЧАСТНЫЙ СТОЛ', 'Игра с другом', 'Пригласите друга. Остальное — дело техники.'], rules: ['ЧАСТНЫЙ СТОЛ', 'Настройки игры', 'Ваши правила для дружеской партии.'], join: ['ЧАСТНЫЙ СТОЛ', 'Присоединиться', 'Введите код комнаты, который отправил вам друг.'], watch: ['ЛУЧШИЕ МЕСТА В КЛУБЕ', 'Просмотр матча', 'Наблюдайте за партией и изучайте игру мастеров.'], lobby: ['КОМНАТА СОЗДАНА', 'Пригласите друга', 'Передайте код — и встретимся за столом.'], profile: ['ЛИЧНЫЙ КАБИНЕТ', 'Ваш профиль', 'Имя, которое запомнят за столом.'], search: props.searchMode === 'ranked' ? ['РЕЙТИНГОВАЯ ИГРА', 'Равный вам соперник', 'Подбираем игрока близкого уровня мастерства.'] : ['БЫСТРАЯ ИГРА', 'Ищем соперника', 'Готовим стол для вашей следующей партии.'] }[page.value] || ['', '', '']))
type Crumb = { label: string; action?: () => void }
const breadcrumb = computed<Crumb[]>(() => {
  const home = { label: 'Главное меню', action: goHome }
  const play = { label: 'Играть', action: () => goPlay('choices') }
  const friend = { label: 'Игра с другом', action: () => goPlay('friend') }
  switch (page.value) {
    case 'menu': return [{ label: 'Клуб', action: goHome }, { label: home.label }]
    case 'profile': return [home, { label: 'Профиль' }]
    case 'exit': return [home, { label: 'Выход' }]
    case 'choices': return [home, { label: play.label }]
    case 'search': return [home, play, { label: props.searchMode === 'ranked' ? 'Рейтинговая игра' : 'Случайный противник' }]
    case 'rules': case 'join': return [play, friend, { label: title.value[1] }]
    case 'lobby': return [play, friend, { label: 'Создать игру' }]
    default: return [home, play, { label: title.value[1] }]
  }
})
const mainActions = [
  { label: 'Играть', icon: 'play', primary: true, action: () => emit('navigate', 'play') },
  { label: 'Настройки', icon: 'settings', primary: false, action: () => emit('settings') },
  { label: 'Профиль', icon: 'user', primary: false, action: () => emit('navigate', 'profile') },
  { label: 'Выход', icon: 'exit', primary: false, action: () => { subview.value = 'exit' } },
]
const choices = [
  { label: 'Случайный противник', icon: 'shuffle', primary: true, action: () => emit('search', 'casual') },
  { label: 'Рейтинговая игра', icon: 'trophy', primary: false, action: () => emit('search', 'ranked') },
  { label: 'Игра с другом', icon: 'users', primary: false, action: () => { subview.value = 'friend' } },
  { label: 'Просмотр матча', icon: 'eye', primary: false, action: () => { subview.value = 'watch' } },
  { label: 'Играть с ботом', icon: 'bot', primary: false, action: () => emit('playBot') },
]
const validCode = computed(() => isRoomCode(props.code))
const profileNote = computed(() => props.name !== props.user.displayName || props.profileChanged
  ? 'Изменения ещё не сохранены' : '')
const bestWinStreak = computed(() => {
  // The server returns recent matches in reverse chronological order. A best
  // streak over a truncated history is not the player's actual record.
  if (props.history.length !== props.user.games) return '—'
  let best = 0, current = 0
  for (const match of props.history) {
    current = match.winnerId === props.user.id ? current + 1 : 0
    best = Math.max(best, current)
  }
  return best
})
function historyDate(item: Record<string, unknown>) {
  const value = item.finishedAt || item.startedAt
  const time = typeof value === 'string' || typeof value === 'number' ? timestamp(value) : 0
  return Number.isFinite(time) && time ? new Date(time).toLocaleString('ru-RU') : '—'
}
function signedElo(value: unknown) { return Number(value) > 0 ? `+${value}` : String(value) }
function goHome() { emit('navigate', 'menu'); subview.value = 'choices' }
function goPlay(nextPage: 'choices' | 'friend') {
  if (props.view === 'lobby') leaveLobby(nextPage)
  else if (props.view === 'play') subview.value = nextPage
  else emit('navigate', 'play')
}
function leaveLobby(nextPage: 'choices' | 'friend' = 'friend') {
  lobbyReturnPage.value = nextPage
  emit('leave')
}
function back() { if (page.value === 'choices' || page.value === 'profile') emit('navigate', 'menu'); else if (page.value === 'rules' || page.value === 'join') subview.value = 'friend'; else subview.value = 'choices' }
function enteredCode(event: Event) {
  if (event instanceof InputEvent && event.isComposing) return
  const input = event.target as HTMLInputElement
  const raw = input.value
  const value = normalizeRoomCode(raw)
  if (raw !== value) {
    const start = normalizeRoomCode(raw.slice(0, input.selectionStart ?? raw.length)).length
    const end = normalizeRoomCode(raw.slice(0, input.selectionEnd ?? raw.length)).length
    // Vue may not patch :value when the sanitized model is unchanged.
    input.value = value
    input.setSelectionRange(start, end)
  }
  emit('update:code', value)
}
function submitInviteCode() { if (!disabled.value && validCode.value) emit('joinRoom', page.value === 'watch') }
function saveProfile() { if (!props.busy && props.name.trim()) emit('saveName') }
function openRules() {
  draftTurnSeconds.value = props.turnSeconds
  draftAimGuide.value = props.showAimGuide
  subview.value = 'rules'
}
function saveRules() {
  emit('update:turnSeconds', draftTurnSeconds.value)
  if (draftAimGuide.value !== props.showAimGuide) emit('update:showAimGuide', draftAimGuide.value)
  subview.value = 'friend'
}
function confirmExit() { cancelExit(); emit('exit') }
function cancelExit() { subview.value = 'choices' }
function exitKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelExit(); return }
  if (event.key !== 'Tab') return
  const buttons = [...(exitDialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])].filter(button => button.getClientRects().length)
  const first = buttons[0], last = buttons.at(-1)
  if (!first) { event.preventDefault(); exitDialog.value?.focus(); return }
  if (document.activeElement === exitDialog.value || !exitDialog.value?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
</script>

<template>
  <main ref="shell" class="club-shell" :data-club-view="page" aria-label="Бильярдный клуб">
    <img class="club-background" :src="asset('club-background', 'webp')" alt="" aria-hidden="true" />
    <div class="club-shade" aria-hidden="true"></div>
    <header class="club-header">
      <button class="club-brand" type="button" aria-label="В главное меню" @click="goHome">
        <span class="club-seal">8</span><span class="club-wordmark"><strong>Pooltool</strong><span>БИЛЬЯРДНЫЙ КЛУБ</span></span>
      </button>
      <button class="club-account" type="button" aria-label="Открыть профиль" @click="emit('navigate', 'profile')">
        <img :src="asset('online-dot')" alt="" :class="{ 'club-offline-dot': !connected }" />
        <span class="club-account-text"><span>{{ user.displayName }}</span><small>Рейтинг · {{ number(user.elo) }} Эло</small></span><span class="club-avatar">{{ initials }}</span>
      </button>
    </header>
    <section ref="content" class="club-content">
      <div v-if="page === 'menu'" class="club-main-menu">
        <div class="club-game-title"><p>ИСКУССТВО ТОЧНОГО УДАРА</p><h1>Pooltool</h1><div><i></i><span>БИЛЬЯРД</span><i></i></div></div>
        <nav class="club-actions" aria-label="Главное меню">
          <button v-for="action in mainActions" :key="action.label" type="button" class="club-action" :class="{ 'club-action-primary': action.primary }" :data-exit-trigger="action.icon === 'exit' ? '' : undefined" :disabled="busy || (action.primary && !connected)" @click="action.action"><img :src="asset(action.icon)" alt="" /><span>{{ action.label }}</span><img class="club-chevron" :src="asset(action.primary ? 'chevron-dark' : 'chevron-gold')" alt="" /></button>
        </nav>
        <p class="club-footnote" aria-live="polite">{{ error || 'Ваш стол ждёт. Сыграем партию?' }}</p>
      </div>
      <section v-else-if="page === 'exit'" ref="exitDialog" class="club-card club-exit" role="dialog" aria-modal="true" aria-labelledby="club-exit-title" tabindex="-1" @keydown="exitKey">
        <div class="club-exit-seal"><img :src="asset('exit-large')" alt="" /></div>
        <div class="club-section-title"><p>ДО НОВОЙ ПАРТИИ</p><h1 id="club-exit-title">Покинуть клуб?</h1><span>Вы действительно хотите выйти из игры?<br />Ваш профиль и настройки сохранены.</span></div>
        <div class="club-actions club-actions-with-back">
          <button class="club-action club-action-primary" :disabled="busy" @click="confirmExit"><img :src="asset('exit-dark')" alt="" /><span>Выйти из игры</span><img :src="asset('chevron-dark')" alt="" /></button>
          <button class="club-action club-action-back club-action-compact" @click="cancelExit"><img :src="asset('arrow-left')" alt="" /><span>Отмена</span></button>
        </div><p class="club-footnote" aria-live="polite">{{ error || 'Отмена вернёт вас в главное меню.' }}</p>
      </section>
      <div v-else class="club-section" :class="{ 'club-section-wide': page === 'rules', 'club-section-form': ['search', 'join', 'watch', 'lobby'].includes(page), 'club-section-profile': page === 'profile' }">
        <div class="club-section-title"><p>{{ title[0] }}</p><h1>{{ title[1] }}</h1><span aria-live="polite">{{ error || title[2] }}</span></div>
        <template v-if="page === 'choices'">
          <div class="club-actions club-actions-with-back"><button v-for="action in choices" :key="action.label" class="club-action" :class="{ 'club-action-primary': action.primary }" :disabled="disabled" @click="action.action"><img :src="asset(action.icon)" :class="{ 'club-bot-icon': action.icon === 'bot' }" alt="" /><span>{{ action.label }}</span><small v-if="action.label === 'Рейтинговая игра'">{{ number(user.elo) }} Эло</small><img v-else :src="asset(action.primary ? 'chevron-dark' : 'chevron-gold')" alt="" /></button><button class="club-action club-action-back club-action-compact" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button></div>
          <p class="club-footnote">Пул-8 · {{ connected ? 'Онлайн' : 'Не в сети' }}</p>
        </template>
        <template v-else-if="page === 'friend'">
          <div class="club-rule-summary"><img :src="asset('circle-dot')" alt="" /><div><strong>Пул-8 · Одна партия</strong><span>{{ turnSeconds }} сек. на удар · Стандартный стол · Без рейтинга</span></div></div>
          <div class="club-actions club-actions-with-back"><button class="club-action" @click="openRules"><img :src="asset('sliders')" alt="" /><span>Настройки игры</span><img :src="asset('chevron-gold')" alt="" /></button><button class="club-action club-action-primary" :disabled="disabled" @click="emit('createRoom')"><img :src="asset('plus')" alt="" /><span>Создать игру</span><img :src="asset('chevron-dark')" alt="" /></button><button class="club-action" @click="subview = 'join'"><img :src="asset('key')" alt="" /><span>Присоединиться</span><img :src="asset('chevron-gold')" alt="" /></button><button class="club-action club-action-back club-action-compact" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button></div>
        </template>
        <section v-else-if="page === 'rules'" class="club-card">
          <div class="club-parameters">
            <div class="club-parameter"><span>Дисциплина</span><span class="club-fixed-value">Пул-8<img :src="asset('chevron-down')" alt="" /></span></div>
            <div class="club-parameter"><span>Формат матча</span><span class="club-fixed-value">Одна партия<img :src="asset('chevron-down')" alt="" /></span></div>
            <label class="club-parameter"><span>Время на удар</span><span class="club-rule-select"><select v-model="draftTurnSeconds"><option v-for="seconds in [30, 60, 90, 120, 180]" :key="seconds" :value="seconds">{{ seconds }} секунд</option></select><img :src="asset('chevron-down')" alt="" /></span></label>
            <div class="club-parameter"><span>Первый разбой</span><span class="club-fixed-value">Создатель комнаты<img :src="asset('chevron-down')" alt="" /></span></div>
            <div class="club-parameter"><span>Стол</span><span class="club-fixed-value">Стандартный · Пул-8<img :src="asset('chevron-down')" alt="" /></span></div>
            <div class="club-parameter"><span>Линия прицеливания</span><button type="button" class="club-rule-switch" role="switch" aria-label="Линия прицеливания" :aria-checked="draftAimGuide" @click="draftAimGuide = !draftAimGuide"><span aria-hidden="true">{{ draftAimGuide ? 'Вкл.' : 'Выкл.' }}</span><img :src="asset(draftAimGuide ? 'toggle-on' : 'toggle-off')" alt="" /></button></div>
            <div class="club-parameter"><span>Разрешить наблюдателей</span><span class="club-rule-switch"><span>Вкл.</span><img :src="asset('toggle-on')" alt="" /></span></div>
          </div>
          <div class="club-rule-actions">
          <div class="club-divider"></div><p class="club-small-note">Правила применятся к новой комнате.</p>
          <div class="club-actions-inline"><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button><button class="club-action club-action-primary" @click="saveRules"><img :src="asset('check-dark')" alt="" /><span>Сохранить правила</span><img :src="asset('chevron-dark')" alt="" /></button></div>
          </div>
        </section>
        <form v-else-if="page === 'join' || page === 'watch'" class="club-card club-code-form" @submit.prevent="submitInviteCode">
          <div class="club-code-field">
            <label class="club-code-label">{{ page === 'watch' ? 'Код наблюдения' : 'Код приглашения' }}<input ref="codeInput" class="club-code-input" :value="code" aria-label="Код комнаты" aria-describedby="club-code-help" autocomplete="off" autocapitalize="characters" spellcheck="false" @input="enteredCode" @compositionend="enteredCode" /></label>
            <p id="club-code-help" class="club-small-note">{{ page === 'watch' ? 'Попросите код наблюдения у участника матча.' : '6 символов · Латинские буквы и цифры' }}</p>
          </div>
          <div v-if="page === 'watch'" class="club-observer-note"><img :src="asset('eye-muted')" alt="" /><span>Только просмотр. Вы не занимаете место игрока и не можете влиять на ход партии.</span></div>
          <button type="submit" class="club-action club-action-primary" :disabled="disabled || !validCode"><img :src="asset(page === 'watch' ? 'eye-dark' : 'log-in')" alt="" /><span>{{ page === 'watch' ? 'Смотреть матч' : 'Присоединиться к игре' }}</span><img :src="asset('chevron-dark')" alt="" /></button>
          <p v-if="page === 'join'" class="club-footnote">Правила матча задаёт создатель комнаты.<br />Дружеские игры не влияют на ваш рейтинг.</p>
          <button type="button" class="club-action club-action-back club-action-compact" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button>
        </form>
        <section v-else-if="page === 'search'" class="club-card">
          <div class="club-search"><div class="club-search-ring" aria-hidden="true"><span class="club-search-arc"><img :src="asset('search-arc')" alt="" /></span><span>{{ searchMode === 'ranked' ? '—' : '8' }}</span></div><strong>{{ time(searchSeconds) }}</strong><p class="club-small-note">Ожидаем второго игрока</p></div>
          <div v-if="searchMode === 'ranked'" class="club-rating-data"><div><small>ВАШ РЕЙТИНГ</small><strong>{{ number(user.elo) }} Эло</strong></div><div><small>ДИАПАЗОН ПОИСКА</small><strong>{{ searchRange }}</strong></div></div>
          <div class="club-divider"></div>
          <p v-if="searchMode === 'ranked'" class="club-footnote club-ranked-search-meta">Пул-8 · Одна партия<br />Диапазон постепенно расширяется во время поиска.</p>
          <div v-else class="club-split-note"><span>Пул-8 · Одна партия</span><span>Без изменения рейтинга</span></div>
          <button class="club-action" :disabled="busy" @click="emit('cancelSearch')"><img :src="asset('x')" alt="" /><span>Отменить поиск</span><img :src="asset('chevron-gold')" alt="" /></button><p v-if="searchMode === 'casual'" class="club-footnote">Отмена вернёт вас в раздел «Играть».</p>
        </section>
        <section v-else-if="page === 'lobby' && room" class="club-card">
          <div class="club-invitation"><span>КОД ПРИГЛАШЕНИЯ</span><strong data-room-code tabindex="0" aria-label="Код приглашения">{{ room.code }}</strong>
            <button class="club-action" @click="emit('copyCode')"><img :src="asset('copy')" alt="" /><span>Скопировать код</span><img :src="asset('chevron-gold')" alt="" /></button>
          </div>
          <div class="club-divider"></div><div class="club-room-players"><div v-for="player in room.players" :key="player.id"><span>{{ player.displayName }}{{ player.id === user.id ? ' · Вы' : '' }}</span><span :class="{ 'club-gold': player.ready }">{{ player.ready ? 'Готов к игре' : 'Не готов' }}</span></div><div v-if="room.players.length < 2"><span class="club-muted">Ваш друг</span><span><img :src="asset('wait-dot')" alt="" />Ожидаем подключения…</span></div></div>
          <p class="club-footnote">Пул-8 · Одна партия · {{ room.settings.turnSeconds }} секунд на удар<br />Матч начнётся, когда друг присоединится.</p>
          <button class="club-action club-action-back club-action-compact" :disabled="busy" @click="leaveLobby()"><img :src="asset('arrow-left')" alt="" /><span>Закрыть комнату и назад</span></button>
        </section>
        <form v-else-if="page === 'profile'" class="club-card club-profile-card" @submit.prevent="saveProfile">
          <div class="club-profile-columns">
            <div class="club-profile-info">
              <div class="club-profile-person"><span class="club-avatar club-avatar-large">{{ initials }}</span><div><strong>{{ user.displayName }}</strong><small>ID {{ user.id }}</small></div><button type="button" class="club-profile-pencil" aria-label="Редактировать профиль" :disabled="busy" @click="profileFields?.focusNickname()"><img :src="asset('pencil')" alt="" /></button></div>
              <ClubProfileFields ref="profileFields" :name="name" :details="profileDetails" :disabled="busy" @update:name="emit('update:name', $event)" @update:details="emit('update:profileDetails', $event)" />
            </div>
            <div class="club-profile-separator" aria-hidden="true"></div>
            <div class="club-profile-statistics">
              <div class="club-profile-rating"><img :src="asset('profile-trophy')" alt="" /><div><strong>{{ number(user.elo) }} Эло</strong><span>Текущий рейтинг</span></div></div>
              <div class="club-stat-grid"><div><strong>{{ number(user.games) }}</strong><span>Сыграно матчей</span></div><div><strong>{{ number(user.wins) }}</strong><span>Побед</span></div><div><strong>{{ user.games ? (user.wins / user.games * 100).toFixed(1).replace('.', ',') : '0' }}%</strong><span>Доля побед</span></div><div><strong>{{ bestWinStreak }}</strong><span>Лучшая серия</span></div></div>
              <ClubRatingProgress />
            </div>
          </div>
          <div class="club-profile-actions"><div class="club-divider"></div><p class="club-small-note" role="status">{{ profileNote }}</p><div class="club-actions-inline"><button type="button" class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button><button type="submit" class="club-action club-action-primary" :disabled="busy || !name.trim()"><img :src="asset('check-dark')" alt="" /><span>Сохранить профиль</span><img :src="asset('chevron-dark')" alt="" /></button></div></div>
          <h2 class="club-history-title">История матчей</h2>
          <p v-if="!history.length" class="club-small-note">Пока нет завершённых матчей.</p>
          <ul v-else class="club-history" tabindex="0" aria-label="История матчей. Дата, соперник, режим, результат, изменение рейтинга">
            <li v-for="item in history" :key="String(item.id || item.matchId)">
              <time>{{ historyDate(item) }}</time>
              <span>{{ item.opponentName ? `против ${item.opponentName}` : 'Партия' }}</span>
              <span>{{ item.mode === 'ranked' || item.ranked ? 'Рейтинговый' : 'Обычный' }}</span>
              <strong>{{ item.winnerId === user.id ? 'Победа' : item.winnerId ? 'Поражение' : 'Матч завершён' }}</strong>
              <small class="club-history-elo" :aria-label="item.eloDelta != null ? `Изменение рейтинга: ${signedElo(item.eloDelta)}` : 'Без изменения рейтинга'">{{ item.eloDelta != null ? `Эло ${signedElo(item.eloDelta)}` : '—' }}</small>
            </li>
          </ul>
        </form>
      </div>
    </section>
    <footer class="club-footer">
      <nav class="club-breadcrumbs" aria-label="Путь по меню">
        <template v-for="(crumb, index) in breadcrumb" :key="crumb.label">
          <span v-if="index > 0" aria-hidden="true"> / </span><button v-if="crumb.action" type="button" :disabled="busy" @click="crumb.action">{{ crumb.label }}</button><span v-else aria-current="page">{{ crumb.label }}</span>
        </template>
      </nav>
      <span>POOLTOOL · v.{{ clientVersion }}</span>
    </footer>
  </main>
</template>
