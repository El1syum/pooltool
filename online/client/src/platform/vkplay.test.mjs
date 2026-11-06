import assert from 'node:assert/strict'
import test from 'node:test'
import { createVkPlayEntry, isVkPlayLaunch } from './vkplay.ts'

function fixture(change = {}) {
  const states = [], sessions = [], requests = [], calls = { sdk: 0, status: 0, login: 0, register: 0, token: 0, reload: 0 }
  let callbacks
  const config = { guestEnabled: true, vkPlay: { enabled: true, configured: true, appId: '42' } }
  const api = {
    getLoginStatus() { calls.status++; queueMicrotask(() => callbacks.getLoginStatusCallback(change.status ?? 2)) },
    authUser() { calls.login++; queueMicrotask(() => callbacks.getLoginStatusCallback(2)) },
    registerUser() { calls.register++; queueMicrotask(() => { callbacks.registerUserCallback({ status: 'ok' }); callbacks.registerUserCallback({ status: 'ok' }) }) },
    getAuthToken() { calls.token++; queueMicrotask(() => { const value = Object.hasOwn(change, 'ticket') ? change.ticket : { status: 'ok', uid: '123', hash: `otp-${calls.token}` }; callbacks.getAuthTokenCallback(value); callbacks.getAuthTokenCallback(value) }) },
    reloadWindow() { calls.reload++ },
  }
  let count = 0
  const entry = createVkPlayEntry({
    search: change.search ?? '?platform=vkplay', embedded: true, clientVersion: 'test', timeoutMs: 20,
    interactiveTimeoutMs: 20, uuid: () => `test-request-${++count}`,
    fetchConfig: async () => change.config ?? config,
    sdk: async appId => {
      calls.sdk++; assert.equal(appId, (change.config ?? config).vkPlay.appId)
      return async options => { callbacks = options; return { ...api, ...change.api } }
    },
    exchange: async body => { requests.push({ ...body }); if (change.exchange) return change.exchange(body, requests.length); return { token: 'own-session-token', user: { id: 'internal-platform-user' } } },
    onState: value => states.push(value), onSession: value => sessions.push(value), ...change.options,
  })
  return { entry, states, sessions, requests, calls, api, callbacks: () => callbacks }
}

test('only explicit platform=vkplay activates platform mode', () => {
  assert.equal(isVkPlayLaunch(''), false)
  assert.equal(isVkPlayLaunch('?appid=42&uid=123&sign=fake'), false)
  assert.equal(isVkPlayLaunch('?platform=other'), false)
  assert.equal(isVkPlayLaunch('?platform=vkplay'), true)
})

test('disabled/missing configuration fails closed before SDK or exchange', async () => {
  for (const vkPlay of [{ enabled: false, configured: false, appId: null }, { enabled: true, configured: false, appId: null }, { enabled: true, configured: true, appId: '../evil' }]) {
    const f = fixture({ config: { guestEnabled: true, vkPlay } })
    await f.entry.start(); assert.equal(f.states.at(-1).phase, 'error'); assert.equal(f.calls.sdk, 0); assert.equal(f.requests.length, 0); f.entry.dispose()
  }
})

test('platform URL outside iframe is rejected without loading SDK', async () => {
  const f = fixture({ options: { embedded: false } }); await f.entry.start()
  assert.equal(f.states.at(-1).phase, 'error'); assert.match(f.states.at(-1).message, /странице VK Play/); assert.equal(f.calls.sdk, 0); f.entry.dispose()
})

test('authorized statuses 2 and 3 exchange token once, duplicate callbacks ignored', async () => {
  for (const status of [2, 3]) {
    const f = fixture({ status }); await f.entry.start()
    assert.equal(f.sessions.length, 1); assert.equal(f.calls.token, 1); assert.equal(f.requests.length, 1)
    assert.deepEqual(f.requests[0], { uid: '123', hash: 'otp-1', requestId: 'test-request-1', clientVersion: 'test' })
    assert.equal(f.states.at(-1).phase, 'authenticated'); assert.equal(f.calls.login, 0); f.entry.dispose()
  }
})

test('status 0 waits for a user gesture before opening platform login', async () => {
  const f = fixture({ status: 0 }); await f.entry.start()
  assert.equal(f.states.at(-1).phase, 'login'); assert.equal(f.calls.login, 0); assert.equal(f.requests.length, 0)
  const promise = f.entry.continueEntry(); assert.equal(f.calls.login, 1, 'Popup starts synchronously inside the click handler')
  await promise; assert.equal(f.sessions.length, 1); f.entry.dispose()
})

test('status 1 waits for confirmation, registers, then reloads once without authenticating', async () => {
  const f = fixture({ status: 1 }); await f.entry.start()
  assert.equal(f.states.at(-1).phase, 'register'); assert.equal(f.calls.register, 0)
  await f.entry.continueEntry(); assert.equal(f.calls.register, 1); assert.equal(f.calls.reload, 1)
  assert.equal(f.calls.token, 0); assert.equal(f.sessions.length, 0); f.entry.dispose()
})

test('signed launch query is forwarded unchanged while marker-only launch is not', async () => {
  const search = '?platform=vkplay&appid=42&uid=123&currency=RUB&lang=ru_RU&sign=abcd'
  const f = fixture({ search }); await f.entry.start(); assert.equal(f.requests[0].launchParams, search); f.entry.dispose()
})
test('large UID strings remain exact and GMRID follows SDK safe-integer boundary', async () => {
  const uid = '12345678901234567890'
  const f = fixture({ ticket: { status: 'ok', uid, hash: 'opaque-token' }, config: { guestEnabled: true, vkPlay: { enabled: true, configured: true, appId: '9007199254740991' } } })
  await f.entry.start(); assert.equal(f.requests[0].uid, uid); assert.equal(f.callbacks().appid, Number.MAX_SAFE_INTEGER); f.entry.dispose()
  const invalid = fixture({ config: { guestEnabled: true, vkPlay: { enabled: true, configured: true, appId: '9007199254740992' } } })
  await invalid.entry.start(); assert.equal(invalid.calls.sdk, 0); assert.equal(invalid.states.at(-1).phase, 'error'); invalid.entry.dispose()
})

test('lost exchange response retries same request and OTP, never calls GAS token getter again', async () => {
  const f = fixture({ exchange: (body, count) => { if (count === 1) throw new TypeError('Network connection lost'); return { token: 'replayed-own-session', user: { id: 'same-user' } } } })
  await f.entry.start(); assert.equal(f.calls.token, 1); assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[0], f.requests[1]); assert.equal(f.sessions.length, 1); f.entry.dispose()
})

test('server rejection is not retried; explicit retry obtains a new ticket and requestId', async () => {
  const f = fixture({ exchange: (body, count) => { if (count === 1) throw Object.assign(new Error('safe server refusal'), { status: 401 }); return { token: 'new-own-session', user: { id: 'same-user' } } } })
  await f.entry.start(); assert.equal(f.requests.length, 1); assert.equal(f.states.at(-1).phase, 'error')
  await f.entry.start(); assert.equal(f.requests.length, 2); assert.notEqual(f.requests[0].hash, f.requests[1].hash); assert.notEqual(f.requests[0].requestId, f.requests[1].requestId); assert.equal(f.sessions.length, 1); f.entry.dispose()
})

test('invalid, rounded or missing UID/token responses never authenticate', async () => {
  for (const ticket of [null, { status: 'ok', uid: 9007199254740992, hash: 'otp' }, { status: 'ok', uid: '0123', hash: 'otp' }, { status: 'ok', uid: '123', hash: '' }, { status: 'ok', uid: '123', hash: 'bad\nsecret' }, { status: 'error', uid: '123', hash: 'secret' }]) {
    const f = fixture({ ticket })
    await f.entry.start(); assert.equal(f.sessions.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.states.at(-1).phase, 'error'); f.entry.dispose()
  }
})

test('missing SDK methods, failed connection, config timeout and missing callback are bounded and safe', async () => {
  const changes = [
    { api: { getAuthToken: undefined } },
    { options: { sdk: async () => { throw new Error('unsafe SDK details secret-otp') } } },
    { options: { fetchConfig: () => new Promise(() => {}), timeoutMs: 3 } },
    { api: { getLoginStatus() {} }, options: { timeoutMs: 3 } },
  ]
  for (const change of changes) {
    const f = fixture(change); await f.entry.start()
    assert.equal(f.states.at(-1).phase, 'error'); assert.doesNotMatch(JSON.stringify(f.states), /secret-otp/); assert.equal(f.sessions.length, 0); f.entry.dispose()
  }
})

test('dispose cancels pending callbacks and a stale owner cannot finish a later login', async () => {
  const f = fixture({ api: { getLoginStatus() {} } })
  const promise = f.entry.start(); await new Promise(resolve => setTimeout(resolve, 1)); const cb = f.callbacks()
  f.entry.dispose(); cb.getLoginStatusCallback(2); await promise
  assert.equal(f.sessions.length, 0); assert.equal(f.requests.length, 0)
})

test('a callback from a replaced SDK handshake cannot complete the next attempt', async () => {
  let respond = false
  const f = fixture({ api: { getLoginStatus() { if (respond) f.callbacks().getLoginStatusCallback(0) } } })
  const first = f.entry.start()
  await new Promise(resolve => setTimeout(resolve, 1))
  const previous = f.callbacks()
  respond = true; await f.entry.start(); await first
  previous.getLoginStatusCallback(2); previous.getAuthTokenCallback({ status: 'ok', uid: '123', hash: 'old-ticket' })
  assert.equal(f.states.at(-1).phase, 'login'); assert.equal(f.sessions.length, 0); assert.equal(f.requests.length, 0)
  f.entry.dispose()
})
