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

`ranked-policy-integration.mjs` runs only against a loopback test service and its
compiled client. It creates actual rated/casual matches and a spectator, verifies
the ranked aim-line control is disabled/off, changes and saves an unrelated
preference without overwriting the saved casual aim-line choice, reloads a fresh
scene, closes/reconnects a real socket, and confirms the preference is restored
after finish and in the next casual match. It also checks stable canvas identity
while settings are open and collects JavaScript errors. No match rank or renderer
state is mocked; the pure policy tests cover the calculating intermediate state.

```powershell
node tests/ranked-policy-integration.mjs
```

`NETWORK_DELAY_MS=250` delays every browser HTTP API request by 250 ms while leaving the token and WebSocket protocol intact. This exercises readiness, commands, settings and navigation under a slower connection. `mobile-layout.mjs` separately checks 390×844 framing and a landscape/portrait resize round trip in both engines.

Screenshots are generated under `tests/artifacts/` (ignored by Git). `ARTIFACT_DIR` changes the directory. WebKit exercises the Safari rendering engine, while an actual Safari release on Apple hardware remains a separate platform check.

`MOBILE_DEBUG=1` in `mobile-layout.mjs` records actual WebGL draw counts, center-pixel colour during a default-framebuffer draw, buffer/viewport dimensions and context status. This distinguishes a live renderer from a blank WebKit automation screenshot after resizing. The instrumentation is injected only by the test, never included in the application.

## Figma match HUD

The November 3 menu and Alt update adds `club-menu-ssr.test.mjs`,
`club-menu-browser.mjs`, `server-library.test.mjs`, `match-assist.mjs`,
`model-workshop.mjs`, `shared-library-integration.mjs` and
`ranked-policy-integration.mjs`. Pure model validation and match policy checks
are under `src/models` and `src/game`. See `CLUB_MENU.md` and
`../../docs/MODEL_ASSET_PIPELINE.md` for scope and fixture limitations.
Shared-library integration requires a loopback test server and explicit admin
credentials in environment variables; it never uses production model data.

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

Free-scene confirmation additionally covers clicks outside the felt, rays that
miss the table plane entirely, preserved heading/contact, a separate power press,
UI-button exclusion, ball/pocket call-selection priority and permission gating.

`optional-calls.mjs` runs two real App clients against the real service (defaults
to port 8791), plays an opening miss, places the opponent's cue ball and submits
an uncalled post-break shot through the actual parameters drawer. It checks no
mandatory warning, no call fields, physical trajectories on both clients and
identical final snapshots. It creates/cleans only its own disposable guest room.
Use `POOLTOOL_URL`, `BROWSERS=chromium,webkit` and `PLAYWRIGHT_MODULE` as above.
`match-assist.mjs` additionally verifies the optional selectors and enabled shot
button with a legacy `callShotRequired=true` component fixture.

`power-gauges.mjs` is an isolated visual component check, not gameplay evidence.
It renders the actual Vue HUD and original external Figma SVG in Chromium/WebKit,
counts gold pixels at 0/25/50/100%, verifies both units share the same fill and
checks 1920px Figma offsets plus 640/390/320px viewport bounds. It starts/stops
temporary Vite on port 4314. Set `BROWSER=webkit` for WebKit; it also needs `pngjs`
(or `PNG_MODULE` pointing at its `lib/png.js`), analogous to `PLAYWRIGHT_MODULE`.

The HUD integration's real shot is submitted through contact confirmation,
downward charge and mouse release. It checks that the authoritative result uses
the selected 3 m/s and the unchanged 90° heading, then compares all three clients.
The broader browser smoke also retains explicit-button/keyboard shot coverage.

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

## Prepared models and personal appearance

`player-appearance.mjs` exercises the actual preview and draft Apply/Cancel.
`player-appearance-integration.mjs` uses an isolated loopback service and explicit
test administrator credentials to verify catalogue choices, per-user device
persistence, no global publication, outage handling and stable game canvas/modal
input gating. It restores the baseline and disables only its own fixtures.
`src/models/playerSelection.test.mjs` tests ID-only preference validation;
`previewSnapshot.test.mjs` guards current table geometry.

`prepared-table.mjs` takes `MODEL_TABLE_PATH` and audits the real supplied GLB:
bed height/rays, open pockets, all balls, runtime transforms, fallback and
disposal. `MODEL_REFERENCE_URL` defaults to the actual engine endpoint at
`http://127.0.0.1:8791/api/assets/table-reference`; it starts its own Vite fixture.
The prepared AI asset is `../../assets/prepared/AI-Hybrid-Playable.glb` from the
client folder. `REQUIRE_CUSTOM_TABLE=1` in `match-hud.mjs` requires all three
clients to load the published model and render the AI-sized geometry, while
normal physical-shot/shared-state assertions remain enabled.

`INJECT_MATCH_FETCH_502=1` in `match-hud.mjs` returns one explicit HTTP 502 for a
background snapshot GET in each browser context. Game commands, WebSocket state
and physics still use the real service. The scenario must finish without an
unhandled promise rejection; departed rooms and already-received authoritative
snapshots do not surface stale background-fetch errors. CSS/JS/WebP failures are
also recorded, so a network stylesheet failure cannot masquerade as a gesture bug.
