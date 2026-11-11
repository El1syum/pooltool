// Actual App and SQLite API. This test creates disposable guests; never target
// a public service or real user credentials.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { waitForConnectedHome } from './app-state.mjs'

const origin = new URL(process.env.POOLTOOL_URL || 'http://127.0.0.1:8791')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use an isolated loopback test service')
const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const engines = (process.env.BROWSERS || 'chromium,webkit').split(',')
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/qa-profile-persistence-20261111')
await mkdir(artifacts, { recursive: true })

async function profile(token) {
  const response = await fetch(new URL('/api/me', origin), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, 'Read the disposable account from the server')
  return (await response.json()).user
}

async function openProfile(page) {
  await page.getByRole('button', { name: 'Профиль', exact: true }).click()
  await page.getByRole('heading', { name: 'Ваш профиль', exact: true }).waitFor()
}

const textbox = (page, name) => page.getByRole('textbox', { name, exact: true })
const save = page => page.getByRole('button', { name: 'Сохранить профиль', exact: true })
const saved = page => page.getByText('Профиль сохранён', { exact: true })
const applySettings = settings => settings.getByRole('button', { name: /^(Сохранить|Применить)( настройки)?$/u })

async function openSound(page) {
  await page.getByRole('button', { name: 'Настройки', exact: true }).click()
  const settings = page.locator('.club-settings-shell')
  await settings.getByRole('button', { name: 'Звук', exact: true }).click()
  return settings
}

async function setVolumeEndpoint(page, settings, key) {
  await settings.getByRole('slider', { name: 'Общая громкость', exact: true }).focus()
  await page.keyboard.press(key)
}

for (const engine of engines) {
  const browser = await playwright[engine].launch()
  const errors = []
  let page
  function monitor(current) {
    current.on('pageerror', error => errors.push(error.message))
    current.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if (response.status() >= 400 && /\.(?:png|svg|js|css|webp|woff2?)$/u.test(pathname)) errors.push(`${response.status()} ${pathname}`)
    })
  }
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    monitor(page)
    await page.goto(origin.href)
    await waitForConnectedHome(page)
    const token = await page.evaluate(() => localStorage.getItem('pooltool.token'))
    assert.ok(token, 'The fresh browser has a guest session')
    const initial = await profile(token)
    for (const field of ['fullName', 'city', 'about']) assert.equal(initial.settings.profileDetails?.[field] ?? '', '', 'New guest has no previously entered private profile')

    // Open a second, genuinely stale settings page before any profile edit.
    const stale = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    monitor(stale)
    await stale.addInitScript(value => localStorage.setItem('pooltool.token', value), token)
    await stale.goto(origin.href)
    await waitForConnectedHome(stale)
    const staleSound = await openSound(stale)
    await staleSound.getByRole('slider', { name: 'Общая громкость', exact: true }).waitFor()

    await openProfile(page)
    const details = { fullName: 'Проверка профиля', city: 'Київ', about: 'Точная игра\nВторая строка' }
    const nickname = `QA ${engine} profile`
    await textbox(page, 'Имя игрока').fill(nickname)
    await textbox(page, 'Имя').fill(` ${details.fullName} `)
    await textbox(page, 'Город').fill(details.city + '\u202e')
    await textbox(page, 'О себе').fill(details.about)
    await save(page).click()
    await saved(page).waitFor()
    let actual = await profile(token)
    assert.equal(actual.displayName, nickname)
    assert.deepEqual(actual.settings.profileDetails, details)
    const cache = await page.evaluate(id => localStorage.getItem(`pooltool.settings.${id}`), actual.id)
    assert.ok(cache, 'Game settings cache is populated')
    assert.equal(Object.hasOwn(JSON.parse(cache), 'profileDetails'), false)
    for (const value of Object.values(details)) assert.equal(cache.includes(value), false, 'Private profile text must not enter the game settings cache')

    // The API rejection must not be reported as a successful save. Retrying
    // uses the unmodified real service, not a fixture response.
    const nextCity = 'Львів'
    await textbox(page, 'Город').fill(nextCity)
    assert.equal(await saved(page).count(), 0, 'Editing clears the prior saved status')
    const pattern = '**/api/me/settings'
    const injectedFailure = route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Проверка повторного сохранения' }) })
      : route.continue()
    await page.route(pattern, injectedFailure)
    try {
      const rejection = page.waitForResponse(response => new URL(response.url()).pathname === '/api/me/settings' && response.request().method() === 'PUT' && response.status() === 503)
      await save(page).click()
      await rejection
      await page.getByRole('alert').filter({ hasText: 'Проверка повторного сохранения' }).waitFor()
      await page.getByText('Изменения ещё не сохранены', { exact: true }).waitFor()
      assert.equal(await saved(page).count(), 0)
      assert.equal((await profile(token)).settings.profileDetails.city, details.city)
      assert.equal(await textbox(page, 'Город').inputValue(), nextCity)
    } finally { await page.unroute(pattern, injectedFailure) }
    await save(page).click()
    await saved(page).waitFor()
    details.city = nextCity
    assert.deepEqual((await profile(token)).settings.profileDetails, details)

    // A settings save from the already-open tab must not replace newer private
    // fields with its older empty snapshot on the legacy whole-object API.
    await setVolumeEndpoint(stale, staleSound, 'End')
    const staleWrite = stale.waitForResponse(response => new URL(response.url()).pathname === '/api/me/settings'
      && response.request().method() === 'PUT' && response.request().postDataJSON()?.volume === 1)
    await applySettings(staleSound).click()
    const staleResponse = await staleWrite
    assert.equal(staleResponse.status(), 200)
    assert.deepEqual(staleResponse.request().postDataJSON().profileDetails, details)
    await staleSound.waitFor({ state: 'hidden' })
    actual = await profile(token)
    assert.equal(actual.settings.volume, 1)
    assert.deepEqual(actual.settings.profileDetails, details)
    await stale.close()

    // Restore from the server in another browser context with the token only.
    const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } })
    monitor(fresh)
    await fresh.addInitScript(value => localStorage.setItem('pooltool.token', value), token)
    await fresh.goto(origin.href)
    await waitForConnectedHome(fresh)
    await openProfile(fresh)
    assert.equal(await textbox(fresh, 'Имя игрока').inputValue(), nickname)
    assert.equal(await textbox(fresh, 'Имя').inputValue(), details.fullName)
    assert.equal(await textbox(fresh, 'Город').inputValue(), details.city)
    assert.equal(await textbox(fresh, 'О себе').inputValue(), details.about)
    await fresh.screenshot({ path: path.join(artifacts, `${engine}-profile-restored.png`) })
    await textbox(fresh, 'Город').fill('Не сохранять этот черновик')
    await fresh.getByRole('button', { name: 'Назад', exact: true }).click()
    await waitForConnectedHome(fresh)

    // Both edits and resetting of graphics/audio settings must keep profile
    // data; this also proves a PUT from the settings screen is namespaced.
    const editSound = async reset => {
      const settings = await openSound(fresh)
      if (reset) await settings.getByRole('button', { name: 'Сбросить настройки', exact: true }).click()
      else await setVolumeEndpoint(fresh, settings, 'Home')
      await applySettings(settings).click()
      await settings.waitFor({ state: 'hidden' })
      const result = await profile(token)
      assert.equal(result.settings.volume, reset ? 0.5 : 0)
      assert.deepEqual(result.settings.profileDetails, details)
    }
    await editSound(false)
    await editSound(true)
    await openProfile(fresh)
    assert.equal(await textbox(fresh, 'Город').inputValue(), details.city)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ engine, actualApi: true, saveAndFreshContext: true, rejectedSaveAndRetry: true, unsavedDraftDiscarded: true, settingsAndResetPreserved: true, staleTabPreserved: true, noPrivateTextInSettingsCache: true, errors }))
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(artifacts, `${engine}-profile-persistence-failure.png`) }).catch(() => {})
    throw error
  } finally { await browser.close() }
}
