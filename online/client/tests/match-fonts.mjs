import { mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const modulePath = process.env.PLAYWRIGHT_MODULE || 'playwright'
const playwright = await import(path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath)
const base = process.env.POOLTOOL_URL || 'http://127.0.0.1:8790'
const artifacts = process.env.ARTIFACT_DIR || path.resolve('tests/artifacts/match-hud')
await mkdir(artifacts, { recursive: true })
const html = await (await fetch(base)).text()
const css = html.match(/href="([^"]+\.css)"/)?.[1]
if (!css) throw new Error('No compiled stylesheet')
for (const engineName of (process.env.BROWSERS || 'chromium,webkit').split(',')) {
  const browser = await playwright[engineName].launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const consoleMessages = []
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push(message.text()) })
    await page.goto(`${base}/ready`)
    const cases = [
      ['regular', 'font-weight:400'], ['semibold', 'font-weight:600'],
      ['explicitWght600', 'font-weight:600;font-variation-settings:"wght" 600'],
      ['opsz14', 'font-weight:600;font-variation-settings:"wght" 600,"opsz" 14'],
      ['opsz19', 'font-weight:600;font-variation-settings:"wght" 600,"opsz" 19'],
      ['opticalNone', 'font-weight:600;font-optical-sizing:none'],
      ['weight700', 'font-weight:700'], ['system600', 'font-family:Arial,sans-serif;font-weight:600'],
      ['variableFormatHint', 'font-family:"Inter VF Hint";font-weight:600'],
      ['staticFaceHint', 'font-family:"Inter VF Face";font-weight:600;font-variation-settings:"wght" 600'],
    ]
    await page.setContent(`<!doctype html><html><head><base href="${base}/"><link rel="stylesheet" href="${css}"><style>@font-face{font-family:"Inter VF Hint";src:url('/fonts/Inter-Variable.ttf') format('truetype-variations');font-weight:100 900}@font-face{font-family:"Inter VF Face";src:url('/fonts/Inter-Variable.ttf') format('truetype-variations');font-weight:600}</style></head><body><main class="hud-root" style="padding:25px;position:relative"><h1>Inter font rendering audit — ${engineName}</h1>${cases.map(([name, style]) => `<div style="margin:18px 0"><small>${name}</small><br><span data-case="${name}" style='font-size:19px;${style}'>Alex Chen Morgan Reed 0123456789</span></div>`).join('')}</main></body></html>`, { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    const metrics = await page.locator('[data-case]').evaluateAll(spans => spans.map(span => {
      const style = getComputedStyle(span)
      const width = span.getBoundingClientRect().width
      const text = span.textContent
      span.textContent = 'Alex Chen'
      const nameWidth = span.getBoundingClientRect().width
      span.textContent = 'Morgan Reed'
      const opponentWidth = span.getBoundingClientRect().width
      span.textContent = text
      return { name: span.dataset.case, width, nameWidth, opponentWidth, family: style.fontFamily, weight: style.fontWeight, variation: style.fontVariationSettings, optical: style.fontOpticalSizing }
    }))
    const semibold = metrics.find(item => item.name === 'semibold')
    const opticalNone = metrics.find(item => item.name === 'opticalNone')
    assert.ok(Math.abs(semibold.nameWidth - 94) < 1, 'Player name must match the 94px Figma text box')
    assert.ok(Math.abs(semibold.nameWidth - opticalNone.nameWidth) < 0.1, 'HUD must pin optical sizing rather than use browser-dependent auto sizing')
    const faces = await page.evaluate(() => [...document.fonts].map(face => ({ family: face.family, weight: face.weight, status: face.status })))
    await page.screenshot({ path: path.join(artifacts, `font-audit-${engineName}.png`) })
    console.log(JSON.stringify({ engine: engineName, metrics, faces, consoleMessages }))
  } finally { await browser.close() }
}
