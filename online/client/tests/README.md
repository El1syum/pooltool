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
