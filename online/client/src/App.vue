<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, CLIENT_VERSION, post, request, setToken, socketUrl, timestamp } from './api'
import type { User, Room, Match, ShotResult } from './api'
import { createGameScene } from './game/createGameScene'
import { expandTrajectory, numberForPocket } from './game/playback'
import { DEFAULT_BINDINGS } from './game/types'
import type { AimState, BindingAction, CameraMode, GameScene, GameSettings, ShotPhase } from './game/types'
import MatchHud from './components/MatchHud.vue'
import ClubMenu from './components/ClubMenu.vue'
import ClubSettings from './components/ClubSettings.vue'
import ModelWorkshop from './components/ModelWorkshop.vue'
import ModelAdminLogin from './components/ModelAdminLogin.vue'
import PlayerAppearance from './components/PlayerAppearance.vue'
import { applyMatchVisualPolicy, getAimGuidePolicy } from './game/matchPolicy'
import { createServerModelLibrary } from './models/serverLibrary'
import { profileFromLibrary } from './models/libraryProfile'
import { emptyVisualAssetProfile, type ModelLibrarySnapshot, type VisualAssetProfile } from './models/types'
import { defaultPlayerAssetSelection, readPlayerAssetSelection, reconcilePlayerAssetSelection, resolvePlayerAssets,
  writePlayerAssetSelection, type PlayerAssetSelection } from './models/playerSelection'

type View = 'menu' | 'play' | 'lobby' | 'search' | 'match' | 'profile' | 'models'
const view = ref<View>('menu')
const user = ref<User | null>(null)
const room = ref<Room | null>(null)
const match = ref<Match | null>(null)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const connection = ref('Подключение')
const connected = ref(false)
const now = ref(Date.now())
const serverClockOffset = ref(0)
const name = ref(localStorage.getItem('pooltool.name') || 'Игрок')
const code = ref('')
const turnSeconds = ref(60)
const searchMode = ref<'casual' | 'ranked'>('casual')
const botDifficulty = ref<'easy' | 'medium' | 'hard'>((localStorage.getItem('pooltool.botDifficulty') as 'easy' | 'medium' | 'hard') || 'medium')
const settingsOpen = ref(false)
const gameMenuOpen = ref(false)
const surrenderConfirmation = ref(false)
const rulesOpen = ref(false)
const altHeld = ref(false)
const assistPinned = ref(false)
const hudPanelOpen = ref(false)
const shotPhase = ref<ShotPhase>('overview')
const bindingCapture = ref<BindingAction | null>(null)
const settingsDirty = ref(false)
const history = ref<Array<Record<string, unknown>>>([])
const stage = ref<HTMLDivElement | null>(null)
const playbackBusy = ref(false)
const placingCue = ref(false)
const calledBall = ref('')
const calledPocket = ref('')
const aim = ref<AimState>({ phi: 90, V0: 2.5, theta: 0, a: 0, b: 0 })
const defaults = (): GameSettings => ({ quality: 'medium', volume: 0.5, sensitivity: 1, bindings: { ...DEFAULT_BINDINGS }, showAimGuide: true, showPocketLabels: true })
const settings = ref<GameSettings>(defaults())
const aimGuidePolicy = computed(() => getAimGuidePolicy(match.value))
const effectiveSettings = computed(() => applyMatchVisualPolicy(settings.value, match.value))
const showAssist = computed(() => (altHeld.value || assistPinned.value) && !settingsOpen.value && !gameMenuOpen.value && !rulesOpen.value && !appearanceOpen.value && !modelNavigationBusy.value && !bindingCapture.value)
const modelLibrary = createServerModelLibrary()
const modelProfile = ref<VisualAssetProfile>(emptyVisualAssetProfile())
const modelCatalogue = ref<ModelLibrarySnapshot | null>(null)
const modelCatalogueLoading = ref(false)
const modelCatalogueError = ref('')
const playerAssets = ref<PlayerAssetSelection>(defaultPlayerAssetSelection())
const effectiveModelProfile = computed(() => resolvePlayerAssets(playerAssets.value, modelCatalogue.value).profile)
const appearanceOpen = ref(false)
const modelNavigationBusy = ref(false)
const modelSceneLoading = ref(false)
const modelSceneErrors = ref<string[]>([])
const modelAdminOpen = ref(false)
const modelAdminBusy = ref(false)
const modelAdminError = ref('')
const workshopKey = ref(0)
const modelReturnView = ref<View>('menu')
let scene: GameScene | null = null
let socket: WebSocket | null = null
let reconnectTimer = 0
let reconnectAttempt = 0
let disposed = false
let lastPlayedShot = ''
let token = localStorage.getItem('pooltool.token') || ''
let heartbeat = 0
let polling = 0
let telemetryFlush = false
let authSentAt = 0
let clockCalibrated = false
let lifecycleGeneration = 0
let modelCatalogueGeneration = 0
let modelSceneGeneration = 0
type CommandResponse = { match: Match; result?: ShotResult }
class SocketUnavailable extends Error {}
// Commands sent over the open socket, keyed by commandId (resolved by commandResult).
const socketCommands = new Map<string, { resolve: (value: CommandResponse) => void; reject: (error: Error) => void; timer: number }>()
const departedRooms = new Set<string>()
const departedMatches = new Set<string>()
const clock = window.setInterval(() => { now.value = Date.now() }, 200)

function uuid(): string {
  return crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('')
}
function restoreJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback } catch { return fallback }
}
function mergeSettings(value: unknown): GameSettings {
  const s = value && typeof value === 'object' ? value as Partial<GameSettings> : {}
  return { ...defaults(), ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings || {}) } }
}
const isPlayer = computed(() => Boolean(match.value?.players.some((p) => p.id === user.value?.id)))
const ownTurn = computed(() => match.value?.players[match.value.currentPlayer]?.id === user.value?.id)
const turnReady = computed(() => Boolean(connected.value && ownTurn.value && match.value?.status === 'active' && !busy.value && !playbackBusy.value && !settingsOpen.value && !gameMenuOpen.value && !rulesOpen.value && !appearanceOpen.value && !modelNavigationBusy.value))
const canShoot = computed(() => turnReady.value && !match.value?.snapshot.needsPlacement && !placingCue.value)
const canPlace = computed(() => turnReady.value && Boolean(match.value?.snapshot.ballInHand) && (Boolean(match.value?.snapshot.needsPlacement) || placingCue.value))
const remaining = computed(() => Math.max(0, Math.ceil((timestamp(match.value?.deadline) - now.value - serverClockOffset.value) / 1000)))
const elapsed = computed(() => Math.max(0, Math.floor(((match.value?.finishedAt ? timestamp(match.value.finishedAt) : now.value + serverClockOffset.value) - timestamp(match.value?.startedAt)) / 1000)))
const isSolo = computed(() => Boolean(room.value?.settings.solo))
const botTurn = computed(() => Boolean(match.value && match.value.status === 'active' && match.value.players[match.value.currentPlayer]?.bot))
const currentPlayerName = computed(() => match.value?.players[match.value.currentPlayer]?.displayName || '—')
const matchStatusText = computed(() => !match.value ? '' : match.value.status === 'finished' ? `Матч завершён. ${winnerName.value}` : match.value.status === 'calculating' || busy.value ? 'Сервер рассчитывает удар' : playbackBusy.value ? 'Воспроизведение удара' : !isPlayer.value ? `Наблюдение. Ходит ${currentPlayerName.value}` : ownTurn.value ? 'Ваш ход' : botTurn.value ? `${currentPlayerName.value} думает…` : `Ходит ${currentPlayerName.value}`)
const winnerName = computed(() => match.value?.players.find((p) => p.id === match.value?.winnerId)?.displayName || 'Нет победителя')
const remainingBalls = computed(() => {
  const targets = match.value?.snapshot.hittable
  return match.value?.snapshot.balls.filter((b) => b.id !== 'cue' && !b.pocketed && (!Array.isArray(targets) || targets.includes(String(b.id)))) || []
})
const captureLabels: Record<BindingAction, string> = { aimLeft: 'Прицел влево', aimRight: 'Прицел вправо', powerUp: 'Увеличить силу', powerDown: 'Уменьшить силу', elevationUp: 'Поднять кий', elevationDown: 'Опустить кий', spinLeft: 'Вращение влево', spinRight: 'Вращение вправо', spinUp: 'Вращение вверх', spinDown: 'Вращение вниз', shoot: 'Удар', resetCamera: 'Сброс камеры', topView: 'Вид сверху', orbit: 'Вращать камеру', cameraLeft: 'Повернуть стол влево', cameraRight: 'Повернуть стол вправо', cueView: 'Вид из-за кия' }
const bindingConflicts = computed(() => {
  const seen = new Map<string, string>()
  const conflicts: string[] = []
  for (const [action, key] of Object.entries(settings.value.bindings)) {
    if (!key) continue
    if (seen.has(key)) conflicts.push(`${captureLabels[action as BindingAction]} и ${seen.get(key)}: ${key}`)
    else seen.set(key, captureLabels[action as BindingAction])
  }
  return conflicts
})
const reasonLabels: Record<string, string> = { eightBall: 'Партия завершена по правилам восьмёрки', surrender: 'Соперник сдался', left: 'Игрок покинул матч', disconnect: 'Техническое поражение: игрок не вернулся после отключения', abandoned: 'Оба игрока отключились, матч прерван', maximumDuration: 'Превышена максимальная длительность матча' }
function reasonLabel(value?: string | null) { return value ? reasonLabels[value] || value : '' }
const resultReason = computed(() => {
  const m = match.value
  if (!m) return ''
  if (m.reason === 'surrender' || m.reason === 'left') {
    const loser = m.players.find((p) => p.id !== m.winnerId)
    return loser?.id === user.value?.id ? (m.reason === 'surrender' ? 'Вы сдались' : 'Вы покинули матч') : `${loser?.displayName || 'Соперник'} ${m.reason === 'surrender' ? 'сдался' : 'покинул матч'}`
  }
  return reasonLabel(m.reason)
})
const ratingChange = computed(() => match.value?.ranked ? match.value.ratings?.find((r) => r.playerId === user.value?.id) : undefined)
const offlinePlayers = computed(() => {
  const m = match.value
  if (!m || m.status === 'finished' || !m.disconnectedPlayers) return []
  return Object.entries(m.disconnectedPlayers).filter(([id]) => id !== user.value?.id).map(([id, forfeitAt]) => ({
    name: m.players.find((p) => p.id === id)?.displayName || 'Игрок',
    seconds: Math.max(0, Math.ceil((timestamp(forfeitAt) - now.value - serverClockOffset.value) / 1000)),
  }))
})
const cameraMode = ref<CameraMode>('free')
let audibleVolume = 0.5
function toggleSound() {
  if (settings.value.volume > 0) { audibleVolume = settings.value.volume; settings.value.volume = 0 }
  else settings.value.volume = audibleVolume || 0.5
}
function setShotPhase(phase: ShotPhase) { shotPhase.value = phase; scene?.setShotPhase(phase) }
function changeCamera(action: 'top' | 'free' | 'cue' | 'left' | 'right' | 'in' | 'out') {
  if (action === 'top') { setShotPhase('overview'); scene?.resetCamera(true) }
  else if (action === 'free') { setShotPhase('overview'); scene?.resetCamera() }
  else if (action === 'cue') { if (canShoot.value) setShotPhase('aim'); else scene?.setCameraMode('cue') }
  else if (action === 'left') scene?.rotateCamera(-0.4)
  else if (action === 'right') scene?.rotateCamera(0.4)
  else scene?.zoomCamera(action === 'in' ? 0.85 : 1.18)
}
function changeHudAim(value: AimState) { aim.value = { ...value }; updateAim() }
function toggleCuePlacement() {
  placingCue.value = !placingCue.value
  setShotPhase('overview')
  if (placingCue.value) scene?.resetCamera(true)
}
const toast = ref<{ title: string; lines: string[]; tone: 'good' | 'bad' | 'neutral' } | null>(null)
let pendingSummary: ShotResult | null = null
let toastTimer = 0
const foulReasons: Record<string, string> = {
  'Cue ball in pocket!': 'биток упал в лузу',
  '4 rails must be contacted, or 1 ball potted': 'на разбое нужно 4 касания бортов или забитый шар',
  'No ball contacted': 'биток не коснулся ни одного шара',
  "First contact wasn't made with target balls": 'первым задет шар не своей группы',
  'Cushion not contacted after first contact': 'после касания ни один шар не дошёл до борта',
  'Shot not called, but it was required!': 'удар не был заказан',
  '8-ball sunk illegally (out of turn or wrong pocket)!': 'восьмёрка забита не по правилам',
  'Shot clock expired': 'истекло время хода',
}
function selectBall(id: string) { calledBall.value = calledBall.value === id ? '' : id }
function selectPocket(id: string) { calledPocket.value = calledPocket.value === id ? '' : id }
function showToast(value: NonNullable<typeof toast.value>) {
  toast.value = value
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.value = null }, 4000)
}
/** One-line outcome of the shot that just finished playing. */
function summarizeShot(shot: ShotResult) {
  const players = match.value?.players || []
  const shooter = players.find((p) => p.id === shot.playerId)
  const lines: string[] = []
  for (const item of shot.potted || []) {
    const pocketIndex = match.value?.snapshot.table.pockets.findIndex((p) => String(p.id) === item.pocket) ?? 0
    const pocketNumber = numberForPocket(item.pocket, Math.max(0, pocketIndex))
    lines.push(item.ball === 'cue' ? `Биток упал в лузу ${pocketNumber}` : `Шар ${item.ball} → луза ${pocketNumber}`)
  }
  const rules = shot.rules || {}
  if (rules.foul) lines.push(`Фол: ${foulReasons[rules.foulReason || ''] || rules.foulReason || 'нарушение правил'}`)
  if (!lines.length) lines.push('Ни один шар не забит')
  if (rules.winner == null && typeof rules.nextPlayer === 'number') {
    const next = players[rules.nextPlayer]
    lines.push(next?.id === shot.playerId ? `${next?.displayName || 'Игрок'} продолжает` : `Ход переходит: ${next?.displayName || 'соперник'}`)
  }
  const pottedOwn = (shot.potted || []).some((item) => item.ball !== 'cue')
  showToast({ title: shooter ? `Удар: ${shooter.displayName}` : 'Удар', lines, tone: rules.foul ? 'bad' : pottedOwn ? 'good' : 'neutral' })
}
async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось выполнить действие' } finally { busy.value = false }
}
function telemetry(type: string, data: Record<string, unknown> = {}) {
  if (!user.value) return
  const key = `pooltool.telemetry.${user.value.id}`
  const events = restoreJson<Array<Record<string, unknown>>>(key, [])
  events.push({ id: uuid(), type, timestamp: new Date().toISOString(), clientVersion: CLIENT_VERSION, matchId: match.value?.id || null, turnId: match.value?.turn ?? null, data })
  localStorage.setItem(key, JSON.stringify(events.slice(-200)))
  void flushTelemetry()
}
async function flushTelemetry() {
  if (!connected.value || !user.value || telemetryFlush || document.visibilityState !== 'visible') return
  const key = `pooltool.telemetry.${user.value.id}`
  const events = restoreJson<Array<Record<string, unknown>>>(key, [])
  if (!events.length) return
  telemetryFlush = true
  try {
    const result = await post<{ acceptedIds: string[] }>('/api/telemetry/events', { events: events.slice(0, 50) })
    const accepted = new Set(result.acceptedIds)
    localStorage.setItem(key, JSON.stringify(restoreJson<Array<Record<string, unknown>>>(key, []).filter((e) => !accepted.has(String(e.id)))))
  } catch { /* bounded queue retained for reconnect */ } finally { telemetryFlush = false }
}
async function authenticate() {
  setToken(token)
  try {
    if (!token) {
      const result = await post<{ token: string; user: User }>('/api/auth/guest', { displayName: name.value.trim() || 'Игрок', clientVersion: CLIENT_VERSION })
      token = result.token
      localStorage.setItem('pooltool.token', token)
      setToken(token)
      user.value = result.user
    } else {
      const result = await request<User | { user: User }>('/api/me')
      user.value = 'user' in result ? result.user : result
    }
    name.value = user.value.displayName
    settings.value = mergeSettings(user.value.settings)
    const cached = restoreJson<GameSettings | null>(`pooltool.settings.${user.value.id}`, null)
    if (cached) settings.value = mergeSettings(cached)
    connect()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      token = ''
      localStorage.removeItem('pooltool.token')
      await authenticate()
    } else error.value = e instanceof Error ? e.message : 'Не удалось подключиться'
  } finally { loading.value = false }
}
function connect() {
  if (disposed || !token || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
  clearTimeout(reconnectTimer)
  connection.value = reconnectAttempt ? 'Восстанавливаем соединение' : 'Подключение'
  const current = new WebSocket(socketUrl())
  socket = current
  current.onopen = () => { authSentAt = Date.now(); clockCalibrated = false; current.send(JSON.stringify({ type: 'auth', token, clientVersion: CLIENT_VERSION })) }
  current.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data)
      if (message.type === 'authenticated') {
        if (message.serverTime) serverClockOffset.value = timestamp(message.serverTime) - (authSentAt + Date.now()) / 2
        connected.value = true
        connection.value = 'Соединение установлено'
        reconnectAttempt = 0
        if (message.user) user.value = message.user
        clearInterval(heartbeat)
        current.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }))
        heartbeat = window.setInterval(() => { if (current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ping', clientTime: Date.now() })); void flushTelemetry() }, 15_000)
        telemetry('clientReconnect', { connected: true })
        void restoreMatch()
        void resumePendingCommand()
        if (settingsDirty.value) void saveSettings()
      } else if (message.type === 'restored') {
        if (message.room) receiveRoom(message.room)
        if (message.match) receiveMatch(message.match)
        if (message.queue?.queued) { searchMode.value = message.queue.mode; view.value = 'search' }
      } else if (message.type === 'pong' && message.clientTime && message.serverTime) {
        const estimate = timestamp(message.serverTime) - (message.clientTime + Date.now()) / 2
        serverClockOffset.value = clockCalibrated ? serverClockOffset.value * .8 + estimate * .2 : estimate
        clockCalibrated = true
      } else if (message.type === 'room') receiveRoom(message.room)
      else if (message.type === 'match') receiveMatch(message.match, message.result)
      else if (message.type === 'matchmaking') {
        if (message.room) receiveRoom(message.room)
        if (message.matchId) loadMatchInBackground(message.matchId)
      } else if (message.type === 'commandResult') {
        const pending = socketCommands.get(String(message.commandId))
        if (pending) {
          socketCommands.delete(String(message.commandId))
          clearTimeout(pending.timer)
          if (message.ok) pending.resolve(message as CommandResponse)
          else pending.reject(new ApiError(typeof message.detail === 'string' ? message.detail : message.detail?.message || `Ошибка сервера (${message.status})`, message.status))
        }
      } else if (message.type === 'error') error.value = message.detail || message.message || 'Ошибка соединения'
    } catch { error.value = 'Сервер прислал некорректное сообщение' }
  }
  current.onclose = () => {
    if (current !== socket) return
    connected.value = false
    connection.value = 'Связь потеряна. Партия сохраняется на сервере.'
    clearInterval(heartbeat)
    for (const [id, pending] of socketCommands) { clearTimeout(pending.timer); pending.reject(new SocketUnavailable()); socketCommands.delete(id) }
    telemetry('clientReconnect', { connected: false })
    if (!disposed) reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10_000))
  }
  current.onerror = () => current.close()
}
function receiveRoom(value: Room | null) {
  if (!value || departedRooms.has(value.code)) return
  room.value = value
  localStorage.setItem('pooltool.room', value.code)
  if (value.matchId) { if (value.matchId !== match.value?.id) loadMatchInBackground(value.matchId) }
  else if (value.status !== 'closed') view.value = 'lobby'
}
function receiveMatch(value: Match, result?: ShotResult) {
  if (!value || departedMatches.has(value.id) || (match.value?.id === value.id && value.revision < match.value.revision)) return
  match.value = value
  if (calledBall.value && !remainingBalls.value.some(ball => String(ball.id) === calledBall.value)) calledBall.value = ''
  localStorage.setItem('pooltool.match', value.id)
  view.value = 'match'
  const last = value.lastShot
  const lastResult = last && 'result' in last ? last.result : last as ShotResult | undefined
  const shot = result || lastResult
  if (shot?.trajectory) {
    const shotKey = shot.shotId || (last && 'id' in last ? last.id : '') || `${value.id}:${value.revision}`
    const serverStart = timestamp(shot.startAt || shot.playbackStartAt || (last && 'startAt' in last ? last.startAt : undefined))
    const start = serverStart ? serverStart - serverClockOffset.value : Date.now() + 200
    if (shotKey !== lastPlayedShot && start + shot.duration * 1000 > Date.now()) {
      lastPlayedShot = shotKey
      playbackBusy.value = true
      pendingSummary = shot
      const trajectory = expandTrajectory(shot.trajectory)
      void nextTick(() => { ensureScene(); scene?.setState(shot.initialState); scene?.playShot(trajectory, start) })
    } else if (!playbackBusy.value) scene?.setState(value.snapshot)
  } else if (!playbackBusy.value) scene?.setState(value.snapshot)
  updateInteraction()
  if (value.status === 'finished') { gameMenuOpen.value = false; void refreshUser().catch(reportBackgroundError) }
}
function reportBackgroundError(failure: unknown) {
  if (!disposed) error.value = failure instanceof Error ? failure.message : 'Не удалось обновить данные. Текущее состояние партии сохранено.'
}
function loadMatchInBackground(id: string) {
  void loadMatch(id).catch(failure => { if (!departedMatches.has(id) && match.value?.id !== id) reportBackgroundError(failure) })
}
async function loadMatch(id: string) {
  if (departedMatches.has(id)) return
  const generation = lifecycleGeneration
  const result = await request<{ match: Match }>(`/api/matches/${encodeURIComponent(id)}`)
  if (generation === lifecycleGeneration) receiveMatch(result.match)
}
async function restoreMatch() {
  const generation = lifecycleGeneration
  try {
    const state = await request<{ room: Room | null; match: Match | null; queue?: { queued: boolean; mode: 'casual' | 'ranked' } }>('/api/me/current')
    if (generation !== lifecycleGeneration) return
    if (state.room) receiveRoom(state.room)
    if (state.match) receiveMatch(state.match)
    if (state.queue?.queued) { searchMode.value = state.queue.mode; view.value = 'search' }
  } catch (e) {
    if (e instanceof ApiError && [403, 404, 410].includes(e.status)) { localStorage.removeItem('pooltool.match'); localStorage.removeItem('pooltool.room') }
    else error.value = e instanceof Error ? e.message : 'Ошибка восстановления'
  }
}
async function refreshUser() { const result = await request<User | { user: User }>('/api/me'); user.value = 'user' in result ? result.user : result }
function ensureScene() {
  if (!stage.value || scene || !match.value) return
  try {
    scene = createGameScene(stage.value, {
      onAimChange: (value) => { aim.value = { ...value } },
      onShoot: (value) => { void shoot(value) },
      onPlaceCueBall: ([x, y]) => { void sendCommand('placeCueBall', { x, y }) },
      onSelectBall: (id) => { if (id !== 'cue') calledBall.value = id },
      onSelectPocket: (id) => { calledPocket.value = id },
      onCameraModeChange: (mode) => { cameraMode.value = mode },
      onShotPhaseChange: (phase) => { shotPhase.value = phase || 'overview' },
      onPlaybackComplete: () => {
        playbackBusy.value = false
        if (match.value) scene?.setState(match.value.snapshot)
        updateInteraction()
        if (pendingSummary) { summarizeShot(pendingSummary); pendingSummary = null }
      },
      onError: (message) => { error.value = message; telemetry('clientError', { message: message.slice(0, 500) }) },
      onPerformance: (stats) => { telemetry('clientPerformance', stats) },
    })
    scene.setSettings(effectiveSettings.value)
    scene.setState(match.value.snapshot)
    scene.setAim(aim.value)
    scene.setShotPhase(shotPhase.value)
    scene.setCalledBall(calledBall.value || null)
    scene.setCalledPocket(calledPocket.value || null)
    void applySceneModels()
    updateInteraction()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось открыть 3D-сцену' }
}
function updateInteraction() {
  const table = match.value?.snapshot.table
  scene?.setInteraction({ canShoot: canShoot.value && !hudPanelOpen.value, canPlaceCueBall: canPlace.value && !hudPanelOpen.value, spectator: !isPlayer.value,
    placementRegion: match.value?.snapshot.ballInHandRegion === 'behind_line' && table ? { minY: 0, maxY: table.length / 4 } : undefined })
}
watch(stage, () => { if (stage.value) ensureScene(); else { scene?.destroy(); scene = null; playbackBusy.value = false } }, { flush: 'post' })
watch([canShoot, canPlace, isPlayer], updateInteraction)
watch(hudPanelOpen, updateInteraction)
watch([ownTurn, () => match.value?.id, () => match.value?.status, playbackBusy, canPlace, settingsOpen, gameMenuOpen, rulesOpen, appearanceOpen, modelNavigationBusy, hudPanelOpen], () => {
  if (!ownTurn.value || match.value?.status !== 'active' || playbackBusy.value || canPlace.value || settingsOpen.value || gameMenuOpen.value || rulesOpen.value || appearanceOpen.value || modelNavigationBusy.value || hudPanelOpen.value) setShotPhase('overview')
})
watch(calledBall, (id) => scene?.setCalledBall(id || null))
watch(calledPocket, (id) => scene?.setCalledPocket(id || null))
watch(effectiveSettings, value => scene?.setSettings(value), { deep: true })
watch(settings, () => { if (user.value) { localStorage.setItem(`pooltool.settings.${user.value.id}`, JSON.stringify(settings.value)); settingsDirty.value = true } }, { deep: true })
watch(view, value => { if (value !== 'match') { altHeld.value = false; assistPinned.value = false } })
watch(effectiveModelProfile, () => { void applySceneModels() }, { deep: true })
watch(() => user.value?.id, id => {
  playerAssets.value = reconcilePlayerAssetSelection(readPlayerAssetSelection(localStorage, id), modelCatalogue.value)
}, { flush: 'sync' })
watch(playerAssets, value => { writePlayerAssetSelection(localStorage, user.value?.id, value) }, { deep: true })
watch(() => match.value?.id, (id, previous) => { if (id && id !== previous) void loadModelLibrary() })
function updateAim() {
  if (!scene) return
  scene.setAim(aim.value)
  // The scene owns phase locks. A rejected direction-only edit must not linger
  // in HUD state and later bypass the lock when its explicit shot button fires.
  aim.value = { ...scene.getAim() }
}
/** One round trip on the open socket; null when the socket is not usable. */
function commandViaSocket(matchId: string, command: Record<string, unknown>): Promise<CommandResponse> | null {
  const current = socket
  if (!current || current.readyState !== WebSocket.OPEN || !connected.value) return null
  const id = String(command.commandId)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { socketCommands.delete(id); reject(new SocketUnavailable()) }, 65_000)
    socketCommands.set(id, { resolve, reject, timer })
    current.send(JSON.stringify({ type: 'command', matchId, command }))
  })
}
async function submitCommand(matchId: string, command: Record<string, unknown>): Promise<CommandResponse> {
  const viaSocket = commandViaSocket(matchId, command)
  if (viaSocket) {
    try { return await viaSocket } catch (e) { if (!(e instanceof SocketUnavailable)) throw e }
  }
  // Same commandId: the server deduplicates, so this fallback can never apply a command twice.
  return post<CommandResponse>(`/api/matches/${matchId}/commands`, command)
}
async function sendCommand(type: string, payload: Record<string, unknown>) {
  if (!match.value || !isPlayer.value || busy.value) return
  const command = { commandId: uuid(), expectedRevision: match.value.revision, type, payload }
  const pending = { matchId: match.value.id, command }
  localStorage.setItem('pooltool.pendingCommand', JSON.stringify(pending))
  await perform(async () => {
    try {
      const response = await submitCommand(pending.matchId, command)
      localStorage.removeItem('pooltool.pendingCommand')
      if (type === 'placeCueBall') placingCue.value = false
      receiveMatch(response.match, response.result)
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) { localStorage.removeItem('pooltool.pendingCommand'); await loadMatch(pending.matchId).catch(() => {}) }
      throw e
    }
  })
}
async function resumePendingCommand() {
  const pending = restoreJson<{ matchId: string; command: Record<string, unknown> } | null>('pooltool.pendingCommand', null)
  if (!pending) return
  try {
    const response = await post<{ match: Match; result?: ShotResult }>(`/api/matches/${pending.matchId}/commands`, pending.command)
    localStorage.removeItem('pooltool.pendingCommand')
    receiveMatch(response.match, response.result)
  } catch (e) {
    if (e instanceof ApiError && e.status < 500) localStorage.removeItem('pooltool.pendingCommand')
  }
}
async function shoot(value = scene?.getAim() ?? aim.value) {
  if (!canShoot.value || canPlace.value) return
  if (match.value?.snapshot.callShotRequired && (!calledBall.value || !calledPocket.value)) { error.value = 'Выберите заказанный шар и лузу перед ударом.'; return }
  scene?.strike()
  await sendCommand('shot', { ...value, ...(calledBall.value ? { ballCall: calledBall.value } : {}), ...(calledPocket.value ? { pocketCall: calledPocket.value } : {}) })
  if (!playbackBusy.value) scene?.cancelStrike()
}
async function createRoom() {
  await perform(async () => { const result = await post<{ room: Room }>('/api/rooms', { settings: { turnSeconds: turnSeconds.value, ranked: false }, clientVersion: CLIENT_VERSION }); receiveRoom(result.room) })
}
async function joinRoom(spectate = false) {
  if (!code.value.trim()) { error.value = 'Введите код комнаты'; return }
  await perform(async () => {
    const result = await post<{ room: Room; match?: Match }>(`/api/rooms/${encodeURIComponent(code.value.trim().toUpperCase())}/${spectate ? 'spectate' : 'join'}`)
    // An explicit join authorizes this room again; stale packets from a previous
    // departure must not prevent an observer from returning to the same match.
    departedRooms.delete(result.room.code)
    if (result.match) departedMatches.delete(result.match.id)
    if (result.room.matchId) departedMatches.delete(result.room.matchId)
    receiveRoom(result.room)
    if (result.match) receiveMatch(result.match)
  })
}
async function ready() { await perform(async () => { const me = room.value?.players.find((p) => p.id === user.value?.id); receiveRoom((await post<{ room: Room }>(`/api/rooms/${room.value!.code}/ready`, { ready: !me?.ready })).room) }) }
async function start() { await perform(async () => { const result = await post<{ room: Room; match: Match }>(`/api/rooms/${room.value!.code}/start`); receiveRoom(result.room); receiveMatch(result.match) }) }
async function playBot() {
  await perform(async () => {
    localStorage.setItem('pooltool.botDifficulty', botDifficulty.value)
    const result = await post<{ room: Room; match: Match }>('/api/solo', { difficulty: botDifficulty.value, turnSeconds: turnSeconds.value })
    departedRooms.delete(result.room.code)
    receiveRoom(result.room)
    receiveMatch(result.match)
  })
}
async function playBotAgain() {
  await leave()
  if (!room.value) await playBot()
}
async function search(mode: 'casual' | 'ranked') {
  await perform(async () => {
    searchMode.value = mode
    view.value = 'search'
    const result = await post<{ matchId?: string; room?: Room }>('/api/matchmaking', { mode })
    if (result.room) receiveRoom(result.room)
    if (result.matchId) await loadMatch(result.matchId)
    clearInterval(polling)
    polling = window.setInterval(async () => {
      if (view.value !== 'search') { clearInterval(polling); return }
      try { const status = await request<{ matchId?: string; room?: Room }>('/api/matchmaking'); if (status.room) receiveRoom(status.room); if (status.matchId) await loadMatch(status.matchId) } catch { /* websocket/reconnect handles connection recovery */ }
    }, 3000)
  })
}
async function cancelSearch() {
  await perform(async () => {
    await request('/api/matchmaking', { method: 'DELETE' })
    clearInterval(polling)
    const state = await request<{ room: Room | null; match: Match | null }>('/api/me/current')
    if (state.room) receiveRoom(state.room)
    if (state.match) receiveMatch(state.match)
    if (!state.room && !state.match) view.value = 'play'
  })
}
async function leave() {
  await perform(async () => {
    const previousRoom = room.value?.code
    const previousMatch = match.value?.id
    lifecycleGeneration++
    if (previousRoom) departedRooms.add(previousRoom)
    if (previousMatch) departedMatches.add(previousMatch)
    try { if (previousRoom) await post(`/api/rooms/${previousRoom}/leave`) }
    catch (error) { if (previousRoom) departedRooms.delete(previousRoom); if (previousMatch) departedMatches.delete(previousMatch); throw error }
    localStorage.removeItem('pooltool.room'); localStorage.removeItem('pooltool.match'); localStorage.removeItem('pooltool.pendingCommand')
    room.value = null; match.value = null; lastPlayedShot = ''; gameMenuOpen.value = false; rulesOpen.value = false; hudPanelOpen.value = false; placingCue.value = false; shotPhase.value = 'overview'; view.value = 'menu'
  })
}
async function showProfile() {
  await perform(async () => { await refreshUser(); history.value = (await request<{ matches: Array<Record<string, unknown>> }>('/api/me/history')).matches; view.value = 'profile' })
}
async function saveName() {
  await perform(async () => { await request('/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: name.value.trim() }) }); localStorage.setItem('pooltool.name', name.value.trim()); await refreshUser() })
}
async function saveSettings() {
  if (!user.value || bindingConflicts.value.length) return
  try { await request('/api/me/settings', { method: 'PUT', body: JSON.stringify(settings.value) }); settingsDirty.value = false; settingsOpen.value = false }
  catch (e) { error.value = e instanceof Error ? e.message : 'Настройки сохранены локально; синхронизация повторится после подключения' }
}
function updateSettings(value: GameSettings) {
  // Keep the saved casual preference even when the ranked presentation is off.
  settings.value = { ...value, showAimGuide: aimGuidePolicy.value.locked ? settings.value.showAimGuide : value.showAimGuide }
}
function navigate(value: 'menu' | 'play' | 'profile' | 'match') {
  if (value === 'profile') { void showProfile(); return }
  view.value = value
}
async function loadModelLibrary() {
  const generation = ++modelCatalogueGeneration
  modelCatalogueLoading.value = true; modelCatalogueError.value = ''
  try {
    const catalogue = await modelLibrary.adapter.load()
    if (generation !== modelCatalogueGeneration) return
    modelCatalogue.value = catalogue
    modelProfile.value = profileFromLibrary(catalogue)
    playerAssets.value = reconcilePlayerAssetSelection(playerAssets.value, catalogue)
  } catch { if (generation === modelCatalogueGeneration) modelCatalogueError.value = 'Не удалось обновить каталог. Сохранённый выбор не изменён.' }
  finally { if (generation === modelCatalogueGeneration) modelCatalogueLoading.value = false }
}
async function applySceneModels() {
  const current = scene, generation = ++modelSceneGeneration
  if (!current) return
  const profile = effectiveModelProfile.value
  modelSceneLoading.value = Boolean(profile.table || profile.environment); modelSceneErrors.value = []
  try {
    const report = await current.setVisualAssets(profile)
    if (generation === modelSceneGeneration && current === scene) modelSceneErrors.value = Object.entries(report.errors).map(([role, message]) => `${role === 'table' ? 'Стол' : 'Окружение'}: ${message}`)
  } catch { if (generation === modelSceneGeneration && current === scene) modelSceneErrors.value = ['Не удалось загрузить оформление.'] }
  finally { if (generation === modelSceneGeneration && current === scene) modelSceneLoading.value = false }
}
function openAppearance() { settingsOpen.value = false; gameMenuOpen.value = false; bindingCapture.value = null; appearanceOpen.value = true; void loadModelLibrary() }
function closeAppearance() { appearanceOpen.value = false; settingsOpen.value = true }
function applyPlayerAssets(value: PlayerAssetSelection) {
  playerAssets.value = reconcilePlayerAssetSelection(value, modelCatalogue.value)
  if (!writePlayerAssetSelection(localStorage, user.value?.id, playerAssets.value)) error.value = 'Оформление применено, но браузер не разрешил сохранить выбор на устройстве.'
  closeAppearance()
}
async function openModels() {
  if (modelNavigationBusy.value) return
  modelNavigationBusy.value = true
  modelReturnView.value = view.value === 'models' ? 'menu' : view.value
  settingsOpen.value = false; gameMenuOpen.value = false; appearanceOpen.value = false; bindingCapture.value = null
  try {
    await modelLibrary.refreshSession().catch(() => {})
    await loadModelLibrary()
    view.value = 'models'
  } finally { modelNavigationBusy.value = false }
}
async function loginModelAdmin(credentials: { username: string; password: string }) {
  modelAdminBusy.value = true; modelAdminError.value = ''
  try {
    await modelLibrary.login(credentials.username, credentials.password)
    modelAdminOpen.value = false; workshopKey.value++
  } catch (e) { modelAdminError.value = e instanceof Error ? e.message : 'Не удалось войти' }
  finally { credentials.password = ''; modelAdminBusy.value = false }
}
async function logoutModelAdmin() {
  try { await modelLibrary.logout(); workshopKey.value++ }
  catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось завершить сеанс' }
}
function applyModels(value: VisualAssetProfile) { modelProfile.value = value; void loadModelLibrary() }
function releaseAlt() { altHeld.value = false }
function handleAssistKey(event: KeyboardEvent) {
  if (event.key !== 'Alt') return
  if (event.type === 'keyup') { releaseAlt(); return }
  if (view.value === 'match' && !bindingCapture.value && !settingsOpen.value && !appearanceOpen.value && !modelNavigationBusy.value && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault(); altHeld.value = true
  }
}
function elevationWheel(event: WheelEvent) {
  if (!event.shiftKey || !canShoot.value || shotPhase.value === 'overview' || !event.deltaY) return
  event.preventDefault(); event.stopImmediatePropagation()
  changeHudAim({ ...aim.value, theta: Math.max(0, Math.min(60, aim.value.theta + (event.deltaY < 0 ? 1 : -1))) })
}
async function surrender() {
  surrenderConfirmation.value = false; gameMenuOpen.value = false
  await sendCommand('surrender', {})
}
function captureBinding(event: KeyboardEvent | MouseEvent) {
  if (!bindingCapture.value) {
    if (event instanceof KeyboardEvent && event.code === 'Escape' && view.value === 'match' && !settingsOpen.value && !appearanceOpen.value && !modelNavigationBusy.value && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      if (surrenderConfirmation.value) surrenderConfirmation.value = false
      else if (rulesOpen.value) rulesOpen.value = false
      else if (gameMenuOpen.value) gameMenuOpen.value = false
      else if (shotPhase.value !== 'overview') setShotPhase(shotPhase.value === 'power' ? 'aim' : 'overview')
      else gameMenuOpen.value = !gameMenuOpen.value
    }
    return
  }
  event.preventDefault(); event.stopImmediatePropagation()
  if (event instanceof KeyboardEvent && event.code === 'Escape') { bindingCapture.value = null; return }
  const key = event instanceof KeyboardEvent ? event.code : `Mouse${event.button}`
  settings.value.bindings[bindingCapture.value] = key
  bindingCapture.value = null
}
async function copyCode() { if (!room.value) return; try { await navigator.clipboard.writeText(room.value.code) } catch { code.value = room.value.code } }
function visibilityChanged() { releaseAlt(); telemetry('clientVisibility', { visible: document.visibilityState === 'visible' }); if (document.visibilityState === 'visible' && connected.value) void restoreMatch() }
onMounted(() => { void authenticate(); void loadModelLibrary(); window.addEventListener('keydown', captureBinding, true); window.addEventListener('mousedown', captureBinding, true); window.addEventListener('keydown', handleAssistKey, true); window.addEventListener('keyup', handleAssistKey, true); window.addEventListener('blur', releaseAlt); document.addEventListener('visibilitychange', visibilityChanged); window.addEventListener('online', connect) })
onBeforeUnmount(() => { disposed = true; clearInterval(clock); clearInterval(polling); clearInterval(heartbeat); clearTimeout(reconnectTimer); socket?.close(); scene?.destroy(); window.removeEventListener('keydown', captureBinding, true); window.removeEventListener('mousedown', captureBinding, true); window.removeEventListener('keydown', handleAssistKey, true); window.removeEventListener('keyup', handleAssistKey, true); window.removeEventListener('blur', releaseAlt); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('online', connect) })
</script>

<template>
  <div class="app-shell club-app" :class="{ 'in-match': view === 'match' && match, 'in-workshop': view === 'models' }">
    <header v-if="loading || !user" class="app-header">
      <button class="brand" :disabled="busy" @click="view = match ? 'match' : 'menu'">Pooltool Online</button>
      <span class="connection" :class="{ offline: !connected }" role="status">{{ connection }}</span>
      <span v-if="user">{{ user.displayName }} · Эло {{ user.elo }}</span>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }} <button @click="error = ''" aria-label="Закрыть ошибку">×</button></div>
    <div v-if="modelNavigationBusy" class="model-game-notice" role="status">Открываем мастерскую…</div>
    <main v-if="loading" class="panel" aria-busy="true"><h1>Загрузка игры</h1><p>Подключаемся к серверу и восстанавливаем профиль.</p></main>
    <main v-else-if="!user" class="panel"><h1>Соединение недоступно</h1><p>Проверьте подключение и повторите попытку.</p><button @click="authenticate">Повторить</button></main>
    <main v-else-if="view === 'models'" class="model-library-page">
      <div class="model-session-bar"><span>Общая библиотека · {{ modelLibrary.session.value.authenticated ? `Администратор: ${modelLibrary.session.value.username}` : 'Режим просмотра' }}</span><button v-if="modelLibrary.session.value.authenticated" @click="logoutModelAdmin">Выйти из админки</button><button v-else @click="modelAdminError = ''; modelAdminOpen = true">Вход администратора</button></div>
      <ModelWorkshop :key="workshopKey" :library="modelLibrary.adapter" :can-manage="modelLibrary.session.value.authenticated" :initial-profile="modelProfile" @apply="applyModels" @request-admin="modelAdminError = ''; modelAdminOpen = true" @close="view = modelReturnView" />
    </main>
    <ClubMenu v-else-if="view !== 'match'" :view="view" :user="user" :room="room" :history="history" :busy="busy" :connected="connected" :connection="connection" :search-mode="searchMode" :client-version="CLIENT_VERSION" :match-available="Boolean(match)" v-model:code="code" v-model:name="name" v-model:turn-seconds="turnSeconds" v-model:bot-difficulty="botDifficulty" @navigate="navigate" @settings="settingsOpen = true" @models="openModels" @exit="leave" @search="search" @cancel-search="cancelSearch" @create-room="createRoom" @join-room="joinRoom" @ready="ready" @leave="leave" @copy-code="copyCode" @play-bot="playBot" @save-name="saveName" />
    <main v-else-if="view === 'match' && match" class="match-screen figma-match-screen">
      <div class="stage-wrap">
        <div ref="stage" class="game-stage" aria-label="Игровой бильярдный стол" @wheel.capture="elevationWheel"></div>
        <Transition name="toast"><div v-if="toast" class="shot-toast" :class="toast.tone" role="status"><strong>{{ toast.title }}</strong><span v-for="line in toast.lines" :key="line">{{ line }}</span></div></Transition>
        <div v-if="(modelSceneLoading || modelSceneErrors.length) && !settingsOpen && !appearanceOpen && !gameMenuOpen" class="model-game-notice" role="status"><span v-if="modelSceneLoading">Загружаем оформление…</span><template v-else><span>Оформление не загрузилось — используется базовая геометрия.</span><small v-for="message in modelSceneErrors" :key="message">{{ message }}</small><button @click="applySceneModels">Повторить загрузку</button></template></div>
      </div>
      <MatchHud
        :match="match" :user="user" :room="room" :aim="aim" :phase="shotPhase"
        :can-shoot="canShoot" :can-place="canPlace"
        :can-reposition="turnReady && Boolean(match.snapshot.ballInHand) && !match.snapshot.needsPlacement"
        :placing-cue="placingCue" :connected="connected" :connection="connection"
        :remaining="remaining" :elapsed="elapsed" :status-text="matchStatusText"
        :volume="settings.volume" :top-view-key="settings.bindings.topView || DEFAULT_BINDINGS.topView"
        :called-ball="calledBall" :called-pocket="calledPocket" :camera-mode="cameraMode"
        :show-assist="showAssist"
        @settings="settingsOpen = true" @menu="gameMenuOpen = true" @mute="toggleSound"
        @rules="rulesOpen = true" @camera="changeCamera" @aim="changeHudAim"
        @shoot="shoot()" @phase="setShotPhase" @select-ball="selectBall" @select-pocket="selectPocket"
        @place-cue="toggleCuePlacement" @copy-code="copyCode" @panel-open="hudPanelOpen = $event"
        @toggle-assist="assistPinned = !assistPinned"
      />
      <div v-for="player in offlinePlayers" :key="player.name" class="offline-banner" role="alert">{{ isPlayer ? 'Соперник' : player.name }} отключился. Ждём переподключения: {{ player.seconds }} с, затем {{ isPlayer ? 'вам будет засчитана победа' : 'ему будет засчитано поражение' }}.</div>
      <div v-if="match.status === 'finished'" class="result-panel"><h1>{{ !match.winnerId ? 'Матч прерван' : match.winnerId === user.id ? 'Вы победили' : isPlayer ? 'Вы проиграли' : `Победитель: ${winnerName}` }}</h1><p>{{ resultReason }}</p><p v-if="ratingChange">Рейтинг: {{ ratingChange.before }} → {{ ratingChange.after }} ({{ ratingChange.delta > 0 ? '+' : '' }}{{ ratingChange.delta }})</p><button v-if="isSolo && isPlayer" :disabled="busy" @click="playBotAgain">Сыграть ещё</button><button :disabled="busy" @click="leave">В главное меню</button><button @click="showProfile">История и рейтинг</button></div>
    </main>
    <div v-if="gameMenuOpen" class="modal-backdrop club-match-backdrop" @click.self="gameMenuOpen = false; surrenderConfirmation = false">
      <section class="club-match-dialog" role="dialog" aria-modal="true" aria-labelledby="game-menu-title">
        <span class="club-dialog-eyebrow">POOLTOOL · 8-BALL</span>
        <h1 id="game-menu-title">{{ surrenderConfirmation ? 'Сдаться?' : 'Меню матча' }}</h1>
        <template v-if="surrenderConfirmation"><p>Вам будет засчитано поражение. Результат рейтинговой партии повлияет на Эло.</p><button class="club-dialog-primary" :disabled="busy" @click="surrender">Да, сдаться</button><button @click="surrenderConfirmation = false">Продолжить игру</button></template>
        <template v-else>
          <p>{{ isPlayer && match?.status !== 'finished' ? 'Таймер сетевой партии продолжает идти.' : 'Вы можете вернуться к столу или покинуть комнату.' }}</p>
          <button class="club-dialog-primary" @click="gameMenuOpen = false">Вернуться в игру</button><button @click="gameMenuOpen = false; settingsOpen = true">Настройки</button>
          <button @click="gameMenuOpen = false; rulesOpen = true">Правила игры</button><button @click="toggleSound">{{ settings.volume > 0 ? 'Выключить звук' : 'Включить звук' }}</button>
          <button v-if="isPlayer && match?.status !== 'finished'" :disabled="busy" @click="surrenderConfirmation = true">Сдаться</button><button v-else :disabled="busy" @click="leave">В главное меню</button>
        </template>
      </section>
    </div>
    <div v-if="rulesOpen" class="modal-backdrop" @click.self="rulesOpen = false">
      <section class="settings-dialog hud-rules-dialog" role="dialog" aria-modal="true" aria-labelledby="rules-title">
        <h1 id="rules-title">Правила 8-BALL</h1>
        <p>После распределения групп игрок забивает свои цельные или полосатые шары. Восьмёрку нужно забить после всех семи шаров своей группы в заказанную лузу.</p>
        <p>После разбоя перед ударом выберите заказанный шар и лузу. Ошибочный первый контакт, падение битка и другие нарушения оценивает сервер; после фола биток ставится в разрешённой зоне.</p>
        <p>До первого ЛКМ наведите направление удара. Первый ЛКМ фиксирует его и открывает выбор точки контакта кия с битком. Подтвердите точку ЛКМ. Затем зажмите ЛКМ, оттяните кий вниз для выбора силы и отпустите кнопку для удара. Правая кнопка возвращает на предыдущий этап.</p>
        <p>Удерживайте Alt для дополнительных приборов. Shift + колесо меняет наклон кия. Альтернативное управление доступно в панели «Параметры удара». В рейтинговых матчах линия прицеливания принудительно отключена. Настройки и меню не останавливают таймер сетевой партии.</p>
        <button @click="rulesOpen = false">Закрыть правила</button>
      </section>
    </div>
    <ClubSettings v-if="settingsOpen" :settings="effectiveSettings" :binding-capture="bindingCapture" :capture-labels="captureLabels" :binding-conflicts="bindingConflicts" :aim-guide-locked="aimGuidePolicy.locked" :in-match="view === 'match'" :user="user" :client-version="CLIENT_VERSION" @update:settings="updateSettings" @capture="bindingCapture = $event" @reset="settings = defaults()" @save="saveSettings" @close="settingsOpen = false; bindingCapture = null" @models="openModels" @appearance="openAppearance" />
    <PlayerAppearance v-if="appearanceOpen" :library="modelCatalogue" :selection="playerAssets" :snapshot="match?.snapshot" :loading="modelCatalogueLoading" :error="modelCatalogueError" @apply="applyPlayerAssets" @close="closeAppearance" @retry="loadModelLibrary" @manage="openModels" />
    <ModelAdminLogin v-if="modelAdminOpen" :busy="modelAdminBusy" :error="modelAdminError" :configured="modelLibrary.session.value.configured" @submit="loginModelAdmin" @close="modelAdminOpen = false; modelAdminError = ''" />
  </div>
</template>
