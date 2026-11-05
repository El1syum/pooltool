import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
let server, createLibrary, Login
const originalFetch = globalThis.fetch
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
  createLibrary = (await server.ssrLoadModule('/src/models/serverLibrary.ts')).createServerModelLibrary
  Login = (await server.ssrLoadModule('/src/components/ModelAdminLogin.vue')).default
})
afterEach(() => { globalThis.fetch = originalFetch })
after(async () => { await server?.close() })
const config = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], replaceProcedural: true, material: {}, materials: {}, hiddenNodes: [] }
const asset = { id: 'a', name: 'Стол', role: 'table', url: '/api/assets/files/a.glb', bytes: 100, enabled: true, config }
const snapshot = version => ({ version, assets: [asset], profile: { tableId: 'a', environmentId: null } })
const auth = { authenticated: true, configured: true, username: 'operator', csrfToken: 'csrf-test-token', expiresAt: '2099-11-03T18:00:00Z' }
function mock(responses) {
  const calls = []
  globalThis.fetch = async (path, options) => { calls.push({ path, options }); const item = responses.shift(); assert.ok(item, `Unexpected request: ${path}`); return new Response(JSON.stringify(item.body), { status: item.status || 200, headers: { 'Content-Type': 'application/json' } }) }
  return calls
}
test('public reads have no admin header or disabled asset request', async () => {
  const calls = mock([{ body: snapshot(7) }])
  const service = createLibrary()
  assert.equal((await service.adapter.load()).version, 7)
  assert.equal(calls[0].path, '/api/assets/library')
  assert.equal(calls[0].options.credentials, 'same-origin')
  assert.equal(calls[0].options.headers['X-Asset-CSRF'], undefined)
})
test('login and authenticated library mutations follow cookie + CSRF API and optimistic versions', async () => {
  const calls = mock([{ body: { authenticated: false, configured: true } }, { body: auth }, { body: snapshot(7) }, { body: { asset, version: 8 } }, { body: { asset, version: 9 } }, { body: snapshot(10) }, { body: { asset: { ...asset, enabled: false }, version: 11 } }, { body: { authenticated: false } }])
  const service = createLibrary()
  await service.refreshSession()
  assert.equal(service.session.value.configured, true)
  await service.login(' operator ', 'unique-password')
  assert.equal(service.session.value.authenticated, true)
  await service.adapter.load()
  const file = new File([new Uint8Array([1, 2, 3])], 'Тест & стол.glb', { type: 'model/gltf-binary' })
  assert.equal((await service.adapter.upload(file, 'table')).asset.id, 'a')
  await service.adapter.update('a/unsafe', { name: 'Готовый стол', config })
  await service.adapter.publish({ tableId: 'a', environmentId: null }, { a: config })
  await service.adapter.remove('a')
  await service.logout()
  assert.equal(service.session.value.authenticated, false)
  assert.equal(service.session.value.csrfToken, undefined)
  assert.deepEqual(JSON.parse(calls[1].options.body), { username: 'operator', password: 'unique-password' })
  assert.equal(calls[2].path, '/api/assets/library?includeDisabled=true')
  const upload = calls[3]
  assert.equal(upload.options.body, file)
  assert.equal(upload.options.headers['Content-Type'], 'model/gltf-binary')
  assert.equal(new URL(upload.path, 'http://test').searchParams.get('name'), 'Тест & стол.glb')
  assert.equal(new URL(upload.path, 'http://test').searchParams.get('role'), 'table')
  assert.equal(new URL(upload.path, 'http://test').searchParams.get('expectedVersion'), '7')
  assert.equal(calls[4].path, '/api/assets/models/a%2Funsafe')
  assert.equal(JSON.parse(calls[4].options.body).expectedVersion, 8)
  assert.equal(JSON.parse(calls[5].options.body).expectedVersion, 9)
  assert.equal(calls[6].options.method, 'DELETE')
  assert.equal(new URL(calls[6].path, 'http://test').searchParams.get('expectedVersion'), '10')
  for (const call of calls.slice(3)) { assert.equal(call.options.headers['X-Asset-CSRF'], auth.csrfToken); assert.equal(call.options.credentials, 'same-origin') }
})
test('unauthenticated mutations fail before any model write', async () => {
  const calls = mock([{ body: { authenticated: false, configured: false } }])
  const service = createLibrary()
  await assert.rejects(service.adapter.remove('a'), failure => failure.status === 401)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, '/api/assets/admin/session')
})
test('expired admin library read falls back to public without exposing disabled entries', async () => {
  const calls = mock([{ body: auth }, { status: 401, body: { detail: 'Сессия истекла' } }, { body: snapshot(4) }])
  const service = createLibrary()
  await service.refreshSession()
  await service.adapter.load()
  assert.equal(service.session.value.authenticated, false)
  assert.equal(calls[2].path, '/api/assets/library')
})
test('validation failures are readable and conflicts are never silently retried', async () => {
  const calls = mock([{ body: auth }, { body: snapshot(1) }, { status: 409, body: { detail: 'Библиотека обновилась. Обновите данные.' } }])
  const service = createLibrary()
  await service.refreshSession(); await service.adapter.load()
  await assert.rejects(service.adapter.publish({ tableId: null, environmentId: null }, {}), failure => failure.status === 409 && failure.message.includes('обновилась'))
  assert.equal(calls.length, 3)
})
test('draft revision survives newer background reads and guards uploads against stale writes', async () => {
  const calls = mock([{ body: auth }, { body: snapshot(1) }, { body: snapshot(9) }, { status: 409, body: { detail: 'Библиотека изменилась' } }])
  const service = createLibrary()
  await service.refreshSession()
  const baseline = await service.adapter.load()
  await service.adapter.load()
  await assert.rejects(service.adapter.upload(new File([new Uint8Array([1])], 'env.glb'), 'environment', { expectedVersion: baseline.version }), failure => failure.status === 409)
  assert.equal(new URL(calls[3].path, 'http://test').searchParams.get('expectedVersion'), '1')
  assert.equal(calls.length, 4, 'A stale upload is never silently retried with a new revision')
})
test('explicit draft versions and names are sent unchanged for atomic publication and edits', async () => {
  const calls = mock([{ body: auth }, { body: snapshot(9) }, { body: { asset, version: 3 } }, { body: snapshot(4) }, { body: { asset, version: 5 } }])
  const service = createLibrary()
  await service.refreshSession(); await service.adapter.load()
  const updated = await service.adapter.update('a', { config }, { expectedVersion: 2 })
  assert.equal(updated.version, 3)
  await service.adapter.publish({ tableId: 'a', environmentId: null }, { a: config }, { expectedVersion: updated.version, names: { a: 'Новое имя' } })
  await service.adapter.remove('a', { expectedVersion: 4 })
  assert.equal(JSON.parse(calls[2].options.body).expectedVersion, 2)
  assert.deepEqual(JSON.parse(calls[3].options.body), { tableId: 'a', environmentId: null, configs: { a: config }, names: { a: 'Новое имя' }, expectedVersion: 3 })
  assert.equal(new URL(calls[4].path, 'http://test').searchParams.get('expectedVersion'), '4')
})
test('admin login dialog is accessible and fails closed when unconfigured', async () => {
  const render = props => renderToString(createSSRApp(Login, props))
  const available = await render({ busy: false, configured: true, error: '' })
  assert.match(available, /role="dialog" aria-modal="true"/)
  assert.match(available, /type="password" autocomplete="current-password"/)
  assert.match(available, /name="username" autocomplete="username"/)
  const unavailable = await render({ busy: false, configured: false, error: '' })
  assert.match(unavailable, /ещё не настроен/)
  assert.doesNotMatch(unavailable, /type="password"/)
})
