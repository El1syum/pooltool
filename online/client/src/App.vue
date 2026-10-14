<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ApiError, CLIENT_VERSION, post, request, setToken, socketUrl, timestamp } from './api'
import type { User, Room, Match, ShotResult } from './api'
import { createGameScene } from './game/createGameScene'
import { expandTrajectory, numberForPocket } from './game/playback'
import { DEFAULT_BINDINGS } from './game/types'
import type { AimState, BindingAction, GameScene, GameSettings } from './game/types'

type View = 'menu' | 'play' | 'lobby' | 'search' | 'match' | 'profile'
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
const turnReady = computed(() => Boolean(connected.value && ownTurn.value && match.value?.status === 'active' && !busy.value && !playbackBusy.value && !settingsOpen.value && !gameMenuOpen.value))
const canShoot = computed(() => turnReady.value && !match.value?.snapshot.needsPlacement && !placingCue.value)
const canPlace = computed(() => turnReady.value && Boolean(match.value?.snapshot.ballInHand) && (Boolean(match.value?.snapshot.needsPlacement) || placingCue.value))
const remaining = computed(() => Math.max(0, Math.ceil((timestamp(match.value?.deadline) - now.value - serverClockOffset.value) / 1000)))
const elapsed = computed(() => Math.max(0, Math.floor(((match.value?.finishedAt ? timestamp(match.value.finishedAt) : now.value + serverClockOffset.value) - timestamp(match.value?.startedAt)) / 1000)))
const isSolo = computed(() => Boolean(room.value?.settings.solo))
const botTurn = computed(() => Boolean(match.value && match.value.status === 'active' && match.value.players[match.value.currentPlayer]?.bot))
const currentPlayerName = computed(() => match.value?.players[match.value.currentPlayer]?.displayName || '—')
const winnerName = computed(() => match.value?.players.find((p) => p.id === match.value?.winnerId)?.displayName || 'Нет победителя')
const remainingBalls = computed(() => {
  const targets = match.value?.snapshot.hittable
  return match.value?.snapshot.balls.filter((b) => b.id !== 'cue' && !b.pocketed && (!Array.isArray(targets) || targets.includes(String(b.id)))) || []
})
const captureLabels: Record<BindingAction, string> = { aimLeft: 'Прицел влево', aimRight: 'Прицел вправо', powerUp: 'Увеличить силу', powerDown: 'Уменьшить силу', elevationUp: 'Поднять кий', elevationDown: 'Опустить кий', spinLeft: 'Вращение влево', spinRight: 'Вращение вправо', spinUp: 'Вращение вверх', spinDown: 'Вращение вниз', shoot: 'Удар', resetCamera: 'Сброс камеры', topView: 'Вид сверху', orbit: 'Вращать камеру' }
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
function formatTime(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
function groupLabel(group?: string) { return group === 'solids' ? 'Цельные' : group === 'stripes' ? 'Полосатые' : 'Группа не определена' }
function groupAt(index: number): string | undefined { const groups = match.value?.snapshot.groups; return Array.isArray(groups) ? groups[index] || undefined : undefined }
function groupBalls(index: number) { const group = groupAt(index); return match.value?.snapshot.balls.filter((ball) => { const id = Number(ball.id); return group === 'solids' ? id >= 1 && id <= 7 : group === 'stripes' ? id >= 9 && id <= 15 : id > 0 && id !== 8 }) || [] }
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
        if (message.matchId) void loadMatch(message.matchId)
      } else if (message.type === 'error') error.value = message.detail || message.message || 'Ошибка соединения'
    } catch { error.value = 'Сервер прислал некорректное сообщение' }
  }
  current.onclose = () => {
    if (current !== socket) return
    connected.value = false
    connection.value = 'Связь потеряна. Партия сохраняется на сервере.'
    clearInterval(heartbeat)
    telemetry('clientReconnect', { connected: false })
    if (!disposed) reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** reconnectAttempt++, 10_000))
  }
  current.onerror = () => current.close()
}
function receiveRoom(value: Room | null) {
  if (!value || departedRooms.has(value.code)) return
  room.value = value
  localStorage.setItem('pooltool.room', value.code)
  if (value.matchId) void loadMatch(value.matchId)
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
      const trajectory = expandTrajectory(shot.trajectory)
      void nextTick(() => { ensureScene(); scene?.setState(shot.initialState); scene?.playShot(trajectory, start) })
    } else if (!playbackBusy.value) scene?.setState(value.snapshot)
  } else if (!playbackBusy.value) scene?.setState(value.snapshot)
  updateInteraction()
  if (value.status === 'finished') { gameMenuOpen.value = false; void refreshUser() }
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
      onSelectPocket: (id) => { calledPocket.value = id; scene?.setCalledPocket(id) },
      onPlaybackComplete: () => { playbackBusy.value = false; if (match.value) scene?.setState(match.value.snapshot); updateInteraction() },
      onError: (message) => { error.value = message; telemetry('clientError', { message: message.slice(0, 500) }) },
      onPerformance: (stats) => { telemetry('clientPerformance', stats) },
    })
    scene.setSettings(settings.value)
    scene.setState(match.value.snapshot)
    scene.setAim(aim.value)
    updateInteraction()
  } catch (e) { error.value = e instanceof Error ? e.message : 'Не удалось открыть 3D-сцену' }
}
function updateInteraction() {
  const table = match.value?.snapshot.table
  scene?.setInteraction({ canShoot: canShoot.value, canPlaceCueBall: canPlace.value, spectator: !isPlayer.value,
    placementRegion: match.value?.snapshot.ballInHandRegion === 'behind_line' && table ? { minY: 0, maxY: table.length / 4 } : undefined })
}
watch(stage, () => { if (stage.value) ensureScene(); else { scene?.destroy(); scene = null; playbackBusy.value = false } }, { flush: 'post' })
watch([canShoot, canPlace, isPlayer], updateInteraction)
watch(settings, () => { scene?.setSettings(settings.value); if (user.value) { localStorage.setItem(`pooltool.settings.${user.value.id}`, JSON.stringify(settings.value)); settingsDirty.value = true } }, { deep: true })
function updateAim() { scene?.setAim(aim.value) }
async function sendCommand(type: string, payload: Record<string, unknown>) {
  if (!match.value || !isPlayer.value || busy.value) return
  const command = { commandId: uuid(), expectedRevision: match.value.revision, type, payload }
  const pending = { matchId: match.value.id, command }
  localStorage.setItem('pooltool.pendingCommand', JSON.stringify(pending))
  await perform(async () => {
    try {
      const response = await post<{ match: Match; result?: ShotResult }>(`/api/matches/${match.value!.id}/commands`, command)
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
async function shoot(value = aim.value) {
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
    room.value = null; match.value = null; lastPlayedShot = ''; gameMenuOpen.value = false; placingCue.value = false; view.value = 'menu'
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
function captureBinding(event: KeyboardEvent | MouseEvent) {
  if (!bindingCapture.value) {
    if (event instanceof KeyboardEvent && event.code === 'Escape' && view.value === 'match' && !settingsOpen.value && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault(); gameMenuOpen.value = !gameMenuOpen.value
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
function visibilityChanged() { telemetry('clientVisibility', { visible: document.visibilityState === 'visible' }); if (document.visibilityState === 'visible' && connected.value) void restoreMatch() }
onMounted(() => { void authenticate(); window.addEventListener('keydown', captureBinding, true); window.addEventListener('mousedown', captureBinding, true); document.addEventListener('visibilitychange', visibilityChanged); window.addEventListener('online', connect) })
onBeforeUnmount(() => { disposed = true; clearInterval(clock); clearInterval(polling); clearInterval(heartbeat); clearTimeout(reconnectTimer); socket?.close(); scene?.destroy(); window.removeEventListener('keydown', captureBinding, true); window.removeEventListener('mousedown', captureBinding, true); document.removeEventListener('visibilitychange', visibilityChanged); window.removeEventListener('online', connect) })
</script>

<template>
  <div class="app-shell" :class="{ 'in-match': view === 'match' && match }">
    <header class="app-header">
      <button class="brand" :disabled="busy" @click="view = match ? 'match' : 'menu'">Pooltool Online</button>
      <span class="connection" :class="{ offline: !connected }" role="status">{{ connection }}</span>
      <span v-if="user">{{ user.displayName }} · Эло {{ user.elo }}</span>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }} <button @click="error = ''" aria-label="Закрыть ошибку">×</button></div>
    <main v-if="loading" class="panel" aria-busy="true"><h1>Загрузка игры</h1><p>Подключаемся к серверу и восстанавливаем профиль.</p></main>
    <main v-else-if="!user" class="panel"><h1>Соединение недоступно</h1><p>Проверьте подключение и повторите попытку.</p><button @click="authenticate">Повторить</button></main>
    <main v-else-if="view === 'menu'" class="panel menu">
      <h1>Бильярд по сети</h1><p>8-ball для двух игроков. Физика и правила рассчитываются на сервере.</p>
      <button :disabled="busy || !connected" @click="view = 'play'">Играть</button>
      <button :disabled="busy" @click="settingsOpen = true">Настройки</button>
      <button :disabled="busy" @click="showProfile">Профиль</button>
      <button v-if="match" :disabled="busy" @click="view = 'match'">Вернуться в матч</button>
      <button v-if="room && (!match || match.status === 'finished')" :disabled="busy" @click="leave">Выйти из комнаты</button>
    </main>
    <main v-else-if="view === 'play'" class="panel">
      <h1>Выбор игры</h1><div class="button-row"><button :disabled="busy || !connected" @click="search('casual')">Случайный противник</button><button :disabled="busy || !connected" @click="search('ranked')">Рейтинговая игра</button></div>
      <section><h2>Игра с ботом</h2><label>Сложность <select v-model="botDifficulty"><option value="easy">Лёгкий</option><option value="medium">Средний</option><option value="hard">Сильный</option></select></label><button :disabled="busy || !connected" @click="playBot">Играть с ботом</button></section>
      <section><h2>Игра с другом</h2><label>Время на ход <select v-model.number="turnSeconds"><option :value="30">30 секунд</option><option :value="60">60 секунд</option><option :value="90">90 секунд</option><option :value="120">120 секунд</option></select></label><button :disabled="busy || !connected" @click="createRoom">Создать комнату</button></section>
      <section><label>Код комнаты <input v-model="code" maxlength="12" autocomplete="off" @keyup.enter="joinRoom(false)" /></label><div class="button-row"><button :disabled="busy || !connected" @click="joinRoom(false)">Присоединиться</button><button :disabled="busy || !connected" @click="joinRoom(true)">Наблюдать матч</button></div></section>
      <button :disabled="busy" @click="view = 'menu'">Назад</button>
    </main>
    <main v-else-if="view === 'search'" class="panel"><h1>{{ searchMode === 'ranked' ? 'Поиск соперника по рейтингу' : 'Поиск соперника' }}</h1><p>Ожидаем второго игрока. Матч откроется автоматически.</p><button :disabled="busy" @click="cancelSearch">Отменить поиск</button></main>
    <main v-else-if="view === 'lobby' && room" class="panel">
      <h1>Комната {{ room.code }}</h1><button @click="copyCode">Скопировать код приглашения</button><p>Время на ход: {{ room.settings.turnSeconds }} секунд</p>
      <ul class="player-list"><li v-for="player in room.players" :key="player.id">{{ player.displayName }} <span>{{ player.ready ? 'Готов' : 'Не готов' }}</span></li><li v-if="room.players.length < 2">Ждём второго игрока</li></ul>
      <p>Матч начнётся, когда оба игрока подтвердят готовность.</p><div class="button-row"><button :disabled="busy || !connected" @click="ready">{{ room.players.find(p => p.id === user?.id)?.ready ? 'Отменить готовность' : 'Готов' }}</button><button :disabled="busy" @click="leave">Выйти из комнаты</button></div>
    </main>
    <main v-else-if="view === 'profile'" class="panel">
      <h1>Профиль</h1><label>Имя игрока <input v-model="name" maxlength="32" /></label><button :disabled="busy || !name.trim()" @click="saveName">Сохранить имя</button>
      <p>Рейтинг: {{ user.elo }} · Матчей: {{ user.games }} · Побед: {{ user.wins }} · Поражений: {{ user.losses }}</p>
      <h2>История матчей</h2><p v-if="!history.length">Пока нет завершённых матчей.</p><ul class="history-list"><li v-for="item in history" :key="String(item.id || item.matchId)"><span>{{ new Date(timestamp(item.finishedAt as string || item.startedAt as string)).toLocaleString('ru-RU') }}</span><span>{{ item.opponentName ? `против ${item.opponentName}` : '' }}</span><span>{{ item.mode === 'ranked' || item.ranked ? 'Рейтинговый' : 'Обычный' }}</span><span>{{ item.winnerId === user.id ? 'Победа' : item.winnerId ? 'Поражение' : 'Матч завершён' }}</span><span v-if="item.eloDelta != null">Эло {{ Number(item.eloDelta) > 0 ? '+' : '' }}{{ item.eloDelta }}</span></li></ul><button @click="view = 'menu'">Назад</button>
    </main>
    <main v-else-if="view === 'match' && match" class="match-screen">
      <div class="match-bar"><div v-for="(player, index) in match.players" :key="player.id" :class="{ current: index === match.currentPlayer && match.status !== 'finished' }"><strong>{{ player.displayName }}</strong><span>{{ groupLabel(groupAt(index)) }} · Осталось {{ groupBalls(index).filter(ball => !ball.pocketed).length }}</span><span class="ball-indicators"><i v-for="ball in groupBalls(index)" :key="ball.id" :class="{ pocketed: ball.pocketed }">{{ ball.id }}</i></span></div><span>Матч {{ formatTime(elapsed) }}</span><span>Ход {{ remaining }} с</span><button @click="gameMenuOpen = true">Меню</button><button @click="settingsOpen = true">Настройки</button><button v-if="isPlayer && match.status !== 'finished'" :disabled="busy" @click="sendCommand('surrender', {})">Сдаться</button><button v-else @click="leave">Выйти</button></div>
      <div class="match-status" role="status">{{ match.status === 'finished' ? `Матч завершён. ${winnerName}` : match.status === 'calculating' || busy ? 'Сервер рассчитывает удар' : playbackBusy ? 'Воспроизведение удара' : !isPlayer ? `Наблюдение. Ходит ${currentPlayerName}` : ownTurn ? 'Ваш ход' : botTurn ? `${currentPlayerName} думает…` : `Ходит ${currentPlayerName}` }}<span v-if="canPlace"> · Установите биток кликом по столу</span></div>
      <div v-for="player in offlinePlayers" :key="player.name" class="offline-banner" role="alert">{{ isPlayer ? 'Соперник' : player.name }} отключился. Ждём переподключения: {{ player.seconds }} с, затем {{ isPlayer ? 'вам будет засчитана победа' : 'ему будет засчитано поражение' }}.</div>
      <div ref="stage" class="game-stage" aria-label="Игровой бильярдный стол"></div>
      <div v-if="match.status !== 'finished'" class="shot-controls">
        <label>Направление {{ aim.phi.toFixed(1) }}°<input v-model.number="aim.phi" type="range" min="0" max="359.9" step="0.1" :disabled="!canShoot" @input="updateAim" /></label>
        <label>Сила {{ aim.V0.toFixed(1) }} м/с<input v-model.number="aim.V0" type="range" min="0.2" max="8" step="0.1" :disabled="!canShoot" @input="updateAim" /></label>
        <label>Наклон {{ aim.theta }}°<input v-model.number="aim.theta" type="range" min="0" max="60" step="1" :disabled="!canShoot" @input="updateAim" /></label>
        <label>Вращение X<input v-model.number="aim.a" type="range" min="-0.6" max="0.6" step="0.02" :disabled="!canShoot" @input="updateAim" /></label><label>Вращение Y<input v-model.number="aim.b" type="range" min="-0.6" max="0.6" step="0.02" :disabled="!canShoot" @input="updateAim" /></label>
        <label>Заказанный шар<select v-model="calledBall" :disabled="!canShoot"><option value="">Без заказа</option><option v-for="ball in remainingBalls" :key="ball.id" :value="String(ball.id)">{{ ball.id }}</option></select></label>
        <label>Заказанная луза<select v-model="calledPocket" :disabled="!canShoot" @change="scene?.setCalledPocket(calledPocket || null)"><option value="">Без заказа</option><option v-for="(pocket, i) in match.snapshot.table.pockets" :key="pocket.id" :value="String(pocket.id)">Луза {{ numberForPocket(String(pocket.id), i) }}</option></select></label>
        <button class="shoot" :disabled="!canShoot || canPlace" @click="shoot()">Удар</button><button @click="scene?.resetCamera(true)">Вид сверху</button>
        <button v-if="turnReady && match.snapshot.ballInHand && !match.snapshot.needsPlacement" @click="placingCue = !placingCue">{{ placingCue ? 'Отменить перестановку' : 'Переставить биток' }}</button>
      </div>
      <div v-else class="result-panel"><h1>{{ !match.winnerId ? 'Матч прерван' : match.winnerId === user.id ? 'Вы победили' : isPlayer ? 'Вы проиграли' : `Победитель: ${winnerName}` }}</h1><p>{{ resultReason }}</p><p v-if="ratingChange">Рейтинг: {{ ratingChange.before }} → {{ ratingChange.after }} ({{ ratingChange.delta > 0 ? '+' : '' }}{{ ratingChange.delta }})</p><button v-if="isSolo && isPlayer" :disabled="busy" @click="playBotAgain">Сыграть ещё</button><button :disabled="busy" @click="leave">В главное меню</button><button @click="showProfile">История и рейтинг</button></div>
    </main>
    <div v-if="gameMenuOpen" class="modal-backdrop" @click.self="gameMenuOpen = false">
      <section class="settings-dialog menu" role="dialog" aria-modal="true" aria-labelledby="game-menu-title">
        <h1 id="game-menu-title">Меню матча</h1><p>Таймер сетевого матча продолжает идти.</p>
        <button @click="gameMenuOpen = false">Вернуться в игру</button><button @click="gameMenuOpen = false; settingsOpen = true">Настройки</button>
        <button v-if="isPlayer && match?.status !== 'finished'" :disabled="busy" @click="gameMenuOpen = false; sendCommand('surrender', {})">Сдаться</button><button v-else :disabled="busy" @click="leave">В главное меню</button>
      </section>
    </div>
    <div v-if="settingsOpen" class="modal-backdrop" @click.self="saveSettings">
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h1 id="settings-title">Настройки</h1><p v-if="match?.status === 'active'">В сетевой игре таймер хода продолжает идти.</p>
        <label>Качество графики<select v-model="settings.quality"><option value="low">Низкое</option><option value="medium">Среднее</option><option value="high">Высокое</option></select></label><label>Громкость<input v-model.number="settings.volume" type="range" min="0" max="1" step="0.05" /></label><label>Чувствительность прицела<input v-model.number="settings.sensitivity" type="range" min="0.1" max="3" step="0.1" /></label><label><input v-model="settings.showAimGuide" type="checkbox" /> Показывать прицел</label><label><input v-model="settings.showPocketLabels" type="checkbox" /> Показывать номера луз</label>
        <h2>Управление</h2><p>Нажмите назначение, затем клавишу или кнопку мыши. Escape отменяет ввод.</p><div class="binding-grid"><label v-for="(title, action) in captureLabels" :key="action"><span>{{ title }}</span><button @click="bindingCapture = action">{{ bindingCapture === action ? 'Ожидаем нажатие…' : settings.bindings[action] }}</button></label></div>
        <p v-for="conflict in bindingConflicts" :key="conflict" class="warning">Конфликт: {{ conflict }}</p><div class="button-row"><button @click="settings = defaults()">Сбросить настройки</button><button :disabled="bindingConflicts.length > 0" @click="saveSettings">Сохранить и закрыть</button><button @click="settingsOpen = false; bindingCapture = null">Закрыть</button></div>
      </section>
    </div>
    <footer v-if="view !== 'match'">Pooltool {{ CLIENT_VERSION }}</footer>
  </div>
</template>
