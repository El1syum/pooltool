# Pooltool fork: project context

Repository: `El1syum/pooltool`. Functional online development branch:
`codex/online-vk`. This checkout is `C:/Users/User/projects/pooltool-online`;
`C:/Users/User/projects/pooltool` contains the separate Cyberpool application.
Do not mix their backend, deployment, assets or commits.

## Current task and scope

Implement the approved `ТЗ pooltool доработки(1).docx`: browser 1v1 Pooltool,
spectators, server-authoritative physics/rules, private rooms and matchmaking,
reconnect/recovery, Elo/profile/history, configurable controls and telemetry.
On 2026-10-14 the user deferred VK publication and final visual design until the
designer completes the layouts. New reference file, for that later design phase:
https://www.figma.com/design/jYFDUnxQsPJT0gD9mQ0tTP/?node-id=1809-29096

On 2026-11-02 the user started the match-interface design implementation with
the new Figma file below and `Интерфейсное решение PoolTool.pdf`. The active
reference is its `Дизайн\База` section: base frame `73:73`, aiming/power states
`73:172`, `73:294`, `73:327`. New 3D models are explicitly deferred; retain the
interactive procedural scene rather than using the reference table screenshot.
https://www.figma.com/design/qLURhvhuM4AZ0xibHYelU8/?node-id=73-73

On 2026-11-03 the active design became
https://www.figma.com/design/YPQR5qd4bL3LUjSRBzTuQH/?node-id=0-1
(menu section `94:73`, game section `105:4604`). The main menu uses the original
Figma image converted to a 1264×848 WebP, not a screenshot of a frame. Menu,
search, private room, profile and settings now use `ClubMenu` / `ClubSettings`.
The actual 3D scene remains procedural until final art models are supplied.

The match HUD lives in `online/client/src/components/MatchHud.vue`, with the
Figma SVG exports in `public/ui/figma-match`, self-hosted Inter/Lora fonts and
scoped `match-hud.css` plus `match-design.css`. New Alt-assist originals are in
`public/ui/figma-assist`. Additional contact/power/elevation cards and the live
%/m/s gauges appear while Alt is held (touch has a Help toggle); blur/visibility
loss releases Alt. Shift+wheel changes cue elevation. Ranked matches force the
aim line off, including spectators and reconnects, without overwriting the
saved casual preference. App.vue remains the network/state authority. Preparation
phases are overview (heading before first LMB) → aim (heading fixed, cue-contact
selection only) → power (heading/contact fixed, downward pull sets V0). Both
dynamic Figma wedge gauges show V0 as percent and m/s, not elevation. The server
still validates and simulates the shot. The accessible parameters drawer
preserves numeric and keyboard controls.

The shared model library is cosmetic only: `online/server/assets.py`, public
`/api/assets/library`, admin APIs under `/api/assets`, GLB files under
`/models/library/`. `ModelWorkshop` supports local previews, transforms,
materials, hidden nodes, calibration and explicit atomic server publication of
table/environment. Only self-contained GLB 2.0 up to 50 MiB is accepted. New
files/configuration persist outside releases at `/opt/pooltool-online/shared/assets`
and in the existing SQLite DB. Disabled/error art falls back to procedural
geometry; authoritative dimensions, balls, pockets and physics are unchanged.

User explicitly chose separate admin username/password on the HTTP preview
(no HTTPS/SSH requirement for this test). Use a unique test-only password;
credentials can be intercepted on HTTP. Server stores scrypt hashes only,
cookie sessions are HttpOnly/SameSite Strict with CSRF protection/rate limits.
Create credentials with `online.ops.create_asset_admin`, outside Git. Never put
plaintext passwords or admin hashes into commits or telemetry. Production TLS
and VK publication remain deferred.

The default preview `/` now sends `Cache-Control: no-store` for HTML (including
HEAD/304), so a version query is not required. Existing pre-fix cached tabs may
need one hard reload. Shot playback preparation uses scalar quaternion math and
a vectorized unchanged-sample mask; upstream collision physics is unchanged.
See `online/docs/SHOT_LATENCY.md` for remote before/after timings and the
remaining CPU-bound dense-break limitation.

## Implementation

- `online/server`: FastAPI, SQLite persistence, authenticated HTTP/WebSocket,
  bounded killable physics workers and the real Pooltool EightBall adapter.
- `online/client`: Vue/TypeScript shell and Three.js game scene; original Pooltool
  numbered ball textures, numbered/colored pockets, shared trajectory playback.
- `online/tests` and `online/server/tests`: physics, API, authority, persistence,
  idempotency, timeouts, ratings, telemetry and worker recovery checks.
- `online/client/tests`: Chromium/WebKit multi-client smoke harness.
- `online/ops`: release-local runtime deployment and isolated systemd service.

Local service: port 8790. Functional remote preview:
http://82.47.143.103:8790 (SSH alias `el1s`, service user `ops`, verified 2026-11-03). Service:
`pooltool-online.service`; releases under `/opt/pooltool-online/releases`, active
symlink `/opt/pooltool-online/current`, persistent data/config under `shared`.
No existing Cyberpool or other server applications are replaced.

This is an HTTP testing preview. Configure HTTPS/WSS before production identity
or platform integration. One ASGI worker owns state; the CPU worker is separate.
Do not run multiple ASGI workers against the current SQLite authority.

Read `online/README.md`, `online/server/API_CONTRACT.md`,
`online/DELIVERY.md` and `online/ops/README.md` for commands and verified scope.
Native Safari/device certification, a production load SLA, final 3D art/audio
and VK publication are explicitly not claimed complete.

The November 3 deployment contains commits `d1989c0` (server library/auth) and
`8e280af` (UI/workshop). Active client assets are `index-d1pvhN-W.js` and
`index-BKWKzaFU.css`; HTML remains no-store. The server was restarted once after
an online SQLite backup; existing 38 completed matches were preserved. The
runtime/database backup is `/opt/pooltool-online/shared/backup-nov3-8e280af`.
Credentials are loaded by `asset-library-preview.conf` from a separate mode-600
`shared/asset-admin.env`; no plaintext password is deployed or committed.
Background room/match/profile fetch failures are handled rather than escaping
as unhandled promise rejections; a real-server browser test injects snapshot
HTTP 502 responses while preserving real WebSocket state and physical shots.

## Git identity

Author and committer: `el1syum <kilmol606@gmail.com>`. No assistant/co-author
attribution. Use the existing authenticated remote for push.
