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

LMB confirmation accepts any free point of the canvas, including background and
rays missing the felt/table plane. Overview→aim and aim→power confirm on release;
the power pull requires a separate press, preventing one confirming click/drag
from immediately firing. Ball/pocket clicks retain call-selection priority;
UI controls, placement, remapped bindings, opponent/spectator and playback gates
remain unchanged.

Free-scene confirmation deployment: `adf6dfc`, client
`/assets/index-DaVx5Gts.js`, CSS unchanged (`index-CsNN5j3a.css`). Applied as a
static update with HTML installed last and old chunks retained; service PID
3089804 stayed unchanged (no backend restart). 58 client checks plus isolated
and real three-client Chromium/WebKit shot scenarios passed. The isolated test
also proves null table-plane ray confirmation and call-selection/UI priorities.

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

The earlier November 3 deployment contains commits `d1989c0` (server library/auth)
and `8e280af` (UI/workshop), then background-fetch handling. Its client assets
remain retained for open tabs; the latest model update is recorded below.
HTML remains no-store. The server was restarted after
an online SQLite backup; existing 38 completed matches were preserved. The
runtime/database backup is `/opt/pooltool-online/shared/backup-nov3-8e280af`.
Credentials are loaded by `asset-library-preview.conf` from a separate mode-600
`shared/asset-admin.env`; no plaintext password is deployed or committed.
Background room/match/profile fetch failures are handled rather than escaping
as unhandled promise rejections; a real-server browser test injects snapshot
HTTP 502 responses while preserving real WebSocket state and physical shots.

## Prepared tables and personal appearance (2026-11-03)

The user supplied an AI GLB and an untextured Sketchfab-rip OBJ archive. The AI
source was 84.9MB / 1.5M triangles and had warped cloth and closed pocket cups.
The hybrid retains its decorative shell/UV detail but rebuilds the cloth, exact
cushion/jaw segments, six open pockets and legs. Checked-in output:
`online/assets/prepared/AI-Hybrid-Playable.glb` (3,235,040 bytes, 81,003 triangles,
67,503 vertices, seven material groups); source file in Downloads is unchanged.
SHA256: `33e07b296b63d9d8dbf6083854bfbeb394d7f14a40c27c4336a7018f159326ce`.

Actual current EightBall geometry is 0.9906×1.9812m, cloth height 0.708m. Earlier
workshop's 1.27×2.54m assumption was wrong; the workshop now gets the actual
engine snapshot from public `/api/assets/table-reference` (cached, no room or
match is created). `previewSnapshot.ts` has an explicitly labelled offline
fallback with correct dimensions. No collision physics was changed.

`Настройки → Оформление` is a separate personal picker with 3D preview and
independent table/environment modes: shared default, procedural, enabled asset.
Preferences store IDs/modes per user on the device only, never URLs/admin state.
Apply/Cancel do not publish the global scene. A failed catalogue does not erase
saved IDs; confirmed disabled/missing IDs return to shared default. The admin
workshop always receives the shared profile, not personal overrides. Runtime
model failures show a fallback/retry notice. Optional GLB extras
`pooltoolCastShadow:false` / `pooltoolReceiveShadow:false` control cosmetic shadow
hints; defaults remain enabled.

The archive's commercial Sketchfab pack was identified; no license was provided
yet. One repaired classic table (500,884 bytes) is delivered locally under
`C:/Users/User/Downloads/Pooltool Prepared Models`, not committed or uploaded
publicly until permission is confirmed. Missing textures do not grant a license.

Read `DESIGN.md`, `online/docs/ASSET_INTAKE_20261103.md`, and the reproducible
`online/tools/model_intake` / `online/tools/asset_pack` instructions. Isolated
tool dependencies are not application dependencies. Verification: 99 Python
tests +513 subtests, 58 client tests, personal-selection API/UI checks, actual
model geometric/runtime checks and real three-client shots in Chromium/WebKit.

Deployed model update: `5ef9e95`, default client `/assets/index-ftO2m1V7.js` and
`/assets/index-CsNN5j3a.css`. Shared table ID `2dc5c0956a32488b86e6667aa857d910`
is the prepared AI hybrid; environment remains the existing default. The public
GLB download was hash-verified against the checked-in derivative. A fresh online
SQLite/runtime backup is `/opt/pooltool-online/shared/backup-models-5ef9e95`
(42 completed matches preserved). No passwords/config/migration guards were
changed; the service restarted once for the new table-reference endpoint.

## No compulsory shot calls (2026-11-04)

On 2026-11-04 compulsory ball/pocket declarations were removed from the web game,
including the eight. Optional target markers do not restrict physical results.
The online-only `OnlineEightBall` adapter preserves contact/cushion/scratch and
early-eight rules. The first legal target pot after the break assigns groups by
event order; break pots keep the table open. Existing active match flags are
normalized on recovery without rewriting completed games or shot history.

Deployed commit `29c4823` to the default preview, client
`/assets/index-BKrqx33R.js` (CSS unchanged). The backend restarted once and is
ready under PID 3702768. Online SQLite backup and prior runtime are under
`/opt/pooltool-online/shared/backup-optional-calls-29c4823`; all 45 completed
matches were verified byte-identical and the shared model catalogue unchanged.
Local verification: 105 Python tests +520 subtests, 58 client checks, actual
post-break uncalled GUI shots/shared state in Chromium and WebKit; legacy active
match recovery, legal/early eight, group assignment, misses and bot rules covered.
The public preview also passed the same two-client post-break GUI scenario in
Chromium and WebKit, with no mandatory warnings, JavaScript or static-asset errors.

## Administration fixes (2026-11-05)

The five audited administration defects are addressed: workshop drafts own a
base catalogue revision; uploads/updates/disables/publication send that explicit
revision and only their successful returned version advances it. Refreshing the
catalogue or reauthenticating never silently rebases old settings. A conflict
retains the draft and blocks writes until explicit confirmed shared-scene reload.
Initial draft and revision come from the same response, not cached App art.

Profile publication atomically persists selected model names, configs and both
slots. Uploads recheck the optional revision inside the commit after async disk
validation, cleaning uncommitted files on conflict. Existing HTTP clients remain
compatible; already-open old administrator tabs need a reload after deployment.

Administrator login/logout no longer remounts the workshop. Room/match/visibility
and reconnect updates preserve it, with an explicit Return destination. Returning
to an ongoing shot catches up to authoritative playback, including when the shot
had started before entering the workshop. The server playback-until timestamp
also gates shooting. Background settings sync never closes the settings dialog;
writes are serialized and older responses cannot clear newer edits.

`tests/admin-library-integration.mjs` exercises the actual App/API with isolated
loopback-only credentials, including the original lost-update/draft/navigation
and startup races. See `online/docs/MODEL_ASSET_PIPELINE.md` and API_CONTRACT.md.
Verification: 116 Python tests +520 subtests, 60 client checks, the isolated
workshop GPU suite in Chromium/WebKit, and 20 real App/API administration
scenarios per browser passed. This includes two actual physical-playback returns,
the five original regressions and zero uncaught JS/static-resource failures.

Deployed `f8c058d`, default client `/assets/index-B1WwzGAE.js` (CSS unchanged),
backend PID 40841. Runtime/online SQLite backup:
`/opt/pooltool-online/shared/backup-admin-fixes-f8c058d`. All 48 previously
completed match payloads were preserved; database integrity and unchanged model
catalogue/selection were verified. Live Chromium/WebKit administrator login,
actual AI preview, original GLB hash, session reload and logout passed with zero
model writes or JS/static-resource errors. Published source/client hashes match
the tested local build. Refresh already-open administrator tabs to receive the
fixed draft-revision logic.
The public three-client WebKit match test also passed with the actual shared AI
table loaded in all three clients, a real charged shot and identical final ball
states; no JavaScript or static-resource failures.

## Optional VK Play authentication preparation (2026-11-05)

The web VK Play adapter is opt-in and disabled by default. Ordinary URLs retain
the guest workflow; only `?platform=vkplay` selects the future iframe entry.
No GMRID/secret are provisioned and no VK Play publication has been performed.
`/api/auth/config` exposes safe enabled/configured/appId data; `/api/auth/vkplay`
exchanges a `getAuthToken()` ticket for our session only after fixed-endpoint GAS
verification, with safe launch signatures, total timeout and bounded one-use
request idempotence. No OTP/secret is persisted or reflected in errors/logs.

External identities are namespaced by provider/app/external ID in a new table,
not merged into guest or VK Mini Apps identities. Platform tokens/pending
commands are memory-only; guest storage is untouched. Reauth/account changes
clear identity-owned game state and reject old HTTP/WS completions. Read
`online/docs/VK_PLAY_AUTH.md` before enabling with real keys/HTTPS and performing
real SDK/GAS acceptance. Test SDK callbacks/transports are explicitly fake.

Verification: 163 Python tests +520 subtests, 74 client checks, explicit fake
platform App bootstrap/account-switch tests in Chromium/WebKit, real disabled
mode+guest-persistence checks in both browsers, and real three-client physical
match/HUD checks in both browsers passed. No live platform login is claimed.

Deployed preparation `d263c94` to the testing preview with VK Play disabled and
unconfigured (`guestEnabled=true`, `appId=null`). Current entry is
`/assets/index-BEVCRBzm.js`, backend PID 328303. Online DB/runtime backup:
`/opt/pooltool-online/shared/backup-vkplay-prepare-d263c94`. All 49 prior completed
matches and existing user/VK mappings were preserved; model library unchanged,
external identity table empty, integrity checked. Public Chromium/WebKit checks
confirmed the guest survives a failed disabled-platform launch and return, no
SDK/platform requests or guest fallback occur, and no JS errors. Published
client/module hashes match the local tested source. No credentials were added
and no VK Play publication was attempted.

## Git identity

Author and committer: `el1syum <kilmol606@gmail.com>`. No assistant/co-author
attribution. Use the existing authenticated remote for push.
