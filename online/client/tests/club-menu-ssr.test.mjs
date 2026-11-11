import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { readFile } from 'node:fs/promises'

let server, Menu, Settings, bindings
const user = { id: 'test-a', displayName: 'Тест Игрока', elo: 1267, games: 17, wins: 9, losses: 8, settings: {} }
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
  Menu = (await server.ssrLoadModule('/src/components/ClubMenu.vue')).default
  Settings = (await server.ssrLoadModule('/src/components/ClubSettings.vue')).default
  bindings = (await server.ssrLoadModule('/src/game/types.ts')).DEFAULT_BINDINGS
})
after(async () => { await server?.close() })
const menu = (overrides = {}) => ({ view: 'menu', user, busy: false, connected: true, connection: 'Соединение установлено', code: '', name: user.displayName, turnSeconds: 120, botDifficulty: 'medium', searchMode: 'casual', clientVersion: 'test', ...overrides })
const render = (component, props) => renderToString(createSSRApp(component, props))

test('home uses local source WebP/SVGs and four Figma menu actions', async () => {
  const html = await render(Menu, menu())
  for (const text of ['Играть', 'Настройки', 'Профиль', 'Выход']) assert.match(html, new RegExp(text))
  assert.match(html, /ui\/club-menu\/club-background\.webp/)
  assert.match(html, /ui\/club-menu\/play\.svg/)
  assert.match(html, /Тест Игрока/)
  assert.doesNotMatch(html, /figma\.com\/api|1240 RP|Александр/)
})

test('healthy connection footer is absent but a lost connection remains announced', async () => {
  for (const view of ['menu', 'play', 'profile']) {
    const html = await render(Menu, menu({ view }))
    const footer = html.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)?.[0]
    assert.ok(footer, 'Keep the breadcrumb/version footer')
    assert.doesNotMatch(footer, /class="club-connection/)
    assert.doesNotMatch(footer, /Соединение установлено/)
  }
  const offline = await render(Menu, menu({ connected: false, connection: 'Подключение потеряно' }))
  assert.match(offline, /club-connection-offline/)
  assert.match(offline, /role="status"/)
  assert.match(offline, /Подключение потеряно/)
})
test('play renders bot training as a fifth full action with the supplied native SVG', async () => {
  const html = await render(Menu, menu({ view: 'play' }))
  for (const text of ['Случайный противник', 'Рейтинговая игра', 'Игра с другом', 'Просмотр матча', 'Тренировка с ботом']) assert.match(html, new RegExp(text))
  assert.match(html, /1\s*267 Эло/)
  const actionClasses = [...html.matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>/g)].map(match => match[1].split(/\s+/))
  assert.equal(actionClasses.filter(classes => classes.includes('club-action')).length, 6, JSON.stringify(actionClasses))
  assert.match(html, /<button[^>]*class="club-action"[^>]*><img[^>]*ui\/club-menu\/bot\.svg[^>]*class="club-bot-icon"[^>]*><span>Тренировка с ботом<\/span><img[^>]*chevron-gold\.svg/)
  assert.doesNotMatch(html, /class="club-text-button"[^>]*>Тренировка с ботом/)
  assert.ok(html.indexOf('Тренировка с ботом') < html.indexOf('<span>Назад</span>'))
})

test('bot training entry follows the common busy and disconnected action lock', async () => {
  for (const overrides of [{ busy: true }, { connected: false }]) {
    const html = await render(Menu, menu({ view: 'play', ...overrides }))
    assert.match(html, /<button[^>]*class="club-action"[^>]*disabled[^>]*><img[^>]*bot\.svg[^>]*><span>Тренировка с ботом/)
  }
})
test('search time and Elo use actual provided values', async () => {
  const html = await render(Menu, menu({ view: 'search', searchMode: 'ranked', searchElapsedSeconds: 74, ratingWindow: 100 }))
  assert.match(html, /01:14/)
  assert.match(html, /1\s*167–1\s*367/)
  assert.match(html, /Отменить поиск/)
})
test('lobby reflects actual users, readiness, invitation code and selected turn time', async () => {
  const room = { id: 'r', code: 'ZXCV67', hostId: user.id, players: [{ id: user.id, displayName: user.displayName, ready: true }], spectators: [], status: 'waiting', settings: { turnSeconds: 90, ranked: false } }
  const html = await render(Menu, menu({ view: 'lobby', room }))
  assert.match(html, /ZXCV67/)
  assert.match(html, /90 секунд на удар/)
  assert.match(html, /Отменить готовность/)
  assert.match(html, /Ожидаем подключения/)
})
test('profile shows real profile fields, numeric Elo progress and actual match history', async () => {
  const html = await render(Menu, menu({ view: 'profile', profileDetails: { fullName: 'Личное имя', city: 'Киев', about: 'Описание профиля' }, history: [{ id: 'm', startedAt: '2026-11-01T12:00:00Z', winnerId: user.id, opponentName: 'Друг', ranked: true, eloDelta: 12 }] }))
  assert.match(html, /17/)
  assert.match(html, /52,9%/)
  assert.match(html, /против Друг/)
  assert.match(html, /Победа/)
  assert.match(html, /Эло \+12/)
  for (const value of ['Личное имя', 'Киев', 'Описание профиля', 'Сохранить профиль']) assert.ok(html.includes(value))
  assert.match(html, /role="meter"[^>]*aria-valuenow="1267"/)
  assert.doesNotMatch(html, /Сезон|Золото|Профиль сохранён/)
})
test('settings is an accessible real-settings component with safe server render', async () => {
  const settings = { quality: 'medium', volume: .5, sensitivity: 1, bindings, showAimGuide: true, showPocketLabels: true }
  const html = await render(Settings, { settings, bindingCapture: null, captureLabels: Object.fromEntries(Object.keys(bindings).map(key => [key, key])), bindingConflicts: [], aimGuideLocked: true, inMatch: true, user, clientVersion: 'test' })
  assert.match(html, /role="dialog" aria-modal="true"/)
  assert.match(html, /Графика/)
  assert.match(html, /Звук/)
  assert.match(html, /Управление/)
  assert.match(html, /Модели стола и окружения/)
  assert.doesNotMatch(html, /club-background\.webp/)
})
test('settings index uses Figma summary slots with current values instead of samples or chevrons', async () => {
  for (const [quality, summary, volume] of [['low', 'Низкая', 0], ['medium', 'Средняя', .37], ['high', 'Высокая', 1]]) {
    const html = await render(Settings, { settings: { quality, volume, sensitivity: 1, bindings, showAimGuide: true, showPocketLabels: true }, bindingCapture: null, captureLabels: {}, bindingConflicts: [], aimGuideLocked: false, inMatch: false, user, clientVersion: 'test' })
    assert.ok(html.includes(`data-testid="graphics-summary">${summary}</small>`))
    assert.ok(html.includes(`data-testid="volume-summary">${Math.round(volume * 100)}%</small>`))
    assert.ok(html.includes('>Мышь и клавиатура</small>'))
    assert.match(html, /ВАШ КОМФОРТ/)
    assert.match(html, /Настройте атмосферу и почувствуйте игру/)
    for (const label of ['Графика', 'Звук', 'Управление']) assert.ok(!html.includes(`${label}</span><img`))
  }
})

test('all referenced original SVG assets have valid standalone SVG metadata', async () => {
  const assets = ['online-dot', 'play', 'chevron-dark', 'chevron-gold', 'settings', 'user', 'exit', 'shuffle', 'trophy', 'users', 'eye', 'bot', 'arrow-left', 'circle-dot', 'sliders', 'plus', 'key', 'log-in', 'eye-muted', 'eye-dark', 'copy', 'wait-dot', 'search-arc', 'x', 'pencil', 'pencil-small', 'pencil-about', 'profile-trophy', 'check-dark', 'monitor', 'volume', 'mouse', 'exit-large', 'exit-dark', 'chevron-down', 'toggle-on', 'toggle-off']
  for (const asset of assets) {
    const svg = await readFile(new URL(`../public/ui/club-menu/${asset}.svg`, import.meta.url), 'utf8')
    assert.match(svg, /^<svg\b/)
    assert.match(svg, /viewBox="0 0 [\d.]+ [\d.]+"/)
    assert.doesNotMatch(svg, /https?:\/\/www\.figma\.com\/api\/mcp/)
  }
})
