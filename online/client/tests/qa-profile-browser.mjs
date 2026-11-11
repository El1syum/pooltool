import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/qa-profile-20261111')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ server: { host: '127.0.0.1', port: 4353, strictPort: true } })

try {
  await server.listen()
  for (const engine of engines) {
    const browser = await playwright[engine].launch()
    const errors = []
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
      page.on('pageerror', error => errors.push(error.message))
      page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
      await page.goto('http://127.0.0.1:4353/tests/qa-profile.fixture.html')
      await page.getByRole('textbox', { name: 'О себе', exact: true }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      const fields = [
        ['Имя игрока', 'Изменить псевдоним', 'club-profile-display-name', 'pencil-small.svg'],
        ['Имя', 'Изменить имя', 'club-profile-full-name', 'pencil-small.svg'],
        ['Город', 'Изменить город', 'club-profile-city', 'pencil-small.svg'],
        ['О себе', 'Изменить описание', 'club-profile-about', 'pencil-about.svg'],
      ]
      for (const [label, action, id, file] of fields) {
        const button = page.getByRole('button', { name: action, exact: true })
        await button.focus()
        await page.keyboard.press('Enter')
        assert.equal(await page.evaluate(() => document.activeElement?.id), id)
        assert.equal(await page.getByRole('textbox', { name: label, exact: true }).getAttribute('id'), id)
        assert.deepEqual(await button.locator('img').evaluate(async img => {
          await img.decode()
          const rect = img.getBoundingClientRect(), field = img.closest('.club-profile-value').getBoundingClientRect()
          return { file: img.src.split('/').at(-1), native: [img.naturalWidth, img.naturalHeight], slot: [rect.width, rect.height], inset: field.right - rect.right }
        }), { file, native: [13, 13], slot: [13, 13], inset: 15 })
      }
      const avatarEdit = page.getByRole('button', { name: 'Редактировать профиль' })
      assert.deepEqual(await avatarEdit.locator('img').evaluate(async img => {
        await img.decode()
        const rect = img.getBoundingClientRect(), status = img.closest('.club-profile-person').querySelector('div').getBoundingClientRect()
        return { native: [img.naturalWidth, img.naturalHeight], slot: [rect.width, rect.height], spacing: rect.left - status.right }
      }), { native: [16, 16], slot: [16, 16], spacing: 16 })
      assert.deepEqual(await page.locator('.club-profile-rating > img').evaluate(async img => {
        await img.decode()
        const rect = img.getBoundingClientRect(), label = img.nextElementSibling.getBoundingClientRect()
        return { file: img.src.split('/').at(-1), native: [img.naturalWidth, img.naturalHeight], slot: [rect.width, rect.height], spacing: label.left - rect.right }
      }), { file: 'profile-trophy.svg', native: [30, 30], slot: [30, 30], spacing: 14 })
      await avatarEdit.click()
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'club-profile-display-name')
      assert.deepEqual(await page.locator('.club-profile-field .club-profile-value').evaluateAll(nodes => nodes.map(node => [node.clientWidth + 2, node.clientHeight + 2])), [[260, 42], [260, 42], [260, 42]])

      await page.getByRole('textbox', { name: 'Имя игрока', exact: true }).fill('Новый псевдоним')
      await page.getByRole('textbox', { name: 'Имя', exact: true }).fill('Олександр Коваль')
      await page.getByRole('textbox', { name: 'Город', exact: true }).fill('Київ\u202e')
      const about = '<img id="unsafe-profile-probe">\nЛюблю бильярд'
      await page.getByRole('textbox', { name: 'О себе', exact: true }).fill(about)
      assert.deepEqual(await page.evaluate(() => ({ name: window.qaProfile.name, ...window.qaProfile.details })), { name: 'Новый псевдоним', fullName: 'Олександр Коваль', city: 'Київ', about })
      assert.equal(await page.locator('#unsafe-profile-probe').count(), 0, 'profile text must never become markup')
      const expanded = await page.locator('#club-profile-about').boundingBox()
      assert.ok(expanded.height >= 39, `a multiline biography grows without a resize handle: ${JSON.stringify(expanded)}`)
      await page.getByRole('textbox', { name: 'О себе', exact: true }).fill('Точная игра')
      assert.equal((await page.locator('#club-profile-about').boundingBox()).height, 19.5)
      assert.equal(await page.getByRole('textbox', { name: 'Город', exact: true }).inputValue(), 'Київ')
      await page.getByRole('button', { name: 'Сохранить профиль', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.qaProfile.saved), { name: 'Новый псевдоним', fullName: 'Олександр Коваль', city: 'Київ', about: 'Точная игра' })

      const meter = page.getByRole('meter', { name: 'Прогресс рейтинга' })
      assert.equal(await meter.getAttribute('aria-valuemin'), '1200')
      assert.equal(await meter.getAttribute('aria-valuemax'), '1300')
      assert.equal(await meter.getAttribute('aria-valuenow'), '1240')
      assert.match(await meter.getAttribute('aria-valuetext'), /^До 1\s300 Эло осталось 60$/u)
      const track = await meter.boundingBox(), fill = await meter.locator('span').boundingBox()
      assert.equal(track.height, 4)
      assert.ok(Math.abs(fill.width / track.width - .4) < .002, JSON.stringify({ track, fill }))
      await page.mouse.move(0, 0)
      await page.screenshot({ path: path.join(artifacts, `${engine}-profile-fields-1440.png`) })

      await page.evaluate(() => window.qaProfile.user.elo = 1300)
      assert.equal(await meter.getAttribute('aria-valuemin'), '1300')
      assert.equal(await meter.getAttribute('aria-valuemax'), '1400')
      assert.equal(await meter.locator('span').evaluate(node => node.getBoundingClientRect().width), 0)

      for (const width of [760, 390, 320]) {
        await page.setViewportSize({ width, height: 640 })
        const bounds = await page.locator('.club-profile-value').evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect(), pencil = node.querySelector('button').getBoundingClientRect()
          return [box.left, box.right, pencil.left, pencil.right]
        }))
        assert.ok(bounds.every(([left, right, pencilLeft, pencilRight]) => left >= 0 && right <= width && pencilLeft >= left && pencilRight <= right), JSON.stringify({ width, bounds }))
        assert.equal(await page.locator('.club-shell').evaluate(node => node.scrollWidth > node.clientWidth), false)
      }
      const bio = page.getByRole('textbox', { name: 'О себе', exact: true })
      await bio.fill('Я'.repeat(300))
      assert.equal(await bio.evaluate(node => node.clientHeight <= 180 && node.scrollHeight >= node.clientHeight && node.value.length === 300), true)
      await bio.fill('Точная игра')
      await page.screenshot({ path: path.join(artifacts, `${engine}-profile-fields-320.png`) })
      await page.evaluate(() => window.qaProfile.disabled = true)
      assert.equal(await page.locator('.club-profile-fields input:disabled, .club-profile-fields textarea:disabled, .club-profile-fields button:disabled').count(), 8)
      assert.deepEqual(errors, [])
      console.log(JSON.stringify({ engine, exactPencilSlots: 5, focusActions: 5, dataFields: 4, formSubmit: true, ratingMilestone: true, responsiveWidths: [1440, 760, 390, 320], errors }))
    } finally { await browser.close() }
  }
} finally { await server.close() }
