/** VK Play is opt-in per launch. Ordinary test URLs never load its SDK. */
export function isVkPlayLaunch(search: string): boolean {
  return new URLSearchParams(search).get('platform') === 'vkplay'
}

export interface VkPlayConfig { guestEnabled: boolean; vkPlay: { enabled: boolean; configured: boolean; appId: string | null } }
export interface VkPlayExchange {
  uid: string
  hash: string
  requestId: string
  launchParams?: string
  clientVersion: string
}
export interface VkPlaySession<T> { token: string; user: T }
export interface VkPlayEntryState {
  phase: 'loading' | 'login' | 'register' | 'error' | 'authenticated'
  message: string
}
interface VkPlayApi {
  getLoginStatus: () => unknown
  authUser: () => unknown
  registerUser: () => unknown
  getAuthToken: () => unknown
  reloadWindow: () => unknown
}
type CallbackOptions = Record<string, unknown> & { appid: number }
export type VkPlaySdkFactory = (options: CallbackOptions) => Promise<VkPlayApi>
declare global { interface Window { iframeApi?: VkPlaySdkFactory } }

class EntryError extends Error {}
let sdkLoad: { appId: string; promise: Promise<VkPlaySdkFactory> } | null = null

function loadSdk(appId: string): Promise<VkPlaySdkFactory> {
  if (sdkLoad) {
    if (sdkLoad.appId !== appId) return Promise.reject(new EntryError('Открыто другое приложение VK Play. Перезагрузите страницу.'))
    return sdkLoad.promise
  }
  const promise = new Promise<VkPlaySdkFactory>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://vkplay.ru/app/${appId}/static/mailru.core.js`
    script.async = true
    script.referrerPolicy = 'no-referrer'
    const timeout = window.setTimeout(() => finish(false), 15_000)
    function finish(ok: boolean) {
      clearTimeout(timeout); script.onload = null; script.onerror = null
      if (ok && typeof window.iframeApi === 'function') resolve(window.iframeApi)
      else { script.remove(); reject(new EntryError('Не удалось загрузить API VK Play. Повторите вход.')) }
    }
    script.onload = () => finish(true)
    script.onerror = () => finish(false)
    document.head.append(script)
  })
  sdkLoad = { appId, promise }
  void promise.catch(() => { if (sdkLoad?.promise === promise) sdkLoad = null })
  return promise
}

function requestId(): string {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function networkFailure(failure: unknown): boolean {
  return failure instanceof TypeError || (failure instanceof Error && ['NetworkError', 'AbortError'].includes(failure.name))
}

/** No launch credentials or session tokens are persisted or sent to telemetry. */
export function createVkPlayEntry<T>(options: {
  search: string
  embedded: boolean
  clientVersion: string
  fetchConfig: () => Promise<VkPlayConfig>
  exchange: (body: VkPlayExchange) => Promise<VkPlaySession<T>>
  onState: (state: VkPlayEntryState) => void
  onSession: (session: VkPlaySession<T>) => void
  sdk?: (appId: string) => Promise<VkPlaySdkFactory>
  timeoutMs?: number
  interactiveTimeoutMs?: number
  uuid?: () => string
}) {
  const timeout = options.timeoutMs ?? 15_000
  let state: VkPlayEntryState = { phase: 'loading', message: 'Подключаемся к VK Play…' }
  let generation = 0, disposed = false, api: VkPlayApi | null = null
  let pending: { kind: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  function set(phase: VkPlayEntryState['phase'], message: string) {
    if (!disposed) { state = { phase, message }; options.onState({ ...state }) }
  }
  function clearPending() {
    if (pending) { const old = pending; pending = null; clearTimeout(old.timer); old.reject(new EntryError('Запрос VK Play отменён.')) }
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null }
  }
  function deliver(kind: string, value: unknown, owner: number) {
    if (disposed || owner !== generation || !pending || pending.kind !== kind) return
    const current = pending; pending = null; clearTimeout(current.timer); current.resolve(value)
  }
  function callback(kind: string, invoke: () => unknown, duration = timeout): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (pending) { reject(new EntryError('Дождитесь ответа VK Play.')); return }
      pending = { kind, resolve, reject, timer: setTimeout(() => {
        pending = null; reject(new EntryError('VK Play не ответил вовремя. Повторите вход.'))
      }, duration) }
      try { invoke() } catch { const old = pending; pending = null; if (old) clearTimeout(old.timer); reject(new EntryError('Не удалось вызвать API VK Play. Повторите вход.')) }
    })
  }
  async function bounded<V>(promise: Promise<V>): Promise<V> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([promise, new Promise<V>((_, reject) => { timer = setTimeout(() => reject(new EntryError('VK Play не ответил вовремя. Повторите вход.')), timeout) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  function failure(value: unknown, owner: number) {
    if (owner !== generation || disposed) return
    clearPending()
    set('error', value instanceof EntryError ? value.message : 'Не удалось проверить вход через VK Play. Повторите вход; гостевой аккаунт не используется.')
  }
  async function acceptStatus(value: unknown, owner: number) {
    if (disposed || owner !== generation) return
    const status = typeof value === 'number' ? value : null
    if (status === 0) { set('login', 'Войдите в аккаунт VK Play в окне платформы.'); return }
    if (status === 1) { set('register', 'Подтвердите первый запуск Pooltool через VK Play.'); return }
    if (status !== 2 && status !== 3) throw new EntryError('VK Play вернул неизвестный статус входа. Повторите вход.')
    set('loading', 'Проверяем аккаунт VK Play на игровом сервере…')
    const token = await callback('token', () => api!.getAuthToken())
    if (owner !== generation || disposed) return
    if (!token || typeof token !== 'object') throw new EntryError('VK Play не выдал токен входа. Повторите вход.')
    const data = token as Record<string, unknown>, uid = String(data.uid ?? '')
    if (data.status !== 'ok' || (typeof data.uid === 'number' && !Number.isSafeInteger(data.uid)) || !/^[1-9]\d{0,19}$/.test(uid) || typeof data.hash !== 'string' || !data.hash || data.hash.length > 2048 || /[^\x21-\x7e]/.test(data.hash)) throw new EntryError('VK Play не выдал корректный токен входа. Повторите вход.')
    const params = new URLSearchParams(options.search)
    const body: VkPlayExchange = { uid, hash: data.hash, requestId: (options.uuid ?? requestId)(), clientVersion: options.clientVersion }
    if (['appid', 'uid', 'sign'].some(key => params.has(key))) body.launchParams = options.search
    let session: VkPlaySession<T>
    try { session = await options.exchange(body) }
    catch (error) {
      // Only replay our OWN exchange request after a lost network response.
      // The server's requestId cache prevents a second GAS check of this OTP.
      if (!networkFailure(error) || owner !== generation || disposed) throw error
      session = await options.exchange(body)
    }
    if (owner !== generation || disposed) return
    if (!session || typeof session.token !== 'string' || !session.token || !session.user) throw new EntryError('Игровой сервер не подтвердил вход VK Play. Повторите вход.')
    options.onSession(session)
    set('authenticated', 'Вход через VK Play подтверждён.')
  }
  async function start() {
    if (disposed) return
    const owner = ++generation
    clearPending(); api = null
    set('loading', 'Подключаемся к VK Play…')
    try {
      const config = await bounded(options.fetchConfig())
      if (owner !== generation || disposed) return
      if (!config?.vkPlay?.enabled) throw new EntryError('Авторизация VK Play пока отключена. Тестовая версия доступна по обычной ссылке без platform=vkplay.')
      if (!config.vkPlay.configured || !config.vkPlay.appId || !/^[1-9]\d{0,19}$/.test(config.vkPlay.appId) || !Number.isSafeInteger(Number(config.vkPlay.appId))) throw new EntryError('Авторизация VK Play ещё не настроена: GMRID и секрет будут подключены позже.')
      if (!options.embedded) throw new EntryError('Откройте игру на странице VK Play. Эта ссылка предназначена для запуска внутри платформы.')
      const factory = await bounded((options.sdk ?? loadSdk)(config.vkPlay.appId))
      if (owner !== generation || disposed) return
      const noop = () => {}
      const callbacks: CallbackOptions = {
        appid: Number(config.vkPlay.appId),
        getLoginStatusCallback: (value: unknown) => deliver('status', value, owner),
        getAuthTokenCallback: (value: unknown) => deliver('token', value, owner),
        registerUserCallback: (value: unknown) => deliver('register', value, owner),
        userInfoCallback: noop, userProfileCallback: noop, paymentFrameUrlCallback: noop,
        paymentReceivedCallback: noop, paymentWindowClosedCallback: noop, userConfirmCallback: noop,
        paymentFrameItem: noop, getGameInventoryItems: noop,
      }
      const connected = await bounded(Promise.resolve(factory(callbacks)))
      if (owner !== generation || disposed) return
      if (!connected || ['getLoginStatus', 'getAuthToken', 'authUser', 'registerUser', 'reloadWindow'].some(method => typeof connected[method as keyof VkPlayApi] !== 'function')) throw new EntryError('Не удалось подключить API VK Play. Повторите вход.')
      api = connected
      await acceptStatus(await callback('status', () => api!.getLoginStatus()), owner)
    } catch (error) { failure(error, owner) }
  }
  async function continueEntry() {
    if (disposed || !api || !['login', 'register'].includes(state.phase)) return
    const owner = generation, phase = state.phase
    set('loading', phase === 'login' ? 'Завершите вход в окне VK Play…' : 'Регистрируем Pooltool в аккаунте VK Play…')
    try {
      if (phase === 'login') {
        await acceptStatus(await callback('status', () => api!.authUser(), options.interactiveTimeoutMs ?? 120_000), owner)
      } else {
        const info = await callback('register', () => api!.registerUser(), options.interactiveTimeoutMs ?? 120_000)
        if (owner !== generation || disposed) return
        if (info && typeof info === 'object' && (info as Record<string, unknown>).status === 'error') throw new EntryError('VK Play не подтвердил регистрацию в игре. Повторите вход.')
        set('loading', 'Регистрация завершена. Перезагружаем игру через VK Play…')
        api!.reloadWindow()
        reloadTimer = setTimeout(() => failure(new EntryError('Перезагрузка VK Play не завершилась. Повторите вход.'), owner), timeout)
      }
    } catch (error) { failure(error, owner) }
  }
  function dispose() { disposed = true; generation++; clearPending(); api = null }
  return { start, continueEntry, dispose }
}
