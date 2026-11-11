import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

// Isolated QA for the real ClubMenu, its event contract and local Figma assets.
// The fixture deliberately performs no API/room writes; App cleanup is tested separately.
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/qa-club-navigation')
await mkdir(artifacts, { recursive: true })
const port = Number(process.env.QA_CLUB_PORT || 4344)
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } })
const url = `http://127.0.0.1:${port}/tests/qa-club-navigation.fixture.html`
const viewports = [[1440, 900], [1366, 768], [390, 844], [320, 568], [568, 320]]
const sourceSlots = new Map()

function assertSameChrome(actual, expected, label) {
  for (const key of Object.keys(expected)) for (const dimension of Object.keys(expected[key])) {
    assert.ok(Math.abs(actual[key][dimension] - expected[key][dimension]) < .05, `${label} ${key}.${dimension}: ${actual[key][dimension]} != ${expected[key][dimension]}`)
  }
}

async function sourceSlot(url) {
  const pathname = new URL(url).pathname
  assert.match(pathname, /^\/ui\/club-menu\/[a-z0-9-]+\.(?:svg|webp)$/)
  if (!sourceSlots.has(pathname)) {
    const bytes = await readFile(`public${pathname}`)
    assert.ok(bytes.length, `${pathname} must not be empty`)
    const root = bytes.toString('utf8').match(/<svg\b[^>]*>/)?.[0]
    if (pathname.endsWith('.svg')) assert.ok(root, `Missing SVG root: ${pathname}`)
    const width = Number(root?.match(/\bwidth="([0-9.]+)"/)?.[1] ?? 1264)
    const height = Number(root?.match(/\bheight="([0-9.]+)"/)?.[1] ?? 848)
    sourceSlots.set(pathname, { pathname, width, height, bytes: bytes.length })
  }
  return sourceSlots.get(pathname)
}

try {
  await server.listen()
  const { isRoomCode, normalizeRoomCode } = await server.ssrLoadModule('/src/roomCode.ts')
  for (const code of ['ABC123', '7K4M2Q', '000000']) assert.equal(isRoomCode(code), true)
  for (const code of ['ABC123\n', 'abc123', 'АBC123', 'ABC12', 'ABC1234', 'ABC-12', ' ABC123']) assert.equal(isRoomCode(code), false)
  assert.equal(normalizeRoomCode(' АaЖb-c123😀 extra'), 'ABC123')
  assert.equal(normalizeRoomCode('ＡßК!'), '')
  const report = []
  for (const engine of engines) {
    const browser = await playwright[engine].launch({ headless: true })
    try {
      for (const [width, height] of viewports) {
        const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
        const errors = [], assetSlots = [], surfaces = []
        page.on('pageerror', error => errors.push(error.message))
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
        try {
          await page.goto(url)
          await page.evaluate(() => document.fonts.ready)
          const shell = page.locator('main.club-shell')
          const crumbs = shell.getByRole('navigation', { name: 'Путь по меню' })
          const body = shell.locator('.club-content')
          const button = (name, region = body) => region.getByRole('button', { name, exact: true })
          const crumb = name => button(name, crumbs)
          const chrome = () => shell.evaluate(node => {
            const coords = selector => {
              const r = node.querySelector(selector).getBoundingClientRect()
              return { top: r.top, right: r.right, height: r.height }
            }
            return { account: coords('.club-account'), version: coords('.club-footer > span'), footer: coords('.club-footer') }
          })
          let anchor
          async function surface(name, label) {
            await page.locator(`main.club-shell[data-club-view="${name}"]`).waitFor()
            assert.equal((await crumbs.locator('[aria-current="page"]').textContent()).trim(), label)
            const actual = await chrome()
            if (anchor) assertSameChrome(actual, anchor, `${engine} ${width}×${height}: ${name} shifted chrome`)
            else anchor = actual
            assert.ok(Math.abs(actual.footer.top + actual.footer.height - height) < .05)
            assert.equal(await crumbs.evaluate(node => getComputedStyle(node).textAlign), 'left')
            await page.waitForFunction(() => [...document.querySelectorAll('main.club-shell img')].every(img => img.complete && img.naturalWidth > 0))
            const slots = await shell.locator('img').evaluateAll(images => images.map(img => ({
              url: img.currentSrc, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
              width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height,
              bot: img.classList.contains('club-bot-icon'),
            })))
            for (const slot of slots) {
              const source = await sourceSlot(slot.url)
              assert.ok(Math.abs(slot.naturalWidth - source.width) < 1 && Math.abs(slot.naturalHeight - source.height) < 1, JSON.stringify({ slot, source }))
              if (!source.pathname.endsWith('.webp')) {
                const expected = slot.bot ? { width: 20, height: 20 } : source
                assert.ok(Math.abs(slot.width - expected.width) < .3 && Math.abs(slot.height - expected.height) < .3, JSON.stringify({ slot, expected, surface: name, width, height }))
              }
              assetSlots.push({ surface: name, pathname: source.pathname, width: slot.width, height: slot.height })
            }
            surfaces.push(name)
          }
          async function backHeight(name, expected) {
            const rect = await button(name).evaluate(node => ({ height: node.getBoundingClientRect().height, minHeight: parseFloat(getComputedStyle(node).minHeight) }))
            assert.deepEqual(rect, { height: expected, minHeight: expected }, `${engine} ${width}×${height}: ${name}`)
          }
          async function capture(name) {
            if (width === 1440 || width === 390) await page.screenshot({ path: path.join(artifacts, `${engine}-${width}x${height}-${name}.png`) })
          }

          await surface('menu', 'Главное меню')
          assert.equal(await shell.evaluate(node => node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1), true)
          await button('Играть').click()
          await surface('choices', 'Играть')
          await backHeight('Назад', 48)
          assert.equal(await button('Тренировка с ботом').evaluate(node => node.getBoundingClientRect().height), width <= 480 ? 56 : 62)
          await button('Случайный противник').click()
          await surface('search', 'Случайный противник')
          assert.equal(await body.locator('.club-split-note > span:first-child').evaluate(node => getComputedStyle(node).fontSize), '13px')
          assert.equal(await body.locator('.club-split-note > span:last-child').textContent(), 'Без изменения рейтинга')
          assert.equal(await body.locator('.club-search + .club-divider').count(), 1)
          assert.equal(await body.getByText('Отмена вернёт вас в раздел «Играть».', { exact: true }).count(), 1)
          assert.notEqual(await body.locator('.club-section-title > p').evaluate(node => getComputedStyle(node).textShadow), 'none')
          await capture('casual')
          await crumb('Играть').press('Enter')
          await surface('choices', 'Играть')
          await page.evaluate(() => { window.clubFixture.ratingWindow = 100; window.clubFixture.searchElapsedSeconds = 24 })
          await body.getByRole('button', { name: /^Рейтинговая игра/ }).click()
          await surface('search', 'Рейтинговая игра')
          assert.equal(await body.locator('.club-search > strong').textContent(), '00:24')
          assert.equal(await body.locator('.club-search .club-small-note').textContent(), 'Ожидаем второго игрока')
          assert.equal(await body.locator('.club-rating-data > div:last-child > strong').textContent().then(text => text.replace(/\s/g, ' ')), '1 167–1 367')
          assert.equal(await body.locator('.club-rating-data + .club-divider + .club-ranked-search-meta br').count(), 1)
          assert.equal(await body.locator('.club-ranked-search-meta').evaluate(node => getComputedStyle(node).textAlign), 'center')
          assert.equal(await body.locator('.club-split-note').count(), 0)
          assert.equal(await body.getByText('Отмена вернёт вас в раздел «Играть».', { exact: true }).count(), 0)
          await capture('ranked')
          await button('Отменить поиск').click()
          await surface('choices', 'Играть')

          await button('Игра с другом').click()
          await surface('friend', 'Игра с другом')
          await backHeight('Назад', 48)
          await button('Настройки игры').click()
          await surface('rules', 'Настройки игры')
          await backHeight('Назад', width <= 480 ? 56 : 62)
          await crumb('Игра с другом').click()
          await surface('friend', 'Игра с другом')
          await button('Присоединиться').click()
          await surface('join', 'Присоединиться')
          await backHeight('Назад', 48)
          const input = body.getByRole('textbox', { name: 'Код комнаты' })
          await input.fill('Жß!Ａ')
          assert.equal(await input.inputValue(), '')
          await input.fill(' АaЖb-c123😀 extra')
          assert.equal(await input.inputValue(), 'ABC123')
          await input.press('End')
          await page.keyboard.insertText('Б@')
          assert.equal(await input.inputValue(), 'ABC123')
          await input.press('Enter')
          assert.deepEqual(await page.evaluate(() => window.lastFixtureJoin), { spectate: false, code: 'ABC123' })
          const codeGaps = () => body.locator('.club-code-form').evaluate(form => {
            const r = selector => form.querySelector(selector).getBoundingClientRect()
            return { hint: r('#club-code-help').top - r('input').bottom, actionGap: parseFloat(getComputedStyle(form).rowGap), submitAfterPrevious: r('[type=submit]').top - (form.querySelector('.club-observer-note') ?? form.querySelector('.club-code-field')).getBoundingClientRect().bottom }
          })
          assert.deepEqual(await codeGaps(), { hint: 12, actionGap: 20, submitAfterPrevious: 20 })
          await capture('join')
          await crumb('Играть').click()
          await surface('choices', 'Играть')
          await button('Просмотр матча').click()
          await surface('watch', 'Просмотр матча')
          await backHeight('Назад', 48)
          assert.deepEqual(await codeGaps(), { hint: 12, actionGap: 20, submitAfterPrevious: 20 })
          await button('Смотреть матч').click()
          assert.deepEqual(await page.evaluate(() => window.lastFixtureJoin), { spectate: true, code: 'ABC123' })
          await crumb('Играть').click()
          await surface('choices', 'Играть')
          await button('Игра с другом').click()
          await button('Создать игру').click()
          await surface('lobby', 'Создать игру')
          assert.equal(await body.getByText('Ваш друг', { exact: true }).evaluate(node => getComputedStyle(node).color), 'rgb(165, 174, 166)')
          await backHeight('Выйти из комнаты', 48)
          await button('Готов').click()
          assert.equal(await button('Отменить готовность').count(), 1)
          await capture('lobby')
          await button('Выйти из комнаты').click()
          await surface('friend', 'Игра с другом')
          await button('Создать игру').click()
          await surface('lobby', 'Создать игру')
          await crumb('Играть').click()
          await surface('choices', 'Играть')

          await crumb('Главное меню').click()
          await button('Выход').click()
          await surface('exit', 'Выход')
          await backHeight('Отмена', 48)
          await page.keyboard.press('Escape')
          await surface('menu', 'Главное меню')
          assert.equal(await button('Выход').evaluate(node => node === document.activeElement), true)
          await button('Профиль').click()
          await surface('profile', 'Профиль')
          const profileGaps = await body.locator('.club-stat-grid').evaluate(node => ({ row: getComputedStyle(node).rowGap, col: getComputedStyle(node).columnGap }))
          assert.deepEqual(profileGaps, { row: '16px', col: '12px' })
          const pencil = button('Редактировать профиль')
          assert.equal(await pencil.evaluate(node => node.getBoundingClientRect().left - node.previousElementSibling.getBoundingClientRect().right), 16)
          await pencil.click()
          assert.equal(await body.getByRole('textbox', { name: 'Имя игрока', exact: true }).evaluate(node => document.activeElement === node), true)
          assert.equal(await body.getByRole('meter', { name: 'Прогресс рейтинга' }).count(), 1)
          await body.locator('.club-profile-info input').first().fill('Новое имя')
          assert.equal(await body.getByText('Изменения ещё не сохранены', { exact: true }).count(), 1)
          await button('Сохранить профиль').scrollIntoViewIfNeeded()
          assertSameChrome(await chrome(), anchor, 'Scrolling the profile must not move the chrome')
          assert.ok(await button('Сохранить профиль').isVisible())
          await capture('profile')
          assert.deepEqual(errors, [])
          report.push({ engine, viewport: [width, height], surfaces, chrome: anchor, assetSlots, status: 'PASS' })
        } catch (error) {
          await page.screenshot({ path: path.join(artifacts, `${engine}-${width}x${height}-failure.png`) }).catch(() => {})
          throw error
        } finally { await page.close() }
      }
    } finally { await browser.close() }
  }
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ cases: report, assetSources: [...sourceSlots.values()] }, null, 2))
  console.log(JSON.stringify({ status: 'PASS', cases: report.length, surfaces: report.reduce((sum, row) => sum + row.surfaces.length, 0), assetSlots: report.reduce((sum, row) => sum + row.assetSlots.length, 0), assetSources: sourceSlots.size }))
} finally { await server.close() }
