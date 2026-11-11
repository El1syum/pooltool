import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engine = process.env.BROWSER || 'chromium'
const artifacts = process.env.ARTIFACT_DIR || path.resolve(`tests/artifacts/qa-settings-${engine}`)
const server = await createServer({ server: { host: '127.0.0.1', port: 4337, strictPort: true, hmr: false } })
const checks = [], failures = []
let browser
await mkdir(artifacts, { recursive: true })

try {
  await server.listen()
  browser = await playwright[engine].launch({ headless: true,
    ...(engine === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}),
  })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => failures.push(error.message))
  page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  const base = 'http://127.0.0.1:4337/tests/qa-settings.fixture.html'
  const shell = page.locator('.club-settings-shell')
  const content = shell.locator('.club-content')
  const readSettings = async () => JSON.parse(await page.locator('[data-settings]').textContent())
  const openTab = label => shell.getByRole('button', { name: label, exact: true }).click()
  const back = () => shell.getByRole('button', { name: 'Назад', exact: true }).click()
  const parameterLabels = () => shell.locator('.club-parameter > span:first-child').allTextContents()
  const antialiasSelect = () => shell.getByRole('combobox', { name: 'Сглаживание', exact: true })
  const assistBinding = () => shell.getByRole('button', { name: 'Назначение: Дополнительные приборы', exact: true })
  async function checkLockedSelect(name) {
    const select = shell.getByRole('combobox', { name, exact: true })
    assert.ok(await select.isDisabled(), name)
    const appearance = await select.evaluate(node => {
      const style = getComputedStyle(node)
      return { icon: style.backgroundImage, border: style.borderTopStyle, cursor: style.cursor }
    })
    assert.match(appearance.icon, /data:image\/svg\+xml/)
    assert.doesNotMatch(appearance.icon, /chevron/)
    assert.equal(appearance.border, 'dashed')
    assert.equal(appearance.cursor, 'not-allowed')
  }
  async function toggleWithoutTint(name) {
    const toggle = shell.getByRole('switch', { name, exact: true })
    const caption = toggle.locator('span')
    const color = () => caption.evaluate(node => getComputedStyle(node).color)
    const wasOn = await toggle.getAttribute('aria-checked') === 'true'
    assert.equal(await color(), 'rgb(165, 174, 166)')
    await toggle.hover()
    assert.equal(await color(), 'rgb(165, 174, 166)', 'hover does not tint the status label')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), String(!wasOn))
    assert.equal(await caption.textContent(), wasOn ? 'Выкл.' : 'Вкл.')
    assert.equal(await color(), 'rgb(165, 174, 166)', 'click does not tint the status label')
    await page.mouse.move(0, 0)
    assert.equal(await color(), 'rgb(165, 174, 166)')
  }
  const verifyNoExtras = async () => {
    assert.equal(await shell.locator('details').count(), 0)
    for (const label of ['Оформление', 'Модели стола и окружения', 'Сбросить настройки', 'Закрыть без сохранения на сервер']) {
      assert.equal(await shell.getByRole('button', { name: label, exact: true }).count(), 0)
    }
  }
  async function open(query = '') {
    await page.goto(base + query)
    await page.getByRole('button', { name: 'Открыть настройки' }).click()
    await shell.waitFor({ state: 'visible' })
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator('[data-under-settings]').evaluate(el => el.inert), true)
    assert.equal(await shell.evaluate(el => document.activeElement === el), true)
  }
  async function geometry(match, width, height) {
    const info = await shell.evaluate(el => {
      const rect = node => {
        const { x, y, width, height } = node.getBoundingClientRect()
        return { x, y, width, height }
      }
      const content = el.querySelector('.club-content')
      const section = content.querySelector('.club-section')
      const header = el.querySelector('.club-header')
      const footer = el.querySelector('footer')
      const card = section.querySelector('.club-card')
      const note = section.querySelector('.club-settings-actions > .club-small-note')
      const actions = section.querySelector('.club-settings-actions')
      const buttons = [...section.querySelectorAll('.club-actions-inline > .club-action, .club-settings-index-actions > .club-action')].map(button => ({
        ...rect(button), font: getComputedStyle(button).fontSize, color: getComputedStyle(button).color,
      }))
      return {
        tab: el.dataset.settingsTab, shell: rect(el), content: rect(content), section: rect(section),
        header: header && rect(header), footer: rect(footer), card: card && rect(card),
        scrollWidth: content.scrollWidth, contentWidth: content.clientWidth,
        scrollHeight: content.scrollHeight, contentHeight: content.clientHeight,
        noteFont: note && getComputedStyle(note).fontSize, actionGap: actions && getComputedStyle(actions).gap, buttons,
      }
    })
    assert.ok(Math.abs(info.shell.width - width) < .1, JSON.stringify(info.shell))
    assert.ok(Math.abs(info.shell.height - height) < .1, JSON.stringify(info.shell))
    assert.ok(info.scrollWidth <= info.contentWidth + 1, JSON.stringify(info))
    assert.equal(!!info.header, !match)
    assert.ok(info.footer.y + info.footer.height <= height + 1, JSON.stringify(info))
    assert.ok(info.content.y + info.content.height <= info.footer.y + 1, JSON.stringify(info))
    if (info.tab !== 'index') {
      assert.ok(Math.abs(info.buttons[0].height - info.buttons[1].height) < .5)
      assert.equal(info.noteFont, match ? '12px' : '11px')
      assert.equal(info.actionGap, match ? '14px' : '12px')
    } else if (!match) assert.equal(info.buttons.at(-1).height, 48)
    checks.push({ match, width, height, ...info })
    return info
  }
  async function checkImages() {
    await shell.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())))
    const img = await shell.locator('.club-action img, .club-toggle img, .club-binding-value img').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => {
      const rect = node.getBoundingClientRect()
      return { path: new URL(node.src).pathname, rendered: [rect.width, rect.height], natural: [node.naturalWidth, node.naturalHeight] }
    }))
    for (const icon of img) assert.deepEqual(icon.rendered, icon.natural, JSON.stringify(icon))
  }
  await open('?match&renderer')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-match-footer]') !== null), true)
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Графика')
  const frames = { index: [580, 285], graphics: [820, 230], sound: [820, 230], controls: [1180, 215] }
  const clubFrames = { index: [480, 239.5], graphics: [680, 117, 566], sound: [680, 117, 566], controls: [960, 112, 576] }
  function exactClub(info) {
    const [width, y, cardHeight] = clubFrames[info.tab]
    assert.equal(info.section.width, width)
    assert.equal(info.section.x + info.section.width / 2, 720)
    assert.ok(Math.abs(info.section.y - y) < 1.5, JSON.stringify(info.section))
    if (info.card) {
      assert.ok(Math.abs(info.card.y - (y + 130)) < 1.5, JSON.stringify(info.card))
      assert.ok(Math.abs(info.card.height - cardHeight) < 1.5, JSON.stringify(info.card))
      assert.ok(info.card.y + info.card.height <= info.footer.y + 1, 'Entire desktop card fits above the footer')
    }
  }
  const exact = async tab => {
    const info = await geometry(true, 1920, 1080)
    assert.equal(info.tab, tab)
    assert.equal(info.section.width, frames[tab][0])
    assert.equal(info.section.y, frames[tab][1])
    assert.equal(info.section.x + info.section.width / 2, 960)
    assert.ok(info.buttons.every(button => button.height === 66))
    if (info.card) {
      assert.ok(Math.abs(info.card.y - (info.section.y + 138)) < 1, JSON.stringify(info.card))
      assert.equal(info.card.height, tab === 'controls' ? 659 : 594)
      assert.ok(info.card.y + info.card.height <= info.footer.y + 1, 'Entire match desktop card fits above the footer')
    }
    await checkImages()
    await page.screenshot({ path: path.join(artifacts, `match-${tab}.png`) })
  }
  await exact('index')
  await verifyNoExtras()
  await openTab('Графика')
  await exact('graphics')
  assert.deepEqual(await parameterLabels(), ['Режим экрана', 'Разрешение', 'Качество графики', 'Качество теней', 'Сглаживание', 'Частота кадров', 'Вертикальная синхронизация'])
  assert.equal(await antialiasSelect().isEnabled(), true)
  assert.equal(await antialiasSelect().inputValue(), 'auto')
  assert.deepEqual(await antialiasSelect().locator('option').allTextContents(), ['Авто (MSAA)', 'FXAA', 'SMAA'])
  for (const mode of ['fxaa', 'smaa', 'auto']) {
    await antialiasSelect().selectOption(mode)
    assert.equal((await readSettings()).antialiasMode, mode)
  }
  assert.match(await shell.getByRole('combobox', { name: 'Качество графики' }).evaluate(node => getComputedStyle(node).backgroundImage), /chevron-down\.svg/)
  assert.equal(await shell.getByRole('switch', { name: 'Вертикальная синхронизация' }).isDisabled(), true)
  await shell.getByRole('button', { name: 'Настройки матча', exact: true }).click()
  assert.equal(await shell.getAttribute('data-settings-tab'), 'index', 'match footer slot navigates to settings index')
  await openTab('Графика')
  const canvas = page.locator('[data-under-settings] canvas')
  assert.deepEqual(await canvas.evaluate(el => [el.width, el.height]), [640, 360])
  await shell.getByRole('combobox', { name: 'Разрешение' }).selectOption('0.5')
  await shell.getByRole('combobox', { name: 'Качество теней' }).selectOption('off')
  await shell.getByRole('combobox', { name: 'Частота кадров' }).selectOption('30')
  assert.deepEqual(await canvas.evaluate(el => [el.width, el.height]), [320, 180])
  const graphics = await readSettings()
  assert.equal(graphics.renderScale, .5); assert.equal(graphics.shadowQuality, 'off'); assert.equal(graphics.frameRateLimit, 30)
  await verifyNoExtras()
  assert.equal((await readSettings()).showAimGuide, true, 'editing graphics does not change the saved aim-line preference')
  await back()
  await openTab('Звук')
  await exact('sound')
  assert.deepEqual(await parameterLabels(), ['Устройство вывода', 'Общая громкость', 'Музыка клуба', 'Удары и шары', 'Атмосфера зала', 'Уведомления', 'Звук в фоновом режиме'])
  // Actual availability differs between browsers and the machine running the test.
  if (await shell.getByRole('combobox', { name: 'Устройство вывода' }).isDisabled()) await checkLockedSelect('Устройство вывода')
  for (const name of ['Музыка клуба', 'Атмосфера зала', 'Уведомления']) assert.equal(await shell.getByRole('slider', { name }).isDisabled(), true)
  assert.equal(await shell.getByRole('slider', { name: 'Общая громкость' }).evaluate(el => el.getBoundingClientRect().width), 200)
  await toggleWithoutTint('Звук в фоновом режиме')
  assert.equal((await readSettings()).audioInBackground, true)
  const impact = shell.getByRole('slider', { name: 'Удары и шары' })
  await impact.focus()
  await page.keyboard.press('Tab')
  const soundToggle = shell.getByRole('switch', { name: 'Звук в фоновом режиме' })
  assert.ok(await soundToggle.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'))
  assert.equal(await soundToggle.locator('span').evaluate(node => getComputedStyle(node).color), 'rgb(165, 174, 166)')
  await impact.fill('0.33')
  assert.equal((await readSettings()).impactVolume, .33)
  await back()
  await openTab('Управление')
  await exact('controls')
  assert.deepEqual(await parameterLabels(), ['Прицеливание', 'Сила и удар', 'Точка контакта / вращение', 'Наклон кия', 'Приближение камеры', 'Вид сверху', 'Обзор стола', 'Дополнительные приборы', 'Меню матча', 'Чувствительность мыши', 'Инверсия камеры', 'Плавное прицеливание'])
  const bindings = shell.locator('.club-control-bindings')
  assert.equal(await bindings.locator('button.club-binding-value > img[src$="pencil-small.svg"]').count(), 3)
  const staticBindings = await bindings.locator('span.club-binding-value').evaluateAll(nodes => nodes.map(node => ({
    background: getComputedStyle(node).backgroundColor, tabIndex: node.tabIndex, icons: node.querySelectorAll('img').length,
  })))
  assert.equal(staticBindings.length, 6)
  assert.ok(staticBindings.every(value => value.background === 'rgba(0, 0, 0, 0)' && value.tabIndex === -1 && value.icons === 0))
  await toggleWithoutTint('Инверсия камеры')
  await toggleWithoutTint('Плавное прицеливание')
  assert.equal((await readSettings()).invertCamera, true)
  assert.equal((await readSettings()).smoothAim, false)
  await verifyNoExtras()
  await shell.getByRole('button', { name: 'Назначение: Вид сверху', exact: true }).click()
  await page.keyboard.press('KeyH')
  assert.equal((await readSettings()).bindings.topView, 'KeyH')
  assert.equal(await assistBinding().locator('[data-binding-key]').textContent(), 'Ctrl')
  await assistBinding().click()
  assert.equal(await assistBinding().locator('[data-binding-key]').textContent(), 'Нажмите клавишу…')
  await page.keyboard.press('KeyJ')
  assert.equal((await readSettings()).bindings.assist, 'KeyJ')
  assert.equal(await assistBinding().locator('[data-binding-key]').textContent(), 'J')
  await shell.getByRole('button', { name: 'Применить', exact: true }).click()
  await shell.waitFor({ state: 'hidden' })
  assert.equal(await page.locator('[data-under-settings]').evaluate(el => el.inert), false)
  await page.waitForFunction(() => document.activeElement.classList.contains('hud-match-menu'))
  assert.equal(await page.locator('[data-saved]').textContent(), '1')
  await open('?error')
  assert.equal(await shell.getByRole('alert').innerText(), 'Не удалось сохранить настройки.')
  await openTab('Графика')
  assert.equal(await shell.getByRole('alert').innerText(), 'Не удалось сохранить настройки.')
  await page.keyboard.press('Escape')
  await shell.waitFor({ state: 'hidden' })
  for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 568], [640, 320]]) {
    await page.setViewportSize({ width, height })
    for (const match of [false, true]) {
      await open(match ? '?match' : '')
      const start = await geometry(match, width, height)
      if (!match) {
        assert.match(await shell.locator('.club-account small').textContent(), /1\s000 Эло/)
        if (width === 1440) {
          exactClub(start)
          await checkImages()
          await page.screenshot({ path: path.join(artifacts, 'club-index.png') })
        }
      }
      for (const label of ['Графика', 'Звук', 'Управление']) {
        await openTab(label)
        const state = await geometry(match, width, height)
        assert.deepEqual(state.header, start.header)
        assert.deepEqual(state.footer, start.footer)
        assert.ok(await shell.getByRole('button', { name: match || label === 'Графика' ? 'Применить' : 'Сохранить', exact: true }).count())
        if (label === 'Графика') assert.equal(await antialiasSelect().isEnabled(), true)
        if (label === 'Управление') assert.equal(await assistBinding().locator('[data-binding-key]').textContent(), 'Ctrl')
        if (!match && width === 1440) {
          exactClub(state)
          await checkImages()
          await page.screenshot({ path: path.join(artifacts, `club-${state.tab}.png`) })
        }
        await back()
        assert.equal(await content.evaluate(el => el.scrollTop), 0)
      }
      if (!match) {
        await shell.getByRole('button', { name: 'Главное меню', exact: true }).click()
        assert.equal(await page.locator('[data-home]').textContent(), 'true')
      } else {
        await shell.getByRole('button', { name: 'Назад к меню матча', exact: true }).click()
      }
      await shell.waitFor({ state: 'hidden' })
    }
  }
  assert.deepEqual(failures, [])
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ engine, status: 'PASS', checks, failures }, null, 2))
  console.log(JSON.stringify({ engine, status: 'PASS', geometryChecks: checks.length, jsOrAssetErrors: failures.length }))
} finally {
  await browser?.close()
  await server.close()
}
