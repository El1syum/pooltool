<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Room, User } from '../api'
import { timestamp } from '../api'
import '../club-menu.css'

const props = withDefaults(defineProps<{
  view: string; user: User; room?: Room | null; history?: Array<Record<string, unknown>>
  busy: boolean; connected: boolean; connection?: string; code: string; name: string
  turnSeconds: number; botDifficulty: 'easy' | 'medium' | 'hard'; searchMode: 'casual' | 'ranked'
  clientVersion: string; matchAvailable?: boolean; searchElapsedSeconds?: number; ratingWindow?: number
}>(), { room: null, history: () => [], connection: '', matchAvailable: false })
const emit = defineEmits<{
  navigate: [view: 'menu' | 'play' | 'profile' | 'match']; settings: []; exit: []; models: []
  search: [mode: 'casual' | 'ranked']; cancelSearch: []; createRoom: []; joinRoom: [spectate: boolean]
  ready: []; leave: []; copyCode: []; playBot: []; saveName: []
  'update:code': [value: string]; 'update:name': [value: string]; 'update:turnSeconds': [value: number]
  'update:botDifficulty': [value: 'easy' | 'medium' | 'hard']
}>()
type Subview = 'choices' | 'friend' | 'rules' | 'join' | 'watch' | 'bot' | 'exit'
const subview = ref<Subview>('choices')
const exited = ref(false)
const clock = ref(Date.now())
const startedSearch = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { clock.value = Date.now() }, 1000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.view, (view, before) => { if (view !== before) subview.value = 'choices'; if (view === 'search' && before !== 'search') startedSearch.value = Date.now(); exited.value = false })
const page = computed(() => props.view === 'play' ? subview.value : props.view === 'menu' && subview.value === 'exit' ? 'exit' : props.view)
const disabled = computed(() => props.busy || !props.connected)
const base = import.meta.env.BASE_URL || '/'
const asset = (name: string, extension = 'svg') => `${base}ui/club-menu/${name}.${extension}`
const initials = computed(() => props.user.displayName.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] || '').join('').toUpperCase() || 'И')
const number = (value: number) => new Intl.NumberFormat('ru-RU').format(value)
const searchSeconds = computed(() => props.searchElapsedSeconds ?? Math.max(0, Math.floor((clock.value - startedSearch.value) / 1000)))
const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const title = computed(() => ({ choices: ['У ВАШЕГО СТОЛА', 'Играть', 'Выберите, с кем разделить партию.'], friend: ['ЧАСТНЫЙ СТОЛ', 'Игра с другом', 'Пригласите друга. Остальное — дело техники.'], rules: ['ЧАСТНЫЙ СТОЛ', 'Настройки игры', 'Ваши правила для дружеской партии.'], join: ['ЧАСТНЫЙ СТОЛ', 'Присоединиться', 'Введите код комнаты, который отправил вам друг.'], watch: ['ЛУЧШИЕ МЕСТА В КЛУБЕ', 'Просмотр матча', 'Наблюдайте за партией и изучайте игру мастеров.'], bot: ['ВАШ ЛИЧНЫЙ СТОЛ', 'Тренировка с ботом', 'Выберите соперника и отточите мастерство.'], lobby: ['КОМНАТА СОЗДАНА', 'Пригласите друга', 'Передайте код — и встретимся за столом.'], profile: ['ЛИЧНЫЙ КАБИНЕТ', 'Ваш профиль', 'Имя, которое запомнят за столом.'], search: props.searchMode === 'ranked' ? ['РЕЙТИНГОВАЯ ИГРА', 'Равный вам соперник', 'Подбираем игрока близкого уровня мастерства.'] : ['БЫСТРАЯ ИГРА', 'Ищем соперника', 'Готовим стол для вашей следующей партии.'] }[page.value] || ['', '', '']))
const breadcrumb = computed(() => page.value === 'menu' ? 'Клуб / Главное меню' : page.value === 'profile' ? 'Главное меню / Профиль' : page.value === 'exit' ? 'Главное меню / Выход' : `Главное меню / ${page.value === 'choices' ? 'Играть' : title.value[1]}`)
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
]
const ready = computed(() => props.room?.players.find(player => player.id === props.user.id)?.ready || false)
function back() { if (page.value === 'choices' || page.value === 'profile') emit('navigate', 'menu'); else if (page.value === 'rules' || page.value === 'join') subview.value = 'friend'; else subview.value = 'choices' }
function enteredCode(event: Event) { emit('update:code', (event.target as HTMLInputElement).value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)) }
function chosenTime(event: Event) { emit('update:turnSeconds', Number((event.target as HTMLSelectElement).value)) }
function historyDate(item: Record<string, unknown>) { const value = timestamp(item.finishedAt as string || item.startedAt as string); return value ? new Date(value).toLocaleString('ru-RU') : '—' }
function confirmExit() { exited.value = true; emit('exit') }
</script>

<template>
  <main class="club-shell" :data-club-view="page" aria-label="Бильярдный клуб">
    <img class="club-background" :src="asset('club-background', 'webp')" alt="" aria-hidden="true" />
    <div class="club-shade" aria-hidden="true"></div>
    <header class="club-header">
      <button class="club-brand" type="button" aria-label="В главное меню" @click="emit('navigate', 'menu'); subview = 'choices'">
        <span class="club-seal">8</span><span class="club-wordmark"><strong>Pooltool</strong><span>БИЛЬЯРДНЫЙ КЛУБ</span></span>
      </button>
      <button class="club-account" type="button" aria-label="Открыть профиль" @click="emit('navigate', 'profile')">
        <img :src="asset('online-dot')" alt="" :class="{ 'club-offline-dot': !connected }" />
        <span class="club-account-text"><span>{{ user.displayName }}</span><small>Рейтинг · {{ number(user.elo) }} Эло</small></span><span class="club-avatar">{{ initials }}</span>
      </button>
    </header>
    <section class="club-content">
      <div v-if="page === 'menu'" class="club-main-menu">
        <div class="club-game-title"><p>ИСКУССТВО ТОЧНОГО УДАРА</p><h1>Pooltool</h1><div><i></i><span>БИЛЬЯРД</span><i></i></div></div>
        <nav class="club-actions" aria-label="Главное меню">
          <button v-for="action in mainActions" :key="action.label" type="button" class="club-action" :class="{ 'club-action-primary': action.primary }" :disabled="busy || (action.primary && !connected)" @click="action.action"><img :src="asset(action.icon)" alt="" /><span>{{ action.label }}</span><img class="club-chevron" :src="asset(action.primary ? 'chevron-dark' : 'chevron-gold')" alt="" /></button>
        </nav>
        <p class="club-footnote">Ваш стол ждёт. Сыграем партию?</p>
        <button v-if="matchAvailable" class="club-text-button" @click="emit('navigate', 'match')">Вернуться в матч</button>
        <button v-if="room && !matchAvailable" class="club-text-button" :disabled="busy" @click="emit('leave')">Выйти из комнаты</button>
      </div>
      <section v-else-if="page === 'exit'" class="club-card club-exit" role="dialog" aria-modal="true" aria-labelledby="club-exit-title">
        <div class="club-exit-seal"><img :src="asset('exit-large')" alt="" /></div>
        <div class="club-section-title"><p>ДО НОВОЙ ПАРТИИ</p><h1 id="club-exit-title">{{ exited ? 'До встречи за столом' : 'Покинуть клуб?' }}</h1><span>{{ exited ? 'Можно закрыть эту вкладку. Ваш профиль и настройки сохранены.' : 'Вы действительно хотите выйти из игры? Ваш профиль и настройки сохранены.' }}</span></div>
        <div class="club-actions">
          <button v-if="!exited" class="club-action club-action-primary" :disabled="busy" @click="confirmExit"><img :src="asset('exit-dark')" alt="" /><span>Выйти из игры</span><img :src="asset('chevron-dark')" alt="" /></button>
          <button class="club-action club-action-back" @click="subview = 'choices'; exited = false"><img :src="asset('arrow-left')" alt="" /><span>{{ exited ? 'Вернуться в клуб' : 'Отмена' }}</span></button>
        </div><p class="club-footnote">{{ matchAvailable ? 'Незавершённую партию нужно покинуть через меню матча.' : 'Отмена вернёт вас в главное меню.' }}</p>
      </section>
      <div v-else class="club-section" :class="{ 'club-section-wide': page === 'rules', 'club-section-form': ['search', 'join', 'watch', 'lobby', 'bot'].includes(page), 'club-section-profile': page === 'profile' }">
        <div class="club-section-title"><p>{{ title[0] }}</p><h1>{{ title[1] }}</h1><span>{{ title[2] }}</span></div>
        <template v-if="page === 'choices'">
          <div class="club-actions"><button v-for="action in choices" :key="action.label" class="club-action" :class="{ 'club-action-primary': action.primary }" :disabled="disabled" @click="action.action"><img :src="asset(action.icon)" alt="" /><span>{{ action.label }}</span><small v-if="action.label === 'Рейтинговая игра'">{{ number(user.elo) }} Эло</small><img v-else :src="asset(action.primary ? 'chevron-dark' : 'chevron-gold')" alt="" /></button><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button></div>
          <p class="club-footnote">Пул-8 · Онлайн · {{ connected ? 'Соединение установлено' : 'Подключение потеряно' }}</p>
          <button class="club-text-button" @click="subview = 'bot'">Тренировка с ботом</button>
        </template>
        <template v-else-if="page === 'friend'">
          <div class="club-rule-summary"><img :src="asset('circle-dot')" alt="" /><div><strong>Пул-8 · Одна партия</strong><span>{{ turnSeconds }} сек. на удар · Стандартный стол · Без рейтинга</span></div></div>
          <div class="club-actions"><button class="club-action" @click="subview = 'rules'"><img :src="asset('sliders')" alt="" /><span>Настройки игры</span><img :src="asset('chevron-gold')" alt="" /></button><button class="club-action club-action-primary" :disabled="disabled" @click="emit('createRoom')"><img :src="asset('plus')" alt="" /><span>Создать игру</span><img :src="asset('chevron-dark')" alt="" /></button><button class="club-action" @click="subview = 'join'"><img :src="asset('key')" alt="" /><span>Присоединиться</span><img :src="asset('chevron-gold')" alt="" /></button><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button></div>
        </template>
        <section v-else-if="page === 'rules'" class="club-card">
          <div class="club-parameter"><span>Дисциплина</span><span class="club-fixed-value">Пул-8</span></div>
          <div class="club-parameter"><span>Формат матча</span><span class="club-fixed-value">Одна партия</span></div>
          <label class="club-parameter"><span>Время на ход</span><select :value="turnSeconds" @change="chosenTime"><option v-for="seconds in [30, 60, 90, 120, 180]" :key="seconds" :value="seconds">{{ seconds }} секунд</option></select></label>
          <div class="club-parameter"><span>Первый разбой</span><span class="club-fixed-value">Создатель комнаты</span></div>
          <div class="club-parameter"><span>Стол</span><span class="club-fixed-value">Стандартный · Пул-8</span></div>
          <div class="club-parameter"><span>Линия прицеливания</span><button class="club-text-button" @click="emit('settings')">В настройках графики</button></div>
          <div class="club-parameter"><span>Наблюдатели</span><span class="club-muted">Разрешены по коду комнаты</span></div>
          <div class="club-divider"></div><p class="club-small-note">Правила применятся к новой комнате. Изменение внешних моделей не меняет физику.</p>
          <div class="club-actions-inline"><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button><button class="club-action club-action-primary" @click="subview = 'friend'"><img :src="asset('check-dark')" alt="" /><span>Сохранить правила</span><img :src="asset('chevron-dark')" alt="" /></button></div>
        </section>
        <section v-else-if="page === 'join' || page === 'watch'" class="club-card">
          <label class="club-code-label">{{ page === 'watch' ? 'Код наблюдения' : 'Код приглашения' }}<input class="club-code-input" :value="code" aria-label="Код комнаты" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" @input="enteredCode" @keyup.enter="!disabled && code.length === 6 && emit('joinRoom', page === 'watch')" /></label>
          <p class="club-small-note">{{ page === 'watch' ? 'Попросите код наблюдения у участника матча.' : '6 символов · Латинские буквы и цифры' }}</p>
          <div v-if="page === 'watch'" class="club-observer-note"><img :src="asset('eye-muted')" alt="" /><span>Только просмотр. Вы не занимаете место игрока и не можете влиять на ход партии.</span></div>
          <button class="club-action club-action-primary" :disabled="disabled || code.length !== 6" @click="emit('joinRoom', page === 'watch')"><img :src="asset(page === 'watch' ? 'eye-dark' : 'log-in')" alt="" /><span>{{ page === 'watch' ? 'Смотреть матч' : 'Присоединиться к игре' }}</span><img :src="asset('chevron-dark')" alt="" /></button>
          <p v-if="page === 'join'" class="club-footnote">Правила матча задаёт создатель комнаты.<br />Дружеские игры не влияют на ваш рейтинг.</p>
          <button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button>
        </section>
        <section v-else-if="page === 'search'" class="club-card">
          <div class="club-search"><div class="club-search-ring"><span class="club-search-arc"><img :src="asset('search-arc')" alt="" /></span><span>8</span></div><strong>{{ time(searchSeconds) }}</strong><p class="club-small-note">Ожидаем второго игрока</p></div>
          <div v-if="searchMode === 'ranked'" class="club-rating-data"><div><small>ВАШ РЕЙТИНГ</small><strong>{{ number(user.elo) }} Эло</strong></div><div><small>ДИАПАЗОН ПОИСКА</small><strong>{{ ratingWindow != null ? `${number(user.elo - ratingWindow)}–${number(user.elo + ratingWindow)}` : 'Подбор по рейтингу' }}</strong></div></div>
          <div class="club-divider"></div><div class="club-split-note"><span>Пул-8 · Одна партия</span><span>{{ searchMode === 'ranked' ? 'С изменением рейтинга' : 'Без изменения рейтинга' }}</span></div>
          <button class="club-action" :disabled="busy" @click="emit('cancelSearch')"><img :src="asset('x')" alt="" /><span>Отменить поиск</span><img :src="asset('chevron-gold')" alt="" /></button><p class="club-footnote">Отмена вернёт вас в раздел «Играть».</p>
        </section>
        <section v-else-if="page === 'lobby' && room" class="club-card">
          <div class="club-invitation"><span>КОД ПРИГЛАШЕНИЯ</span><h2>Комната {{ room.code }}</h2><strong aria-label="Код приглашения">{{ room.code }}</strong></div>
          <button class="club-action" @click="emit('copyCode')"><img :src="asset('copy')" alt="" /><span>Скопировать код приглашения</span><img :src="asset('chevron-gold')" alt="" /></button>
          <div class="club-divider"></div><div class="club-room-players"><div v-for="player in room.players" :key="player.id"><span>{{ player.displayName }}{{ player.id === user.id ? ' · Вы' : '' }}</span><span :class="{ 'club-gold': player.ready }">{{ player.ready ? 'Готов к игре' : 'Не готов' }}</span></div><div v-if="room.players.length < 2"><span>Ваш друг</span><span><img :src="asset('wait-dot')" alt="" />Ожидаем подключения…</span></div></div>
          <p class="club-footnote">Пул-8 · Одна партия · {{ room.settings.turnSeconds }} секунд на удар<br />Матч начнётся, когда оба игрока подтвердят готовность.</p>
          <button class="club-action club-action-primary" :disabled="disabled" @click="emit('ready')"><img :src="asset('check-dark')" alt="" /><span>{{ ready ? 'Отменить готовность' : 'Готов' }}</span><img :src="asset('chevron-dark')" alt="" /></button><button class="club-action club-action-back" :disabled="busy" @click="emit('leave')"><img :src="asset('arrow-left')" alt="" /><span>Выйти из комнаты</span></button>
        </section>
        <section v-else-if="page === 'bot'" class="club-card"><label class="club-parameter"><span>Сложность</span><select :value="botDifficulty" @change="emit('update:botDifficulty', ($event.target as HTMLSelectElement).value as 'easy' | 'medium' | 'hard')"><option value="easy">Лёгкий</option><option value="medium">Средний</option><option value="hard">Сильный</option></select></label><label class="club-parameter"><span>Время на ход</span><select :value="turnSeconds" @change="chosenTime"><option v-for="seconds in [30, 60, 90, 120, 180]" :key="seconds" :value="seconds">{{ seconds }} секунд</option></select></label><button class="club-action club-action-primary" :disabled="disabled" @click="emit('playBot')"><img :src="asset('play')" alt="" /><span>Играть с ботом</span><img :src="asset('chevron-dark')" alt="" /></button><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button></section>
        <section v-else-if="page === 'profile'" class="club-card club-profile-card">
          <div class="club-profile-columns"><div class="club-profile-info"><div class="club-profile-person"><span class="club-avatar club-avatar-large">{{ initials }}</span><div><strong>{{ user.displayName }}</strong><small>ID {{ user.id }}</small></div><img :src="asset('pencil')" alt="" /></div><label class="club-parameter"><span>Псевдоним</span><input :value="name" aria-label="Имя игрока" maxlength="32" @input="emit('update:name', ($event.target as HTMLInputElement).value)" /></label><p class="club-small-note">Псевдоним отображается соперникам и в истории партий.</p></div><div class="club-profile-statistics"><div class="club-profile-rating"><img :src="asset('profile-trophy')" alt="" /><div><strong>{{ number(user.elo) }} Эло</strong><span>Текущий рейтинг</span></div></div><div class="club-stat-grid"><div><strong>{{ user.games }}</strong><span>Сыграно матчей</span></div><div><strong>{{ user.wins }}</strong><span>Побед</span></div><div><strong>{{ user.games ? (user.wins / user.games * 100).toFixed(1).replace('.', ',') : '0' }}%</strong><span>Доля побед</span></div><div><strong>{{ user.losses }}</strong><span>Поражений</span></div></div></div></div>
          <div class="club-divider"></div><p class="club-small-note">{{ name !== user.displayName ? 'Изменения ещё не сохранены' : 'Профиль сохранён' }}</p><div class="club-actions-inline"><button class="club-action club-action-back" @click="back"><img :src="asset('arrow-left')" alt="" /><span>Назад</span></button><button class="club-action club-action-primary" :disabled="busy || !name.trim()" @click="emit('saveName')"><img :src="asset('check-dark')" alt="" /><span>Сохранить имя</span><img :src="asset('chevron-dark')" alt="" /></button></div>
          <h2 class="club-history-title">История матчей</h2><p v-if="!history.length" class="club-small-note">Пока нет завершённых матчей.</p><ul v-else class="club-history"><li v-for="item in history" :key="String(item.id || item.matchId)"><time>{{ historyDate(item) }}</time><span>{{ item.opponentName ? `против ${item.opponentName}` : 'Партия' }}</span><span>{{ item.mode === 'ranked' || item.ranked ? 'Рейтинговый' : 'Обычный' }}</span><strong>{{ item.winnerId === user.id ? 'Победа' : item.winnerId ? 'Поражение' : 'Матч завершён' }}</strong><small v-if="item.eloDelta != null">Эло {{ Number(item.eloDelta) > 0 ? '+' : '' }}{{ item.eloDelta }}</small></li></ul>
        </section>
      </div>
    </section>
    <footer class="club-footer"><span>{{ breadcrumb }}</span><span>POOLTOOL · v.{{ clientVersion }}</span><p class="club-connection" role="status" :class="{ 'club-connection-offline': !connected }">{{ connection || (connected ? 'Соединение установлено' : 'Подключение потеряно') }}</p></footer>
  </main>
</template>
