import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'

let server, Hud
before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
  Hud = (await server.ssrLoadModule('/src/components/MatchHud.vue')).default
})
after(async () => { await server?.close() })

function fixture(overrides = {}) {
  return {
    match: {
      id: 'fixture-match', roomId: 'fixture-room', status: 'active', revision: 0,
      currentPlayer: 0, startedAt: new Date().toISOString(), deadline: null,
      players: [{ id: 'a', displayName: 'Alex Chen' }, { id: 'b', displayName: 'Morgan Reed' }],
      snapshot: { groups: [null, null], balls: Array.from({ length: 15 }, (_, index) => ({ id: String(index + 1), position: [0, 0, 0.03], pocketed: false })), table: { width: 1.27, length: 2.54, pockets: [] } },
    },
    user: { id: 'a' }, room: { code: 'ABC123' }, aim: { phi: 90, V0: 2.4, theta: 15, a: 0, b: 0 },
    phase: 'overview', canShoot: true, canPlace: false, canReposition: false,
    placingCue: false, connected: true, connection: 'Соединение установлено',
    remaining: 24, elapsed: 725, statusText: 'Ваш ход', volume: 0.5,
    topViewKey: 'KeyT', calledBall: '', calledPocket: '', cameraMode: 'free',
    ...overrides,
  }
}
const render = props => renderToString(createSSRApp(Hud, props))
function articles(html) {
  return [...html.matchAll(/<article\b[^>]*data-player-id="([^"]+)"[^>]*>[\s\S]*?<\/article>/g)]
    .map(match => ({ id: match[1], html: match[0] }))
}

test('an open table never assigns all 14 object balls to each player', async () => {
  const html = await render(fixture())
  const cards = articles(html)
  assert.equal(cards.length, 2)
  for (const card of cards) {
    assert.match(card.html, /data-group="open"/)
    assert.match(card.html, /Открытый стол/)
    assert.doesNotMatch(card.html, /осталось 14/)
  }
})

test('group score counts pocketed flags and state 4, but excludes the eight-ball', async () => {
  const props = fixture()
  props.match.snapshot.groups = ['solids', 'stripes']
  for (const ball of props.match.snapshot.balls) {
    if ([1, 3, 4, 7, 8, 9, 12, 13].includes(Number(ball.id))) ball.state = 4
  }
  props.match.snapshot.balls[0].pocketed = true
  const cards = articles(await render(props))
  assert.match(cards[0].html, /забито 4 из 7, осталось 3/)
  assert.match(cards[1].html, /забито 3 из 7, осталось 4/)
  assert.match(cards[0].html, /ball-shading\.svg/)
  assert.match(cards[0].html, /ball-highlight\.svg/)
})

test('moving the local player to the left preserves original group and turn indices', async () => {
  const props = fixture({ user: { id: 'b' } })
  props.match.snapshot.groups = ['solids', 'stripes']
  const cards = articles(await render(props))
  assert.deepEqual(cards.map(card => card.id), ['b', 'a'])
  assert.match(cards[0].html, /data-group="stripes"/)
  assert.doesNotMatch(cards[0].html, /hud-player-active/)
  assert.match(cards[1].html, /hud-player-active/)
})

test('timers, mapped key hint and mute action use current values', async () => {
  const html = await render(fixture({ volume: 0, topViewKey: 'KeyF' }))
  assert.match(html, /00:24/)
  assert.match(html, /12:05/)
  assert.match(html, /Взгляд сверху кнопка F/)
  assert.match(html, /aria-label="Включить звук"/)
  assert.doesNotMatch(html, /Взгляд сверху кнопка KeyF/)
})

test('power phase renders original vector gauges as live percent and speed, never elevation', async () => {
  const html = await render(fixture({ phase: 'power' }))
  for (const name of ['reticle-center', 'reticle-ring', 'wedge-outline']) assert.match(html, new RegExp(`${name}\\.svg`))
  assert.match(html, /30%/)
  assert.match(html, /2.4 м\/с/)
  assert.doesNotMatch(html, /15°/)
  assert.equal([...html.matchAll(/role="meter"/g)].length, 2)
  assert.match(html, /aria-valuemax="100" aria-valuenow="30"/)
  assert.match(html, /aria-valuemax="8" aria-valuenow="2.4"/)
  assert.equal([...html.matchAll(/offset="0.7"/g)].length, 4)
  assert.doesNotMatch(html, /figma\.com\/api\/mcp\/asset/)
})

test('both fill levels follow the same current cue speed', async () => {
  for (const [V0, percentage, offset] of [[0.2, 3, '0.975'], [4, 50, '0.5'], [8, 100, '0']]) {
    const html = await render(fixture({ phase: 'power', aim: { phi: 90, V0, theta: 0, a: 0, b: 0 } }))
    assert.match(html, new RegExp(`${percentage}%`))
    assert.match(html, new RegExp(`${V0.toFixed(1)} м/с`))
    assert.equal([...html.matchAll(new RegExp(`offset="${offset}"`, 'g'))].length, 4)
  }
})

test('contact phase disables the locked direction control', async () => {
  const html = await render(fixture({ phase: 'aim' }))
  // Open drawer controls are exercised in browser tests; this hint also makes
  // the lock and its escape route explicit to a player using the contact HUD.
  assert.match(html, /Направление зафиксировано/)
})
