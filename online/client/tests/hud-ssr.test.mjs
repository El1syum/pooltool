import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { readFile } from 'node:fs/promises'

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
    phase: 'overview', canShoot: true, canPlace: false,
    remaining: 24, topViewKey: 'KeyT', overviewKey: 'KeyV', cameraMode: 'free',
    ...overrides,
  }
}
const render = props => renderToString(createSSRApp(Hud, props))
test('the selectable room-code node excludes the invitation label', async () => {
  const html = await render(fixture())
  assert.match(html, /Комната <span data-room-code>ABC123<\/span>/)
  assert.doesNotMatch(html, /<button[^>]*data-room-code/)
})
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
    assert.match(card.html, /<strong>0<\/strong><span>Из 7<\/span>/)
    assert.doesNotMatch(card.html, /Открытый стол|Группы определятся после разбоя|осталось 14/)
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

test('the table code, turn timer and both mapped camera hints use real values', async () => {
  const html = await render(fixture({ topViewKey: 'KeyF', overviewKey: 'KeyB' }))
  assert.match(html, /00:24/)
  assert.match(html, /<span class="hud-rack-detail">Раунд 1 {3}· {3}8-BALL<\/span>/)
  assert.match(html, /8-BALL.*СТОЛ ABC123/)
  assert.match(html, /F · вид сверху/)
  assert.match(html, /B · обзор стола/)
  assert.match(html, /aria-label="Меню матча"/)
  assert.doesNotMatch(html, /МАТЧ \d\d:|KeyF · вид сверху|Параметры удара/)
})

test('power phase renders original vector gauges as live percent and speed, never elevation', async () => {
  const html = await render(fixture({ phase: 'power', showAssist: true }))
  assert.match(html, /power-reticle\.svg/)
  const source = await readFile(new URL('../public/ui/figma-assist/power-gauge.svg', import.meta.url), 'utf8')
  const originalPath = source.match(/<path id="Vector 3" d="([^"]+)"/)[1]
  assert.equal([...html.matchAll(/class="hud-gauge-shape" d="([^"]+)"/g)].filter(match => match[1] === originalPath).length, 2,
    'Both gauges inline the exact original Figma path without an external SVG fragment')
  assert.doesNotMatch(html, /<use[^>]+power-gauge\.svg/)
  assert.match(html, /30%/)
  assert.match(html, /2.4 м\/с/)
  assert.match(html, /aria-label="Прибор наклона кия"/)
  assert.equal([...html.matchAll(/role="meter"/g)].length, 2)
  assert.match(html, /aria-valuemax="100" aria-valuenow="30"/)
  assert.match(html, /aria-valuemax="8" aria-valuenow="2.4"/)
  assert.equal([...html.matchAll(/offset="0.7"/g)].length, 4)
  assert.doesNotMatch(html, /figma\.com\/api\/mcp\/asset/)
})

test('both fill levels follow the same current cue speed', async () => {
  for (const [V0, percentage, offset] of [[0.2, 3, '0.975'], [4, 50, '0.5'], [8, 100, '0']]) {
    const html = await render(fixture({ phase: 'power', showAssist: true, aim: { phi: 90, V0, theta: 0, a: 0, b: 0 } }))
    assert.match(html, new RegExp(`${percentage}%`))
    assert.match(html, new RegExp(`${V0.toFixed(1)} м/с`))
    assert.equal([...html.matchAll(new RegExp(`offset="${offset}"`, 'g'))].length, 4)
  }
})

test('contact phase preserves its original Figma reticle and locked-direction hint', async () => {
  const html = await render(fixture({ phase: 'aim', showAssist: true }))
  assert.match(html, /Направление удара не меняется/)
  assert.match(html, /contact-ring\.svg/)
  assert.match(html, /contact-reticle\.svg/)
})

test('power gauges stay visible without the assist key while auxiliary cards remain opt-in', async () => {
  const html = await render(fixture({ phase: 'power', showAssist: false }))
  assert.doesNotMatch(html, /data-testid="alt-assist"/)
  assert.equal([...html.matchAll(/role="meter"/g)].length, 2)
  assert.match(html, /aria-valuemax="100" aria-valuenow="30"/)
  assert.match(html, /aria-valuemax="8" aria-valuenow="2.4"/)
  assert.match(html, /power-reticle\.svg/)
  assert.doesNotMatch(html, /aria-label="Прибор (?:силы удара|наклона кия|точки контакта)"/)
})

test('contact and heading states never show power gauges, with or without assistance', async () => {
  for (const phase of ['overview', 'aim']) {
    for (const showAssist of [false, true]) {
      const html = await render(fixture({ phase, cameraMode: 'cue', showAssist }))
      assert.doesNotMatch(html, /role="meter"/)
      assert.equal(html.includes('data-testid="alt-assist"'), phase === 'aim' && showAssist)
    }
  }
})

test('finished matches hide both power meters and optional assist cards', async () => {
  const props = fixture({ phase: 'power', showAssist: true })
  props.match.status = 'finished'
  const html = await render(props)
  assert.doesNotMatch(html, /role="meter"|data-testid="alt-assist"/)
})

test('own cue heading uses the direction design without confirming contact', async () => {
  for (const canShoot of [true, false]) {
    const html = await render(fixture({ cameraMode: 'cue', canShoot }))
    assert.match(html, /hud-heading/)
    assert.match(html, /data-shot-phase="overview"/)
    assert.match(html, /direction-arrow\.svg/)
    assert.match(html, /direction-ring\.svg/)
    assert.match(html, /direction-reticle\.svg/)
    assert.doesNotMatch(html, /hud-overview-instruction/)
    assert.doesNotMatch(html, /role="meter"/)
  }
})

test('the general overview instruction and ball legend do not require the assist key', async () => {
  const html = await render(fixture({ phase: 'overview', cameraMode: 'free', showAssist: false }))
  assert.match(html, /hud-overview-instruction/)
  assert.match(html, /Обозначения состояния шаров/)
  assert.doesNotMatch(html, /data-testid="alt-assist"/)
})

test('the contact leader appears only with own-turn keyboard assistance', async () => {
  const base = fixture({ phase: 'aim', showAssist: false })
  assert.doesNotMatch(await render(base), /contact-leader\.svg/)
  assert.match(await render({ ...base, showAssist: true }), /contact-leader\.svg/)
  assert.doesNotMatch(await render({ ...base, showAssist: true, user: { id: 'b' } }), /contact-leader\.svg|data-testid="alt-assist"/)
})

test('assist hints and slider labels follow the configured keyboard binding', async () => {
  for (const assistKeyLabel of ['Ctrl', 'H']) {
    const html = await render(fixture({ phase: 'power', showAssist: true, assistKeyLabel }))
    assert.match(html, new RegExp(`Удерживается ${assistKeyLabel}`))
    assert.match(html, new RegExp(`aria-label="Сила удара ${assistKeyLabel}"`))
    assert.match(html, new RegExp(`aria-label="Наклон кия ${assistKeyLabel}"`))
    assert.doesNotMatch(html, /Удерживается Alt|Сила удара Alt|Наклон кия Alt/)
  }
})

test('match feedback uses the designed footer text instead of inventing a new surface', async () => {
  const html = await render(fixture({ feedback: 'Соединение потеряно' }))
  assert.match(html, /<span class="(?=[^"]*\bhud-footer-instruction\b)(?=[^"]*\bhud-footer-feedback\b)[^"]+" role="status">Соединение потеряно<\/span>/)
  assert.doesNotMatch(html, /hud-match-status|hud-phase-hint|hud-controls|hud-alt-hint|hud-touch-assist/)
})
