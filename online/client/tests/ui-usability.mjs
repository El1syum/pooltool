// Real Vue menu + real DOM clipboard checks. The insecure HTTP document is an
// explicitly served transport fixture; successful legacy copying is not mocked.
// The optional App lane uses disposable guests/rooms against the real API.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const apiBase = (process.env.POOLTOOL_API || 'http://127.0.0.1:8791').replace(/\/$/, '')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(apiBase).hostname), 'The real API lane uses an isolated loopback server')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/ui-usability')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4339, strictPort: true,
  proxy: { '/api': apiBase, '/models/library': apiBase, '/ready': apiBase, '/ws': { target: apiBase.replace(/^http/, 'ws'), ws: true } },
} })
const base = 'http://127.0.0.1:4339'
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
let browser
async function api(actor, endpoint, body, allowed = [200]) {
  const response = await fetch(apiBase + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30_000) })
  const data = await response.json()
  assert.ok(allowed.includes(response.status), `${endpoint}: ${response.status} ${JSON.stringify(data.detail || '')}`)
  return data
}
try {
  await server.listen()
  const helper = await server.transformRequest('/src/platform/clipboard.ts')
  assert.ok(helper?.code)
  const css = await readFile(path.resolve('src/style.css'), 'utf8')
  for (const engine of engines) {
    browser = await playwright[engine].launch({ headless: true })
    const errors = []
    const menu = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    menu.on('pageerror', error => errors.push(error.message))
    await menu.goto(base + '/tests/club-menu-fixture.html')
    await menu.getByRole('heading', { name: 'Pooltool', exact: true }).waitFor()
    await menu.getByRole('heading', { name: 'Pooltool', exact: true }).dblclick()
    assert.equal(await menu.evaluate(() => window.getSelection().toString()), '', 'UI titles cannot be accidentally selected')
    await menu.evaluate(() => {
      const s = window.clubFixture
      s.view = 'profile'
      s.history = [
        { id: 'ranked-win', opponentName: 'Игрок', mode: 'ranked', winnerId: 'fixture-player', eloDelta: 12, finishedAt: '2026-11-05T10:01:00Z' },
        { id: 'casual-long', opponentName: 'Соперник с очень длинным именем без изменения рейтинга', mode: 'casual', winnerId: 'other', finishedAt: '2026-11-05T10:02:00Z' },
        { id: 'ranked-loss', opponentName: 'Другой игрок', mode: 'ranked', winnerId: 'other', eloDelta: -9, finishedAt: '2026-11-05T10:03:00Z' },
      ]
    })
    await menu.getByRole('heading', { name: 'История матчей', exact: true }).waitFor()
    const historyLayouts = []
    for (const width of [1440, 768, 390, 320]) {
      await menu.setViewportSize({ width, height: 900 })
      const layout = await menu.locator('.club-history').evaluate(list => ({
        width: list.clientWidth, contentWidth: list.scrollWidth,
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        columns: [...list.querySelectorAll('li')].map(row => [...row.children].map(cell => ({ x: cell.getBoundingClientRect().x, width: cell.getBoundingClientRect().width, text: cell.textContent.trim() }))),
      }))
      assert.equal(layout.columns.length, 3)
      assert.ok(layout.columns.every(row => row.length === 5), 'Casual rows must reserve the Elo column as well')
      for (let column = 0; column < 5; column++) {
        assert.ok(layout.columns.every(row => Math.abs(row[column].x - layout.columns[0][column].x) < 1), `${engine} ${width}: history column ${column} drifted: ${JSON.stringify(layout)}`)
        assert.ok(layout.columns.every(row => Math.abs(row[column].width - layout.columns[0][column].width) < 1), `${engine} ${width}: history column widths drifted`)
      }
      assert.equal(layout.columns[1][4].text, '—', 'No Elo change is represented explicitly, not by removing its cell')
      assert.ok(layout.pageWidth <= layout.viewport + 1, `${engine} ${width}: horizontal scrolling is confined to the history list`)
      if (width < 768) assert.ok(layout.contentWidth > layout.width, 'Narrow history retains five columns with horizontal scroll')
      historyLayouts.push({ width, historyWidth: layout.width, contentWidth: layout.contentWidth })
      await menu.screenshot({ path: path.join(artifacts, `${engine}-history-${width}.png`) })
    }
    await menu.getByLabel('Имя игрока', { exact: true }).fill('Редактируемое имя')
    assert.equal(await menu.getByLabel('Имя игрока', { exact: true }).inputValue(), 'Редактируемое имя', 'The text-selection restriction must not disable forms')
    assert.equal(await menu.getByLabel('Имя игрока', { exact: true }).evaluate(node => getComputedStyle(node).getPropertyValue('user-select') || getComputedStyle(node).getPropertyValue('-webkit-user-select')), 'text')
    await menu.evaluate(() => {
      window.clubFixture.view = 'lobby'
      window.clubFixture.room = { id: 'fixture-room', code: 'AB12XY', hostId: 'fixture-player', players: [{ id: 'fixture-player', displayName: 'Тест Игрока', ready: false }], spectators: [], status: 'waiting', settings: { turnSeconds: 120, ranked: false } }
    })
    const invitation = menu.locator('[data-room-code]')
    await invitation.dblclick()
    assert.equal(await menu.evaluate(() => window.getSelection().toString()), 'AB12XY', 'Room invitation code remains directly selectable')
    assert.equal(await invitation.evaluate(node => getComputedStyle(node).getPropertyValue('user-select') || getComputedStyle(node).getPropertyValue('-webkit-user-select')), 'text')
    await menu.close()

    // A non-localhost HTTP origin is genuinely insecure in both engines. The
    // helper is the current source transformed by Vite, not a handwritten copy.
    const clipboard = await browser.newPage()
    clipboard.on('pageerror', error => errors.push(error.message))
    await clipboard.route('http://pooltool-http.test/copy-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><style>${css}</style><button id="copy">Copy</button><input id="edit" value="editable text"><span data-room-code id="code">AB12XY</span><script type="module">
      ${helper.code}
      window.copyTextUnderTest=copyText;
      window.copyEvents=[];window.copyValue='AB12XY';window.selectionMode='input';
      document.addEventListener('copy',()=>{window.copyEvents.push(document.activeElement?.value||getSelection().toString())});
      document.querySelector('#copy').onclick=async()=>{
        if(window.selectionMode==='input'){const e=document.querySelector('#edit');e.focus();e.setSelectionRange(2,7,'backward')}
        else{const e=document.querySelector('#code');getSelection().setBaseAndExtent(e.firstChild,5,e.firstChild,1)}
        window.copyResult=null;window.copyResult=await copyText(window.copyValue);
      };
      window.clipboardFixtureReady=true;
    </script>` }))
    await clipboard.goto('http://pooltool-http.test/copy-fixture')
    await clipboard.waitForFunction(() => window.clipboardFixtureReady)
    assert.equal(await clipboard.evaluate(() => window.isSecureContext), false, 'The legacy lane must test actual insecure HTTP')
    assert.equal(await clipboard.evaluate(() => typeof navigator.clipboard), 'undefined', 'Clipboard API is naturally unavailable, not stubbed, on insecure HTTP')
    await clipboard.getByRole('button', { name: 'Copy', exact: true }).click()
    await clipboard.waitForFunction(() => typeof window.copyResult === 'boolean')
    assert.equal(await clipboard.evaluate(() => window.copyResult), true, `${engine}: user-gesture document.execCommand must copy on HTTP`)
    assert.equal(await clipboard.evaluate(() => window.copyEvents.at(-1)), 'AB12XY')
    assert.deepEqual(await clipboard.locator('#edit').evaluate(node => ({ focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })), { focused: true, start: 2, end: 7, direction: 'backward' })
    assert.equal(await clipboard.locator('[data-clipboard-temporary]').count(), 0)

    await clipboard.evaluate(() => { window.selectionMode = 'range'; window.originalExec = document.execCommand.bind(document); document.execCommand = () => false })
    await clipboard.getByRole('button', { name: 'Copy', exact: true }).click()
    await clipboard.waitForFunction(() => typeof window.copyResult === 'boolean')
    assert.equal(await clipboard.evaluate(() => window.copyResult), false, 'A refused copy is not reported as success')
    assert.deepEqual(await clipboard.evaluate(() => ({ text: getSelection().toString(), anchor: getSelection().anchorOffset, focus: getSelection().focusOffset })), { text: 'B12X', anchor: 5, focus: 1 }, 'Failed copying restores the original directional text selection')
    assert.equal(await clipboard.locator('[data-clipboard-temporary]').count(), 0)
    await clipboard.evaluate(() => { document.execCommand = () => { throw Error('Explicit clipboard refusal') } })
    await clipboard.getByRole('button', { name: 'Copy', exact: true }).click()
    await clipboard.waitForFunction(() => typeof window.copyResult === 'boolean')
    assert.equal(await clipboard.evaluate(() => window.copyResult), false)
    assert.equal(await clipboard.locator('[data-clipboard-temporary]').count(), 0)

    // Explicit API doubles cover modern success and rejection, separately from
    // the real insecure-HTTP legacy command above.
    await clipboard.evaluate(() => { document.execCommand = window.originalExec; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.modernCopied = value } } }) })
    const beforeModern = await clipboard.evaluate(() => window.copyEvents.length)
    await clipboard.getByRole('button', { name: 'Copy', exact: true }).click()
    await clipboard.waitForFunction(() => typeof window.copyResult === 'boolean')
    assert.equal(await clipboard.evaluate(() => window.copyResult), true)
    assert.equal(await clipboard.evaluate(() => window.modernCopied), 'AB12XY')
    assert.equal(await clipboard.evaluate(() => window.copyEvents.length), beforeModern, 'Successful modern copying must not invoke the legacy command')
    await clipboard.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('Explicit modern permission denial') } })
    await clipboard.getByRole('button', { name: 'Copy', exact: true }).click()
    await clipboard.waitForFunction(() => typeof window.copyResult === 'boolean')
    assert.equal(await clipboard.evaluate(() => window.copyResult), true, 'Modern rejection falls back to the real legacy copy command')
    assert.equal(await clipboard.evaluate(() => window.copyEvents.length), beforeModern + 1)
    assert.equal(await clipboard.locator('[data-clipboard-temporary]').count(), 0)
    assert.equal(await clipboard.evaluate(() => window.copyTextUnderTest('')), false)
    await clipboard.close()

    let realAppFeedback = false
    if (process.env.SKIP_REAL_APP !== '1') {
      const readiness = await fetch(apiBase + '/ready')
      assert.equal(readiness.status, 200)
      assert.equal((await readiness.json()).physics, 'pooltool')
      const actor = await api(null, '/api/auth/guest', { displayName: `Clipboard QA ${engine}`, clientVersion: 'ui-usability-qa' })
      const { room } = await api(actor, '/api/rooms', { settings: { turnSeconds: 180, ranked: false } })
      const context = await browser.newContext()
      const app = await context.newPage()
      app.on('pageerror', error => errors.push(error.message))
      try {
        await context.addInitScript(({ token, name }) => {
          localStorage.setItem('pooltool.token', token); localStorage.setItem('pooltool.name', name)
          // Loopback HTTP is considered trustworthy, so explicitly disable only
          // this API to exercise the ordinary-preview legacy branch in App.
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
          window.appCopyEvents = []
          document.addEventListener('copy', () => window.appCopyEvents.push(document.activeElement?.value || getSelection().toString()))
        }, { token: actor.token, name: actor.user.displayName })
        await app.goto(base)
        await app.locator('[data-club-view="lobby"]').waitFor()
        await app.getByRole('button', { name: 'Скопировать код приглашения', exact: true }).click()
        await app.getByText('Код приглашения скопирован', { exact: true }).waitFor()
        assert.equal(await app.evaluate(() => window.appCopyEvents.at(-1)), room.code)
        await app.evaluate(() => { document.execCommand = () => false })
        await app.getByRole('button', { name: 'Скопировать код приглашения', exact: true }).click()
        await app.getByText('Браузер запретил копирование. Код выделен — нажмите Ctrl+C.', { exact: true }).waitFor()
        assert.equal(await app.evaluate(() => getSelection().toString()), room.code)
        assert.equal(await app.locator('[data-clipboard-temporary]').count(), 0)
        assert.equal(await app.getByRole('button', { name: 'Готов', exact: true }).isEnabled(), true)
        realAppFeedback = true
      } finally {
        await api(actor, `/api/rooms/${room.code}/leave`, {}, [200, 403, 404, 409]).catch(() => {})
        await context.close()
      }
    }
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine, historyLayouts, fixedFiveColumns: true, editableForms: true, onlyRoomCodeSelectable: true, insecureHttpLegacyCopy: true, restoredFocusAndSelection: true, explicitModernApiDoubles: true, realAppFeedback, jsErrors: errors.length }))
    await browser.close(); browser = null
  }
} finally {
  await browser?.close()
  await server.close()
}
