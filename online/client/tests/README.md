# Browser smoke checks

`browser-smoke.mjs` checks the actual running server and compiled client, using separate browser contexts for two players and an observer. It exercises room readiness, cue placement through canvas raycasting, a real physical shot, animation in all three clients, reconnect during playback, spectator authorization and explicit rejoining of the same room, persisted key bindings/graphics settings, keyboard-modifier camera rotation without changing aim, profile history, leaving a completed room and creating a new match through matchmaking. It also verifies original ball textures, nonempty rendered geometry, no JavaScript errors and a narrow 390×844 viewport.

The test creates disposable guest accounts and completes the test matches. Use a development/test database. Start the application with the real physics engine; a mock server does not satisfy the checks.

Run from `online/client` with Node 24 and an installed Playwright module:

```powershell
$env:POOLTOOL_URL = 'http://127.0.0.1:8790'
# Optional when Playwright is supplied by a shared runtime rather than node_modules:
$env:PLAYWRIGHT_MODULE = 'C:/path/to/playwright/index.mjs'
node tests/browser-smoke.mjs
```

Both Chromium and WebKit run by default. `BROWSERS=chromium` or `BROWSERS=webkit` selects one engine. `PLAYWRIGHT_BROWSERS_PATH` can select the installed browser cache; the browser revisions must match the Playwright module. `CHROMIUM_EXECUTABLE` / `WEBKIT_EXECUTABLE` are available for a known compatible custom installation.

`NETWORK_DELAY_MS=250` delays every browser HTTP API request by 250 ms while leaving the token and WebSocket protocol intact. This exercises readiness, commands, settings and navigation under a slower connection. `mobile-layout.mjs` separately checks 390×844 framing and a landscape/portrait resize round trip in both engines.

Screenshots are generated under `tests/artifacts/` (ignored by Git). `ARTIFACT_DIR` changes the directory. WebKit exercises the Safari rendering engine, while an actual Safari release on Apple hardware remains a separate platform check.

`MOBILE_DEBUG=1` in `mobile-layout.mjs` records actual WebGL draw counts, center-pixel colour during a default-framebuffer draw, buffer/viewport dimensions and context status. This distinguishes a live renderer from a blank WebKit automation screenshot after resizing. The instrumentation is injected only by the test, never included in the application.

## Figma match HUD

`match-hud.mjs` checks the new full-window HUD with the real service: desktop
1920×1080 and 1280×800, portrait 390×844, original SVG dimensions, aiming/power
states, modal input gating, unchanged canvas instance, sound settings, spectator
permissions, a real physical shot and matching final state in three clients.
`VISUAL_FIXTURE=1` additionally renders a separate, noninteractive 4-vs-3 score
example through the actual Vue component for visual review; it is explicitly a
visual fixture, never evidence of server gameplay.

`shot-workflow.mjs` uses the real Three.js renderer with an isolated scene
fixture to check gesture transitions, no accidental click shots, remapped mouse
controls, placement priority and actual GPU-projected cue-ball alignment.
It starts and stops its own temporary Vite instance; it does not need a backend.
It also checks heading hover before the first click, a locked contact-phase
heading, contact editing, and sideways/upward pull cancellation.

`power-gauges.mjs` is an isolated visual component check, not gameplay evidence.
It renders the actual Vue HUD and original external Figma SVG in Chromium/WebKit,
counts gold pixels at 0/25/50/100%, verifies both units share the same fill and
checks 1920px Figma offsets plus 640/390/320px viewport bounds. It starts/stops
temporary Vite on port 4314. Set `BROWSER=webkit` for WebKit; it also needs `pngjs`
(or `PNG_MODULE` pointing at its `lib/png.js`), analogous to `PLAYWRIGHT_MODULE`.

```powershell
node --test tests/hud-ssr.test.mjs
node --test --experimental-strip-types src/game/playback.test.mjs src/game/shotWorkflow.test.mjs
node tests/shot-workflow.mjs
node tests/match-hud.mjs
node tests/power-gauges.mjs
```

The SSR tests verify group ownership, open-table counts, pocketed flags, original
player indices after card reordering, timers and mapped key labels. The full
`browser-smoke.mjs` also uses the new parameters drawer while preserving its
network/reconnect/history/matchmaking coverage.

`match-fonts.mjs` checks the self-hosted variable fonts in both engines. It guards
against differing automatic optical-size selection: Inter's default optical
size matches the Figma player-name boxes (94px and 122px), so the HUD explicitly
uses `font-optical-sizing: none` while preserving real 400/500/600/700 weights.

For remote Chromium verification only, `DIRECT_NETWORK=1` adds the browser's
`--no-proxy-server` launch flag. This avoids an unrelated operating-system proxy
returning intermittent 502 responses; it does not change the application or the
user's proxy settings. Without the flag the normal browser network is used.
