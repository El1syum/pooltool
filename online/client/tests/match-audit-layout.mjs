// Real Vue HUD/CSS only: Figma desktop slots and responsive non-overlap.
// The fixture does not stub or claim to exercise server physics or App dialogs.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const moduleUrl = value => path.isAbsolute(value) ? pathToFileURL(value).href : value
const playwright = await import(moduleUrl(process.env.PLAYWRIGHT_MODULE || 'playwright'))
const engine = process.env.BROWSER || 'chromium'
const artifacts = path.resolve(process.env.ARTIFACT_DIR || 'tests/artifacts/match-audit-layout', engine)
await mkdir(artifacts, { recursive: true })
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 4326, strictPort: true } })
const viewports = [
  [1920, 1080], [1841, 900], [1840, 900], [1800, 900], [1760, 900], [1741, 900],
  [1440, 900], [1024, 768], [844, 390], [760, 360], [568, 320], [500, 320],
  [390, 844], [390, 640], [320, 568],
].map(([width, height]) => ({ width, height }))
const mobileViewports = [320, 360, 375, 390, 414, 480].flatMap(width =>
  [568, 640, 667, 736, 760, 761, 844, 900].map(height => ({ width, height })))
const states = [
  { name: 'heading', phase: 'overview', cameraMode: 'cue', showAssist: false },
  { name: 'heading-assist', phase: 'overview', cameraMode: 'cue', showAssist: true },
  { name: 'contact', phase: 'aim', cameraMode: 'cue', showAssist: false },
  { name: 'contact-assist', phase: 'aim', cameraMode: 'cue', showAssist: true },
  { name: 'power', phase: 'power', cameraMode: 'cue', showAssist: false },
  { name: 'power-assist', phase: 'power', cameraMode: 'cue', showAssist: true },
  { name: 'overview', phase: 'overview', cameraMode: 'free', showAssist: true },
  { name: 'spectator', phase: 'overview', cameraMode: 'free', showAssist: true, userId: 'spectator', canShoot: false },
  { name: 'calculating', phase: 'overview', cameraMode: 'cue', showAssist: true, status: 'calculating', canShoot: false },
  { name: 'placement', phase: 'overview', cameraMode: 'free', showAssist: true, canShoot: false, canPlace: true },
  { name: 'finished', phase: 'power', cameraMode: 'cue', showAssist: true, status: 'finished', canShoot: false },
]
const selectors = [
  '.hud-identity', '.hud-match-menu', '.hud-player', '.hud-clock', '.hud-match-status', '.hud-stage-instruction',
  '.assist-card', '.hud-footer', '.hud-target-caption', '.hud-contact-caption', '.hud-direction-control > span',
  '.hud-ball-legend', '.hud-phase-hint', '.hud-power-gauge', '.hud-power-number', '.hud-speed-number',
]
let browser
const errors = []
const checks = []
try {
  await server.listen()
  browser = await playwright[engine].launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await page.goto('http://127.0.0.1:4326/tests/match-assist-fixture.html')
  await page.waitForFunction(() => window.fixtureReady)
  await page.evaluate(async () => {
    // Apply the actual ancestor that hides quiet match statuses in production.
    document.body.classList.add('in-match')
    await document.fonts.ready
  })
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0))

  async function state(value) {
    await page.evaluate(value => {
      const fixture = window.assistFixture
      Object.assign(fixture, {
        phase: value.phase, cameraMode: value.cameraMode, showAssist: value.showAssist,
        user: { id: value.userId || 'a' }, canShoot: value.canShoot ?? true,
        canPlace: value.canPlace || false, statusText: value.name === 'spectator' ? 'Наблюдение за матчем' : value.status === 'calculating' ? 'Расчёт удара' : 'Ваш ход',
      })
      fixture.match.status = value.status || 'active'
      Object.assign(fixture.aim, { V0: 4.1, theta: 30, a: 0, b: 0, ...value.aim })
    }, value)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  async function geometry() {
    return page.evaluate(selectors => {
      const nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)].map((node, index) => {
        const rect = node.getBoundingClientRect()
        let visible = true
        for (let ancestor = node; ancestor instanceof Element; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor)
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= .001) visible = false
        }
        return { selector: `${selector}[${index}]`, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height, visible }
      })).filter(rect => rect.width > 1 && rect.height > 1)
      const outside = nodes.filter(rect => rect.left < -.25 || rect.right > innerWidth + .25 || rect.top < -.25 || rect.bottom > innerHeight + .25)
      const intersections = []
      for (let left = 0; left < nodes.length; left++) for (let right = left + 1; right < nodes.length; right++) {
        const a = nodes[left], b = nodes[right]
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (width > .5 && height > .5) intersections.push({ a: a.selector, b: b.selector, width, height })
      }
      const blockedControls = [...document.querySelectorAll('.hud-root button:not(:disabled), .hud-root input:not(:disabled), .assist-cue-face[aria-disabled="false"]')].flatMap(node => {
        const rect = node.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return []
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return hit && (hit === node || node.contains(hit)) ? [] : [{ label: node.getAttribute('aria-label') || node.textContent?.trim(), rect: rect.toJSON(), hit: hit?.className || hit?.tagName || null }]
      })
      const target = document.querySelector('.hud-contact-reticle, .hud-power-reticle')?.getBoundingClientRect()
      const contactCore = target ? { left: target.left + target.width / 2 - 24, right: target.left + target.width / 2 + 24, top: target.top + target.height / 2 - 24, bottom: target.top + target.height / 2 + 24 } : null
      const coreOcclusions = contactCore ? nodes.filter(node => (node.selector.startsWith('.assist-card[') || node.selector.startsWith('.hud-contact-caption['))
        && Math.min(node.right, contactCore.right) - Math.max(node.left, contactCore.left) > 1
        && Math.min(node.bottom, contactCore.bottom) - Math.max(node.top, contactCore.top) > 1) : []
      const caption = document.querySelector('.hud-contact-caption')
      let contactCaption = null
      if (caption) {
        const rect = caption.getBoundingClientRect(), style = getComputedStyle(caption)
        const range = document.createRange(); range.selectNodeContents(caption)
        const textLines = [...range.getClientRects()].map(line => ({ left: line.left, right: line.right, top: line.top, bottom: line.bottom }))
        contactCaption = { parentIsRoot: caption.parentElement.matches('.hud-root'), width: rect.width,
          fontSize: Number.parseFloat(style.fontSize), effectiveFontSize: Number.parseFloat(style.fontSize) * rect.width / Number.parseFloat(style.width),
          pointerEvents: style.pointerEvents, textLines,
          clippedLines: textLines.filter(line => line.left < rect.left - 1 || line.right > rect.right + 1 || line.top < rect.top - 1 || line.bottom > rect.bottom + 1) }
      }
      return { nodes, outside, intersections, blockedControls, contactCore, coreOcclusions, contactCaption, oldNestedCaptions: document.querySelectorAll('.hud-contact-annotation > span').length, invisible: nodes.filter(node => !node.visible), horizontalOverflow: document.documentElement.scrollWidth > innerWidth }
    }, selectors)
  }
  function clear(layout, label) {
    assert.deepEqual(layout.outside, [], `Everything must fit: ${label}: ${JSON.stringify(layout.outside)}`)
    assert.deepEqual(layout.intersections, [], `Independent HUD blocks must not intersect: ${label}: ${JSON.stringify(layout.intersections)}`)
    assert.deepEqual(layout.invisible, [], `Do not hide HUD blocks to fit: ${label}: ${JSON.stringify(layout.invisible)}`)
    assert.deepEqual(layout.blockedControls, [], `Visible controls must be hit-testable: ${label}: ${JSON.stringify(layout.blockedControls)}`)
    assert.deepEqual(layout.coreOcclusions, [], `Side cards and caption must clear the entire 48px contact core: ${label}: ${JSON.stringify({ blocks: layout.coreOcclusions, contactCore: layout.contactCore })}`)
    assert.equal(layout.oldNestedCaptions, 0, `Do not retain a duplicate scaled caption: ${label}`)
    if (layout.contactCaption) {
      assert.equal(layout.contactCaption.parentIsRoot, true, `Caption must be outside transformed reticle/annotation groups: ${label}`)
      assert.ok(layout.contactCaption.fontSize >= 10 && layout.contactCaption.effectiveFontSize >= 9.99, `Readable contact caption, at least 10 effective px: ${label}: ${JSON.stringify(layout.contactCaption)}`)
      assert.equal(layout.contactCaption.pointerEvents, 'none', `Contact caption must not intercept scene input: ${label}`)
      assert.deepEqual(layout.contactCaption.clippedLines, [], `Contact description must not clip: ${label}: ${JSON.stringify(layout.contactCaption)}`)
    }
    assert.equal(layout.horizontalOverflow, false, `No page overflow: ${label}`)
  }

  const focusedStates = states.filter(value => ['contact', 'contact-assist', 'power', 'power-assist'].includes(value.name))
  const stressProfiles = [{ a: .56, b: .56 }, { a: .8, b: 0 }, { a: 0, b: -.8 }].flatMap(spin =>
    [.2, 8].flatMap(V0 => [0, 60].map(theta => ({ ...spin, V0, theta }))))
  const stressViewports = [{ width: 320, height: 568 }, { width: 320, height: 640 }, { width: 320, height: 844 }, { width: 390, height: 844 }]
  const cases = [...viewports.map(viewport => ({ viewport, values: states, matrix: 'base' })),
    ...mobileViewports.map(viewport => ({ viewport, values: focusedStates, matrix: 'mobile-contact-power' })),
    ...stressViewports.map(viewport => ({ viewport, matrix: 'mobile-shot-value-stress', values: stressProfiles.flatMap((aim, index) => focusedStates.map(value => ({ ...value, aim, sample: `values-${index}` }))) }))]
  for (const { viewport, values, matrix } of cases) {
    await page.setViewportSize(viewport)
    for (const value of values) {
      await state(value)
      const layout = await geometry()
      const label = `${viewport.width}x${viewport.height} ${value.name}`
      clear(layout, label)
      const expectedMeters = value.phase === 'power' && value.status !== 'finished' ? 2 : 0
      assert.equal(await page.getByRole('meter').count(), expectedMeters, `Both live meters must stay present without Ctrl: ${label}`)
      assert.equal(layout.nodes.filter(node => node.selector.startsWith('.hud-power-gauge[')).length, expectedMeters, `Both meters must have rendered bounds: ${label}`)
      assert.equal(layout.nodes.filter(node => node.selector.startsWith('.hud-power-number[') || node.selector.startsWith('.hud-speed-number[')).length, expectedMeters, `Both meter labels must remain rendered: ${label}`)
      const expectedCards = value.showAssist && value.userId !== 'spectator' && !value.canPlace && !value.status ? value.phase === 'power' ? 3 : value.phase === 'aim' ? 1 : 0 : 0
      assert.equal(await page.locator('.assist-card').count(), expectedCards, `Do not hide required assist cards to fit: ${label}`)
      assert.equal(layout.nodes.filter(node => node.selector.startsWith('.assist-card[')).length, expectedCards, `Every required assist card must have rendered bounds: ${label}`)
      assert.equal(await page.locator('.hud-contact-caption').count(), value.name === 'contact-assist' ? 1 : 0, `A single contact description appears only with contact assistance: ${label}`)
      checks.push({ viewport, state: value.name, matrix, aim: value.aim || null, blocks: layout.nodes.length, meters: expectedMeters, cards: expectedCards, contactCoreClear: true, caption: layout.contactCaption })
      if (value.name === 'power-assist' && [1920, 844, 568, 320].includes(viewport.width)) {
        await page.screenshot({ path: path.join(artifacts, `${viewport.width}x${viewport.height}-power${value.sample ? `-${value.sample}` : ''}.png`) })
      }
    }
  }

  // Source-of-truth desktop slots from the fresh full Figma contexts. Dynamic
  // game text and the real 3D camera are not replaced with reference screenshots.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await state(states.find(value => value.name === 'power-assist'))
  const slots = await page.evaluate(() => Object.fromEntries([
    ['.hud-identity', [40, 36, null, 42]], ['.hud-match-menu', [1700, 36, 180, 44]],
    ['.hud-clock', [836, 51, 248, 86]], ['.hud-stage-instruction', [40, 220, 320, null]],
    ['.assist-power', [42, 466.02, 294, null]], ['.assist-elevation', [1570, 280.04, 310, null]],
    ['.assist-contact', [1630, 649.94, 250, null]],
  ].map(([selector, expected]) => {
    const rect = document.querySelector(selector).getBoundingClientRect()
    return [selector, { actual: [rect.left, rect.top, rect.width, rect.height], expected }]
  })))
  for (const [selector, { actual, expected }] of Object.entries(slots)) expected.forEach((value, index) => {
    if (value !== null) assert.ok(Math.abs(actual[index] - value) < .1, `Keep the 1920 Figma slot ${selector}[${index}]: ${actual[index]} vs ${value}`)
  })
  const svgRoots = await page.locator('.assist-range svg, .assist-elevation-slot > svg').evaluateAll(nodes => nodes.map(node => [node.getAttribute('width'), node.getAttribute('height')]))
  assert.deepEqual(svgRoots, [['182', '20'], ['262', '70'], ['192', '16']], 'Original SVG root dimensions are unchanged')
  const desktopContactCaptions = []
  for (const [a, b] of [[.25, -.2], [.56, .56], [.8, 0], [-.8, 0], [0, .8], [0, -.8]]) {
    await state({ ...states.find(value => value.name === 'contact-assist'), aim: { a, b } })
    const caption = await page.locator('.hud-contact-caption').evaluate(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      return { left: rect.left, top: rect.top, width: rect.width, fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight) }
    })
    assert.ok(Math.abs(caption.left - (960 + 72 + a * 77)) < .1, `Keep exact desktop contact-caption X: ${JSON.stringify({ a, b, caption })}`)
    assert.ok(Math.abs(caption.top - (540 + 69 - b * 77)) < .1, `Keep exact desktop contact-caption Y: ${JSON.stringify({ a, b, caption })}`)
    assert.equal(caption.width, 265)
    assert.equal(caption.fontSize, 14)
    assert.equal(caption.lineHeight, 17)
    desktopContactCaptions.push({ a, b, ...caption })
  }

  // The wrappers must retain keyboard input and fixed direction/contact policy.
  await page.setViewportSize({ width: 568, height: 320 })
  await state(states.find(value => value.name === 'power-assist'))
  await page.getByRole('slider', { name: 'Сила удара Ctrl', exact: true }).focus()
  await page.keyboard.press('Home')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), .2)
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.V0), 8)
  await page.getByRole('slider', { name: 'Наклон кия Ctrl', exact: true }).focus()
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.theta), 60)
  await state(states.find(value => value.name === 'contact-assist'))
  await page.getByRole('slider', { name: 'Точка контакта на схеме битка', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => window.assistFixture.aim.a), .05)
  assert.equal(await page.evaluate(() => window.assistFixture.aim.phi), 90)

  // Negative controls prove the intersection gate rejects the two old layout
  // regressions instead of passing merely because all nodes have bounds.
  await page.setViewportSize({ width: 1741, height: 900 })
  await state(states.find(value => value.name === 'overview'))
  const desktopRegression = await page.addStyleTag({ content: '.hud-modern:not(.hud-compact) .hud-scoreboard { left:50%; top:0; transform:translateX(-50%); width:1440px; height:176px; padding:26px 48px 20px; grid-template-columns:500px 248px 500px; gap:0; } .hud-modern:not(.hud-compact) .hud-player { height:130px; }' })
  assert.ok((await geometry()).intersections.some(value => value.a.startsWith('.hud-identity') || value.a.startsWith('.hud-match-menu')), 'Reject the original late desktop breakpoint')
  await desktopRegression.evaluate(node => node.remove())
  clear(await geometry(), 'desktop negative-control cleanup')
  await page.setViewportSize({ width: 568, height: 320 })
  await state(states.find(value => value.name === 'power-assist'))
  const shortRegression = await page.addStyleTag({ content: '.hud-modern .assist-elevation { top:160px; }' })
  assert.ok((await geometry()).intersections.some(value => value.a.startsWith('.assist-card') && value.b.startsWith('.hud-footer')), 'Reject the old short-screen elevation/footer collision')
  await shortRegression.evaluate(node => node.remove())
  clear(await geometry(), 'short-screen negative-control cleanup')
  await page.setViewportSize({ width: 320, height: 640 })
  await state(states.find(value => value.name === 'contact-assist'))
  const coreRegression = await page.addStyleTag({ content: '.hud-modern .assist-contact:not(.assist-contact-lower) { top:196px; }' })
  assert.equal((await geometry()).coreOcclusions.length, 1, 'Reject the original 320x640 contact-assist overlap even when the exact center is still clickable')
  await coreRegression.evaluate(node => node.remove())
  clear(await geometry(), 'contact-core negative-control cleanup')
  const tinyCaption = await page.addStyleTag({ content: '.hud-contact-caption { font-size:14px; transform:scale(.26); transform-origin:top left; }' })
  const unreadableCaption = await geometry()
  assert.ok(unreadableCaption.contactCaption.effectiveFontSize < 4, 'Reproduce the former 14px × .52 × .5 caption shrink')
  assert.throws(() => clear(unreadableCaption, 'tiny caption negative control'), assert.AssertionError, 'Reject a caption that is present but unreadable')
  await tinyCaption.evaluate(node => node.remove())
  clear(await geometry(), 'contact-caption negative-control cleanup')
  assert.deepEqual(errors, [])
  const report = { engine, checks, desktopSlots: slots, desktopContactCaptions, sourceSvgRoots: svgRoots, keyboardControls: true, negativeControls: 4, errors }
  await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ engine, checks: checks.length, mobileViewports: mobileViewports.length, contactCore: 48, desktopSlots: Object.keys(slots).length, desktopContactCaptions: desktopContactCaptions.length, minimumCaptionPx: 10, negativeControls: 4, errors: errors.length }))
} finally {
  await browser?.close()
  await server.close()
}
