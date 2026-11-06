import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
let server, api
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
  api = await server.ssrLoadModule('/src/models/playerSelection.ts')
})
after(async () => { await server?.close() })
const config = () => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], replaceProcedural: true, material: {}, materials: {}, hiddenNodes: [] })
const asset = (id, role = 'table', enabled = true) => ({ id, role, enabled, name: id, url: `/models/library/${id}.glb`, bytes: 1200, config: config() })
const library = () => ({ version: 7, profile: { tableId: 'shared-table', environmentId: 'shared-room' }, assets: [asset('shared-table'), asset('own-table'), asset('shared-room', 'environment')] })
const choice = id => ({ mode: 'asset', id })

test('defaults follow the server scene without copying its selection into preferences', () => {
  const preferences = api.defaultPlayerAssetSelection(), catalog = library()
  const result = api.resolvePlayerAssets(preferences, catalog)
  assert.equal(result.profile.table.source.url, '/models/library/shared-table.glb')
  assert.equal(result.profile.environment.source.url, '/models/library/shared-room.glb')
  assert.deepEqual(result.selection, preferences)
  catalog.profile.tableId = 'own-table'
  assert.equal(api.resolvePlayerAssets(preferences, catalog).profile.table.name, 'own-table')
})

test('each personal role overrides only presentation and does not mutate the shared scene', () => {
  const catalog = library(), before = structuredClone(catalog)
  const preferences = { version: 1, table: choice('own-table'), environment: { mode: 'default' } }
  const result = api.resolvePlayerAssets(preferences, catalog)
  assert.equal(result.profile.table.name, 'own-table')
  assert.equal(result.profile.environment.name, 'shared-room')
  result.profile.table.position[0] = 4
  assert.deepEqual(catalog, before)
  assert.deepEqual(result.selection, preferences)
})

test('procedural is an explicit persistent choice, not an alias for shared defaults', () => {
  const preferences = { version: 1, table: { mode: 'procedural' }, environment: { mode: 'default' } }
  const result = api.resolvePlayerAssets(preferences, library())
  assert.equal(result.profile.table, null)
  assert.equal(result.profile.environment.name, 'shared-room')
  assert.equal(api.playerAssetChoiceValue(preferences.table), 'procedural')
  assert.deepEqual(api.playerAssetChoiceFromValue('procedural'), preferences.table)
})

test('a not-yet-loaded or failed catalogue never erases saved valid IDs', () => {
  const preferences = { version: 1, table: choice('own-table'), environment: choice('future-room') }
  for (const absent of [null, undefined]) {
    assert.deepEqual(api.reconcilePlayerAssetSelection(preferences, absent), preferences)
    assert.deepEqual(api.resolvePlayerAssets(preferences, absent).selection, preferences)
    assert.deepEqual(api.resolvePlayerAssets(preferences, absent).unavailable, [])
  }
})

test('confirmed missing, disabled and wrong-role models fall back to shared defaults', () => {
  for (const selected of [asset('missing'), asset('disabled', 'table', false), asset('wrong-role', 'environment')]) {
    const catalog = library()
    if (selected.id !== 'missing') catalog.assets.push(selected)
    const result = api.resolvePlayerAssets({ version: 1, table: choice(selected.id), environment: { mode: 'procedural' } }, catalog)
    assert.equal(result.selection.table.mode, 'default')
    assert.equal(result.profile.table.name, 'shared-table')
    assert.equal(result.profile.environment, null)
    assert.deepEqual(result.unavailable, ['table'])
  }
})

test('preferences accept IDs only, drop injected URLs/configuration and isolate user storage', () => {
  const map = new Map(), storage = { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) }
  const injected = { version: 1, table: { ...choice('own-table'), url: 'https://evil.invalid/a.glb', config: { scale: [9, 9, 9] } }, environment: choice('https://evil.invalid/a.glb'), admin: true }
  assert.equal(api.writePlayerAssetSelection(storage, 'a', injected), true)
  const saved = api.readPlayerAssetSelection(storage, 'a')
  assert.deepEqual(saved, { version: 1, table: choice('own-table'), environment: { mode: 'default' } })
  assert.deepEqual(api.readPlayerAssetSelection(storage, 'b'), api.defaultPlayerAssetSelection())
  assert.equal(api.playerAssetStorageKey(null), null)
  assert.equal(api.writePlayerAssetSelection(storage, null, injected), false)
  assert.doesNotMatch([...map.values()].join(''), /https|config|admin/)
  assert.deepEqual(api.playerAssetChoiceFromValue('asset:https://evil.invalid/x'), { mode: 'default' })
})

test('broken local storage and malformed versions fail closed without throwing or deleting data', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } }
  assert.deepEqual(api.readPlayerAssetSelection(broken, 'a'), api.defaultPlayerAssetSelection())
  assert.equal(api.writePlayerAssetSelection(broken, 'a', {}), false)
  assert.deepEqual(api.parsePlayerAssetSelection({ version: 2, table: choice('own-table') }), api.defaultPlayerAssetSelection())
  assert.deepEqual(api.parsePlayerAssetSelection(null), api.defaultPlayerAssetSelection())
  assert.deepEqual(api.readPlayerAssetSelection({ getItem: () => '{', setItem() {} }, 'a'), api.defaultPlayerAssetSelection())
})

test('invalid catalogue URLs cannot escape the public local model path', () => {
  const catalog = library()
  catalog.assets.find(asset => asset.id === 'own-table').url = 'https://evil.invalid/model.glb'
  const result = api.resolvePlayerAssets({ version: 1, table: choice('own-table'), environment: { mode: 'default' } }, catalog)
  assert.deepEqual(result.unavailable, ['table'])
  assert.equal(result.selection.table.mode, 'default')
  assert.equal(result.profile.table.name, 'shared-table')
})
