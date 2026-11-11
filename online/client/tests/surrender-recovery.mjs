// Real local service: a server-committed surrender must not restore a defeat
// panel on a fresh page. Optional second lane drops only the actual WS ack.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { clickHudAction, waitForConnectedHome } from './app-state.mjs'

const base = (process.env.POOLTOOL_URL || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use an isolated loopback test server')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const modes = process.env.SURRENDER_DROP_ACK === '1' ? ['fresh-restore', 'lost-ws-ack'] : ['fresh-restore']

async function api(endpoint, token, body, allowed = [200]) {
  const response = await fetch(`${base}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${endpoint}: ${response.status} ${JSON.stringify(data.detail ?? '')}`)
  return data
}

assert.equal((await api('/ready')).physics, 'pooltool', 'The real Pooltool engine is required')
for (const engine of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) })
  try {
    for (const mode of modes) {
      const actor = await api('/api/auth/guest', '', { displayName: `QA surrender ${engine}`, clientVersion: 'qa-surrender-recovery' })
      const { room, match } = await api('/api/solo', actor.token, { difficulty: 'easy', turnSeconds: 120 })
      const errors = [], retried = []
      let context
      try {
        if (mode === 'fresh-restore') {
          const result = await api(`/api/matches/${match.id}/commands`, actor.token, { type: 'surrender', commandId: `restore-${crypto.randomUUID()}`, expectedRevision: match.revision, payload: {} })
          assert.equal(result.match.reason, 'surrender')
          assert.notEqual(result.match.winnerId, actor.user.id)
          assert.equal((await api('/api/me/current', actor.token)).room?.id, room.id, 'Server still holds the finished room before opening the fresh browser')
        }
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
        await context.addInitScript(token => {
          // Only authentication is seeded: no pending command or match bookmarks.
          localStorage.setItem('pooltool.token', token)
          window.qaSurrenderSawPanel = false
          new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
              if (node instanceof Element && (node.matches('.result-panel') || node.querySelector('.result-panel'))) window.qaSurrenderSawPanel = true
            }
          }).observe(document, { childList: true, subtree: true })
        }, actor.token)
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/matches/${match.id}/commands`) retried.push('http-command')
        })
        let dropped = 0, outgoingSurrenders = 0
        if (mode === 'lost-ws-ack') await page.routeWebSocket(/\/ws(?:\?|$)/, client => {
          const server = client.connectToServer()
          let surrenderCommandId
          client.onMessage(frame => {
            const message = JSON.parse(frame.toString())
            if (message.type === 'command' && message.command?.type === 'surrender') {
              surrenderCommandId = message.command.commandId
              outgoingSurrenders++
            }
            server.send(frame)
          })
          server.onMessage(frame => {
            const message = JSON.parse(frame.toString())
            if (surrenderCommandId && message.type === 'commandResult' && message.commandId === surrenderCommandId && message.ok) { dropped++; return }
            client.send(frame)
          })
        })
        const departure = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/rooms/${room.code}/leave`, { timeout: 20_000 })
        // If navigation or a click throws, avoid an unhandled waiter rejection.
        void departure.catch(() => {})
        await page.goto(base)
        if (mode === 'lost-ws-ack') {
          await page.getByTestId('match-hud').waitFor()
          await clickHudAction(page, page.getByRole('button', { name: 'Меню матча', exact: true }))
          await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
          await page.getByRole('heading', { name: 'Сдаться?', exact: true }).waitFor()
          await page.getByRole('button', { name: 'Сдаться', exact: true }).click()
        }
        assert.equal((await departure).status(), 200, 'The browser actually left the finished room')
        await waitForConnectedHome(page)
        const state = await api('/api/me/current', actor.token)
        assert.equal(state.room, null)
        assert.equal(state.match, null)
        const history = await api('/api/me/history', actor.token)
        assert.equal(history.matches.find(item => item.id === match.id)?.reason, 'surrender')
        assert.equal(await page.evaluate(() => window.qaSurrenderSawPanel), false, 'Defeat panel must never be mounted')
        assert.deepEqual(await page.evaluate(() => ['pooltool.room', 'pooltool.match', 'pooltool.pendingCommand'].map(key => localStorage.getItem(key))), [null, null, null])
        assert.deepEqual(retried, [], 'Departure must not replay the command over HTTP')
        assert.equal(dropped, mode === 'lost-ws-ack' ? 1 : 0, 'The genuine commandResult must be dropped exactly once in the loss lane')
        assert.equal(outgoingSurrenders, mode === 'lost-ws-ack' ? 1 : 0)
        assert.deepEqual(errors, [])
        console.log(JSON.stringify({ engine, mode, roomReleased: true, historyPreserved: true, resultPanel: false, droppedAck: dropped }))
      } finally {
        await context?.close()
        await api(`/api/rooms/${room.code}/leave`, actor.token, {}, [200, 403, 404]).catch(() => {})
      }
    }
  } finally {
    await browser.close()
  }
}
