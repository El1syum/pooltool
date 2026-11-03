# Figma club menus

Run from `online/client`:

```powershell
node --test tests/club-menu-ssr.test.mjs
npm run dev -- --port 4321
# In a second terminal, with an installed Playwright package:
$env:PLAYWRIGHT_MODULE = 'C:/path/to/playwright/index.mjs'
node tests/club-menu-browser.mjs
```

The browser fixture is isolated from the backend and is never production UI.
It tests real Vue components, navigation events, code normalization, turn time,
room readiness, settings events and ranked aim-line disabling. Responsive
screenshots and horizontal-overflow checks cover 320, 390, 768 and 1440 px.
Artifacts are written under the existing ignored `tests/artifacts/club-menu`.
This is component evidence, not an online-game or physics test; use the existing
real-service smoke tests for gameplay after App.vue integration.

`ClubMenu.vue` owns only temporary menu navigation. Its network actions are
emitted to App.vue. `ClubSettings.vue` receives a `GameSettings` model and emits
complete immutable replacements through `update:settings`. It never mutates
props or calls the server directly. The ranked aim-line switch requires
`aimGuideLocked` from the authoritative app policy; App.vue must also enforce
the renderer settings independently of this UI control.

## Shared server library integration

`shared-library-integration.mjs` runs against the actual compiled app and API,
not a fixture. Use a disposable database/model directory with a configured
asset administrator. Set `POOLTOOL_URL`, `ASSET_ADMIN_USERNAME`,
`ASSET_ADMIN_PASSWORD`, and optionally `PLAYWRIGHT_MODULE`, then run:

```powershell
node tests/shared-library-integration.mjs
```

It runs Chromium and WebKit by default (`BROWSERS` can select one), covers
read-only access, wrong/correct login, cleared password, real GLB import/upload,
configuration and one atomic two-role publication, a separate unprivileged
client, server write rejection, logout, and a fresh two-player match fetching
both published URLs. Tiny original fixture meshes use `replaceProcedural=false`
to retain the actual playable table. It disables only this run's uploaded
assets and restores the initial selection in `finally`.

Mutations are restricted to loopback unless the operator explicitly sets
`ALLOW_SHARED_LIBRARY_MUTATION=1` for an isolated remote test environment.
Credentials are read from environment variables and never printed or saved.
