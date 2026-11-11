<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, CLIENT_VERSION, post, request, setToken, socketUrl, timestamp } from './api'
import type { User, Room, Match, ShotResult } from './api'
import { createGameScene } from './game/createGameScene'
import { expandTrajectory, numberForPocket } from './game/playback'
import { DEFAULT_BINDINGS } from './game/types'
import { bindingLabel, findBindingConflicts, isAssistKeyboardBinding, matchesAssistBinding, normalizeAssistBinding } from './game/assistBinding'
import type { AimState, BindingAction, CameraMode, GameScene, GameSettings, ShotPhase } from './game/types'
import MatchHud from './components/MatchHud.vue'
import MatchMenu from './components/MatchMenu.vue'
import MatchOverlayFooter from './components/MatchOverlayFooter.vue'
import ClubMenu from './components/ClubMenu.vue'
import ClubSettings from './components/ClubSettings.vue'
import ModelWorkshop from './components/ModelWorkshop.vue'
import ModelAdminLogin from './components/ModelAdminLogin.vue'
import PlayerAppearance from './components/PlayerAppearance.vue'
import AccessibleDialog from './components/AccessibleDialog.vue'
import { applyMatchVisualPolicy, getAimGuidePolicy } from './game/matchPolicy'
import { createServerModelLibrary } from './models/serverLibrary'
import { profileFromLibrary } from './models/libraryProfile'
import { emptyVisualAssetProfile, type ModelLibrarySnapshot, type VisualAssetProfile } from './models/types'
import { defaultPlayerAssetSelection, readPlayerAssetSelection, reconcilePlayerAssetSelection, resolvePlayerAssets,
  writePlayerAssetSelection, type PlayerAssetSelection } from './models/playerSelection'
import { createVkPlayEntry, isVkPlayLaunch, type VkPlayConfig, type VkPlayEntryState } from './platform/vkplay'
import { copyText } from './platform/clipboard'
import { emptyProfileDetails, normalizeProfileDetails, type ProfileDetails } from './profileDetails'
import { isRoomCode } from './roomCode'
import { DEFAULT_PRESENTATION_SETTINGS } from './game/settingsOptions'

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
const vkPlayLaunch = isVkPlayLaunch(location.search)
const vkPlayEntryState = ref<VkPlayEntryState>({ phase: 'loading', message: 'Подключаемся к VK Play…' })
let vkPlayEntry: ReturnType<typeof createVkPlayEntry<User>> | null = null
const now = ref(Date.now())
const serverClockOffset = ref(0)
const name = ref(localStorage.getItem('pooltool.name') || 'Игрок')
const profileDetails = ref(emptyProfileDetails())
const storedProfileDetails = ref(emptyProfileDetails())
let pendingProfileDetails: ProfileDetails | null = null
const profileSaved = ref(false)
const profileChanged = computed(() => JSON.stringify(normalizeProfileDetails(profileDetails.value)) !== JSON.stringify(storedProfileDetails.value))
const code = ref('')
const turnSeconds = ref(60)
const searchMode = ref<'casual' | 'ranked'>('casual')
const ratingWindow = ref<number | null>(null)
const botDifficulty = ref<'easy' | 'medium' | 'hard'>((localStorage.getItem('pooltool.botDifficulty') as 'easy' | 'medium' | 'hard') || 'medium')
const settingsOpen = ref(false)
const gameMenuOpen = ref(false)
const surrenderConfirmation = ref(false)
const rulesOpen = ref(false)
const matchOverlayOpen = computed(() => view.value === 'match' && (gameMenuOpen.value || settingsOpen.value))
const assistHeld = ref(false)
const assistPressedCodes = new Set<string>()
const assistPinned = ref(false)
const hudPanelOpen = ref(false)
const shotPhase = ref<ShotPhase>('overview')
const bindingCapture = ref<BindingAction | null>(null)
const bindingCaptureError = ref('')
const settingsDirty = ref(false)
const history = ref<Array<Record<string, unknown>>>([])
const stage = ref<HTMLDivElement | null>(null)
const playbackBusy = ref(false)
const sceneInputSuspended = ref(false)
const placingCue = ref(false)
const calledBall = ref('')
const calledPocket = ref('')
const aim = ref<AimState>({ phi: 90, V0: 2.5, theta: 0, a: 0, b: 0 })
const defaults = (): GameSettings => ({ ...DEFAULT_PRESENTATION_SETTINGS, quality: 'medium', volume: 0.5, sensitivity: 1, bindings: { ...DEFAULT_BINDINGS }, showAimGuide: true, showPocketLabels: true })
const settings = ref<GameSettings>(defaults())
const aimGuidePolicy = computed(() => getAimGuidePolicy(match.value))
const effectiveSettings = computed(() => applyMatchVisualPolicy(settings.value, match.value))
const assistKeyLabel = computed(() => bindingLabel(normalizeAssistBinding(settings.value.bindings.assist)))
const showAssist = computed(() => (assistHeld.value || assistPinned.value) && !settingsOpen.value && !gameMenuOpen.value && !rulesOpen.value && !appearanceOpen.value && !modelNavigationBusy.value && !bindingCapture.value)
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
const modelReturnView = ref<View>('menu')
let scene: GameScene | null = null
let aimTurnKey = ''
let socket: WebSocket | null = null
let reconnectTimer = 0
let reconnectAttempt = 0
let disposed = false
let lastPlayedShot = ''
let latestPlayback: { matchId: string; shot: ShotResult } | null = null
// The platform never restores a cached guest identity, including on shared PCs.
let token = vkPlayLaunch ? '' : localStorage.getItem('pooltool.token') || ''
let heartbeat = 0
let polling = 0
let searchGeneration = 0
let cancellingSearch = false
type SearchDestination = 'menu' | 'play' | 'profile'
let searchExitTarget: SearchDestination | null = null
let telemetryFlush = false
const clipboardMessage = ref('')
let clipboardMessageTimer = 0
let authSentAt = 0
let clockCalibrated = false
let lifecycleGeneration = 0
// UI-operation ownership is separate from navigation generation: leaving a
// match deliberately invalidates stale room loads, but must release its busy UI.
let activeOperation: symbol | null = null
let modelCatalogueGeneration = 0
let modelSceneGeneration = 0
let hydratingSettings = false
let settingsRevision = 0
let settingsDialogRevision = 0
let settingsSync: Promise<boolean> | null = null
let attemptedSurrenderDeparture: string | null = null
type CommandResponse = { match: Match; result?: ShotResult }
type QueueState = { queued?: boolean; mode?: 'casual' | 'ranked'; ratingWindow?: number; matchId?: string; room?: Room }
class SocketUnavailable extends Error {}
type PendingCommand = { matchId: string; command: Record<string, unknown>; userId?: string }
let platformPendingCommand: PendingCommand | null = null
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
function rememberPending(value: PendingCommand | null) {
  if (vkPlayLaunch) platformPendingCommand = value ? { ...value, userId: user.value?.id } : null
  else if (value) localStorage.setItem('pooltool.pendingCommand', JSON.stringify(value))
  else localStorage.removeItem('pooltool.pendingCommand')
}
function pendingCommand(): PendingCommand | null {
  if (vkPlayLaunch) return platformPendingCommand?.userId === user.value?.id ? platformPendingCommand : null
  return restoreJson<PendingCommand | null>('pooltool.pendingCommand', null)
}
function clearGameBookmarks() {
  if (!vkPlayLaunch) { localStorage.removeItem('pooltool.room'); localStorage.removeItem('pooltool.match') }
}
function mergeSettings(value: unknown): GameSettings {
  const record = value && typeof value === 'object' ? value as Partial<GameSettings> & { profileDetails?: unknown } : {}
  // Profile fields are synchronized through the same authenticated endpoint,
  // but never passed to the renderer or stored in the local game-settings cache.
  const { profileDetails: _profileDetails, ...s } = record
  return { ...defaults(), ...s, bindings: { ...DEFAULT_BINDINGS, ...(s.bindings || {}), assist: normalizeAssistBinding(s.bindings?.assist) } }
}
const isPlayer = computed(() => Boolean(match.value?.players.some((p) => p.id === user.value?.id)))
const ownSurrenderedMatchId = computed(() => {
  const current = match.value, userId = user.value?.id
  if (!current || !userId || current.status !== 'finished' || current.reason !== 'surrender'
    || !current.winnerId || current.winnerId === userId || !isPlayer.value) return null
  // An explicit return as an observer is not a second surrender.
  const spectators = room.value?.id === current.roomId ? room.value.spectators : null
  return Array.isArray(spectators) && spectators.includes(userId) ? null : current.id
})
const ownTurn = computed(() => match.value?.players[match.value.currentPlayer]?.id === user.value?.id)
const turnReady = computed(() => Boolean(view.value === 'match' && connected.value && ownTurn.value && match.value?.status === 'active' && timestamp(match.value.playbackUntil) <= now.value + serverClockOffset.value && !busy.value && !playbackBusy.value && !settingsOpen.value && !gameMenuOpen.value && !rulesOpen.value && !appearanceOpen.value && !modelNavigationBusy.value))
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
const captureLabels: Record<BindingAction, string> = { aimLeft: 'Прицел влево', aimRight: 'Прицел вправо', powerUp: 'Увеличить силу', powerDown: 'Уменьшить силу', elevationUp: 'Поднять кий', elevationDown: 'Опустить кий', spinLeft: 'Вращение влево', spinRight: 'Вращение вправо', spinUp: 'Вращение вверх', spinDown: 'Вращение вниз', shoot: 'Удар', resetCamera: 'Сброс камеры', topView: 'Вид сверху', orbit: 'Вращать камеру', cameraLeft: 'Повернуть стол влево', cameraRight: 'Повернуть стол вправо', cueView: 'Вид из-за кия', assist: 'Дополнительные приборы' }
const bindingConflicts = computed(() => findBindingConflicts(settings.value.bindings).map(([action, previous, key]) => `${captureLabels[action as BindingAction]} и ${captureLabels[previous as BindingAction]}: ${key}`))
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
function setShotPhase(phase: ShotPhase) { shotPhase.value = phase; scene?.setShotPhase(phase) }
function inputIsSuspended() { return scene?.isInputSuspended() ?? sceneInputSuspended.value }
function changeHudPhase(phase: ShotPhase) { if (!inputIsSuspended()) setShotPhase(phase) }
function changeCamera(action: 'top' | 'free' | 'cue' | 'left' | 'right' | 'in' | 'out') {
  if (action === 'top') { setShotPhase('overview'); scene?.resetCamera(true) }
  else if (action === 'free') { setShotPhase('overview'); scene?.resetCamera() }
  else if (action === 'cue') { scene?.setCameraMode('cue'); scene?.requestAimPointerLock() }
  else if (action === 'left') scene?.rotateCamera(-0.4)
  else if (action === 'right') scene?.rotateCamera(0.4)
  else scene?.zoomCamera(action === 'in' ? 0.85 : 1.18)
}
function changeHudAim(value: AimState) { if (!inputIsSuspended()) { aim.value = { ...value }; updateAim() } }
function toggleCuePlacement() {
  if (inputIsSuspended()) return
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
function selectBall(id: string) { if (!inputIsSuspended()) calledBall.value = calledBall.value === id ? '' : id }
function selectPocket(id: string) { if (!inputIsSuspended()) calledPocket.value = calledPocket.value === id ? '' : id }
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
  const owner = Symbol('ui-operation')
  activeOperation = owner
  busy.value = true
  error.value = ''
  try { await action() } catch (e) {
    if (activeOperation === owner && !(e instanceof ApiError && e.code === 'identity_changed')) error.value = e instanceof Error ? e.message : 'Не удалось выполнить действие'
  } finally {
    if (activeOperation === owner) { activeOperation = null; busy.value = false }
  }
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
function applyAuthenticatedUser(value: User) {
  user.value = value
  name.value = value.displayName
  storedProfileDetails.value = normalizeProfileDetails(value.settings?.profileDetails)
  pendingProfileDetails = null
  profileDetails.value = { ...storedProfileDetails.value }
  profileSaved.value = false
  const remoteSettings = mergeSettings(value.settings)
  const cached = restoreJson<GameSettings | null>(`pooltool.settings.${value.id}`, null)
  hydratingSettings = true
  try { settings.value = cached ? mergeSettings({ ...cached, bindings: { ...cached.bindings, assist: cached.bindings?.assist ?? remoteSettings.bindings.assist } }) : remoteSettings }
  finally { hydratingSettings = false }
  settingsDirty.value = JSON.stringify(settings.value) !== JSON.stringify(remoteSettings)
  localStorage.setItem(`pooltool.settings.${value.id}`, JSON.stringify(settings.value))
  connect()
}
function resetPlatformIdentity() {
  lifecycleGeneration++; modelSceneGeneration++; searchGeneration++
  cancellingSearch = false; searchExitTarget = null; ratingWindow.value = null
  activeOperation = null
  attemptedSurrenderDeparture = null
  clearTimeout(reconnectTimer); clearInterval(heartbeat); clearInterval(polling)
  const previous = socket; socket = null; previous?.close()
  for (const pending of socketCommands.values()) { clearTimeout(pending.timer); pending.reject(new ApiError('Учётная запись изменилась.', 409, 'identity_changed')) }
  socketCommands.clear(); platformPendingCommand = null
  token = ''; setToken(''); user.value = null; connected.value = false; reconnectAttempt = 0
  scene?.destroy(); scene = null
  room.value = null; match.value = null; history.value = []; view.value = 'menu'; modelReturnView.value = 'menu'
  latestPlayback = null; lastPlayedShot = ''; pendingSummary = null; playbackBusy.value = false
  departedRooms.clear(); departedMatches.clear(); busy.value = false
  settingsOpen.value = false; gameMenuOpen.value = false; surrenderConfirmation.value = false; rulesOpen.value = false
  appearanceOpen.value = false; modelAdminOpen.value = false; modelNavigationBusy.value = false; hudPanelOpen.value = false
  releaseAssist(); assistPinned.value = false; bindingCapture.value = null; bindingCaptureError.value = ''; placingCue.value = false
  calledBall.value = ''; calledPocket.value = ''; shotPhase.value = 'overview'; toast.value = null
  clearTimeout(toastTimer); settingsRevision++; settingsSync = null
  clearTimeout(clipboardMessageTimer); clipboardMessage.value = ''
  hydratingSettings = true
  try { settings.value = defaults() } finally { hydratingSettings = false }
  settingsDirty.value = false; error.value = ''; name.value = 'Игрок'
  profileDetails.value = emptyProfileDetails(); storedProfileDetails.value = emptyProfileDetails(); pendingProfileDetails = null; profileSaved.value = false
}
async function authenticate(retryGuest = true) {
  if (vkPlayLaunch) {
    resetPlatformIdentity()
    if (!vkPlayEntry) vkPlayEntry = createVkPlayEntry<User>({
      search: location.search, embedded: window.parent !== window,
      clientVersion: CLIENT_VERSION,
      fetchConfig: () => request<VkPlayConfig>('/api/auth/config'),
      exchange: body => post<{ token: string; user: User }>('/api/auth/vkplay', body),
      onState: value => { vkPlayEntryState.value = value; loading.value = value.phase === 'loading' },
      onSession: value => {
        // Intentionally memory-only. Keep the test guest token untouched.
        token = value.token; setToken(token); error.value = ''
        applyAuthenticatedUser(value.user)
      },
    })
    await vkPlayEntry.start()
    return
  }
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
    applyAuthenticatedUser(user.value)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && retryGuest) {
      token = ''
      localStorage.removeItem('pooltool.token')
      await authenticate(false)
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
    if (current !== socket || disposed) return
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
        if (settingsDirty.value) void synchronizeSettings()
      } else if (message.type === 'restored') {
        if (message.room) receiveRoom(message.room)
        if (message.match) receiveMatch(message.match)
        // A reconnect snapshot may have been assembled before an acknowledged
        // cancellation. Re-read queue state rather than reopening a stale search.
        if (message.queue?.queued && !cancellingSearch) void restoreMatch()
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
  current.onclose = (event) => {
    if (current !== socket) return
    if (vkPlayLaunch && event.code === 1008) {
      // Reject old commands as identity changes, never as retryable socket loss.
      // Otherwise submitCommand would replay A's command via HTTP after logout.
      vkPlayEntry?.dispose(); vkPlayEntry = null
      resetPlatformIdentity()
      vkPlayEntryState.value = { phase: 'error', message: 'Сессия VK Play больше не подтверждена. Повторите вход через платформу.' }
      loading.value = false
      return
    }
    connected.value = false
    connection.value = 'Связь потеряна. Партия сохраняется на сервере.'
    clearInterval(heartbeat)
    for (const [id, pending] of socketCommands) { clearTimeout(pending.timer); pending.reject(new SocketUnavailable()); socketCommands.delete(id) }
    telemetry('clientReconnect', { connected: false })
    if (!disposed) reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10_000))
  }
  current.onerror = () => current.close()
}
function receiveServerView(value: View) {
  // A running/recovered game updates in the background while the administrator
  // prepares art. Even a newly started match must not destroy that draft; the
  // explicit Return action leads to the latest authoritative game/room instead.
  if (view.value === 'models' || modelNavigationBusy.value) modelReturnView.value = value
  else view.value = value
}
function finishQueueForMembership() {
  // A later authoritative room/match wins over any earlier HTTP snapshot of
  // the queue, even when both responses belong to the same connected account.
  searchGeneration++; clearInterval(polling); searchExitTarget = null; ratingWindow.value = null
}
function receiveRoom(value: Room | null) {
  if (!value || departedRooms.has(value.code)) return
  if (value.status !== 'closed') finishQueueForMembership()
  room.value = value
  if (!vkPlayLaunch) localStorage.setItem('pooltool.room', value.code)
  if (value.matchId) { if (value.matchId !== match.value?.id) loadMatchInBackground(value.matchId) }
  else if (value.status !== 'closed') receiveServerView('lobby')
}
function receiveMatch(value: Match, result?: ShotResult) {
  if (!value || departedMatches.has(value.id) || (match.value?.id === value.id && value.revision < match.value.revision)) return
  finishQueueForMembership()
  // Physics recordings are immutable input, not editable UI state. Deep Vue
  // proxies turn every interpolation read into reactive dependency tracking.
  if (result) markRaw(result)
  if (value.lastShot) markRaw(value.lastShot)
  match.value = value
  const replay = result?.trajectory ? result : value.lastShot && 'result' in value.lastShot && value.lastShot.result?.trajectory ? value.lastShot.result : null
  if (replay) latestPlayback = { matchId: value.id, shot: replay }
  else if (latestPlayback?.matchId !== value.id) latestPlayback = null
  if (calledBall.value && !remainingBalls.value.some(ball => String(ball.id) === calledBall.value)) calledBall.value = ''
  if (!vkPlayLaunch) localStorage.setItem('pooltool.match', value.id)
  receiveServerView('match')
  if (view.value === 'match' && !modelNavigationBusy.value) applyMatchPlayback(value, result)
  updateInteraction()
  if (value.status === 'finished') {
    gameMenuOpen.value = false; surrenderConfirmation.value = false
    if (ownSurrenderedMatchId.value === value.id) {
      // The authoritative broadcast is also confirmation if the separate
      // commandResult is delayed or lost. Release the original operation.
      const pending = pendingCommand()
      if (pending?.matchId === value.id && pending.command?.type === 'surrender') {
        const id = String(pending.command.commandId), waiting = socketCommands.get(id)
        if (waiting) { clearTimeout(waiting.timer); socketCommands.delete(id); waiting.resolve({ match: value }) }
      }
    }
    void refreshUser().catch(reportBackgroundError)
  }
}
function applyMatchPlayback(value: Match, result?: ShotResult) {
  const last = value.lastShot
  const lastResult = last && 'result' in last ? last.result : last as ShotResult | undefined
  const lastId = last && 'shotId' in last ? last.shotId : last && 'id' in last ? last.id : undefined
  const cached = latestPlayback?.matchId === value.id && (!lastId || latestPlayback.shot.shotId === lastId) ? latestPlayback.shot : undefined
  // Match broadcasts deliberately omit lastShot.result when result is sent as
  // a sibling field. Retain that last trajectory while the workshop is open so
  // returning to the table can still catch up to the real shared animation.
  const shot = result || (lastResult?.trajectory ? lastResult : cached || lastResult)
  if (shot?.trajectory) {
    const shotKey = `${value.id}:${shot.shotId || (last && 'id' in last ? last.id : '') || value.revision}`
    const serverStart = timestamp(shot.startAt || shot.playbackStartAt || (last && 'startAt' in last ? last.startAt : undefined))
    const start = serverStart ? serverStart - serverClockOffset.value : Date.now() + 200
    if (shotKey !== lastPlayedShot && start + shot.duration * 1000 > Date.now()) {
      lastPlayedShot = shotKey
      playbackBusy.value = true
      pendingSummary = shot
      const trajectory = expandTrajectory(shot.trajectory)
      void nextTick(() => {
        if (view.value !== 'match' || modelNavigationBusy.value || match.value?.id !== value.id || lastPlayedShot !== shotKey) return
        ensureScene(); scene?.setState(shot.initialState); scene?.playShot(trajectory, start)
      })
    } else if (!playbackBusy.value) scene?.setState(value.snapshot)
  } else if (!playbackBusy.value) scene?.setState(value.snapshot)
}
function reportBackgroundError(failure: unknown) {
  if (failure instanceof ApiError && failure.code === 'identity_changed') return
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
  const queueGeneration = searchGeneration
  try {
    const state = await request<{ room: Room | null; match: Match | null; queue?: QueueState }>('/api/me/current')
    if (generation !== lifecycleGeneration) return
    if (state.room) receiveRoom(state.room)
    if (state.match) receiveMatch(state.match)
    if (state.queue?.queued && !cancellingSearch && queueGeneration === searchGeneration) restoreSearch(state.queue)
  } catch (e) {
    if (generation !== lifecycleGeneration || (e instanceof ApiError && e.code === 'identity_changed')) return
    if (e instanceof ApiError && [403, 404, 410].includes(e.status)) clearGameBookmarks()
    else error.value = e instanceof Error ? e.message : 'Ошибка восстановления'
  }
}
async function refreshUser() { const result = await request<User | { user: User }>('/api/me'); user.value = 'user' in result ? result.user : result }
function ensureScene() {
  if (!stage.value || scene || !match.value) return
  try {
    const keepSuspended = sceneInputSuspended.value
    scene = createGameScene(stage.value, {
      onAimChange: (value) => { aim.value = { ...value } },
      onShoot: (value) => { void shoot(value) },
      onPlaceCueBall: ([x, y]) => { void sendCommand('placeCueBall', { x, y }) },
      onSelectBall: (id) => { if (id !== 'cue') calledBall.value = id },
      onSelectPocket: (id) => { calledPocket.value = id },
      onCameraModeChange: (mode) => { cameraMode.value = mode },
      onShotPhaseChange: (phase) => { shotPhase.value = phase || 'overview' },
      onInputSuspendedChange: (value) => { sceneInputSuspended.value = value },
      onPlaybackComplete: () => {
        playbackBusy.value = false
        if (match.value) scene?.setState(match.value.snapshot)
        updateInteraction()
        if (pendingSummary) { summarizeShot(pendingSummary); pendingSummary = null }
      },
      onError: (message) => { error.value = message; telemetry('clientError', { message: message.slice(0, 500) }) },
      onPerformance: (stats) => { telemetry('clientPerformance', stats) },
    })
    aimTurnKey = ''
    cameraMode.value = scene.getCameraMode()
    scene.setDefaultAimCamera('cue')
    if (keepSuspended) scene.suspendInput()
    scene.setSettings(effectiveSettings.value)
    scene.setState(match.value.snapshot)
    scene.setAim(aim.value)
    scene.setShotPhase(shotPhase.value)
    scene.setCalledBall(calledBall.value || null)
    scene.setCalledPocket(calledPocket.value || null)
    void applySceneModels()
    updateInteraction()
    applyMatchPlayback(match.value)
  } catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось открыть 3D-сцену' }
}
function updateInteraction() {
  const table = match.value?.snapshot.table
  const canAim = canShoot.value && !hudPanelOpen.value
  scene?.setInteraction({ canShoot: canAim, canPlaceCueBall: canPlace.value && !hudPanelOpen.value, spectator: !isPlayer.value,
    pointerLockAllowed: !showAssist.value,
    ownTurn: ownTurn.value && match.value?.status === 'active',
    placementRegion: match.value?.snapshot.ballInHandRegion === 'behind_line' && table ? { minY: 0, maxY: table.length / 4 } : undefined })
  // Modals and drawers also toggle canShoot. Only a new authoritative shot (or
  // finishing cue-ball placement) resets an explicitly selected top/free view.
  if (canPlace.value) aimTurnKey = ''
  if (scene && canAim && match.value) {
    const key = `${match.value.id}:${match.value.snapshot.shotNumber ?? 0}`
    if (aimTurnKey !== key) { aimTurnKey = key; scene.beginAimTurn() }
  }
}
watch(stage, () => {
  if (stage.value) ensureScene()
  else {
    scene?.destroy(); scene = null; playbackBusy.value = false
    // A disposed scene has not completed its animation. A replacement scene
    // must be allowed to resume this same shot from the shared server time.
    lastPlayedShot = ''
  }
}, { flush: 'post' })
watch([canShoot, canPlace, isPlayer], updateInteraction)
watch(hudPanelOpen, updateInteraction)
watch(showAssist, updateInteraction)
watch([ownTurn, () => match.value?.id, () => match.value?.status, playbackBusy, canPlace, settingsOpen, gameMenuOpen, rulesOpen, appearanceOpen, modelNavigationBusy, hudPanelOpen], () => {
  if (!ownTurn.value || match.value?.status !== 'active' || playbackBusy.value || canPlace.value || settingsOpen.value || gameMenuOpen.value || rulesOpen.value || appearanceOpen.value || modelNavigationBusy.value || hudPanelOpen.value) setShotPhase('overview')
})
watch(calledBall, (id) => scene?.setCalledBall(id || null))
watch(calledPocket, (id) => scene?.setCalledPocket(id || null))
watch(effectiveSettings, value => scene?.setSettings(value), { deep: true })
watch(settings, () => {
  if (user.value && !hydratingSettings) {
    localStorage.setItem(`pooltool.settings.${user.value.id}`, JSON.stringify(settings.value))
    settingsRevision++
    settingsDirty.value = true
  }
}, { deep: true, flush: 'sync' })
watch([name, profileDetails], () => { profileSaved.value = false }, { deep: true })
watch(settingsOpen, () => { settingsDialogRevision++ }, { flush: 'sync' })
watch([ownSurrenderedMatchId, () => room.value?.id, busy, connected, view, modelNavigationBusy, appearanceOpen],
  ([matchId, roomId, working, online, currentView, openingModels, changingAppearance], previous) => {
    if (online && !previous[3]) attemptedSurrenderDeparture = null
    // Surrender is committed before leaving the room. Wait for the command's
    // busy owner to finish, and never leave a room belonging to another match.
    if (!matchId || working || currentView !== 'match' || openingModels || changingAppearance
      || !roomId || roomId !== match.value?.roomId || attemptedSurrenderDeparture === matchId) return
    attemptedSurrenderDeparture = matchId
    void leave()
  })
watch(view, value => { if (value !== 'match') { releaseAssist(); assistPinned.value = false } })
watch(() => settings.value.bindings.assist, () => { releaseAssist(); assistPinned.value = false })
watch(bindingCapture, () => { bindingCaptureError.value = ''; releaseAssist() })
watch([settingsOpen, gameMenuOpen, rulesOpen, appearanceOpen, modelNavigationBusy], values => { if (values.some(Boolean)) releaseAssist() })
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
  rememberPending(pending)
  await perform(async () => {
    try {
      const response = await submitCommand(pending.matchId, command)
      rememberPending(null)
      if (type === 'placeCueBall') placingCue.value = false
      receiveMatch(response.match, response.result)
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && e.code !== 'identity_changed') { rememberPending(null); await loadMatch(pending.matchId).catch(() => {}) }
      throw e
    }
  })
}
async function resumePendingCommand() {
  const pending = pendingCommand()
  if (!pending) return
  const generation = lifecycleGeneration
  const stillCurrent = () => generation === lifecycleGeneration && pendingCommand()?.command?.commandId === pending.command.commandId
  try {
    const response = await post<{ match: Match; result?: ShotResult }>(`/api/matches/${pending.matchId}/commands`, pending.command)
    if (!stillCurrent()) return
    rememberPending(null)
    receiveMatch(response.match, response.result)
  } catch (e) {
    if (stillCurrent() && e instanceof ApiError && e.status < 500 && e.code !== 'identity_changed') rememberPending(null)
  }
}
async function shoot(value = scene?.getAim() ?? aim.value) {
  if (!canShoot.value || canPlace.value || inputIsSuspended()) return
  scene?.strike()
  await sendCommand('shot', { ...value, ...(calledBall.value ? { ballCall: calledBall.value } : {}), ...(calledPocket.value ? { pocketCall: calledPocket.value } : {}) })
  if (!playbackBusy.value) scene?.cancelStrike()
}
async function createRoom() {
  await perform(async () => { const result = await post<{ room: Room }>('/api/rooms', { settings: { turnSeconds: turnSeconds.value, ranked: false }, clientVersion: CLIENT_VERSION }); receiveRoom(result.room) })
}
async function joinRoom(spectate = false) {
  if (!isRoomCode(code.value)) { error.value = 'Введите шесть латинских букв или цифр из кода комнаты'; return }
  await perform(async () => {
    const result = await post<{ room: Room; match?: Match }>(`/api/rooms/${code.value}/${spectate ? 'spectate' : 'join'}`)
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
  const previousUser = user.value?.id, previousToken = token
  await leave()
  // A queued replay belongs to the original identity, not an account that
  // authenticated while its leave request was pending.
  if (user.value?.id === previousUser && token === previousToken && !room.value) await playBot()
}
function applyQueueWindow(status: QueueState) {
  if (typeof status.ratingWindow === 'number' && Number.isFinite(status.ratingWindow) && status.ratingWindow >= 0) ratingWindow.value = status.ratingWindow
}
function startSearchPolling() {
  clearInterval(polling)
  const generation = searchGeneration
  let pending = false
  const timer = window.setInterval(async () => {
    if (view.value !== 'search' || generation !== searchGeneration) { clearInterval(timer); return }
    if (pending || cancellingSearch) return
    pending = true
    try {
      const status = await request<QueueState>('/api/matchmaking')
      if (generation !== searchGeneration || view.value !== 'search' || cancellingSearch) return
      applyQueueWindow(status)
      if (status.room) receiveRoom(status.room)
      if (status.matchId) await loadMatch(status.matchId)
      if (status.queued === false && !status.room && !status.matchId && view.value === 'search') {
        const destination = searchExitTarget ?? 'play'
        await perform(() => finishSearchNavigation(destination))
      }
    } catch { /* websocket/reconnect handles connection recovery */ }
    finally { pending = false }
  }, 3000)
  polling = timer
}
function restoreSearch(queue: QueueState) {
  if (queue.mode === 'ranked' || queue.mode === 'casual') searchMode.value = queue.mode
  applyQueueWindow(queue)
  receiveServerView('search')
  if (view.value === 'search') startSearchPolling()
}
async function search(mode: 'casual' | 'ranked') {
  await perform(async () => {
    searchGeneration++
    searchExitTarget = null
    searchMode.value = mode
    ratingWindow.value = null
    view.value = 'search'
    const result = await post<QueueState>('/api/matchmaking', { mode })
    applyQueueWindow(result)
    if (result.room) receiveRoom(result.room)
    if (result.matchId) await loadMatch(result.matchId)
    if (view.value === 'search') startSearchPolling()
  })
}
async function finishSearchNavigation(destination: SearchDestination) {
  searchExitTarget = null; ratingWindow.value = null
  view.value = destination === 'profile' ? 'play' : destination
  if (destination === 'profile') await loadProfileView()
}
async function cancelSearch(returnView: SearchDestination = 'play') {
  await perform(async () => {
    searchGeneration++; cancellingSearch = true; searchExitTarget = returnView; clearInterval(polling)
    try {
      await request('/api/matchmaking', { method: 'DELETE' })
      const state = await request<{ room: Room | null; match: Match | null }>('/api/me/current')
      if (state.room) receiveRoom(state.room)
      if (state.match) receiveMatch(state.match)
      if (!state.room && !state.match && view.value === 'search') await finishSearchNavigation(returnView)
    } finally {
      cancellingSearch = false
      if (view.value === 'search') startSearchPolling()
    }
  })
}
async function leave(returnView: 'menu' | 'play' = 'menu') {
  await perform(async () => {
    const previousRoom = room.value?.code
    const previousMatch = match.value?.id
    const afterSurrender = Boolean(previousMatch && ownSurrenderedMatchId.value === previousMatch)
    const generation = ++lifecycleGeneration
    const stillLeaving = () => generation === lifecycleGeneration && room.value?.code === previousRoom && match.value?.id === previousMatch
    if (previousRoom) departedRooms.add(previousRoom)
    if (previousMatch) departedMatches.add(previousMatch)
    try { if (previousRoom) await post(`/api/rooms/${previousRoom}/leave`) }
    catch (error) {
      if (!stillLeaving()) return
      // A lost response or a second tab can already have completed this leave.
      // Only an authoritative empty membership confirms that; a 503 alone does not.
      const state = afterSurrender && !(error instanceof ApiError && error.code === 'identity_changed')
        ? await request<{ room: Room | null; match: Match | null }>('/api/me/current').catch(() => null) : null
      if (!stillLeaving()) return
      if (!state || state.room || state.match) {
        if (previousRoom) departedRooms.delete(previousRoom)
        if (previousMatch) departedMatches.delete(previousMatch)
        throw error
      }
    }
    if (!stillLeaving()) return
    clearGameBookmarks(); rememberPending(null)
    room.value = null; match.value = null; lastPlayedShot = ''; latestPlayback = null; resumeMatchOverlay(); rulesOpen.value = false; hudPanelOpen.value = false; placingCue.value = false; shotPhase.value = 'overview'; view.value = returnView
  })
}
async function loadProfileView() {
  await refreshUser()
  if (user.value) name.value = user.value.displayName
  if (!settingsDirty.value && !settingsSync) storedProfileDetails.value = normalizeProfileDetails(user.value?.settings?.profileDetails)
  profileDetails.value = { ...(pendingProfileDetails ?? storedProfileDetails.value) }
  profileSaved.value = false
  history.value = (await request<{ matches: Array<Record<string, unknown>> }>('/api/me/history')).matches
  view.value = 'profile'
}
async function showProfile() { await perform(loadProfileView) }
async function saveName() {
  await perform(async () => {
    const identity = user.value?.id
    if (!identity) return
    const displayName = name.value.trim()
    const details = normalizeProfileDetails(profileDetails.value)
    profileSaved.value = false
    if (displayName !== user.value?.displayName) {
      const result = await request<{ user: User }>('/api/me', { method: 'PATCH', body: JSON.stringify({ displayName }) })
      if (user.value?.id !== identity) return
      user.value = result.user
      if (!vkPlayLaunch) localStorage.setItem('pooltool.name', result.user.displayName)
    }
    if (pendingProfileDetails || JSON.stringify(details) !== JSON.stringify(storedProfileDetails.value)) {
      pendingProfileDetails = details
      settingsRevision++; settingsDirty.value = true
    }
    if (settingsDirty.value && !await synchronizeSettings()) {
      if (user.value?.id === identity && !error.value) error.value = 'Не удалось сохранить профиль. Проверьте настройки и повторите попытку.'
      return
    }
    await refreshUser()
    if (user.value?.id !== identity) return
    name.value = user.value.displayName
    profileDetails.value = { ...storedProfileDetails.value }
    await nextTick()
    profileSaved.value = true
  })
}
async function synchronizeSettings(): Promise<boolean> {
  if (!user.value || bindingConflicts.value.length) return false
  if (settingsSync) return settingsSync
  const currentSync = (async () => {
    try {
      // Serialize writes and send a new snapshot if the user edits while a PUT
      // is in flight. An older response never clears newer unsaved changes.
      while (settingsDirty.value) {
        if (!user.value || bindingConflicts.value.length) return false
        const userId = user.value.id
        // The legacy PUT replaces the whole object. Read the latest profile
        // before a game-only write so an older tab does not replace newer text.
        let latestProfile = storedProfileDetails.value
        if (!pendingProfileDetails) {
          const current = await request<{ settings: Record<string, unknown> }>('/api/me/settings')
          if (user.value?.id !== userId) return false
          latestProfile = normalizeProfileDetails(current.settings.profileDetails)
        }
        const revision = settingsRevision, profileSnapshot = pendingProfileDetails
        const payload = JSON.stringify({ ...settings.value, profileDetails: profileSnapshot ?? latestProfile })
        const result = await request<{ settings: Record<string, unknown> }>('/api/me/settings', { method: 'PUT', body: payload })
        if (user.value?.id !== userId) return false
        storedProfileDetails.value = normalizeProfileDetails(result.settings.profileDetails)
        if (pendingProfileDetails === profileSnapshot) pendingProfileDetails = null
        if (revision === settingsRevision) settingsDirty.value = false
      }
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'identity_changed') return false
      error.value = e instanceof Error ? e.message : 'Настройки сохранены локально; синхронизация повторится после подключения'
      return false
    }
  })()
  settingsSync = currentSync
  try { return await currentSync }
  finally { if (settingsSync === currentSync) settingsSync = null }
}
async function saveSettings() {
  const revision = settingsRevision, dialogRevision = settingsDialogRevision
  if (await synchronizeSettings() && revision === settingsRevision && dialogRevision === settingsDialogRevision) resumeMatchOverlay()
}
function updateSettings(value: GameSettings) {
  // Keep the saved casual preference even when the ranked presentation is off.
  settings.value = { ...value, showAimGuide: aimGuidePolicy.value.locked ? settings.value.showAimGuide : value.showAimGuide }
}
function navigate(value: 'menu' | 'play' | 'profile' | 'match') {
  if (view.value === 'search' && value !== 'match') { void cancelSearch(value); return }
  if (view.value === 'lobby' && value === 'menu') { void leave('menu'); return }
  if (value === 'profile') { void showProfile(); return }
  view.value = value
}
function resumeMatchOverlay() {
  settingsOpen.value = false; gameMenuOpen.value = false; surrenderConfirmation.value = false; bindingCapture.value = null
}
function openMatchMenu() {
  settingsOpen.value = false; surrenderConfirmation.value = false; bindingCapture.value = null; gameMenuOpen.value = true
}
function openMatchSettings() {
  gameMenuOpen.value = false; surrenderConfirmation.value = false; settingsOpen.value = true
}
function closeSettings() {
  if (view.value === 'match' && match.value) openMatchMenu()
  else resumeMatchOverlay()
}
function settingsHome() { resumeMatchOverlay(); navigate('menu') }
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
  const generation = lifecycleGeneration
  modelNavigationBusy.value = true
  modelReturnView.value = view.value === 'models' ? 'menu' : view.value
  settingsOpen.value = false; gameMenuOpen.value = false; appearanceOpen.value = false; bindingCapture.value = null
  try {
    await modelLibrary.refreshSession().catch(() => {})
    await loadModelLibrary()
    if (generation !== lifecycleGeneration) return
    view.value = 'models'
  } finally { if (generation === lifecycleGeneration) modelNavigationBusy.value = false }
}
async function loginModelAdmin(credentials: { username: string; password: string }) {
  modelAdminBusy.value = true; modelAdminError.value = ''
  try {
    await modelLibrary.login(credentials.username, credentials.password)
    modelAdminOpen.value = false
  } catch (e) { modelAdminError.value = e instanceof Error ? e.message : 'Не удалось войти' }
  finally { credentials.password = ''; modelAdminBusy.value = false }
}
async function logoutModelAdmin() {
  try { await modelLibrary.logout() }
  catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось завершить сеанс' }
}
function applyModels(value: VisualAssetProfile) { modelProfile.value = value; void loadModelLibrary() }
function releaseAssist() { assistPressedCodes.clear(); assistHeld.value = false }
function handleAssistKey(event: KeyboardEvent) {
  const code = event.code || ({ Control: 'ControlLeft', Alt: 'AltLeft', Shift: 'ShiftLeft', Meta: 'MetaLeft' } as Record<string, string>)[event.key] || ''
  if (event.type === 'keyup') {
    const wasHeld = assistPressedCodes.has(code)
    assistPressedCodes.delete(code); assistHeld.value = assistPressedCodes.size > 0
    if (wasHeld) { event.preventDefault(); event.stopImmediatePropagation() }
    return
  }
  if (!matchesAssistBinding(code, settings.value.bindings.assist, event)) return
  const editable = event.target instanceof HTMLElement && (event.target.isContentEditable || Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]')))
  if (view.value !== 'match' || bindingCapture.value || settingsOpen.value || gameMenuOpen.value || rulesOpen.value || appearanceOpen.value || modelNavigationBusy.value || editable) return
  // Assist wins over an unsaved conflicting game binding. A temporary overlap
  // must never turn an informational hold into a shot/camera action.
  event.preventDefault(); event.stopImmediatePropagation(); assistPressedCodes.add(code); assistHeld.value = true
}
function elevationWheel(event: WheelEvent) {
  if (inputIsSuspended() || !event.shiftKey || !canShoot.value || shotPhase.value === 'overview' || !event.deltaY) return
  event.preventDefault(); event.stopImmediatePropagation()
  changeHudAim({ ...aim.value, theta: Math.max(0, Math.min(60, aim.value.theta + (event.deltaY < 0 ? 1 : -1))) })
}
async function surrender() {
  if (!match.value || !isPlayer.value || match.value.status === 'finished' || busy.value) return
  resumeMatchOverlay()
  await sendCommand('surrender', {})
}
function captureBinding(event: KeyboardEvent | MouseEvent) {
  if (!bindingCapture.value) {
    if (event instanceof KeyboardEvent && event.code === 'Escape' && view.value === 'match' && !settingsOpen.value && !appearanceOpen.value && !modelNavigationBusy.value && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      if (surrenderConfirmation.value) surrenderConfirmation.value = false
      else if (rulesOpen.value) rulesOpen.value = false
      else if (gameMenuOpen.value) resumeMatchOverlay()
      else if (shotPhase.value !== 'overview') setShotPhase(shotPhase.value === 'power' ? 'aim' : 'overview')
      else openMatchMenu()
    }
    return
  }
  event.preventDefault(); event.stopImmediatePropagation()
  if (event instanceof KeyboardEvent && event.code === 'Escape') { bindingCapture.value = null; return }
  if (bindingCapture.value === 'assist' && (!(event instanceof KeyboardEvent) || !isAssistKeyboardBinding(event.code))) {
    bindingCaptureError.value = 'Для дополнительных приборов выберите клавишу клавиатуры. Esc — отмена.'
    return
  }
  const key = event instanceof KeyboardEvent ? event.code : `Mouse${event.button}`
  settings.value.bindings[bindingCapture.value] = key
  bindingCapture.value = null
}
async function copyCode() {
  const invitation = room.value?.code, identity = token, initialView = view.value
  if (!invitation) return
  const copied = await copyText(invitation)
  if (token !== identity || room.value?.code !== invitation || view.value !== initialView
    || settingsOpen.value || gameMenuOpen.value || rulesOpen.value || appearanceOpen.value || modelAdminOpen.value || modelNavigationBusy.value) return
  if (!copied) {
    const element = document.querySelector<HTMLElement>('[data-room-code]')
    if (element) {
      (element.closest<HTMLElement>('button') || element).focus({ preventScroll: true })
      const range = document.createRange(); range.selectNodeContents(element)
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    }
  }
  clipboardMessage.value = copied ? 'Код приглашения скопирован' : 'Браузер запретил копирование. Код выделен — нажмите Ctrl+C.'
  clearTimeout(clipboardMessageTimer)
  clipboardMessageTimer = window.setTimeout(() => { clipboardMessage.value = '' }, 4000)
}
function visibilityChanged() { releaseAssist(); telemetry('clientVisibility', { visible: document.visibilityState === 'visible' }); if (document.visibilityState === 'visible' && connected.value) void restoreMatch() }
onMounted(() => { void authenticate(); void loadModelLibrary(); window.addEventListener('keydown', captureBinding, true); window.addEventListener('mousedown', captureBinding, true); window.addEventListener('keydown', handleAssistKey, true); window.addEventListener('keyup', handleAssistKey, true); window.addEventListener('blur', releaseAssist); document.addEventListener('visibilitychange', visibilityChanged); window.addEventListener('online', connect) })
onBeforeUnmount(() => { disposed = true; vkPlayEntry?.dispose(); clearInterval(clock); clearInterval(polling); clearInterval(heartbeat); clearTimeout(reconnectTimer); clearTimeout(clipboardMessageTimer); socket?.close(); scene?.destroy(); window.removeEventListener('keydown', captureBinding, true); window.removeEventListener('mousedown', captureBinding, true); window.removeEventListener('keydown', handleAssistKey, true); window.removeEventListener('keyup', handleAssistKey, true); window.removeEventListener('blur', releaseAssist); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('online', connect) })
</script>

<template>
  <div class="app-shell club-app" :class="{ 'in-match': view === 'match' && match, 'in-workshop': view === 'models', 'match-overlay-open': matchOverlayOpen }">
    <div v-if="clipboardMessage" class="clipboard-feedback" role="status">{{ clipboardMessage }}</div>
    <header v-if="loading || !user" class="app-header">
      <button class="brand" :disabled="busy" @click="view = match ? 'match' : 'menu'">Pooltool Online</button>
      <span class="connection" :class="{ offline: !connected }" role="status">{{ connection }}</span>
      <span v-if="user">{{ user.displayName }} · Эло {{ user.elo }}</span>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }} <button @click="error = ''" aria-label="Закрыть ошибку">×</button></div>
    <div v-if="modelNavigationBusy" class="model-game-notice" role="status">Открываем мастерскую…</div>
    <main v-if="vkPlayLaunch && !user" class="panel" data-testid="vkplay-entry" :aria-busy="loading">
      <h1>Вход через VK Play</h1><p :role="vkPlayEntryState.phase === 'error' ? 'alert' : 'status'">{{ vkPlayEntryState.message }}</p>
      <button v-if="vkPlayEntryState.phase === 'login'" @click="vkPlayEntry?.continueEntry()">Войти через VK Play</button>
      <button v-else-if="vkPlayEntryState.phase === 'register'" @click="vkPlayEntry?.continueEntry()">Продолжить с VK Play</button>
      <button v-else-if="vkPlayEntryState.phase === 'error'" @click="authenticate()">Повторить вход</button>
    </main>
    <main v-else-if="loading" class="panel" aria-busy="true"><h1>Загрузка игры</h1><p>Подключаемся к серверу и восстанавливаем профиль.</p></main>
    <main v-else-if="!user" class="panel"><h1>Соединение недоступно</h1><p>Проверьте подключение и повторите попытку.</p><button @click="authenticate()">Повторить</button></main>
    <main v-else-if="view === 'models'" class="model-library-page">
      <div class="model-session-bar"><span>Общая библиотека · {{ modelLibrary.session.value.authenticated ? `Администратор: ${modelLibrary.session.value.username}` : 'Режим просмотра' }}</span><button v-if="modelLibrary.session.value.authenticated" @click="logoutModelAdmin">Выйти из админки</button><button v-else @click="modelAdminError = ''; modelAdminOpen = true">Вход администратора</button></div>
      <ModelWorkshop :library="modelLibrary.adapter" :can-manage="modelLibrary.session.value.authenticated" :initial-profile="modelProfile" @apply="applyModels" @request-admin="modelAdminError = ''; modelAdminOpen = true" @close="view = modelReturnView" />
    </main>
    <ClubMenu v-else-if="view !== 'match'" :view="view" :user="user" :room="room" :history="history" :busy="busy" :connected="connected" :connection="connection" :search-mode="searchMode" :rating-window="ratingWindow" :client-version="CLIENT_VERSION" :match-available="Boolean(match)" :profile-saved="profileSaved" :profile-changed="profileChanged" v-model:profile-details="profileDetails" v-model:code="code" v-model:name="name" v-model:turn-seconds="turnSeconds" v-model:bot-difficulty="botDifficulty" @navigate="navigate" @settings="settingsOpen = true" @models="openModels" @exit="leave()" @search="search" @cancel-search="cancelSearch()" @create-room="createRoom" @join-room="joinRoom" @ready="ready" @leave="leave(view === 'lobby' ? 'play' : 'menu')" @copy-code="copyCode" @play-bot="playBot" @save-name="saveName" />
    <main v-else-if="view === 'match' && match" class="match-screen figma-match-screen">
      <div class="stage-wrap">
        <div ref="stage" class="game-stage" aria-label="Игровой бильярдный стол" @wheel.capture="elevationWheel"></div>
        <div v-if="sceneInputSuspended && ownTurn && match.status === 'active' && !playbackBusy && !settingsOpen && !gameMenuOpen && !rulesOpen && !appearanceOpen && !hudPanelOpen" class="game-resume-notice" data-testid="game-input-resume" role="status"><span>Управление приостановлено. Параметры удара сохранены.</span><button type="button" @click="scene?.resumeInput()">Продолжить игру</button><small>Клик по столу также вернёт управление — без изменения удара.</small></div>
        <Transition name="toast"><div v-if="toast && !matchOverlayOpen" class="shot-toast" :class="toast.tone" role="status"><strong>{{ toast.title }}</strong><span v-for="line in toast.lines" :key="line">{{ line }}</span></div></Transition>
        <div v-if="(modelSceneLoading || modelSceneErrors.length) && !settingsOpen && !appearanceOpen && !gameMenuOpen" class="model-game-notice" role="status"><span v-if="modelSceneLoading">Загружаем оформление…</span><template v-else><span>Оформление не загрузилось — используется базовая геометрия.</span><small v-for="message in modelSceneErrors" :key="message">{{ message }}</small><button @click="applySceneModels">Повторить загрузку</button></template></div>
      </div>
      <MatchHud
        :match="match" :user="user" :room="room" :aim="aim" :phase="shotPhase"
        :can-shoot="canShoot && !sceneInputSuspended" :can-place="canPlace && !sceneInputSuspended"
        :can-reposition="!sceneInputSuspended && turnReady && Boolean(match.snapshot.ballInHand) && !match.snapshot.needsPlacement"
        :placing-cue="placingCue" :connected="connected" :connection="connection"
        :remaining="remaining" :elapsed="elapsed" :status-text="matchStatusText"
        :volume="settings.volume" :top-view-key="settings.bindings.topView || DEFAULT_BINDINGS.topView"
        :called-ball="calledBall" :called-pocket="calledPocket" :camera-mode="cameraMode"
        :show-assist="showAssist" :overlay="matchOverlayOpen"
        :assist-key-label="assistKeyLabel"
        @menu="openMatchMenu"
        @rules="rulesOpen = true" @camera="changeCamera" @aim="changeHudAim"
        @shoot="shoot()" @phase="changeHudPhase" @select-ball="selectBall" @select-pocket="selectPocket"
        @place-cue="toggleCuePlacement" @copy-code="copyCode" @panel-open="hudPanelOpen = $event"
        @toggle-assist="assistPinned = !assistPinned"
      />
      <div v-for="player in (matchOverlayOpen ? [] : offlinePlayers)" :key="player.name" class="offline-banner" role="alert">{{ isPlayer ? 'Соперник' : player.name }} отключился. Ждём переподключения: {{ player.seconds }} с, затем {{ isPlayer ? 'вам будет засчитана победа' : 'ему будет засчитано поражение' }}.</div>
      <div v-if="match.status === 'finished' && !ownSurrenderedMatchId && !matchOverlayOpen" class="result-panel"><h1>{{ !match.winnerId ? 'Матч прерван' : match.winnerId === user.id ? 'Вы победили' : isPlayer ? 'Вы проиграли' : `Победитель: ${winnerName}` }}</h1><p>{{ resultReason }}</p><p v-if="ratingChange">Рейтинг: {{ ratingChange.before }} → {{ ratingChange.after }} ({{ ratingChange.delta > 0 ? '+' : '' }}{{ ratingChange.delta }})</p><div class="result-actions"><button v-if="isSolo && isPlayer" :disabled="busy" @click="playBotAgain">Сыграть ещё</button><button :disabled="busy" @click="leave()">В главное меню</button><button @click="showProfile">История и рейтинг</button></div></div>
    </main>
    <MatchMenu v-if="gameMenuOpen && view === 'match' && match && user" :match="match" :room="room" :user-id="user.id" :confirmation="surrenderConfirmation" :busy="busy" :connected="connected" :version="CLIENT_VERSION" @resume="resumeMatchOverlay" @settings="openMatchSettings" @confirm="surrenderConfirmation = true" @cancel="surrenderConfirmation = false" @surrender="surrender" @leave="leave()" />
    <AccessibleDialog v-if="rulesOpen" title-id="rules-title" dialog-class="settings-dialog hud-rules-dialog" return-focus-selector=".hud-rules" @close="rulesOpen = false">
        <h1 id="rules-title">Правила 8-BALL</h1>
        <p>После распределения групп игрок забивает свои цельные или полосатые шары. Восьмёрку нужно забить после всех семи шаров своей группы. Заказывать шар и лузу не требуется, в том числе для восьмёрки.</p>
        <p>Выбор шара и лузы в параметрах удара необязателен и служит для отметки цели. Ошибочный первый контакт, падение битка и другие нарушения оценивает сервер; после фола биток ставится в разрешённой зоне.</p>
        <p>До первого ЛКМ наведите направление удара. Клик по свободному месту сцены фиксирует его и открывает выбор точки контакта кия с битком. Подтвердите точку таким же кликом — попадать по битку не нужно. Затем отдельно зажмите ЛКМ, оттяните кий вниз для выбора силы и отпустите кнопку для удара. Клики по прицельным шарам и лузам сохраняют выбор заказа. Правая кнопка возвращает на предыдущий этап.</p>
        <p>Удерживайте {{ assistKeyLabel }} для дополнительных приборов. Клавиша меняется в настройках управления. Shift + колесо меняет наклон кия. Альтернативное управление доступно в панели «Параметры удара». В рейтинговых матчах линия прицеливания принудительно отключена. Настройки и меню не останавливают таймер сетевой партии.</p>
        <button @click="rulesOpen = false">Закрыть правила</button>
    </AccessibleDialog>
    <ClubSettings v-if="settingsOpen" :settings="effectiveSettings" :binding-capture="bindingCapture" :binding-capture-error="bindingCaptureError" :capture-labels="captureLabels" :binding-conflicts="bindingConflicts" :aim-guide-locked="aimGuidePolicy.locked" :in-match="view === 'match'" :user="user" :client-version="CLIENT_VERSION" @update:settings="updateSettings" @capture="bindingCapture = $event" @reset="settings = defaults()" @save="saveSettings" @close="closeSettings" @home="settingsHome" @models="openModels" @appearance="openAppearance">
      <template #match-footer="{ tab, goToIndex }">
        <MatchOverlayFooter v-if="match" :page="tab" :status="match.status" :connected="connected" :version="CLIENT_VERSION" @resume="resumeMatchOverlay" @menu="openMatchMenu" @settings="goToIndex" />
      </template>
    </ClubSettings>
    <PlayerAppearance v-if="appearanceOpen" :library="modelCatalogue" :selection="playerAssets" :snapshot="match?.snapshot" :loading="modelCatalogueLoading" :error="modelCatalogueError" @apply="applyPlayerAssets" @close="closeAppearance" @retry="loadModelLibrary" @manage="openModels" />
    <ModelAdminLogin v-if="modelAdminOpen" :busy="modelAdminBusy" :error="modelAdminError" :configured="modelLibrary.session.value.configured" @submit="loginModelAdmin" @close="modelAdminOpen = false; modelAdminError = ''" />
  </div>
</template>
